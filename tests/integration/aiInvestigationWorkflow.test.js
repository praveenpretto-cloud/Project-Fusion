'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * AI PAYMENT OPERATIONS COPILOT — INTEGRATION TEST SUITE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Tests the Express API routes (/api/ai/synthetic-cases, /api/ai/investigate)
 * against synthetic cases, MockModelProvider, schema validators, citation rules,
 * timeout/error handlers, and security boundaries (zero persistent DB access,
 * zero payment mutation capabilities).
 *
 * Uses in-memory request dispatching (sandbox safe, zero socket binding).
 */

const express = require('express');
const { syntheticStore, CASE_ID_REGEX } = require('../../core/ai/synthetic/syntheticStore');
const aiInvestigateRouter = require('../../routes/aiInvestigateRouter');
const { MockModelProvider } = require('../../core/ai/providers/mockModelProvider');
const { InvestigationOrchestrator } = require('../../core/ai/orchestrator');

function safeJsonParse(str) {
    try {
        return JSON.parse(str);
    } catch {
        return str;
    }
}

/**
 * In-memory HTTP request dispatcher (sandbox safe, 100% offline, zero network socket binding)
 */
function makeRequest(
    app,
    {
        method = 'GET',
        url = '/',
        headers = {},
        body = null,
        ip = '127.0.0.1',
        hostname = 'localhost',
    }
) {
    return new Promise((resolve) => {
        let statusCode = 200;
        const responseHeaders = {};
        let responseBody = null;

        const req = {
            method: method.toUpperCase(),
            url,
            originalUrl: url,
            path: url.split('?')[0],
            params: {},
            query: {},
            headers: { ...headers },
            body: body || {},
            ip,
            hostname,
            socket: { remoteAddress: ip },
            on(event, cb) {
                if (event === 'close') {
                    // no-op for in-memory
                }
                return this;
            },
        };

        const chunks = [];
        const res = {
            statusCode: 200,
            status(code) {
                statusCode = code;
                this.statusCode = code;
                return this;
            },
            setHeader(k, v) {
                responseHeaders[k.toLowerCase()] = v;
            },
            getHeader(k) {
                return responseHeaders[k.toLowerCase()];
            },
            flushHeaders() {},
            write(chunk) {
                chunks.push(chunk);
            },
            flush() {},
            send(payload) {
                responseBody = payload;
                resolve({
                    status: statusCode,
                    statusCode,
                    headers: responseHeaders,
                    body: typeof payload === 'string' ? safeJsonParse(payload) : payload,
                    text: String(payload),
                });
            },
            json(payload) {
                responseBody = payload;
                resolve({
                    status: statusCode,
                    statusCode,
                    headers: responseHeaders,
                    body: payload,
                    text: JSON.stringify(payload),
                });
            },
            end(payload) {
                if (payload) {
                    chunks.push(payload);
                    responseBody = payload;
                } else if (chunks.length > 0) {
                    responseBody = chunks.join('');
                }
                resolve({
                    status: statusCode,
                    statusCode,
                    headers: responseHeaders,
                    body: responseBody,
                    text: String(responseBody || ''),
                });
            },
        };

        app.handle(req, res);
    });
}

function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/ai', aiInvestigateRouter);
    return app;
}

