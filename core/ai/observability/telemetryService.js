'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * CENTRAL TELEMETRY SERVICE — PHASE AI-3.4
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Provides unified, privacy-safe tracing, metrics, context propagation, and span management.
 * Strictly local-first. Does NOT send telemetry to third-party cloud services.
 * Telemetry failures are strictly isolated and never crash business execution.
 */

const { trace, context, SpanStatusCode, propagation } = require('@opentelemetry/api');
const {
    BasicTracerProvider,
    SimpleSpanProcessor,
    BatchSpanProcessor,
} = require('@opentelemetry/sdk-trace-base');
const { AsyncHooksContextManager } = require('@opentelemetry/context-async-hooks');
const { Resource } = require('@opentelemetry/resources');
const { LocalInMemorySpanExporter, isLoopbackEndpoint } = require('./localExporter');
const { MetricsAggregator } = require('./metricsRegistry');
const {
    SEMCONV_VERSION,
    GEN_AI_ATTRIBUTES,
    FUSION_AI_ATTRIBUTES,
    METRIC_NAMES,
    SPAN_NAMES,
    ALLOWED_MODEL_LABELS,
    ALLOWED_TOOL_LABELS,
    ERROR_CLASSIFICATIONS,
    classifyError,
} = require('./telemetryConstants');

const SERVICE_NAME = 'project-fusion-ai';

class TelemetryService {
    constructor() {
        this.initialized = false;
        this.metrics = new MetricsAggregator();
        this.localExporter = new LocalInMemorySpanExporter();
        this.tracer = null;
        this.provider = null;
        this._initTracer();
    }

    _initTracer() {
        try {
            // Enable AsyncLocalStorage / AsyncHooks context manager for seamless parent-child span propagation
            try {
                const contextManager = new AsyncHooksContextManager();
                contextManager.enable();
                context.setGlobalContextManager(contextManager);
            } catch (ctxErr) {
                // If already set or fails, fall back to default context manager
            }

            const resource = new Resource({
                'service.name': SERVICE_NAME,
                'service.version': '1.0.0',
                'deployment.environment': process.env.NODE_ENV || 'development',
                'fusion.semconv_version': SEMCONV_VERSION,
            });

            this.provider = new BasicTracerProvider({ resource });

            // Always add the safe local in-memory span exporter for development/tests/inspections
            this.provider.addSpanProcessor(new SimpleSpanProcessor(this.localExporter));

            // Optional OTLP Exporter if configured and pointing to local loopback
            const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
            if (otlpEndpoint) {
                if (isLoopbackEndpoint(otlpEndpoint)) {
                    try {
                        const {
                            OTLPTraceExporter,
                        } = require('@opentelemetry/exporter-trace-otlp-http');
                        const otlp = new OTLPTraceExporter({ url: otlpEndpoint });
                        this.provider.addSpanProcessor(new BatchSpanProcessor(otlp));
                    } catch (e) {
                        // Fail-safe: do not crash
                    }
                } else {
                    // Non-loopback export strictly rejected without explicit bypass
                    if (process.env.ALLOW_NON_LOOPBACK_TELEMETRY !== 'true') {
                        // Suppress external export
                    }
                }
            }

            this.provider.register();
            this.tracer = trace.getTracer(SERVICE_NAME, '1.0.0');
            this.initialized = true;
        } catch (err) {
            // Fail-safe: fall back to noop tracer
            this.tracer = trace.getTracer(SERVICE_NAME);
            this.initialized = false;
        }
    }

    /**
     * Get active OpenTelemetry tracer.
     */
    getTracer() {
        return this.tracer || trace.getTracer(SERVICE_NAME);
    }

    /**
     * Executes a synchronous operation within an OpenTelemetry span.
     */
    withSyncSpan(spanName, fn, options = {}) {
        const tracer = this.getTracer();
        const parentCtx = options.parentContext || context.active();
        const initialAttrs = this.sanitizeAttributes(options.attributes || {});

        const span = tracer.startSpan(spanName, { attributes: initialAttrs }, parentCtx);
        const spanCtx = trace.setSpan(parentCtx, span);

        try {
            return context.with(spanCtx, () => {
                const result = fn(span, spanCtx);
                span.setStatus({ code: SpanStatusCode.OK });
                return result;
            });
        } catch (err) {
            const errType = classifyError(err);
            span.setStatus({
                code: SpanStatusCode.ERROR,
                description: `Sanitized error classification: ${errType}`,
            });
            span.setAttribute(FUSION_AI_ATTRIBUTES.ERROR_TYPE, errType);
            span.setAttribute('error', true);
            throw err;
        } finally {
            try {
                span.end();
            } catch {}
        }
    }

