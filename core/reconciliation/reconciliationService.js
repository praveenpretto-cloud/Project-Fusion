'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════
 * RECONCILIATION SERVICE — core/reconciliation/reconciliationService.js
 * After Fusion settles an instruction, this:
 *   1. Marks the Zoho invoice as PAID via Zoho API
 *   2. Logs the reconciliation result in reconciliation_log table
 *   3. Can run a bulk daily reconciliation sweep
 * ═══════════════════════════════════════════════════════════════════
 */

const logger = require('../../logger');

/**
 * Reconciles a single settled instruction back to Zoho Books.
 * Called automatically after SETTLED state in sagaCore.
 *
 * @param {Object} pool          - pg Pool
 * @param {Object} instruction   - Settled instruction row from DB
 * @param {string} settlementRef - External intent/UTR reference
 */
async function reconcileToZoho(pool, instruction, settlementRef) {
    const zohoInvoiceId = instruction.zoho_invoice_id;

    // Only reconcile instructions that originated from Zoho
    if (!zohoInvoiceId) {
        logger.info(`[RECONCILE] Instruction ${instruction.instruction_id} has no Zoho invoice ID — skipping Zoho reconciliation`);
        return { skipped: true, reason: 'no_zoho_invoice_id' };
    }

    logger.info(`[RECONCILE] Reconciling instruction ${instruction.instruction_id} → Zoho Invoice ${zohoInvoiceId}`);

    try {
        const { markInvoicePaid } = require('../../adapters/zohoAdapter');

        const payment = await markInvoicePaid(zohoInvoiceId, {
            amount:    parseFloat(instruction.net_amount || instruction.amount),
            date:      new Date().toISOString().split('T')[0],
            reference: settlementRef || instruction.external_intent_id || instruction.instruction_id,
            mode:      instruction.currency === 'INR' ? 'bank_transfer' : 'bank_transfer',
        });

        // Log success
        await pool.query(
            `INSERT INTO reconciliation_log
             (instruction_id, zoho_invoice_id, zoho_payment_id, reconciled_at, status)
             VALUES ($1, $2, $3, NOW(), 'RECONCILED')
             ON CONFLICT DO NOTHING`,
            [
                instruction.instruction_id,
                zohoInvoiceId,
                payment?.payment_id || null,
            ]
        );

        // Update local invoice state to SETTLED
        await pool.query(
            `UPDATE invoices SET state = 'SETTLED', updated_at = NOW() WHERE invoice_id = $1 OR invoice_id = $2`,
            [zohoInvoiceId, `ZOHO-${zohoInvoiceId}`]
        );

        logger.info(`[RECONCILE] ✅ Zoho invoice ${zohoInvoiceId} marked as PAID. Zoho Payment ID: ${payment?.payment_id}`);
        return { success: true, zohoPaymentId: payment?.payment_id };

    } catch (err) {
        logger.error(`[RECONCILE] ❌ Failed to reconcile ${zohoInvoiceId}: ${err.message}`);

        // Log failure for retry
        try {
            await pool.query(
                `INSERT INTO reconciliation_log
                 (instruction_id, zoho_invoice_id, reconciled_at, status, error_message)
                 VALUES ($1, $2, NOW(), 'FAILED', $3)
                 ON CONFLICT DO NOTHING`,
                [instruction.instruction_id, zohoInvoiceId, err.message]
            );
        } catch (dbErr) {
            logger.error(`[RECONCILE] DB log failed: ${dbErr.message}`);
        }

        return { success: false, error: err.message };
    }
}

/**
 * Daily reconciliation sweep.
 * Finds all SETTLED instructions with no reconciliation record and retries them.
 *
 * @param {Object} pool - pg Pool
 */
async function runDailyReconciliationSweep(pool) {
    logger.info('[RECONCILE] Starting daily reconciliation sweep...');

    const result = await pool.query(`
        SELECT i.*
        FROM instructions i
        LEFT JOIN reconciliation_log r ON r.instruction_id = i.instruction_id::text
        WHERE i.state = 'SETTLED'
          AND i.zoho_invoice_id IS NOT NULL
          AND r.recon_id IS NULL
        ORDER BY i.updated_at DESC
        LIMIT 100
    `);

    const unreconciled = result.rows;
    logger.info(`[RECONCILE] Found ${unreconciled.length} unreconciled instruction(s)`);

    let successCount = 0;
    let failCount    = 0;

    for (const instruction of unreconciled) {
        const result = await reconcileToZoho(pool, instruction, instruction.external_intent_id);
        if (result.success) successCount++;
        else if (!result.skipped) failCount++;
    }

    logger.info(`[RECONCILE] Sweep complete — ✅ ${successCount} reconciled, ❌ ${failCount} failed`);
    return { successCount, failCount, total: unreconciled.length };
}

/**
 * Gets reconciliation status for a specific instruction.
 */
async function getReconciliationStatus(pool, instructionId) {
    const result = await pool.query(
        `SELECT * FROM reconciliation_log WHERE instruction_id = $1 ORDER BY reconciled_at DESC LIMIT 1`,
        [instructionId]
    );
    return result.rows[0] || null;
}

module.exports = {
    reconcileToZoho,
    runDailyReconciliationSweep,
    getReconciliationStatus,
};
