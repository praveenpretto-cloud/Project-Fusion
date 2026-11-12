'use strict';

const Joi = require('joi');

const SUPPORTED_INTENTS = [
    'FAILURE_INVESTIGATION',
    'SAGA_INVESTIGATION',
    'WEBHOOK_INVESTIGATION',
    'LEDGER_AUDIT',
    'RECONCILIATION_INVESTIGATION',
    'ISO_VALIDATION',
    'FULL_INVESTIGATION',
];

const REPORT_STATUSES = [
    'COMPLETED',
    'INCOMPLETE_EVIDENCE',
    'INVESTIGATION_FAILED',
    'SAFE_REFUSAL',
];

// Structured allowlist of permitted operational diagnostic recommendation codes (exact enumeration)
const ALLOWED_RECOMMENDATION_CODES = Object.freeze([
    'VERIFY_PROVIDER_STATUS',
    'REVIEW_RECONCILIATION_RECORD',
    'INSPECT_LEDGER_INTEGRITY',
    'CHECK_WEBHOOK_CONFIGURATION',
    'REVIEW_SAGA_EVIDENCE',
    'VERIFY_ISO_VALIDATION_RECORD',
    'REVIEW_TRANSACTION_TIMELINE',
    'CHECK_ACCOUNT_BALANCE',
    'VERIFY_BENEFICIARY_DETAILS',
    'INSPECT_DATABASE_STATUS',
    'REQUEST_COUNTERPARTY_INFORMATION',
    'MANUAL_OPERATIONAL_REVIEW',
]);

// Deterministic display description mapping for approved recommendation codes
const RECOMMENDATION_DESCRIPTIONS = Object.freeze({
    VERIFY_PROVIDER_STATUS:
        'Inspect provider gateway portal and status endpoint for execution error details.',
    REVIEW_RECONCILIATION_RECORD:
        'Review reconciliation log and match internal ledger against external books.',
    INSPECT_LEDGER_INTEGRITY:
        'Audit journal hash chain, entry balance, and predecessor continuity.',
    CHECK_WEBHOOK_CONFIGURATION:
        'Verify webhook signature verification, endpoint delivery, and event recording.',
    REVIEW_SAGA_EVIDENCE:
        'Inspect saga state machine history, step transitions, and compensation records.',
    VERIFY_ISO_VALIDATION_RECORD:
        'Examine ISO 20022 message schema validation and structured address syntax.',
    REVIEW_TRANSACTION_TIMELINE:
        'Inspect instruction state transitions, timestamps, and error messages.',
    CHECK_ACCOUNT_BALANCE: 'Check internal ledger balances and business account liquidity.',
    VERIFY_BENEFICIARY_DETAILS: 'Verify counterparty banking details and IFSC/routing format.',
    INSPECT_DATABASE_STATUS: 'Check database connectivity, replication lag, and persistence state.',
    REQUEST_COUNTERPARTY_INFORMATION:
        'Request updated payment information or invoice documentation from counterparty.',
    MANUAL_OPERATIONAL_REVIEW:
        'Escalate to human operations specialist for compliance and risk determination.',
});

// Backward compatibility alias
const ALLOWED_OPERATIONAL_CHECKS = ALLOWED_RECOMMENDATION_CODES;

// Mutation verbs and target nouns for comprehensive rejection of financial mutation commands
const MUTATION_VERBS = [
    'execute',
    'process',
    'retry',
    're-?initiate',
    'initiate',
    'trigger',
    'submit',
    'reverse',
    'release',
    'disburse',
    'refund',
    'transfer',
    'pay',
    'resend',
    'send',
    'settle',
    'mark',
    'override',
];

const MUTATION_TARGETS = [
    'payout',
    'payment',
    'refund',
    'disbursement',
    'transfer',
    'escrow',
    'settlement',
    'funds',
    'cash',
    'money',
    'transaction',
];

// Prohibited financial mutation trigger phrases in recommendations
const FORBIDDEN_MUTATION_PATTERNS = [
    new RegExp(
        `\\b(${MUTATION_VERBS.join('|')})\\s+(?:(?:the|this|that|an?|again|new|immediate(?:ly)?)\\s+)*(?:${MUTATION_TARGETS.join('|')}|(?:as\\s+)?settled|policy)\\b`,
        'i'
    ),
    /\bexecute\s+payout\b/i,
    /\bprocess\s+refund\b/i,
    /\bretry\s+payment\b/i,
    /\btransfer\s+funds\b/i,
    /\brelease\s+escrow\b/i,
    /\bmark\s+(as\s+)?settled\b/i,
    /\btrigger\s+settlement\b/i,
    /\binitiate\s+transfer\b/i,
    /\boverride\s+policy\b/i,
    /\bsubmit\s+(?:the\s+)?payout(?:\s+again)?\b/i,
    /\bre-?initiate\s+(?:the\s+)?payment\b/i,
    /\breverse\s+(?:the\s+)?transfer\b/i,
    /\bretry\s+(?:the\s+)?disbursement\b/i,
];

