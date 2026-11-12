'use strict';

/**
 * PROJECT FUSION — WEBHOOK PROCESSOR & SECURITY VERIFICATION
 * ============================================================
 * Implements institutional-grade webhook security and idempotency:
 * 1. Stripe official SDK signature verification (`stripe.webhooks.constructEvent`)
 * 2. RazorpayX HMAC-SHA256 signature verification with timing-safe comparison
 * 3. Provider-scoped atomic deduplication (`processed_webhook_events`)
 * 4. Safe state transitions preventing duplicate settlements & handling post-settlement events
 * 5. Strict testnet/sandbox enforcement (rejects livemode events)
 */

const crypto = require('crypto');
const Stripe = require('stripe');
const logger = require('../../logger');
const { writeLedger, writeCompensatingLedger, verifyLedgerIntegrity } = require('../orchestrator/ledgerUtils');
const { toCanonicalMinorUnits, fromCanonicalMinorUnits } = require('../orchestrator/financialDecimal');

/**
 * Timing-safe string comparison to protect against side-channel timing attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifies Stripe webhook payload using the official Stripe SDK constructEvent.
 * Enforces test-mode activity only (rejects livemode: true).
 *
 * @param {Buffer|string} rawBody - Exact raw HTTP request body
 * @param {string} signature - Value from Stripe-Signature header
 * @param {string} secret - Dedicated Stripe test webhook secret (whsec_*)
 * @returns {object} Stripe Event object
 */