    /**
     * Executes an async operation within an OpenTelemetry span.
     * Manages active context propagation, timing, attribute recording, and error classification.
     *
     * @param {string} spanName - Name of the span
     * @param {Function} fn - Function receiving (span, ctx)
     * @param {object} [options]
     * @param {object} [options.attributes] - Initial span attributes
     * @param {object} [options.parentContext] - Parent OpenTelemetry context
     * @returns {Promise<any>}
     */
    async withSpan(spanName, fn, options = {}) {
        const tracer = this.getTracer();
        const parentCtx = options.parentContext || context.active();
        const initialAttrs = this.sanitizeAttributes(options.attributes || {});

        const span = tracer.startSpan(spanName, { attributes: initialAttrs }, parentCtx);
        const spanCtx = trace.setSpan(parentCtx, span);

        try {
            return await context.with(spanCtx, async () => {
                const result = await fn(span, spanCtx);
                span.setStatus({ code: SpanStatusCode.OK });
                return result;
            });
        } catch (err) {
            const errType = classifyError(err);
            span.setStatus({
                code: SpanStatusCode.ERROR,
                description: `Sanitized error classification: ${errType}`,
            });
            span.setAttribute(FUSION_AI_ATTRIBUTES.ERROR_TYPE, errType);
            span.setAttribute('error', true);
            throw err;
        } finally {
            try {
                span.end();
            } catch {
                // Safeguard against span termination errors
            }
        }
    }

    /**
     * Starts an active span manually when lifecycle crosses non-block callbacks.
     */
    startSpan(spanName, options = {}) {
        const tracer = this.getTracer();
        const parentCtx = options.parentContext || context.active();
        const initialAttrs = this.sanitizeAttributes(options.attributes || {});
        return tracer.startSpan(spanName, { attributes: initialAttrs }, parentCtx);
    }

    /**
     * Sanitizes attribute objects to prevent PII, prompt content, or raw payloads from leaking.
     */
    sanitizeAttributes(attrs = {}) {
        const safe = {};
        for (const [key, val] of Object.entries(attrs)) {
            if (val === undefined || val === null) continue;

            // Reject forbidden keys containing prompt, content, raw text, or sensitive identifiers
            const lowerKey = key.toLowerCase();
            if (
                lowerKey.includes('message') ||
                lowerKey.includes('prompt') ||
                lowerKey.includes('completion') ||
                lowerKey.includes('content') ||
                lowerKey.includes('argument') ||
                lowerKey.includes('password') ||
                lowerKey.includes('secret') ||
                lowerKey.includes('token_map') ||
                lowerKey.includes('customer') ||
                lowerKey.includes('beneficiary') ||
                lowerKey.includes('email') ||
                lowerKey.includes('account_number') ||
                lowerKey.includes('pan') ||
                lowerKey.includes('iban') ||
                lowerKey.includes('exception')
            ) {
                // Only allow standard token usage counts, never prompt/completion content
                if (
                    key !== GEN_AI_ATTRIBUTES.USAGE_INPUT_TOKENS &&
                    key !== GEN_AI_ATTRIBUTES.USAGE_OUTPUT_TOKENS &&
                    key !== GEN_AI_ATTRIBUTES.USAGE_PROMPT_TOKENS &&
                    key !== GEN_AI_ATTRIBUTES.USAGE_COMPLETION_TOKENS
                ) {
                    continue;
                }
            }

            // Primitive value preservation
            if (typeof val === 'string') {
                safe[key] = val.length > 256 ? `${val.substring(0, 253)}...` : val;
            } else if (typeof val === 'number' || typeof val === 'boolean') {
                safe[key] = val;
            } else if (Array.isArray(val)) {
                // Keep arrays of strings/numbers if small
                safe[key] = val.slice(0, 10).map((v) => (typeof v === 'object' ? '[OBJECT]' : v));
            }
        }
        return safe;
    }

    // ── METRIC RECORDING METHODS ──────────────────────────────────────────────

    recordInvestigationStart(labels = {}) {
        try {
            this.metrics.incrementCounter(
                METRIC_NAMES.INVESTIGATIONS_TOTAL,
                1,
                this._filterLabels(labels)
            );
            this.metrics.incrementCounter(METRIC_NAMES.INVESTIGATION_ACTIVE, 1);
        } catch {}
    }

    recordInvestigationEnd(durationMs, success, labels = {}) {
        try {
            this.metrics.incrementCounter(METRIC_NAMES.INVESTIGATION_ACTIVE, -1);
            const safeLabels = this._filterLabels(labels);
            this.metrics.recordHistogram(
                METRIC_NAMES.INVESTIGATION_DURATION,
                durationMs,
                safeLabels
            );
            if (!success) {
                this.metrics.incrementCounter(METRIC_NAMES.INVESTIGATION_FAILURES, 1, safeLabels);
            }
        } catch {}
    }

