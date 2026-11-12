'use strict';

const { BaseModelProvider, PROVIDER_STATUSES } = require('./baseProvider');
const { telemetry, SPAN_NAMES, GEN_AI_ATTRIBUTES, FUSION_AI_ATTRIBUTES, classifyError } = require('../observability');

/**
 * Mock Model Provider for Deterministic Offline Testing
 * 
 * Allows tests to configure exact model responses, artificial latency, JSON syntax errors,
 * timeout triggers, or service unavailability without a running Ollama daemon.
 */
class MockModelProvider extends BaseModelProvider {
    /**
     * @param {object} [options]
     * @param {string} [options.forcedStatus=PROVIDER_STATUSES.SUCCESS]
     * @param {object|string} [options.mockResponse] - Object or string returned on SUCCESS
     * @param {number} [options.simulatedLatencyMs=10]
     */
    constructor(options = {}) {
        super('mock');
        this.forcedStatus = options.forcedStatus || PROVIDER_STATUSES.SUCCESS;
        this.mockResponse = options.mockResponse || null;
        this.simulatedLatencyMs = options.simulatedLatencyMs !== undefined ? options.simulatedLatencyMs : 10;
        this.invocationHistory = [];
        this.mockChatResponses = options.mockChatResponses || [];
        this.chatInvocationHistory = [];
        this.chatStepIndex = 0;
    }

    setMockChatResponses(responses) {
        this.mockChatResponses = Array.isArray(responses) ? [...responses] : [responses];
        this.chatStepIndex = 0;
    }

    setMockOutcome(status, response = null) {
        this.forcedStatus = status;
        if (response !== null) {
            this.mockResponse = response;
        }
    }

    setForcedStatus(status) {
        this.forcedStatus = status;
    }

    setMockResponse(response) {
        this.mockResponse = response;
    }

    async ping() {
        if (this.forcedStatus === PROVIDER_STATUSES.AI_UNAVAILABLE) {
            return {
                available: false,
                status: PROVIDER_STATUSES.AI_UNAVAILABLE,
                latencyMs: this.simulatedLatencyMs,
                error: 'Mock service configured as unavailable'
            };
        }
        return {
            available: true,
            status: PROVIDER_STATUSES.SUCCESS,
            latencyMs: this.simulatedLatencyMs,
            models: ['mock-llama-3.2']
        };
    }

