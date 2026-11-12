'use strict';

/**
 * PROJECT FUSION — MILESTONE MR2.2 TEST SUITE
 * ============================================================
 * Comprehensive unit and regression tests verifying:
 * 1. Fail-closed amount and currency validation
 * 2. Exact monetary arithmetic without floating-point math
 * 3. Normalized refund tracking and compensating double-entry ledger
 * 4. Multi-step partial refund state machine
 */

const {
    toCanonicalDecimal,
    toCanonicalMinorUnits,
    fromCanonicalMinorUnits,
    getAssetScale,
} = require('../../core/orchestrator/financialDecimal');
const { toStripeMinorUnits } = require('../../adapters/paymentsAdapters');
const { processWebhookEvent } = require('../../core/webhooks/webhookProcessor');
const {
    writeLedger,
    writeCompensatingLedger,
    verifyLedgerIntegrity,
} = require('../../core/orchestrator/ledgerUtils');

function createMockPool(initialState = {}) {
    const db = {
        instructions: new Map(
            (initialState.instructions || []).map((i) => [i.instruction_id, { ...i }])
        ),
        processed_webhook_events: new Map(
            (initialState.processed_webhook_events || []).map((e) => [
                `${e.provider}:${e.event_id}`,
                { ...e },
            ])
        ),
        ledger_journal: [],
    };

    let ledgerWriteCount = 0;
    let compensatingLedgerWriteCount = 0;
    let ledgerVerifyCount = 0;
    let shouldFailLedgerWrite = false;

    const pool = {
        getDb: () => db,
        getLedgerWriteCount: () => ledgerWriteCount,
        getCompensatingLedgerWriteCount: () => compensatingLedgerWriteCount,
        getLedgerVerifyCount: () => ledgerVerifyCount,
        setFailLedgerWrite: (val) => {
            shouldFailLedgerWrite = val;
        },
        connect: async () => {
            let inTxn = false;
            let stagedInstructions = new Map();
            let stagedEvents = new Map();
            let stagedJournal = [];

            return {
                query: async (sql, params = []) => {
                    const normalized = sql.trim().toUpperCase();

                    if (normalized === 'BEGIN') {
                        inTxn = true;
                        stagedInstructions = new Map();
                        for (const [k, v] of db.instructions) stagedInstructions.set(k, { ...v });
                        stagedEvents = new Map();
                        for (const [k, v] of db.processed_webhook_events)
                            stagedEvents.set(k, { ...v });
                        stagedJournal = [...db.ledger_journal];
                        return { rows: [] };
                    }

                    if (normalized === 'COMMIT') {
                        if (inTxn) {
                            for (const [k, v] of stagedInstructions)
                                db.instructions.set(k, { ...v });
                            for (const [k, v] of stagedEvents)
                                db.processed_webhook_events.set(k, { ...v });
                            db.ledger_journal = stagedJournal;
                            inTxn = false;
                        }
                        return { rows: [] };
                    }

                    if (normalized === 'ROLLBACK') {
                        inTxn = false;
                        stagedInstructions.clear();
                        stagedEvents.clear();
                        stagedJournal = [];
                        return { rows: [] };
                    }

                    if (normalized.startsWith('SELECT PG_ADVISORY_XACT_LOCK')) {
                        return { rows: [] };
                    }

                    if (normalized.startsWith('SELECT HASH FROM LEDGER_JOURNAL')) {
                        const targetJournal = inTxn ? stagedJournal : db.ledger_journal;
                        const last = targetJournal[targetJournal.length - 1];
                        return { rows: last ? [{ hash: last.hash }] : [{ hash: 'GENESIS_HASH' }] };
                    }

                    if (normalized.startsWith('INSERT INTO LEDGER_JOURNAL')) {
                        const [
                            entryId,
                            instructionId,
                            accountId,
                            direction,
                            amount,
                            currency,
                            timestamp,
                            hash,
                            prevHash,
                        ] = params;
                        const targetJournal = inTxn ? stagedJournal : db.ledger_journal;
                        targetJournal.push({
                            entry_id: entryId,
                            instruction_id: instructionId,
                            account_id: accountId,
                            direction,
                            amount: parseFloat(amount),
                            currency,
                            timestamp,
                            hash,
                            prev_hash: prevHash,
                        });
                        return { rows: [] };
                    }

                    if (normalized.includes('FROM LEDGER_JOURNAL') && normalized.includes('SUM(')) {
                        const [instructionId, currency] = params;
                        const targetJournal = inTxn ? stagedJournal : db.ledger_journal;
                        const matching = targetJournal.filter(
                            (j) => j.instruction_id === instructionId && j.currency === currency
                        );
                        const total_debit = matching
                            .filter((j) => j.direction === 'DEBIT')
                            .reduce((sum, j) => sum + j.amount, 0);
                        const total_credit = matching
                            .filter((j) => j.direction === 'CREDIT')
                            .reduce((sum, j) => sum + j.amount, 0);
                        return { rows: [{ total_debit, total_credit }] };
                    }

                    if (normalized.startsWith('INSERT INTO PROCESSED_WEBHOOK_EVENTS')) {
                        const [eventId, provider, eventType, instructionId, intentId, payloadHash] =
                            params;
                        const key = `${provider}:${eventId}`;
                        const targetStore = inTxn ? stagedEvents : db.processed_webhook_events;

                        if (targetStore.has(key)) {
                            return { rows: [] };
                        }
                        const rec = {
                            event_id: eventId,
                            provider,
                            event_type: eventType,
                            instruction_id: instructionId,
                            external_intent_id: intentId,
                            payload_hash: payloadHash,
                        };
                        targetStore.set(key, rec);
                        return { rows: [{ event_id: eventId }] };
                    }

                    if (
                        normalized.startsWith('SELECT * FROM INSTRUCTIONS WHERE EXTERNAL_INTENT_ID')
                    ) {
                        const intentId = params[0];
                        const targetStore = inTxn ? stagedInstructions : db.instructions;
                        const found = Array.from(targetStore.values()).filter(
                            (i) => i.external_intent_id === intentId
                        );
                        return { rows: found.map((f) => ({ ...f })) };
                    }

                    if (normalized.startsWith('SELECT * FROM INSTRUCTIONS WHERE INSTRUCTION_ID')) {
                        const id = params[0];
                        const targetStore = inTxn ? stagedInstructions : db.instructions;
                        const found = Array.from(targetStore.values()).filter(
                            (i) => i.instruction_id === id
                        );
                        return { rows: found.map((f) => ({ ...f })) };
                    }

                    if (normalized.includes("UPDATE INSTRUCTIONS SET STATE = 'SETTLED'")) {
                        const instructionId = params[0];
                        const targetStore = inTxn ? stagedInstructions : db.instructions;
                        if (targetStore.has(instructionId)) {
                            targetStore.get(instructionId).state = 'SETTLED';
                        }
                        return { rows: [] };
                    }

                    if (
                        normalized.includes('UPDATE INSTRUCTIONS SET STATE = $1') ||
                        normalized.includes('UPDATE INSTRUCTIONS SET STATUS = $1')
                    ) {
                        const [targetState, metaStr, instructionId] = params;
                        const targetStore = inTxn ? stagedInstructions : db.instructions;
                        if (targetStore.has(instructionId)) {
                            const inst = targetStore.get(instructionId);
                            inst.state = targetState;
                            inst.status = targetState;
                            try {
                                inst.metadata = JSON.parse(metaStr);
                            } catch {
                                inst.metadata = metaStr;
                            }
                        }
                        return { rows: [] };
                    }

                    if (normalized.includes("UPDATE INSTRUCTIONS SET STATE = 'MANUAL_CHECK'")) {
                        const [errMsg, instructionId] = params;
                        const targetStore = inTxn ? stagedInstructions : db.instructions;
                        if (targetStore.has(instructionId)) {
                            targetStore.get(instructionId).state = 'MANUAL_CHECK';
                            targetStore.get(instructionId).error_message = errMsg;
                        }
                        return { rows: [] };
                    }

                    return { rows: [] };
                },
                release: () => {},
            };
        },
        mockWriteLedger: async () => {
            if (shouldFailLedgerWrite) throw new Error('LEDGER_WRITE_IO_FAILURE');
            ledgerWriteCount++;
        },
        mockWriteCompensatingLedger: async () => {
            if (shouldFailLedgerWrite) throw new Error('LEDGER_WRITE_IO_FAILURE');
            compensatingLedgerWriteCount++;
            return {
                entryIdDebit: 'mock_debit',
                entryIdCredit: 'mock_credit',
                hash: 'mock_hash',
            };
        },
        mockVerifyLedgerIntegrity: async () => {
            ledgerVerifyCount++;
        },
    };
    return pool;
}