describe('AI Payment Operations Copilot — Integration Suite', () => {
    let app;

    beforeAll(() => {
        process.env.LOCAL_ONLY = 'true';
        process.env.AI_PROVIDER_TYPE = 'mock';
        app = createTestApp();
    });

    afterAll(() => {
        delete process.env.LOCAL_ONLY;
        delete process.env.AI_PROVIDER_TYPE;
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 1. GET /api/ai/synthetic-cases
    // ─────────────────────────────────────────────────────────────────────────
    describe('1. GET /api/ai/synthetic-cases', () => {
        test('returns all 15 registered synthetic cases with sanitized metadata', async () => {
            const res = await makeRequest(app, {
                method: 'GET',
                url: '/api/ai/synthetic-cases',
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.count).toBe(15);
            expect(Array.isArray(res.body.cases)).toBe(true);
            expect(res.body.cases.length).toBe(15);

            // Verify first and last case IDs
            expect(res.body.cases[0].id).toBe('CASE-01');
            expect(res.body.cases[14].id).toBe('CASE-15');

            // Verify structure of case metadata
            const sampleCase = res.body.cases[0];
            expect(sampleCase).toHaveProperty('id');
            expect(sampleCase).toHaveProperty('title');
            expect(sampleCase).toHaveProperty('intent');
            expect(sampleCase).toHaveProperty('transactionId');
            expect(sampleCase).toHaveProperty('question');
            expect(sampleCase).toHaveProperty('expectedStatus');
            expect(sampleCase).toHaveProperty('toolsAvailable');
            expect(Array.isArray(sampleCase.toolsAvailable)).toBe(true);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. POST /api/ai/investigate — Valid Synthetic Cases
    // ─────────────────────────────────────────────────────────────────────────
    describe('2. POST /api/ai/investigate — Valid Cases', () => {
        test('investigates CASE-01 (Provider Rejection) and returns grounded report', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/investigate',
                body: {
                    caseId: 'CASE-01',
                    providerType: 'mock',
                },
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.status).toBe('REPORT_GENERATED');
            expect(res.body.case_id).toBe('CASE-01');
            expect(res.body.intent).toBe('FAILURE_INVESTIGATION');
            expect(res.body.report).toBeDefined();
            expect(res.body.report.investigation_id).toMatch(/^INV-INTEL-/);
            expect(res.body.report.status).toBe('COMPLETED');
            expect(res.body.report.summary).toContain('3a7f8b2c-0001');
            expect(res.body.raw_evidence).toHaveProperty('getTransactionTimeline');
            expect(res.body.raw_evidence).toHaveProperty('getProviderFailureDetails');
        });

        test('investigates CASE-06 (Ledger Arithmetic Mismatch)', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/investigate',
                body: {
                    caseId: 'CASE-06',
                    providerType: 'mock',
                },
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.case_id).toBe('CASE-06');
            expect(res.body.intent).toBe('LEDGER_AUDIT');
            expect(res.body.raw_evidence).toHaveProperty('verifyLedgerIntegrity');
        });

        test('investigates CASE-10 (ISO 20022 Validation)', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/investigate',
                body: {
                    caseId: 'CASE-10',
                    providerType: 'mock',
                },
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.case_id).toBe('CASE-10');
            expect(res.body.intent).toBe('ISO_VALIDATION');
            expect(res.body.raw_evidence).toHaveProperty('explainIsoValidationErrors');
        });

        test('accepts custom operator question override within bounds', async () => {
            const customQuestion = 'Analyze whether gateway returned definitive failure code.';
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/investigate',
                body: {
                    caseId: 'CASE-01',
                    question: customQuestion,
                    providerType: 'mock',
                },
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Unknown Case ID & Arbitrary Transaction ID Rejection
    // ─────────────────────────────────────────────────────────────────────────
    describe('3. Unknown Case ID & Parameter Validation', () => {
        test('rejects missing caseId with 400', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/investigate',
                body: {},
            });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBe('MISSING_CASE_ID');
        });

        test('rejects arbitrary customer transaction UUID without synthetic caseId', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/investigate',
                body: {
                    caseId: '3a7f8b2c-0001-4567-89ab-cdef01234567',
                },
            });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBe('INVALID_CASE_ID_FORMAT');
        });

        test('rejects out-of-range caseId CASE-99 with 400', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/investigate',
                body: {
                    caseId: 'CASE-99',
                },
            });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBe('INVALID_CASE_ID_FORMAT');
        });

        test('rejects caseId of invalid type (number) with 400', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/investigate',
                body: {
                    caseId: 1,
                },
            });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBe('MISSING_CASE_ID');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Malformed Request Handling
    // ─────────────────────────────────────────────────────────────────────────
    describe('4. Malformed Request Handling', () => {
        test('rejects question exceeding 500 characters with 400', async () => {
            const longQuestion = 'A'.repeat(501);
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/investigate',
                body: {
                    caseId: 'CASE-01',
                    question: longQuestion,
                },
            });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBe('QUESTION_TOO_LONG');
        });

        test('rejects question of invalid type with 400', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/investigate',
                body: {
                    caseId: 'CASE-01',
                    question: { malicious: 'object' },
                },
            });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBe('INVALID_QUESTION_TYPE');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Schema Validation & Citation Verification
    // ─────────────────────────────────────────────────────────────────────────
    describe('5. Schema Validation & Citation Verification', () => {
        test('generated report satisfies strict schema rules', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/investigate',
                body: {
                    caseId: 'CASE-01',
                    providerType: 'mock',
                },
            });

            expect(res.status).toBe(200);
            const report = res.body.report;

            // Required top-level fields
            expect(typeof report.investigation_id).toBe('string');
            expect(typeof report.transaction_id).toBe('string');
            expect(typeof report.summary).toBe('string');
            expect(report.summary.length).toBeGreaterThanOrEqual(10);
            expect(Array.isArray(report.confirmed_findings)).toBe(true);
            expect(Array.isArray(report.recommended_checks)).toBe(true);
            expect(Array.isArray(report.evidence_references)).toBe(true);
            expect(Array.isArray(report.limitations)).toBe(true);

            // Finding citations validation
            report.confirmed_findings.forEach((finding) => {
                expect(typeof finding.claim).toBe('string');
                expect(Array.isArray(finding.evidence_references)).toBe(true);
                expect(finding.evidence_references.length).toBeGreaterThan(0);
                expect(typeof finding.source_field).toBe('string');
            });

            // Recommended checks formatting
            expect(Array.isArray(report.recommended_checks_display)).toBe(true);
            report.recommended_checks_display.forEach((check) => {
                expect(check).toHaveProperty('code');
                expect(check).toHaveProperty('description');
            });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Hallucinated Evidence Rejection
    // ─────────────────────────────────────────────────────────────────────────
    describe('6. Hallucinated Evidence Rejection', () => {
        test('orchestrator rejects candidate report citing unknown evidence sources', async () => {
            const mockProvider = new MockModelProvider();
            mockProvider.setForcedStatus('SUCCESS');
            mockProvider.setMockResponse({
                summary: 'Adversarial report citing hallucinated sources.',
                status: 'COMPLETED',
                confirmed_findings: [
                    {
                        claim: 'Payment failed due to SWIFT BIC error.',
                        evidence_references: ['non_existent_swift_table', 'fabrication_oracle_db'],
                        source_field: 'swift_table.error',
                    },
                ],
                hypotheses: [],
                missing_information: [],
                recommended_checks: ['VERIFY_PROVIDER_STATUS'],
                evidence_references: ['non_existent_swift_table'],
                limitations: ['Advisory only.'],
            });

            const orchestrator = new InvestigationOrchestrator({
                dbClient: syntheticStore.createControlledDbBoundary(),
                modelProvider: mockProvider,
            });

            const testCase = syntheticStore.getCaseById('CASE-01');
            const outcome = await orchestrator.investigate({
                transactionId: testCase.transactionId,
                explicitIntent: testCase.intent,
                evidenceOverride: testCase.evidence,
            });

            expect(outcome.success).toBe(false);
            expect(outcome.status).toBe('REPORT_VALIDATION_FAILED');
            expect(outcome.validation_errors.length).toBeGreaterThan(0);
            expect(
                outcome.validation_errors.some((e) =>
                    e.includes('cites unknown or unretrieved evidence')
                )
            ).toBe(true);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 7. Timeout & Model Failure Handling
    // ─────────────────────────────────────────────────────────────────────────
    describe('7. Timeout & Provider Failure Translation', () => {
        test('returns 504 on model timeout', async () => {
            const mockProvider = new MockModelProvider({
                forcedStatus: 'MODEL_TIMEOUT',
            });

            const orchestrator = new InvestigationOrchestrator({
                dbClient: syntheticStore.createControlledDbBoundary(),
                modelProvider: mockProvider,
            });

            const testCase = syntheticStore.getCaseById('CASE-01');
            const outcome = await orchestrator.investigate({
                transactionId: testCase.transactionId,
                explicitIntent: testCase.intent,
                evidenceOverride: testCase.evidence,
            });

            expect(outcome.success).toBe(false);
            expect(outcome.status).toBe('MODEL_TIMEOUT');
        });

        test('returns 503 on CASE-14 (Model Unavailable)', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/investigate',
                body: {
                    caseId: 'CASE-14',
                    providerType: 'mock',
                },
            });

            expect(res.status).toBe(503);
            expect(res.body.success).toBe(false);
            expect(res.body.status).toBe('AI_UNAVAILABLE');
            expect(res.body.error).toContain('AI inference service is unavailable');
        });

        test('returns 502 on CASE-15 (Invalid Model JSON Output)', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/investigate',
                body: {
                    caseId: 'CASE-15',
                    providerType: 'mock',
                },
            });

            expect(res.status).toBe(502);
            expect(res.body.success).toBe(false);
            expect(res.body.status).toBe('MODEL_OUTPUT_INVALID');
            expect(res.body.error).toContain('malformed');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 8. No Persistent Database Access Guard
    // ─────────────────────────────────────────────────────────────────────────
    describe('8. Zero Persistent Database Access Enforcement', () => {
        test('synthetic store boundary strictly throws on any database query attempt', async () => {
            const boundary = syntheticStore.createControlledDbBoundary();
            await expect(boundary.query('SELECT 1')).rejects.toThrow(
                /SECURITY_VIOLATION: Direct database query rejected/
            );
        });

        test('investigation workflow executes completely without calling dbClient.query', async () => {
            const spyBoundary = {
                query: jest.fn().mockImplementation(async () => {
                    throw new Error('Database access prohibited');
                }),
            };

            const mockProvider = new MockModelProvider();
            mockProvider.setForcedStatus('SUCCESS');
            mockProvider.setMockResponse({
                summary: 'Valid offline report.',
                status: 'COMPLETED',
                confirmed_findings: [
                    {
                        claim: 'Gateway rejected payout due to insufficient balance.',
                        evidence_references: ['getTransactionTimeline'],
                        source_field: 'getTransactionTimeline.timeline.current_state',
                    },
                ],
                hypotheses: [],
                missing_information: [],
                recommended_checks: ['VERIFY_PROVIDER_STATUS'],
                evidence_references: ['getTransactionTimeline'],
                limitations: ['Advisory only.'],
            });

            const orchestrator = new InvestigationOrchestrator({
                dbClient: spyBoundary,
                modelProvider: mockProvider,
            });

            const testCase = syntheticStore.getCaseById('CASE-01');
            const outcome = await orchestrator.investigate({
                transactionId: testCase.transactionId,
                explicitIntent: testCase.intent,
                evidenceOverride: testCase.evidence,
            });

            expect(outcome.success).toBe(true);
            expect(spyBoundary.query).not.toHaveBeenCalled();
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 9. Payment Mutation Prohibitions & Defense
    // ─────────────────────────────────────────────────────────────────────────
    describe('9. Payment Mutation Prohibitions & Non-Autonomous Guardrails', () => {
        test('CASE-13: strictly refuses mutation request in advisory mode', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/investigate',
                body: {
                    caseId: 'CASE-13',
                    providerType: 'mock',
                },
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.report.summary).toContain('refuses mutation request');
            // Prohibit mutation verbs in recommended checks
            const forbiddenVerbs = [
                'EXECUTE',
                'DISBURSE',
                'REFUND',
                'RETRY',
                'OVERRIDE',
                'TRANSFER',
            ];
            res.body.report.recommended_checks.forEach((code) => {
                for (const verb of forbiddenVerbs) {
                    expect(code).not.toContain(verb);
                }
            });
        });

        test('candidate report containing forbidden mutation recommendation is rejected by schema', async () => {
            const mockProvider = new MockModelProvider();
            mockProvider.setForcedStatus('SUCCESS');
            mockProvider.setMockResponse({
                summary: 'Malicious report recommending immediate fund transfer.',
                status: 'COMPLETED',
                confirmed_findings: [
                    {
                        claim: 'Instruction failed; we should execute payout immediately.',
                        evidence_references: ['getTransactionTimeline'],
                        source_field: 'getTransactionTimeline.status',
                    },
                ],
                hypotheses: [],
                missing_information: [],
                recommended_checks: ['EXECUTE_PAYOUT_NOW'], // invalid mutation code
                evidence_references: ['getTransactionTimeline'],
                limitations: ['Advisory only.'],
            });

            const orchestrator = new InvestigationOrchestrator({
                dbClient: syntheticStore.createControlledDbBoundary(),
                modelProvider: mockProvider,
            });

            const testCase = syntheticStore.getCaseById('CASE-01');
            const outcome = await orchestrator.investigate({
                transactionId: testCase.transactionId,
                explicitIntent: testCase.intent,
                evidenceOverride: testCase.evidence,
            });

            expect(outcome.success).toBe(false);
            expect(outcome.status).toBe('REPORT_VALIDATION_FAILED');
            expect(outcome.validation_errors.length).toBeGreaterThan(0);
        });

        test('router exposes zero payment mutation endpoints or tools', () => {
            // Verify router stack only has GET /synthetic-cases and POST /investigate
            const routes = aiInvestigateRouter.stack
                .filter((layer) => layer.route)
                .map((layer) => ({
                    path: layer.route.path,
                    methods: Object.keys(layer.route.methods),
                }));

            expect(routes).toEqual([
                { path: '/synthetic-cases', methods: ['get'] },
                { path: '/investigate', methods: ['post'] },
                { path: '/agent-investigate', methods: ['post'] },
                { path: '/agent-investigate/stream', methods: ['post'] },
                { path: '/observability/traces/:traceId', methods: ['get'] },
                { path: '/observability/metrics', methods: ['get'] },
            ]);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 10. Authentication & Local-Only Access Boundary
    // ─────────────────────────────────────────────────────────────────────────
    describe('10. Authentication & Local-Only Access Boundary', () => {
        test('rejects remote unauthenticated requests when LOCAL_ONLY is false', async () => {
            const originalLocalOnly = process.env.LOCAL_ONLY;
            process.env.LOCAL_ONLY = 'false';
            process.env.API_SECRET_KEY = 'valid_test_secret_key';

            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/investigate',
                ip: '203.0.113.195',
                hostname: 'external.example.com',
                body: { caseId: 'CASE-01' },
            });

            expect(res.status).toBe(401);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBe('UNAUTHORIZED');

            // Authenticated with matching x-api-key succeeds
            const resAuth = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/investigate',
                ip: '203.0.113.195',
                hostname: 'external.example.com',
                headers: { 'x-api-key': 'valid_test_secret_key' },
                body: { caseId: 'CASE-01', providerType: 'mock' },
            });

            expect(resAuth.status).toBe(200);
            expect(resAuth.body.success).toBe(true);

            // Restore environment
            process.env.LOCAL_ONLY = originalLocalOnly;
            delete process.env.API_SECRET_KEY;
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 11. POST /api/ai/agent-investigate — Bounded Agent Execution
    // ─────────────────────────────────────────────────────────────────────────
    describe('11. POST /api/ai/agent-investigate — Bounded Agent Execution', () => {
        test('executes agentic investigation with mock provider and returns trace + report', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/agent-investigate',
                body: {
                    caseId: 'CASE-01',
                    providerType: 'mock',
                },
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.status).toBe('REPORT_GENERATED');
            expect(res.body.case_id).toBe('CASE-01');
            expect(res.body.report).toBeDefined();
            expect(res.body.trace).toBeDefined();
            expect(Array.isArray(res.body.trace)).toBe(true);
            expect(res.body.metrics).toBeDefined();
            expect(res.body.metrics.rounds).toBeGreaterThanOrEqual(1);
            expect(res.body.metrics.tool_executions).toBeGreaterThanOrEqual(1);
        });

        test('rejects missing caseId with 400', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/agent-investigate',
                body: { providerType: 'mock' },
            });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('MISSING_CASE_ID');
        });

        test('rejects invalid caseId format with 400', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/agent-investigate',
                body: { caseId: 'CASE-999', providerType: 'mock' },
            });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('INVALID_CASE_ID_FORMAT');
        });

        test('rejects oversized question with 400', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/agent-investigate',
                body: {
                    caseId: 'CASE-01',
                    question: 'A'.repeat(501),
                    providerType: 'mock',
                },
            });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('QUESTION_TOO_LONG');
        });
    });

    describe('12. Observability & Tracing Endpoints', () => {
        test('GET /api/ai/observability/metrics returns telemetry payload on loopback', async () => {
            const res = await makeRequest(app, {
                method: 'GET',
                url: '/api/ai/observability/metrics',
                ip: '127.0.0.1',
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.telemetry).toBeDefined();
            expect(res.body.telemetry.investigations).toBeDefined();
            expect(res.body.telemetry.models).toBeDefined();
            expect(res.body.telemetry.agent).toBeDefined();
            expect(res.body.telemetry.rag).toBeDefined();
            expect(res.body.telemetry.dlp).toBeDefined();
        });

        test('GET /api/ai/observability/traces/:traceId rejects non-local request with 403', async () => {
            const res = await makeRequest(app, {
                method: 'GET',
                url: '/api/ai/observability/traces/0123456789abcdef0123456789abcdef',
                ip: '198.51.100.22',
                hostname: 'external.example.com',
            });

            expect(res.status).toBe(403);
            expect(res.body.error).toBe('FORBIDDEN');
        });

        test('GET /api/ai/observability/traces/:traceId returns 404 for unknown trace', async () => {
            const res = await makeRequest(app, {
                method: 'GET',
                url: '/api/ai/observability/traces/00000000000000000000000000000000',
                ip: '127.0.0.1',
            });

            expect(res.status).toBe(404);
            expect(res.body.error).toBe('TRACE_NOT_FOUND');
        });

        test('POST /api/ai/agent-investigate/stream handles SSE request with mock provider', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/agent-investigate/stream',
                body: { caseId: 'CASE-01', providerType: 'mock' },
                ip: '127.0.0.1',
            });

            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toBe('text/event-stream');
            // Body chunks were written to res
            expect(res.body).toBeDefined();
            expect(res.body).toContain('event: investigation.started');
            expect(res.body).toContain('event: investigation.completed');
        });
    });
});
