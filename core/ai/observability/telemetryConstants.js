'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * OPEN TELEMETRY & OBSERVABILITY CONSTANTS — PHASE AI-3.4
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Strict privacy boundaries, semantic attribute keys, and low-cardinality metric names.
 */

// OpenTelemetry Semantic Conventions Version
const SEMCONV_VERSION = '1.28.0';

// GenAI Semantic Attribute Keys (Stable & Incubating)
const GEN_AI_ATTRIBUTES = {
    SYSTEM: 'gen_ai.system',
    REQUEST_MODEL: 'gen_ai.request.model',
    RESPONSE_MODEL: 'gen_ai.response.model',
    OPERATION_NAME: 'gen_ai.operation.name',
    REQUEST_TEMPERATURE: 'gen_ai.request.temperature',
    REQUEST_TOP_P: 'gen_ai.request.top_p',
    REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
    RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
    RESPONSE_ID: 'gen_ai.response.id',
    USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
    USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
    USAGE_PROMPT_TOKENS: 'gen_ai.usage.prompt_tokens',
    USAGE_COMPLETION_TOKENS: 'gen_ai.usage.completion_tokens',
};

// Fusion AI Specific Attribute Keys (strictly sanitized & low/controlled cardinality)
const FUSION_AI_ATTRIBUTES = {
    INVESTIGATION_ID: 'fusion.ai.investigation_id',
    CASE_ID: 'fusion.ai.case_id',
    INTENT: 'fusion.ai.intent',
    STATUS: 'fusion.ai.status',
    OUTCOME: 'fusion.ai.outcome',
    ERROR_TYPE: 'fusion.ai.error_type',

    // Agent
    AGENT_ROUND: 'fusion.ai.agent.round',
    AGENT_ROUNDS_TOTAL: 'fusion.ai.agent.rounds_total',
    AGENT_TERMINATION_REASON: 'fusion.ai.agent.termination_reason',
    AGENT_TOOL_CALL_COUNT: 'fusion.ai.agent.tool_call_count',

    // Tool
    TOOL_NAME: 'fusion.ai.tool.name',
    TOOL_STATUS: 'fusion.ai.tool.status',
    TOOL_RESULT_BYTES: 'fusion.ai.tool.result_bytes',
    TOOL_FAILURE_TYPE: 'fusion.ai.tool.failure_type',
    TOOL_CALL_ID: 'fusion.ai.tool.call_id',

    // RAG
    RAG_PROVIDER: 'fusion.ai.rag.provider',
    RAG_ERROR_CODE: 'fusion.ai.rag.error_code',
    RAG_TOP_K: 'fusion.ai.rag.top_k',
    RAG_CANDIDATE_CHUNKS: 'fusion.ai.rag.candidate_chunks',
    RAG_RETURNED_CHUNKS: 'fusion.ai.rag.returned_chunks',
    RAG_MATCH_TYPE: 'fusion.ai.rag.match_type',
    RAG_ABSTENTION: 'fusion.ai.rag.abstention',
    RAG_EMBEDDING_MODEL: 'fusion.ai.rag.embedding_model',
    RAG_EMBEDDING_DIMENSION: 'fusion.ai.rag.embedding_dimension',
    RAG_EXACT_MATCH: 'fusion.ai.rag.exact_match',

    // DLP
    DLP_REDACTION_COUNT: 'fusion.ai.dlp.redaction_count',
    DLP_CATEGORIES: 'fusion.ai.dlp.categories',
    DLP_CATEGORY: 'fusion.ai.dlp.category',
    DLP_TARGET: 'fusion.ai.dlp.target',

    // Validation
    VALIDATION_TYPE: 'fusion.ai.validation.type',
    VALIDATION_PASSED: 'fusion.ai.validation.passed',
    VALIDATION_VIOLATION_COUNT: 'fusion.ai.validation.violation_count',
};

