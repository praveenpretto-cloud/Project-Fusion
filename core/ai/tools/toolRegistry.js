'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * CONTROLLED TOOL REGISTRY — PHASE AI-3.1
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Strict Bounded Operational Tool Registry for Agentic Investigation.
 *
 * SECURITY & GOVERNANCE INVARIANTS:
 * 1. STRICT READ-ONLY: All tools are diagnostic and strictly read-only.
 * 2. ZERO PERSISTENT DATABASE / SQL: No SQL execution is permitted.
 * 3. ZERO FINANCIAL MUTATION: No payment, transfer, refund, or settlement tools exist.
 * 4. SYNTHETIC BOUNDARY: Case data is strictly bound by the backend context.
 *    The model CANNOT choose another case or submit arbitrary external IDs.
 * 5. BOUNDED OUTPUT: Tool results are bounded in size to prevent prompt-stuffing.
 */

const MAX_TOOL_RESULT_BYTES = 16384; // 16KB maximum observation size
const TOOL_EXECUTION_TIMEOUT_MS = 5000; // 5s timeout per tool
const COMMON_ID_KEYS = new Set([
    'transaction_id',
    'transaction_identifier',
    'transactionId',
    'case_id',
    'caseId',
]);
const { telemetry, SPAN_NAMES, FUSION_AI_ATTRIBUTES, classifyError } = require('../observability');

/**
 * Standardized tool error outcome
 */
function createToolError(code, message, details = null) {
    return {
        success: false,
        status: code,
        error: code,
        message,
        details,
    };
}

/**
 * Helper to check if model accidentally passed candidate report as tool args
 */
function checkAccidentalReportSubmission(args) {
    if (
        args &&
        typeof args === 'object' &&
        (args.confirmed_findings || args.summary || (args.status && args.status === 'COMPLETED'))
    ) {
        return 'Tool is for querying observations only. DO NOT submit your final report as tool arguments. When ready to conclude, output your JSON report directly in your assistant response without invoking tools.';
    }
    return null;
}

/**
 * Bounded string truncation helper
 */
function enforceResultSizeLimit(data) {
    if (data === null || data === undefined) return data;
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    if (Buffer.byteLength(str, 'utf8') > MAX_TOOL_RESULT_BYTES) {
        return {
            truncated: true,
            originalByteSize: Buffer.byteLength(str, 'utf8'),
            data: JSON.parse(str.slice(0, MAX_TOOL_RESULT_BYTES - 128) + '"}'),
            warning: 'Tool result was truncated to stay within maximum 16KB observation limit.',
        };
    }
    return data;
}

