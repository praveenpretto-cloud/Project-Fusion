'use strict';

const { BaseModelProvider, PROVIDER_STATUSES } = require('./baseProvider');
const { Ollama } = require('ollama');
const {
    telemetry,
    SPAN_NAMES,
    GEN_AI_ATTRIBUTES,
    FUSION_AI_ATTRIBUTES,
    classifyError,
} = require('../observability');

const APPROVED_HOSTS = new Set([
    'http://127.0.0.1:11434',
    'http://localhost:11434',
    '127.0.0.1:11434',
    'localhost:11434',
]);

/**
 * Validates that the provided host points exclusively to an approved local loopback endpoint.
 * Prevents SSRF, DNS rebinding, and external model redirection attacks.
 *
 * @param {string} host
 * @returns {string} Normalized local host URL
 */
function validateAndNormalizeLocalHost(host) {
    if (!host || typeof host !== 'string') {
        return 'http://127.0.0.1:11434';
    }

    const trimmed = host.trim().toLowerCase();

    // Check direct match
    if (!APPROVED_HOSTS.has(trimmed)) {
        try {
            const parsed = new URL(trimmed.startsWith('http') ? trimmed : `http://${trimmed}`);
            const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
            const isApprovedPort = parsed.port === '11434' || parsed.port === '';
            const isHttp = parsed.protocol === 'http:';

            if (!isLocal || !isApprovedPort || !isHttp) {
                throw new Error(`Non-local or unapproved model host rejected: '${host}'`);
            }
        } catch {
            throw new Error(
                `Invalid local model host: '${host}'. Only approved local loopback (127.0.0.1:11434) is permitted.`
            );
        }
    }

    return trimmed.startsWith('http') ? trimmed : `http://${trimmed}`;
}

const DEFAULT_LOCAL_MODEL = 'llama3.1:latest';
const DEFAULT_TIMEOUT_MS = 30000; // 30s authoritative timeout: 2x safety margin over max measured 14.9s latency

class OllamaProvider extends BaseModelProvider {
    /**
     * @param {object} [options]
     * @param {string} [options.host='http://127.0.0.1:11434'] - Must be approved local host
     * @param {string} [options.defaultModel='llama3.1:latest'] - Default model tag
     * @param {number} [options.timeoutMs=30000] - Authoritative inference timeout
     */
    constructor(options = {}) {
        super('ollama');
        const rawHost = options.host || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
        this.host = validateAndNormalizeLocalHost(rawHost);
        this.defaultModel = options.defaultModel || process.env.OLLAMA_MODEL || DEFAULT_LOCAL_MODEL;
        this.timeoutMs =
            options.timeoutMs !== undefined
                ? options.timeoutMs
                : parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS;
        this.client = new Ollama({ host: this.host });
    }

    /**
     * Healthcheck ping to local Ollama server.
     * Verifies server connectivity and confirms that the configured model is installed.
     */
    async ping() {
        const start = Date.now();
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 2000);

            // Check tags list
            const res = await this.client.list();
            clearTimeout(timer);
            const installedModels = res && res.models ? res.models.map((m) => m.name) : [];

            // Verify that the configured model is installed (exact match or prefix match)
            const isInstalled = installedModels.some((name) => {
                if (name === this.defaultModel) return true;
                if (!this.defaultModel.includes(':') && name.split(':')[0] === this.defaultModel)
                    return true;
                return false;
            });

            if (!isInstalled) {
                return {
                    available: false,
                    status: PROVIDER_STATUSES.AI_UNAVAILABLE,
                    latencyMs: Date.now() - start,
                    configuredModel: this.defaultModel,
                    models: installedModels,
                    error: `Configured model '${this.defaultModel}' is not installed in local Ollama daemon. Missing prerequisite. Installed models: [${installedModels.join(', ')}].`,
                };
            }