describe('Project Fusion — Milestone MR2.2 Webhook Hardening & Compensating Ledger', () => {
    describe('Phase A: Fail-Closed Amount and Currency Validation', () => {
        test('1. Valid USD payment settles to SETTLED with exactly 1 ledger posting', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_valid_usd',
                        external_intent_id: 'pi_valid_usd',
                        state: 'PENDING_SETTLEMENT',
                        amount: '50.00',
                        currency: 'USD',
                        sender: 'ACC_SENDER',
                        recipient: 'ACC_RECIPIENT',
                    },
                ],
            });

            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_valid_usd',
                eventType: 'payment_intent.succeeded',
                intentId: 'pi_valid_usd',
                rawBody: '{}',
                payload: {
                    data: {
                        object: {
                            id: 'pi_valid_usd',
                            amount: 5000,
                            currency: 'usd',
                        },
                    },
                },
                writeLedgerFn: mockPool.mockWriteLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(200);
            expect(res.body.settled).toBe(true);
            expect(mockPool.getLedgerWriteCount()).toBe(1);
            expect(mockPool.getDb().instructions.get('inst_valid_usd').state).toBe('SETTLED');
        });

        test('2. Unsupported currency (SGD on Stripe card adapter) fails closed to MANUAL_CHECK with zero ledger postings', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_unsupported_curr',
                        external_intent_id: 'pi_unsupported_curr',
                        state: 'PENDING_SETTLEMENT',
                        amount: '100.00',
                        currency: 'SGD', // Not supported by Stripe card adapter
                        sender: 'ACC_SENDER',
                        recipient: 'ACC_RECIPIENT',
                    },
                ],
            });

            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_unsupported_curr',
                eventType: 'payment_intent.succeeded',
                intentId: 'pi_unsupported_curr',
                rawBody: '{}',
                payload: {
                    data: {
                        object: {
                            id: 'pi_unsupported_curr',
                            amount: 10000,
                            currency: 'sgd',
                        },
                    },
                },
                writeLedgerFn: mockPool.mockWriteLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(200);
            expect(res.body.mismatch).toBe(true);
            expect(res.body.reason).toBe('CONVERSION_FAILURE');
            expect(mockPool.getLedgerWriteCount()).toBe(0);
            expect(mockPool.getDb().instructions.get('inst_unsupported_curr').state).toBe(
                'MANUAL_CHECK'
            );
        });

        test('3. Non-positive amount (0.00) fails closed to MANUAL_CHECK with zero ledger postings', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_zero_amt',
                        external_intent_id: 'pi_zero_amt',
                        state: 'PENDING_SETTLEMENT',
                        amount: '0.00',
                        currency: 'USD',
                        sender: 'ACC_SENDER',
                        recipient: 'ACC_RECIPIENT',
                    },
                ],
            });

            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_zero_amt',
                eventType: 'payment_intent.succeeded',
                intentId: 'pi_zero_amt',
                rawBody: '{}',
                payload: {
                    data: {
                        object: {
                            id: 'pi_zero_amt',
                            amount: 0,
                            currency: 'usd',
                        },
                    },
                },
                writeLedgerFn: mockPool.mockWriteLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(200);
            expect(res.body.mismatch).toBe(true);
            expect(res.body.reason).toBe('CONVERSION_FAILURE');
            expect(mockPool.getLedgerWriteCount()).toBe(0);
            expect(mockPool.getDb().instructions.get('inst_zero_amt').state).toBe('MANUAL_CHECK');
        });

        test('4. Excessive decimal precision (5.005 USD) fails closed to MANUAL_CHECK with zero ledger postings', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_excess_prec',
                        external_intent_id: 'pi_excess_prec',
                        state: 'PENDING_SETTLEMENT',
                        amount: '5.005', // 3 decimals for USD
                        currency: 'USD',
                        sender: 'ACC_SENDER',
                        recipient: 'ACC_RECIPIENT',
                    },
                ],
            });

            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_excess_prec',
                eventType: 'payment_intent.succeeded',
                intentId: 'pi_excess_prec',
                rawBody: '{}',
                payload: {
                    data: {
                        object: {
                            id: 'pi_excess_prec',
                            amount: 501,
                            currency: 'usd',
                        },
                    },
                },
                writeLedgerFn: mockPool.mockWriteLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(200);
            expect(res.body.mismatch).toBe(true);
            expect(res.body.reason).toBe('CONVERSION_FAILURE');
            expect(mockPool.getLedgerWriteCount()).toBe(0);
            expect(mockPool.getDb().instructions.get('inst_excess_prec').state).toBe(
                'MANUAL_CHECK'
            );
        });

        test('5. Missing amount in webhook payload transitions to MANUAL_CHECK', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_missing_amt',
                        external_intent_id: 'pi_missing_amt',
                        state: 'PENDING_SETTLEMENT',
                        amount: '20.00',
                        currency: 'USD',
                        sender: 'ACC_SENDER',
                        recipient: 'ACC_RECIPIENT',
                    },
                ],
            });

            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_missing_amt',
                eventType: 'payment_intent.succeeded',
                intentId: 'pi_missing_amt',
                rawBody: '{}',
                payload: {
                    data: {
                        object: {
                            id: 'pi_missing_amt',
                            currency: 'usd',
                            // amount is omitted
                        },
                    },
                },
                writeLedgerFn: mockPool.mockWriteLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(200);
            expect(res.body.mismatch).toBe(true);
            expect(res.body.reason).toBe('MISSING_AMOUNT');
            expect(mockPool.getLedgerWriteCount()).toBe(0);
            expect(mockPool.getDb().instructions.get('inst_missing_amt').state).toBe(
                'MANUAL_CHECK'
            );
        });
    });

    describe('Phase B: Exact Monetary Arithmetic and Currency Scales', () => {
        test('1. USD 19.99 converts to exactly 1999 minor units via exact BigInt math', () => {
            const minor = toCanonicalMinorUnits('19.99', 'USD');
            expect(minor).toBe(1999n);
            expect(fromCanonicalMinorUnits(minor, 'USD')).toBe('19.99');
        });

        test('2. INR 100.25 converts to exactly 10025 minor units', () => {
            const minor = toCanonicalMinorUnits('100.25', 'INR');
            expect(minor).toBe(10025n);
            expect(fromCanonicalMinorUnits(minor, 'INR')).toBe('100.25');
        });

        test('3. JPY 1000 converts to exactly 1000 minor units (0-decimal currency)', () => {
            expect(getAssetScale('JPY')).toBe(0);
            const canonical = toCanonicalDecimal('1000', 'JPY');
            expect(canonical).toBe('1000');
            const minor = toCanonicalMinorUnits('1000', 'JPY');
            expect(minor).toBe(1000n);
            expect(fromCanonicalMinorUnits(minor, 'JPY')).toBe('1000');
            expect(toStripeMinorUnits('1000', 'JPY')).toBe(1000);
        });

        test('4. KWD 10.125 converts to exactly 10125 minor units (3-decimal currency) in generic parser', () => {
            expect(getAssetScale('KWD')).toBe(3);
            const canonical = toCanonicalDecimal('10.125', 'KWD');
            expect(canonical).toBe('10.125');
            const minor = toCanonicalMinorUnits('10.125', 'KWD');
            expect(minor).toBe(10125n);
            expect(fromCanonicalMinorUnits(minor, 'KWD')).toBe('10.125');
        });

        test('5. KWD is rejected on Stripe adapter as unsupported presentment rail', () => {
            expect(() => {
                toStripeMinorUnits('10.125', 'KWD');
            }).toThrow(/Unsupported Stripe fiat currency/);
        });

        test('6. Excessive precision and malformed amounts reject with RangeError / TypeError', () => {
            expect(() => toCanonicalDecimal('10.001', 'USD')).toThrow(RangeError);
            expect(() => toCanonicalDecimal('100.1', 'JPY')).toThrow(RangeError);
            expect(() => toCanonicalDecimal('10.1234', 'KWD')).toThrow(RangeError);
            expect(toCanonicalMinorUnits('-5.00', 'USD')).toBe(-500n);
        });
    });

    describe('Phase C, D & E: Normalized Refund Lifecycle and Compensating Ledger', () => {
        test('1. Successful full refund posts compensating ledger and transitions state to REFUNDED', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_full_refund',
                        external_intent_id: 'pi_full_refund',
                        state: 'SETTLED',
                        amount: '100.00',
                        currency: 'USD',
                        sender: 'ACC_TREASURY_USD',
                        recipient: 'ACC_CLEARING_USD',
                        metadata: {},
                    },
                ],
            });

            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_refund_full',
                eventType: 'refund.created',
                intentId: 'pi_full_refund',
                rawBody: '{}',
                payload: {
                    data: {
                        object: {
                            id: 're_full_001',
                            payment_intent: 'pi_full_refund',
                            amount: 10000,
                            currency: 'usd',
                            status: 'succeeded',
                        },
                    },
                },
                writeCompensatingLedgerFn: mockPool.mockWriteCompensatingLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(200);
            expect(res.body.state).toBe('REFUNDED');
            expect(res.body.operation).toBe('COMPENSATING_REFUND');
            expect(mockPool.getCompensatingLedgerWriteCount()).toBe(1);

            const inst = mockPool.getDb().instructions.get('inst_full_refund');
            expect(inst.state).toBe('REFUNDED');
            expect(inst.metadata.cumulative_refunded_minor).toBe(10000);
            expect(inst.metadata.refunds.length).toBe(1);
            expect(inst.metadata.refunds[0].refund_id).toBe('re_full_001');
            expect(inst.metadata.refunds[0].ledger_posted).toBe(true);
        });

        test('2. Two sequential partial refunds accumulate correctly and transition from PARTIALLY_REFUNDED to REFUNDED', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_multi_partial',
                        external_intent_id: 'pi_multi_partial',
                        state: 'SETTLED',
                        amount: '100.00',
                        currency: 'USD',
                        sender: 'ACC_TREASURY_USD',
                        recipient: 'ACC_CLEARING_USD',
                        metadata: {},
                    },
                ],
            });

            // Partial Refund 1: $20.00
            const res1 = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_part_1',
                eventType: 'refund.created',
                intentId: 'pi_multi_partial',
                rawBody: '{}',
                payload: {
                    data: {
                        object: {
                            id: 're_part_001',
                            amount: 2000,
                            currency: 'usd',
                            status: 'succeeded',
                        },
                    },
                },
                writeCompensatingLedgerFn: mockPool.mockWriteCompensatingLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res1.status).toBe(200);
            expect(res1.body.state).toBe('PARTIALLY_REFUNDED');
            expect(res1.body.cumulative_refunded).toBe('20.00');
            expect(mockPool.getCompensatingLedgerWriteCount()).toBe(1);

            // Partial Refund 2: $30.00 (Total now $50.00)
            const res2 = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_part_2',
                eventType: 'refund.created',
                intentId: 'pi_multi_partial',
                rawBody: '{}',
                payload: {
                    data: {
                        object: {
                            id: 're_part_002',
                            amount: 3000,
                            currency: 'usd',
                            status: 'succeeded',
                        },
                    },
                },
                writeCompensatingLedgerFn: mockPool.mockWriteCompensatingLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res2.status).toBe(200);
            expect(res2.body.state).toBe('PARTIALLY_REFUNDED');
            expect(res2.body.cumulative_refunded).toBe('50.00');
            expect(mockPool.getCompensatingLedgerWriteCount()).toBe(2);

            // Remaining Refund 3: $50.00 (Total now $100.00 -> Transitions to REFUNDED)
            const res3 = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_part_3',
                eventType: 'refund.created',
                intentId: 'pi_multi_partial',
                rawBody: '{}',
                payload: {
                    data: {
                        object: {
                            id: 're_part_003',
                            amount: 5000,
                            currency: 'usd',
                            status: 'succeeded',
                        },
                    },
                },
                writeCompensatingLedgerFn: mockPool.mockWriteCompensatingLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res3.status).toBe(200);
            expect(res3.body.state).toBe('REFUNDED');
            expect(res3.body.cumulative_refunded).toBe('100.00');
            expect(mockPool.getCompensatingLedgerWriteCount()).toBe(3);

            const inst = mockPool.getDb().instructions.get('inst_multi_partial');
            expect(inst.state).toBe('REFUNDED');
            expect(inst.metadata.refunds.length).toBe(3);
        });

        test('3. Duplicate refund webhook delivery is ignored without duplicate ledger writes', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_dup_refund',
                        external_intent_id: 'pi_dup_refund',
                        state: 'SETTLED',
                        amount: '50.00',
                        currency: 'USD',
                        sender: 'ACC_TREASURY_USD',
                        recipient: 'ACC_CLEARING_USD',
                        metadata: {},
                    },
                ],
            });

            // Delivery 1
            await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_dup_refund_1',
                eventType: 'refund.created',
                intentId: 'pi_dup_refund',
                rawBody: '{}',
                payload: {
                    data: {
                        object: {
                            id: 're_dup_001',
                            amount: 2500,
                            currency: 'usd',
                            status: 'succeeded',
                        },
                    },
                },
                writeCompensatingLedgerFn: mockPool.mockWriteCompensatingLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(mockPool.getCompensatingLedgerWriteCount()).toBe(1);

            // Delivery 2: Repeat with a new event ID referencing the same refund ID
            await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_dup_refund_2',
                eventType: 'refund.updated',
                intentId: 'pi_dup_refund',
                rawBody: '{}',
                payload: {
                    data: {
                        object: {
                            id: 're_dup_001',
                            amount: 2500,
                            currency: 'usd',
                            status: 'succeeded',
                        },
                    },
                },
                writeCompensatingLedgerFn: mockPool.mockWriteCompensatingLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            // Still exactly 1 compensating ledger write!
            expect(mockPool.getCompensatingLedgerWriteCount()).toBe(1);
        });

        test('4. Over-refund attempt exceeding captured payment flags MANUAL_CHECK and blocks ledger posting', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_over_refund',
                        external_intent_id: 'pi_over_refund',
                        state: 'SETTLED',
                        amount: '50.00',
                        currency: 'USD',
                        sender: 'ACC_TREASURY_USD',
                        recipient: 'ACC_CLEARING_USD',
                        metadata: {},
                    },
                ],
            });

            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_over_refund',
                eventType: 'refund.created',
                intentId: 'pi_over_refund',
                rawBody: '{}',
                payload: {
                    data: {
                        object: {
                            id: 're_over_001',
                            amount: 6000, // $60.00 > $50.00
                            currency: 'usd',
                            status: 'succeeded',
                        },
                    },
                },
                writeCompensatingLedgerFn: mockPool.mockWriteCompensatingLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(200);
            expect(res.body.mismatch).toBe(true);
            expect(res.body.reason).toBe('OVER_REFUND_ATTEMPT');
            expect(mockPool.getCompensatingLedgerWriteCount()).toBe(0);
            expect(mockPool.getDb().instructions.get('inst_over_refund').state).toBe(
                'MANUAL_CHECK'
            );
        });

        test('5. Pending or failed refunds are recorded in metadata but NEVER post to ledger', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_pending_refund',
                        external_intent_id: 'pi_pending_refund',
                        state: 'SETTLED',
                        amount: '100.00',
                        currency: 'USD',
                        sender: 'ACC_TREASURY_USD',
                        recipient: 'ACC_CLEARING_USD',
                        metadata: {},
                    },
                ],
            });

            // Pending refund
            const resPending = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_ref_pending',
                eventType: 'refund.created',
                intentId: 'pi_pending_refund',
                rawBody: '{}',
                payload: {
                    data: {
                        object: {
                            id: 're_pending_001',
                            amount: 5000,
                            currency: 'usd',
                            status: 'pending',
                        },
                    },
                },
                writeCompensatingLedgerFn: mockPool.mockWriteCompensatingLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(resPending.status).toBe(200);
            expect(mockPool.getCompensatingLedgerWriteCount()).toBe(0);

            // Failed refund
            const resFailed = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_ref_failed',
                eventType: 'refund.failed',
                intentId: 'pi_pending_refund',
                rawBody: '{}',
                payload: {
                    data: {
                        object: {
                            id: 're_failed_001',
                            amount: 2500,
                            currency: 'usd',
                            status: 'failed',
                        },
                    },
                },
                writeCompensatingLedgerFn: mockPool.mockWriteCompensatingLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(resFailed.status).toBe(200);
            expect(mockPool.getCompensatingLedgerWriteCount()).toBe(0);

            const inst = mockPool.getDb().instructions.get('inst_pending_refund');
            expect(inst.state).toBe('SETTLED');
            expect(inst.metadata.refunds.length).toBe(2);
            expect(inst.metadata.refunds.find((r) => r.refund_id === 're_pending_001').status).toBe(
                'PENDING'
            );
            expect(inst.metadata.refunds.find((r) => r.refund_id === 're_failed_001').status).toBe(
                'FAILED'
            );
        });
    });
});