const TOOL_DEFINITIONS = [
    {
        name: 'get_case_overview',
        canonicalEvidenceKey: 'caseOverview',
        description:
            'Retrieves high-level metadata about the current investigation target, including case title, intent category, transaction identifier, question, and list of available evidence modules in the synthetic fixture. NOTE: This is a read-only query tool; do NOT invoke this tool to submit your final report.',
        classification: 'READ_ONLY',
        parameters: {
            type: 'object',
            properties: {
                transaction_id: {
                    type: 'string',
                    description: 'Optional transaction identifier.',
                },
            },
            required: [],
            additionalProperties: false,
        },
        validateArgs: (args) => {
            const accidentalErr = checkAccidentalReportSubmission(args);
            if (accidentalErr) return { valid: false, error: accidentalErr };
            if (!args || typeof args !== 'object') return { valid: true, value: {} };
            for (const k of Object.keys(args)) {
                if (!COMMON_ID_KEYS.has(k)) {
                    return {
                        valid: false,
                        error: `Unexpected arguments provided to get_case_overview: '${k}'. Tool takes no functional arguments.`,
                    };
                }
            }
            return { valid: true, value: {} };
        },
        execute: async (syntheticCase) => {
            return {
                success: true,
                status: 'OVERVIEW_AVAILABLE',
                data: {
                    case_id: syntheticCase.id,
                    title: syntheticCase.title,
                    intent: syntheticCase.intent,
                    transaction_id: syntheticCase.transactionId,
                    question: syntheticCase.question,
                    available_evidence_modules: Object.keys(syntheticCase.evidence || {}),
                },
            };
        },
    },
    {
        name: 'get_transaction_timeline',
        canonicalEvidenceKey: 'getTransactionTimeline',
        description:
            'Queries the chronological lifecycle state transitions for the payment instruction (e.g. SUBMITTED, EXECUTING, SETTLED, FAILED, MANUAL_CHECK). Use this initial diagnostic step to observe whether the transaction succeeded, failed, or requires manual review.',
        classification: 'READ_ONLY',
        parameters: {
            type: 'object',
            properties: {
                transaction_id: {
                    type: 'string',
                    description: 'Target transaction identifier.',
                },
                format: {
                    type: 'string',
                    enum: ['summary', 'detailed'],
                    description: 'Optional format level of the timeline. Defaults to summary.',
                },
            },
            required: [],
            additionalProperties: false,
        },
        validateArgs: (args) => {
            const accidentalErr = checkAccidentalReportSubmission(args);
            if (accidentalErr) return { valid: false, error: accidentalErr };
            if (!args || typeof args !== 'object') return { valid: true, value: {} };
            const keys = Object.keys(args);
            for (const k of keys) {
                if (k !== 'format' && !COMMON_ID_KEYS.has(k)) {
                    return {
                        valid: false,
                        error: `Unexpected property '${k}'. Only 'format' or 'transaction_id' is permitted.`,
                    };
                }
            }
            if (args.format && !['summary', 'detailed'].includes(args.format)) {
                return {
                    valid: false,
                    error: `Invalid format '${args.format}'. Must be 'summary' or 'detailed'.`,
                };
            }
            return { valid: true, value: args };
        },
        execute: async (syntheticCase) => {
            const ev = syntheticCase.evidence && syntheticCase.evidence.getTransactionTimeline;
            if (!ev) {
                return createToolError(
                    'EVIDENCE_NOT_AVAILABLE',
                    `No transaction timeline evidence recorded for transaction ${syntheticCase.transactionId}.`
                );
            }
            return {
                success: true,
                status: ev.status || 'TIMELINE_AVAILABLE',
                data: ev.timeline || ev.data || ev,
            };
        },
    },
    {
        name: 'get_provider_failure_details',
        canonicalEvidenceKey: 'getProviderFailureDetails',
        description:
            'Queries external payment gateway decline codes, gateway decline classifications, execution attempt counts, and provider error messages (e.g. from Razorpay, Stripe, or Stellar). Use this when the timeline reveals a FAILED or MANUAL_CHECK state or gateway error to determine the root cause.',
        classification: 'READ_ONLY',
        parameters: {
            type: 'object',
            properties: {
                transaction_id: {
                    type: 'string',
                    description: 'Target transaction identifier.',
                },
                includeRawMessage: {
                    type: 'boolean',
                    description: 'Whether to include raw error strings. Defaults to true.',
                },
            },
            required: [],
            additionalProperties: false,
        },
        validateArgs: (args) => {
            const accidentalErr = checkAccidentalReportSubmission(args);
            if (accidentalErr) return { valid: false, error: accidentalErr };
            if (!args || typeof args !== 'object') return { valid: true, value: {} };

            // Normalize aliases
            if (args.include_raw_message !== undefined && args.includeRawMessage === undefined) {
                args.includeRawMessage = args.include_raw_message;
            }
            if (typeof args.includeRawMessage === 'string') {
                const lower = args.includeRawMessage.trim().toLowerCase();
                if (lower === 'true' || lower === '1') args.includeRawMessage = true;
                else if (lower === 'false' || lower === '0') args.includeRawMessage = false;
            }

            const keys = Object.keys(args);
            for (const k of keys) {
                if (
                    k !== 'includeRawMessage' &&
                    k !== 'include_raw_message' &&
                    !COMMON_ID_KEYS.has(k)
                ) {
                    return {
                        valid: false,
                        error: `Unexpected property '${k}'. Only 'includeRawMessage' or 'transaction_id' is permitted.`,
                    };
                }
            }
            if (
                args.includeRawMessage !== undefined &&
                typeof args.includeRawMessage !== 'boolean'
            ) {
                return { valid: false, error: 'Property includeRawMessage must be a boolean.' };
            }
            return { valid: true, value: args };
        },
        execute: async (syntheticCase) => {
            const ev = syntheticCase.evidence && syntheticCase.evidence.getProviderFailureDetails;
            if (!ev) {
                return createToolError(
                    'EVIDENCE_NOT_AVAILABLE',
                    `No provider failure details recorded for transaction ${syntheticCase.transactionId}.`
                );
            }
            return {
                success: true,
                status: ev.status || 'FAILURE_DETAILS_AVAILABLE',
                data: ev.data || ev,
            };
        },
    },
    {
        name: 'get_saga_execution_evidence',
        canonicalEvidenceKey: 'getSagaExecutionEvidence',
        description:
            'Inspects distributed saga state machine execution history, step compensation logs, and milestone breakdown for multi-step payment flows (e.g. invoice escrow, advance release). Use this when investigating saga step errors or milestone states.',
        classification: 'READ_ONLY',
        parameters: {
            type: 'object',
            properties: {
                transaction_id: {
                    type: 'string',
                    description: 'Target transaction identifier.',
                },
                stepName: {
                    type: 'string',
                    description: 'Optional specific saga step to inspect.',
                },
            },
            required: [],
            additionalProperties: false,
        },
        validateArgs: (args) => {
            const accidentalErr = checkAccidentalReportSubmission(args);
            if (accidentalErr) return { valid: false, error: accidentalErr };
            if (!args || typeof args !== 'object') return { valid: true, value: {} };

            // Normalize aliases
            if (args.step_name !== undefined && args.stepName === undefined) {
                args.stepName = args.step_name;
            }

            const keys = Object.keys(args);
            for (const k of keys) {
                if (k !== 'stepName' && k !== 'step_name' && !COMMON_ID_KEYS.has(k)) {
                    return {
                        valid: false,
                        error: `Unexpected property '${k}'. Only 'stepName' or 'transaction_id' is permitted.`,
                    };
                }
            }
            if (args.stepName !== undefined && typeof args.stepName !== 'string') {
                return { valid: false, error: 'Property stepName must be a string.' };
            }
            return { valid: true, value: args };
        },
        execute: async (syntheticCase) => {
            const ev = syntheticCase.evidence && syntheticCase.evidence.getSagaExecutionEvidence;
            if (!ev) {
                return createToolError(
                    'EVIDENCE_NOT_AVAILABLE',
                    `No saga execution evidence recorded for transaction ${syntheticCase.transactionId}.`
                );
            }
            return {
                success: true,
                status: ev.status || 'SAGA_EVIDENCE_AVAILABLE',
                data: ev.data || ev,
            };
        },
    },
    {
        name: 'get_webhook_delivery_evidence',
        canonicalEvidenceKey: 'getSettlementAndWebhookEvidence',
        description:
            'Examines asynchronous provider webhook events, delivery timestamps, signature verification records, and duplicate delivery events. Use this when investigating webhook event drops or signature rejections.',
        classification: 'READ_ONLY',
        parameters: {
            type: 'object',
            properties: {
                transaction_id: {
                    type: 'string',
                    description: 'Target transaction identifier.',
                },
                filterProvider: {
                    type: 'string',
                    enum: ['STRIPE', 'RAZORPAYX', 'STELLAR', 'ALL'],
                    description: 'Filter events by gateway provider.',
                },
            },
            required: [],
            additionalProperties: false,
        },
        validateArgs: (args) => {
            const accidentalErr = checkAccidentalReportSubmission(args);
            if (accidentalErr) return { valid: false, error: accidentalErr };
            if (!args || typeof args !== 'object') return { valid: true, value: {} };

            // Normalize aliases
            if (args.provider !== undefined && args.filterProvider === undefined) {
                args.filterProvider = args.provider;
            }
            if (args.filter_provider !== undefined && args.filterProvider === undefined) {
                args.filterProvider = args.filter_provider;
            }
            if (typeof args.filterProvider === 'string') {
                args.filterProvider = args.filterProvider.trim().toUpperCase();
            }

            const keys = Object.keys(args);
            for (const k of keys) {
                if (
                    k !== 'filterProvider' &&
                    k !== 'provider' &&
                    k !== 'filter_provider' &&
                    !COMMON_ID_KEYS.has(k)
                ) {
                    return {
                        valid: false,
                        error: `Unexpected property '${k}'. Only 'filterProvider' or 'transaction_id' is permitted.`,
                    };
                }
            }
            if (
                args.filterProvider &&
                !['STRIPE', 'RAZORPAYX', 'STELLAR', 'ALL'].includes(args.filterProvider)
            ) {
                return {
                    valid: false,
                    error: `Invalid filterProvider '${args.filterProvider}'. Must be one of: STRIPE, RAZORPAYX, STELLAR, ALL.`,
                };
            }
            return { valid: true, value: args };
        },
        execute: async (syntheticCase) => {
            const ev =
                syntheticCase.evidence && syntheticCase.evidence.getSettlementAndWebhookEvidence;
            if (!ev) {
                return createToolError(
                    'EVIDENCE_NOT_AVAILABLE',
                    `No webhook delivery evidence recorded for transaction ${syntheticCase.transactionId}.`
                );
            }
            return {
                success: true,
                status: ev.status || 'WEBHOOK_EVIDENCE_AVAILABLE',
                data: ev.data || ev,
            };
        },
    },
    {
        name: 'get_ledger_integrity_evidence',
        canonicalEvidenceKey: 'verifyLedgerIntegrity',
        description:
            'Audits double-entry journal balance equilibrium (debits = credits), SHA-256 hash chaining continuity, and sequence identifier progression. Use this when investigating ledger balance anomalies or hash mismatch errors.',
        classification: 'READ_ONLY',
        parameters: {
            type: 'object',
            properties: {
                transaction_id: {
                    type: 'string',
                    description: 'Target transaction identifier.',
                },
                verifyChaining: {
                    type: 'boolean',
                    description: 'Verify sequential SHA-256 hash chaining.',
                },
            },
            required: [],
            additionalProperties: false,
        },
        validateArgs: (args) => {
            const accidentalErr = checkAccidentalReportSubmission(args);
            if (accidentalErr) return { valid: false, error: accidentalErr };
            if (!args || typeof args !== 'object') return { valid: true, value: {} };

            // Normalize aliases
            if (args.verify_chaining !== undefined && args.verifyChaining === undefined) {
                args.verifyChaining = args.verify_chaining;
            }
            if (typeof args.verifyChaining === 'string') {
                const lower = args.verifyChaining.trim().toLowerCase();
                if (lower === 'true' || lower === '1') args.verifyChaining = true;
                else if (lower === 'false' || lower === '0') args.verifyChaining = false;
            }

            const keys = Object.keys(args);
            for (const k of keys) {
                if (k !== 'verifyChaining' && k !== 'verify_chaining' && !COMMON_ID_KEYS.has(k)) {
                    return {
                        valid: false,
                        error: `Unexpected property '${k}'. Only 'verifyChaining' or 'transaction_id' is permitted.`,
                    };
                }
            }
            if (args.verifyChaining !== undefined && typeof args.verifyChaining !== 'boolean') {
                return { valid: false, error: 'Property verifyChaining must be a boolean.' };
            }
            return { valid: true, value: args };
        },
        execute: async (syntheticCase) => {
            const ev = syntheticCase.evidence && syntheticCase.evidence.verifyLedgerIntegrity;
            if (!ev) {
                return createToolError(
                    'EVIDENCE_NOT_AVAILABLE',
                    `No ledger integrity evidence recorded for transaction ${syntheticCase.transactionId}.`
                );
            }
            return {
                success: true,
                status: ev.status || 'LEDGER_AUDIT_AVAILABLE',
                data: ev.data || ev,
            };
        },
    },
    {
        name: 'get_reconciliation_evidence',
        canonicalEvidenceKey: 'getReconciliationEvidence',
        description:
            'Inspects accounting reconciliation status against external enterprise systems (e.g. Zoho Books sync, FIRC/e-BRC issuance, settlement variance). Use this when investigating accounting sync discrepancies.',
        classification: 'READ_ONLY',
        parameters: {
            type: 'object',
            properties: {
                transaction_id: {
                    type: 'string',
                    description: 'Target transaction identifier.',
                },
                system: {
                    type: 'string',
                    enum: ['ZOHO', 'INTERNAL'],
                    description: 'Target accounting system.',
                },
            },
            required: [],
            additionalProperties: false,
        },
        validateArgs: (args) => {
            const accidentalErr = checkAccidentalReportSubmission(args);
            if (accidentalErr) return { valid: false, error: accidentalErr };
            if (!args || typeof args !== 'object') return { valid: true, value: {} };

            if (typeof args.system === 'string') {
                args.system = args.system.trim().toUpperCase();
            }

            const keys = Object.keys(args);
            for (const k of keys) {
                if (k !== 'system' && !COMMON_ID_KEYS.has(k)) {
                    return {
                        valid: false,
                        error: `Unexpected property '${k}'. Only 'system' or 'transaction_id' is permitted.`,
                    };
                }
            }
            if (args.system && !['ZOHO', 'INTERNAL'].includes(args.system)) {
                return {
                    valid: false,
                    error: `Invalid system '${args.system}'. Must be 'ZOHO' or 'INTERNAL'.`,
                };
            }
            return { valid: true, value: args };
        },
        execute: async (syntheticCase) => {
            const ev = syntheticCase.evidence && syntheticCase.evidence.getReconciliationEvidence;
            if (!ev) {
                return createToolError(
                    'EVIDENCE_NOT_AVAILABLE',
                    `No reconciliation evidence recorded for transaction ${syntheticCase.transactionId}.`
                );
            }
            return {
                success: true,
                status: ev.status || 'RECONCILIATION_AVAILABLE',
                data: ev.data || ev,
            };
        },
    },
    {
        name: 'explain_iso_validation_errors',
        canonicalEvidenceKey: 'explainIsoValidationErrors',
        description:
            'Analyzes pacs.008 ISO 20022 XML parsing errors, structured debtor/creditor postal address violations, and schema compliance faults. Use this when investigating ISO messaging failures.',
        classification: 'READ_ONLY',
        parameters: {
            type: 'object',
            properties: {
                transaction_id: {
                    type: 'string',
                    description: 'Target transaction identifier.',
                },
                messageType: {
                    type: 'string',
                    enum: ['pacs.008', 'camt.053'],
                    description: 'ISO 20022 message schema format.',
                },
            },
            required: [],
            additionalProperties: false,
        },
        validateArgs: (args) => {
            const accidentalErr = checkAccidentalReportSubmission(args);
            if (accidentalErr) return { valid: false, error: accidentalErr };
            if (!args || typeof args !== 'object') return { valid: true, value: {} };

            // Normalize aliases
            if (args.message_type !== undefined && args.messageType === undefined) {
                args.messageType = args.message_type;
            }
            if (typeof args.messageType === 'string') {
                args.messageType = args.messageType.trim().toLowerCase();
            }

            const keys = Object.keys(args);
            for (const k of keys) {
                if (k !== 'messageType' && k !== 'message_type' && !COMMON_ID_KEYS.has(k)) {
                    return {
                        valid: false,
                        error: `Unexpected property '${k}'. Only 'messageType' or 'transaction_id' is permitted.`,
                    };
                }
            }
            if (args.messageType && !['pacs.008', 'camt.053'].includes(args.messageType)) {
                return {
                    valid: false,
                    error: `Invalid messageType '${args.messageType}'. Must be 'pacs.008' or 'camt.053'.`,
                };
            }
            return { valid: true, value: args };
        },
        execute: async (syntheticCase) => {
            const ev = syntheticCase.evidence && syntheticCase.evidence.explainIsoValidationErrors;
            if (!ev) {
                return createToolError(
                    'EVIDENCE_NOT_AVAILABLE',
                    `No ISO 20022 validation evidence recorded for transaction ${syntheticCase.transactionId}.`
                );
            }
            return {
                success: true,
                status: ev.status || 'ISO_VALIDATION_AVAILABLE',
                data: ev.data || ev,
            };
        },
    },
];