// Metric Names
const METRIC_NAMES = {
    // Investigation
    INVESTIGATIONS_TOTAL: 'fusion.ai.investigations.total',
    INVESTIGATION_DURATION: 'fusion.ai.investigation.duration',
    INVESTIGATION_FAILURES: 'fusion.ai.investigation.failures',
    INVESTIGATION_ACTIVE: 'fusion.ai.investigation.active',

    // Model
    MODEL_REQUESTS: 'fusion.ai.model.requests',
    MODEL_DURATION: 'fusion.ai.model.duration',
    MODEL_INPUT_TOKENS: 'fusion.ai.model.input_tokens',
    MODEL_OUTPUT_TOKENS: 'fusion.ai.model.output_tokens',
    MODEL_TIMEOUTS: 'fusion.ai.model.timeouts',
    MODEL_ERRORS: 'fusion.ai.model.errors',

    // Agent
    AGENT_ROUNDS: 'fusion.ai.agent.rounds',
    AGENT_TOOL_CALLS: 'fusion.ai.agent.tool_calls',
    AGENT_REPEATED_TOOL_CALLS: 'fusion.ai.agent.repeated_tool_calls',
    AGENT_REFUSALS: 'fusion.ai.agent.refusals',
    AGENT_VALIDATION_FAILURES: 'fusion.ai.agent.validation_failures',

    // RAG
    RAG_RETRIEVAL_DURATION: 'fusion.ai.rag.retrieval.duration',
    RAG_EMBEDDING_DURATION: 'fusion.ai.rag.embedding.duration',
    RAG_CHUNKS_RETURNED: 'fusion.ai.rag.chunks.returned',
    RAG_ABSTENTIONS: 'fusion.ai.rag.abstentions',
    RAG_CITATION_FAILURES: 'fusion.ai.rag.citation_failures',

    // DLP
    DLP_REDACTIONS: 'fusion.ai.dlp.redactions',
    DLP_DURATION: 'fusion.ai.dlp.duration',
    DLP_DETECTION_FAILURES: 'fusion.ai.dlp.detection_failures',
};

// Span Names
const SPAN_NAMES = {
    INVESTIGATION_HTTP_REQUEST: 'ai.investigation.http_request',
    DLP_INPUT_SANITIZATION: 'ai.dlp.input_sanitization',
    AGENT_ORCHESTRATION: 'ai.agent.orchestration',
    AGENT_ROUND: 'ai.agent.round',
    LLM_INFERENCE: 'ai.llm.inference',
    TOOL_SELECTION: 'ai.tool.selection',
    TOOL_EXECUTION: 'ai.tool.execution',
    RAG_RETRIEVAL: 'ai.rag.retrieval',
    RAG_QUERY_PREPROCESSING: 'ai.rag.query_preprocessing',
    RAG_EMBEDDING: 'ai.rag.embedding',
    RAG_BM25_SEARCH: 'ai.rag.bm25_search',
    RAG_DENSE_SEARCH: 'ai.rag.dense_search',
    RAG_HYBRID_RANKING: 'ai.rag.hybrid_ranking',
    RAG_RELEVANCE_FILTER: 'ai.rag.relevance_filter',
    EVIDENCE_CITATION_VALIDATION: 'ai.validation.evidence_citation',
    STRUCTURED_SCHEMA_VALIDATION: 'ai.validation.structured_schema',
    DLP_OUTPUT_SANITIZATION: 'ai.dlp.output_sanitization',
};

// Safe Model Names Allowlist for Low-Cardinality Metric Labels
const ALLOWED_MODEL_LABELS = new Set([
    'llama3.1:latest',
    'llama3:latest',
    'mock-model',
    'nomic-embed-text:latest',
    'mock-embed-384',
    'unknown',
]);

// Allowed Tool Names for Low-Cardinality Metric Labels
const ALLOWED_TOOL_LABELS = new Set([
    'get_transaction_timeline',
    'get_provider_failure_details',
    'get_reconciliation_evidence',
    'verify_ledger_integrity',
    'get_saga_execution_evidence',
    'explain_iso_validation_errors',
    'get_webhook_delivery_evidence',
    'get_settlement_and_webhook_evidence',
    'search_payment_knowledge',
    'unknown',
]);