function verifyStripeSignature(rawBody, signature, secret) {
    if (!rawBody) {
        const err = new Error('Missing raw request body for Stripe signature verification');
        err.statusCode = 400;
        throw err;
    }
    if (!signature) {
        const err = new Error('Missing Stripe-Signature header');
        err.statusCode = 400;
        throw err;
    }
    if (!secret) {
        const err = new Error('STRIPE_WEBHOOK_SECRET is not configured');
        err.statusCode = 500;
        throw err;
    }

    const stripeKey = process.env.STRIPE_TEST_SECRET_KEY || 'sk_test_placeholder';
    const stripe = new Stripe(stripeKey, {
        apiVersion: '2023-10-16',
    });

    // stripe.webhooks.constructEvent throws if signature/timestamp/secret is invalid or payload was tampered
    let event;
    try {
        event = stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (e) {
        const err = new Error(`Stripe signature verification failed: ${e.message}`);
        err.statusCode = 400;
        throw err;
    }

    // Strict Testnet Enforcement: reject any event flagged with livemode = true
    if (event.livemode === true) {
        const err = new Error('CRITICAL: Production livemode Stripe event detected! Project Fusion strictly prohibits live operations.');
        err.statusCode = 400;
        throw err;
    }

    return event;
}

/**
 * Verifies RazorpayX webhook signature using HMAC-SHA256 and timing-safe comparison.
 * Enforces that the dedicated webhook secret is used (NOT the API key secret).
 *
 * @param {Buffer|string} rawBody - Exact raw HTTP request body
 * @param {string} signature - Value from X-Razorpay-Signature header
 * @param {string} secret - Dedicated RazorpayX webhook signing secret
 * @returns {boolean} True if signature is cryptographically valid
 */
function verifyRazorpayXSignature(rawBody, signature, secret) {
    if (!rawBody || !signature) {
        return false;
    }
    if (!secret) {
        const err = new Error('RAZORPAYX_WEBHOOK_SECRET is not configured');
        err.statusCode = 500;
        throw err;
    }

    // Security Rule: Do NOT use the Razorpay API key secret as the webhook secret
    if (process.env.RAZORPAY_KEY_SECRET && secret === process.env.RAZORPAY_KEY_SECRET) {
        const err = new Error('SECURITY VIOLATION: Razorpay API key secret must NOT be used as the webhook signing secret.');
        err.statusCode = 500;
        throw err;
    }

    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');

    return timingSafeEqual(signature, expectedSignature);
}

/**
 * Atomically processes a verified webhook event with deduplication and safe state transitions.
 *
 * @param {object} params
 * @param {object} params.pool - PostgreSQL connection pool
 * @param {string} params.provider - 'STRIPE' | 'RAZORPAYX'
 * @param {string} params.eventId - Provider event ID
 * @param {string} params.eventType - Provider event type (e.g. 'payment_intent.succeeded')
 * @param {string} [params.intentId] - External transaction reference (e.g. pi_..., pout_...)
 * @param {string} [params.instructionId] - Internal instruction UUID if available
 * @param {Buffer|string} params.rawBody - Raw request body for hash calculation
 * @param {object} [params.payload] - Parsed event payload
 * @param {string} [params.failureReason] - Reason message for failure events
 * @param {Function} [params.writeLedgerFn] - Injected writeLedger implementation (defaults to production ledgerUtils)
 * @param {Function} [params.verifyLedgerIntegrityFn] - Injected verifyLedgerIntegrity implementation
 * @returns {Promise<{ status: number, body: object }>}
 */
async function processWebhookEvent({
    pool,
    provider,
    eventId,
    eventType,
    intentId,
    instructionId,
    rawBody,
    payload = {},
    failureReason,
    writeLedgerFn = writeLedger,
    writeCompensatingLedgerFn = writeCompensatingLedger,
    verifyLedgerIntegrityFn = verifyLedgerIntegrity,
}) {
    // 1. Mandatory Identifier Validation
    if (!eventId || typeof eventId !== 'string' || eventId.trim() === '') {
        return {
            status: 400,
            body: { error: 'Missing required webhook event identifier' },
        };
    }

    if (!intentId && !instructionId) {
        return {
            status: 400,
            body: { error: 'Invalid webhook payload: Missing intent ID or instruction reference' },
        };
    }

    const payloadHash = crypto
        .createHash('sha256')
        .update(rawBody || '')
        .digest('hex');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 2. PROVIDER-SCOPED DEDUPLICATION (Atomic DB Level)
        const insertEvent = await client.query(
            `INSERT INTO processed_webhook_events 
             (event_id, provider, event_type, instruction_id, external_intent_id, payload_hash)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (provider, event_id) DO NOTHING
             RETURNING event_id`,
            [eventId, provider, eventType, instructionId || null, intentId || null, payloadHash]
        );

        if (insertEvent.rows.length === 0) {
            // Event has ALREADY been processed! Replay or duplicate delivery detected.
            await client.query('ROLLBACK');
            logger.warn(`[WEBHOOK] 🛑 Duplicate event received and ignored: ${provider} event ${eventId}`);
            return {
                status: 200,
                body: { received: true, duplicate: true, message: 'Duplicate event ignored' },
            };
        }

        // 3. TRANSACTION LOOKUP & ROW LOCKING (FOR UPDATE)
        const rawObj = (payload && payload.data && payload.data.object) ? payload.data.object : (payload || {});
        const effectiveIntentId = intentId || rawObj.payment_intent || (rawObj.object === 'payment_intent' ? rawObj.id : (rawObj.id?.startsWith('pi_') ? rawObj.id : null));
        const effectiveInstructionId = instructionId || rawObj.metadata?.instruction_id || rawObj.metadata?.instructionId;

        let txnResult;
        if (effectiveIntentId) {
            txnResult = await client.query(
                'SELECT * FROM instructions WHERE external_intent_id = $1 FOR UPDATE',
                [effectiveIntentId]
            );
        }
        if ((!txnResult || txnResult.rows.length === 0) && rawObj.payment_intent && rawObj.payment_intent !== effectiveIntentId) {
            txnResult = await client.query(
                'SELECT * FROM instructions WHERE external_intent_id = $1 FOR UPDATE',
                [rawObj.payment_intent]
            );
        }
        if ((!txnResult || txnResult.rows.length === 0) && effectiveInstructionId) {
            txnResult = await client.query(
                'SELECT * FROM instructions WHERE instruction_id = $1 FOR UPDATE',
                [effectiveInstructionId]
            );
        }
        if ((!txnResult || txnResult.rows.length === 0) && intentId && intentId !== effectiveIntentId) {
            txnResult = await client.query(
                'SELECT * FROM instructions WHERE external_intent_id = $1 FOR UPDATE',
                [intentId]
            );
        }

        if (!txnResult || txnResult.rows.length === 0) {
            // Unknown provider reference! Roll back event recording so instruction can be linked if ingested later
            await client.query('ROLLBACK');
            logger.warn(`[WEBHOOK] ⚠️ Transaction not found for provider reference: ${intentId || instructionId}. Returning retryable 404 status.`);
            return {
                status: 404,
                body: { error: 'Instruction not found for reference', retryable: true, reference: intentId || instructionId },
            };
        }

        const txn = txnResult.rows[0];

        // Backfill instruction_id on processed_webhook_events if discovered via intentId
        if (!instructionId && txn.instruction_id) {
            await client.query(
                'UPDATE processed_webhook_events SET instruction_id = $1 WHERE provider = $2 AND event_id = $3',
                [txn.instruction_id, provider, eventId]
            );
        }

        // 4. PROVIDER-SPECIFIC STATE TRANSITIONS & SETTLEMENT LOGIC
        const isStripeSuccess = provider === 'STRIPE' && eventType === 'payment_intent.succeeded';
        const isRazorpaySuccess = provider === 'RAZORPAYX' && (
            eventType === 'payout.processed' || 
            payload?.status === 'processed' ||
            payload?.payload?.payout?.entity?.status === 'processed'
        );
        const isSuccess = isStripeSuccess || isRazorpaySuccess;

        const isStripeFailure = provider === 'STRIPE' && (
            eventType === 'payment_intent.payment_failed' || 
            eventType === 'charge.failed'
        );
        const isRazorpayFailure = provider === 'RAZORPAYX' && (
            eventType === 'payout.failed' || 
            eventType === 'payout.rejected'
        );
        const isFailure = isStripeFailure || isRazorpayFailure;

        const isStripeRefund = provider === 'STRIPE' && (
            eventType === 'charge.refunded' || 
            eventType === 'refund.created' ||
            eventType === 'refund.updated' ||
            eventType === 'refund.failed' ||
            eventType === 'charge.dispute.created'
        );
        const isRazorpayReversal = provider === 'RAZORPAYX' && (
            eventType === 'payout.reversed'
        );

        // A. SUCCESSFUL SETTLEMENT
        if (isSuccess) {
            if (txn.state === 'SETTLED') {
                // Prevent duplicate ledger settlement!
                logger.info(`[WEBHOOK] Instruction ${txn.instruction_id} is already SETTLED. Duplicate settlement prevented.`);
                await client.query('COMMIT');
                return {
                    status: 200,
                    body: { received: true, already_settled: true, instruction_id: txn.instruction_id },
                };
            }

            if (txn.state === 'FAILED' || txn.state === 'ROLLED_BACK') {
                logger.warn(`[WEBHOOK] Out-of-order success received for instruction ${txn.instruction_id} in terminal state ${txn.state}. Ignoring.`);
                await client.query('COMMIT');
                return {
                    status: 200,
                    body: { received: true, ignored: true, reason: `Instruction in terminal state ${txn.state}`, instruction_id: txn.instruction_id },
                };
            }

            // AMOUNT AND CURRENCY VERIFICATION (FAIL-CLOSED)
            if (provider === 'STRIPE') {
                const rawObj = (payload && Object.keys(payload).length > 0) ? payload : (rawBody ? (() => { try { return JSON.parse(rawBody.toString('utf8')); } catch { return {}; } })() : {});
                const obj = (rawObj && rawObj.data && rawObj.data.object) ? rawObj.data.object : (rawObj || {});
                const webhookCurrency = (obj.currency || '').toUpperCase();
                const instructionCurrency = (txn.currency || '').toUpperCase();

                if (webhookCurrency && instructionCurrency && webhookCurrency !== instructionCurrency) {
                    logger.error(`[WEBHOOK] ❌ Currency mismatch for ${txn.instruction_id}: instruction expects ${instructionCurrency}, webhook reported ${webhookCurrency}`);
                    await client.query(
                        "UPDATE instructions SET state = 'MANUAL_CHECK', error_message = $1, updated_at = NOW() WHERE instruction_id = $2",
                        [`Currency mismatch: expected ${instructionCurrency}, received ${webhookCurrency}`, txn.instruction_id]
                    );
                    await client.query('COMMIT');
                    return {
                        status: 200,
                        body: { received: true, mismatch: true, reason: 'CURRENCY_MISMATCH', instruction_id: txn.instruction_id },
                    };
                }

                const { toStripeMinorUnits } = require('../../adapters/paymentsAdapters');
                let expectedMinorUnits;
                try {
                    expectedMinorUnits = toStripeMinorUnits(txn.amount, txn.currency);
                } catch (convErr) {
                    logger.error(`[WEBHOOK] ❌ Amount validation conversion failure for ${txn.instruction_id}: ${convErr.message}`);
                    await client.query(
                        "UPDATE instructions SET state = 'MANUAL_CHECK', error_message = $1, updated_at = NOW() WHERE instruction_id = $2",
                        [`Amount validation conversion failure: ${convErr.message}`, txn.instruction_id]
                    );
                    await client.query('COMMIT');
                    return {
                        status: 200,
                        body: { received: true, mismatch: true, reason: 'CONVERSION_FAILURE', detail: convErr.message, instruction_id: txn.instruction_id },
                    };
                }

                const actualAmount = obj.amount_received !== undefined && obj.amount_received !== null ? obj.amount_received : obj.amount;
                if (rawObj && rawObj.data && rawObj.data.object && (actualAmount === undefined || actualAmount === null)) {
                    logger.error(`[WEBHOOK] ❌ Missing amount in webhook payload for ${txn.instruction_id}`);
                    await client.query(
                        "UPDATE instructions SET state = 'MANUAL_CHECK', error_message = $1, updated_at = NOW() WHERE instruction_id = $2",
                        ['Missing amount in webhook payload', txn.instruction_id]
                    );
                    await client.query('COMMIT');
                    return {
                        status: 200,
                        body: { received: true, mismatch: true, reason: 'MISSING_AMOUNT', instruction_id: txn.instruction_id },
                    };
                }

                if (actualAmount !== undefined && actualAmount !== null && Number(actualAmount) !== expectedMinorUnits) {
                    logger.error(`[WEBHOOK] ❌ Amount mismatch for ${txn.instruction_id}: expected ${expectedMinorUnits} minor units, webhook reported ${actualAmount}`);
                    await client.query(
                        "UPDATE instructions SET state = 'MANUAL_CHECK', error_message = $1, updated_at = NOW() WHERE instruction_id = $2",
                        [`Amount mismatch: expected ${expectedMinorUnits} minor units, received ${actualAmount}`, txn.instruction_id]
                    );
                    await client.query('COMMIT');
                    return {
                        status: 200,
                        body: { received: true, mismatch: true, reason: 'AMOUNT_MISMATCH', instruction_id: txn.instruction_id },
                    };
                }
            }

            logger.info(`[WEBHOOK] ✅ Finalizing Settlement for ${txn.instruction_id}`);

            // Double-entry ledger write (funds guaranteed moved)
            await writeLedgerFn(
                client,
                txn.instruction_id,
                txn.sender,
                txn.recipient,
                txn.amount,
                txn.currency,
                txn.tax_withheld || 0
            );

            // Double-entry ledger verification
            await verifyLedgerIntegrityFn(client, txn.instruction_id, txn.currency, txn.tax_withheld || 0);

            // Update state to SETTLED
            await client.query(
                "UPDATE instructions SET state = 'SETTLED', updated_at = NOW() WHERE instruction_id = $1",
                [txn.instruction_id]
            );

            await client.query('COMMIT');
            logger.info(`[WEBHOOK] 🎉 SAGA_COMPLETED successfully for ${txn.instruction_id}`);
            return {
                status: 200,
                body: { received: true, settled: true, instruction_id: txn.instruction_id },
            };
        }

        // B. PAYMENT FAILURE UPSTREAM
        if (isFailure) {
            if (txn.state === 'SETTLED') {
                // Out-of-order failure event arriving after settlement
                logger.warn(`[WEBHOOK] Out-of-order failure event received for already SETTLED instruction ${txn.instruction_id}. State preserved.`);
                await client.query('COMMIT');
                return {
                    status: 200,
                    body: { received: true, ignored: true, reason: 'Instruction already settled, out-of-order failure ignored', instruction_id: txn.instruction_id },
                };
            }

            if (txn.state === 'FAILED') {
                await client.query('COMMIT');
                return {
                    status: 200,
                    body: { received: true, already_failed: true, instruction_id: txn.instruction_id },
                };
            }

            logger.error(`[WEBHOOK] ❌ Payment Failed upstream for ${txn.instruction_id}: ${failureReason || 'Provider error'}`);
            await client.query(
                "UPDATE instructions SET state = 'FAILED', error_message = $1, updated_at = NOW() WHERE instruction_id = $2",
                [failureReason || 'Upstream provider payment failed', txn.instruction_id]
            );
            await client.query('COMMIT');
            return {
                status: 200,
                body: { received: true, failed: true, instruction_id: txn.instruction_id },
            };
        }

        // C. LEGITIMATE POST-SETTLEMENT REFUNDS & REVERSALS
        // Preserves the original settled payment record and posts compensating double-entry ledger entries.
        if (isStripeRefund) {
            const isSettledOrRefunded = txn.state === 'SETTLED' || 
                                        txn.status === 'PARTIALLY_REFUNDED' || 
                                        txn.status === 'SETTLED' || 
                                        txn.state === 'PARTIALLY_REFUNDED' ||
                                        txn.state === 'REFUNDED' ||
                                        txn.status === 'REFUNDED';

            if (!isSettledOrRefunded) {
                logger.warn(`[WEBHOOK] ⚠️ Out-of-order refund event received for non-settled instruction ${txn.instruction_id} in state ${txn.state}. Rolling back and returning retryable 409 Conflict.`);
                await client.query('ROLLBACK');
                return {
                    status: 409,
                    body: {
                        received: false,
                        retryable: true,
                        reason: 'INSTRUCTION_NOT_SETTLED',
                        message: `Instruction ${txn.instruction_id} is in state ${txn.state}; compensating refund cannot post before captured payment is established.`,
                        instruction_id: txn.instruction_id,
                    },
                };
            }

            // Extract metadata
            let meta = txn.metadata;
            if (typeof meta === 'string') {
                try { meta = JSON.parse(meta); } catch { meta = {}; }
            } else if (!meta || typeof meta !== 'object') {
                meta = {};
            }
            if (!Array.isArray(meta.refunds)) {
                meta.refunds = [];
            }

            // Identify refund candidates from payload
            const rawObj = (payload && payload.data && payload.data.object) ? payload.data.object : (payload || {});
            let refundItems = [];

            if (eventType === 'charge.refunded' && rawObj.refunds && Array.isArray(rawObj.refunds.data) && rawObj.refunds.data.length > 0) {
                // Multi-refund array from charge.refunded
                refundItems = rawObj.refunds.data.map((r) => ({
                    id: r.id,
                    amount_minor: BigInt(r.amount !== undefined ? r.amount : 0),
                    status: (r.status || 'succeeded').toLowerCase(),
                    currency: (r.currency || txn.currency).toUpperCase(),
                }));
            } else if (rawObj.id && typeof rawObj.id === 'string' && rawObj.id.startsWith('re_')) {
                // Direct refund object or mock refund payload
                const refundAmt = rawObj.amount !== undefined ? rawObj.amount : (rawObj.amount_refunded !== undefined ? rawObj.amount_refunded : 0);
                const refundStatus = (rawObj.status || (eventType === 'refund.failed' ? 'failed' : 'succeeded')).toLowerCase();
                refundItems = [{
                    id: rawObj.id,
                    amount_minor: BigInt(refundAmt !== undefined ? refundAmt : 0),
                    status: refundStatus,
                    currency: (rawObj.currency || txn.currency).toUpperCase(),
                }];
            } else if (eventType === 'charge.refunded' && (!rawObj.refunds || !Array.isArray(rawObj.refunds.data) || rawObj.refunds.data.length === 0)) {
                // Real Charge object without individual refund objects
                logger.warn(`[WEBHOOK] charge.refunded event ${eventId} carries no individual refund objects in refunds.data. Preserving idempotency without assuming cumulative charge amount is a new refund.`);
                await client.query('COMMIT');
                return {
                    status: 200,
                    body: { received: true, ignored: true, reason: 'CHARGE_REFUND_WITHOUT_ITEMS', instruction_id: txn.instruction_id },
                };
            } else {
                // Individual refund event (refund.created, refund.updated, refund.failed)
                const refundId = rawObj.id || rawObj.refund_id || eventId;
                const refundAmt = rawObj.amount !== undefined ? rawObj.amount : (rawObj.amount_refunded !== undefined ? rawObj.amount_refunded : 0);
                const refundStatus = (rawObj.status || (eventType === 'refund.failed' ? 'failed' : 'succeeded')).toLowerCase();
                refundItems = [{
                    id: refundId,
                    amount_minor: BigInt(refundAmt !== undefined ? refundAmt : 0),
                    status: refundStatus,
                    currency: (rawObj.currency || txn.currency).toUpperCase(),
                }];
            }

            let anyNewPosting = false;
            let lastRefundId = null;
            let lastRefundState = meta.refund_status || txn.state;

            const totalCapturedMinor = toCanonicalMinorUnits(txn.amount, txn.currency);
            let cumulativeRefundedMinor = BigInt(meta.cumulative_refunded_minor || 0);

            // Fail-closed Currency mismatch validation for refunds
            for (const item of refundItems) {
                if (item.currency && txn.currency && item.currency !== txn.currency.toUpperCase()) {
                    logger.error(`[WEBHOOK] ❌ Currency mismatch in refund for ${txn.instruction_id}: instruction expects ${txn.currency}, refund reported ${item.currency}`);
                    await client.query(
                        "UPDATE instructions SET state = 'MANUAL_CHECK', error_message = $1, updated_at = NOW() WHERE instruction_id = $2",
                        [`Currency mismatch in refund: expected ${txn.currency}, received ${item.currency}`, txn.instruction_id]
                    );
                    await client.query('COMMIT');
                    return {
                        status: 200,
                        body: { received: true, mismatch: true, reason: 'CURRENCY_MISMATCH', instruction_id: txn.instruction_id },
                    };
                }
            }

            // Check if authoritative payment_refunds table exists
            let hasRefundsTable = false;
            try {
                const regCheck = await client.query("SELECT to_regclass('public.payment_refunds') AS tbl");
                hasRefundsTable = Boolean(regCheck.rows[0]?.tbl);
            } catch (_) {
                hasRefundsTable = false;
            }

            for (const item of refundItems) {
                lastRefundId = item.id;

                // Positive amount validation for non-failed refunds
                if (item.status !== 'failed' && item.status !== 'canceled' && item.amount_minor <= 0n) {
                    logger.error(`[WEBHOOK] ❌ Invalid non-positive refund amount for ${txn.instruction_id}: ${item.amount_minor}`);
                    await client.query(
                        "UPDATE instructions SET state = 'MANUAL_CHECK', error_message = $1, updated_at = NOW() WHERE instruction_id = $2",
                        [`Invalid refund amount: minor units must be positive`, txn.instruction_id]
                    );
                    await client.query('COMMIT');
                    return {
                        status: 200,
                        body: { received: true, mismatch: true, reason: 'INVALID_REFUND_AMOUNT', instruction_id: txn.instruction_id },
                    };
                }

                const existingIdx = meta.refunds.findIndex((r) => r.refund_id === item.id);
                const existingRecord = existingIdx >= 0 ? meta.refunds[existingIdx] : null;

                let existingDbRecord = null;
                if (hasRefundsTable) {
                    const dbCheck = await client.query(
                        'SELECT * FROM payment_refunds WHERE provider = $1 AND provider_refund_id = $2 FOR UPDATE',
                        [provider, item.id]
                    );
                    existingDbRecord = dbCheck.rows[0] || null;
                }

                const isAlreadySucceeded = (existingDbRecord && existingDbRecord.status === 'SUCCEEDED') ||
                                           (existingRecord && existingRecord.status === 'SUCCEEDED');

                if (isAlreadySucceeded && (item.status === 'pending' || item.status === 'failed' || item.status === 'canceled')) {
                    logger.warn(`[WEBHOOK] ⚠️ Stale ${item.status} event ignored for already SUCCEEDED refund ${item.id}. Status regression prevented.`);
                    continue;
                }

                if (item.status === 'failed' || item.status === 'canceled') {
                    if (hasRefundsTable) {
                        await client.query(`
                            INSERT INTO payment_refunds (
                                provider, provider_refund_id, instruction_id, external_intent_id,
                                amount_minor, currency, status, event_id, updated_at
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                            ON CONFLICT (provider, provider_refund_id) DO UPDATE SET
                                status = CASE 
                                    WHEN payment_refunds.status = 'SUCCEEDED' THEN payment_refunds.status 
                                    ELSE EXCLUDED.status 
                                END,
                                event_id = EXCLUDED.event_id,
                                updated_at = NOW()
                        `, [
                            provider, item.id, txn.instruction_id, txn.external_intent_id,
                            item.amount_minor, (item.currency || txn.currency).toUpperCase(),
                            item.status.toUpperCase(), eventId
                        ]);
                    }
                    if (existingRecord) {
                        existingRecord.status = item.status.toUpperCase();
                        existingRecord.updated_at = new Date().toISOString();
                    } else {
                        meta.refunds.push({
                            refund_id: item.id,
                            amount_minor: Number(item.amount_minor),
                            amount_decimal: fromCanonicalMinorUnits(item.amount_minor, txn.currency),
                            currency: txn.currency,
                            status: item.status.toUpperCase(),
                            created_at: new Date().toISOString(),
                            event_id: eventId,
                            ledger_posted: false,
                        });
                    }
                    continue;
                }

                if (item.status === 'pending') {
                    if (hasRefundsTable) {
                        await client.query(`
                            INSERT INTO payment_refunds (
                                provider, provider_refund_id, instruction_id, external_intent_id,
                                amount_minor, currency, status, event_id, updated_at
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                            ON CONFLICT (provider, provider_refund_id) DO UPDATE SET
                                status = CASE 
                                    WHEN payment_refunds.status IN ('SUCCEEDED', 'FAILED') THEN payment_refunds.status 
                                    ELSE EXCLUDED.status 
                                END,
                                event_id = EXCLUDED.event_id,
                                updated_at = NOW()
                        `, [
                            provider, item.id, txn.instruction_id, txn.external_intent_id,
                            item.amount_minor, (item.currency || txn.currency).toUpperCase(),
                            'PENDING', eventId
                        ]);
                    }
                    if (existingRecord) {
                        existingRecord.status = 'PENDING';
                        existingRecord.updated_at = new Date().toISOString();
                    } else {
                        meta.refunds.push({
                            refund_id: item.id,
                            amount_minor: Number(item.amount_minor),
                            amount_decimal: fromCanonicalMinorUnits(item.amount_minor, txn.currency),
                            currency: txn.currency,
                            status: 'PENDING',
                            created_at: new Date().toISOString(),
                            event_id: eventId,
                            ledger_posted: false,
                        });
                    }
                    continue;
                }

                if (item.status === 'succeeded') {
                    const isAlreadyPosted = (existingDbRecord && existingDbRecord.status === 'SUCCEEDED' && existingDbRecord.ledger_entry_id) ||
                                            (existingRecord && existingRecord.ledger_posted);

                    if (isAlreadyPosted) {
                        // Already posted to ledger! Idempotent replay detected for this refund.
                        logger.info(`[WEBHOOK] Refund ${item.id} already posted to ledger. Skipping duplicate ledger posting.`);
                        continue;
                    }

                    // Check over-refund limit against DB or meta
                    let effectiveCumulative = cumulativeRefundedMinor;
                    if (hasRefundsTable) {
                        const sumRes = await client.query(`
                            SELECT COALESCE(SUM(amount_minor), 0) AS total
                            FROM payment_refunds
                            WHERE instruction_id = $1 AND status = 'SUCCEEDED' AND provider_refund_id != $2
                        `, [txn.instruction_id, item.id]);
                        effectiveCumulative = BigInt(sumRes.rows[0].total);
                    }

                    if (effectiveCumulative + item.amount_minor > totalCapturedMinor) {
                        logger.error(`[WEBHOOK] ❌ Over-refund attempt on ${txn.instruction_id}: ${effectiveCumulative + item.amount_minor} exceeds captured ${totalCapturedMinor}`);
                        await client.query(
                            "UPDATE instructions SET state = 'MANUAL_CHECK', error_message = $1, updated_at = NOW() WHERE instruction_id = $2",
                            [`Over-refund attempt: refund amount exceeds remaining captured balance`, txn.instruction_id]
                        );
                        await client.query('COMMIT');
                        return {
                            status: 200,
                            body: { received: true, mismatch: true, reason: 'OVER_REFUND_ATTEMPT', instruction_id: txn.instruction_id },
                        };
                    }

                    // Post compensating double-entry ledger entries
                    const refundDecimal = fromCanonicalMinorUnits(item.amount_minor, txn.currency);
                    const ledgerResult = await writeCompensatingLedgerFn(
                        client,
                        txn.instruction_id,
                        txn.sender,
                        txn.recipient,
                        refundDecimal,
                        txn.currency,
                        item.id
                    );

                    // Verify ledger integrity
                    await verifyLedgerIntegrityFn(client, txn.instruction_id, txn.currency, txn.tax_withheld || 0);

                    // Insert/update payment_refunds
                    if (hasRefundsTable) {
                        await client.query(`
                            INSERT INTO payment_refunds (
                                provider, provider_refund_id, instruction_id, external_intent_id,
                                amount_minor, currency, status, event_id, ledger_entry_id, updated_at
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                            ON CONFLICT (provider, provider_refund_id) DO UPDATE SET
                                status = EXCLUDED.status,
                                event_id = EXCLUDED.event_id,
                                ledger_entry_id = COALESCE(payment_refunds.ledger_entry_id, EXCLUDED.ledger_entry_id),
                                updated_at = NOW()
                        `, [
                            provider, item.id, txn.instruction_id, txn.external_intent_id,
                            item.amount_minor, (item.currency || txn.currency).toUpperCase(),
                            'SUCCEEDED', eventId, ledgerResult.entryIdDebit
                        ]);
                    }

                    cumulativeRefundedMinor = effectiveCumulative + item.amount_minor;
                    anyNewPosting = true;

                    const refundRecord = {
                        refund_id: item.id,
                        amount_minor: Number(item.amount_minor),
                        amount_decimal: refundDecimal,
                        currency: txn.currency,
                        status: 'SUCCEEDED',
                        created_at: new Date().toISOString(),
                        event_id: eventId,
                        ledger_posted: true,
                        ledger_hash: ledgerResult.hash,
                    };

                    if (existingIdx >= 0) {
                        meta.refunds[existingIdx] = refundRecord;
                    } else {
                        meta.refunds.push(refundRecord);
                    }
                }
            }

            if (hasRefundsTable) {
                const finalSumRes = await client.query(`
                    SELECT COALESCE(SUM(amount_minor), 0) AS total
                    FROM payment_refunds
                    WHERE instruction_id = $1 AND status = 'SUCCEEDED'
                `, [txn.instruction_id]);
                cumulativeRefundedMinor = BigInt(finalSumRes.rows[0].total);
            }

            meta.cumulative_refunded_minor = Number(cumulativeRefundedMinor);
            let targetState;
            if (cumulativeRefundedMinor >= totalCapturedMinor) {
                targetState = 'REFUNDED';
            } else if (cumulativeRefundedMinor > 0n) {
                targetState = 'PARTIALLY_REFUNDED';
            } else {
                targetState = txn.state; // Remains SETTLED if no successful refunds have been posted
            }
            meta.refund_status = targetState;
            lastRefundState = targetState;

            // Attempt state update with fallback for material freeze trigger
            try {
                await client.query(
                    "UPDATE instructions SET state = $1, status = $1, metadata = $2, updated_at = NOW() WHERE instruction_id = $3",
                    [targetState, JSON.stringify(meta), txn.instruction_id]
                );
            } catch (stateErr) {
                if (stateErr.message.includes('terminal state SETTLED')) {
                    // In fusion_db, material freeze trigger preserves original SETTLED state; update status & metadata
                    await client.query(
                        "UPDATE instructions SET status = $1, metadata = $2, updated_at = NOW() WHERE instruction_id = $3",
                        [targetState, JSON.stringify(meta), txn.instruction_id]
                    );
                } else {
                    throw stateErr;
                }
            }

            await client.query('COMMIT');
            logger.warn(`[WEBHOOK] 🔄 Refund lifecycle updated for ${txn.instruction_id} -> ${targetState} (Cumulative: ${fromCanonicalMinorUnits(cumulativeRefundedMinor, txn.currency)} ${txn.currency})`);

            return {
                status: 200,
                body: {
                    received: true,
                    state: targetState,
                    operation: 'COMPENSATING_REFUND',
                    refund_id: lastRefundId,
                    cumulative_refunded: fromCanonicalMinorUnits(cumulativeRefundedMinor, txn.currency),
                    cumulative_refunded_minor: Number(cumulativeRefundedMinor),
                    any_posted: anyNewPosting,
                    instruction_id: txn.instruction_id,
                },
            };
        }

        const isStripePending = provider === 'STRIPE' && (
            eventType === 'payment_intent.processing' ||
            eventType === 'payment_intent.created' ||
            eventType === 'payment_intent.requires_action'
        );
        if (isStripePending) {
            if (txn.state === 'PENDING_EXECUTION' || txn.state === 'LOCKED') {
                await client.query(
                    "UPDATE instructions SET state = 'PENDING_SETTLEMENT', external_intent_id = COALESCE(external_intent_id, $1), updated_at = NOW() WHERE instruction_id = $2",
                    [intentId || null, txn.instruction_id]
                );
            }
            await client.query('COMMIT');
            return {
                status: 200,
                body: { received: true, state: txn.state === 'SETTLED' ? 'SETTLED' : 'PENDING_SETTLEMENT', pending: true, instruction_id: txn.instruction_id },
            };
        }

        if (isRazorpayReversal) {
            if (txn.state === 'SETTLED') {
                logger.warn(`[WEBHOOK] 🔄 Post-settlement reversal received for instruction ${txn.instruction_id}`);
                await client.query(
                    "UPDATE instructions SET state = 'REVERSED', updated_at = NOW() WHERE instruction_id = $1",
                    [txn.instruction_id]
                );
                await client.query('COMMIT');
                return {
                    status: 200,
                    body: { received: true, state: 'REVERSED', instruction_id: txn.instruction_id },
                };
            } else {
                logger.warn(`[WEBHOOK] Reversal event received for non-settled instruction ${txn.instruction_id} in state ${txn.state}`);
                await client.query('COMMIT');
                return {
                    status: 200,
                    body: { received: true, ignored: true, reason: `Reversal on non-settled state ${txn.state}`, instruction_id: txn.instruction_id },
                };
            }
        }

        // D. INFORMATIONAL / NON-MUTATING EVENTS
        logger.info(`[WEBHOOK] Non-mutating event recorded: ${provider} ${eventType} for ${txn.instruction_id}`);
        await client.query('COMMIT');
        return {
            status: 200,
            body: { received: true, informational: true, event_type: eventType, instruction_id: txn.instruction_id },
        };
    } catch (err) {
        // A failed database operation must NOT leave an event permanently marked as processed
        await client.query('ROLLBACK');
        logger.error(`[WEBHOOK DB ERROR] ❌ ${err.message}`);
        return {
            status: 500,
            body: { error: 'Database transaction failed during webhook processing', detail: err.message },
        };
    } finally {
        client.release();
    }
}

module.exports = {
    timingSafeEqual,
    verifyStripeSignature,
    verifyRazorpayXSignature,
    processWebhookEvent,
};