const RAG_TOOL_DEFINITION = {
    name: 'search_payment_knowledge',
    canonicalEvidenceKey: 'searchPaymentKnowledge',
    description:
        'Searches authoritative payment rail and standards documentation (Stripe, Razorpay, Stellar, ISO 20022, Project Fusion). Use this tool to look up technical error codes, failure semantics, webhook idempotency, or schema specifications when investigating transaction anomalies.',
    classification: 'READ_ONLY',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Technical search query or error description.',
            },
            provider: {
                type: 'string',
                enum: ['STRIPE', 'RAZORPAY', 'STELLAR', 'ISO20022', 'PROJECT_FUSION', 'ALL'],
                description: 'Target payment rail or technical domain.',
            },
            error_code: {
                type: 'string',
                description:
                    'Exact technical error code to prioritize (e.g. balance_insufficient, tx_bad_seq, streetName).',
            },
            product: {
                type: 'string',
                description: 'Optional subproduct (e.g. payment_intents, payouts, pacs.008).',
            },
            max_results: {
                type: 'integer',
                description: 'Maximum number of documentation chunks to retrieve (1-5, default 3).',
            },
        },
        required: ['query'],
        additionalProperties: false,
    },
    validateArgs: (rawArgs) => {
        let args = rawArgs;
        if (typeof args === 'string') {
            try {
                args = JSON.parse(args);
            } catch {
                return {
                    valid: false,
                    error: 'Malformed JSON arguments for search_payment_knowledge.',
                };
            }
        }
        const accidentalErr = checkAccidentalReportSubmission(args);
        if (accidentalErr) return { valid: false, error: accidentalErr };
        if (!args || typeof args !== 'object') {
            return {
                valid: false,
                error: 'Arguments must be an object with a string query property.',
            };
        }
        if (!args.query || typeof args.query !== 'string' || args.query.trim().length === 0) {
            return {
                valid: false,
                error: "Property 'query' is required and must be a non-empty string.",
            };
        }
        if (args.query.length > 300) {
            return {
                valid: false,
                error: "Property 'query' exceeds maximum length of 300 characters.",
            };
        }
        if (
            args.provider &&
            !['STRIPE', 'RAZORPAY', 'STELLAR', 'ISO20022', 'PROJECT_FUSION', 'ALL'].includes(
                String(args.provider).toUpperCase().trim()
            )
        ) {
            return {
                valid: false,
                error: `Invalid provider '${args.provider}'. Must be one of: STRIPE, RAZORPAY, STELLAR, ISO20022, PROJECT_FUSION, ALL`,
            };
        }
        if (args.max_results !== undefined) {
            const max = Number(args.max_results);
            if (!Number.isInteger(max) || max < 1 || max > 5) {
                return {
                    valid: false,
                    error: 'Property max_results must be an integer between 1 and 5.',
                };
            }
        }
        return {
            valid: true,
            value: {
                query: args.query.trim(),
                provider: args.provider ? String(args.provider).toUpperCase().trim() : undefined,
                error_code: args.error_code ? String(args.error_code).trim() : undefined,
                product: args.product ? String(args.product).trim() : undefined,
                max_results: args.max_results ? Number(args.max_results) : 3,
            },
        };
    },
    execute: async (syntheticCase, args, options = {}) => {
        const { getOrCreateIndexer } = require('../rag/ingestion/knowledgeIndexer');
        const indexerOptions = {};
        if (options && options.embeddingProvider) {
            indexerOptions.embeddingProvider = options.embeddingProvider;
        }
        const indexer = await getOrCreateIndexer(indexerOptions);
        const results = await indexer.search(args.query, {
            provider: args.provider,
            error_code: args.error_code,
            topK: args.max_results || 3,
        });

        if (!results || results.length === 0) {
            return {
                success: true,
                status: 'NO_DOCUMENTATION_FOUND',
                data: {
                    query: args.query,
                    retrieved_chunks: [],
                    count: 0,
                    note: 'No documentation chunks matched the specified query criteria.',
                },
            };
        }

        const formattedChunks = results.map((r) => ({
            chunk_id: r.chunk.chunk_id,
            source_id: r.chunk.source_id,
            provider: r.chunk.provider,
            title: r.chunk.title,
            section: r.chunk.section,
            content: r.chunk.content,
            source_url: r.chunk.source_url,
            document_version: r.chunk.document_version,
            relevance_score: r.score,
            match_type: r.match_type,
        }));

        return {
            success: true,
            status: 'DOCUMENTATION_RETRIEVED',
            data: {
                query: args.query,
                retrieved_chunks: formattedChunks,
                count: formattedChunks.length,
            },
        };
    },
};

