'use strict';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Tool 3: getSagaExecutionEvidence
 * 
 * Retrieves Saga step breakdown and escrow flags for invoice workflows.
 * Generic payment instructions that lack persisted invoice linkages return INCOMPLETE_GENERIC_SAGA.
 * 
 * @param {object} client - Database query client ({ query: Function })
 * @param {string} identifier - Instruction UUID, Invoice ID, or Saga ID
 * @returns {Promise<object>} Structured Saga execution evidence
 */
async function getSagaExecutionEvidence(client, identifier) {
    if (!client || typeof client.query !== 'function') {
        throw new Error('getSagaExecutionEvidence: client with query method is required');
    }

    if (!identifier || typeof identifier !== 'string' || identifier.trim().length === 0 || identifier.trim().length > 255) {
        return {
            success: false,
            status: 'INVALID_IDENTIFIER',
            message: 'identifier must be a non-empty string under 256 characters',
            data: null
        };
    }

    const cleanId = identifier.trim();
    const isUuid = UUID_REGEX.test(cleanId);

    let resolvedInvoiceId = null;
    let invoiceRecord = null;

    if (isUuid) {
        // Query whether this instruction UUID is mapped to an invoice inside invoices.saga_config JSONB
        // Match JSON path: saga_config->'instructions' containing an element with instruction_id = cleanId
        const matchPayload = JSON.stringify([{ instruction_id: cleanId }]);
        const invoiceMapSql = `
            SELECT invoice_id, saga_id, state 
            FROM invoices 
            WHERE saga_config->'instructions' @> $1::jsonb
            LIMIT 1;
        `;

        const mapResult = await client.query(invoiceMapSql, [matchPayload]);

        if (!mapResult || !mapResult.rows || mapResult.rows.length === 0) {
            return {
                success: true,
                status: 'INCOMPLETE_GENERIC_SAGA',
                identifier: cleanId,
                message: 'Generic payment instructions do not persist intermediate Saga step history in PostgreSQL',
                steps: []
            };
        }

        resolvedInvoiceId = mapResult.rows[0].invoice_id;
        invoiceRecord = mapResult.rows[0];
    } else {
        // Identifier is not a UUID; check invoice_id or saga_id with collision protection
        const invoiceLookupSql = `
            SELECT invoice_id, saga_id, state 
            FROM invoices 
            WHERE invoice_id = $1 OR saga_id = $1 
            LIMIT 2;
        `;

        const lookupResult = await client.query(invoiceLookupSql, [cleanId]);

        if (!lookupResult || !lookupResult.rows || lookupResult.rows.length === 0) {
            return {
                success: false,
                status: 'NOT_FOUND',
                message: `No invoice or Saga record found matching identifier '${cleanId}'`,
                data: null
            };
        }

        if (lookupResult.rows.length > 1) {
            return {
                success: false,
                status: 'AMBIGUOUS_IDENTIFIER_MATCH',
                message: `Identifier '${cleanId}' collided between multiple invoice records`,
                candidates: lookupResult.rows.map(r => ({ invoice_id: r.invoice_id, saga_id: r.saga_id }))
            };
        }

        resolvedInvoiceId = lookupResult.rows[0].invoice_id;
        invoiceRecord = lookupResult.rows[0];
    }

    const stepsSql = `
        SELECT step_id, amount_pct, condition, rail, status, escrow_flagged 
        FROM invoice_saga_steps 
        WHERE invoice_id = $1 
        ORDER BY id ASC;
    `;

    const stepsResult = await client.query(stepsSql, [resolvedInvoiceId]);
    const stepRows = (stepsResult && stepsResult.rows) ? stepsResult.rows : [];

    return {
        success: true,
        status: 'SAGA_EVIDENCE_AVAILABLE',
        invoice_id: invoiceRecord.invoice_id,
        saga_id: invoiceRecord.saga_id,
        invoice_state: invoiceRecord.state,
        steps: stepRows.map(s => ({
            step_id: s.step_id,
            amount_pct: s.amount_pct ? s.amount_pct.toString() : null,
            condition: s.condition,
            rail: s.rail,
            status: s.status,
            escrow_flagged: Boolean(s.escrow_flagged),
            escrow_disclaimer: s.escrow_flagged 
                ? 'Internal pipeline conditional hold flag (GIFT IFSC PSR 2024); does not establish third-party legal escrow custody'
                : null
        }))
    };
}

module.exports = {
    getSagaExecutionEvidence,
};