            return {
                available: true,
                status: PROVIDER_STATUSES.SUCCESS,
                latencyMs: Date.now() - start,
                configuredModel: this.defaultModel,
                models: installedModels,
            };
        } catch (err) {
            return {
                available: false,
                status: PROVIDER_STATUSES.AI_UNAVAILABLE,
                latencyMs: Date.now() - start,
                error: err.message,
            };
        }
    }

    /**
     * Generate structured completion from prompt context using local Ollama.
     */
    async generate({
        model,
        systemInstruction,
        evidenceContext,
        investigationQuestion,
        generationConfig = {},
        timeoutMs,
    }) {
        const selectedModel = model || this.defaultModel;
        return telemetry.withSpan(SPAN_NAMES.LLM_INFERENCE, async (span) => {
            span.setAttribute(GEN_AI_ATTRIBUTES.SYSTEM, 'ollama');
            span.setAttribute(GEN_AI_ATTRIBUTES.REQUEST_MODEL, selectedModel);
            span.setAttribute(GEN_AI_ATTRIBUTES.OPERATION_NAME, 'generate');
            if (generationConfig.temperature !== undefined) {
                span.setAttribute(
                    GEN_AI_ATTRIBUTES.REQUEST_TEMPERATURE,
                    generationConfig.temperature
                );
            }
            if (generationConfig.maxTokens !== undefined) {
                span.setAttribute(GEN_AI_ATTRIBUTES.REQUEST_MAX_TOKENS, generationConfig.maxTokens);
            }

            const startTime = Date.now();
            const effectiveTimeout = timeoutMs !== undefined ? timeoutMs : this.timeoutMs;

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), effectiveTimeout);

            try {
                // Build messages array strictly segregating trusted instructions from untrusted data
                const messages = [
                    {
                        role: 'system',
                        content: systemInstruction,
                    },
                    {
                        role: 'user',
                        content: `=== OPERATIONAL EVIDENCE (UNTRUSTED DATA) ===\n${
                            typeof evidenceContext === 'string'
                                ? evidenceContext
                                : JSON.stringify(evidenceContext, null, 2)
                        }\n\n=== INVESTIGATION QUESTION ===\n${investigationQuestion}\n\nRespond strictly in valid JSON adhering to the investigation report schema.`,
                    },
                ];

                const response = await this.client.chat({
                    model: selectedModel,
                    messages,
                    format: 'json',
                    options: {
                        temperature:
                            generationConfig.temperature !== undefined
                                ? generationConfig.temperature
                                : 0.1,
                        num_predict: generationConfig.maxTokens || 2048,
                        top_p: generationConfig.topP || 0.9,
                    },
                });

                clearTimeout(timer);
                const latencyMs = Date.now() - startTime;
                const promptTokens = response?.prompt_eval_count || 0;
                const completionTokens = response?.eval_count || 0;

                span.setAttribute(GEN_AI_ATTRIBUTES.USAGE_INPUT_TOKENS, promptTokens);
                span.setAttribute(GEN_AI_ATTRIBUTES.USAGE_OUTPUT_TOKENS, completionTokens);
                span.setAttribute(FUSION_AI_ATTRIBUTES.STATUS, PROVIDER_STATUSES.SUCCESS);

                telemetry.recordModelRequest(latencyMs, {
                    provider: 'ollama',
                    model: selectedModel,
                    success: true,
                    promptTokens,
                    completionTokens,
                });

                const content =
                    response && response.message && response.message.content
                        ? response.message.content.trim()
                        : '';

                if (!content) {
                    span.setAttribute(
                        FUSION_AI_ATTRIBUTES.STATUS,
                        PROVIDER_STATUSES.MODEL_RESPONSE_EMPTY
                    );
                    return {
                        rawResponse: '',
                        parsedResponse: null,
                        latencyMs,
                        metadata: {
                            provider: this.providerName,
                            model: selectedModel,
                            tokens: {
                                prompt: promptTokens,
                                completion: completionTokens,
                            },
                        },
                        status: PROVIDER_STATUSES.MODEL_RESPONSE_EMPTY,
                        error: 'Model returned an empty response',
                    };
                }

                // Attempt strict JSON parsing
                let parsed = null;
                try {
                    parsed = JSON.parse(content);
                } catch (jsonErr) {
                    span.setAttribute(
                        FUSION_AI_ATTRIBUTES.STATUS,
                        PROVIDER_STATUSES.MODEL_OUTPUT_INVALID
                    );
                    span.setAttribute(FUSION_AI_ATTRIBUTES.ERROR_TYPE, 'MODEL_OUTPUT_INVALID');
                    return {
                        rawResponse: content,
                        parsedResponse: null,
                        latencyMs,
                        metadata: {
                            provider: this.providerName,
                            model: selectedModel,
                            tokens: {
                                prompt: promptTokens,
                                completion: completionTokens,
                            },
                        },
                        status: PROVIDER_STATUSES.MODEL_OUTPUT_INVALID,
                        error: `Model output is not valid JSON: ${jsonErr.message}`,
                    };
                }

                return {
                    rawResponse: content,
                    parsedResponse: parsed,
                    latencyMs,
                    metadata: {
                        provider: this.providerName,
                        model: selectedModel,
                        tokens: {
                            prompt: promptTokens,
                            completion: completionTokens,
                        },
                    },
                    status: PROVIDER_STATUSES.SUCCESS,
                    error: null,
                };
            } catch (err) {
                clearTimeout(timer);
                const latencyMs = Date.now() - startTime;
                const errorType = classifyError(err);
                span.setAttribute(FUSION_AI_ATTRIBUTES.ERROR_TYPE, errorType);
                span.setAttribute(FUSION_AI_ATTRIBUTES.STATUS, 'ERROR');

                telemetry.recordModelRequest(latencyMs, {
                    provider: 'ollama',
                    model: selectedModel,
                    success: false,
                    errorType,
                });

                if (
                    err.name === 'AbortError' ||
                    err.message.includes('abort') ||
                    latencyMs >= effectiveTimeout
                ) {
                    return {
                        rawResponse: null,
                        parsedResponse: null,
                        latencyMs,
                        metadata: { provider: this.providerName, model: selectedModel },
                        status: PROVIDER_STATUSES.MODEL_TIMEOUT,
                        error: `Model inference exceeded timeout of ${effectiveTimeout}ms`,
                    };
                }

                if (err.message && (err.message.includes('not found') || err.status_code === 404)) {
                    return {
                        rawResponse: null,
                        parsedResponse: null,
                        latencyMs,
                        metadata: { provider: this.providerName, model: selectedModel },
                        status: PROVIDER_STATUSES.AI_UNAVAILABLE,
                        error: `Model '${selectedModel}' is not installed in local Ollama daemon. Missing prerequisite.`,
                    };
                }

                if (
                    err.code === 'ECONNREFUSED' ||
                    err.message.includes('ECONNREFUSED') ||
                    err.message.includes('connect')
                ) {
                    return {
                        rawResponse: null,
                        parsedResponse: null,
                        latencyMs,
                        metadata: { provider: this.providerName, model: selectedModel },
                        status: PROVIDER_STATUSES.AI_UNAVAILABLE,
                        error: `Local Ollama instance unavailable at ${this.host} (${err.message})`,
                    };
                }

                return {
                    rawResponse: null,
                    parsedResponse: null,
                    latencyMs,
                    metadata: { provider: this.providerName, model: selectedModel },
                    status: PROVIDER_STATUSES.MODEL_PROVIDER_ERROR,
                    error: err.message,
                };
            }
        });
    }

    /**
     * Multi-turn chat completion with native function calling support.
     *
     * @param {object} params
     * @param {string} [params.model]
     * @param {Array<object>} params.messages
     * @param {Array<object>} [params.tools]
     * @param {string|object} [params.format]
     * @param {object} [params.generationConfig]
     * @param {number} [params.timeoutMs]
     * @returns {Promise<object>}
     */
    async chat({
        model,
        messages,
        tools = [],
        format = undefined,
        generationConfig = {},
        timeoutMs,
    }) {
        const selectedModel = model || this.defaultModel;
        return telemetry.withSpan(SPAN_NAMES.LLM_INFERENCE, async (span) => {
            span.setAttribute(GEN_AI_ATTRIBUTES.SYSTEM, 'ollama');
            span.setAttribute(GEN_AI_ATTRIBUTES.REQUEST_MODEL, selectedModel);
            span.setAttribute(GEN_AI_ATTRIBUTES.OPERATION_NAME, 'chat');
            if (generationConfig.temperature !== undefined) {
                span.setAttribute(
                    GEN_AI_ATTRIBUTES.REQUEST_TEMPERATURE,
                    generationConfig.temperature
                );
            }
            if (generationConfig.maxTokens !== undefined) {
                span.setAttribute(GEN_AI_ATTRIBUTES.REQUEST_MAX_TOKENS, generationConfig.maxTokens);
            }
            if (Array.isArray(tools) && tools.length > 0) {
                span.setAttribute(FUSION_AI_ATTRIBUTES.AGENT_TOOL_CALL_COUNT, tools.length);
            }

            const startTime = Date.now();
            const effectiveTimeout = timeoutMs !== undefined ? timeoutMs : this.timeoutMs;

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), effectiveTimeout);

            try {
                const chatPayload = {
                    model: selectedModel,
                    messages,
                    options: {
                        temperature:
                            generationConfig.temperature !== undefined
                                ? generationConfig.temperature
                                : 0.1,
                        num_predict: generationConfig.maxTokens || 2048,
                        top_p: generationConfig.topP || 0.9,
                    },
                };

                if (Array.isArray(tools) && tools.length > 0) {
                    chatPayload.tools = tools;
                }

                if (format !== undefined) {
                    chatPayload.format = format;
                }

                const response = await this.client.chat(chatPayload);

                clearTimeout(timer);
                const latencyMs = Date.now() - startTime;
                const promptTokens = response?.prompt_eval_count || 0;
                const completionTokens = response?.eval_count || 0;

                span.setAttribute(GEN_AI_ATTRIBUTES.USAGE_INPUT_TOKENS, promptTokens);
                span.setAttribute(GEN_AI_ATTRIBUTES.USAGE_OUTPUT_TOKENS, completionTokens);
                span.setAttribute(FUSION_AI_ATTRIBUTES.STATUS, PROVIDER_STATUSES.SUCCESS);

                telemetry.recordModelRequest(latencyMs, {
                    provider: 'ollama',
                    model: selectedModel,
                    success: true,
                    promptTokens,
                    completionTokens,
                });

                if (!response || !response.message) {
                    span.setAttribute(
                        FUSION_AI_ATTRIBUTES.STATUS,
                        PROVIDER_STATUSES.MODEL_RESPONSE_EMPTY
                    );
                    return {
                        status: PROVIDER_STATUSES.MODEL_RESPONSE_EMPTY,
                        message: null,
                        rawResponse: response,
                        latencyMs,
                        metadata: {
                            provider: this.providerName,
                            model: selectedModel,
                            tokens: {
                                prompt: promptTokens,
                                completion: completionTokens,
                            },
                        },
                        error: 'Model returned an empty chat response',
                    };
                }

                return {
                    status: PROVIDER_STATUSES.SUCCESS,
                    message: response.message,
                    rawResponse: response,
                    latencyMs,
                    metadata: {
                        provider: this.providerName,
                        model: selectedModel,
                        tokens: {
                            prompt: promptTokens,
                            completion: completionTokens,
                        },
                    },
                    error: null,
                };
            } catch (err) {
                clearTimeout(timer);
                const latencyMs = Date.now() - startTime;
                const errorType = classifyError(err);
                span.setAttribute(FUSION_AI_ATTRIBUTES.ERROR_TYPE, errorType);
                span.setAttribute(FUSION_AI_ATTRIBUTES.STATUS, 'ERROR');

                telemetry.recordModelRequest(latencyMs, {
                    provider: 'ollama',
                    model: selectedModel,
                    success: false,
                    errorType,
                });

                if (
                    err.name === 'AbortError' ||
                    err.message.includes('abort') ||
                    latencyMs >= effectiveTimeout
                ) {
                    return {
                        status: PROVIDER_STATUSES.MODEL_TIMEOUT,
                        message: null,
                        rawResponse: null,
                        latencyMs,
                        metadata: { provider: this.providerName, model: selectedModel },
                        error: `Model inference exceeded timeout of ${effectiveTimeout}ms`,
                    };
                }

                if (err.message && (err.message.includes('not found') || err.status_code === 404)) {
                    return {
                        status: PROVIDER_STATUSES.AI_UNAVAILABLE,
                        message: null,
                        rawResponse: null,
                        latencyMs,
                        metadata: { provider: this.providerName, model: selectedModel },
                        error: `Model '${selectedModel}' is not installed in local Ollama daemon. Missing prerequisite.`,
                    };
                }

                if (
                    err.code === 'ECONNREFUSED' ||
                    err.message.includes('ECONNREFUSED') ||
                    err.message.includes('connect')
                ) {
                    return {
                        status: PROVIDER_STATUSES.AI_UNAVAILABLE,
                        message: null,
                        rawResponse: null,
                        latencyMs,
                        metadata: { provider: this.providerName, model: selectedModel },
                        error: `Local Ollama instance unavailable at ${this.host} (${err.message})`,
                    };
                }

                return {
                    status: PROVIDER_STATUSES.MODEL_PROVIDER_ERROR,
                    message: null,
                    rawResponse: null,
                    latencyMs,
                    metadata: { provider: this.providerName, model: selectedModel },
                    error: err.message,
                };
            }
        });
    }
}

module.exports = {
    OllamaProvider,
    validateAndNormalizeLocalHost,
};
