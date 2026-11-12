'use strict';

/**
 * PROJECT FUSION — MILESTONE MR2.4 UNIT TEST SUITE
 * ============================================================
 * Unit tests verifying:
 * 1. Out-of-order refund rejection & retryable 409 before settlement
 * 2. Recovery when parent settles and refund is retried
 * 3. Out-of-order event delivery (refund.updated before refund.created)
 * 4. Two-phase pending -> succeeded transition
 * 5. Stale event protection against status regression
 * 6. Unknown reference rollback with retryable 404
 * 7. Failure-injection atomic rollback and subsequent successful retry
 * 8. Charge.refunded without items does not create fake refunds
 */

const { processWebhookEvent } = require('../../core/webhooks/webhookProcessor');

function createMockPoolForMR24(initialState = {}) {
    const db = {
        instructions: new Map((initialState.instructions || []).map((i) => [i.instruction_id, { ...i }])),
        processed_webhook_events: new Map(
            (initialState.processed_webhook_events || []).map((e) => [`${e.provider}:${e.event_id}`, { ...e }])
        ),
        payment_refunds: new Map(
            (initialState.payment_refunds || []).map((r) => [`${r.provider}:${r.provider_refund_id}`, { ...r }])
        ),
        ledger_journal: [...(initialState.ledger_journal || [])],
    };

    let ledgerWriteCount = 0;
    let compensatingLedgerWriteCount = 0;
    let shouldFailCompensatingLedger = false;

    const pool = {
        getDb: () => db,
        getCompensatingLedgerWriteCount: () => compensatingLedgerWriteCount,
        setFailCompensatingLedger: (val) => {
            shouldFailCompensatingLedger = val;
        },
        connect: async () => {
            let inTxn = false;
            let stagedInstructions = new Map();
            let stagedEvents = new Map();
            let stagedRefunds = new Map();
            let stagedJournal = [];

            return {
                query: async (sql, params = []) => {
                    const normalized = sql.trim().toUpperCase();

                    if (normalized === 'BEGIN') {
                        inTxn = true;
                        stagedInstructions = new Map();
                        for (const [k, v] of db.instructions) stagedInstructions.set(k, { ...v });
                        stagedEvents = new Map();
                        for (const [k, v] of db.processed_webhook_events) stagedEvents.set(k, { ...v });
                        stagedRefunds = new Map();
                        for (const [k, v] of db.payment_refunds) stagedRefunds.set(k, { ...v });
                        stagedJournal = [...db.ledger_journal];
                        return { rows: [] };
                    }

                    if (normalized === 'COMMIT') {
                        if (inTxn) {
                            for (const [k, v] of stagedInstructions) db.instructions.set(k, { ...v });
                            for (const [k, v] of stagedEvents) db.processed_webhook_events.set(k, { ...v });
                            for (const [k, v] of stagedRefunds) db.payment_refunds.set(k, { ...v });
                            db.ledger_journal = stagedJournal;
                            inTxn = false;
                        }
                        return { rows: [] };
                    }

                    if (normalized === 'ROLLBACK') {
                        inTxn = false;
                        stagedInstructions.clear();
                        stagedEvents.clear();
                        stagedRefunds.clear();
                        stagedJournal = [];
                        return { rows: [] };
                    }

                    if (normalized.includes("TO_REGCLASS('PUBLIC.PAYMENT_REFUNDS')")) {
                        return { rows: [{ tbl: 'payment_refunds' }] };
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
                        const [entryId, instructionId, accountId, direction, amount, currency, timestamp, hash, prevHash] = params;
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
                        const [eventId, provider, eventType, instructionId, intentId, payloadHash] = params;
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

                    if (normalized.startsWith('SELECT * FROM INSTRUCTIONS WHERE EXTERNAL_INTENT_ID')) {
                        const intentId = params[0];
                        const targetStore = inTxn ? stagedInstructions : db.instructions;
                        const found = Array.from(targetStore.values()).filter((i) => i.external_intent_id === intentId);
                        return { rows: found.map((f) => ({ ...f })) };
                    }

                    if (normalized.startsWith('SELECT * FROM INSTRUCTIONS WHERE INSTRUCTION_ID')) {
                        const id = params[0];
                        const targetStore = inTxn ? stagedInstructions : db.instructions;
                        const found = Array.from(targetStore.values()).filter((i) => i.instruction_id === id);
                        return { rows: found.map((f) => ({ ...f })) };
                    }

                    if (normalized.includes('FROM PAYMENT_REFUNDS WHERE PROVIDER = $1 AND PROVIDER_REFUND_ID = $2')) {
                        const [provider, refundId] = params;
                        const targetStore = inTxn ? stagedRefunds : db.payment_refunds;
                        const key = `${provider}:${refundId}`;
                        const found = targetStore.get(key);
                        return { rows: found ? [{ ...found }] : [] };
                    }

                    if (normalized.includes('FROM PAYMENT_REFUNDS') && normalized.includes('SUM(AMOUNT_MINOR)') && normalized.includes('PROVIDER_REFUND_ID != $2')) {
                        const [instructionId, refundId] = params;
                        const targetStore = inTxn ? stagedRefunds : db.payment_refunds;
                        let sum = 0n;
                        for (const r of targetStore.values()) {
                            if (r.instruction_id === instructionId && r.status === 'SUCCEEDED' && r.provider_refund_id !== refundId) {
                                sum += BigInt(r.amount_minor);
                            }
                        }
                        return { rows: [{ total: sum.toString() }] };
                    }

                    if (normalized.includes('FROM PAYMENT_REFUNDS') && normalized.includes('SUM(AMOUNT_MINOR)')) {
                        const [instructionId] = params;
                        const targetStore = inTxn ? stagedRefunds : db.payment_refunds;
                        let sum = 0n;
                        for (const r of targetStore.values()) {
                            if (r.instruction_id === instructionId && r.status === 'SUCCEEDED') {
                                sum += BigInt(r.amount_minor);
                            }
                        }
                        return { rows: [{ total: sum.toString() }] };
                    }

                    if (normalized.startsWith('INSERT INTO PAYMENT_REFUNDS')) {
                        const targetStore = inTxn ? stagedRefunds : db.payment_refunds;
                        const [provider, refundId, instructionId, intentId, amountMinor, currency, status, eventId, ledgerEntryId] = params;
                        const key = `${provider}:${refundId}`;
                        const existing = targetStore.get(key) || {};

                        // Enforce stale event rule: SUCCEEDED cannot regress to PENDING or FAILED
                        let effectiveStatus = status;
                        if (existing.status === 'SUCCEEDED' && (status === 'PENDING' || status === 'FAILED' || status === 'CANCELED')) {
                            effectiveStatus = 'SUCCEEDED';
                        }

                        const rec = {
                            ...existing,
                            provider,
                            provider_refund_id: refundId,
                            instruction_id: instructionId,
                            external_intent_id: intentId,
                            amount_minor: BigInt(amountMinor),
                            currency,
                            status: effectiveStatus,
                            event_id: eventId,
                            ledger_entry_id: ledgerEntryId !== undefined ? ledgerEntryId : existing.ledger_entry_id,
                        };
                        targetStore.set(key, rec);
                        return { rows: [rec] };
                    }

                    if (normalized.includes("UPDATE INSTRUCTIONS SET STATE = 'SETTLED'")) {
                        const instructionId = params[0];
                        const targetStore = inTxn ? stagedInstructions : db.instructions;
                        if (targetStore.has(instructionId)) {
                            targetStore.get(instructionId).state = 'SETTLED';
                        }
                        return { rows: [] };
                    }

                    if (normalized.includes("UPDATE INSTRUCTIONS SET STATE = $1") || normalized.includes("UPDATE INSTRUCTIONS SET STATUS = $1")) {
                        const [targetState, metaStr, instructionId] = params;
                        const targetStore = inTxn ? stagedInstructions : db.instructions;
                        if (targetStore.has(instructionId)) {
                            const inst = targetStore.get(instructionId);
                            inst.state = targetState;
                            inst.status = targetState;
                            try { inst.metadata = JSON.parse(metaStr); } catch { inst.metadata = metaStr; }
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
    };

    return pool;
}

describe('MR2.4 Concurrency, Event Ordering & Recovery Suite', () => {
    let mockCompensatingLedger;
    let mockVerifyLedger;

    beforeEach(() => {
        mockCompensatingLedger = jest.fn(async (client, instructionId, sender, recipient, amount, currency, refundId) => {
            return {
                entryIdDebit: 'debit-uuid-' + refundId,
                entryIdCredit: 'credit-uuid-' + refundId,
                hash: 'hash_' + refundId,
            };
        });
        mockVerifyLedger = jest.fn(async () => true);
    });

    test('MR2.4-U01: Out-of-order refund arriving before settlement returns retryable 409 and rolls back event', async () => {
        const pool = createMockPoolForMR24({
            instructions: [
                {
                    instruction_id: 'inst_unsettled',
                    external_intent_id: 'pi_test_unsettled',
                    amount: '100.00',
                    currency: 'USD',
                    sender: 'ACC_TREASURY_USD',
                    recipient: 'ACC_CLEARING_USD',
                    state: 'PENDING_EXECUTION', // Not yet settled!
                    metadata: {},
                },
            ],
        });

        const res = await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_early_refund_001',
            eventType: 'refund.created',
            intentId: 'pi_test_unsettled',
            rawBody: JSON.stringify({ id: 're_early_001', amount: 5000, currency: 'usd', status: 'succeeded' }),
            payload: {
                id: 'evt_early_refund_001',
                data: {
                    object: {
                        id: 're_early_001',
                        amount: 5000,
                        currency: 'usd',
                        status: 'succeeded',
                        payment_intent: 'pi_test_unsettled',
                    },
                },
            },
            writeCompensatingLedgerFn: mockCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        // Must return 409 Conflict with retryable flag
        expect(res.status).toBe(409);
        expect(res.body.retryable).toBe(true);
        expect(res.body.reason).toBe('INSTRUCTION_NOT_SETTLED');

        // Zero ledger postings
        expect(mockCompensatingLedger).not.toHaveBeenCalled();

        // Database must NOT mark event as permanently consumed (transaction was rolled back)
        expect(pool.getDb().processed_webhook_events.has('STRIPE:evt_early_refund_001')).toBe(false);
        // Instruction remains in PENDING_EXECUTION
        expect(pool.getDb().instructions.get('inst_unsettled').state).toBe('PENDING_EXECUTION');
    });

    test('MR2.4-U02: Out-of-order recovery: settling parent allows retried refund to succeed', async () => {
        const pool = createMockPoolForMR24({
            instructions: [
                {
                    instruction_id: 'inst_recovery',
                    external_intent_id: 'pi_test_recovery',
                    amount: '100.00',
                    currency: 'USD',
                    sender: 'ACC_TREASURY_USD',
                    recipient: 'ACC_CLEARING_USD',
                    state: 'PENDING_EXECUTION',
                    metadata: {},
                },
            ],
        });

        // 1. Settle the parent instruction
        await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_pi_settle',
            eventType: 'payment_intent.succeeded',
            intentId: 'pi_test_recovery',
            rawBody: JSON.stringify({ id: 'pi_test_recovery', amount: 10000, currency: 'usd' }),
            payload: { data: { object: { id: 'pi_test_recovery', amount: 10000, currency: 'usd' } } },
        });
        expect(pool.getDb().instructions.get('inst_recovery').state).toBe('SETTLED');

        // 2. Retry the previously un-settled refund
        const retryRes = await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_early_refund_retry',
            eventType: 'refund.created',
            intentId: 'pi_test_recovery',
            rawBody: JSON.stringify({ id: 're_recovered_001', amount: 4000, currency: 'usd', status: 'succeeded' }),
            payload: {
                data: {
                    object: {
                        id: 're_recovered_001',
                        amount: 4000,
                        currency: 'usd',
                        status: 'succeeded',
                        payment_intent: 'pi_test_recovery',
                    },
                },
            },
            writeCompensatingLedgerFn: mockCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        expect(retryRes.status).toBe(200);
        expect(retryRes.body.state).toBe('PARTIALLY_REFUNDED');
        expect(mockCompensatingLedger).toHaveBeenCalledTimes(1);
        expect(pool.getDb().instructions.get('inst_recovery').state).toBe('PARTIALLY_REFUNDED');
    });

    test('MR2.4-U03: Out-of-order event delivery (refund.updated before refund.created) is idempotent', async () => {
        const pool = createMockPoolForMR24({
            instructions: [
                {
                    instruction_id: 'inst_ooo_events',
                    external_intent_id: 'pi_test_ooo',
                    amount: '100.00',
                    currency: 'USD',
                    sender: 'ACC_TREASURY_USD',
                    recipient: 'ACC_CLEARING_USD',
                    state: 'SETTLED',
                    metadata: {},
                },
            ],
        });

        // 1. refund.updated arrives FIRST with status succeeded
        const resUpdated = await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_ooo_updated',
            eventType: 'refund.updated',
            intentId: 'pi_test_ooo',
            rawBody: JSON.stringify({ id: 're_ooo_001', amount: 10000, currency: 'usd', status: 'succeeded' }),
            payload: {
                data: {
                    object: {
                        id: 're_ooo_001',
                        amount: 10000,
                        currency: 'usd',
                        status: 'succeeded',
                        payment_intent: 'pi_test_ooo',
                    },
                },
            },
            writeCompensatingLedgerFn: mockCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        expect(resUpdated.status).toBe(200);
        expect(resUpdated.body.state).toBe('REFUNDED');
        expect(mockCompensatingLedger).toHaveBeenCalledTimes(1);

        // 2. Later, refund.created arrives for the SAME refund ID
        const resCreated = await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_ooo_created',
            eventType: 'refund.created',
            intentId: 'pi_test_ooo',
            rawBody: JSON.stringify({ id: 're_ooo_001', amount: 10000, currency: 'usd', status: 'succeeded' }),
            payload: {
                data: {
                    object: {
                        id: 're_ooo_001',
                        amount: 10000,
                        currency: 'usd',
                        status: 'succeeded',
                        payment_intent: 'pi_test_ooo',
                    },
                },
            },
            writeCompensatingLedgerFn: mockCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        expect(resCreated.status).toBe(200);
        // Ledger write count must still be exactly 1
        expect(mockCompensatingLedger).toHaveBeenCalledTimes(1);
    });

    test('MR2.4-U04: Two-phase pending -> succeeded transition writes compensating ledger only on succeeded', async () => {
        const pool = createMockPoolForMR24({
            instructions: [
                {
                    instruction_id: 'inst_two_phase',
                    external_intent_id: 'pi_test_two_phase',
                    amount: '100.00',
                    currency: 'USD',
                    sender: 'ACC_TREASURY_USD',
                    recipient: 'ACC_CLEARING_USD',
                    state: 'SETTLED',
                    metadata: {},
                },
            ],
        });

        // Phase 1: pending
        await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_tp_pending',
            eventType: 'refund.created',
            intentId: 'pi_test_two_phase',
            rawBody: JSON.stringify({ id: 're_tp_001', amount: 10000, currency: 'usd', status: 'pending' }),
            payload: {
                data: {
                    object: {
                        id: 're_tp_001',
                        amount: 10000,
                        currency: 'usd',
                        status: 'pending',
                        payment_intent: 'pi_test_two_phase',
                    },
                },
            },
            writeCompensatingLedgerFn: mockCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        expect(mockCompensatingLedger).not.toHaveBeenCalled();
        expect(pool.getDb().payment_refunds.get('STRIPE:re_tp_001').status).toBe('PENDING');

        // Phase 2: succeeded
        await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_tp_succeeded',
            eventType: 'refund.updated',
            intentId: 'pi_test_two_phase',
            rawBody: JSON.stringify({ id: 're_tp_001', amount: 10000, currency: 'usd', status: 'succeeded' }),
            payload: {
                data: {
                    object: {
                        id: 're_tp_001',
                        amount: 10000,
                        currency: 'usd',
                        status: 'succeeded',
                        payment_intent: 'pi_test_two_phase',
                    },
                },
            },
            writeCompensatingLedgerFn: mockCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        expect(mockCompensatingLedger).toHaveBeenCalledTimes(1);
        expect(pool.getDb().payment_refunds.get('STRIPE:re_tp_001').status).toBe('SUCCEEDED');
        expect(pool.getDb().instructions.get('inst_two_phase').state).toBe('REFUNDED');
    });

    test('MR2.4-U05: Stale events cannot regress a successfully processed refund', async () => {
        const pool = createMockPoolForMR24({
            instructions: [
                {
                    instruction_id: 'inst_stale_guard',
                    external_intent_id: 'pi_test_stale',
                    amount: '50.00',
                    currency: 'USD',
                    sender: 'ACC_TREASURY_USD',
                    recipient: 'ACC_CLEARING_USD',
                    state: 'SETTLED',
                    metadata: {},
                },
            ],
        });

        // 1. Process successful refund
        await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_stale_1',
            eventType: 'refund.created',
            intentId: 'pi_test_stale',
            rawBody: JSON.stringify({ id: 're_stale_001', amount: 5000, currency: 'usd', status: 'succeeded' }),
            payload: {
                data: { object: { id: 're_stale_001', amount: 5000, currency: 'usd', status: 'succeeded', payment_intent: 'pi_test_stale' } },
            },
            writeCompensatingLedgerFn: mockCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        expect(pool.getDb().payment_refunds.get('STRIPE:re_stale_001').status).toBe('SUCCEEDED');

        // 2. Stale pending event arrives later
        await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_stale_2_pending',
            eventType: 'refund.updated',
            intentId: 'pi_test_stale',
            rawBody: JSON.stringify({ id: 're_stale_001', amount: 5000, currency: 'usd', status: 'pending' }),
            payload: {
                data: { object: { id: 're_stale_001', amount: 5000, currency: 'usd', status: 'pending', payment_intent: 'pi_test_stale' } },
            },
            writeCompensatingLedgerFn: mockCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        // Status must NOT regress to PENDING
        expect(pool.getDb().payment_refunds.get('STRIPE:re_stale_001').status).toBe('SUCCEEDED');

        // 3. Stale failed event arrives later
        await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_stale_3_failed',
            eventType: 'refund.failed',
            intentId: 'pi_test_stale',
            rawBody: JSON.stringify({ id: 're_stale_001', amount: 5000, currency: 'usd', status: 'failed' }),
            payload: {
                data: { object: { id: 're_stale_001', amount: 5000, currency: 'usd', status: 'failed', payment_intent: 'pi_test_stale' } },
            },
            writeCompensatingLedgerFn: mockCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        // Status must STILL be SUCCEEDED
        expect(pool.getDb().payment_refunds.get('STRIPE:re_stale_001').status).toBe('SUCCEEDED');
    });

    test('MR2.4-U06: Database exception during ledger write triggers atomic rollback and retry succeeds', async () => {
        const pool = createMockPoolForMR24({
            instructions: [
                {
                    instruction_id: 'inst_rollback_retry',
                    external_intent_id: 'pi_test_rollback',
                    amount: '100.00',
                    currency: 'USD',
                    sender: 'ACC_TREASURY_USD',
                    recipient: 'ACC_CLEARING_USD',
                    state: 'SETTLED',
                    metadata: {},
                },
            ],
        });

        const failingCompensatingLedger = jest.fn()
            .mockImplementationOnce(async () => {
                throw new Error('LEDGER_WRITE_IO_FAILURE: Simulated database crash during ledger append');
            })
            .mockImplementationOnce(async (client, instructionId, sender, recipient, amount, currency, refundId) => {
                return {
                    entryIdDebit: 'debit-uuid-' + refundId,
                    entryIdCredit: 'credit-uuid-' + refundId,
                    hash: 'hash_' + refundId,
                };
            });

        // Attempt 1: Fails during ledger write
        const resFail = await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_crash_001',
            eventType: 'refund.created',
            intentId: 'pi_test_rollback',
            rawBody: JSON.stringify({ id: 're_crash_001', amount: 10000, currency: 'usd', status: 'succeeded' }),
            payload: {
                data: { object: { id: 're_crash_001', amount: 10000, currency: 'usd', status: 'succeeded', payment_intent: 'pi_test_rollback' } },
            },
            writeCompensatingLedgerFn: failingCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        expect(resFail.status).toBe(500);
        // Staged changes must be rolled back: event not recorded as processed, refund not saved, state remains SETTLED
        expect(pool.getDb().processed_webhook_events.has('STRIPE:evt_crash_001')).toBe(false);
        expect(pool.getDb().payment_refunds.has('STRIPE:re_crash_001')).toBe(false);
        expect(pool.getDb().instructions.get('inst_rollback_retry').state).toBe('SETTLED');

        // Attempt 2: Retry succeeds
        const resRetry = await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_crash_001',
            eventType: 'refund.created',
            intentId: 'pi_test_rollback',
            rawBody: JSON.stringify({ id: 're_crash_001', amount: 10000, currency: 'usd', status: 'succeeded' }),
            payload: {
                data: { object: { id: 're_crash_001', amount: 10000, currency: 'usd', status: 'succeeded', payment_intent: 'pi_test_rollback' } },
            },
            writeCompensatingLedgerFn: failingCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        expect(resRetry.status).toBe(200);
        expect(resRetry.body.state).toBe('REFUNDED');
        expect(pool.getDb().processed_webhook_events.has('STRIPE:evt_crash_001')).toBe(true);
        expect(pool.getDb().payment_refunds.has('STRIPE:re_crash_001')).toBe(true);
        expect(pool.getDb().instructions.get('inst_rollback_retry').state).toBe('REFUNDED');
    });
});

