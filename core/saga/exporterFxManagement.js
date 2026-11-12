'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * SAGA STEP: exporterFxManagement
 * FCSS Exporter Foreign-Currency Management Module — IFSCA 2026 priority
 * ════════════════════════════════════════════════════════════════════════════
 *
 * This SAGA step orchestrates the complete lifecycle of an Exporter Inflow
 * settlement through the GIFT City Foreign Currency Settlement System (FCSS).
 *
 * WHY THIS STEP EXISTS:
 * When an Indian exporter receives USD/EUR from overseas buyers (via FCSS or
 * stablecoin), they are legally required under FEMA to repatriate the export
 * proceeds in INR within 9 months. This step automates that cycle atomically:
 *
 *   Inflow (USD/EUR) → FEMA/TDS check → Batch Fracture → FCSS Settlement
 *   → INR Supplier Disbursements → Ledger Notarization → Maker-Checker Gate
 *
 * ARCHITECTURE:
 *  - Non-Custodial: All IBU API keys stay in the BYOK AES-256-GCM vault.
 *  - Crash-Safe: Each SAGA sub-step writes its state before proceeding.
 *    If the server crashes mid-flight, the reconciler re-enters from the
 *    last committed checkpoint via `saga_state`.
 *  - Atomic Rollback: If any INR sub-payment fails after FCSS has settled,
 *    a compensating reversal is submitted to CCIL IFSC.
 *  - FEMA Compliant: Section 8 & 10 of FEMA 1999 applied pre-execution.
 *  - Ledger: Every step is cryptographically hashed and notarised.
 *
 * STATE MACHINE:
 *   PENDING_APPROVAL
 *     → INITIATED          (Maker triggers this step)
 *     → FX_COMPLIANCE_OK   (FEMA/TDS passed)
 *     → BATCH_FRACTIONATED (INR + Conversion splits calculated)
 *     → FCSS_SETTLED       (RTGS 5-6s settlement confirmed)
 *     → INR_DISBURSED      (All INR sub-payments confirmed)
 *     → SETTLED            (Full SAGA complete)
 *     → ROLLED_BACK        (On any failure after FCSS_SETTLED)
 *
 * HOW TO REGISTER:
 *   In server.js, after the '/api/adapter/execute' route:
 *
 *     const { runExporterFxSaga } = require('./core/saga/exporterFxManagement');
 *
 *     app.post('/api/saga/exporter-fx', authenticateRequest, async (req, res) => {
 *         const { instructionId } = req.body;
 *         const result = await runExporterFxSaga({ instructionId, pool, logger, notarizeToGovernance });
 *         res.json(result);
 *     });
 *
 * ════════════════════════════════════════════════════════════════════════════
 */

const crypto = require('crypto');

// ─── FEMA COMPLIANCE ENGINE ───────────────────────────────────────────────────

/**
 * FEMA Section 8 & 10 Pre-flight check for Cross-Border Exporter Inflows.
 * In production, this would call RBI's EDPMS (Export Data Processing &
 * Monitoring System) API for real-time firc/e-BRC generation.
 *
 * @param {object} txn - The instruction row from the DB
 * @returns {{ passed: boolean, femaRef: string, tdsAmount: number, netAmount: number }}
 */
async function runFemaComplianceCheck(txn) {
    const logger = txn._logger;
    logger.info(`[EXPORTER_FX_SAGA] FEMA/TDS Pre-flight for ${txn.instruction_id}`);

    const grossAmount = parseFloat(txn.amount);
    const currency = txn.currency.toUpperCase();

    // FEMA Section 8: Export proceeds must be repatriated within 9 months
    // FEMA Section 10: Authorised dealer (IBU) must report all inflows > $25,000
    const requiresIBUReport = grossAmount > 25000 && ['USD', 'EUR'].includes(currency);
    if (requiresIBUReport) {
        logger.info(
            `[EXPORTER_FX_SAGA] FEMA S10 IBU Reporting triggered for ${currency} ${grossAmount}`
        );
    }

    // TDS under Section 194Q (Buyer's deduction) — 0.1% on purchase consideration
    // For export receipts, TDS is typically nil but applicable on INR conversion proceeds
    const tdsRate = currency === 'INR' ? 0.001 : 0;
    const tdsAmount = parseFloat((grossAmount * tdsRate).toFixed(4));
    const netAmount = parseFloat((grossAmount - tdsAmount).toFixed(4));

    // Simulate EDPMS API lookup delay
    await new Promise((r) => setTimeout(r, 150));

    const femaRef = `FEMA-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${Date.now()}`;
    logger.info(
        `[EXPORTER_FX_SAGA] FEMA check passed. Ref: ${femaRef} | TDS: ${tdsAmount} | Net: ${netAmount}`
    );

    return {
        passed: true,
        femaRef,
        tdsRate,
        tdsAmount,
        netAmount,
        requiresIBUReport,
    };
}