    async generate({
        model = 'mock-llama-3.2',
        systemInstruction,
        evidenceContext,
        investigationQuestion,
        generationConfig = {},
        timeoutMs = 15000
    }) {
        const record = {
            model,
            systemInstruction,
            evidenceContext,
            investigationQuestion,
            generationConfig,
            timeoutMs,
            timestamp: Date.now()
        };
        this.invocationHistory.push(record);

        // Simulate configured latency
        if (this.simulatedLatencyMs > 0) {
            await new Promise(resolve => setTimeout(resolve, Math.min(this.simulatedLatencyMs, timeoutMs)));
        }

        if (this.forcedStatus === PROVIDER_STATUSES.MODEL_TIMEOUT || this.simulatedLatencyMs >= timeoutMs) {
            return {
                rawResponse: null,
                parsedResponse: null,
                latencyMs: timeoutMs,
                metadata: { provider: this.providerName, model },
                status: PROVIDER_STATUSES.MODEL_TIMEOUT,
                error: `Model inference exceeded timeout of ${timeoutMs}ms`
            };
        }

        if (this.forcedStatus === PROVIDER_STATUSES.AI_UNAVAILABLE) {
            return {
                rawResponse: null,
                parsedResponse: null,
                latencyMs: this.simulatedLatencyMs,
                metadata: { provider: this.providerName, model },
                status: PROVIDER_STATUSES.AI_UNAVAILABLE,
                error: 'Local Ollama instance unavailable'
            };
        }

        if (this.forcedStatus === PROVIDER_STATUSES.MODEL_RESPONSE_EMPTY) {
            return {
                rawResponse: '',
                parsedResponse: null,
                latencyMs: this.simulatedLatencyMs,
                metadata: { provider: this.providerName, model, tokens: { prompt: 50, completion: 0 } },
                status: PROVIDER_STATUSES.MODEL_RESPONSE_EMPTY,
                error: 'Model returned an empty response'
            };
        }

        if (this.forcedStatus === PROVIDER_STATUSES.MODEL_OUTPUT_INVALID) {
            const malformed = typeof this.mockResponse === 'string' ? this.mockResponse : 'MALFORMED_JSON_STRING { "unclosed": ';
            return {
                rawResponse: malformed,
                parsedResponse: null,
                latencyMs: this.simulatedLatencyMs,
                metadata: { provider: this.providerName, model, tokens: { prompt: 50, completion: 10 } },
                status: PROVIDER_STATUSES.MODEL_OUTPUT_INVALID,
                error: 'Model output is not valid JSON: Unexpected token'
            };
        }

        if (this.forcedStatus === PROVIDER_STATUSES.MODEL_PROVIDER_ERROR) {
            return {
                rawResponse: null,
                parsedResponse: null,
                latencyMs: this.simulatedLatencyMs,
                metadata: { provider: this.providerName, model },
                status: PROVIDER_STATUSES.MODEL_PROVIDER_ERROR,
                error: 'Unexpected runtime crash in model provider'
            };
        }

        // Default: SUCCESS with schema-compliant report structure
        const defaultReport = {
            summary: 'Investigation completed based on operational evidence.',
            status: 'COMPLETED',
            confirmed_findings: [
                {
                    claim: 'Operational transaction state confirmed by recorded timeline.',
                    evidence_references: ['getTransactionTimeline'],
                    source_field: 'getTransactionTimeline.status'
                }
            ],
            hypotheses: [],
            missing_information: [],
            recommended_checks: ['REVIEW_TRANSACTION_TIMELINE'],
            evidence_references: ['getTransactionTimeline'],
            limitations: ['Advisory decision support only; human approval required.']
        };

        const rawContent = typeof this.mockResponse === 'string'
            ? this.mockResponse
            : JSON.stringify(this.mockResponse || defaultReport);

        let parsed = null;
        try {
            parsed = JSON.parse(rawContent);
        } catch {
            parsed = null;
        }

        return {
            rawResponse: rawContent,
            parsedResponse: parsed,
            latencyMs: this.simulatedLatencyMs,
            metadata: {
                provider: this.providerName,
                model,
                tokens: { prompt: 120, completion: 240 }
            },
            status: PROVIDER_STATUSES.SUCCESS,
            error: null
        };
    }

