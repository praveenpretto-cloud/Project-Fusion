'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * AI OBSERVABILITY TEST SUITE — PHASE AI-3.4
 * ════════════════════════════════════════════════════════════════════════════
 */

const {
    telemetry,
    TelemetryService,
    SEMCONV_VERSION,
    GEN_AI_ATTRIBUTES,
    FUSION_AI_ATTRIBUTES,
    SPAN_NAMES,
    METRIC_NAMES,
    classifyError,
    ERROR_CLASSIFICATIONS,
    isLoopbackEndpoint,
} = require('../../core/ai/observability');
const { AgentLoop } = require('../../core/ai/orchestrator/agentLoop');
const { ToolRegistry } = require('../../core/ai/tools/toolRegistry');
const { MockModelProvider } = require('../../core/ai/providers/mockModelProvider');
const { MockEmbeddingProvider } = require('../../core/ai/rag/retrieval/embeddingProvider');
const { BM25Retriever } = require('../../core/ai/rag/retrieval/bm25Retriever');
const { DenseRetriever } = require('../../core/ai/rag/retrieval/denseRetriever');
const { HybridRanker } = require('../../core/ai/rag/retrieval/hybridRanker');
const { EvidenceCitationValidator } = require('../../core/ai/validators/evidenceCitationValidator');
const { createDlpContext } = require('../../core/ai/security/dlpMasker');
const { syntheticStore } = require('../../core/ai/synthetic/syntheticStore');