    recordModelRequest(
        durationMs,
        {
            provider = 'ollama',
            model = 'unknown',
            success = true,
            errorType,
            promptTokens = 0,
            completionTokens = 0,
        } = {}
    ) {
        try {
            const safeModel = ALLOWED_MODEL_LABELS.has(model) ? model : 'other';
            const labels = { provider, model: safeModel, success: String(success) };
            this.metrics.incrementCounter(METRIC_NAMES.MODEL_REQUESTS, 1, labels);
            this.metrics.recordHistogram(METRIC_NAMES.MODEL_DURATION, durationMs, labels);

            if (promptTokens > 0) {
                this.metrics.incrementCounter(
                    METRIC_NAMES.MODEL_INPUT_TOKENS,
                    promptTokens,
                    labels
                );
            }
            if (completionTokens > 0) {
                this.metrics.incrementCounter(
                    METRIC_NAMES.MODEL_OUTPUT_TOKENS,
                    completionTokens,
                    labels
                );
            }

            if (!success) {
                const errLabel = { ...labels, error_type: errorType || 'UNKNOWN' };
                this.metrics.incrementCounter(METRIC_NAMES.MODEL_ERRORS, 1, errLabel);
                if (errorType === ERROR_CLASSIFICATIONS.MODEL_TIMEOUT) {
                    this.metrics.incrementCounter(METRIC_NAMES.MODEL_TIMEOUTS, 1, labels);
                }
            }
        } catch {}
    }

    recordAgentRound(roundNumber, labels = {}) {
        try {
            this.metrics.incrementCounter(METRIC_NAMES.AGENT_ROUNDS, 1, this._filterLabels(labels));
        } catch {}
    }

    recordToolExecution(
        toolName,
        durationMs,
        { success = true, resultBytes = 0, failureType } = {}
    ) {
        try {
            const safeTool = ALLOWED_TOOL_LABELS.has(toolName) ? toolName : 'unknown';
            const labels = { tool: safeTool, success: String(success) };
            this.metrics.incrementCounter(METRIC_NAMES.AGENT_TOOL_CALLS, 1, labels);
            if (!success && failureType) {
                this.metrics.incrementCounter(METRIC_NAMES.AGENT_VALIDATION_FAILURES, 1, {
                    tool: safeTool,
                    failure_type: failureType,
                });
            }
        } catch {}
    }

    recordRepeatedToolCall(toolName) {
        try {
            const safeTool = ALLOWED_TOOL_LABELS.has(toolName) ? toolName : 'unknown';
            this.metrics.incrementCounter(METRIC_NAMES.AGENT_REPEATED_TOOL_CALLS, 1, {
                tool: safeTool,
            });
        } catch {}
    }

    recordAgentRefusal(reason) {
        try {
            this.metrics.incrementCounter(METRIC_NAMES.AGENT_REFUSALS, 1, {
                reason: reason || 'PROHIBITED_MUTATION',
            });
        } catch {}
    }

    recordRagRetrieval(durationMs, { chunksReturned = 0, abstained = false, provider } = {}) {
        try {
            const labels = provider ? { provider } : {};
            this.metrics.recordHistogram(METRIC_NAMES.RAG_RETRIEVAL_DURATION, durationMs, labels);
            this.metrics.incrementCounter(METRIC_NAMES.RAG_CHUNKS_RETURNED, chunksReturned, labels);
            if (abstained) {
                this.metrics.incrementCounter(METRIC_NAMES.RAG_ABSTENTIONS, 1, labels);
            }
        } catch {}
    }

    recordRagEmbedding(durationMs, { model = 'unknown' } = {}) {
        try {
            const safeModel = ALLOWED_MODEL_LABELS.has(model) ? model : 'other';
            this.metrics.recordHistogram(METRIC_NAMES.RAG_EMBEDDING_DURATION, durationMs, {
                model: safeModel,
            });
        } catch {}
    }

    recordDlpRedaction(count = 1, category = 'UNKNOWN', durationMs = 0) {
        try {
            this.metrics.incrementCounter(METRIC_NAMES.DLP_REDACTIONS, count, { category });
            if (durationMs > 0) {
                this.metrics.recordHistogram(METRIC_NAMES.DLP_DURATION, durationMs);
            }
        } catch {}
    }

    recordDlpDuration(durationMs) {
        try {
            if (durationMs >= 0) {
                this.metrics.recordHistogram(METRIC_NAMES.DLP_DURATION, durationMs);
            }
        } catch {}
    }

    _filterLabels(labels = {}) {
        const allowed = {};
        for (const [k, v] of Object.entries(labels)) {
            if (
                ['intent', 'status', 'provider', 'model', 'tool', 'success', 'category'].includes(k)
            ) {
                allowed[k] = String(v);
            }
        }
        return allowed;
    }

    /**
     * Returns aggregate metrics summary for the local API endpoint.
     */
    getMetricsSummary() {
        return this.metrics.getSummary();
    }

    /**
     * Resets local in-memory traces and metrics (useful for isolated unit tests).
     */
    reset() {
        this.localExporter.reset();
        this.metrics.reset();
    }
}

// Singleton instance
const telemetry = new TelemetryService();

module.exports = {
    TelemetryService,
    telemetry,
};
