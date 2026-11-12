'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════
 * PAYMENT DECISIONING ENGINE — core/decisioning/decisionEngine.js
 * Evaluates each Zoho invoice and decides:
 *   - Auto-approve (small/routine) → triggers SAGA immediately
 *   - Escalate (large/flagged)     → stays PENDING_APPROVAL for human
 *   - Defer (not due yet)          → scheduled for future
 * ═══════════════════════════════════════════════════════════════════
 */

const logger = require('../../logger');

// ── THRESHOLDS (configurable via env) ────────────────────────────────────────
const AUTO_APPROVE_INR = parseFloat(process.env.DECISION_AUTO_APPROVE_INR || 50000);
const AUTO_APPROVE_USD = parseFloat(process.env.DECISION_AUTO_APPROVE_USD || 600);
const DEFER_DAYS_AHEAD = parseInt(process.env.DECISION_DEFER_DAYS || 3);

/**
 * Urgency tiers based on due date proximity.
 */
function classifyUrgency(dueDateStr) {
    if (!dueDateStr) return 'STANDARD';
    const dueDate = new Date(dueDateStr);
    const today = new Date();
    const daysLeft = Math.floor((dueDate - today) / (1000 * 60 * 60 * 24));

    if (daysLeft < 0) return 'OVERDUE';
    if (daysLeft === 0) return 'URGENT';
    if (daysLeft <= 2) return 'URGENT';
    if (daysLeft <= 7) return 'STANDARD';
    return 'DEFERRED';
}

/**
 * Decides whether an invoice instruction should be auto-approved,
 * escalated for human review, or deferred.
 *
 * @param {Object} normalizedInvoice - Output from zohoAdapter.normalizeZohoInvoice()
 * @returns {Object} decision { action, urgency, reason, autoApprove }
 */
function evaluateInvoice(normalizedInvoice) {
    const { totalAmount, currency, dueDate, buyer } = normalizedInvoice;
    const urgency = classifyUrgency(dueDate);

    const flags = [];

    // ── FLAG: Overdue invoices always escalate to human ──────────────────────
    if (urgency === 'OVERDUE') {
        flags.push('OVERDUE_INVOICE');
    }

    // ── FLAG: Amount above auto-approve threshold ─────────────────────────────
    const threshold = currency === 'INR' ? AUTO_APPROVE_INR : AUTO_APPROVE_USD;
    if (totalAmount > threshold) {
        flags.push(`ABOVE_THRESHOLD_${currency}_${threshold}`);
    }

    // ── FLAG: Unknown/new counterparty ────────────────────────────────────────
    if (!buyer?.zohoId) {
        flags.push('UNKNOWN_BUYER');
    }

    // ── FLAG: Cross-border (non-INR) gets extra scrutiny ─────────────────────
    const isCrossBorder = currency !== 'INR';
    if (isCrossBorder && totalAmount > AUTO_APPROVE_USD) {
        flags.push('CROSS_BORDER_HIGH_VALUE');
    }

    // ── DECISION LOGIC ────────────────────────────────────────────────────────
    let action;
    let reason;

    const hasBlockingFlag = flags.some(
        (f) =>
            f === 'OVERDUE_INVOICE' ||
            f.startsWith('ABOVE_THRESHOLD') ||
            f === 'CROSS_BORDER_HIGH_VALUE'
    );

    if (urgency === 'DEFERRED' && !flags.includes('OVERDUE_INVOICE')) {
        // Not due for a while — schedule for later
        action = 'DEFER';
        reason = `Invoice not due for ${DEFER_DAYS_AHEAD}+ days. Deferred for scheduled processing.`;
    } else if (hasBlockingFlag) {
        // Requires a human approver (maker-checker)
        action = 'ESCALATE';
        reason = `Manual review required. Flags: ${flags.join(', ')}`;
    } else {
        // Small, routine, on-time — auto-approve
        action = 'AUTO_APPROVE';
        reason = `Routine ${currency} payment of ${totalAmount} within auto-approve threshold.`;
    }

    const decision = {
        action,
        urgency,
        reason,
        flags,
        autoApprove: action === 'AUTO_APPROVE',
        isCrossBorder,
        threshold,
        evaluatedAt: new Date().toISOString(),
    };

    logger.info(
        `[DECISION] Invoice ${normalizedInvoice.invoiceId}: ${action} (${urgency}) — ${reason}`
    );
    return decision;
}

/**
 * Enriches an instruction record with decisioning metadata.
 * Called after normalizeZohoInvoice() and before persisting.
 *
 * @param {Object} instruction - Fusion instruction object
 * @param {Object} decision    - Output of evaluateInvoice()
 * @returns {Object} Enriched instruction
 */
function applyDecisionToInstruction(instruction, decision) {
    return {
        ...instruction,
        _paymentDecision: decision.action,
        _decisionUrgency: decision.urgency,
        _decisionFlags: decision.flags,
        _decisionReason: decision.reason,
        _isCrossBorder: decision.isCrossBorder,
        // State: auto-approved go straight to INITIATED, others stay PENDING_APPROVAL
        state: decision.autoApprove ? 'INITIATED' : 'PENDING_APPROVAL',
    };
}

module.exports = {
    evaluateInvoice,
    applyDecisionToInstruction,
};