    /**
     * Multi-turn chat completion with tool calling support for mock testing.
     */
    async chat({
        model = 'mock-llama-3.2',
        messages = [],
        tools = [],
        format = undefined,
        generationConfig = {},
        timeoutMs = 30000
    }) {
        return telemetry.withSpan(SPAN_NAMES.LLM_INFERENCE, async (span) => {
            span.setAttribute(GEN_AI_ATTRIBUTES.SYSTEM, 'mock');
            span.setAttribute(GEN_AI_ATTRIBUTES.REQUEST_MODEL, model);
            span.setAttribute(GEN_AI_ATTRIBUTES.OPERATION_NAME, 'chat');
            if (Array.isArray(tools) && tools.length > 0) {
                span.setAttribute(FUSION_AI_ATTRIBUTES.AGENT_TOOL_CALL_COUNT, tools.length);
            }

            const record = {
                model,
                messages: JSON.parse(JSON.stringify(messages)),
                tools,
                format,
                timeoutMs,
                timestamp: Date.now()
            };
            this.chatInvocationHistory.push(record);

            // Simulate configured latency
            if (this.simulatedLatencyMs > 0) {
                await new Promise(resolve => setTimeout(resolve, Math.min(this.simulatedLatencyMs, timeoutMs)));
            }

            if (this.forcedStatus === PROVIDER_STATUSES.MODEL_TIMEOUT || this.simulatedLatencyMs >= timeoutMs) {
                span.setAttribute(FUSION_AI_ATTRIBUTES.STATUS, PROVIDER_STATUSES.MODEL_TIMEOUT);
                span.setAttribute(FUSION_AI_ATTRIBUTES.ERROR_TYPE, 'MODEL_TIMEOUT');
                telemetry.recordModelRequest(timeoutMs, {
                    provider: 'mock',
                    model,
                    success: false,
                    errorType: 'MODEL_TIMEOUT'
                });
                return {
                    status: PROVIDER_STATUSES.MODEL_TIMEOUT,
                    message: null,
                    rawResponse: null,
                    latencyMs: timeoutMs,
                    metadata: { provider: this.providerName, model },
                    error: `Model inference exceeded timeout of ${timeoutMs}ms`
                };
            }

            if (this.forcedStatus === PROVIDER_STATUSES.AI_UNAVAILABLE) {
                span.setAttribute(FUSION_AI_ATTRIBUTES.STATUS, PROVIDER_STATUSES.AI_UNAVAILABLE);
                span.setAttribute(FUSION_AI_ATTRIBUTES.ERROR_TYPE, 'MODEL_UNAVAILABLE');
                telemetry.recordModelRequest(this.simulatedLatencyMs, {
                    provider: 'mock',
                    model,
                    success: false,
                    errorType: 'MODEL_UNAVAILABLE'
                });
                return {
                    status: PROVIDER_STATUSES.AI_UNAVAILABLE,
                    message: null,
                    rawResponse: null,
                    latencyMs: this.simulatedLatencyMs,
                    metadata: { provider: this.providerName, model },
                    error: 'Local Ollama instance unavailable'
                };
            }

            if (this.forcedStatus === PROVIDER_STATUSES.MODEL_RESPONSE_EMPTY) {
                span.setAttribute(FUSION_AI_ATTRIBUTES.STATUS, PROVIDER_STATUSES.MODEL_RESPONSE_EMPTY);
                telemetry.recordModelRequest(this.simulatedLatencyMs, {
                    provider: 'mock',
                    model,
                    success: true,
                    promptTokens: 50,
                    completionTokens: 0
                });
                return {
                    status: PROVIDER_STATUSES.MODEL_RESPONSE_EMPTY,
                    message: null,
                    rawResponse: null,
                    latencyMs: this.simulatedLatencyMs,
                    metadata: { provider: this.providerName, model, tokens: { prompt: 50, completion: 0 } },
                    error: 'Model returned an empty chat response'
                };
            }

            if (this.forcedStatus === PROVIDER_STATUSES.MODEL_OUTPUT_INVALID) {
                const malformed = typeof this.mockResponse === 'string' ? this.mockResponse : 'MALFORMED_JSON_STRING { "unclosed": ';
                span.setAttribute(FUSION_AI_ATTRIBUTES.STATUS, PROVIDER_STATUSES.SUCCESS);
                telemetry.recordModelRequest(this.simulatedLatencyMs, {
                    provider: 'mock',
                    model,
                    success: true,
                    promptTokens: 50,
                    completionTokens: 10
                });
                return {
                    status: PROVIDER_STATUSES.SUCCESS, // Provider transport succeeded, but content is invalid
                    message: {
                        role: 'assistant',
                        content: malformed
                    },
                    rawResponse: malformed,
                    latencyMs: this.simulatedLatencyMs,
                    metadata: { provider: this.providerName, model, tokens: { prompt: 50, completion: 10 } },
                    error: null
                };
            }

            if (this.forcedStatus === PROVIDER_STATUSES.MODEL_PROVIDER_ERROR) {
                span.setAttribute(FUSION_AI_ATTRIBUTES.STATUS, PROVIDER_STATUSES.MODEL_PROVIDER_ERROR);
                span.setAttribute(FUSION_AI_ATTRIBUTES.ERROR_TYPE, 'INTERNAL_ERROR');
                telemetry.recordModelRequest(this.simulatedLatencyMs, {
                    provider: 'mock',
                    model,
                    success: false,
                    errorType: 'INTERNAL_ERROR'
                });
                return {
                    status: PROVIDER_STATUSES.MODEL_PROVIDER_ERROR,
                    message: null,
                    rawResponse: null,
                    latencyMs: this.simulatedLatencyMs,
                    metadata: { provider: this.providerName, model },
                    error: 'Model provider backend error'
                };
            }

            // Check if a scripted response step exists
            if (this.mockChatResponses.length > 0) {
                const stepIdx = Math.min(this.chatStepIndex, this.mockChatResponses.length - 1);
                this.chatStepIndex++;
                const stepOutcome = this.mockChatResponses[stepIdx];

                if (stepOutcome.forcedStatus) {
                    span.setAttribute(FUSION_AI_ATTRIBUTES.STATUS, stepOutcome.forcedStatus);
                    span.setAttribute(FUSION_AI_ATTRIBUTES.ERROR_TYPE, stepOutcome.forcedStatus);
                    telemetry.recordModelRequest(this.simulatedLatencyMs, {
                        provider: 'mock',
                        model,
                        success: false,
                        errorType: stepOutcome.forcedStatus
                    });
                    return {
                        status: stepOutcome.forcedStatus,
                        message: null,
                        rawResponse: null,
                        latencyMs: this.simulatedLatencyMs,
                        metadata: { provider: this.providerName, model },
                        error: stepOutcome.error || `Forced status: ${stepOutcome.forcedStatus}`
                    };
                }

                const stepMessage = stepOutcome.message || stepOutcome;
                const tokens = stepOutcome.tokens || { prompt: 150, completion: 220 };
                span.setAttribute(GEN_AI_ATTRIBUTES.USAGE_INPUT_TOKENS, tokens.prompt || 0);
                span.setAttribute(GEN_AI_ATTRIBUTES.USAGE_OUTPUT_TOKENS, tokens.completion || 0);
                span.setAttribute(FUSION_AI_ATTRIBUTES.STATUS, PROVIDER_STATUSES.SUCCESS);

                telemetry.recordModelRequest(this.simulatedLatencyMs, {
                    provider: 'mock',
                    model,
                    success: true,
                    promptTokens: tokens.prompt || 0,
                    completionTokens: tokens.completion || 0
                });

                return {
                    status: PROVIDER_STATUSES.SUCCESS,
                    message: stepMessage,
                    rawResponse: { message: stepMessage },
                    latencyMs: this.simulatedLatencyMs,
                    metadata: {
                        provider: this.providerName,
                        model,
                        tokens
                    },
                    error: null
                };
            }

            // Fallback default message: check if messages have tool observation
            const hasToolResult = messages.some(m => m.role === 'tool');

            if (!hasToolResult && Array.isArray(tools) && tools.length > 0) {
                // If this.mockResponse has confirmed_findings citing a specific tool, select that tool!
                let selectedToolName = 'get_transaction_timeline';
                if (this.mockResponse && typeof this.mockResponse === 'object' && Array.isArray(this.mockResponse.confirmed_findings) && this.mockResponse.confirmed_findings[0]) {
                    const citedTool = (this.mockResponse.confirmed_findings[0].evidence_references || [])[0];
                    if (citedTool && tools.some(t => t.function.name === citedTool)) {
                        selectedToolName = citedTool;
                    }
                }

                // If query asks for documentation or knowledge lookup, select search_payment_knowledge
                const userMsg = messages.find(m => m.role === 'user');
                const userContent = (userMsg ? userMsg.content : '').toLowerCase();
                if (
                    (userContent.includes('knowledge') || userContent.includes('documentation') || userContent.includes('rag') || userContent.includes('docs:')) &&
                    tools.some(t => t.function.name === 'search_payment_knowledge')
                ) {
                    selectedToolName = 'search_payment_knowledge';
                }

                const firstTool = tools.find(t => t.function.name === selectedToolName) || tools[0];
                const toolArgs = selectedToolName === 'search_payment_knowledge'
                    ? { query: 'balance_insufficient' }
                    : {};

                const defaultCall = {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                        {
                            function: {
                                name: firstTool.function.name,
                                arguments: toolArgs
                            }
                        }
                    ]
                };
                span.setAttribute(FUSION_AI_ATTRIBUTES.STATUS, PROVIDER_STATUSES.SUCCESS);
                telemetry.recordModelRequest(this.simulatedLatencyMs, {
                    provider: 'mock',
                    model,
                    success: true,
                    promptTokens: 150,
                    completionTokens: 40
                });
                return {
                    status: PROVIDER_STATUSES.SUCCESS,
                    message: defaultCall,
                    rawResponse: { message: defaultCall },
                    latencyMs: this.simulatedLatencyMs,
                    metadata: { provider: this.providerName, model, tokens: { prompt: 150, completion: 40 } },
                    error: null
                };
            }

            // Step 2: Tool results present; produce final report
            const toolMsg = messages.find(m => m.role === 'tool');
            let executedToolName = toolMsg && toolMsg.tool_name ? toolMsg.tool_name : 'get_transaction_timeline';
            let retrievedChunkId = null;

            if (toolMsg && toolMsg.content) {
                try {
                    const jsonMatch = toolMsg.content.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const parsedContent = JSON.parse(jsonMatch[0]);
                        if (Array.isArray(parsedContent.retrieved_chunks) && parsedContent.retrieved_chunks[0]) {
                            executedToolName = 'search_payment_knowledge';
                            retrievedChunkId = parsedContent.retrieved_chunks[0].chunk_id;
                        }
                    }
                } catch {
                    /* ignore non-json tool message content */
                }
            }

            const finalReport = {
                summary: executedToolName === 'search_payment_knowledge'
                    ? 'Dynamic investigation successfully retrieved authoritative payment rail documentation.'
                    : 'Dynamic investigation successfully completed via tool observations.',
                status: 'COMPLETED',
                confirmed_findings: [
                    {
                        claim: executedToolName === 'search_payment_knowledge'
                            ? 'Authoritative payment documentation retrieved and validated against knowledge base.'
                            : 'Transaction state observed via retrieved evidence.',
                        evidence_references: [executedToolName],
                        source_field: executedToolName === 'search_payment_knowledge' && retrievedChunkId
                            ? retrievedChunkId
                            : `${executedToolName}.status`
                    }
                ],
                hypotheses: [],
                missing_information: [],
                recommended_checks: ['REVIEW_TRANSACTION_TIMELINE'],
                evidence_references: [executedToolName],
                limitations: ['Advisory decision support only. Dual approval required for operational actions.']
            };

            let responseReport = finalReport;
            if (this.mockResponse) {
                if (typeof this.mockResponse === 'string') {
                    responseReport = this.mockResponse;
                } else if (executedToolName === 'search_payment_knowledge') {
                    // When RAG search tool was executed, synthesize report citing search_payment_knowledge
                    responseReport = {
                        ...this.mockResponse,
                        confirmed_findings: [
                            {
                                claim: 'Authoritative payment documentation retrieved and validated against knowledge base.',
                                evidence_references: ['search_payment_knowledge'],
                                source_field: retrievedChunkId || 'searchPaymentKnowledge.retrieved_chunks'
                            }
                        ],
                        evidence_references: ['search_payment_knowledge']
                    };
                } else {
                    responseReport = this.mockResponse;
                }
            }

            const finalMsg = {
                role: 'assistant',
                content: typeof responseReport === 'string'
                    ? responseReport
                    : JSON.stringify(responseReport)
            };

            span.setAttribute(GEN_AI_ATTRIBUTES.USAGE_INPUT_TOKENS, 280);
            span.setAttribute(GEN_AI_ATTRIBUTES.USAGE_OUTPUT_TOKENS, 150);
            span.setAttribute(FUSION_AI_ATTRIBUTES.STATUS, PROVIDER_STATUSES.SUCCESS);
            telemetry.recordModelRequest(this.simulatedLatencyMs, {
                provider: 'mock',
                model,
                success: true,
                promptTokens: 280,
                completionTokens: 150
            });

            return {
                status: PROVIDER_STATUSES.SUCCESS,
                message: finalMsg,
                rawResponse: { message: finalMsg },
                latencyMs: this.simulatedLatencyMs,
                metadata: { provider: this.providerName, model, tokens: { prompt: 280, completion: 150 } },
                error: null
            };
        });
    }
}

module.exports = {
    MockModelProvider,
};