// Standard Exception Classifications (replaces raw stack traces & sensitive error messages)
const ERROR_CLASSIFICATIONS = {
    MODEL_TIMEOUT: 'MODEL_TIMEOUT',
    MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
    MODEL_OUTPUT_INVALID: 'MODEL_OUTPUT_INVALID',
    INVALID_TOOL_CALL: 'INVALID_TOOL_CALL',
    TOOL_EXECUTION_EXCEPTION: 'TOOL_EXECUTION_EXCEPTION',
    AGENT_MAX_ROUNDS_EXHAUSTED: 'AGENT_MAX_ROUNDS_EXHAUSTED',
    REPEATED_TOOL_CALL: 'REPEATED_TOOL_CALL',
    RAG_RETRIEVAL_FAILURE: 'RAG_RETRIEVAL_FAILURE',
    EMBEDDING_DIMENSION_MISMATCH: 'EMBEDDING_DIMENSION_MISMATCH',
    CITATION_VALIDATION_FAILURE: 'CITATION_VALIDATION_FAILURE',
    SCHEMA_VALIDATION_FAILURE: 'SCHEMA_VALIDATION_FAILURE',
    DLP_FAILURE: 'DLP_FAILURE',
    PROHIBITED_MUTATION_REFUSAL: 'PROHIBITED_MUTATION_REFUSAL',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
};

/**
 * Classifies an error into a bounded, safe, low-cardinality error type.
 * Ensures sensitive messages are excluded from spans and metrics.
 *
 * @param {Error|object|string} err
 * @returns {string} Error classification
 */
function classifyError(err) {
    if (!err) return 'NONE';
    const msg = (typeof err === 'string' ? err : err.message || err.error || '').toLowerCase();
    const code = (err.code || err.status || '').toString().toLowerCase();

    if (
        msg.includes('timeout') ||
        msg.includes('deadline') ||
        msg.includes('abort') ||
        code.includes('timeout')
    ) {
        return ERROR_CLASSIFICATIONS.MODEL_TIMEOUT;
    }
    if (
        msg.includes('econnrefused') ||
        msg.includes('unavailable') ||
        msg.includes('not found') ||
        msg.includes('missing prerequisite')
    ) {
        return ERROR_CLASSIFICATIONS.MODEL_UNAVAILABLE;
    }
    if (msg.includes('not valid json') || msg.includes('json') || msg.includes('parse')) {
        return ERROR_CLASSIFICATIONS.MODEL_OUTPUT_INVALID;
    }
    if (msg.includes('repeated_tool_call') || msg.includes('repeated identical')) {
        return ERROR_CLASSIFICATIONS.REPEATED_TOOL_CALL;
    }
    if (msg.includes('dimension mismatch')) {
        return ERROR_CLASSIFICATIONS.EMBEDDING_DIMENSION_MISMATCH;
    }
    if (msg.includes('citation') || msg.includes('evidence reference')) {
        return ERROR_CLASSIFICATIONS.CITATION_VALIDATION_FAILURE;
    }
    if (msg.includes('schema') || msg.includes('joi') || msg.includes('validation')) {
        return ERROR_CLASSIFICATIONS.SCHEMA_VALIDATION_FAILURE;
    }
    if (msg.includes('mutation') || msg.includes('prohibited')) {
        return ERROR_CLASSIFICATIONS.PROHIBITED_MUTATION_REFUSAL;
    }
    if (msg.includes('tool') || msg.includes('execute')) {
        return ERROR_CLASSIFICATIONS.TOOL_EXECUTION_EXCEPTION;
    }
    if (msg.includes('dlp') || msg.includes('mask')) {
        return ERROR_CLASSIFICATIONS.DLP_FAILURE;
    }
    return ERROR_CLASSIFICATIONS.INTERNAL_ERROR;
}

module.exports = {
    SEMCONV_VERSION,
    GEN_AI_ATTRIBUTES,
    FUSION_AI_ATTRIBUTES,
    METRIC_NAMES,
    SPAN_NAMES,
    ALLOWED_MODEL_LABELS,
    ALLOWED_TOOL_LABELS,
    ERROR_CLASSIFICATIONS,
    classifyError,
};
