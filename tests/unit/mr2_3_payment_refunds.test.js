'use strict';

/**
 * PROJECT FUSION — MILESTONE MR2.3 TEST SUITE
 * ============================================================
 * Unit tests verifying:
 * 1. Authoritative persistence in `payment_refunds`
 * 2. Strict deduplication on (provider, provider_refund_id)
 * 3. Exact multi-step partial refund state progression (SETTLED -> PARTIALLY_REFUNDED -> REFUNDED)
 * 4. Over-refund detection and fail-closed state (MANUAL_CHECK)
 * 5. Compensating double-entry ledger reversals (Debit Recipient, Credit Sender)
 * 6. Non-succeeded refund statuses (PENDING, FAILED) without duplicate or premature ledger postings
 * 7. Multi-refund batch arrays from `charge.refunded`
 */

const { processWebhookEvent } = require('../../core/webhooks/webhookProcessor');
const {
    toCanonicalMinorUnits,
    fromCanonicalMinorUnits,
} = require('../../core/orchestrator/financialDecimal');

function createMockPoolWithRefundsTable(initialState = {}) {
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
        payment_refunds: new Map(
            (initialState.payment_refunds || []).map((r) => [
                `${r.provider}:${r.provider_refund_id}`,
                { ...r },
            ])
        ),
        ledger_journal: [...(initialState.ledger_journal || [])],
    };

    let ledgerWriteCount = 0;
    let compensatingLedgerWriteCount = 0;

    const pool = {
        getDb: () => db,
        getLedgerWriteCount: () => ledgerWriteCount,
        getCompensatingLedgerWriteCount: () => compensatingLedgerWriteCount,
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
                        for (const [k, v] of db.processed_webhook_events)
                            stagedEvents.set(k, { ...v });
                        stagedRefunds = new Map();
                        for (const [k, v] of db.payment_refunds) stagedRefunds.set(k, { ...v });
                        stagedJournal = [...db.ledger_journal];
                        return { rows: [] };
                    }

                    if (normalized === 'COMMIT') {
                        if (inTxn) {
                            for (const [k, v] of stagedInstructions)
                                db.instructions.set(k, { ...v });
                            for (const [k, v] of stagedEvents)
                                db.processed_webhook_events.set(k, { ...v });
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

                    // Table existence check
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

                    // Query payment_refunds for single refund lock
                    if (
                        normalized.includes(
                            'FROM PAYMENT_REFUNDS WHERE PROVIDER = $1 AND PROVIDER_REFUND_ID = $2'
                        )
                    ) {
                        const [provider, refundId] = params;
                        const targetStore = inTxn ? stagedRefunds : db.payment_refunds;
                        const key = `${provider}:${refundId}`;
                        const found = targetStore.get(key);
                        return { rows: found ? [{ ...found }] : [] };
                    }

                    // SUM query for payment_refunds with exclusion
                    if (
                        normalized.includes('FROM PAYMENT_REFUNDS') &&
                        normalized.includes('SUM(AMOUNT_MINOR)') &&
                        normalized.includes('PROVIDER_REFUND_ID != $2')
                    ) {
                        const [instructionId, refundId] = params;
                        const targetStore = inTxn ? stagedRefunds : db.payment_refunds;
                        let sum = 0n;
                        for (const r of targetStore.values()) {
                            if (
                                r.instruction_id === instructionId &&
                                r.status === 'SUCCEEDED' &&
                                r.provider_refund_id !== refundId
                            ) {
                                sum += BigInt(r.amount_minor);
                            }
                        }
                        return { rows: [{ total: sum.toString() }] };
                    }

                    // Final SUM query for payment_refunds
                    if (
                        normalized.includes('FROM PAYMENT_REFUNDS') &&
                        normalized.includes('SUM(AMOUNT_MINOR)')
                    ) {
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

                    // Insert or update payment_refunds
                    if (normalized.startsWith('INSERT INTO PAYMENT_REFUNDS')) {
                        const targetStore = inTxn ? stagedRefunds : db.payment_refunds;
                        // Format: provider, item.id, txn.instruction_id, txn.external_intent_id, item.amount_minor, currency, status, eventId, [ledger_entry_id]
                        const [
                            provider,
                            refundId,
                            instructionId,
                            intentId,
                            amountMinor,
                            currency,
                            status,
                            eventId,
                            ledgerEntryId,
                        ] = params;
                        const key = `${provider}:${refundId}`;
                        const existing = targetStore.get(key) || {};
                        const rec = {
                            ...existing,
                            provider,
                            provider_refund_id: refundId,
                            instruction_id: instructionId,
                            external_intent_id: intentId,
                            amount_minor: BigInt(amountMinor),
                            currency,
                            status,
                            event_id: eventId,
                            ledger_entry_id:
                                ledgerEntryId !== undefined
                                    ? ledgerEntryId
                                    : existing.ledger_entry_id,
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
    };

    return pool;
}

describe('MR2.3 Payment Refunds & Authoritative Persistence', () => {
    let mockCompensatingLedger;
    let mockVerifyLedger;

    beforeEach(() => {
        mockCompensatingLedger = jest.fn(
            async (client, instructionId, sender, recipient, amount, currency, refundId) => {
                return {
                    entryIdDebit: 'debit-uuid-' + refundId,
                    entryIdCredit: 'credit-uuid-' + refundId,
                    hash: 'hash_' + refundId,
                };
            }
        );
        mockVerifyLedger = jest.fn(async () => true);
    });

    test('MR2.3-U01: Full refund writes authoritative payment_refunds record and transitions SETTLED -> REFUNDED', async () => {
        const pool = createMockPoolWithRefundsTable({
            instructions: [
                {
                    instruction_id: 'inst_usd_001',
                    external_intent_id: 'pi_test_full',
                    amount: '100.00',
                    currency: 'USD',
                    sender: 'ACC_TREASURY_USD',
                    recipient: 'ACC_CLEARING_USD',
                    state: 'SETTLED',
                    metadata: {},
                },
            ],
        });

        const res = await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_ref_001',
            eventType: 'refund.created',
            intentId: 'pi_test_full',
            rawBody: JSON.stringify({
                id: 're_full_001',
                amount: 10000,
                currency: 'usd',
                status: 'succeeded',
            }),
            payload: {
                id: 'evt_ref_001',
                data: {
                    object: {
                        id: 're_full_001',
                        amount: 10000,
                        currency: 'usd',
                        status: 'succeeded',
                        payment_intent: 'pi_test_full',
                    },
                },
            },
            writeCompensatingLedgerFn: mockCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        expect(res.status).toBe(200);
        expect(res.body.state).toBe('REFUNDED');
        expect(res.body.cumulative_refunded_minor).toBe(10000);

        // Verify payment_refunds table persistence
        const refundsMap = pool.getDb().payment_refunds;
        expect(refundsMap.has('STRIPE:re_full_001')).toBe(true);
        const refRecord = refundsMap.get('STRIPE:re_full_001');
        expect(refRecord.amount_minor).toBe(10000n);
        expect(refRecord.currency).toBe('USD');
        expect(refRecord.status).toBe('SUCCEEDED');
        expect(refRecord.ledger_entry_id).toBe('debit-uuid-re_full_001');

        // Verify ledger invocation
        expect(mockCompensatingLedger).toHaveBeenCalledTimes(1);
        expect(mockCompensatingLedger).toHaveBeenCalledWith(
            expect.anything(),
            'inst_usd_001',
            'ACC_TREASURY_USD',
            'ACC_CLEARING_USD',
            '100.00',
            'USD',
            're_full_001'
        );

        // Verify instruction state
        const inst = pool.getDb().instructions.get('inst_usd_001');
        expect(inst.state).toBe('REFUNDED');
    });

    test('MR2.3-U02: Multi-step partial refunds transition SETTLED -> PARTIALLY_REFUNDED -> REFUNDED', async () => {
        const pool = createMockPoolWithRefundsTable({
            instructions: [
                {
                    instruction_id: 'inst_multi_part',
                    external_intent_id: 'pi_test_multi',
                    amount: '1.00',
                    currency: 'USD',
                    sender: 'ACC_TREASURY_USD',
                    recipient: 'ACC_CLEARING_USD',
                    state: 'SETTLED',
                    metadata: {},
                },
            ],
        });

        // Step 1: $0.30 refund
        const res1 = await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_part_001',
            eventType: 'refund.created',
            intentId: 'pi_test_multi',
            rawBody: JSON.stringify({
                id: 're_part_001',
                amount: 30,
                currency: 'usd',
                status: 'succeeded',
            }),
            payload: {
                id: 'evt_part_001',
                data: {
                    object: {
                        id: 're_part_001',
                        amount: 30,
                        currency: 'usd',
                        status: 'succeeded',
                        payment_intent: 'pi_test_multi',
                    },
                },
            },
            writeCompensatingLedgerFn: mockCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        expect(res1.status).toBe(200);
        expect(res1.body.state).toBe('PARTIALLY_REFUNDED');
        expect(res1.body.cumulative_refunded_minor).toBe(30);

        let inst = pool.getDb().instructions.get('inst_multi_part');
        expect(inst.state).toBe('PARTIALLY_REFUNDED');
        expect(pool.getDb().payment_refunds.size).toBe(1);

        // Step 2: $0.70 refund
        const res2 = await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_part_002',
            eventType: 'refund.created',
            intentId: 'pi_test_multi',
            rawBody: JSON.stringify({
                id: 're_part_002',
                amount: 70,
                currency: 'usd',
                status: 'succeeded',
            }),
            payload: {
                id: 'evt_part_002',
                data: {
                    object: {
                        id: 're_part_002',
                        amount: 70,
                        currency: 'usd',
                        status: 'succeeded',
                        payment_intent: 'pi_test_multi',
                    },
                },
            },
            writeCompensatingLedgerFn: mockCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        expect(res2.status).toBe(200);
        expect(res2.body.state).toBe('REFUNDED');
        expect(res2.body.cumulative_refunded_minor).toBe(100);

        inst = pool.getDb().instructions.get('inst_multi_part');
        expect(inst.state).toBe('REFUNDED');
        expect(pool.getDb().payment_refunds.size).toBe(2);
        expect(mockCompensatingLedger).toHaveBeenCalledTimes(2);
    });

    test('MR2.3-U03: Idempotent replay of same refund does not write duplicate ledger entries', async () => {
        const pool = createMockPoolWithRefundsTable({
            instructions: [
                {
                    instruction_id: 'inst_replay',
                    external_intent_id: 'pi_test_replay',
                    amount: '50.00',
                    currency: 'USD',
                    sender: 'ACC_TREASURY_USD',
                    recipient: 'ACC_CLEARING_USD',
                    state: 'SETTLED',
                    metadata: {},
                },
            ],
        });

        // First delivery
        await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_replay_001',
            eventType: 'refund.created',
            intentId: 'pi_test_replay',
            rawBody: JSON.stringify({
                id: 're_dup_001',
                amount: 5000,
                currency: 'usd',
                status: 'succeeded',
            }),
            payload: {
                id: 'evt_replay_001',
                data: {
                    object: {
                        id: 're_dup_001',
                        amount: 5000,
                        currency: 'usd',
                        status: 'succeeded',
                        payment_intent: 'pi_test_replay',
                    },
                },
            },
            writeCompensatingLedgerFn: mockCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        expect(mockCompensatingLedger).toHaveBeenCalledTimes(1);

        // Replay with new event ID but identical provider_refund_id 're_dup_001'
        const replayRes = await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_replay_002',
            eventType: 'refund.updated',
            intentId: 'pi_test_replay',
            rawBody: JSON.stringify({
                id: 're_dup_001',
                amount: 5000,
                currency: 'usd',
                status: 'succeeded',
            }),
            payload: {
                id: 'evt_replay_002',
                data: {
                    object: {
                        id: 're_dup_001',
                        amount: 5000,
                        currency: 'usd',
                        status: 'succeeded',
                        payment_intent: 'pi_test_replay',
                    },
                },
            },
            writeCompensatingLedgerFn: mockCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        expect(replayRes.status).toBe(200);
        // Ledger write count must still be 1 (duplicate avoided)
        expect(mockCompensatingLedger).toHaveBeenCalledTimes(1);
    });

    test('MR2.3-U04: Over-refund attempt is rejected and flags MANUAL_CHECK', async () => {
        const pool = createMockPoolWithRefundsTable({
            instructions: [
                {
                    instruction_id: 'inst_over_ref',
                    external_intent_id: 'pi_test_over',
                    amount: '10.00',
                    currency: 'USD',
                    sender: 'ACC_TREASURY_USD',
                    recipient: 'ACC_CLEARING_USD',
                    state: 'SETTLED',
                    metadata: {},
                },
            ],
        });

        // Attempt refund of $15.00 on a $10.00 payment
        const res = await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_over_001',
            eventType: 'refund.created',
            intentId: 'pi_test_over',
            rawBody: JSON.stringify({
                id: 're_over_001',
                amount: 1500,
                currency: 'usd',
                status: 'succeeded',
            }),
            payload: {
                id: 'evt_over_001',
                data: {
                    object: {
                        id: 're_over_001',
                        amount: 1500,
                        currency: 'usd',
                        status: 'succeeded',
                        payment_intent: 'pi_test_over',
                    },
                },
            },
            writeCompensatingLedgerFn: mockCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        expect(res.status).toBe(200);
        expect(res.body.mismatch).toBe(true);
        expect(res.body.reason).toBe('OVER_REFUND_ATTEMPT');

        const inst = pool.getDb().instructions.get('inst_over_ref');
        expect(inst.state).toBe('MANUAL_CHECK');
        expect(mockCompensatingLedger).not.toHaveBeenCalled();
    });

    test('MR2.3-U05: Pending and failed refund events do not trigger compensating ledger entries', async () => {
        const pool = createMockPoolWithRefundsTable({
            instructions: [
                {
                    instruction_id: 'inst_statuses',
                    external_intent_id: 'pi_test_statuses',
                    amount: '20.00',
                    currency: 'USD',
                    sender: 'ACC_TREASURY_USD',
                    recipient: 'ACC_CLEARING_USD',
                    state: 'SETTLED',
                    metadata: {},
                },
            ],
        });

        // Pending refund
        const pendingRes = await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_pend_001',
            eventType: 'refund.updated',
            intentId: 'pi_test_statuses',
            rawBody: JSON.stringify({
                id: 're_pend_001',
                amount: 2000,
                currency: 'usd',
                status: 'pending',
            }),
            payload: {
                id: 'evt_pend_001',
                data: {
                    object: {
                        id: 're_pend_001',
                        amount: 2000,
                        currency: 'usd',
                        status: 'pending',
                        payment_intent: 'pi_test_statuses',
                    },
                },
            },
            writeCompensatingLedgerFn: mockCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        expect(pendingRes.status).toBe(200);
        expect(mockCompensatingLedger).not.toHaveBeenCalled();

        let refRecord = pool.getDb().payment_refunds.get('STRIPE:re_pend_001');
        expect(refRecord.status).toBe('PENDING');
        expect(refRecord.ledger_entry_id).toBeUndefined();

        // Failed refund
        const failedRes = await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_fail_001',
            eventType: 'refund.failed',
            intentId: 'pi_test_statuses',
            rawBody: JSON.stringify({
                id: 're_pend_001',
                amount: 2000,
                currency: 'usd',
                status: 'failed',
            }),
            payload: {
                id: 'evt_fail_001',
                data: {
                    object: {
                        id: 're_pend_001',
                        amount: 2000,
                        currency: 'usd',
                        status: 'failed',
                        payment_intent: 'pi_test_statuses',
                    },
                },
            },
            writeCompensatingLedgerFn: mockCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        expect(failedRes.status).toBe(200);
        expect(mockCompensatingLedger).not.toHaveBeenCalled();

        refRecord = pool.getDb().payment_refunds.get('STRIPE:re_pend_001');
        expect(refRecord.status).toBe('FAILED');
        expect(refRecord.ledger_entry_id).toBeUndefined();

        const inst = pool.getDb().instructions.get('inst_statuses');
        expect(inst.state).toBe('SETTLED');
    });

    test('MR2.3-U06: charge.refunded containing multiple refunds records all items in payment_refunds', async () => {
        const pool = createMockPoolWithRefundsTable({
            instructions: [
                {
                    instruction_id: 'inst_charge_ref',
                    external_intent_id: 'pi_test_charge',
                    amount: '100.00',
                    currency: 'USD',
                    sender: 'ACC_TREASURY_USD',
                    recipient: 'ACC_CLEARING_USD',
                    state: 'SETTLED',
                    metadata: {},
                },
            ],
        });

        const res = await processWebhookEvent({
            pool,
            provider: 'STRIPE',
            eventId: 'evt_charge_ref_001',
            eventType: 'charge.refunded',
            intentId: 'pi_test_charge',
            rawBody: JSON.stringify({
                id: 'ch_test_charge',
                payment_intent: 'pi_test_charge',
                refunds: {
                    data: [
                        { id: 're_batch_1', amount: 4000, currency: 'usd', status: 'succeeded' },
                        { id: 're_batch_2', amount: 6000, currency: 'usd', status: 'succeeded' },
                    ],
                },
            }),
            payload: {
                id: 'evt_charge_ref_001',
                data: {
                    object: {
                        id: 'ch_test_charge',
                        payment_intent: 'pi_test_charge',
                        amount_refunded: 10000,
                        refunds: {
                            data: [
                                {
                                    id: 're_batch_1',
                                    amount: 4000,
                                    currency: 'usd',
                                    status: 'succeeded',
                                },
                                {
                                    id: 're_batch_2',
                                    amount: 6000,
                                    currency: 'usd',
                                    status: 'succeeded',
                                },
                            ],
                        },
                    },
                },
            },
            writeCompensatingLedgerFn: mockCompensatingLedger,
            verifyLedgerIntegrityFn: mockVerifyLedger,
        });

        expect(res.status).toBe(200);
        expect(res.body.state).toBe('REFUNDED');
        expect(mockCompensatingLedger).toHaveBeenCalledTimes(2);

        expect(pool.getDb().payment_refunds.has('STRIPE:re_batch_1')).toBe(true);
        expect(pool.getDb().payment_refunds.has('STRIPE:re_batch_2')).toBe(true);
        expect(pool.getDb().payment_refunds.get('STRIPE:re_batch_1').amount_minor).toBe(4000n);
        expect(pool.getDb().payment_refunds.get('STRIPE:re_batch_2').amount_minor).toBe(6000n);
    });
});
