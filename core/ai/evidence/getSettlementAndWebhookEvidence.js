'use strict';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Tool 4: getSettlementAndWebhookEvidence
 *
 * Retrieves verified inbound webhook events from processed_webhook_events.
 * Prohibits inferring unrecorded duplicate delivery counts or assuming Stellar RPC without proof.
 *
 * @param {object} client - Database query client ({ query: Function })
 * @param {object} params - Search parameters
 * @param {string} [params.instructionId] - Instruction UUID
 * @param {string} [params.externalIntentId] - External intent ID
 * @returns {Promise<object>} Structured webhook settlement evidence
 */
async function getSettlementAndWebhookEvidence(client, params = {}) {
    if (!client || typeof client.query !== 'function') {
        throw new Error('getSettlementAndWebhookEvidence: client with query method is required');
    }

    const { instructionId, externalIntentId } = params;

    const hasInstructionId =
        instructionId && typeof instructionId === 'string' && UUID_REGEX.test(instructionId.trim());
    const hasIntentId =
        externalIntentId &&
        typeof externalIntentId === 'string' &&
        externalIntentId.trim().length > 0;

    if (!hasInstructionId && !hasIntentId) {
        return {
            success: false,
            status: 'INVALID_PARAMETERS',
            message:
                'At least one valid parameter (instructionId UUID or externalIntentId string) is required',
            events: [],
        };
    }

    const cleanInstId = hasInstructionId ? instructionId.trim() : null;
    const cleanIntentId = hasIntentId ? externalIntentId.trim() : null;

    // Check instruction context if instructionId was provided
    let instructionRow = null;
    if (cleanInstId) {
        const instSql = `
            SELECT instruction_id, provider, external_intent_id, currency, state 
            FROM instructions 
            WHERE instruction_id = $1 
            LIMIT 1;
        `;
        const instResult = await client.query(instSql, [cleanInstId]);
        if (instResult && instResult.rows && instResult.rows.length > 0) {
            instructionRow = instResult.rows[0];
        }
    }

    // Effective search parameters
    const targetInstId = cleanInstId || (instructionRow ? instructionRow.instruction_id : null);
    const targetIntentId =
        cleanIntentId || (instructionRow ? instructionRow.external_intent_id : null);

    const webhookSql = `
        SELECT 
            event_id,
            provider,
            event_type,
            instruction_id,
            external_intent_id,
            payload_hash,
            processed_at
        FROM processed_webhook_events
        WHERE ($1::text IS NOT NULL AND instruction_id = $1::text)
           OR ($2::text IS NOT NULL AND external_intent_id = $2::text)
        ORDER BY processed_at ASC;
    `;

    const webhookResult = await client.query(webhookSql, [targetInstId, targetIntentId]);
    const eventRows = webhookResult && webhookResult.rows ? webhookResult.rows : [];

    if (eventRows.length > 0) {
        return {
            success: true,
            status: 'WEBHOOK_RECORDED',
            events_count: eventRows.length,
            events: eventRows.map((e) => ({
                event_id: e.event_id,
                provider: e.provider,
                event_type: e.event_type,
                instruction_id: e.instruction_id,
                external_intent_id: e.external_intent_id,
                payload_hash: e.payload_hash,
                processed_at: e.processed_at ? new Date(e.processed_at).toISOString() : null,
            })),
            delivery_tracking_note:
                'Duplicate delivery count is not persisted by PostgreSQL (ON CONFLICT DO NOTHING drop policy)',
        };
    }

    // No webhook rows found. Check whether transaction is definitively verified as Stellar RPC
    // AI-0.3.1 RULE: Do NOT return NO_WEBHOOKS_STELLAR_RPC merely because currency is XLM and provider is CRYPTO.
    // Provider identity must be verified by explicit persisted evidence.
    return {
        success: true,
        status: 'WEBHOOK_NOT_RECORDED',
        events_count: 0,
        events: [],
        provider_identity:
            instructionRow && instructionRow.provider
                ? 'UNVERIFIED_BROAD_CATEGORY'
                : 'NOT_RECORDED',
        delivery_tracking_note:
            'No webhook event matching the references is recorded in processed_webhook_events',
    };
}

module.exports = {
    getSettlementAndWebhookEvidence,
};