class ToolRegistry {
    constructor(options = {}) {
        this.options = options;
        this.embeddingProvider = options.embeddingProvider || null;
        this._tools = new Map();
        for (const def of TOOL_DEFINITIONS) {
            this._tools.set(def.name, Object.freeze(def));
        }
        if (options.enableRAG) {
            this.registerTool(RAG_TOOL_DEFINITION);
        }
    }

    /**
     * Registers an additional approved tool definition.
     * @param {object} def
     */
    registerTool(def) {
        if (!def || !def.name) throw new Error('Invalid tool definition');
        this._tools.set(def.name, Object.freeze(def));
    }

    /**
     * Enables the RAG search_payment_knowledge tool.
     */
    registerRAGTool() {
        this.registerTool(RAG_TOOL_DEFINITION);
    }

    /**
     * Retrieves tool definition by name.
     * @param {string} name
     * @returns {object|null}
     */
    getTool(name) {
        if (!name || typeof name !== 'string') return null;
        return this._tools.get(name.trim()) || null;
    }

    /**
     * Checks if tool exists.
     * @param {string} name
     * @returns {boolean}
     */
    hasTool(name) {
        if (!name || typeof name !== 'string') return false;
        return this._tools.has(name.trim());
    }

    /**
     * Returns list of all registered tool names.
     * @returns {string[]}
     */
    getToolNames() {
        return Array.from(this._tools.keys());
    }

