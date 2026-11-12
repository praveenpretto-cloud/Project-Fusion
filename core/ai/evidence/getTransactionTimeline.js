'use strict';

const { toCanonicalDecimal } = require('../../orchestrator/financialDecimal');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Tool 1: getTransactionTimeline
 *
 * Retrieves chronological lifecycle timestamps and state transitions for a transaction.
 * Only returns persisted schema fields; does not invent unrecorded intermediate timestamps.
 *
 * @param {object} client - Database query client ({ query: Function })
 * @param {string} instructionId - Target instruction UUID
 * @returns {Promise<object>} Structured timeline response
 */
async function getTransactionTimeline(client, instructionId) {
    if (!client || typeof client.query !== 'function') {
        throw new Error('getTransactionTimeline: client with query method is required');
    }

    if (
        !instructionId ||
        typeof instructionId !== 'string' ||
        !UUID_REGEX.test(instructionId.trim())
    ) {
        return {
            success: false,
            status: 'INVALID_IDENTIFIER',
            message: 'instructionId must be a valid UUID string',
            timeline: null,
        };
    }

    const cleanId = instructionId.trim();

    const sql = `
        SELECT 
            i.instruction_id,
            i.state,
            i.amount,
            i.currency,
            i.created_at,
            i.updated_at,
            r.status AS reconciliation_status,
            r.reconciled_at
        FROM instructions i
        LEFT JOIN reconciliation_log r ON r.instruction_id = i.instruction_id::text
        WHERE i.instruction_id = $1
        LIMIT 1;
    `;

    const result = await client.query(sql, [cleanId]);

    if (!result || !result.rows || result.rows.length === 0) {
        return {
            success: false,
            status: 'NOT_FOUND',
            message: `No instruction found for ID '${cleanId}'`,
            timeline: null,
        };
    }

    const row = result.rows[0];

    return {
        success: true,
        status: 'TIMELINE_AVAILABLE',
        timeline: {
            instruction_id: row.instruction_id,
            current_state: row.state,
            amount: toCanonicalDecimal(row.amount, row.currency),
            currency: row.currency,
            created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
            updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
            reconciliation: {
                status: row.reconciliation_status || 'NOT_RECORDED',
                reconciled_at: row.reconciled_at ? new Date(row.reconciled_at).toISOString() : null,
            },
        },
    };
}

module.exports = {
    getTransactionTimeline,
};
