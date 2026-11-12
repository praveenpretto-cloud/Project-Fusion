'use strict';

/**
 * Tool 7: explainIsoValidationErrors
 * 
 * Extracts and categorizes persisted ISO 20022 validation errors from invoices.iso_enriched.
 * Does NOT execute live XML parsing, and does NOT claim legal or regulatory compliance.
 * 
 * @param {object} client - Database query client ({ query: Function })
 * @param {string} documentId - Invoice ID or Saga ID
 * @returns {Promise<object>} Structured ISO validation error explanation
 */
async function explainIsoValidationErrors(client, documentId) {
    if (!client || typeof client.query !== 'function') {
        throw new Error('explainIsoValidationErrors: client with query method is required');
    }

    if (!documentId || typeof documentId !== 'string' || documentId.trim().length === 0 || documentId.trim().length > 255) {
        return {
            success: false,
            status: 'INVALID_IDENTIFIER',
            message: 'documentId must be a non-empty string under 256 characters',
            data: null
        };
    }

    const cleanId = documentId.trim();

    const sql = `
        SELECT invoice_id, saga_id, iso_enriched, state 
        FROM invoices 
        WHERE invoice_id = $1 OR saga_id = $1 
        LIMIT 2;
    `;

    const result = await client.query(sql, [cleanId]);

    if (!result || !result.rows || result.rows.length === 0) {
        return {
            success: false,
            status: 'NOT_FOUND',
            message: `No invoice record found matching document ID '${cleanId}'`,
            data: null
        };
    }

    if (result.rows.length > 1) {
        return {
            success: false,
            status: 'AMBIGUOUS_IDENTIFIER_MATCH',
            message: `Document identifier '${cleanId}' collided between multiple invoice records`,
            candidates: result.rows.map(r => ({ invoice_id: r.invoice_id, saga_id: r.saga_id })),
            data: null
        };
    }

    const row = result.rows[0];

    let isoEnriched = row.iso_enriched;
    if (typeof isoEnriched === 'string') {
        try {
            isoEnriched = JSON.parse(isoEnriched);
        } catch {
            isoEnriched = {};
        }
    } else if (!isoEnriched || typeof isoEnriched !== 'object') {
        isoEnriched = {};
    }

    const validationErrors = Array.isArray(isoEnriched.validationErrors)
        ? isoEnriched.validationErrors
        : [];

    const hasErrors = validationErrors.length > 0;

    return {
        success: true,
        status: hasErrors ? 'ISO_VALIDATION_ERRORS_PERSISTED' : 'ISO_ENRICHED_NO_ERRORS',
        data: {
            document_id: cleanId,
            invoice_id: row.invoice_id,
            saga_id: row.saga_id,
            invoice_state: row.state,
            has_validation_errors: hasErrors,
            error_count: validationErrors.length,
            persisted_errors: validationErrors.map((err, idx) => ({
                index: idx + 1,
                error_message: typeof err === 'string' ? err : JSON.stringify(err),
                category: typeof err === 'string' && err.includes('structuredAddress') 
                    ? 'MANDATORY_STRUCTURED_ADDRESS_SYNTAX' 
                    : 'SCHEMA_VALIDATION_ERROR'
            })),
            disclaimer: 'Persisted schema validation errors from invoices.iso_enriched; does not represent an independent regulatory compliance or customs clearance determination.'
        }
    };
}

module.exports = {
    explainIsoValidationErrors,
};

