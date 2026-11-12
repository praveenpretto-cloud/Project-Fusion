'use strict';

const { IntentClassifier, INTENT_DEFINITIONS } = require('../../core/ai/orchestrator/intentClassifier');
const { PromptBuilder } = require('../../core/ai/orchestrator/promptBuilder');
const { EvidenceCitationValidator } = require('../../core/ai/validators/evidenceCitationValidator');
const { InvestigationOrchestrator } = require('../../core/ai/orchestrator/investigationOrchestrator');
const { MockModelProvider } = require('../../core/ai/providers/mockModelProvider');

describe('AI Orchestrator Unit Tests', () => {
    describe('IntentClassifier', () => {
        test('resolves all 7 supported explicit intents to their authorized tools', () => {
            const explicitIntents = [
                'FAILURE_INVESTIGATION',
                'SAGA_INVESTIGATION',
                'WEBHOOK_INVESTIGATION',
                'LEDGER_AUDIT',
                'RECONCILIATION_INVESTIGATION',
                'ISO_VALIDATION',
                'FULL_INVESTIGATION'
            ];

            for (const intent of explicitIntents) {
                const res = IntentClassifier.classify({ explicitIntent: intent, question: '' });
                expect(res.isClarificationRequired).toBe(false);
                expect(res.intent).toBe(intent);
                expect(Array.isArray(res.tools)).toBe(true);
                expect(res.tools.length).toBeGreaterThan(0);
            }
        });

        test('flags unsupported explicit intent as requiring clarification', () => {
            const res = IntentClassifier.classify({ explicitIntent: 'ARBITRARY_NONEXISTENT_INTENT', question: '' });
            expect(res.isClarificationRequired).toBe(true);
            expect(res.intent).toBeNull();
            expect(res.reason).toContain('Unsupported explicit intent');
        });

        test('correctly infers intent from natural language operational questions', () => {
            const q1 = IntentClassifier.classify({ question: 'Why did this transaction fail at Stripe?' });
            expect(q1.intent).toBe('FAILURE_INVESTIGATION');

            const q2 = IntentClassifier.classify({ question: 'Inspect the saga compensation execution for order 123' });
            expect(q2.intent).toBe('SAGA_INVESTIGATION');

            const q3 = IntentClassifier.classify({ question: 'Did we receive duplicate webhook events for this payment?' });
            expect(q3.intent).toBe('WEBHOOK_INVESTIGATION');

            const q4 = IntentClassifier.classify({ question: 'Verify the hash chain and double-entry ledger balance' });
            expect(q4.intent).toBe('LEDGER_AUDIT');

            const q5 = IntentClassifier.classify({ question: 'Reconcile ledger with Zoho books settlement batch' });
            expect(q5.intent).toBe('RECONCILIATION_INVESTIGATION');

            const q6 = IntentClassifier.classify({ question: 'Explain ISO 20022 pacs.008 schema validation syntax errors' });
            expect(q6.intent).toBe('ISO_VALIDATION');
        });

        test('requires clarification for ambiguous or empty queries without explicit intent', () => {
            const res = IntentClassifier.classify({ question: 'What is the weather today?' });
            expect(res.isClarificationRequired).toBe(true);
            expect(res.intent).toBeNull();
        });

        test('prohibits routing-ledger questions and flags clarification required', () => {
            const res = IntentClassifier.classify({ question: 'Show me the routing rules and fees for currency exchange' });
            expect(res.isClarificationRequired).toBe(true);
            expect(res.reason).toContain('not supported');
        });
    });

    describe('PromptBuilder', () => {
        test('builds separate system instruction and untrusted operational evidence context', () => {
            const context = PromptBuilder.buildUserContent({
                investigationId: 'INV-TEST-001',
                transactionId: 'tx-12345',
                intent: 'FAILURE_INVESTIGATION',
                rawEvidence: {
                    getProviderFailureDetails: {
                        success: true,
                        data: { error_message: 'Card declined: insufficient funds' }
                    }
                },
                question: 'Why did the card fail?'
            });

            expect(typeof context.systemInstruction).toBe('string');
            expect(context.systemInstruction).toContain('Fusion Operations Intelligence');
            expect(context.systemInstruction).toContain('ABSOLUTE PROHIBITION ON FINANCIAL MUTATIONS');

            expect(typeof context.evidenceContext).toBe('object');
            expect(context.evidenceContext.getProviderFailureDetails).toBeDefined();
            expect(context.evidenceContext.getProviderFailureDetails.data.error_message).toContain('insufficient funds');

            expect(context.promptPayload.investigation_id).toBe('INV-TEST-001');
            expect(context.promptPayload.transaction_id).toBe('tx-12345');
            expect(context.investigationQuestion).toBe('Why did the card fail?');
        });
    });

    describe('EvidenceCitationValidator', () => {
        const validReport = {
            investigation_id: 'INV-001',
            transaction_id: 'tx-001',
            intent: 'FAILURE_INVESTIGATION',
            status: 'COMPLETED',
            summary: 'Payment declined by gateway due to insufficient balance.',
            confirmed_findings: [
                {
                    claim: 'Gateway reported insufficient funds on sender account.',
                    evidence_references: ['getProviderFailureDetails'],
                    source_field: 'getProviderFailureDetails.data.error_message'
                }
            ],
            hypotheses: [
                {
                    hypothesis: 'Possible that account balance was lower than requested amount at execution time.',
                    supporting_evidence: ['getProviderFailureDetails'],
                    missing_evidence: ['bank_account_realtime_balance']
                }
            ],
            missing_information: ['Real-time gateway account balance log'],
            recommended_checks: ['CHECK_ACCOUNT_BALANCE'],
            evidence_references: ['getProviderFailureDetails'],
            limitations: ['Internal evidence only; banking gateway live balance inaccessible.'],
            model_metadata: {
                provider: 'mock',
                model: 'test-model',
                latency_ms: 15
            }
        };

        test('validates fully compliant report without errors', () => {
            const res = EvidenceCitationValidator.validate({
                report: validReport,
                availableEvidenceKeys: new Set(['getProviderFailureDetails', 'getProviderFailureDetails.data.error_message'])
            });

            expect(res.valid).toBe(true);
            expect(res.errors.length).toBe(0);
        });

        test('fails validation when required fields are missing', () => {
            const invalidReport = { ...validReport };
            delete invalidReport.summary;

            const res = EvidenceCitationValidator.validate({
                report: invalidReport,
                availableEvidenceKeys: new Set(['getProviderFailureDetails'])
            });

            expect(res.valid).toBe(false);
            expect(res.errors.some(e => e.includes('"summary" is required'))).toBe(true);
        });

        test('fails validation when report cites evidence not in availableEvidenceKeys', () => {
            const res = EvidenceCitationValidator.validate({
                report: validReport,
                availableEvidenceKeys: new Set(['otherToolOnly'])
            });

            expect(res.valid).toBe(false);
            expect(res.errors.some(e => e.includes('unknown or unretrieved evidence reference'))).toBe(true);
        });

        test('fails validation when recommended_checks contain prohibited mutation actions or evasion phrases', () => {
            const prohibitedPhrases = [
                'Please execute payout immediately.',
                'We must process refund for the customer.',
                'Retry payment on secondary route.',
                'Operator should transfer funds now.',
                'System should mark settled in ledger.',
                'Release escrow to beneficiary.',
                'Submit the payout again.',
                'Re-initiate the payment.',
                'Release the escrow.',
                'Reverse the transfer.',
                'Retry the disbursement.',
                'EXECUTE_PAYOUT',
                'PROCESS_REFUND',
                'RETRY_PAYMENT'
            ];

            for (const phrase of prohibitedPhrases) {
                const reportWithMutation = {
                    ...validReport,
                    recommended_checks: [phrase]
                };

                const res = EvidenceCitationValidator.validate({
                    report: reportWithMutation,
                    availableEvidenceKeys: new Set(['getProviderFailureDetails'])
                });

                expect(res.valid).toBe(false);
                expect(res.errors.length).toBeGreaterThan(0);
            }
        });

        test('validates exact operational diagnostic recommendation codes from allowlist', () => {
            const reportWithAllowlist = {
                ...validReport,
                recommended_checks: [
                    'VERIFY_PROVIDER_STATUS',
                    'REVIEW_RECONCILIATION_RECORD',
                    'INSPECT_LEDGER_INTEGRITY',
                    'CHECK_WEBHOOK_CONFIGURATION',
                    'REVIEW_SAGA_EVIDENCE',
                    'VERIFY_ISO_VALIDATION_RECORD'
                ]
            };

            const res = EvidenceCitationValidator.validate({
                report: reportWithAllowlist,
                availableEvidenceKeys: new Set(['getProviderFailureDetails', 'getProviderFailureDetails.data.error_message'])
            });

            expect(res.valid).toBe(true);
            expect(res.errors.length).toBe(0);
        });

        test('rejects unknown or unlisted recommendation codes', () => {
            const reportWithUnknownCode = {
                ...validReport,
                recommended_checks: ['UNKNOWN_OPERATIONAL_CHECK']
            };

            const res = EvidenceCitationValidator.validate({
                report: reportWithUnknownCode,
                availableEvidenceKeys: new Set(['getProviderFailureDetails'])
            });

            expect(res.valid).toBe(false);
            expect(res.errors.some(e => e.includes('not an allowed operational recommendation code'))).toBe(true);
        });

        test('rejects a valid code combined with an unsafe instruction or arbitrary prose', () => {
            const reportWithMixedInstruction = {
                ...validReport,
                recommended_checks: ['VERIFY_PROVIDER_STATUS: execute payout immediately']
            };

            const res = EvidenceCitationValidator.validate({
                report: reportWithMixedInstruction,
                availableEvidenceKeys: new Set(['getProviderFailureDetails'])
            });

            expect(res.valid).toBe(false);
            expect(res.errors.some(e => e.includes('not an allowed operational recommendation code') || e.includes('prohibited financial mutation action'))).toBe(true);
        });

        test('rejects duplicate recommendation codes in recommended_checks', () => {
            const reportWithDuplicates = {
                ...validReport,
                recommended_checks: ['VERIFY_PROVIDER_STATUS', 'VERIFY_PROVIDER_STATUS']
            };

            const res = EvidenceCitationValidator.validate({
                report: reportWithDuplicates,
                availableEvidenceKeys: new Set(['getProviderFailureDetails'])
            });

            expect(res.valid).toBe(false);
            expect(res.errors.some(e => e.includes('Duplicate recommendation codes are not permitted'))).toBe(true);
        });

        test('rejects missing or non-array recommendations', () => {
            const reportWithNullChecks = {
                ...validReport,
                recommended_checks: null
            };

            const res = EvidenceCitationValidator.validate({
                report: reportWithNullChecks,
                availableEvidenceKeys: new Set(['getProviderFailureDetails'])
            });

            expect(res.valid).toBe(false);
            expect(res.errors.some(e => e.includes('"recommended_checks" must be an array'))).toBe(true);
        });

        test('rejects confirmed finding with missing or empty evidence references', () => {
            const reportWithoutCitation = {
                ...validReport,
                confirmed_findings: [
                    {
                        claim: 'This is an ungrounded claim without citations.',
                        evidence_references: [],
                        source_field: 'unknown'
                    }
                ]
            };

            const res = EvidenceCitationValidator.validate({
                report: reportWithoutCitation,
                availableEvidenceKeys: new Set(['getProviderFailureDetails'])
            });

            expect(res.valid).toBe(false);
            expect(res.errors.some(e => e.includes('must contain at least 1 items') || e.includes('no evidence references'))).toBe(true);
        });

        test('enforces hypothesis separation and requires tentative phrasing', () => {
            const reportWithCertainHypothesis = {
                ...validReport,
                hypotheses: [
                    {
                        hypothesis: 'The database definitely crashed because of hardware failure.', // Not tentative
                        supporting_evidence: [],
                        missing_evidence: []
                    }
                ]
            };

            const res = EvidenceCitationValidator.validate({
                report: reportWithCertainHypothesis,
                availableEvidenceKeys: new Set(['getProviderFailureDetails', 'getProviderFailureDetails.data.error_message'])
            });

            expect(res.valid).toBe(false);
            expect(res.errors.some(e => e.includes('tentative/hypothetical phrasing'))).toBe(true);
        });
    });

    describe('InvestigationOrchestrator', () => {
        test('rejects missing or empty transactionId', async () => {
            const orchestrator = new InvestigationOrchestrator({
                modelProvider: new MockModelProvider()
            });

            const res1 = await orchestrator.investigate({});
            expect(res1.success).toBe(false);
            expect(res1.status).toBe('INVALID_PARAMETERS');

            const res2 = await orchestrator.investigate({ transactionId: '   ' });
            expect(res2.success).toBe(false);
            expect(res2.status).toBe('INVALID_PARAMETERS');
        });

        test('returns INTENT_CLARIFICATION_REQUIRED when question is unrecognized', async () => {
            const orchestrator = new InvestigationOrchestrator({
                modelProvider: new MockModelProvider()
            });

            const res = await orchestrator.investigate({
                transactionId: 'tx-001',
                question: 'What is the capital of France?'
            });

            expect(res.success).toBe(false);
            expect(res.status).toBe('INTENT_CLARIFICATION_REQUIRED');
            expect(res.reason).toBeDefined();
        });

        test('executes end-to-end investigation with mock provider and mock evidence tools', async () => {
            const mockDb = { query: jest.fn() };
            const mockEvidenceTools = {
                getTransactionTimeline: jest.fn().mockResolvedValue({
                    success: true,
                    status: 'TIMELINE_AVAILABLE',
                    timeline: { current_state: 'FAILED' }
                }),
                getProviderFailureDetails: jest.fn().mockResolvedValue({
                    success: true,
                    status: 'FAILURE_DETAILS_AVAILABLE',
                    data: { error_message: 'Card expired' }
                }),
                getSettlementAndWebhookEvidence: jest.fn().mockResolvedValue({
                    success: true,
                    events: []
                })
            };

            const mockProvider = new MockModelProvider({
                mockResponse: {
                    summary: 'Transaction failed because the customer credit card expired.',
                    status: 'COMPLETED',
                    confirmed_findings: [
                        {
                            claim: 'Card expired error reported by provider gateway.',
                            evidence_references: ['getProviderFailureDetails'],
                            source_field: 'getProviderFailureDetails.data.error_message'
                        }
                    ],
                    hypotheses: [],
                    missing_information: [],
                    recommended_checks: ['REQUEST_COUNTERPARTY_INFORMATION'],
                    evidence_references: ['getProviderFailureDetails', 'getTransactionTimeline'],
                    limitations: ['Internal evidence only.']
                }
            });

            const orchestrator = new InvestigationOrchestrator({
                dbClient: mockDb,
                modelProvider: mockProvider,
                evidenceTools: mockEvidenceTools
            });

            const res = await orchestrator.investigate({
                transactionId: 'tx-valid-001',
                explicitIntent: 'FAILURE_INVESTIGATION',
                question: 'Why did this fail?'
            });

            expect(res.success).toBe(true);
            expect(res.status).toBe('REPORT_GENERATED');
            expect(res.report).toBeDefined();
            expect(res.report.investigation_id).toMatch(/^INV-INTEL-/);
            expect(res.report.transaction_id).toBe('tx-valid-001');
            expect(res.report.intent).toBe('FAILURE_INVESTIGATION');
            expect(res.report.summary).toContain('Transaction failed because');
            expect(res.report.recommended_checks).toEqual(['REQUEST_COUNTERPARTY_INFORMATION']);
            expect(res.report.recommended_checks_display).toBeDefined();
            expect(res.report.recommended_checks_display[0].code).toBe('REQUEST_COUNTERPARTY_INFORMATION');
            expect(res.report.recommended_checks_display[0].description).toContain('counterparty');
            expect(mockEvidenceTools.getProviderFailureDetails).toHaveBeenCalledWith(mockDb, 'tx-valid-001');
        });

        test('handles provider failures fail-closed without hallucination', async () => {
            const mockProvider = new MockModelProvider();
            mockProvider.setForcedStatus('AI_UNAVAILABLE');

            const orchestrator = new InvestigationOrchestrator({
                modelProvider: mockProvider,
                evidenceTools: {
                    getTransactionTimeline: jest.fn().mockResolvedValue({ success: true }),
                    getProviderFailureDetails: jest.fn().mockResolvedValue({ success: true }),
                    getSettlementAndWebhookEvidence: jest.fn().mockResolvedValue({ success: true })
                }
            });

            const res = await orchestrator.investigate({
                transactionId: 'tx-fail-001',
                explicitIntent: 'FAILURE_INVESTIGATION'
            });

            expect(res.success).toBe(false);
            expect(res.status).toBe('AI_UNAVAILABLE');
            expect(res.error).toBeDefined();
        });

        test('handles tool errors gracefully during evidence gathering', async () => {
            const mockEvidenceTools = {
                getTransactionTimeline: jest.fn().mockRejectedValue(new Error('Database connection reset')),
                getProviderFailureDetails: jest.fn().mockResolvedValue({ success: true, data: {} }),
                getSettlementAndWebhookEvidence: jest.fn().mockResolvedValue({ success: true, events: [] })
            };

            const mockProvider = new MockModelProvider({
                mockResponse: {
                    summary: 'Partial investigation due to timeline lookup failure.',
                    status: 'INCOMPLETE_EVIDENCE',
                    confirmed_findings: [
                        {
                            claim: 'Provider details retrieved successfully.',
                            evidence_references: ['getProviderFailureDetails'],
                            source_field: 'getProviderFailureDetails.status'
                        }
                    ],
                    hypotheses: [],
                    missing_information: ['Transaction timeline details'],
                    recommended_checks: ['INSPECT_DATABASE_STATUS'],
                    evidence_references: ['getProviderFailureDetails'],
                    limitations: ['Timeline tool failed.']
                }
            });

            const orchestrator = new InvestigationOrchestrator({
                modelProvider: mockProvider,
                evidenceTools: mockEvidenceTools
            });

            const res = await orchestrator.investigate({
                transactionId: 'tx-tool-err-001',
                explicitIntent: 'FAILURE_INVESTIGATION'
            });

            expect(res.success).toBe(true);
            expect(res.status).toBe('REPORT_GENERATED');
            expect(res.raw_evidence.getTransactionTimeline.success).toBe(false);
            expect(res.raw_evidence.getTransactionTimeline.error).toContain('Database connection reset');
        });
    });
});
