'use strict';

const { BaseModelProvider, PROVIDER_STATUSES } = require('../../core/ai/providers/baseProvider');
const { MockModelProvider } = require('../../core/ai/providers/mockModelProvider');
const { OllamaProvider } = require('../../core/ai/providers/ollamaProvider');
const { createModelProvider } = require('../../core/ai/providers');

describe('AI Model Providers Unit Tests', () => {
    describe('BaseModelProvider', () => {
        test('instantiates with default name and exposes PROVIDER_STATUSES', () => {
            const provider = new BaseModelProvider();
            expect(provider.providerName).toBe('base');
            expect(PROVIDER_STATUSES.SUCCESS).toBe('SUCCESS');
            expect(PROVIDER_STATUSES.AI_UNAVAILABLE).toBe('AI_UNAVAILABLE');
            expect(PROVIDER_STATUSES.MODEL_TIMEOUT).toBe('MODEL_TIMEOUT');
            expect(PROVIDER_STATUSES.MODEL_OUTPUT_INVALID).toBe('MODEL_OUTPUT_INVALID');
        });

        test('throws error if abstract generate() or ping() called directly', async () => {
            const provider = new BaseModelProvider();
            await expect(provider.generate({})).rejects.toThrow('BaseModelProvider.generate() must be implemented by subclass');
            await expect(provider.ping()).rejects.toThrow('BaseModelProvider.ping() must be implemented by subclass');
        });

        test('isAvailable returns false if ping() throws', async () => {
            const provider = new BaseModelProvider();
            const available = await provider.isAvailable();
            expect(available).toBe(false);
        });
    });

    describe('OllamaProvider Host Security and Validation', () => {
        test('accepts valid loopback host http://127.0.0.1:11434', () => {
            const provider = new OllamaProvider({ host: 'http://127.0.0.1:11434' });
            expect(provider.host).toBe('http://127.0.0.1:11434');
        });

        test('accepts valid localhost with custom port http://localhost:11434', () => {
            const provider = new OllamaProvider({ host: 'http://localhost:11434' });
            expect(provider.host).toBe('http://localhost:11434');
        });

        test('rejects external or non-loopback host names', () => {
            expect(() => new OllamaProvider({ host: 'http://api.openai.com/v1' }))
                .toThrow(/Only approved local loopback/);
            expect(() => new OllamaProvider({ host: 'http://192.168.1.100:11434' }))
                .toThrow(/Only approved local loopback/);
            expect(() => new OllamaProvider({ host: 'http://evil-server.com' }))
                .toThrow(/Only approved local loopback/);
        });

        test('rejects invalid URL string', () => {
            expect(() => new OllamaProvider({ host: 'not-a-valid-url' }))
                .toThrow(/Only approved local loopback/);
        });

        test('rejects non-http / non-https protocols', () => {
            expect(() => new OllamaProvider({ host: 'ftp://127.0.0.1:11434' }))
                .toThrow(/Only approved local loopback/);
        });

        test('defaults to llama3.1:latest as documented development model', () => {
            const provider = new OllamaProvider();
            expect(provider.defaultModel).toBe('llama3.1:latest');
        });

        test('allows explicit model configuration via constructor options', () => {
            const provider = new OllamaProvider({ defaultModel: 'custom-model:v1' });
            expect(provider.defaultModel).toBe('custom-model:v1');
        });

        test('authoritative timeout defaults to 30000ms with justified 2x safety margin', () => {
            const provider = new OllamaProvider();
            expect(provider.timeoutMs).toBe(30000);

            const customProvider = new OllamaProvider({ timeoutMs: 45000 });
            expect(customProvider.timeoutMs).toBe(45000);
        });

        test('ping returns AI_UNAVAILABLE when configured model is not installed', async () => {
            const provider = new OllamaProvider({ defaultModel: 'missing-model-xyz' });
            provider.client = {
                list: jest.fn().mockResolvedValue({
                    models: [{ name: 'llama3.1:latest' }]
                })
            };

            const pingRes = await provider.ping();
            expect(pingRes.available).toBe(false);
            expect(pingRes.status).toBe(PROVIDER_STATUSES.AI_UNAVAILABLE);
            expect(pingRes.error).toContain('is not installed in local Ollama daemon');
        });

        test('generate returns AI_UNAVAILABLE when model is not found in daemon', async () => {
            const provider = new OllamaProvider({ defaultModel: 'uninstalled-model' });
            provider.client = {
                chat: jest.fn().mockRejectedValue(new Error('model "uninstalled-model" not found, try pulling it first'))
            };

            const res = await provider.generate({
                systemInstruction: 'sys',
                evidenceContext: {},
                investigationQuestion: 'test'
            });

            expect(res.status).toBe(PROVIDER_STATUSES.AI_UNAVAILABLE);
            expect(res.error).toContain('not installed in local Ollama daemon. Missing prerequisite.');
        });
    });

    describe('MockModelProvider', () => {
        test('generates valid success completion with default mock report', async () => {
            const mock = new MockModelProvider({ simulatedLatencyMs: 5 });
            const res = await mock.generate({
                model: 'test-model',
                systemInstruction: 'Test system',
                evidenceContext: {},
                investigationQuestion: 'What happened?'
            });

            expect(res.status).toBe(PROVIDER_STATUSES.SUCCESS);
            expect(res.error).toBeNull();
            expect(res.parsedResponse).toBeDefined();
            expect(res.parsedResponse.summary).toContain('Investigation completed');
            expect(res.metadata.provider).toBe('mock');
            expect(mock.invocationHistory.length).toBe(1);
        });

        test('returns MODEL_TIMEOUT when forcedStatus is MODEL_TIMEOUT', async () => {
            const mock = new MockModelProvider();
            mock.setForcedStatus(PROVIDER_STATUSES.MODEL_TIMEOUT);
            const res = await mock.generate({ timeoutMs: 1000 });

            expect(res.status).toBe(PROVIDER_STATUSES.MODEL_TIMEOUT);
            expect(res.error).toContain('exceeded timeout');
            expect(res.parsedResponse).toBeNull();
        });

        test('returns MODEL_TIMEOUT when simulated latency exceeds timeoutMs', async () => {
            const mock = new MockModelProvider({ simulatedLatencyMs: 500 });
            const res = await mock.generate({ timeoutMs: 100 });

            expect(res.status).toBe(PROVIDER_STATUSES.MODEL_TIMEOUT);
            expect(res.error).toContain('exceeded timeout of 100ms');
        });

        test('returns AI_UNAVAILABLE when forcedStatus is AI_UNAVAILABLE', async () => {
            const mock = new MockModelProvider();
            mock.setForcedStatus(PROVIDER_STATUSES.AI_UNAVAILABLE);
            const res = await mock.generate({});

            expect(res.status).toBe(PROVIDER_STATUSES.AI_UNAVAILABLE);
            expect(res.error).toContain('unavailable');
            expect(res.parsedResponse).toBeNull();
        });

        test('returns MODEL_OUTPUT_INVALID when response is malformed JSON', async () => {
            const mock = new MockModelProvider();
            mock.setMockOutcome(PROVIDER_STATUSES.MODEL_OUTPUT_INVALID, '{ broken json: true ');
            const res = await mock.generate({});

            expect(res.status).toBe(PROVIDER_STATUSES.MODEL_OUTPUT_INVALID);
            expect(res.error).toContain('not valid JSON');
            expect(res.parsedResponse).toBeNull();
        });

        test('returns MODEL_RESPONSE_EMPTY when forcedStatus is MODEL_RESPONSE_EMPTY', async () => {
            const mock = new MockModelProvider();
            mock.setForcedStatus(PROVIDER_STATUSES.MODEL_RESPONSE_EMPTY);
            const res = await mock.generate({});

            expect(res.status).toBe(PROVIDER_STATUSES.MODEL_RESPONSE_EMPTY);
            expect(res.error).toContain('empty response');
        });

        test('returns MODEL_PROVIDER_ERROR when forcedStatus is MODEL_PROVIDER_ERROR', async () => {
            const mock = new MockModelProvider();
            mock.setForcedStatus(PROVIDER_STATUSES.MODEL_PROVIDER_ERROR);
            const res = await mock.generate({});

            expect(res.status).toBe(PROVIDER_STATUSES.MODEL_PROVIDER_ERROR);
            expect(res.error).toContain('crash in model provider');
        });

        test('ping reports availability state correctly', async () => {
            const mock = new MockModelProvider();
            const availablePing = await mock.ping();
            expect(availablePing.available).toBe(true);
            expect(await mock.isAvailable()).toBe(true);

            mock.setForcedStatus(PROVIDER_STATUSES.AI_UNAVAILABLE);
            const unavailablePing = await mock.ping();
            expect(unavailablePing.available).toBe(false);
            expect(await mock.isAvailable()).toBe(false);
        });

        test('records invocation history with accurate parameters', async () => {
            const mock = new MockModelProvider();
            await mock.generate({
                model: 'model-a',
                investigationQuestion: 'Question A'
            });
            await mock.generate({
                model: 'model-b',
                investigationQuestion: 'Question B'
            });

            expect(mock.invocationHistory.length).toBe(2);
            expect(mock.invocationHistory[0].model).toBe('model-a');
            expect(mock.invocationHistory[1].investigationQuestion).toBe('Question B');
        });
    });

    describe('createModelProvider Factory', () => {
        test('creates MockModelProvider when type is mock', () => {
            const p = createModelProvider('mock');
            expect(p).toBeInstanceOf(MockModelProvider);
        });

        test('creates OllamaProvider when type is ollama', () => {
            const p = createModelProvider('ollama', { host: 'http://127.0.0.1:11434' });
            expect(p).toBeInstanceOf(OllamaProvider);
        });

        test('throws error when type is unknown or invalid', () => {
            expect(() => createModelProvider('unsupported-type'))
                .toThrow(/Unsupported model provider type/);
        });
    });
});
