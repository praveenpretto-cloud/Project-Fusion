const logger = require('../../logger');
const { evaluatePolicy } = require('../../policyEngine');
const { writeLedger, verifyLedgerIntegrity } = require('./ledgerUtils');
const { generateComplianceDocs } = require('../compliance/complianceDocWorkflow');
const { reconcileToZoho } = require('../reconciliation/reconciliationService');
const { normalizeResult } = require('../adapterResultNormalizer');
const providerDispatcher = require('./providerDispatcher');

// Bank rail policy identifiers (module-private immutable list)
const SAGA_BANK_RAILS = Object.freeze([
    'SWIFT',
    'ISO20022',
    'ISO 20022',
    'ISO_20022',
    'NEFT',
    'RTGS',
    'IMPS',
    'ACH',
    'FEDWIRE',
    'FED_WIRE',
    'FED WIRE',
    'CHAPS',
    'SEPA',
    'FASTER_PAYMENTS',
    'FASTER PAYMENTS',
    'FASTERPAYMENTS',
    'WIRE',
    'NIUM',
    'NIUM_SWIFT',
    'NIUM SWIFT',
    'NIUMSWIFT',
    'BANK_TRANSFER',
    'BANK TRANSFER',
    'BANKTRANSFER',
]);

/**
 * Detects if a transaction payload indicates a bank rail via any candidate property.
 * Normalizes separators (spaces, hyphens, underscores) and capitalization.
 */
function isBankRailTxn(txn) {
    if (!txn || typeof txn !== 'object') return false;
    const candidates = [
        txn.purpose,
        txn.rail,
        txn.route_selected,
        txn.payment_method,
        txn.provider,
        txn._requestedAdapter,
    ]
        .filter(Boolean)
        .map((s) => String(s).trim());

    return candidates.some((str) => {
        const rawUpper = str.toUpperCase();
        const underscore = rawUpper.replace(/[\s-]+/g, '_');
        const compact = rawUpper.replace(/[^A-Z0-9]/g, '');

        return SAGA_BANK_RAILS.some((r) => {
            const rUnderscore = r.replace(/[\s-]+/g, '_');
            const rCompact = r.replace(/[^A-Z0-9]/g, '');
            return (
                rawUpper.includes(r) ||
                underscore.includes(rUnderscore) ||
                compact.includes(rCompact)
            );
        });
    });
}

let pool; // Will be injected

/**
 * UNIFIED SAGA ATOMIC CORE
 * Handles INITIATED -> LOCKED -> PENDING_EXECUTION -> SETTLED
 */
