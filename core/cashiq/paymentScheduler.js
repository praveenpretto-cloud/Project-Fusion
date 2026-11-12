'use strict';

const logger = require('../../logger');
const { defaultCanonicalApprovalService } = require('../approvals/canonicalApprovalService');

/**
 * Sweeps the scheduled_payments table and processes due payments under ADR-002 governance.
 * Payments requiring approval are paused in PENDING_APPROVAL and submitted for Four-Eyes review.
 * Only payments explicitly authorized for automatic execution under a versioned policy are dispatched.
 *
 * @param {object} pool - PostgreSQL pool
 * @param {object} [canonicalApprovalService] - Optional injected approval service for testing
 */
async function runScheduledPaymentsSweep(
    pool,
    canonicalApprovalService = defaultCanonicalApprovalService
) {
    logger.info('[SCHEDULER] Starting scheduled payments sweep...');
    try {
        // Ensure scheduled_payments table exists
        await pool.query(`
            CREATE TABLE IF NOT EXISTS scheduled_payments (
                schedule_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                business_id     UUID NOT NULL,
                label           VARCHAR(255),
                amount          DECIMAL(20,2) NOT NULL,
                currency        VARCHAR(10) NOT NULL DEFAULT 'INR',
                recipient_name  VARCHAR(255) NOT NULL,
                purpose         VARCHAR(100) NOT NULL DEFAULT 'VENDOR_PAYMENT',
                scheduled_date  DATE NOT NULL,
                recurrence      VARCHAR(20) DEFAULT 'ONCE',
                status          VARCHAR(20) DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','PROCESSING','DONE','CANCELLED','FAILED')),
                note            TEXT,
                created_at      TIMESTAMP DEFAULT NOW()
            )
        `);

        const nowStr = new Date().toISOString().split('T')[0];
        const duePayments = await pool.query(
            `SELECT * FROM scheduled_payments 
             WHERE scheduled_date <= $1 AND status = 'SCHEDULED'`,
            [nowStr]
        );

        if (duePayments.rows.length === 0) {
            logger.info('[SCHEDULER] No pending scheduled payments found.');
            return;
        }

        logger.info(`[SCHEDULER] Found ${duePayments.rows.length} scheduled payments to process.`);

        for (const payment of duePayments.rows) {
            const { schedule_id, business_id, amount, currency, recipient_name, purpose } = payment;
            logger.info(
                `[SCHEDULER] Evaluating payment ${schedule_id} of ${amount} ${currency} to ${recipient_name}`
            );

            // Determine sender
            const sender =
                business_id === 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
                    ? 'Bob_Supply'
                    : 'Alice_Corp';

            // Generate UUID for instruction
            const crypto = require('crypto');
            const instructionId = crypto.randomUUID();

            const client = await pool.connect();
            try {
                // Evaluate policy before dispatching or initiating
                const policyResult = await canonicalApprovalService.evaluateApprovalPolicy(
                    {
                        instruction_id: instructionId,
                        amount,
                        currency,
                        sender,
                        recipient: recipient_name,
                        purpose,
                        auto_policy_rule:
                            payment.note && payment.note.includes('AUTO_POLICY')
                                ? payment.note
                                : null,
                    },
                    { pool }
                );

                if (policyResult.autoExecute === true) {
                    // Pre-authorized routine payment under explicit policy
                    logger.info(
                        `[SCHEDULER] ⚡ Payment ${schedule_id} eligible for auto-execution under policy: ${policyResult.reason}`
                    );
                    await client.query('BEGIN');
                    await client.query(
                        `INSERT INTO instructions 
                         (instruction_id, amount, currency, sender, recipient, purpose, state, approval_status, provider, created_at, updated_at, net_amount, tax_withheld)
                         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_APPROVAL', 'PENDING_APPROVAL', 'FUSION_MASTER', NOW(), NOW(), $2, 0.00)`,
                        [
                            instructionId,
                            parseFloat(amount),
                            currency,
                            sender,
                            recipient_name,
                            purpose,
                        ]
                    );
                    await client.query('COMMIT');

                    await canonicalApprovalService.executeAutomaticApproval({
                        instructionId,
                        policyName: policyResult.policyVersion || 'AUTO_RECURRING_POLICY',
                        pool,
                    });

                    await pool.query(
                        `UPDATE scheduled_payments SET status = 'DONE', note = $1 WHERE schedule_id = $2`,
                        [`Auto-executed under policy: ${policyResult.policyVersion}`, schedule_id]
                    );

                    if (payment.recurrence && payment.recurrence !== 'ONCE') {
                        await scheduleNextOccurrence(pool, payment);
                    }
                } else {
                    // Strict ADR-002 Governance: Mandatory Four-Eyes human approval
                    logger.info(
                        `[SCHEDULER] 🛡️ Payment ${schedule_id} requires Four-Eyes approval. Creating PENDING_APPROVAL instruction.`
                    );
                    await client.query('BEGIN');
                    await client.query(
                        `INSERT INTO instructions 
                         (instruction_id, amount, currency, sender, recipient, purpose, state, approval_status, provider, created_at, updated_at, net_amount, tax_withheld)
                         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_APPROVAL', 'PENDING_APPROVAL', 'FUSION_MASTER', NOW(), NOW(), $2, 0.00)`,
                        [
                            instructionId,
                            parseFloat(amount),
                            currency,
                            sender,
                            recipient_name,
                            purpose,
                        ]
                    );
                    await client.query('COMMIT');

                    // Request dual-authorization via canonical approval service
                    await canonicalApprovalService.requestPaymentApproval({
                        instructionId,
                        makerOperatorId: '00000000-0000-4000-8000-000000000002', // dev-ops / scheduler initiator
                        amount: parseFloat(amount),
                        currency,
                        notes: `Scheduled payment: ${payment.label || purpose} to ${recipient_name}`,
                        recipient: recipient_name,
                        pool,
                    });

                    await pool.query(
                        `UPDATE scheduled_payments SET status = 'PROCESSING', note = $1 WHERE schedule_id = $2`,
                        [
                            `Instruction ${instructionId} submitted for Four-Eyes approval (${policyResult.reason})`,
                            schedule_id,
                        ]
                    );
                }
            } catch (err) {
                logger.error(
                    `[SCHEDULER] Failed to process payment ${schedule_id}: ${err.message}`
                );
                await pool.query(
                    `UPDATE scheduled_payments SET status = 'FAILED', note = $1 WHERE schedule_id = $2`,
                    [`Execution failed: ${err.message}`, schedule_id]
                );
            } finally {
                client.release();
            }
        }
    } catch (err) {
        logger.error(`[SCHEDULER] Error in runScheduledPaymentsSweep: ${err.message}`);
    }
}

/**
 * Schedule the next occurrence of a recurring payment.
 */
async function scheduleNextOccurrence(pool, payment) {
    const current = new Date(payment.scheduled_date);
    let nextDate = new Date(current);

    if (payment.recurrence === 'DAILY') {
        nextDate.setDate(current.getDate() + 1);
    } else if (payment.recurrence === 'WEEKLY') {
        nextDate.setDate(current.getDate() + 7);
    } else if (payment.recurrence === 'MONTHLY') {
        nextDate.setMonth(current.getMonth() + 1);
    } else {
        return; // ONCE or invalid
    }

    const nextDateStr = nextDate.toISOString().split('T')[0];
    logger.info(
        `[SCHEDULER] Scheduling next occurrence of payment ${payment.schedule_id} for ${nextDateStr}`
    );

    await pool.query(
        `INSERT INTO scheduled_payments 
         (business_id, label, amount, currency, recipient_name, purpose, scheduled_date, recurrence, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
            payment.business_id,
            payment.label,
            payment.amount,
            payment.currency,
            payment.recipient_name,
            payment.purpose,
            nextDateStr,
            payment.recurrence,
            payment.note,
        ]
    );
}

module.exports = { runScheduledPaymentsSweep };
