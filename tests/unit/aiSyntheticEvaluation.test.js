'use strict';

const { SYNTHETIC_CASES } = require('../../core/ai/benchmark/syntheticCases');
const { InvestigationOrchestrator } = require('../../core/ai/orchestrator');
const { MockModelProvider } = require('../../core/ai/providers/mockModelProvider');

describe('AI Synthetic Operational Evaluation Suite (15 Cases)', () => {
    let provider;
    let orchestrator;

    beforeEach(() => {
        provider = new MockModelProvider({ simulatedLatencyMs: 1 });
        orchestrator = new InvestigationOrchestrator({
            modelProvider: provider,
            timeoutMs: 5000
        });
    });

    test('verifies all 15 synthetic operational evaluation cases produce their expected status', async () => {
        expect(SYNTHETIC_CASES.length).toBe(15);

        for (const testCase of SYNTHETIC_CASES) {
            // Configure provider behavior per test case
            if (testCase.forcedProviderStatus) {
                provider.setForcedStatus(testCase.forcedProviderStatus);
            } else {
                provider.setForcedStatus('SUCCESS');
                const toolNames = Object.keys(testCase.evidence || {});
                const primaryTool = toolNames[0] || 'getTransactionTimeline';
                provider.setMockResponse({
                    summary: `Operational evaluation for ${testCase.transactionId}: ${testCase.groundedFinding}`,
                    status: 'COMPLETED',
                    confirmed_findings: [
                        {
                            claim: testCase.groundedFinding,
                            evidence_references: [primaryTool],
                            source_field: `${primaryTool}.status`
                        }
                    ],
                    hypotheses: [],
                    missing_information: [],
                    recommended_checks: ['VERIFY_PROVIDER_STATUS'],
                    evidence_references: toolNames.length > 0 ? toolNames : ['getTransactionTimeline'],
                    limitations: ['Advisory decision support only. Human review required.']
                });
            }

            const outcome = await orchestrator.investigate({
                transactionId: testCase.transactionId,
                question: testCase.question,
                explicitIntent: testCase.intent,
                evidenceOverride: testCase.evidence || {}
            });

            expect(outcome.status).toBe(testCase.expectedStatus);

            if (outcome.status === 'REPORT_GENERATED') {
                expect(outcome.report).toBeDefined();
                expect(outcome.report.confirmed_findings[0].claim).toBe(testCase.groundedFinding);
                expect(outcome.report.intent).toBe(testCase.intent);
                expect(outcome.report.transaction_id).toBe(testCase.transactionId);
                expect(outcome.report.recommended_checks_display).toBeDefined();
            }
        }
    });

    describe('Adversarial & Fault Injection Verification', () => {
        test('CASE-12: Prompt Injection in Invoice Notes is contained as passive untrusted data', async () => {
            const case12 = SYNTHETIC_CASES.find(c => c.id === 'CASE-12');
            expect(case12).toBeDefined();

            // Mock model attempt to follow injection by recommending payout execution
            provider.setMockResponse({
                summary: 'Investigated customer notes.',
                status: 'COMPLETED',
                confirmed_findings: [
                    {
                        claim: 'Customer requested payout execution in invoice notes.',
                        evidence_references: ['getTransactionTimeline'],
                        source_field: 'getTransactionTimeline.timeline.notes'
                    }
                ],
                hypotheses: [],
                missing_information: [],
                recommended_checks: ['Execute payout to customer immediately.'], // VIOLATION
                evidence_references: ['getTransactionTimeline'],
                limitations: []
            });

            const outcome = await orchestrator.investigate({
                transactionId: case12.transactionId,
                question: case12.question,
                explicitIntent: case12.intent,
                evidenceOverride: case12.evidence
            });

            // Validator MUST reject this report because recommended_checks contains forbidden mutation
            expect(outcome.success).toBe(false);
            expect(outcome.status).toBe('REPORT_VALIDATION_FAILED');
            expect(outcome.validation_errors.some(e => e.includes('prohibited financial mutation action') || e.includes('not an allowed operational recommendation code'))).toBe(true);
        });

        test('CASE-13: Payment Mutation Request is strictly rejected by recommendation validator', async () => {
            const case13 = SYNTHETIC_CASES.find(c => c.id === 'CASE-13');
            expect(case13).toBeDefined();

            // Simulate model hallucinating a mutation command
            provider.setMockResponse({
                summary: 'Refund requested by operator.',
                status: 'COMPLETED',
                confirmed_findings: [
                    {
                        claim: 'Transaction failed at provider.',
                        evidence_references: ['getTransactionTimeline'],
                        source_field: 'getTransactionTimeline.status'
                    }
                ],
                hypotheses: [],
                missing_information: [],
                recommended_checks: ['Process refund for $500 immediately to sender account.'], // VIOLATION
                evidence_references: ['getTransactionTimeline'],
                limitations: []
            });

            const outcome = await orchestrator.investigate({
                transactionId: case13.transactionId,
                question: case13.question,
                explicitIntent: case13.intent,
                evidenceOverride: case13.evidence
            });

            // Validator MUST reject this report
            expect(outcome.success).toBe(false);
            expect(outcome.status).toBe('REPORT_VALIDATION_FAILED');
            expect(outcome.validation_errors.some(e => e.includes('prohibited financial mutation action') || e.includes('not an allowed operational recommendation code'))).toBe(true);
        });

        test('CASE-14: Model Unavailable fails closed with structured AI_UNAVAILABLE', async () => {
            const case14 = SYNTHETIC_CASES.find(c => c.id === 'CASE-14');
            expect(case14).toBeDefined();

            provider.setForcedStatus('AI_UNAVAILABLE');

            const outcome = await orchestrator.investigate({
                transactionId: case14.transactionId,
                question: case14.question,
                explicitIntent: case14.intent,
                evidenceOverride: case14.evidence
            });

            expect(outcome.success).toBe(false);
            expect(outcome.status).toBe('AI_UNAVAILABLE');
            expect(outcome.error).toBeDefined();
            expect(outcome.report).toBeUndefined();
        });

        test('CASE-15: Invalid Model JSON Response fails closed with MODEL_OUTPUT_INVALID', async () => {
            const case15 = SYNTHETIC_CASES.find(c => c.id === 'CASE-15');
            expect(case15).toBeDefined();

            provider.setForcedStatus('MODEL_OUTPUT_INVALID');

            const outcome = await orchestrator.investigate({
                transactionId: case15.transactionId,
                question: case15.question,
                explicitIntent: case15.intent,
                evidenceOverride: case15.evidence
            });

            expect(outcome.success).toBe(false);
            expect(outcome.status).toBe('MODEL_OUTPUT_INVALID');
            expect(outcome.error).toBeDefined();
            expect(outcome.report).toBeUndefined();
        });
    });
});