async function processInstructionSagaAtomic(instructionId, dbPool, options = {}) {
    pool = dbPool;
    logger.info(`[SAGA-CORE] ⚛️ Atomic Processing for ${instructionId}`);
    let client = await pool.connect();
    try {
        // ── PHASE 1: POLICY & LOCKING ───────────────────────────────────
        let result = await client.query('SELECT * FROM instructions WHERE instruction_id = $1', [
            instructionId,
        ]);
        if (result.rows.length === 0) throw new Error('Not Found');
        let txn = result.rows[0];

        if (txn.state === 'INITIATED' || txn.state === 'PENDING' || txn.state === 'APPROVED') {
            const secretKey = process.env.API_SECRET_KEY || 'fusion_test_secret_key';
            const permit = evaluatePolicy(txn, secretKey);
            if (permit.decision === 'APPROVED') {
                await client.query('BEGIN');
                // Aggregate Connected Bank Liquidity Check (Non-Custodial)
                // We check the real-time balance of the SME's actual bank accounts before routing the API call.
                const bizRes = await client.query(`SELECT business_id FROM businesses LIMIT 1`);
                const businessId = bizRes.rows.length > 0 ? bizRes.rows[0].business_id : txn.sender;

                const aggRes = await client.query(
                    `
                    SELECT SUM(latest_balance) AS total_balance
                    FROM (
                        SELECT COALESCE(
                            (SELECT t.balance_after
                             FROM bank_transactions t
                             WHERE t.account_id = a.account_id AND t.balance_after IS NOT NULL
                             ORDER BY t.txn_date DESC, t.imported_at DESC LIMIT 1), 0
                        ) AS latest_balance
                        FROM business_bank_accounts a
                        WHERE a.business_id = $1 AND a.is_active = TRUE
                    ) subq
                `,
                    [businessId]
                );

                let bal = Number(aggRes.rows[0].total_balance || 0);
                if (bal === 0) bal = 2500000; // Simulated connected bank balance for demo

                // [LUMEN_SYNC_FIX]: Skip internal balance check for Digital Assets (XLM, USDC).
                const isCrypto = ['XLM', 'USDC', 'BTC', 'ETH'].includes(txn.currency);

                if (bal < Number(txn.amount) && !isCrypto) {
                    await client.query(
                        "UPDATE instructions SET state = 'MANUAL_CHECK', error_message = $1, updated_at = NOW() WHERE instruction_id = $2",
                        [
                            `Insufficient Connected Bank Liquidity (${bal} < ${txn.amount})`,
                            instructionId,
                        ]
                    );
                    await client.query('COMMIT');
                    return { status: 'MANUAL_CHECK', reason: 'INSUFFICIENT_LIQUIDITY' };
                }

                // NON-CUSTODIAL: We DO NOT debit an internal shadow ledger here.
                // The actual bank account will decrease when the API execution succeeds.

                await client.query(
                    "UPDATE instructions SET state = 'LOCKED', updated_at = NOW() WHERE instruction_id = $1",
                    [instructionId]
                );
                await client.query('COMMIT');
                txn.state = 'LOCKED';
                logger.info(`[SAGA-CORE] ✅ LOCKED: ${instructionId}`);
            } else {
                await client.query(
                    "UPDATE instructions SET state = 'FAILED', error_message = 'Policy Rejected', updated_at = NOW() WHERE instruction_id = $1",
                    [instructionId]
                );
                return { status: 'FAILED', reason: 'POLICY_REJECTED' };
            }
        }

        // ── PHASE 2: ROUTING ───────────────────────────────────────────
        if (txn.state === 'LOCKED') {
            const adapter =
                txn.currency === 'INR'
                    ? 'FIAT'
                    : ['BTC', 'ETH', 'USDC', 'XLM'].includes(txn.currency)
                      ? 'CRYPTO'
                      : 'FIAT';
            await client.query(
                "UPDATE instructions SET state = 'PENDING_EXECUTION', provider = $1, updated_at = NOW() WHERE instruction_id = $2",
                [adapter, instructionId]
            );
            txn.state = 'PENDING_EXECUTION';
            txn.provider = adapter;
            logger.info(`[SAGA-CORE] ✅ ROUTED to ${adapter}: ${instructionId}`);
        }

        // ── PHASE 3: EXECUTION ──────────────────────────────────────────
        if (txn.state === 'PENDING_EXECUTION') {
            await executeInstructionInternal(instructionId, txn.provider, pool, options);
        }

        const stateCheck = await pool.query(
            'SELECT state FROM instructions WHERE instruction_id = $1',
            [instructionId]
        );
        const currentState = stateCheck.rows.length > 0 ? stateCheck.rows[0].state : 'UNKNOWN';

        return { status: 'SUCCESS', instructionId, current_state: currentState };
    } catch (err) {
        logger.error(`[SAGA-CORE ERROR] ${err.message}`);
        throw err;
    } finally {
        client.release();
    }
}

/**
 * INTERNAL SAGA EXECUTER (Step 4: Execute)
 */
