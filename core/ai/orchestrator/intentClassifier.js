'use strict';

/**
 * Deterministic Intent Classifier
 * 
 * Maps user queries or operational parameters to an approved, bounded investigation intent.
 * The backend—not the LLM—determines which evidence tools are executed.
 * Routing investigation is excluded because routing_ledger is empty at runtime.
 */

const INTENT_TOOL_MAPPING = Object.freeze({
    FAILURE_INVESTIGATION: [
        'getTransactionTimeline',
        'getProviderFailureDetails',
        'getSettlementAndWebhookEvidence'
    ],
    SAGA_INVESTIGATION: [
        'getTransactionTimeline',
        'getSagaExecutionEvidence'
    ],
    WEBHOOK_INVESTIGATION: [
        'getSettlementAndWebhookEvidence',
        'getProviderFailureDetails'
    ],
    LEDGER_AUDIT: [
        'verifyLedgerIntegrity',
        'getTransactionTimeline'
    ],
    RECONCILIATION_INVESTIGATION: [
        'getReconciliationEvidence',
        'getTransactionTimeline'
    ],
    ISO_VALIDATION: [
        'explainIsoValidationErrors'
    ],
    FULL_INVESTIGATION: [
        'getTransactionTimeline',
        'getProviderFailureDetails',
        'getSagaExecutionEvidence',
        'getSettlementAndWebhookEvidence',
        'verifyLedgerIntegrity',
        'getReconciliationEvidence',
        'explainIsoValidationErrors'
    ]
});

const KEYWORD_INTENT_RULES = [
    {
        intent: 'ISO_VALIDATION',
        regex: /\b(iso|iso20022|pacs\.008|syntax|structured\s*address|xml\s*validation)\b/i
    },
    {
        intent: 'RECONCILIATION_INVESTIGATION',
        regex: /\b(zoho|reconcil|accounting\s*sync|books|firc|ebrc)\b/i
    },
    {
        intent: 'LEDGER_AUDIT',
        regex: /\b(ledger|hash|chain|predecessor|double[- ]entry|debit|credit|sequence_id|integrity)\b/i
    },
    {
        intent: 'WEBHOOK_INVESTIGATION',
        regex: /\b(webhook|event_id|delivery|payload_hash|drop|replay)\b/i
    },
    {
        intent: 'SAGA_INVESTIGATION',
        regex: /\b(saga|step|invoice_saga|escrow_flagged|milestone|advance_30)\b/i
    },
    {
        intent: 'FAILURE_INVESTIGATION',
        regex: /\b(fail|failed|rejection|error|manual_check|declined|insufficient\s*funds)\b/i
    }
];