const confirmedFindingSchema = Joi.object({
    claim: Joi.string().trim().min(5).max(1000).required(),
    evidence_references: Joi.array().items(Joi.string().trim().min(1)).min(1).required(),
    source_field: Joi.string().trim().min(2).max(255).required(),
});

const hypothesisSchema = Joi.object({
    hypothesis: Joi.string().trim().min(5).max(1000).required(),
    supporting_evidence: Joi.array().items(Joi.string().trim()).default([]),
    missing_evidence: Joi.array().items(Joi.string().trim()).default([]),
});

const recommendedCheckSchema = Joi.string()
    .trim()
    .valid(...ALLOWED_RECOMMENDATION_CODES)
    .required()
    .custom((value, helpers) => {
        for (const pattern of FORBIDDEN_MUTATION_PATTERNS) {
            if (pattern.test(value)) {
                return helpers.error('any.forbidden_mutation', { pattern: pattern.toString() });
            }
        }
        return value;
    }, 'Mutation trigger prohibition')
    .messages({
        'any.only':
            'Recommended check "{#value}" is not an allowed operational recommendation code. Must be one of: ' +
            ALLOWED_RECOMMENDATION_CODES.join(', '),
    });

const investigationReportSchema = Joi.object({
    investigation_id: Joi.string().trim().min(5).max(100).required(),
    transaction_id: Joi.string().trim().min(1).max(100).required(),
    intent: Joi.string()
        .valid(...SUPPORTED_INTENTS)
        .required(),
    status: Joi.string()
        .valid(...REPORT_STATUSES)
        .required(),
    summary: Joi.string().trim().min(10).max(2000).required(),
    confirmed_findings: Joi.array().items(confirmedFindingSchema).default([]),
    hypotheses: Joi.array().items(hypothesisSchema).default([]),
    missing_information: Joi.array().items(Joi.string().trim()).default([]),
    recommended_checks: Joi.array().items(recommendedCheckSchema).unique().default([]).messages({
        'array.unique': 'Duplicate recommendation codes are not permitted in recommended_checks.',
    }),
    recommended_checks_display: Joi.array()
        .items(
            Joi.object({
                code: Joi.string().required(),
                description: Joi.string().required(),
            })
        )
        .optional(),
    refusal_code: Joi.string().trim().max(100).optional(),
    refusal_reason: Joi.string().trim().max(1000).optional(),
    security_audit: Joi.object().optional(),
    evidence_references: Joi.array().items(Joi.string().trim()).default([]),
    limitations: Joi.array().items(Joi.string().trim()).default([]),
    model_metadata: Joi.object({
        provider: Joi.string().trim().required(),
        model: Joi.string().trim().required(),
        latency_ms: Joi.number().integer().min(0).optional(),
        tokens: Joi.object({
            prompt: Joi.number().integer().min(0).optional(),
            completion: Joi.number().integer().min(0).optional(),
        }).optional(),
    }).required(),
}).messages({
    'any.forbidden_mutation':
        'Recommended check contains prohibited financial mutation action: {#pattern}',
});

/**
 * Validates a candidate report against the strict investigation report schema.
 *
 * @param {object} report
 * @returns {{ valid: boolean, value?: object, errors?: string[] }}
 */
function validateInvestigationReport(report) {
    if (!report || typeof report !== 'object') {
        return { valid: false, errors: ['Report must be a non-null object'] };
    }

    const { error, value } = investigationReportSchema.validate(report, {
        abortEarly: false,
        stripUnknown: false, // Disallow unsupported fields
    });

    if (error) {
        return {
            valid: false,
            errors: error.details.map((d) => d.message),
        };
    }

    return { valid: true, value, errors: [] };
}

function formatRecommendationDisplay(code) {
    return RECOMMENDATION_DESCRIPTIONS[code] || null;
}

module.exports = {
    investigationReportSchema,
    validateInvestigationReport,
    SUPPORTED_INTENTS,
    REPORT_STATUSES,
    ALLOWED_RECOMMENDATION_CODES,
    ALLOWED_OPERATIONAL_CHECKS,
    RECOMMENDATION_DESCRIPTIONS,
    formatRecommendationDisplay,
    FORBIDDEN_MUTATION_PATTERNS,
};