async function executeInstructionInternal(instructionId, adapter, dbPool, options = {}) {
    pool = dbPool;
    logger.info(`[SAGA-EXEC] ⚡ Executing ${instructionId} via ${adapter}`);
    let txn;
    const res = await pool.query('SELECT * FROM instructions WHERE instruction_id = $1', [
        instructionId,
    ]);
    if (res.rows.length === 0) throw new Error('Instruction not found');
    txn = res.rows[0];

    // Enforce Policy constraints: max_execution_attempts
    const { evaluatePolicy } = require('../../policyEngine');
    const secretKey = process.env.API_SECRET_KEY || 'fusion_test_secret_key';
    const permit = evaluatePolicy(txn, secretKey);
    const maxAttempts = permit.constraints?.max_execution_attempts || 1;
    const currentAttempts = txn.execution_attempts || 0;

    if (currentAttempts >= maxAttempts) {
        logger.error(
            `[SAGA-EXEC] ❌ Blocked execution attempt for ${instructionId}: current attempts (${currentAttempts}) would exceed max permitted (${maxAttempts}).`
        );
        await pool.query(
            "UPDATE instructions SET state = 'FAILED', error_message = $1, updated_at = NOW() WHERE instruction_id = $2",
            [
                `Execution attempts limit exceeded (${currentAttempts + 1} > ${maxAttempts})`,
                instructionId,
            ]
        );
        return;
    }

    // Increment attempts count
    await pool.query(
        'UPDATE instructions SET execution_attempts = execution_attempts + 1, updated_at = NOW() WHERE instruction_id = $1',
        [instructionId]
    );

    // Compliance & Tax
    const { runComplianceChecks } = require('../complianceInterceptor');
    const taxInfo = await runComplianceChecks(pool, txn);

    await pool.query(
        'UPDATE instructions SET tax_withheld = $1, net_amount = $2 WHERE instruction_id = $3',
        [taxInfo.tax_withheld, taxInfo.net_payout, instructionId]
    );
    txn.tax_withheld = taxInfo.tax_withheld;
    txn.net_amount = taxInfo.net_payout;

    // Adapter Execution
    let adapterResult;
    let adapterMetadata = null;
    let isOverride = false;

    try {
        if (options && options.adapterOverride) {
            // SPRINT 2.2.4.2.8: Elimination of runtime adapter injection in production architecture
            logger.warn(
                `[SAGA-EXEC] ❌ Blocked runtime adapter override for ${instructionId}. Runtime adapter injection is disallowed.`
            );
            adapterMetadata = { id: 'unauthorized_injected_override', untrusted: true };
            isOverride = true;
            adapterResult = {
                status: 'UNKNOWN',
                untrusted_execution: true,
                error: 'Untrusted execution: Runtime adapter injection is disallowed in production architecture',
            };
        } else if (txn.currency === 'XLM') {
            // Permitted genuine crypto rail: Stellar Testnet
            adapterMetadata = providerDispatcher.getProviderMetadata('core_stellar');
            adapterResult = await providerDispatcher.dispatchProviderExecution('core_stellar', txn);
        } else if (['BTC', 'ETH', 'USDC'].includes(txn.currency)) {
            // Unsupported crypto assets: Explicitly SIMULATED without making blockchain calls
            const cryptoRailName =
                txn.currency === 'BTC'
                    ? 'BITCOIN_TESTNET'
                    : txn.currency === 'ETH'
                      ? 'ETHEREUM_TESTNET'
                      : 'STELLAR_USDC_TESTNET';
            logger.info(
                `[SAGA-EXEC] 🧪 Asset '${txn.currency}' has no verified testnet adapter. Returning SIMULATED without network dispatch.`
            );
            adapterMetadata = {
                id: `simulated_crypto_${txn.currency.toLowerCase()}`,
                name: `Simulated ${txn.currency} Rail`,
                is_mock: true,
                simulated: true,
            };
            adapterResult = {
                adapter_type: 'SIMULATED_CRYPTO',
                status: 'SIMULATED',
                simulated: true,
                settlement_confirmed: false,
                asset: txn.currency,
                rail: cryptoRailName,
                intent_id: `sim_${txn.currency.toLowerCase()}_${Date.now()}`,
                reason: `No genuine ${txn.currency} testnet adapter configured. Execution is simulated.`,
                timestamp: new Date().toISOString(),
                note: `Simulated ${txn.currency} transfer. Zero blockchain operations executed.`,
            };
        } else if (txn.currency === 'INR') {
            // Permitted genuine fiat rail: RazorpayX Sandbox
            adapterMetadata = providerDispatcher.getProviderMetadata('core_razorpay');
            adapterResult = await providerDispatcher.dispatchProviderExecution(
                'core_razorpay',
                txn
            );
        } else if (
            txn.currency === 'CNY' ||
            (txn.purpose && txn.purpose.toUpperCase().includes('ALIPAY'))
        ) {
            // Unsupported fiat rail: Explicitly SIMULATED without network dispatch
            logger.info(
                `[SAGA-EXEC] 🧪 CNY/Alipay has no verified sandbox adapter. Returning SIMULATED without network dispatch.`
            );
            adapterMetadata = {
                id: 'plugin_alipay_mock',
                name: 'Alipay Global Payments',
                is_mock: true,
                simulated: true,
            };
            adapterResult = {
                adapter_type: 'ALIPAY_SDK',
                status: 'SIMULATED',
                simulated: true,
                settlement_confirmed: false,
                currency: 'CNY',
                rail: 'ALIPAY',
                intent_id: `sim_alipay_${Date.now()}`,
                reason: 'No verified Alipay sandbox integration configured. Execution is simulated.',
                timestamp: new Date().toISOString(),
                note: 'Simulated CNY/Alipay payment. Zero external payment operations executed.',
            };
        } else {
            // General Fiat routing check:
            const isBankRail = isBankRailTxn(txn);
            const isSupportedStripeCurrency = ['USD', 'EUR', 'GBP', 'CAD'].includes(txn.currency);

            if (isBankRail || !isSupportedStripeCurrency) {
                // Bank rails (SWIFT, ISO 20022, Fedwire, CHAPS, Faster Payments, Nium, etc.) or unsupported currencies
                const requestedRail = isBankRail
                    ? txn.rail ||
                      txn.purpose ||
                      txn.payment_method ||
                      txn.route_selected ||
                      'SWIFT/ISO20022'
                    : txn.currency || 'UNKNOWN_RAIL';
                logger.info(
                    `[SAGA-EXEC] 🧪 Requested rail '${requestedRail}' has no verified banking integration. Returning SIMULATED without network dispatch.`
                );
                adapterMetadata = {
                    id: `simulated_rail_${String(requestedRail)
                        .toLowerCase()
                        .replace(/[^a-z0-9]/g, '_')}`,
                    name: `Simulated ${requestedRail} Rail`,
                    is_mock: true,
                    simulated: true,
                };
                adapterResult = {
                    adapter_type: 'SIMULATED_BANK_RAIL',
                    status: 'SIMULATED',
                    simulated: true,
                    settlement_confirmed: false,
                    currency: txn.currency,
                    rail: requestedRail,
                    intent_id: `sim_bank_${Date.now()}`,
                    reason: `No verified ${requestedRail} sandbox integration configured. Execution is simulated.`,
                    timestamp: new Date().toISOString(),
                    note: `Simulated ${requestedRail} transfer. Zero external payment operations executed.`,
                };
            } else {
                // Permitted genuine fiat rail: Stripe Test Mode for USD, EUR, GBP, CAD
                adapterMetadata = providerDispatcher.getProviderMetadata(
                    'core_stripe',
                    txn.currency
                );
                adapterResult = await providerDispatcher.dispatchProviderExecution(
                    'core_stripe',
                    txn
                );
            }
        }
    } catch (adapterErr) {
        logger.error(`[ADAPTER-FAILURE] ${instructionId}: ${adapterErr.message}`);
        adapterResult = { status: 'FAILED', error: adapterErr.message };
    }

    // Normalize adapter result through shared normalizer before any settlement decision
    adapterResult = normalizeResult(adapterResult, txn, 0, adapterMetadata, {
        enforceSagaTrust: true,
        isInjectedOverride: isOverride,
    });

    if (adapterResult.status === 'SUCCESS') {
        const finalClient = await pool.connect();
        try {
            await finalClient.query('BEGIN');
            await finalClient.query(
                "UPDATE instructions SET state = 'SETTLED', external_intent_id = $1, utr = $2, updated_at = NOW() WHERE instruction_id = $3",
                [adapterResult.intent_id, adapterResult.utr || null, instructionId]
            );

            // If this is a Zoho invoice, update local invoice state to SETTLED
            if (txn.zoho_invoice_id) {
                await finalClient.query(
                    `UPDATE invoices SET state = 'SETTLED', updated_at = NOW() WHERE invoice_id = $1 OR invoice_id = $2`,
                    [txn.zoho_invoice_id, `ZOHO-${txn.zoho_invoice_id}`]
                );
                logger.info(
                    `[SAGA-EXEC] Updated Zoho invoice ${txn.zoho_invoice_id} state to SETTLED`
                );
            }

            // Centralized Ledger Logic (Double-Entry + Hash Chain)
            await writeLedger(
                finalClient,
                instructionId,
                txn.sender,
                txn.recipient,
                txn.net_amount,
                txn.currency,
                txn.tax_withheld || 0
            );
            await verifyLedgerIntegrity(
                finalClient,
                instructionId,
                txn.currency,
                txn.tax_withheld || 0
            );

            await finalClient.query('COMMIT');
            logger.info(`[SAGA-EXEC] ✅ SETTLED: ${instructionId}`);
        } catch (dbErr) {
            await finalClient.query('ROLLBACK');
            throw dbErr;
        } finally {
            finalClient.release();
        }

        // ── POST-SETTLEMENT: Compliance Docs + Zoho Reconciliation ──────────
        // Fire-and-forget — settlement is already confirmed, these are async ops
        const settledTxn = { ...txn, external_intent_id: adapterResult.intent_id };
        generateComplianceDocs(
            pool,
            settledTxn,
            adapterResult.intent_id,
            txn.zoho_invoice_id
        ).catch((e) =>
            logger.error(`[POST-SETTLE] Compliance doc error for ${instructionId}: ${e.message}`)
        );
        reconcileToZoho(pool, settledTxn, adapterResult.intent_id).catch((e) =>
            logger.error(`[POST-SETTLE] Reconciliation error for ${instructionId}: ${e.message}`)
        );
    } else if (adapterResult.status === 'SIMULATED') {
        // 🧪 SIMULATION ISOLATION:
        // Mock and synthetic executions MUST NOT create settled payment ledger entries.
        const simNote =
            adapterResult.note || adapterResult.reason || 'Simulated execution (non-financial)';
        await pool.query(
            "UPDATE instructions SET state = 'SIMULATED', external_intent_id = $1, error_message = $2, updated_at = NOW() WHERE instruction_id = $3",
            [adapterResult.intent_id || null, simNote, instructionId]
        );
        logger.info(
            `[SAGA-EXEC] 🧪 Simulation recorded for ${instructionId} (State: SIMULATED, Ledger: BYPASSED)`
        );
    } else if (['PROCESSING', 'PENDING', 'PENDING_SETTLEMENT'].includes(adapterResult.status)) {
        await pool.query(
            "UPDATE instructions SET state = 'PENDING_SETTLEMENT', external_intent_id = $1, utr = $2, updated_at = NOW() WHERE instruction_id = $3",
            [adapterResult.intent_id || null, adapterResult.utr || null, instructionId]
        );
    } else if (adapterResult.status === 'UNKNOWN') {
        // ⚠️ AMBIGUOUS / CONTRADICTORY OUTCOME:
        // Do NOT mark as FAILED (which could invite repeat payment); flag for manual reconciliation.
        const reconciliationReason =
            adapterResult.contradiction_reason ||
            adapterResult.error ||
            'Ambiguous adapter outcome: reconciliation required before settlement or retry';
        await pool.query(
            "UPDATE instructions SET state = 'MANUAL_CHECK', external_intent_id = $1, error_message = $2, updated_at = NOW() WHERE instruction_id = $3",
            [adapterResult.intent_id || null, reconciliationReason, instructionId]
        );
        logger.warn(
            `[SAGA-EXEC] ⚠️ Ambiguous outcome for ${instructionId} (State: MANUAL_CHECK, Ledger: BYPASSED): ${reconciliationReason}`
        );
    } else if (['REVERSED', 'SIMULATED_REVERSED'].includes(adapterResult.status)) {
        const reversalMsg =
            adapterResult.status === 'SIMULATED_REVERSED'
                ? 'Simulated rollback recorded (non-financial)'
                : 'Adapter reported reversal';
        await pool.query(
            "UPDATE instructions SET state = 'SIMULATED', external_intent_id = $1, error_message = $2, updated_at = NOW() WHERE instruction_id = $3",
            [adapterResult.intent_id || null, reversalMsg, instructionId]
        );
        logger.info(
            `[SAGA-EXEC] 🔄 Reversal status recorded for ${instructionId} (State: SIMULATED, Ledger: BYPASSED)`
        );
    } else {
        await pool.query(
            "UPDATE instructions SET state = 'FAILED', error_message = $1, updated_at = NOW() WHERE instruction_id = $2",
            [adapterResult.error || 'Adapter indicated execution failure', instructionId]
        );
    }
}

module.exports = {
    processInstructionSagaAtomic,
    executeInstructionInternal,
};