class IntentClassifier {
    /**
     * Classifies an investigation question or explicit intent string into a verified intent and tool plan.
     * 
     * @param {object} params
     * @param {string} [params.explicitIntent] - Explicitly provided intent code
     * @param {string} [params.question] - Free-form operator question
     * @param {string} [params.targetIdentifier] - Target ID (UUID, invoice, or saga ID)
     * @returns {{ intent: string, tools: string[], isClarificationRequired: boolean, reason: string }}
     */
    static classify({ explicitIntent, question = '', targetIdentifier = '' }) {
        // 1. Explicit valid intent override
        if (explicitIntent) {
            const canonicalIntent = String(explicitIntent).toUpperCase();
            if (Object.prototype.hasOwnProperty.call(INTENT_TOOL_MAPPING, canonicalIntent)) {
                return {
                    intent: canonicalIntent,
                    tools: [...INTENT_TOOL_MAPPING[canonicalIntent]],
                    isClarificationRequired: false,
                    reason: `Explicit verified intent '${canonicalIntent}' provided.`
                };
            }
            return {
                intent: null,
                tools: [],
                isClarificationRequired: true,
                reason: `Unsupported explicit intent '${explicitIntent}'. Must be one of: ${Object.keys(INTENT_TOOL_MAPPING).join(', ')}`
            };
        }

        const cleanQuestion = String(question || '').trim();

        // 2. Reject routing queries (routing_ledger is empty at runtime; routing mutation not permitted)
        if (/\b(routing|route|routing_rules|routing_ledger|fx_rate|exchange\s*rate)\b/i.test(cleanQuestion)) {
            return {
                intent: null,
                tools: [],
                isClarificationRequired: true,
                reason: 'Routing investigation is not supported because routing_ledger is not populated at runtime.'
            };
        }

        // 3. Target identifier heuristics (if question is minimal)
        if (!cleanQuestion && targetIdentifier) {
            const idUpper = targetIdentifier.toUpperCase();
            if (idUpper.startsWith('INV-') || idUpper.startsWith('SAGA-')) {
                return {
                    intent: 'ISO_VALIDATION',
                    tools: [...INTENT_TOOL_MAPPING.ISO_VALIDATION],
                    isClarificationRequired: false,
                    reason: 'Identifier prefix matches commercial invoice/saga document.'
                };
            }
            return {
                intent: 'FULL_INVESTIGATION',
                tools: [...INTENT_TOOL_MAPPING.FULL_INVESTIGATION],
                isClarificationRequired: false,
                reason: 'Target transaction ID provided without specific sub-domain question; default to full investigation.'
            };
        }

        if (!cleanQuestion) {
            return {
                intent: 'FULL_INVESTIGATION',
                tools: [...INTENT_TOOL_MAPPING.FULL_INVESTIGATION],
                isClarificationRequired: false,
                reason: 'Empty question provided; defaulting to bounded full investigation.'
            };
        }

        // 4. Payment domain relevance check
        const PAYMENT_DOMAIN_REGEX = /\b(transaction|payment|payout|transfer|invoice|saga|webhook|ledger|error|fail|decline|stripe|razorpay|stellar|zoho|reconcil|settle|account|balance|audit|iso|pacs|firc|ebrc|double[- ]entry)\b/i;
        if (!PAYMENT_DOMAIN_REGEX.test(cleanQuestion)) {
            return {
                intent: null,
                tools: [],
                isClarificationRequired: true,
                reason: 'Question does not match supported payment operations investigation domains.'
            };
        }

        // 5. Match against deterministic keyword rules
        const matchedIntents = [];
        for (const rule of KEYWORD_INTENT_RULES) {
            if (rule.regex.test(cleanQuestion)) {
                matchedIntents.push(rule.intent);
            }
        }

        if (matchedIntents.length === 1) {
            const singleIntent = matchedIntents[0];
            return {
                intent: singleIntent,
                tools: [...INTENT_TOOL_MAPPING[singleIntent]],
                isClarificationRequired: false,
                reason: `Question matched deterministic keywords for '${singleIntent}'.`
            };
        }

        if (matchedIntents.length > 1) {
            // Prioritize reconciliation over general ledger audit if reconciliation is explicitly named
            if (matchedIntents.includes('RECONCILIATION_INVESTIGATION') && /\b(zoho|reconcil)\b/i.test(cleanQuestion)) {
                return {
                    intent: 'RECONCILIATION_INVESTIGATION',
                    tools: [...INTENT_TOOL_MAPPING.RECONCILIATION_INVESTIGATION],
                    isClarificationRequired: false,
                    reason: "Question specifically requests reconciliation investigation."
                };
            }

            // Multi-faceted inquiry: map safely to FULL_INVESTIGATION
            return {
                intent: 'FULL_INVESTIGATION',
                tools: [...INTENT_TOOL_MAPPING.FULL_INVESTIGATION],
                isClarificationRequired: false,
                reason: `Question touches multiple operational domains (${matchedIntents.join(', ')}); mapped to FULL_INVESTIGATION.`
            };
        }

        // Safe fallback for recognized payment domain questions without specific sub-domain trigger
        return {
            intent: 'FULL_INVESTIGATION',
            tools: [...INTENT_TOOL_MAPPING.FULL_INVESTIGATION],
            isClarificationRequired: false,
            reason: 'Question recognized in payment domain; defaulting to full operational investigation.'
        };
    }
}

module.exports = {
    IntentClassifier,
    INTENT_TOOL_MAPPING,
};