describe('AI-3.4: AI Observability, Tracing & Performance Telemetry', () => {
    beforeEach(() => {
        telemetry.reset();
    });

    test('1. OpenTelemetry SDK and tracer initializes correctly with local exporter', () => {
        expect(telemetry.initialized).toBe(true);
        expect(telemetry.getTracer()).toBeDefined();
        expect(SEMCONV_VERSION).toBe('1.28.0');
    });

    test('2. Root span creation and execution tracking', async () => {
        await telemetry.withSpan(SPAN_NAMES.INVESTIGATION_HTTP_REQUEST, async (span) => {
            span.setAttribute(FUSION_AI_ATTRIBUTES.CASE_ID, 'CASE-01');
            span.setAttribute(FUSION_AI_ATTRIBUTES.INTENT, 'FAILURE_INVESTIGATION');
        });

        const spans = telemetry.localExporter.getFinishedSpans();
        expect(spans.length).toBe(1);
        expect(spans[0].name).toBe(SPAN_NAMES.INVESTIGATION_HTTP_REQUEST);
        expect(spans[0].attributes[FUSION_AI_ATTRIBUTES.CASE_ID]).toBe('CASE-01');
        expect(spans[0].attributes[FUSION_AI_ATTRIBUTES.INTENT]).toBe('FAILURE_INVESTIGATION');
    });

    test('3. Child span parentage and context propagation across async boundaries', async () => {
        await telemetry.withSpan('parent-root', async (pSpan) => {
            await telemetry.withSpan('child-operation', async (cSpan) => {
                cSpan.setAttribute('test.step', 'child');
            });
        });

        const spans = telemetry.localExporter.getFinishedSpans();
        expect(spans.length).toBe(2);
        const child = spans.find(s => s.name === 'child-operation');
        const parent = spans.find(s => s.name === 'parent-root');
        expect(child.parentSpanId).toBe(parent.spanContext().spanId);
        expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
    });

    test('4. Model inference span captures GenAI semantic conventions', async () => {
        const mockProvider = new MockModelProvider({ simulatedLatencyMs: 5 });
        mockProvider.setMockOutcome('SUCCESS', { test: 'response' });

        await mockProvider.chat({
            model: 'mock-llama-3.2',
            messages: [{ role: 'user', content: 'test question' }],
            generationConfig: { temperature: 0.1, maxTokens: 1024 }
        });

        const spans = telemetry.localExporter.getFinishedSpans();
        const modelSpan = spans.find(s => s.name === SPAN_NAMES.LLM_INFERENCE);
        expect(modelSpan).toBeDefined();
        expect(modelSpan.attributes[GEN_AI_ATTRIBUTES.SYSTEM]).toBe('mock');
        expect(modelSpan.attributes[GEN_AI_ATTRIBUTES.REQUEST_MODEL]).toBe('mock-llama-3.2');
        expect(modelSpan.attributes[GEN_AI_ATTRIBUTES.OPERATION_NAME]).toBe('chat');
        expect(modelSpan.attributes[GEN_AI_ATTRIBUTES.USAGE_INPUT_TOKENS]).toBeGreaterThan(0);
        expect(modelSpan.attributes[GEN_AI_ATTRIBUTES.USAGE_OUTPUT_TOKENS]).toBeGreaterThan(0);
    });

    test('5. Tool execution span records name, status, and size without leaking sensitive args', async () => {
        const registry = new ToolRegistry();
        const syntheticCase = syntheticStore.getCaseById('CASE-01');

        await registry.executeTool('get_transaction_timeline', {}, syntheticCase);

        const spans = telemetry.localExporter.getFinishedSpans();
        const toolSpan = spans.find(s => s.name === SPAN_NAMES.TOOL_EXECUTION);
        expect(toolSpan).toBeDefined();
        expect(toolSpan.attributes[FUSION_AI_ATTRIBUTES.TOOL_NAME]).toBe('get_transaction_timeline');
        expect(toolSpan.attributes[FUSION_AI_ATTRIBUTES.TOOL_STATUS]).toBeDefined();
        expect(toolSpan.attributes[FUSION_AI_ATTRIBUTES.TOOL_RESULT_BYTES]).toBeGreaterThan(0);
        // Sensitive data must never be an attribute
        expect(toolSpan.attributes.arguments).toBeUndefined();
        expect(toolSpan.attributes.content).toBeUndefined();
    });

    test('6. RAG retrieval, BM25, and dense search spans record query metrics without raw query text', async () => {
        const embedProvider = new MockEmbeddingProvider();
        const chunks = [
            { chunk_id: 'c1', content: 'Stripe balance_insufficient error guide', provider: 'STRIPE', error_codes: ['balance_insufficient'] }
        ];
        const bm25 = new BM25Retriever(chunks);
        const vectorTable = new Map();
        vectorTable.set('c1', await embedProvider.getEmbedding(chunks[0].content));
        const dense = new DenseRetriever({ chunks, vectorTable, embeddingProvider: embedProvider });
        const ranker = new HybridRanker({ bm25Retriever: bm25, denseRetriever: dense });

        await ranker.search('balance_insufficient', { provider: 'STRIPE' });

        const spans = telemetry.localExporter.getFinishedSpans();
        const ragSpan = spans.find(s => s.name === SPAN_NAMES.RAG_RETRIEVAL);
        const bm25Span = spans.find(s => s.name === SPAN_NAMES.RAG_BM25_SEARCH);
        const denseSpan = spans.find(s => s.name === SPAN_NAMES.RAG_DENSE_SEARCH);

        expect(ragSpan).toBeDefined();
        expect(bm25Span).toBeDefined();
        expect(denseSpan).toBeDefined();

        expect(ragSpan.attributes[FUSION_AI_ATTRIBUTES.RAG_PROVIDER]).toBe('STRIPE');
        expect(ragSpan.attributes[FUSION_AI_ATTRIBUTES.RAG_RETURNED_CHUNKS]).toBe(1);
        expect(ragSpan.attributes.query).toBeUndefined(); // Raw query strictly excluded
    });

    test('7. Embedding generation spans track model and dimension', async () => {
        const provider = new MockEmbeddingProvider({ dimension: 384, modelName: 'test-embed-384' });
        await provider.getEmbedding('sample text');

        const spans = telemetry.localExporter.getFinishedSpans();
        const embedSpan = spans.find(s => s.name === SPAN_NAMES.RAG_EMBEDDING);
        expect(embedSpan).toBeDefined();
        expect(embedSpan.attributes[FUSION_AI_ATTRIBUTES.RAG_EMBEDDING_MODEL]).toBe('test-embed-384');
        expect(embedSpan.attributes[FUSION_AI_ATTRIBUTES.RAG_EMBEDDING_DIMENSION]).toBe(384);
    });

    test('8. Citation validation span records verification outcome and violations', () => {
        const report = {
            investigation_id: 'INV-1',
            transaction_id: 'TX-1',
            intent: 'FAILURE_INVESTIGATION',
            status: 'COMPLETED',
            summary: 'Summary test',
            confirmed_findings: [],
            hypotheses: [],
            missing_information: [],
            recommended_checks: ['VERIFY_PROVIDER_STATUS'],
            evidence_references: [],
            limitations: ['test'],
            model_metadata: {
                provider: 'mock',
                model: 'mock-model',
                latency_ms: 10
            }
        };

        const res = EvidenceCitationValidator.validate({ report, availableEvidenceKeys: [] });
        expect(res.valid).toBe(true);

        const spans = telemetry.localExporter.getFinishedSpans();
        const valSpan = spans.find(s => s.name === SPAN_NAMES.EVIDENCE_CITATION_VALIDATION);
        expect(valSpan).toBeDefined();
        expect(valSpan.attributes[FUSION_AI_ATTRIBUTES.VALIDATION_PASSED]).toBe(true);
        expect(valSpan.attributes[FUSION_AI_ATTRIBUTES.VALIDATION_VIOLATION_COUNT]).toBe(0);
    });

    test('9. DLP redaction triggers categorical metrics increment', () => {
        const dlp = createDlpContext();
        dlp.maskText('Contact customer Siddharth Patel at test@example.com');

        const summary = telemetry.getMetricsSummary();
        expect(summary.dlp.redactions).toBeGreaterThanOrEqual(1);
    });

    test('10. Metrics aggregator records latency histograms and percentiles', () => {
        telemetry.metrics.recordHistogram(METRIC_NAMES.INVESTIGATION_DURATION, 100);
        telemetry.metrics.recordHistogram(METRIC_NAMES.INVESTIGATION_DURATION, 200);
        telemetry.metrics.recordHistogram(METRIC_NAMES.INVESTIGATION_DURATION, 300);

        const stats = telemetry.metrics.getStats(METRIC_NAMES.INVESTIGATION_DURATION);
        expect(stats.count).toBe(3);
        expect(stats.min).toBe(100);
        expect(stats.max).toBe(300);
        expect(stats.median).toBe(200);
    });

    test('11. Safe exception classification sanitizes error messages', () => {
        expect(classifyError(new Error('Model timeout after 30000ms'))).toBe(ERROR_CLASSIFICATIONS.MODEL_TIMEOUT);
        expect(classifyError(new Error('connect ECONNREFUSED 127.0.0.1:11434'))).toBe(ERROR_CLASSIFICATIONS.MODEL_UNAVAILABLE);
        expect(classifyError(new Error('Embedding dimension mismatch'))).toBe(ERROR_CLASSIFICATIONS.EMBEDDING_DIMENSION_MISMATCH);
        expect(classifyError(new Error('Prohibited financial mutation requested'))).toBe(ERROR_CLASSIFICATIONS.PROHIBITED_MUTATION_REFUSAL);
    });

    test('12. Loopback exporter guard rejects non-local addresses', () => {
        expect(isLoopbackEndpoint('http://127.0.0.1:4318/v1/traces')).toBe(true);
        expect(isLoopbackEndpoint('http://localhost:4318/v1/traces')).toBe(true);
        expect(isLoopbackEndpoint('http://api.honeycomb.io/v1/traces')).toBe(false);
        expect(isLoopbackEndpoint('https://datadog.com')).toBe(false);
    });

    test('13. Attribute sanitizer strips PII, tokens, and prompt bodies', () => {
        const sanitized = telemetry.sanitizeAttributes({
            'gen_ai.request.model': 'llama3.1:latest',
            'prompt': 'SECRET SYSTEM INSTRUCTION WITH SENSITIVE DATA',
            'user.email': 'customer@bank.com',
            'customer_name': 'John Doe',
            'account_number': '123456789',
            'fusion.ai.case_id': 'CASE-01'
        });

        expect(sanitized['gen_ai.request.model']).toBe('llama3.1:latest');
        expect(sanitized['fusion.ai.case_id']).toBe('CASE-01');
        expect(sanitized.prompt).toBeUndefined();
        expect(sanitized['user.email']).toBeUndefined();
        expect(sanitized.customer_name).toBeUndefined();
        expect(sanitized.account_number).toBeUndefined();
    });

    test('13b. Negative security assertion: sensitive LLM, PII, and raw argument keys are strictly excluded from span serialization', () => {
        const sensitiveInput = {
            'messages': [{ role: 'user', content: 'Transfer $50,000 to card 4111222233334444' }],
            'prompt_tokens_raw': 'System instruction...',
            'completion_text': 'Confirmed transfer',
            'tool.arguments': { account: '12345', pin: '9999' },
            'raw_exception': 'Database password postgres_secret failed',
            'customer.pan': 'ABCDE1234F',
            'customer.iban': 'GB82WEST12345698765432',
            'api_secret_key': 'fusion_bank_secret_key_2025',
            'gen_ai.system': 'mock',
            'fusion.ai.case_id': 'CASE-01',
            'fusion.ai.tool.name': 'get_transaction_timeline'
        };

        const sanitized = telemetry.sanitizeAttributes(sensitiveInput);

        // Positive allowlisted keys
        expect(sanitized['gen_ai.system']).toBe('mock');
        expect(sanitized['fusion.ai.case_id']).toBe('CASE-01');
        expect(sanitized['fusion.ai.tool.name']).toBe('get_transaction_timeline');

        // Negative assertions: all sensitive keys strictly undefined
        expect(sanitized.messages).toBeUndefined();
        expect(sanitized.prompt_tokens_raw).toBeUndefined();
        expect(sanitized.completion_text).toBeUndefined();
        expect(sanitized['tool.arguments']).toBeUndefined();
        expect(sanitized.raw_exception).toBeUndefined();
        expect(sanitized['customer.pan']).toBeUndefined();
        expect(sanitized['customer.iban']).toBeUndefined();
        expect(sanitized.api_secret_key).toBeUndefined();
    });

    test('14. Full agent investigation trace produces connected parent-child hierarchy', async () => {
        const c = syntheticStore.getCaseById('CASE-01');
        const mockProvider = new MockModelProvider();
        mockProvider.setMockChatResponses([
            {
                role: 'assistant',
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_transaction_timeline', arguments: {} }
                }]
            },
            {
                role: 'assistant',
                content: JSON.stringify({
                    investigation_id: 'INV-TEST-001',
                    transaction_id: c.transactionId,
                    intent: c.intent,
                    status: 'COMPLETED',
                    summary: 'Completed successfully.',
                    confirmed_findings: [{
                        claim: 'Recorded status.',
                        evidence_references: ['get_transaction_timeline'],
                        source_field: 'getTransactionTimeline.status'
                    }],
                    hypotheses: [],
                    missing_information: [],
                    recommended_checks: ['VERIFY_PROVIDER_STATUS'],
                    evidence_references: ['get_transaction_timeline'],
                    limitations: ['Synthetic test']
                })
            }
        ]);

        const loop = new AgentLoop({
            toolRegistry: new ToolRegistry(),
            modelProvider: mockProvider
        });

        await loop.run({ syntheticCase: c });

        const spans = telemetry.localExporter.getFinishedSpans();
        const root = spans.find(s => s.name === SPAN_NAMES.AGENT_ORCHESTRATION);
        expect(root).toBeDefined();

        const children = spans.filter(s => s !== root);
        expect(children.length).toBeGreaterThan(0);
        children.forEach(child => {
            expect(child.parentSpanId).toBe(root.spanContext().spanId);
            expect(child.spanContext().traceId).toBe(root.spanContext().traceId);
        });
    });

    test('15. Repeated tool calls increment agent metrics counter', async () => {
        const c = syntheticStore.getCaseById('CASE-01');
        const mockProvider = new MockModelProvider();
        mockProvider.setMockChatResponses([
            {
                role: 'assistant',
                tool_calls: [{
                    id: 'c1',
                    type: 'function',
                    function: { name: 'get_transaction_timeline', arguments: {} }
                }]
            },
            {
                role: 'assistant',
                tool_calls: [{
                    id: 'c2',
                    type: 'function',
                    function: { name: 'get_transaction_timeline', arguments: {} } // identical repeated call
                }]
            },
            {
                role: 'assistant',
                content: JSON.stringify({
                    summary: 'Done',
                    status: 'COMPLETED',
                    confirmed_findings: [],
                    hypotheses: [],
                    missing_information: [],
                    recommended_checks: ['VERIFY_PROVIDER_STATUS'],
                    evidence_references: ['get_transaction_timeline'],
                    limitations: []
                })
            }
        ]);

        const loop = new AgentLoop({
            toolRegistry: new ToolRegistry(),
            modelProvider: mockProvider
        });

        await loop.run({ syntheticCase: c });

        const summary = telemetry.getMetricsSummary();
        expect(summary.agent.repeated_tool_calls).toBe(1);
    });

    test('16. Tool execution fails closed when tool lacks validateArgs', async () => {
        const c = syntheticStore.getCaseById('CASE-01');
        const reg = new ToolRegistry();
        reg.registerTool({
            name: 'unsafe_custom_tool',
            description: 'Unsafe tool without validator',
            execute: async () => ({ success: true })
        });

        const res = await reg.executeTool('unsafe_custom_tool', {}, c);
        expect(res.success).toBe(false);
        expect(res.status).toBe('MISSING_VALIDATOR');
        expect(res.error).toBe('MISSING_VALIDATOR');
        expect(res.message).toContain('has no validateArgs function');
    });

    test('17. Tool execution validates arguments and rejects malformed inputs', async () => {
        const c = syntheticStore.getCaseById('CASE-01');
        const reg = new ToolRegistry();
        const res = await reg.executeTool('get_transaction_timeline', { format: 'invalid_format' }, c);
        expect(res.success).toBe(false);
        expect(res.status).toBe('INVALID_ARGUMENTS');
        expect(res.error).toBe('INVALID_ARGUMENTS');
        expect(res.message).toContain('Invalid format');
    });

    test('18. Observability metrics aggregator formats summary with low-cardinality keys', () => {
        const summary = telemetry.getMetricsSummary();
        expect(summary.investigations).toBeDefined();
        expect(summary.models).toBeDefined();
        expect(summary.rag).toBeDefined();
        expect(summary.agent).toBeDefined();
        expect(summary.dlp).toBeDefined();
        
        // Assert no raw transaction IDs or customer names in metrics labels
        const serialized = JSON.stringify(summary);
        expect(serialized).not.toContain('TX-');
        expect(serialized).not.toContain('Alice Smith');
    });
});