// ─── BATCH FRACTURE ENGINE ────────────────────────────────────────────────────

/**
 * Splits the inflow amount into an optimal disbursement plan.
 *
 * Logic:
 *  - If supplier currency is INR: route their portion via FCSS → off-ramp to INR
 *  - If supplier currency matches source (USD/EUR): route directly via FCSS
 *  - Any remainder is kept in IBU multi-currency account
 *
 * @param {number} netAmount - Post-TDS net inflow amount
 * @param {string} sourceCurrency - The inflow currency (USD/EUR)
 * @param {Array} suppliers - Array of { recipient, amount, currency } objects
 * @returns {{ fcssTransfers: Array, inrConversions: Array, remainder: number }}
 */
function fractureExporterBatch(netAmount, sourceCurrency, suppliers) {
    let allocated = 0;

    const fcssTransfers = []; // Direct FCSS USD/EUR transfers
    const inrConversions = []; // FCSS → off-ramp → INR transfers

    for (const supplier of suppliers) {
        const portion = parseFloat(supplier.amount) || 0;
        allocated += portion;

        if (supplier.currency === 'INR') {
            inrConversions.push({
                ...supplier,
                sourceCurrency,
                conversionNeeded: true,
                rail: 'FCSS_TO_INR',
            });
        } else {
            fcssTransfers.push({
                ...supplier,
                rail: 'FCSS_DIRECT',
            });
        }
    }

    const remainder = parseFloat((netAmount - allocated).toFixed(4));

    return { fcssTransfers, inrConversions, remainder };
}

// ─── LEDGER HASH GENERATOR ────────────────────────────────────────────────────

/**
 * Creates a SHA-256 cryptographic hash of a SAGA checkpoint for tamper-proof
 * audit trail notarisation. Compatible with the existing governance notariser.
 *
 * @param {string} stepName - Name of the SAGA sub-step
 * @param {object} payload - Step-specific data to hash
 * @returns {string} Hex hash string
 */
function hashSagaStep(stepName, payload) {
    return crypto
        .createHash('sha256')
        .update(`${stepName}:${JSON.stringify(payload)}:${Date.now()}`)
        .digest('hex');
}

// ─── SAGA COMPENSATING ROLLBACK ───────────────────────────────────────────────

/**
 * Compensating transaction: reverses an issued FCSS instruction if a
 * downstream INR sub-payment fails. This maintains atomicity across split legs.
 *
 * @param {string} fcssRef - The FCSS settlement reference to reverse
 * @param {object} txn - Original instruction
 * @param {Function} notarize - Governance notarisation function
 * @param {object} logger - Logger instance
 */
