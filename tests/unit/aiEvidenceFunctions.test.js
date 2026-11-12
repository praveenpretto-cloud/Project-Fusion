'use strict';

const crypto = require('crypto');
const {
    getTransactionTimeline,
    getProviderFailureDetails,
    getSagaExecutionEvidence,
    getSettlementAndWebhookEvidence,
    verifyLedgerIntegrity,
    getReconciliationEvidence,
    explainIsoValidationErrors,
    computePayloadHash,
} = require('../../core/ai/evidence');
const { toCanonicalDecimal } = require('../../core/orchestrator/financialDecimal');

describe('Fusion Operations Intelligence — Phase AI-1A Evidence Suite', () => {
    // Helper to generate a realistic SHA-256 hash
    function sha256(str) {
        return crypto.createHash('sha256').update(str).digest('hex');
    }

    const TEST_INSTRUCTION_ID = '3a7f8b2c-1234-4567-89ab-cdef01234567';
    const TEST_INVOICE_ID = 'INV-2026-X100';
    const TEST_SAGA_ID = 'SAGA-INV-2026-X100';

    // =========================================================================
    // 1. PARAMETERIZED SQL & INPUT VALIDATION ACROSS TOOLS
    // =========================================================================
    describe('Capability 1 & 2: Parameterized SQL & Strict Input Validation', () => {
        test('rejects non-UUID instruction identifiers with INVALID_IDENTIFIER', async () => {
            const mockClient = { query: jest.fn() };
            const badIds = [
                'not-a-uuid',
                '12345',
                'SELECT * FROM users;',
                '3a7f8b2c-1234-4567-89ab',
            ];

            for (const badId of badIds) {
                const resTimeline = await getTransactionTimeline(mockClient, badId);
                expect(resTimeline.success).toBe(false);
                expect(resTimeline.status).toBe('INVALID_IDENTIFIER');

                const resProvider = await getProviderFailureDetails(mockClient, badId);
                expect(resProvider.success).toBe(false);
                expect(resProvider.status).toBe('INVALID_IDENTIFIER');

                const resLedger = await verifyLedgerIntegrity(mockClient, badId);
                expect(resLedger.success).toBe(false);
                expect(resLedger.status).toBe('INVALID_IDENTIFIER');

                const resRecon = await getReconciliationEvidence(mockClient, badId);
                expect(resRecon.success).toBe(false);
                expect(resRecon.status).toBe('INVALID_IDENTIFIER');
            }
            expect(mockClient.query).not.toHaveBeenCalled();
        });

        test('all queries use parameterized placeholders and never concatenate raw inputs', async () => {
            const capturedQueries = [];
            const mockClient = {
                query: jest.fn(async (sql, params) => {
                    capturedQueries.push({ sql, params });
                    return { rows: [] };
                }),
            };

            await getTransactionTimeline(mockClient, TEST_INSTRUCTION_ID);
            await getProviderFailureDetails(mockClient, TEST_INSTRUCTION_ID);
            await getSettlementAndWebhookEvidence(mockClient, {
                instructionId: TEST_INSTRUCTION_ID,
            });
            await getReconciliationEvidence(mockClient, TEST_INSTRUCTION_ID);
            await explainIsoValidationErrors(mockClient, TEST_INVOICE_ID);

            expect(capturedQueries.length).toBeGreaterThan(0);
            for (const q of capturedQueries) {
                // Assert no direct SQL injection strings
                expect(q.sql).not.toContain(TEST_INSTRUCTION_ID);
                expect(q.sql).not.toContain(TEST_INVOICE_ID);
                // Assert parameterized placeholders
                expect(q.sql).toMatch(/\$[1-9]/);
                expect(Array.isArray(q.params)).toBe(true);
            }
        });
    });

    // =========================================================================
    // 2. TOOL 1: getTransactionTimeline
    // =========================================================================
    describe('Capability 3, 4 & 5: getTransactionTimeline Exact Output & Missing Data', () => {
        test('returns persisted timeline with canonical decimal amount and reconciliation status', async () => {
            const createdAt = new Date('2026-11-01T10:00:00Z');
            const updatedAt = new Date('2026-11-01T10:05:00Z');
            const reconciledAt = new Date('2026-11-01T10:06:00Z');

            const mockClient = {
                query: jest.fn().mockResolvedValue({
                    rows: [
                        {
                            instruction_id: TEST_INSTRUCTION_ID,
                            state: 'SETTLED',
                            amount: '1500.5',
                            currency: 'USD',
                            created_at: createdAt,
                            updated_at: updatedAt,
                            reconciliation_status: 'RECONCILED',
                            reconciled_at: reconciledAt,
                        },
                    ],
                }),
            };

            const res = await getTransactionTimeline(mockClient, TEST_INSTRUCTION_ID);

            expect(res.success).toBe(true);
            expect(res.status).toBe('TIMELINE_AVAILABLE');
            expect(res.timeline.amount).toBe('1500.50'); // Canonical scale 2 decimal
            expect(res.timeline.current_state).toBe('SETTLED');
            expect(res.timeline.created_at).toBe(createdAt.toISOString());
            expect(res.timeline.updated_at).toBe(updatedAt.toISOString());
            expect(res.timeline.reconciliation.status).toBe('RECONCILED');
            expect(res.timeline.reconciliation.reconciled_at).toBe(reconciledAt.toISOString());
            // Does not invent unrecorded intermediate timestamps
            expect(res.timeline.locked_at).toBeUndefined();
            expect(res.timeline.routed_at).toBeUndefined();
        });

        test('returns NOT_FOUND when instruction does not exist', async () => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({ rows: [] }),
            };

            const res = await getTransactionTimeline(mockClient, TEST_INSTRUCTION_ID);
            expect(res.success).toBe(false);
            expect(res.status).toBe('NOT_FOUND');
        });
    });

    // =========================================================================
    // 3. TOOL 2: getProviderFailureDetails
    // =========================================================================
    describe('Capability 7: getProviderFailureDetails & Four-Tier Identity Classification', () => {
        test('Tier 1: PERSISTED_PROVIDER_EVIDENCE via processed_webhook_events', async () => {
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    state: 'FAILED',
                                    provider: 'FIAT',
                                    external_intent_id: 'unknown_ref_123',
                                    utr: null,
                                    execution_attempts: 1,
                                    error_message: 'Webhook reported failure',
                                    currency: 'USD',
                                },
                            ],
                        };
                    }
                    if (sql.includes('FROM processed_webhook_events')) {
                        return { rows: [{ provider: 'STRIPE' }] };
                    }
                    return { rows: [] };
                }),
            };

            const res = await getProviderFailureDetails(mockClient, TEST_INSTRUCTION_ID);
            expect(res.success).toBe(true);
            expect(res.data.provider_classification).toBe('PERSISTED_PROVIDER_EVIDENCE');
            expect(res.data.resolved_provider).toBe('STRIPE');
            expect(res.data.provider_mode).toBe('NOT_RECORDED');
        });

        test('Tier 2: IDENTIFIER_FORMAT_CANDIDATE matches pi_ for Stripe and pout_ for RazorpayX', async () => {
            const mockClientStripe = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    state: 'FAILED',
                                    provider: 'FIAT',
                                    external_intent_id: 'pi_3MtwBwLkdIwHu7ix28a3tqPa',
                                    utr: null,
                                    execution_attempts: 1,
                                    error_message: 'Card declined',
                                    currency: 'USD',
                                },
                            ],
                        };
                    }
                    return { rows: [] };
                }),
            };

            const resStripe = await getProviderFailureDetails(
                mockClientStripe,
                TEST_INSTRUCTION_ID
            );
            expect(resStripe.data.provider_classification).toBe('IDENTIFIER_FORMAT_CANDIDATE');
            expect(resStripe.data.resolved_provider).toBe('STRIPE');

            const mockClientRazorpay = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    state: 'FAILED',
                                    provider: 'FIAT',
                                    external_intent_id: 'pout_L3rG8H7b0Z2M4A',
                                    utr: null,
                                    execution_attempts: 2,
                                    error_message: 'Insufficient balance in business account',
                                    currency: 'INR',
                                },
                            ],
                        };
                    }
                    return { rows: [] };
                }),
            };

            const resRazorpay = await getProviderFailureDetails(
                mockClientRazorpay,
                TEST_INSTRUCTION_ID
            );
            expect(resRazorpay.data.provider_classification).toBe('IDENTIFIER_FORMAT_CANDIDATE');
            expect(resRazorpay.data.resolved_provider).toBe('RAZORPAYX');
        });

        test('Tier 2 BANNED CLAIM: 64-char hex string is GENERIC_HEX64 and does NOT claim Stellar', async () => {
            const hex64 = 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0';
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    state: 'FAILED',
                                    provider: 'CRYPTO',
                                    external_intent_id: hex64,
                                    utr: null,
                                    execution_attempts: 1,
                                    error_message: 'tx_failed',
                                    currency: 'XLM',
                                },
                            ],
                        };
                    }
                    return { rows: [] };
                }),
            };

            const res = await getProviderFailureDetails(mockClient, TEST_INSTRUCTION_ID);
            expect(res.data.provider_classification).toBe('IDENTIFIER_FORMAT_CANDIDATE');
            expect(res.data.resolved_provider).toBe('GENERIC_HEX64');
            expect(res.data.provider_evidence_note).toContain(
                'does not prove Stellar network settlement'
            );
        });

        test('Tier 3: UNVERIFIED_BROAD_CATEGORY for instructions.provider when intent format is absent', async () => {
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    state: 'FAILED',
                                    provider: 'FIAT',
                                    external_intent_id: null,
                                    utr: null,
                                    execution_attempts: 0,
                                    error_message: 'Policy Rejected',
                                    currency: 'EUR',
                                },
                            ],
                        };
                    }
                    return { rows: [] };
                }),
            };

            const res = await getProviderFailureDetails(mockClient, TEST_INSTRUCTION_ID);
            expect(res.data.provider_classification).toBe('UNVERIFIED_BROAD_CATEGORY');
            expect(res.data.resolved_provider).toBe('FIAT');
        });

        test('Tier 4: NOT_RECORDED when provider fields are null', async () => {
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    state: 'INITIATED',
                                    provider: null,
                                    external_intent_id: null,
                                    utr: null,
                                    execution_attempts: 0,
                                    error_message: null,
                                    currency: 'USD',
                                },
                            ],
                        };
                    }
                    return { rows: [] };
                }),
            };

            const res = await getProviderFailureDetails(mockClient, TEST_INSTRUCTION_ID);
            expect(res.data.provider_classification).toBe('NOT_RECORDED');
            expect(res.data.resolved_provider).toBe('NOT_RECORDED');
            expect(res.data.provider_mode).toBe('NOT_RECORDED');
        });
    });

    // =========================================================================
    // 4. TOOL 3: getSagaExecutionEvidence
    // =========================================================================
    describe('Capability 6: getSagaExecutionEvidence & Generic Saga vs Invoices', () => {
        test('generic instruction with no invoice association returns INCOMPLETE_GENERIC_SAGA', async () => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({ rows: [] }),
            };

            const res = await getSagaExecutionEvidence(mockClient, TEST_INSTRUCTION_ID);
            expect(res.success).toBe(true);
            expect(res.status).toBe('INCOMPLETE_GENERIC_SAGA');
            expect(res.steps).toEqual([]);
            expect(res.message).toContain(
                'Generic payment instructions do not persist intermediate Saga step history'
            );
        });

        test('invoice lookup returns steps and clarifies escrow_flagged is an internal pipeline hold', async () => {
            const mockClient = {
                query: jest.fn(async (sql, params) => {
                    if (sql.includes('LIMIT 2')) {
                        return {
                            rows: [
                                {
                                    invoice_id: TEST_INVOICE_ID,
                                    saga_id: TEST_SAGA_ID,
                                    state: 'IN_PROGRESS',
                                },
                            ],
                        };
                    }
                    if (sql.includes('FROM invoices WHERE invoice_id')) {
                        return {
                            rows: [
                                {
                                    invoice_id: TEST_INVOICE_ID,
                                    saga_id: TEST_SAGA_ID,
                                    state: 'IN_PROGRESS',
                                },
                            ],
                        };
                    }
                    if (sql.includes('FROM invoice_saga_steps')) {
                        return {
                            rows: [
                                {
                                    step_id: 'STEP_01',
                                    amount_pct: '30.00',
                                    condition: 'ADVANCE',
                                    rail: 'STRIPE',
                                    status: 'COMPLETED',
                                    escrow_flagged: false,
                                },
                                {
                                    step_id: 'STEP_02',
                                    amount_pct: '70.00',
                                    condition: 'DELIVERY',
                                    rail: 'STRIPE',
                                    status: 'PENDING',
                                    escrow_flagged: true,
                                },
                            ],
                        };
                    }
                    return { rows: [] };
                }),
            };

            const res = await getSagaExecutionEvidence(mockClient, TEST_INVOICE_ID);
            expect(res.success).toBe(true);
            expect(res.status).toBe('SAGA_EVIDENCE_AVAILABLE');
            expect(res.steps.length).toBe(2);
            expect(res.steps[1].escrow_flagged).toBe(true);
            // Must contain disclaimer that escrow_flagged does not prove legal custody
            expect(res.steps[1].escrow_disclaimer).toContain(
                'does not establish third-party legal escrow custody'
            );
            expect(res.steps[0].escrow_disclaimer).toBeNull();
        });

        test('handles collision between invoice_id and saga_id with AMBIGUOUS_IDENTIFIER_MATCH', async () => {
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('LIMIT 2')) {
                        return {
                            rows: [
                                { invoice_id: 'COLLIDE-ID', saga_id: 'SAGA-101' },
                                { invoice_id: 'INV-202', saga_id: 'COLLIDE-ID' },
                            ],
                        };
                    }
                    return { rows: [] };
                }),
            };

            const res = await getSagaExecutionEvidence(mockClient, 'COLLIDE-ID');
            expect(res.success).toBe(false);
            expect(res.status).toBe('AMBIGUOUS_IDENTIFIER_MATCH');
            expect(res.candidates.length).toBe(2);
        });
    });

    // =========================================================================
    // 5. TOOL 4: getSettlementAndWebhookEvidence
    // =========================================================================
    describe('Capability 8: getSettlementAndWebhookEvidence Delivery Tracking & Provider Bounds', () => {
        test('returns persisted webhook events and documents duplicate drop policy', async () => {
            const processedAt = new Date('2026-11-01T12:00:00Z');
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    provider: 'FIAT',
                                    external_intent_id: 'pi_test123',
                                    currency: 'USD',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('FROM processed_webhook_events')) {
                        return {
                            rows: [
                                {
                                    event_id: 'evt_stripe_1',
                                    provider: 'STRIPE',
                                    event_type: 'payment_intent.succeeded',
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    external_intent_id: 'pi_test123',
                                    payload_hash: sha256('webhook_payload_sample'),
                                    processed_at: processedAt,
                                },
                            ],
                        };
                    }
                    return { rows: [] };
                }),
            };

            const res = await getSettlementAndWebhookEvidence(mockClient, {
                instructionId: TEST_INSTRUCTION_ID,
            });
            expect(res.success).toBe(true);
            expect(res.status).toBe('WEBHOOK_RECORDED');
            expect(res.events_count).toBe(1);
            expect(res.events[0].event_id).toBe('evt_stripe_1');
            expect(res.delivery_tracking_note).toContain(
                'Duplicate delivery count is not persisted by PostgreSQL'
            );
        });

        test('does NOT return NO_WEBHOOKS_STELLAR_RPC merely for XLM & CRYPTO without explicit provider proof', async () => {
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    provider: 'CRYPTO',
                                    external_intent_id: 'some_hash',
                                    currency: 'XLM',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('FROM processed_webhook_events')) {
                        return { rows: [] };
                    }
                    return { rows: [] };
                }),
            };

            const res = await getSettlementAndWebhookEvidence(mockClient, {
                instructionId: TEST_INSTRUCTION_ID,
            });
            expect(res.success).toBe(true);
            // AI-0.3.1 RULE: Must return WEBHOOK_NOT_RECORDED with UNVERIFIED_BROAD_CATEGORY
            expect(res.status).toBe('WEBHOOK_NOT_RECORDED');
            expect(res.provider_identity).toBe('UNVERIFIED_BROAD_CATEGORY');
        });
    });

    // =========================================================================
    // 6. TOOL 5: verifyLedgerIntegrity & Five Dimensions (Including PRED-01 to PRED-07)
    // =========================================================================
    describe('Capability 11: verifyLedgerIntegrity Five Dimensions & Synthetic PRED-01..07', () => {
        // Helper to create synthetic valid 2-entry ledger postings
        function createPostingPair({
            instructionId = TEST_INSTRUCTION_ID,
            gross = '110.00',
            net = '100.00',
            currency = 'USD',
            prevHash = 'PRED_HASH_001',
            seq1 = 101,
            seq2 = 102,
            timestamp = new Date('2026-11-01T12:00:00Z').toISOString(),
        }) {
            const entryId1 = 'e1-uuid';
            const entryId2 = 'e2-uuid';
            const canonicalGross = toCanonicalDecimal(gross, currency);
            const canonicalNet = toCanonicalDecimal(net, currency);

            const payload1 = `${prevHash}${entryId1}${instructionId}Sender_CorpDEBIT${canonicalGross}${currency}${timestamp}`;
            const hash1 = sha256(payload1);

            const payload2 = `${hash1}${entryId2}${instructionId}Recipient_CorpCREDIT${canonicalNet}${currency}${timestamp}`;
            const hash2 = sha256(payload2);

            return [
                {
                    entry_id: entryId1,
                    instruction_id: instructionId,
                    account_id: 'Sender_Corp',
                    direction: 'DEBIT',
                    amount: canonicalGross,
                    currency,
                    timestamp,
                    hash: hash1,
                    prev_hash: prevHash,
                    sequence_id: seq1,
                },
                {
                    entry_id: entryId2,
                    instruction_id: instructionId,
                    account_id: 'Recipient_Corp',
                    direction: 'CREDIT',
                    amount: canonicalNet,
                    currency,
                    timestamp,
                    hash: hash2,
                    prev_hash: hash1,
                    sequence_id: seq2,
                },
            ];
        }

        test('Dimension 1 & 2: Balanced with Tax satisfies posting consistency but NOT conventional double-entry equality', async () => {
            const entries = createPostingPair({ gross: '110.00', net: '100.00', currency: 'USD' });
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '10.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    if (sql.includes('NOT EXISTS (')) {
                        return { rows: [{ '?column?': 1 }] }; // Predecessor immediate match
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.success).toBe(true);
            expect(res.status).toBe('LEDGER_VERIFIED');
            // Dimension 1: Application posting consistency
            expect(res.dimensions.application_posting_consistency).toBe('CONSISTENT');
            // Dimension 2: Conventional double-entry equality MUST be reported unbalanced
            expect(res.dimensions.conventional_double_entry_balance).toBe(
                'UNBALANCED_NO_TAX_LIABILITY_POSTING'
            );
            expect(res.arithmetic_summary.debits_equal_credits).toBe(false);
            // Dimension 3, 4, 5
            expect(res.dimensions.entry_hash_validity).toBe('VALID');
            expect(res.dimensions.internal_link_continuity).toBe('CONTINUOUS');
            expect(res.dimensions.immediate_global_predecessor).toBe('PREDECESSOR_VERIFIED');
        });

        test('Missing tax data returns UNVERIFIABLE_MISSING_TAX_DATA', async () => {
            const entries = createPostingPair({ gross: '100.00', net: '100.00', currency: 'USD' });
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: null,
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    if (sql.includes('NOT EXISTS (')) {
                        return { rows: [{ '?column?': 1 }] };
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.dimensions.application_posting_consistency).toBe(
                'UNVERIFIABLE_MISSING_TAX_DATA'
            );
            expect(res.arithmetic_summary.tax_withheld_status).toBe('TAX_DATA_UNAVAILABLE');
        });

        test('Unexpected ledger entry count returns UNEXPECTED_ENTRY_COUNT', async () => {
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '0.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        // Only 1 entry instead of 2
                        return {
                            rows: [
                                {
                                    entry_id: 'e1',
                                    direction: 'DEBIT',
                                    amount: '100.00',
                                    currency: 'USD',
                                    sequence_id: 101,
                                },
                            ],
                        };
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.success).toBe(false);
            expect(res.status).toBe('UNEXPECTED_ENTRY_COUNT');
            expect(res.entries_found).toBe(1);
        });

        test('Currency mismatch across instruction and ledger returns CURRENCY_MISMATCH', async () => {
            const entries = createPostingPair({ gross: '100.00', net: '100.00', currency: 'EUR' });
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        // Instruction expects USD, ledger entries are in EUR
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '0.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.success).toBe(false);
            expect(res.status).toBe('CURRENCY_MISMATCH');
        });

        // ---------------------------------------------------------------------
        // SYNTHETIC PREDECESSOR CASES: PRED-01 THROUGH PRED-07
        // ---------------------------------------------------------------------
        test('PRED-01: Correct immediate predecessor returns PREDECESSOR_VERIFIED', async () => {
            const entries = createPostingPair({ prevHash: 'HASH_100', seq1: 101, seq2: 102 });
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '0.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    if (sql.includes('NOT EXISTS (')) {
                        // Immediate match exists
                        return { rows: [{ '?column?': 1 }] };
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.dimensions.immediate_global_predecessor).toBe('PREDECESSOR_VERIFIED');
        });

        test('PRED-02: Valid sequence gap returns PREDECESSOR_VERIFIED when no intervening rows exist', async () => {
            // Pred seq 100, curr seq 108. Rollbacks consumed 101-107.
            const entries = createPostingPair({ prevHash: 'HASH_100', seq1: 108, seq2: 109 });
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '0.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    if (sql.includes('NOT EXISTS (')) {
                        // Subquery for intermediate rows returns empty, so NOT EXISTS succeeds
                        return { rows: [{ '?column?': 1 }] };
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.dimensions.immediate_global_predecessor).toBe('PREDECESSOR_VERIFIED');
        });

        test('PRED-03: Existing but non-immediate predecessor returns PREDECESSOR_NOT_IMMEDIATE', async () => {
            const entries = createPostingPair({ prevHash: 'HASH_100', seq1: 105, seq2: 106 });
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '0.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    if (sql.includes('NOT EXISTS (')) {
                        // Immediate check fails because intermediate row at 103 exists
                        return { rows: [] };
                    }
                    if (sql.includes('sequence_id') && sql.includes('WHERE hash = $1')) {
                        // Diagnostic confirms HASH_100 exists at sequence_id 100 (< 105)
                        return { rows: [{ sequence_id: 100 }] };
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.dimensions.immediate_global_predecessor).toBe('PREDECESSOR_NOT_IMMEDIATE');
        });

        test('PRED-04: Missing predecessor returns PREDECESSOR_HASH_NOT_FOUND', async () => {
            const entries = createPostingPair({
                prevHash: 'NONEXISTENT_HASH',
                seq1: 101,
                seq2: 102,
            });
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '0.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    if (sql.includes('NOT EXISTS (')) {
                        return { rows: [] };
                    }
                    if (sql.includes('SELECT sequence_id FROM ledger_journal WHERE hash')) {
                        return { rows: [] }; // Hash does not exist anywhere
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.dimensions.immediate_global_predecessor).toBe('PREDECESSOR_HASH_NOT_FOUND');
        });

        test('PRED-05: Later record with matching hash returns PREDECESSOR_SEQUENCE_VIOLATION', async () => {
            const entries = createPostingPair({ prevHash: 'FUTURE_HASH', seq1: 105, seq2: 106 });
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '0.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    if (sql.includes('NOT EXISTS (')) {
                        return { rows: [] };
                    }
                    if (sql.includes('sequence_id') && sql.includes('WHERE hash = $1')) {
                        // Hash exists but at sequence_id 110 (which is >= 105)
                        return { rows: [{ sequence_id: 110 }] };
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.dimensions.immediate_global_predecessor).toBe(
                'PREDECESSOR_SEQUENCE_VIOLATION'
            );
        });

        test('PRED-06: Genesis entry with sequence ID > 1 and no earlier committed rows returns GENESIS_VERIFIED', async () => {
            const entries = createPostingPair({ prevHash: 'GENESIS_HASH', seq1: 5, seq2: 6 });
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '0.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    if (sql.includes('SELECT NOT EXISTS')) {
                        // Genesis check: no earlier rows exist before sequence 5
                        return { rows: [{ is_valid_genesis: true }] };
                    }
                    if (sql.includes('NOT EXISTS (')) {
                        // Entry 2 follows Entry 1 immediately
                        return { rows: [{ '?column?': 1 }] };
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.dimensions.immediate_global_predecessor).toBe('GENESIS_VERIFIED');
            expect(res.dimensions.predecessor_detail.entry_1).toBe('GENESIS_VERIFIED');
            expect(res.dimensions.predecessor_detail.entry_2).toBe('PREDECESSOR_VERIFIED');
        });

        test('PRED-07: Genesis sentinel when earlier committed row exists returns INVALID_GENESIS_PREDECESSOR_EXISTS', async () => {
            const entries = createPostingPair({ prevHash: 'GENESIS_HASH', seq1: 5, seq2: 6 });
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '0.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    if (sql.includes('SELECT NOT EXISTS')) {
                        // Row exists at sequence 2, so is_valid_genesis is false
                        return { rows: [{ is_valid_genesis: false }] };
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.dimensions.immediate_global_predecessor).toBe(
                'INVALID_GENESIS_PREDECESSOR_EXISTS'
            );
        });
    });

    // =========================================================================
    // 6B. AI-1A.1 CORRECTIONS: ENTRY 2 PREDECESSOR & DEBITS_EQUAL_CREDITS
    // =========================================================================
    describe('AI-1A.1: Global Predecessor Continuity for Both Entry 1 & Entry 2', () => {
        function createPostingPair({
            instructionId = TEST_INSTRUCTION_ID,
            gross = '100.00',
            net = '100.00',
            currency = 'USD',
            prevHash = 'PRED_HASH_001',
            seq1 = 101,
            seq2 = 102,
            timestamp = new Date('2026-11-01T12:00:00Z').toISOString(),
        }) {
            const entryId1 = 'e1-uuid';
            const entryId2 = 'e2-uuid';
            const canonicalGross = toCanonicalDecimal(gross, currency);
            const canonicalNet = toCanonicalDecimal(net, currency);

            const payload1 = `${prevHash}${entryId1}${instructionId}Sender_CorpDEBIT${canonicalGross}${currency}${timestamp}`;
            const hash1 = sha256(payload1);

            const payload2 = `${hash1}${entryId2}${instructionId}Recipient_CorpCREDIT${canonicalNet}${currency}${timestamp}`;
            const hash2 = sha256(payload2);

            return [
                {
                    entry_id: entryId1,
                    instruction_id: instructionId,
                    account_id: 'Sender_Corp',
                    direction: 'DEBIT',
                    amount: canonicalGross,
                    currency,
                    timestamp,
                    hash: hash1,
                    prev_hash: prevHash,
                    sequence_id: seq1,
                },
                {
                    entry_id: entryId2,
                    instruction_id: instructionId,
                    account_id: 'Recipient_Corp',
                    direction: 'CREDIT',
                    amount: canonicalNet,
                    currency,
                    timestamp,
                    hash: hash2,
                    prev_hash: hash1,
                    sequence_id: seq2,
                },
            ];
        }

        test('Entry 1 and Entry 2 consecutively committed: valid PREDECESSOR_VERIFIED', async () => {
            const entries = createPostingPair({ seq1: 201, seq2: 202 });
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '0.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    if (sql.includes('NOT EXISTS (')) {
                        return { rows: [{ '?column?': 1 }] };
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.success).toBe(true);
            expect(res.status).toBe('LEDGER_VERIFIED');
            expect(res.dimensions.immediate_global_predecessor).toBe('PREDECESSOR_VERIFIED');
            expect(res.dimensions.predecessor_detail.entry_1).toBe('PREDECESSOR_VERIFIED');
            expect(res.dimensions.predecessor_detail.entry_2).toBe('PREDECESSOR_VERIFIED');
            expect(res.dimensions.internal_link_continuity).toBe('CONTINUOUS');
        });

        test('Sequence gaps between unrelated consumed sequence values: valid PREDECESSOR_VERIFIED', async () => {
            // Pred seq 100, Entry 1 seq 105 (gap 101-104), Entry 2 seq 110 (gap 106-109)
            const entries = createPostingPair({ prevHash: 'H_100', seq1: 105, seq2: 110 });
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '0.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    if (sql.includes('NOT EXISTS (')) {
                        // Intermediate rows don't exist in DB (consumed by rollbacks)
                        return { rows: [{ '?column?': 1 }] };
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.success).toBe(true);
            expect(res.status).toBe('LEDGER_VERIFIED');
            expect(res.dimensions.immediate_global_predecessor).toBe('PREDECESSOR_VERIFIED');
            expect(res.dimensions.predecessor_detail.entry_1).toBe('PREDECESSOR_VERIFIED');
            expect(res.dimensions.predecessor_detail.entry_2).toBe('PREDECESSOR_VERIFIED');
        });

        test('A committed unrelated row between Entry 1 and Entry 2: invalid PREDECESSOR_NOT_IMMEDIATE', async () => {
            const entries = createPostingPair({ prevHash: 'H_100', seq1: 101, seq2: 103 });
            const entry1Hash = entries[0].hash;

            const mockClient = {
                query: jest.fn(async (sql, params) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '0.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    if (sql.includes('NOT EXISTS (')) {
                        // Entry 1 check passes
                        if (params && params[0] === 'H_100') {
                            return { rows: [{ '?column?': 1 }] };
                        }
                        // Entry 2 check fails because row 102 was committed between Entry 1 and Entry 2
                        return { rows: [] };
                    }
                    if (sql.includes('sequence_id') && sql.includes('WHERE hash = $1')) {
                        // Diagnostic confirms Entry 1 hash exists at seq 101 (< 103)
                        return { rows: [{ sequence_id: 101 }] };
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.success).toBe(true);
            expect(res.status).toBe('LEDGER_INTEGRITY_MISMATCH');
            expect(res.dimensions.immediate_global_predecessor).toBe('PREDECESSOR_NOT_IMMEDIATE');
            expect(res.dimensions.predecessor_detail.entry_1).toBe('PREDECESSOR_VERIFIED');
            expect(res.dimensions.predecessor_detail.entry_2).toBe('PREDECESSOR_NOT_IMMEDIATE');
            expect(res.dimensions.internal_link_continuity).toBe('INTERNAL_LINK_NOT_IMMEDIATE');
        });

        test('Entry 2 points to Entry 1 hash but another committed row intervenes: invalid', async () => {
            const entries = createPostingPair({ seq1: 301, seq2: 305 });
            const mockClient = {
                query: jest.fn(async (sql, params) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '0.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    if (sql.includes('NOT EXISTS (')) {
                        if (params && params[0] === 'PRED_HASH_001') {
                            return { rows: [{ '?column?': 1 }] };
                        }
                        return { rows: [] }; // Intervening row exists
                    }
                    if (sql.includes('sequence_id') && sql.includes('WHERE hash = $1')) {
                        return { rows: [{ sequence_id: 301 }] };
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.dimensions.immediate_global_predecessor).toBe('PREDECESSOR_NOT_IMMEDIATE');
            expect(res.status).toBe('LEDGER_INTEGRITY_MISMATCH');
        });

        test('Entry 2 has incorrect prev_hash: invalid PREDECESSOR_HASH_NOT_FOUND and INTERNAL_LINK_BROKEN', async () => {
            const entries = createPostingPair({ seq1: 101, seq2: 102 });
            entries[1].prev_hash = 'CORRUPTED_ENTRY_2_PREV_HASH';

            const mockClient = {
                query: jest.fn(async (sql, params) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '0.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    if (sql.includes('NOT EXISTS (')) {
                        if (params && params[0] === 'PRED_HASH_001') {
                            return { rows: [{ '?column?': 1 }] };
                        }
                        return { rows: [] };
                    }
                    if (sql.includes('sequence_id') && sql.includes('WHERE hash = $1')) {
                        return { rows: [] }; // Hash not found
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.dimensions.immediate_global_predecessor).toBe('PREDECESSOR_HASH_NOT_FOUND');
            expect(res.dimensions.internal_link_continuity).toBe('INTERNAL_LINK_BROKEN');
            expect(res.status).toBe('LEDGER_INTEGRITY_MISMATCH');
        });

        test('Entry 1 is a valid genesis entry with sequence ID greater than one: valid', async () => {
            const entries = createPostingPair({ prevHash: 'GENESIS_HASH', seq1: 15, seq2: 16 });
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '0.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    if (sql.includes('SELECT NOT EXISTS')) {
                        return { rows: [{ is_valid_genesis: true }] };
                    }
                    if (sql.includes('NOT EXISTS (')) {
                        return { rows: [{ '?column?': 1 }] };
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.success).toBe(true);
            expect(res.dimensions.immediate_global_predecessor).toBe('GENESIS_VERIFIED');
            expect(res.dimensions.predecessor_detail.entry_1).toBe('GENESIS_VERIFIED');
            expect(res.dimensions.predecessor_detail.entry_2).toBe('PREDECESSOR_VERIFIED');
        });

        test('Entry 2 follows a genesis Entry 1 immediately: valid', async () => {
            const entries = createPostingPair({ prevHash: 'GENESIS_HASH', seq1: 1, seq2: 2 });
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '0.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    if (sql.includes('SELECT NOT EXISTS')) {
                        return { rows: [{ is_valid_genesis: true }] };
                    }
                    if (sql.includes('NOT EXISTS (')) {
                        return { rows: [{ '?column?': 1 }] };
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.success).toBe(true);
            expect(res.status).toBe('LEDGER_VERIFIED');
            expect(res.dimensions.predecessor_detail.entry_2).toBe('PREDECESSOR_VERIFIED');
        });

        test('Accounting terminology: tax = 0 returns DEBITS_EQUAL_CREDITS', async () => {
            const entries = createPostingPair({ gross: '500.00', net: '500.00', currency: 'USD' });
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '0.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    if (sql.includes('NOT EXISTS (')) {
                        return { rows: [{ '?column?': 1 }] };
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.dimensions.conventional_double_entry_balance).toBe('DEBITS_EQUAL_CREDITS');
            expect(res.dimensions.debits_equal_credits).toBe('DEBITS_EQUAL_CREDITS');
            expect(res.arithmetic_summary.debits_equal_credits).toBe(true);
        });

        test('Accounting terminology: tax > 0 returns UNBALANCED_NO_TAX_LIABILITY_POSTING', async () => {
            const entries = createPostingPair({ gross: '550.00', net: '500.00', currency: 'USD' });
            const mockClient = {
                query: jest.fn(async (sql) => {
                    if (sql.includes('FROM instructions')) {
                        return {
                            rows: [
                                {
                                    instruction_id: TEST_INSTRUCTION_ID,
                                    currency: 'USD',
                                    tax_withheld: '50.00',
                                    state: 'SETTLED',
                                },
                            ],
                        };
                    }
                    if (sql.includes('ledger_journal') && sql.includes('WHERE instruction_id')) {
                        return { rows: entries };
                    }
                    if (sql.includes('NOT EXISTS (')) {
                        return { rows: [{ '?column?': 1 }] };
                    }
                    return { rows: [] };
                }),
            };

            const res = await verifyLedgerIntegrity(mockClient, TEST_INSTRUCTION_ID);
            expect(res.dimensions.conventional_double_entry_balance).toBe(
                'UNBALANCED_NO_TAX_LIABILITY_POSTING'
            );
            expect(res.dimensions.debits_equal_credits).toBe('UNBALANCED_NO_TAX_LIABILITY_POSTING');
            expect(res.arithmetic_summary.debits_equal_credits).toBe(false);
        });
    });

    // =========================================================================
    // 7. TOOL 6: getReconciliationEvidence
    // =========================================================================
    describe('Capability 9: getReconciliationEvidence & Scenario SC-08 Contract', () => {
        test('SC-08: Reconciliation FAILED with instruction SETTLED isolates sync failure without declaring settlement failed', async () => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({
                    rows: [
                        {
                            id: 'recon-uuid-001',
                            instruction_id: TEST_INSTRUCTION_ID,
                            zoho_invoice_id: 'ZOHO-INV-99',
                            zoho_payment_id: null,
                            reconciled_at: null,
                            status: 'FAILED',
                            error_message: 'Zoho API timeout on invoice sync',
                            instruction_state: 'SETTLED',
                        },
                    ],
                }),
            };

            const res = await getReconciliationEvidence(mockClient, TEST_INSTRUCTION_ID);
            expect(res.success).toBe(true);
            expect(res.status).toBe('RECONCILIATION_AVAILABLE');
            expect(res.reconciliation.status).toBe('FAILED');
            expect(res.reconciliation.instruction_state).toBe('SETTLED');
            // Strict SC-08 finding text check
            expect(res.reconciliation.finding).toBe(
                'Project Fusion records the instruction state as SETTLED. The Zoho reconciliation record reports FAILED. The available records show an accounting synchronization failure but do not independently establish external settlement finality.'
            );
        });

        test('returns NOT_RECORDED when no reconciliation row exists', async () => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({ rows: [] }),
            };

            const res = await getReconciliationEvidence(mockClient, TEST_INSTRUCTION_ID);
            expect(res.success).toBe(true);
            expect(res.status).toBe('NOT_RECORDED');
            expect(res.reconciliation).toBeNull();
        });
    });

    // =========================================================================
    // 8. TOOL 7: explainIsoValidationErrors
    // =========================================================================
    describe('Capability 10: explainIsoValidationErrors Persisted Errors & Collision Handling', () => {
        test('extracts structured address errors from iso_enriched without running live XML parser', async () => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({
                    rows: [
                        {
                            invoice_id: TEST_INVOICE_ID,
                            saga_id: TEST_SAGA_ID,
                            state: 'PARSED',
                            iso_enriched: {
                                validationErrors: [
                                    'seller.structuredAddress.streetName is required (ISO 20022 Nov 2026 mandate)',
                                    'seller.structuredAddress.postCode for India must be 6 digits',
                                ],
                            },
                        },
                    ],
                }),
            };

            const res = await explainIsoValidationErrors(mockClient, TEST_INVOICE_ID);
            expect(res.success).toBe(true);
            expect(res.status).toBe('ISO_VALIDATION_ERRORS_PERSISTED');
            expect(res.data.error_count).toBe(2);
            expect(res.data.persisted_errors[0].category).toBe(
                'MANDATORY_STRUCTURED_ADDRESS_SYNTAX'
            );
            expect(res.data.disclaimer).toContain(
                'does not represent an independent regulatory compliance or customs clearance determination'
            );
        });

        test('returns ISO_ENRICHED_NO_ERRORS when validationErrors array is empty', async () => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({
                    rows: [
                        {
                            invoice_id: TEST_INVOICE_ID,
                            saga_id: TEST_SAGA_ID,
                            state: 'PARSED',
                            iso_enriched: { validationErrors: [] },
                        },
                    ],
                }),
            };

            const res = await explainIsoValidationErrors(mockClient, TEST_INVOICE_ID);
            expect(res.success).toBe(true);
            expect(res.status).toBe('ISO_ENRICHED_NO_ERRORS');
            expect(res.data.has_validation_errors).toBe(false);
        });

        test('returns AMBIGUOUS_IDENTIFIER_MATCH when collision occurs across invoice records', async () => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({
                    rows: [
                        { invoice_id: 'AMBIG-ID', saga_id: 'SAGA-1' },
                        { invoice_id: 'INV-2', saga_id: 'AMBIG-ID' },
                    ],
                }),
            };

            const res = await explainIsoValidationErrors(mockClient, 'AMBIG-ID');
            expect(res.success).toBe(false);
            expect(res.status).toBe('AMBIGUOUS_IDENTIFIER_MATCH');
            expect(res.candidates.length).toBe(2);
        });
    });

    // =========================================================================
    // 9. PURE HASH HELPER UNIT TESTS
    // =========================================================================
    describe('Ledger Hash Helper: Canonical Decimal & Historical Fallback Verification', () => {
        test('canonical payload hash matches exact ledgerUtils writeLedger specification', () => {
            const entry = {
                entry_id: 'e1-uuid',
                instruction_id: TEST_INSTRUCTION_ID,
                account_id: 'Alice_Corp',
                direction: 'DEBIT',
                amount: '100.5',
                currency: 'USD',
                prev_hash: 'GENESIS_HASH',
                timestamp: '2026-11-01T12:00:00.000Z',
            };

            // Canonical scale 2 representation for USD is '100.50'
            const expectedPayload =
                'GENESIS_HASH' +
                'e1-uuid' +
                TEST_INSTRUCTION_ID +
                'Alice_Corp' +
                'DEBIT' +
                '100.50' +
                'USD' +
                '2026-11-01T12:00:00.000Z';
            const expectedHash = sha256(expectedPayload);

            const result = computePayloadHash(entry, '2026-11-01T12:00:00.000Z');
            expect(result.hash).toBe(expectedHash);
            expect(result.format).toBe('CANONICAL');
        });

        test('historical fallback 1: matches legacy parseFloat hash if stored hash matches legacy format', () => {
            const legacyAmt = parseFloat('100.50'); // '100.5' in JS string
            const ts = '2026-11-01T12:00:00.000Z';
            const legacyPayload =
                'PREV' + 'e1' + 'inst1' + 'Alice' + 'DEBIT' + legacyAmt + 'USD' + ts;
            const legacyHash = sha256(legacyPayload);

            const entry = {
                entry_id: 'e1',
                instruction_id: 'inst1',
                account_id: 'Alice',
                direction: 'DEBIT',
                amount: '100.50',
                currency: 'USD',
                prev_hash: 'PREV',
                hash: legacyHash, // Stored hash matches legacy format
                timestamp: ts,
            };

            const result = computePayloadHash(entry, ts);
            expect(result.hash).toBe(legacyHash);
            expect(result.format).toBe('LEGACY_FLOAT');
        });
    });
});