    /**
     * Formats all tools into standard Ollama/OpenAI tool calling schemas.
     * @returns {Array<object>}
     */
    getOllamaToolDefinitions() {
        return Array.from(this._tools.values()).map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            },
        }));
    }

    /**
     * Safely executes an approved tool against a synthetic case.
     *
     * @param {string} name - Registered tool name
     * @param {object} rawArgs - Raw arguments object emitted by the model
     * @param {object} syntheticCase - Authoritative synthetic case fixture
     * @returns {Promise<{ success: boolean, status: string, data: any, evidenceKey: string, toolName: string }>}
     */
    async executeTool(name, rawArgs, syntheticCase) {
        return telemetry.withSpan(SPAN_NAMES.TOOL_EXECUTION, async (span) => {
            span.setAttribute(FUSION_AI_ATTRIBUTES.TOOL_NAME, name);
            const tool = this.getTool(name);
            if (!tool) {
                span.setAttribute(FUSION_AI_ATTRIBUTES.TOOL_STATUS, 'UNKNOWN_TOOL');
                span.setAttribute(FUSION_AI_ATTRIBUTES.TOOL_FAILURE_TYPE, 'UNKNOWN_TOOL');
                telemetry.recordToolExecution(name, 0, {
                    success: false,
                    failureType: 'UNKNOWN_TOOL',
                });
                return createToolError(
                    'UNKNOWN_TOOL',
                    `Tool '${name}' is not registered in the approved tool registry.`,
                    { requestedTool: name, approvedTools: this.getToolNames() }
                );
            }

            if (!syntheticCase || typeof syntheticCase !== 'object' || !syntheticCase.id) {
                span.setAttribute(FUSION_AI_ATTRIBUTES.TOOL_STATUS, 'INVALID_CONTEXT');
                span.setAttribute(FUSION_AI_ATTRIBUTES.TOOL_FAILURE_TYPE, 'INVALID_CONTEXT');
                telemetry.recordToolExecution(name, 0, {
                    success: false,
                    failureType: 'INVALID_CONTEXT',
                });
                return createToolError(
                    'INVALID_CONTEXT',
                    'Synthetic case context is missing or invalid. Tools require a bound synthetic case.'
                );
            }

            // Validate arguments (fail-closed security boundary: tools must provide validateArgs)
            if (typeof tool.validateArgs !== 'function') {
                span.setAttribute(FUSION_AI_ATTRIBUTES.TOOL_STATUS, 'MISSING_VALIDATOR');
                span.setAttribute(FUSION_AI_ATTRIBUTES.TOOL_FAILURE_TYPE, 'MISSING_VALIDATOR');
                telemetry.recordToolExecution(name, 0, {
                    success: false,
                    failureType: 'MISSING_VALIDATOR',
                });
                return createToolError(
                    'MISSING_VALIDATOR',
                    `Tool '${name}' has no validateArgs function. Tools must define explicit schema validation.`
                );
            }

            const validation = tool.validateArgs(rawArgs || {});
            if (!validation || !validation.valid) {
                span.setAttribute(FUSION_AI_ATTRIBUTES.TOOL_STATUS, 'INVALID_ARGUMENTS');
                span.setAttribute(FUSION_AI_ATTRIBUTES.TOOL_FAILURE_TYPE, 'INVALID_ARGUMENTS');
                telemetry.recordToolExecution(name, 0, {
                    success: false,
                    failureType: 'INVALID_ARGUMENTS',
                });
                return createToolError(
                    'INVALID_ARGUMENTS',
                    `Invalid arguments for tool '${name}': ${validation ? validation.error : 'Validation failed'}`
                );
            }

            const startTime = Date.now();
            let timer = null;
            try {
                const timeoutPromise = new Promise((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    `Tool execution timed out after ${TOOL_EXECUTION_TIMEOUT_MS}ms`
                                )
                            ),
                        TOOL_EXECUTION_TIMEOUT_MS
                    );
                });

                const executionPromise = tool.execute(syntheticCase, validation.value, {
                    embeddingProvider: this.embeddingProvider,
                });
                const result = await Promise.race([executionPromise, timeoutPromise]);
                if (timer) clearTimeout(timer);

                const boundedData = enforceResultSizeLimit(
                    result.data !== undefined ? result.data : result
                );
                const resultBytes = Buffer.byteLength(JSON.stringify(boundedData || ''), 'utf8');
                const durationMs = Date.now() - startTime;
                const success = result.success !== false;

                span.setAttribute(FUSION_AI_ATTRIBUTES.TOOL_STATUS, result.status || 'SUCCESS');
                span.setAttribute(FUSION_AI_ATTRIBUTES.TOOL_RESULT_BYTES, resultBytes);

                telemetry.recordToolExecution(name, durationMs, {
                    success,
                    resultBytes,
                    failureType: success ? undefined : result.error || result.status,
                });

                return {
                    success,
                    status: result.status || 'SUCCESS',
                    message: result.message || null,
                    error: result.error || null,
                    data: boundedData,
                    toolName: tool.name,
                    canonicalEvidenceKey: tool.canonicalEvidenceKey,
                };
            } catch (err) {
                if (timer) clearTimeout(timer);
                const durationMs = Date.now() - startTime;
                const failureType = classifyError(err);
                span.setAttribute(FUSION_AI_ATTRIBUTES.TOOL_STATUS, 'TOOL_EXECUTION_FAILED');
                span.setAttribute(FUSION_AI_ATTRIBUTES.TOOL_FAILURE_TYPE, failureType);

                telemetry.recordToolExecution(name, durationMs, {
                    success: false,
                    failureType,
                });

                return createToolError(
                    'TOOL_EXECUTION_FAILED',
                    `Error executing tool '${name}': ${err.message}`,
                    { toolName: name }
                );
            }
        });
    }
}

module.exports = {
    ToolRegistry,
    TOOL_DEFINITIONS,
    RAG_TOOL_DEFINITION,
    MAX_TOOL_RESULT_BYTES,
    TOOL_EXECUTION_TIMEOUT_MS,
};