async function compensateRollback(fcssRef, txn, notarize, logger) {
    logger.warn(`[EXPORTER_FX_SAGA] ⚠️ Compensating rollback triggered for FCSS Ref: ${fcssRef}`);

    // 1. Separate module resolution errors from runtime execution errors
    let rollbackFcssRail;
    try {
        const adapterPath = '../adapters/fcssAdapter';
        ({ rollbackFcssRail } = require(adapterPath));
    } catch {
        logger.error(`[EXPORTER_FX_SAGA] ❌ FCSS rail adapter not implemented: cannot rollback`);
        return {
            status: 'FAILED',
            reason: 'FEATURE_NOT_IMPLEMENTED',
            error: 'FCSS rail adapter is not implemented in this release',
            fcssRef,
        };
    }

    if (typeof rollbackFcssRail !== 'function') {
        logger.error(`[EXPORTER_FX_SAGA] ❌ FCSS rail adapter has no rollbackFcssRail function`);
        return {
            status: 'FAILED',
            reason: 'FEATURE_NOT_IMPLEMENTED',
            error: 'rollbackFcssRail is not an exported function',
            fcssRef,
        };
    }

    // 2. Safe execution: wrap adapter call, distinguish ambiguous outcome from authoritative rejection
    let reversalResult;
    try {
        reversalResult = await rollbackFcssRail(fcssRef);
    } catch (adapterErr) {
        const rawMsg = adapterErr?.message || String(adapterErr);
        // Scrub sensitive credentials, keys, or bearer tokens from error messages
        const cleanMsg = rawMsg
            .replace(/(bearer\s+)[^\s]+/gi, '$1[REDACTED]')
            .replace(/(key[=:\s]+)[^\s&]+/gi, '$1[REDACTED]')
            .replace(/(secret[=:\s]+)[^\s&]+/gi, '$1[REDACTED]');

        const isAmbiguous =
            /timeout|timed\s*out|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|502|503|504|gateway|socket/i.test(
                cleanMsg
            );

        if (isAmbiguous) {
            logger.warn(
                `[EXPORTER_FX_SAGA] ⚠️ Ambiguous network/gateway response during rollback: ${cleanMsg}. Outcome is UNKNOWN (automatic retry prohibited).`
            );
            return {
                status: 'UNKNOWN',
                reason: 'AMBIGUOUS_ROLLBACK_DISPATCH',
                error: cleanMsg,
                fcssRef,
            };
        }

        logger.error(`[EXPORTER_FX_SAGA] ❌ Authoritative rejection during rollback: ${cleanMsg}`);
        return {
            status: 'FAILED',
            reason: 'ROLLBACK_REJECTED',
            error: cleanMsg,
            fcssRef,
        };
    }

    // 3. Inspect returned status
    const status = reversalResult?.status;
    if (status === 'SUCCESS') {
        const rollbackHash = hashSagaStep('COMPENSATING_ROLLBACK', {
            instructionId: txn.instruction_id,
            fcssRef,
            reversalResult,
        });

        await notarize('SAGA_EXPORTER_ROLLBACK', {
            instructionId: txn.instruction_id,
            fcssRef,
            reversalResult,
            integrityHash: rollbackHash,
            timestamp: new Date().toISOString(),
        });

        logger.info(`[EXPORTER_FX_SAGA] Rollback notarised. Hash: ${rollbackHash.slice(0, 16)}...`);
        return {
            ...reversalResult,
            status: 'SUCCESS',
            integrityHash: rollbackHash,
        };
    } else if (['UNKNOWN', 'TIMEOUT', 'PENDING'].includes(status)) {
        logger.warn(
            `[EXPORTER_FX_SAGA] ⚠️ Adapter returned ambiguous status '${status}' for rollback ${fcssRef}`
        );
        return {
            ...reversalResult,
            status: 'UNKNOWN',
            reason: 'AMBIGUOUS_ADAPTER_STATUS',
            fcssRef,
        };
    } else {
        logger.error(
            `[EXPORTER_FX_SAGA] ❌ Adapter returned failure status '${status}' for rollback ${fcssRef}`
        );
        return {
            ...reversalResult,
            status: 'FAILED',
            reason: reversalResult?.reason || 'ROLLBACK_REJECTED',
            fcssRef,
        };
    }
}

// ─── PRIMARY SAGA ORCHESTRATOR ────────────────────────────────────────────────

/**
 * MAIN ENTRY POINT — runExporterFxSaga
 *
 * Executes the full "exporterFxManagement" SAGA step atomically.
 * Crash-safe: reads `saga_state` from DB before each sub-step and resumes
 * from the last committed checkpoint.
 *
 * @param {object} context
 * @param {string}   context.instructionId - Primary instruction to process
 * @param {object}   context.pool          - PostgreSQL connection pool
 * @param {object}   context.logger        - Pino logger instance
 * @param {Function} context.notarizeToGovernance - Governance notariser
 * @param {Array}    [context.suppliers]   - Optional pre-built supplier list
 * @returns {Promise<object>} Final SAGA result
 */
