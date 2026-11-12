'use strict';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Tool 6: getReconciliationEvidence
 * 
 * Retrieves Zoho Books accounting synchronization records.
 * Distinguishes accounting synchronization failures from payment execution failures.
 * 
 * @param {object} client - Database query client ({ query: Function })
 * @param {string} instructionId - Target instruction UUID
 * @returns {Promise<object>} Structured reconciliation evidence
 */
async function getReconciliationEvidence(client, instructionId) {
    if (!client || typeof client.query !== 'function') {
        throw new Error('getReconciliationEvidence: client with query method is required');
    }

    if (!instructionId || typeof instructionId !== 'string' || !UUID_REGEX.test(instructionId.trim())) {
        return {
            success: false,
            status: 'INVALID_IDENTIFIER',
            message: 'instructionId must be a valid UUID string',
            reconciliation: null
        };
    }

    const cleanId = instructionId.trim();

    const sql = `
        SELECT 
            r.id,
            r.instruction_id,
            r.zoho_invoice_id,
            r.zoho_payment_id,
            r.reconciled_at,
            r.status,
            r.error_message,
            i.state AS instruction_state
        FROM reconciliation_log r
        LEFT JOIN instructions i ON i.instruction_id::text = r.instruction_id
        WHERE r.instruction_id = $1::text
        ORDER BY r.created_at DESC
        LIMIT 1;
    `;

    const result = await client.query(sql, [cleanId]);

    if (!result || !result.rows || result.rows.length === 0) {
        return {
            success: true,
            status: 'NOT_RECORDED',
            message: `No reconciliation log record found for instruction '${cleanId}'`,
            reconciliation: null
        };
    }

    const row = result.rows[0];

    let finding = null;
    if (row.status === 'FAILED' && row.instruction_state === 'SETTLED') {
        finding = 'Project Fusion records the instruction state as SETTLED. The Zoho reconciliation record reports FAILED. The available records show an accounting synchronization failure but do not independently establish external settlement finality.';
    } else if (row.status === 'RECONCILED') {
        finding = 'Zoho accounting synchronization is confirmed as RECONCILED.';
    } else if (row.status === 'PENDING') {
        finding = 'Zoho accounting synchronization is pending completion.';
    } else {
        finding = `Zoho synchronization status is '${row.status}'.`;
    }

    return {
        success: true,
        status: 'RECONCILIATION_AVAILABLE',
        reconciliation: {
            id: row.id,
            instruction_id: row.instruction_id,
            zoho_invoice_id: row.zoho_invoice_id || null,
            zoho_payment_id: row.zoho_payment_id || null,
            status: row.status,
            reconciled_at: row.reconciled_at ? new Date(row.reconciled_at).toISOString() : null,
            error_message: row.error_message || null,
            instruction_state: row.instruction_state || null,
            finding
        }
    };
}

module.exports = {
    getReconciliationEvidence,
};

