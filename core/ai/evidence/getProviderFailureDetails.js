'use strict';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Tool 2: getProviderFailureDetails
 * 
 * Retrieves provider error diagnostics, attempts, and external intent references.
 * Classifies provider identity strictly according to four-tier evidence hierarchy.
 * Banned: claiming 64-char hex proves Stellar; exposing raw HTTP payloads or secrets.
 * 
 * @param {object} client - Database query client ({ query: Function })
 * @param {string} instructionId - Target instruction UUID
 * @returns {Promise<object>} Structured provider failure details
 */
async function getProviderFailureDetails(client, instructionId) {
    if (!client || typeof client.query !== 'function') {
        throw new Error('getProviderFailureDetails: client with query method is required');
    }

    if (!instructionId || typeof instructionId !== 'string' || !UUID_REGEX.test(instructionId.trim())) {
        return {
            success: false,
            status: 'INVALID_IDENTIFIER',
            message: 'instructionId must be a valid UUID string',
            data: null
        };
    }

    const cleanId = instructionId.trim();

    // Query instruction failure and provider fields
    const instSql = `
        SELECT 
            instruction_id,
            state,
            provider,
            external_intent_id,
            utr,
            execution_attempts,
            error_message,
            currency
        FROM instructions
        WHERE instruction_id = $1
        LIMIT 1;
    `;

    const instResult = await client.query(instSql, [cleanId]);

    if (!instResult || !instResult.rows || instResult.rows.length === 0) {
        return {
            success: false,
            status: 'NOT_FOUND',
            message: `No instruction found for ID '${cleanId}'`,
            data: null
        };
    }

    const row = instResult.rows[0];

    // Check if there is explicit persisted provider evidence in processed_webhook_events
    const webhookSql = `
        SELECT provider 
        FROM processed_webhook_events
        WHERE instruction_id = $1 
           OR ($2::text IS NOT NULL AND external_intent_id = $2::text)
        LIMIT 1;
    `;

    const webhookResult = await client.query(webhookSql, [cleanId, row.external_intent_id || null]);
    const webhookProvider = (webhookResult && webhookResult.rows && webhookResult.rows.length > 0)
        ? webhookResult.rows[0].provider
        : null;

    let providerClassification = 'NOT_RECORDED';
    let resolvedProvider = 'NOT_RECORDED';
    let providerEvidenceNote = 'No provider identity persisted or inferred';

    if (webhookProvider) {
        providerClassification = 'PERSISTED_PROVIDER_EVIDENCE';
        resolvedProvider = webhookProvider;
        providerEvidenceNote = `Provider confirmed as '${webhookProvider}' via persisted processed_webhook_events record`;
    } else if (row.external_intent_id) {
        const intentId = row.external_intent_id.trim();
        if (intentId.startsWith('pi_') || intentId.startsWith('seti_')) {
            providerClassification = 'IDENTIFIER_FORMAT_CANDIDATE';
            resolvedProvider = 'STRIPE';
            providerEvidenceNote = `Intent format '${intentId.substring(0, 4)}...' is a candidate for Stripe, but provider is not explicitly recorded`;
        } else if (intentId.startsWith('pout_') || intentId.startsWith('pay_')) {
            providerClassification = 'IDENTIFIER_FORMAT_CANDIDATE';
            resolvedProvider = 'RAZORPAYX';
            providerEvidenceNote = `Intent format '${intentId.substring(0, 5)}...' is a candidate for RazorpayX, but provider is not explicitly recorded`;
        } else if (/^[0-9a-f]{64}$/i.test(intentId)) {
            providerClassification = 'IDENTIFIER_FORMAT_CANDIDATE';
            resolvedProvider = 'GENERIC_HEX64';
            providerEvidenceNote = '64-character hexadecimal identifier alone is inconclusive and does not prove Stellar network settlement';
        } else {
            providerClassification = 'IDENTIFIER_FORMAT_CANDIDATE';
            resolvedProvider = 'UNKNOWN_FORMAT';
            providerEvidenceNote = 'Intent identifier does not match standard provider pattern heuristics';
        }
    } else if (row.provider) {
        providerClassification = 'UNVERIFIED_BROAD_CATEGORY';
        resolvedProvider = row.provider;
        providerEvidenceNote = `Broad router categorization '${row.provider}' recorded; specific execution gateway is unrecorded`;
    }

    const isFailureState = ['FAILED', 'MANUAL_CHECK'].includes(row.state);

    return {
        success: true,
        status: isFailureState ? 'FAILURE_DETAILS_AVAILABLE' : 'INSTRUCTION_NOT_FAILED',
        data: {
            instruction_id: row.instruction_id,
            state: row.state,
            provider_classification: providerClassification,
            resolved_provider: resolvedProvider,
            provider_evidence_note: providerEvidenceNote,
            raw_provider_column: row.provider || null,
            provider_mode: 'NOT_RECORDED',
            external_intent_id: row.external_intent_id || null,
            utr: row.utr || null,
            execution_attempts: parseInt(row.execution_attempts, 10) || 0,
            error_message: row.error_message || null
        }
    };
}

module.exports = {
    getProviderFailureDetails,
};