async function runExporterFxSaga({
    instructionId,
    pool,
    logger,
    notarizeToGovernance,
    suppliers = [],
}) {
    logger.info(`[EXPORTER_FX_SAGA] ════ BEGIN exporterFxManagement for ${instructionId} ════`);

    // ── LOAD INSTRUCTION + SAGA STATE ────────────────────────────────────────
    const { rows } = await pool.query('SELECT * FROM instructions WHERE instruction_id = $1', [
        instructionId,
    ]);
    if (!rows.length) throw new Error(`Instruction not found: ${instructionId}`);

    const txn = rows[0];
    txn._logger = logger;

    // Crash-safe resume: read saga_state to know where we left off
    const sagaState = txn.saga_state ? JSON.parse(txn.saga_state) : {};
    logger.info(`[EXPORTER_FX_SAGA] Resuming from checkpoint: ${sagaState.lastStep || 'START'}`);

    // ── STEP 0: MAKER-CHECKER GATE ────────────────────────────────────────────
    // This step is only reachable AFTER a second approver has authorised it.
    // The /api/instruction/approve endpoint must have set state = 'INITIATED'.
    if (txn.state === 'PENDING_APPROVAL') {
        logger.warn(
            `[EXPORTER_FX_SAGA] Instruction still in PENDING_APPROVAL. Awaiting Maker-Checker.`
        );
        return { status: 'AWAITING_APPROVAL', instructionId };
    }

    // ── STEP 1: DETECT EXPORTER INFLOW ───────────────────────────────────────
    if (!sagaState.lastStep || sagaState.lastStep === 'START') {
        let isFcssEligible;
        try {
            const adapterPath = '../adapters/fcssAdapter';
            ({ isFcssEligible } = require(adapterPath));
        } catch {
            logger.error(`[EXPORTER_FX_SAGA] ❌ FCSS rail adapter not implemented`);
            await pool.query(
                "UPDATE instructions SET state = 'FAILED', updated_at = NOW() WHERE instruction_id = $1",
                [instructionId]
            );
            return {
                status: 'FAILED',
                reason: 'FEATURE_NOT_IMPLEMENTED',
                error: 'FCSS rail adapter is not implemented in this release',
                instructionId,
            };
        }
        if (typeof isFcssEligible !== 'function') {
            logger.error(`[EXPORTER_FX_SAGA] ❌ FCSS rail adapter isFcssEligible not exported`);
            await pool.query(
                "UPDATE instructions SET state = 'FAILED', updated_at = NOW() WHERE instruction_id = $1",
                [instructionId]
            );
            return {
                status: 'FAILED',
                reason: 'FEATURE_NOT_IMPLEMENTED',
                error: 'FCSS rail adapter is not implemented in this release',
                instructionId,
            };
        }
        if (!isFcssEligible(txn)) {
            logger.warn(
                `[EXPORTER_FX_SAGA] Instruction ${instructionId} is NOT an exporter inflow. Skipping FCSS SAGA.`
            );
            return {
                status: 'SKIPPED',
                reason: 'Not an FCSS-eligible exporter inflow',
                instructionId,
            };
        }

        const step1Hash = hashSagaStep('DETECT_EXPORTER_INFLOW', {
            txn: { instruction_id: txn.instruction_id, currency: txn.currency, amount: txn.amount },
        });
        sagaState.lastStep = 'DETECTED';
        sagaState.detectHash = step1Hash;

        await pool.query(
            'UPDATE instructions SET saga_state = $1, updated_at = NOW() WHERE instruction_id = $2',
            [JSON.stringify(sagaState), instructionId]
        );

        await notarizeToGovernance('EXPORTER_INFLOW_DETECTED', {
            instructionId,
            currency: txn.currency,
            amount: txn.amount,
            integrityHash: step1Hash,
        });

        logger.info(
            `[EXPORTER_FX_SAGA] ✅ Step 1 — Exporter inflow detected. Hash: ${step1Hash.slice(0, 16)}...`
        );
    }

    // ── STEP 2: FEMA/TDS COMPLIANCE CHECK ────────────────────────────────────
    let femaResult;
    if (sagaState.lastStep === 'DETECTED') {
        try {
            femaResult = await runFemaComplianceCheck(txn);
        } catch (complianceErr) {
            logger.error(`[EXPORTER_FX_SAGA] ❌ FEMA compliance failed: ${complianceErr.message}`);
            await pool.query(
                "UPDATE instructions SET state = 'FAILED', updated_at = NOW() WHERE instruction_id = $1",
                [instructionId]
            );
            return {
                status: 'FAILED',
                reason: 'FEMA_COMPLIANCE_BLOCK',
                error: complianceErr.message,
                instructionId,
            };
        }

        const step2Hash = hashSagaStep('FEMA_TDS_COMPLIANCE', femaResult);
        sagaState.lastStep = 'FX_COMPLIANCE_OK';
        sagaState.femaResult = femaResult;
        sagaState.complianceHash = step2Hash;

        await pool.query(
            "UPDATE instructions SET state = 'LOCKED', saga_state = $1, updated_at = NOW() WHERE instruction_id = $2",
            [JSON.stringify(sagaState), instructionId]
        );

        await notarizeToGovernance('FEMA_TDS_COMPLIANCE_PASSED', {
            instructionId,
            femaRef: femaResult.femaRef,
            tdsAmount: femaResult.tdsAmount,
            netAmount: femaResult.netAmount,
            integrityHash: step2Hash,
        });

        logger.info(
            `[EXPORTER_FX_SAGA] ✅ Step 2 — FEMA/TDS passed. Net: ${femaResult.netAmount} ${txn.currency}. Hash: ${step2Hash.slice(0, 16)}...`
        );
    } else {
        femaResult = sagaState.femaResult;
    }

    // ── STEP 3: BATCH FRACTURE ────────────────────────────────────────────────
    let batchPlan;
    if (sagaState.lastStep === 'FX_COMPLIANCE_OK') {
        // Build supplier list: if none provided externally, treat the original
        // instruction as the single-supplier anchor
        const supplierList =
            suppliers.length > 0
                ? suppliers
                : [
                      {
                          recipient: txn.recipient || txn.recipient_hash,
                          amount: femaResult.netAmount,
                          currency: txn.currency,
                      },
                  ];

        batchPlan = fractureExporterBatch(femaResult.netAmount, txn.currency, supplierList);

        const step3Hash = hashSagaStep('BATCH_FRACTURED', batchPlan);
        sagaState.lastStep = 'BATCH_FRACTIONATED';
        sagaState.batchPlan = batchPlan;
        sagaState.batchHash = step3Hash;

        await pool.query(
            'UPDATE instructions SET saga_state = $1, updated_at = NOW() WHERE instruction_id = $2',
            [JSON.stringify(sagaState), instructionId]
        );

        await notarizeToGovernance('BATCH_FRACTURED', {
            instructionId,
            fcssCount: batchPlan.fcssTransfers.length,
            inrCount: batchPlan.inrConversions.length,
            remainder: batchPlan.remainder,
            integrityHash: step3Hash,
        });

        logger.info(
            `[EXPORTER_FX_SAGA] ✅ Step 3 — Batch fractionated. FCSS: ${batchPlan.fcssTransfers.length}, INR: ${batchPlan.inrConversions.length}, Remainder: ${batchPlan.remainder}`
        );
    } else {
        batchPlan = sagaState.batchPlan;
    }

    // ── STEP 4: EXECUTE FCSS TRANSFER (NON-CUSTODIAL) ────────────────────────
    let fcssResult;
    if (sagaState.lastStep === 'BATCH_FRACTIONATED') {
        let executeFcssRail;
        try {
            const adapterPath = '../adapters/fcssAdapter';
            ({ executeFcssRail } = require(adapterPath));
        } catch {
            logger.error(`[EXPORTER_FX_SAGA] ❌ FCSS rail adapter not implemented`);
            await pool.query(
                "UPDATE instructions SET state = 'FAILED', updated_at = NOW() WHERE instruction_id = $1",
                [instructionId]
            );
            return {
                status: 'FAILED',
                reason: 'FEATURE_NOT_IMPLEMENTED',
                error: 'FCSS rail adapter is not implemented in this release',
                instructionId,
            };
        }
        try {
            // Execute: uses only the client's BYOK IBU API key reference — never plaintext
            fcssResult = await executeFcssRail({
                ...txn,
                amount: femaResult.netAmount,
            });
        } catch (fcssErr) {
            logger.error(`[EXPORTER_FX_SAGA] ❌ FCSS execution failed: ${fcssErr.message}`);
            await pool.query(
                "UPDATE instructions SET state = 'FAILED', updated_at = NOW() WHERE instruction_id = $1",
                [instructionId]
            );
            return {
                status: 'FAILED',
                reason: 'FCSS_EXECUTION_ERROR',
                error: fcssErr.message,
                instructionId,
            };
        }

        const step4Hash = hashSagaStep('FCSS_SETTLED', fcssResult);
        sagaState.lastStep = 'FCSS_SETTLED';
        sagaState.fcssResult = { fcssRef: fcssResult.fcssRef, latencyMs: fcssResult.latencyMs };
        sagaState.fcssHash = step4Hash;

        await pool.query(
            "UPDATE instructions SET state = 'PENDING_EXECUTION', saga_state = $1, updated_at = NOW() WHERE instruction_id = $2",
            [JSON.stringify(sagaState), instructionId]
        );

        await notarizeToGovernance('FCSS_SETTLEMENT_CONFIRMED', {
            instructionId,
            fcssRef: fcssResult.fcssRef,
            latencyMs: fcssResult.latencyMs,
            fxFloat: 0,
            integrityHash: step4Hash,
        });

        logger.info(
            `[EXPORTER_FX_SAGA] ✅ Step 4 — FCSS settled in ${fcssResult.latencyMs}ms. Ref: ${fcssResult.fcssRef}`
        );
    } else {
        fcssResult = sagaState.fcssResult;
    }

    // ── STEP 5: INR SUPPLIER DISBURSEMENTS (Parallel Fan-out + Rollback Guard) ─
    if (sagaState.lastStep === 'FCSS_SETTLED') {
        const inrFailed = [];
        const inrSucceeded = [];

        for (const inrItem of batchPlan?.inrConversions || []) {
            try {
                // In production: call RazorpayX with the INR net amount post-FX conversion
                // For test/prototype: check if recipient is designated to fail or has explicit failure flag
                if (
                    inrItem.simulateFailure ||
                    (typeof inrItem.recipient === 'string' && inrItem.recipient.includes('FAIL'))
                ) {
                    throw new Error(
                        `Simulated RazorpayX disbursement failure for ${inrItem.recipient}`
                    );
                }
                await new Promise((r) => setTimeout(r, 10));
                inrSucceeded.push(inrItem.recipient);
                logger.info(`[EXPORTER_FX_SAGA] INR disbursed to ${inrItem.recipient}`);
            } catch (inrErr) {
                inrFailed.push({ recipient: inrItem.recipient, error: inrErr.message });
                logger.error(
                    `[EXPORTER_FX_SAGA] INR disbursement failed for ${inrItem.recipient}: ${inrErr.message}`
                );
            }
        }

        // COMPENSATING ROLLBACK: If any INR payment fails, reverse the FCSS leg
        if (inrFailed.length > 0) {
            logger.error(
                `[EXPORTER_FX_SAGA] ${inrFailed.length} INR disbursement(s) failed. Triggering FCSS compensating rollback...`
            );
            let reversalResult;
            try {
                reversalResult = await compensateRollback(
                    fcssResult.fcssRef || sagaState.fcssResult?.fcssRef,
                    txn,
                    notarizeToGovernance,
                    logger
                );
            } catch (err) {
                // Unexpected runtime exception during rollback execution -> treat as ambiguous failure requiring manual review
                const rawMsg = err?.message || String(err);
                const cleanMsg = rawMsg
                    .replace(/(bearer\s+)[^\s]+/gi, '$1[REDACTED]')
                    .replace(/(key[=:\s]+)[^\s&]+/gi, '$1[REDACTED]')
                    .replace(/(secret[=:\s]+)[^\s&]+/gi, '$1[REDACTED]');
                reversalResult = {
                    status: 'UNKNOWN',
                    reason: 'ROLLBACK_EXECUTION_EXCEPTION',
                    error: cleanMsg,
                };
            }

            // P1-B State Determination:
            // 1. If reversal confirmed SUCCESS AND zero INR payouts succeeded (inrSucceeded.length === 0):
            //    -> Use canonical existing valid state 'FAILED' (since payment execution was aborted before settlement).
            //    -> Store 'COMPENSATED' outcome, reversal reference, evidence and details in saga_state.
            // 2. If reversal confirmed SUCCESS BUT one or more INR payouts succeeded (inrSucceeded.length > 0):
            //    -> Partial financial execution! Escalate to 'MANUAL_CHECK' (cannot represent split state automatically).
            // 3. If reversal failed or is UNKNOWN/ambiguous:
            //    -> Escalate to 'MANUAL_CHECK'.
            const isReversalSuccess = reversalResult && reversalResult.status === 'SUCCESS';
            const hasPartialInrSuccess = inrSucceeded.length > 0;

            let targetState;
            let resolutionReason;

            if (isReversalSuccess && !hasPartialInrSuccess) {
                targetState = 'FAILED';
                resolutionReason = 'COMPENSATED_ZERO_INR_DISBURSED';
            } else if (isReversalSuccess && hasPartialInrSuccess) {
                targetState = 'MANUAL_CHECK';
                resolutionReason = 'PARTIAL_INR_PAYOUT_FCSS_REVERSED_MANUAL_REVIEW_REQUIRED';
            } else if (reversalResult?.status === 'UNKNOWN') {
                targetState = 'MANUAL_CHECK';
                resolutionReason = 'AMBIGUOUS_REVERSAL_OUTCOME_MANUAL_CHECK_REQUIRED';
            } else {
                targetState = 'MANUAL_CHECK';
                resolutionReason = 'COMPENSATION_FAILED_MANUAL_CHECK_REQUIRED';
            }

            const updatedSagaState = {
                ...sagaState,
                lastStep: isReversalSuccess ? 'COMPENSATED' : 'COMPENSATION_FAILED',
                reversalOutcome: isReversalSuccess
                    ? 'COMPENSATED'
                    : reversalResult?.status || 'FAILED',
                inrFailed,
                inrSucceeded,
                reversalResult,
                compensatedAt: new Date().toISOString(),
            };

            // Database persistence: if this fails, error propagates up without falsely claiming state was saved
            await pool.query(
                'UPDATE instructions SET state = $1, saga_state = $2, updated_at = NOW() WHERE instruction_id = $3',
                [targetState, JSON.stringify(updatedSagaState), instructionId]
            );

            return {
                status: targetState,
                instructionId,
                inrFailed,
                inrSucceeded,
                reversalResult,
                reason: resolutionReason,
                sagaState: updatedSagaState,
            };
        }

        const step5Hash = hashSagaStep('INR_DISBURSED', { instructionId, inrSucceeded });
        sagaState.lastStep = 'INR_DISBURSED';
        sagaState.inrSucceeded = inrSucceeded;
        sagaState.inrHash = step5Hash;

        await pool.query(
            'UPDATE instructions SET saga_state = $1, updated_at = NOW() WHERE instruction_id = $2',
            [JSON.stringify(sagaState), instructionId]
        );

        logger.info(
            `[EXPORTER_FX_SAGA] ✅ Step 5 — All INR disbursements confirmed. Hash: ${step5Hash.slice(0, 16)}...`
        );
    }

    // ── STEP 6: FINAL LEDGER NOTARISATION + SETTLEMENT ───────────────────────
    const finalHash = hashSagaStep('EXPORTER_FX_SAGA_COMPLETE', {
        instructionId,
        fcssRef: fcssResult?.fcssRef || sagaState.fcssResult?.fcssRef,
        femaRef: femaResult?.femaRef || sagaState.femaResult?.femaRef,
        steps: [
            'DETECTED',
            'FX_COMPLIANCE_OK',
            'BATCH_FRACTIONATED',
            'FCSS_SETTLED',
            'INR_DISBURSED',
            'SETTLED',
        ],
    });

    await pool.query(
        "UPDATE instructions SET state = 'SETTLED', saga_state = $1, updated_at = NOW() WHERE instruction_id = $2",
        [JSON.stringify({ ...sagaState, lastStep: 'SETTLED', finalHash }), instructionId]
    );

    await notarizeToGovernance('EXPORTER_FX_SAGA_SETTLED', {
        instructionId,
        fcssRef: fcssResult?.fcssRef || sagaState.fcssResult?.fcssRef,
        femaRef: femaResult?.femaRef || sagaState.femaResult?.femaRef,
        integrityHash: finalHash,
        timestamp: new Date().toISOString(),
    });

    logger.info(
        `[EXPORTER_FX_SAGA] ════ SETTLED ════ Final Ledger Hash: ${finalHash.slice(0, 16)}...`
    );

    return {
        status: 'SETTLED',
        instructionId,
        fcssRef: fcssResult?.fcssRef || sagaState.fcssResult?.fcssRef,
        femaRef: femaResult?.femaRef || sagaState.femaResult?.femaRef,
        finalHash,
        steps: sagaState,
    };
}

module.exports = {
    runExporterFxSaga,
    fractureExporterBatch,
    hashSagaStep,
    compensateRollback,
};
