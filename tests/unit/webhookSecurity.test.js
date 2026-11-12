'use strict';

/**
 * PROJECT FUSION — WEBHOOK SECURITY & IDEMPOTENCY UNIT TESTS
 * ============================================================
 * Tests institutional-grade webhook security requirements for Sprint 2.1:
 * 1. Valid Stripe signature verification (Stripe SDK)
 * 2. Invalid Stripe signature rejection (400 Bad Request)
 * 3. Tampered Stripe payload rejection
 * 4. Valid RazorpayX signature verification (HMAC-SHA256 timing-safe)
 * 5. Invalid RazorpayX signature rejection
 * 6. Duplicate event delivery protection (deduplication)
 * 7. Missing event identifiers rejection (no Date.now fallback)
 * 8. Unknown provider references handling (404 & rollback)
 * 9. Out-of-order events handling (settled state preserved)
 * 10. Duplicate settlement prevention (zero duplicate ledger writes)
 * 11. Database transaction rollback on processing failure
 * 12. Legitimate post-settlement refund or reversal events
 * 13. Production livemode event rejection (Strict testnet enforcement)
 * 14. Dedicated RazorpayX signing secret enforcement (secret separation)
 * 15. Legacy gateway endpoint non-mutating guarantee
 */

const crypto = require('crypto');
const Stripe = require('stripe');
const {
    verifyStripeSignature,
    verifyRazorpayXSignature,
    processWebhookEvent,
} = require('../../core/webhooks/webhookProcessor');
const {
    handleStripeWebhook,
    handleRazorpayWebhook,
    handleLegacyGatewayWebhook,
} = require('../../routes/webhooks');

const TEST_STRIPE_SECRET = 'whsec_test_mock_webhook_secret_998877';
const TEST_RAZORPAY_SECRET = 'rzp_whsec_test_sandbox_secret_112233';

function createMockRes() {
    const res = {
        statusCode: 200,
        bodyData: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(data) {
            this.bodyData = data;
            return this;
        },
        send(data) {
            this.bodyData = data;
            return this;
        },
    };
    return res;
}

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

                    // INSERT INTO processed_webhook_events
                    if (normalized.startsWith('INSERT INTO PROCESSED_WEBHOOK_EVENTS')) {
                        const [eventId, provider, eventType, instructionId, intentId, payloadHash] =
                            params;
                        const key = `${provider}:${eventId}`;
                        const targetStore = inTxn ? stagedEvents : db.processed_webhook_events;

                        if (targetStore.has(key)) {
                            // Conflict -> return empty rows to signal duplicate
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

                    // UPDATE processed_webhook_events SET instruction_id ...
                    if (normalized.startsWith('UPDATE PROCESSED_WEBHOOK_EVENTS')) {
                        const [instructionId, provider, eventId] = params;
                        const key = `${provider}:${eventId}`;
                        const targetStore = inTxn ? stagedEvents : db.processed_webhook_events;
                        if (targetStore.has(key)) {
                            targetStore.get(key).instruction_id = instructionId;
                        }
                        return { rows: [] };
                    }

                    // SELECT * FROM instructions WHERE external_intent_id = $1 ...
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

                    // SELECT * FROM instructions WHERE instruction_id = $1 ...
                    if (normalized.startsWith('SELECT * FROM INSTRUCTIONS WHERE INSTRUCTION_ID')) {
                        const id = params[0];
                        const targetStore = inTxn ? stagedInstructions : db.instructions;
                        const found = Array.from(targetStore.values()).filter(
                            (i) => i.instruction_id === id
                        );
                        return { rows: found.map((f) => ({ ...f })) };
                    }

                    // UPDATE instructions SET state = 'SETTLED' ...
                    if (normalized.includes("UPDATE INSTRUCTIONS SET STATE = 'SETTLED'")) {
                        const instructionId = params[0];
                        const targetStore = inTxn ? stagedInstructions : db.instructions;
                        if (targetStore.has(instructionId)) {
                            targetStore.get(instructionId).state = 'SETTLED';
                        }
                        return { rows: [] };
                    }

                    // UPDATE instructions SET state = 'FAILED' ...
                    if (normalized.includes("UPDATE INSTRUCTIONS SET STATE = 'FAILED'")) {
                        const [errMsg, instructionId] = params;
                        const targetStore = inTxn ? stagedInstructions : db.instructions;
                        if (targetStore.has(instructionId)) {
                            targetStore.get(instructionId).state = 'FAILED';
                            targetStore.get(instructionId).error_message = errMsg;
                        }
                        return { rows: [] };
                    }

                    // UPDATE instructions SET state = 'REFUNDED' ...
                    if (normalized.includes("UPDATE INSTRUCTIONS SET STATE = 'REFUNDED'")) {
                        const instructionId = params[0];
                        const targetStore = inTxn ? stagedInstructions : db.instructions;
                        if (targetStore.has(instructionId)) {
                            targetStore.get(instructionId).state = 'REFUNDED';
                        }
                        return { rows: [] };
                    }

                    // UPDATE instructions SET state = 'REVERSED' ...
                    if (normalized.includes("UPDATE INSTRUCTIONS SET STATE = 'REVERSED'")) {
                        const instructionId = params[0];
                        const targetStore = inTxn ? stagedInstructions : db.instructions;
                        if (targetStore.has(instructionId)) {
                            targetStore.get(instructionId).state = 'REVERSED';
                        }
                        return { rows: [] };
                    }

                    // UPDATE instructions SET state = $1, status = $1, metadata = $2 ...
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

                    // UPDATE instructions SET state = 'MANUAL_CHECK' ...
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
        mockWriteLedger: async (
            client,
            instructionId,
            sender,
            recipient,
            amount,
            currency,
            tax
        ) => {
            if (shouldFailLedgerWrite) {
                throw new Error('LEDGER_WRITE_IO_FAILURE: Database connection terminated abruptly');
            }
            ledgerWriteCount++;
        },
        mockWriteCompensatingLedger: async (
            client,
            instructionId,
            sender,
            recipient,
            amount,
            currency,
            refundId
        ) => {
            if (shouldFailLedgerWrite) {
                throw new Error('LEDGER_WRITE_IO_FAILURE: Database connection terminated abruptly');
            }
            compensatingLedgerWriteCount++;
            return {
                entryIdDebit: 'mock_debit_id',
                entryIdCredit: 'mock_credit_id',
                hash: 'mock_compensating_hash',
            };
        },
        mockVerifyLedgerIntegrity: async () => {
            ledgerVerifyCount++;
        },
    };

    return pool;
}

describe('Project Fusion — Sprint 2.1: Webhook Security & Idempotency', () => {
    const originalEnv = { ...process.env };
    let stripeInstance;

    beforeAll(() => {
        process.env.STRIPE_TEST_SECRET_KEY = 'sk_test_mock_for_webhooks_unit_test';
        process.env.STRIPE_WEBHOOK_SECRET = TEST_STRIPE_SECRET;
        process.env.RAZORPAY_KEY_ID = 'rzp_test_mock_key';
        process.env.RAZORPAY_KEY_SECRET = 'rzp_key_secret_different_from_webhook';
        process.env.RAZORPAYX_WEBHOOK_SECRET = TEST_RAZORPAY_SECRET;
        stripeInstance = new Stripe(process.env.STRIPE_TEST_SECRET_KEY);
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    // ------------------------------------------------------------------------
    // 1. STRIPE SIGNATURE VERIFICATION
    // ------------------------------------------------------------------------
    describe('Stripe Signature Verification', () => {
        test('accepts valid Stripe webhook signature matching STRIPE_WEBHOOK_SECRET', () => {
            const payload = JSON.stringify({
                id: 'evt_stripe_valid_001',
                object: 'event',
                type: 'payment_intent.succeeded',
                livemode: false,
                data: {
                    object: {
                        id: 'pi_test_valid_001',
                        amount: 5000,
                        currency: 'usd',
                    },
                },
            });

            const header = stripeInstance.webhooks.generateTestHeaderString({
                payload,
                secret: TEST_STRIPE_SECRET,
            });

            const event = verifyStripeSignature(payload, header, TEST_STRIPE_SECRET);
            expect(event.id).toBe('evt_stripe_valid_001');
            expect(event.type).toBe('payment_intent.succeeded');
            expect(event.livemode).toBe(false);
        });

        test('rejects Stripe webhook with invalid or forged signature (400 Bad Request)', () => {
            const payload = JSON.stringify({
                id: 'evt_stripe_invalid_001',
                object: 'event',
                type: 'payment_intent.succeeded',
                livemode: false,
            });

            const forgedHeader =
                't=1700000000,v1=9999999999999999999999999999999999999999999999999999999999999999';

            expect(() => {
                verifyStripeSignature(payload, forgedHeader, TEST_STRIPE_SECRET);
            }).toThrow(/Stripe signature verification failed/);
        });

        test('rejects tampered Stripe payload where body was altered after signature generation', () => {
            const originalPayload = JSON.stringify({
                id: 'evt_stripe_tamper_001',
                object: 'event',
                type: 'payment_intent.succeeded',
                livemode: false,
                amount: 1000,
            });

            const header = stripeInstance.webhooks.generateTestHeaderString({
                payload: originalPayload,
                secret: TEST_STRIPE_SECRET,
            });

            const tamperedPayload = JSON.stringify({
                id: 'evt_stripe_tamper_001',
                object: 'event',
                type: 'payment_intent.succeeded',
                livemode: false,
                amount: 999999, // Tampered amount!
            });

            expect(() => {
                verifyStripeSignature(tamperedPayload, header, TEST_STRIPE_SECRET);
            }).toThrow(/Stripe signature verification failed/);
        });

        test('rejects Stripe event if livemode = true (Strict Testnet Enforcement)', () => {
            const livemodePayload = JSON.stringify({
                id: 'evt_stripe_live_001',
                object: 'event',
                type: 'payment_intent.succeeded',
                livemode: true, // PROHIBITED!
                data: { object: { id: 'pi_live_001' } },
            });

            const header = stripeInstance.webhooks.generateTestHeaderString({
                payload: livemodePayload,
                secret: TEST_STRIPE_SECRET,
            });

            expect(() => {
                verifyStripeSignature(livemodePayload, header, TEST_STRIPE_SECRET);
            }).toThrow(/CRITICAL: Production livemode Stripe event detected/);
        });
    });

    // ------------------------------------------------------------------------
    // 2. RAZORPAYX SIGNATURE VERIFICATION
    // ------------------------------------------------------------------------
    describe('RazorpayX Signature Verification', () => {
        test('accepts valid RazorpayX signature matching RAZORPAYX_WEBHOOK_SECRET', () => {
            const payload = JSON.stringify({
                entity: 'event',
                event: 'payout.processed',
                id: 'evt_rzp_valid_001',
                payload: { payout: { entity: { id: 'pout_valid_001', status: 'processed' } } },
            });

            const validSig = crypto
                .createHmac('sha256', TEST_RAZORPAY_SECRET)
                .update(payload)
                .digest('hex');

            const isValid = verifyRazorpayXSignature(payload, validSig, TEST_RAZORPAY_SECRET);
            expect(isValid).toBe(true);
        });

        test('rejects RazorpayX webhook with mismatched signature', () => {
            const payload = JSON.stringify({
                entity: 'event',
                event: 'payout.processed',
                id: 'evt_rzp_invalid_001',
            });

            const invalidSig = crypto
                .createHmac('sha256', 'wrong_secret_12345')
                .update(payload)
                .digest('hex');

            const isValid = verifyRazorpayXSignature(payload, invalidSig, TEST_RAZORPAY_SECRET);
            expect(isValid).toBe(false);
        });

        test('fails securely if RAZORPAYX_WEBHOOK_SECRET matches RAZORPAY_KEY_SECRET', () => {
            const sharedSecret = 'compromised_shared_secret';
            process.env.RAZORPAY_KEY_SECRET = sharedSecret;

            expect(() => {
                verifyRazorpayXSignature('{}', 'some_sig', sharedSecret);
            }).toThrow(/SECURITY VIOLATION: Razorpay API key secret must NOT be used/);

            process.env.RAZORPAY_KEY_SECRET = 'rzp_key_secret_different_from_webhook';
        });
    });

    // ------------------------------------------------------------------------
    // 3. PERSISTENT EVENT DEDUPLICATION & REPLAY PROTECTION
    // ------------------------------------------------------------------------
    describe('Event Deduplication & Replay Protection', () => {
        test('initial webhook delivery settles transaction and records deduplication record', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_dedup_001',
                        external_intent_id: 'pi_dedup_001',
                        state: 'PENDING_SETTLEMENT',
                        amount: 100,
                        currency: 'USD',
                        sender: 'ACC_SENDER',
                        recipient: 'ACC_RECIPIENT',
                    },
                ],
            });

            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_dedup_first_001',
                eventType: 'payment_intent.succeeded',
                intentId: 'pi_dedup_001',
                rawBody: '{"id":"evt_dedup_first_001"}',
                writeLedgerFn: mockPool.mockWriteLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(200);
            expect(res.body.settled).toBe(true);
            expect(mockPool.getLedgerWriteCount()).toBe(1);

            const db = mockPool.getDb();
            expect(db.instructions.get('inst_dedup_001').state).toBe('SETTLED');
            expect(db.processed_webhook_events.has('STRIPE:evt_dedup_first_001')).toBe(true);
        });

        test('duplicate event delivery returns 200 Duplicate Ignored without invoking ledger', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_dedup_002',
                        external_intent_id: 'pi_dedup_002',
                        state: 'SETTLED',
                    },
                ],
                processed_webhook_events: [
                    {
                        provider: 'STRIPE',
                        event_id: 'evt_dedup_repeat_001',
                        instruction_id: 'inst_dedup_002',
                    },
                ],
            });

            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_dedup_repeat_001', // Already processed!
                eventType: 'payment_intent.succeeded',
                intentId: 'pi_dedup_002',
                rawBody: '{"id":"evt_dedup_repeat_001"}',
                writeLedgerFn: mockPool.mockWriteLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(200);
            expect(res.body.duplicate).toBe(true);
            expect(res.body.message).toBe('Duplicate event ignored');
            expect(mockPool.getLedgerWriteCount()).toBe(0); // Zero duplicate writes!
        });

        test('missing event identifier returns 400 Bad Request and never generates Date.now ID', async () => {
            const mockPool = createMockPool();

            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'RAZORPAYX',
                eventId: null, // Missing!
                eventType: 'payout.processed',
                intentId: 'pout_missing_id_001',
                rawBody: '{}',
                writeLedgerFn: mockPool.mockWriteLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/Missing required webhook event identifier/);
            expect(mockPool.getLedgerWriteCount()).toBe(0);
        });
    });

    // ------------------------------------------------------------------------
    // 4. TRANSACTION INTEGRITY, ROLLBACK & STATE TRANSITIONS
    // ------------------------------------------------------------------------
    describe('Transaction Integrity & State Transitions', () => {
        test('returns 404 and rolls back event recording if provider reference is unknown', async () => {
            const mockPool = createMockPool({ instructions: [] });

            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_unknown_ref_001',
                eventType: 'payment_intent.succeeded',
                intentId: 'pi_nonexistent_999',
                rawBody: '{}',
                writeLedgerFn: mockPool.mockWriteLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(404);
            expect(res.body.error).toMatch(/Instruction not found/);

            // Confirms event was rolled back and NOT permanently marked processed
            const db = mockPool.getDb();
            expect(db.processed_webhook_events.has('STRIPE:evt_unknown_ref_001')).toBe(false);
        });

        test('prevents duplicate settlement if instruction is already in SETTLED state', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_already_settled',
                        external_intent_id: 'pi_settled_001',
                        state: 'SETTLED', // Already settled
                    },
                ],
            });

            // New event ID for already settled transaction
            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_new_envelope_for_settled',
                eventType: 'payment_intent.succeeded',
                intentId: 'pi_settled_001',
                rawBody: '{}',
                writeLedgerFn: mockPool.mockWriteLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(200);
            expect(res.body.already_settled).toBe(true);
            expect(mockPool.getLedgerWriteCount()).toBe(0); // Invariant maintained: No double-settlement
        });

        test('out-of-order failure event arriving after SETTLED does NOT mutate state to FAILED', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_out_of_order_001',
                        external_intent_id: 'pi_ooo_001',
                        state: 'SETTLED',
                    },
                ],
            });

            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_late_failure_001',
                eventType: 'payment_intent.payment_failed',
                intentId: 'pi_ooo_001',
                rawBody: '{}',
                failureReason: 'Card was declined',
                writeLedgerFn: mockPool.mockWriteLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(200);
            expect(res.body.ignored).toBe(true);
            // State MUST remain SETTLED
            expect(mockPool.getDb().instructions.get('inst_out_of_order_001').state).toBe(
                'SETTLED'
            );
        });

        test('database transaction rollbacks on ledger error, leaving event unrecorded for retry', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_fail_io',
                        external_intent_id: 'pi_fail_io_001',
                        state: 'PENDING_SETTLEMENT',
                        amount: 50,
                        currency: 'USD',
                    },
                ],
            });

            mockPool.setFailLedgerWrite(true); // Induce error during writeLedger

            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_retryable_failure_001',
                eventType: 'payment_intent.succeeded',
                intentId: 'pi_fail_io_001',
                rawBody: '{}',
                writeLedgerFn: mockPool.mockWriteLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(500);
            expect(res.body.error).toMatch(/Database transaction failed/);

            // State must NOT be settled
            expect(mockPool.getDb().instructions.get('inst_fail_io').state).toBe(
                'PENDING_SETTLEMENT'
            );
            // Event must NOT be permanently marked as processed
            expect(
                mockPool.getDb().processed_webhook_events.has('STRIPE:evt_retryable_failure_001')
            ).toBe(false);
        });

        test('legitimate post-settlement Stripe refund transitions state to REFUNDED, not FAILED', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_refund_stripe',
                        external_intent_id: 'pi_refund_001',
                        state: 'SETTLED',
                        amount: '100.00',
                        currency: 'USD',
                        sender: 'ACC_SENDER',
                        recipient: 'ACC_RECIPIENT',
                    },
                ],
            });

            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_stripe_refund_001',
                eventType: 'charge.refunded',
                intentId: 'pi_refund_001',
                rawBody: '{}',
                payload: {
                    id: 're_stripe_refund_001',
                    amount: 10000,
                    currency: 'usd',
                    status: 'succeeded',
                },
                writeLedgerFn: mockPool.mockWriteLedger,
                writeCompensatingLedgerFn: mockPool.mockWriteCompensatingLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(200);
            expect(res.body.state).toBe('REFUNDED');
            expect(mockPool.getCompensatingLedgerWriteCount()).toBe(1);
            expect(mockPool.getDb().instructions.get('inst_refund_stripe').state).toBe('REFUNDED');
        });

        test('legitimate post-settlement RazorpayX reversal transitions state to REVERSED, not FAILED', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_reversal_rzp',
                        external_intent_id: 'pout_reversal_001',
                        state: 'SETTLED',
                    },
                ],
            });

            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'RAZORPAYX',
                eventId: 'evt_rzp_reversal_001',
                eventType: 'payout.reversed',
                intentId: 'pout_reversal_001',
                rawBody: '{}',
                writeLedgerFn: mockPool.mockWriteLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(200);
            expect(res.body.state).toBe('REVERSED');
            expect(mockPool.getDb().instructions.get('inst_reversal_rzp').state).toBe('REVERSED');
        });
    });

    // ------------------------------------------------------------------------
    // 5. ROUTE HANDLERS & LEGACY ENDPOINT SECURITY
    // ------------------------------------------------------------------------
    describe('Route Handlers & Legacy Non-Mutating Gateway', () => {
        test('handleStripeWebhook parses valid signature and calls processor', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_route_stripe_001',
                        external_intent_id: 'pi_route_001',
                        state: 'PENDING_SETTLEMENT',
                        amount: 100,
                        currency: 'USD',
                        sender: 'ACC_A',
                        recipient: 'ACC_B',
                    },
                ],
            });

            const payloadStr = JSON.stringify({
                id: 'evt_route_stripe_001',
                object: 'event',
                type: 'payment_intent.succeeded',
                livemode: false,
                data: {
                    object: {
                        id: 'pi_route_001',
                        amount: 10000,
                        currency: 'usd',
                    },
                },
            });

            const header = stripeInstance.webhooks.generateTestHeaderString({
                payload: payloadStr,
                secret: TEST_STRIPE_SECRET,
            });

            const req = {
                headers: { 'stripe-signature': header },
                rawBody: Buffer.from(payloadStr, 'utf8'),
                body: JSON.parse(payloadStr),
                pool: mockPool,
            };
            const res = createMockRes();

            await handleStripeWebhook(req, res);
            expect(res.statusCode).toBe(200);
            expect(res.bodyData.settled).toBe(true);
        });

        test('handleRazorpayWebhook parses valid signature and calls processor', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_route_rzp_001',
                        external_intent_id: 'pout_route_001',
                        state: 'PENDING_SETTLEMENT',
                        amount: 5000,
                        currency: 'INR',
                        sender: 'ACC_INR_1',
                        recipient: 'ACC_INR_2',
                    },
                ],
            });

            const payloadObj = {
                entity: 'event',
                event: 'payout.processed',
                id: 'evt_route_rzp_001',
                payload: {
                    payout: {
                        entity: {
                            id: 'pout_route_001',
                            status: 'processed',
                        },
                    },
                },
            };
            const payloadStr = JSON.stringify(payloadObj);
            const sig = crypto
                .createHmac('sha256', TEST_RAZORPAY_SECRET)
                .update(payloadStr)
                .digest('hex');

            const req = {
                headers: {
                    'x-razorpay-signature': sig,
                    'x-razorpay-event-id': 'evt_route_rzp_001',
                },
                rawBody: Buffer.from(payloadStr, 'utf8'),
                body: payloadObj,
                pool: mockPool,
            };
            const res = createMockRes();

            await handleRazorpayWebhook(req, res);
            expect(res.statusCode).toBe(200);
            expect(res.bodyData.settled).toBe(true);
        });

        test('handleLegacyGatewayWebhook is strictly non-mutating and returns security warning', async () => {
            const req = { body: { id: 'evt_legacy_001', intent_id: 'pi_test_legacy' } };
            const res = createMockRes();

            await handleLegacyGatewayWebhook(req, res);
            expect(res.statusCode).toBe(200);
            expect(res.bodyData.received).toBe(true);
            expect(res.bodyData.mutated).toBe(false);
            expect(res.bodyData.warning).toMatch(/Legacy gateway endpoint is non-mutating/);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // MILESTONE MR2.1: STRIPE WEBHOOK LIFECYCLE & SAFEGUARD VALIDATIONS
    // ─────────────────────────────────────────────────────────────────────────
    describe('Milestone MR2.1: Stripe Webhook Lifecycle & Safeguards', () => {
        test('flags MANUAL_CHECK and prevents ledger posting on currency mismatch', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_cur_mismatch',
                        external_intent_id: 'pi_cur_mismatch',
                        state: 'PENDING_SETTLEMENT',
                        amount: '100.00',
                        currency: 'USD',
                        sender: 'ACC_SENDER',
                        recipient: 'ACC_RECIPIENT',
                    },
                ],
            });

            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_cur_mismatch',
                eventType: 'payment_intent.succeeded',
                intentId: 'pi_cur_mismatch',
                rawBody: '{"id":"evt_cur_mismatch"}',
                payload: {
                    data: {
                        object: {
                            id: 'pi_cur_mismatch',
                            amount: 10000,
                            currency: 'eur', // Mismatch! (EUR vs USD)
                        },
                    },
                },
                writeLedgerFn: mockPool.mockWriteLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(200);
            expect(res.body.mismatch).toBe(true);
            expect(res.body.reason).toBe('CURRENCY_MISMATCH');
            expect(mockPool.getLedgerWriteCount()).toBe(0); // Zero ledger postings!
            expect(mockPool.getDb().instructions.get('inst_cur_mismatch').state).toBe(
                'MANUAL_CHECK'
            );
        });

        test('flags MANUAL_CHECK and prevents ledger posting on amount mismatch', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_amt_mismatch',
                        external_intent_id: 'pi_amt_mismatch',
                        state: 'PENDING_SETTLEMENT',
                        amount: '100.00',
                        currency: 'USD',
                        sender: 'ACC_SENDER',
                        recipient: 'ACC_RECIPIENT',
                    },
                ],
            });

            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_amt_mismatch',
                eventType: 'payment_intent.succeeded',
                intentId: 'pi_amt_mismatch',
                rawBody: '{"id":"evt_amt_mismatch"}',
                payload: {
                    data: {
                        object: {
                            id: 'pi_amt_mismatch',
                            amount: 5000, // Mismatch! (5000 minor cents = $50 vs expected 10000 = $100)
                            currency: 'usd',
                        },
                    },
                },
                writeLedgerFn: mockPool.mockWriteLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(200);
            expect(res.body.mismatch).toBe(true);
            expect(res.body.reason).toBe('AMOUNT_MISMATCH');
            expect(mockPool.getLedgerWriteCount()).toBe(0); // Zero ledger postings!
            expect(mockPool.getDb().instructions.get('inst_amt_mismatch').state).toBe(
                'MANUAL_CHECK'
            );
        });

        test('handles payment_intent.processing by remaining in PENDING_SETTLEMENT without posting to ledger', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_processing_001',
                        external_intent_id: 'pi_proc_001',
                        state: 'PENDING_EXECUTION',
                        amount: '25.00',
                        currency: 'USD',
                        sender: 'ACC_SENDER',
                        recipient: 'ACC_RECIPIENT',
                    },
                ],
            });

            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_proc_001',
                eventType: 'payment_intent.processing',
                intentId: 'pi_proc_001',
                rawBody: '{"id":"evt_proc_001"}',
                writeLedgerFn: mockPool.mockWriteLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(200);
            expect(res.body.pending).toBe(true);
            expect(res.body.state).toBe('PENDING_SETTLEMENT');
            expect(mockPool.getLedgerWriteCount()).toBe(0);
        });

        test('resolves instruction via external_intent_id even when instructionId metadata is missing', async () => {
            const mockPool = createMockPool({
                instructions: [
                    {
                        instruction_id: 'inst_missing_meta',
                        external_intent_id: 'pi_missing_meta_123',
                        state: 'PENDING_SETTLEMENT',
                        amount: '10.00',
                        currency: 'USD',
                        sender: 'ACC_SENDER',
                        recipient: 'ACC_RECIPIENT',
                    },
                ],
            });

            // Note: instructionId is undefined in params
            const res = await processWebhookEvent({
                pool: mockPool,
                provider: 'STRIPE',
                eventId: 'evt_missing_meta',
                eventType: 'payment_intent.succeeded',
                intentId: 'pi_missing_meta_123',
                rawBody: '{"id":"evt_missing_meta"}',
                payload: {
                    data: {
                        object: {
                            id: 'pi_missing_meta_123',
                            amount: 1000,
                            currency: 'usd',
                            metadata: {}, // Empty metadata!
                        },
                    },
                },
                writeLedgerFn: mockPool.mockWriteLedger,
                verifyLedgerIntegrityFn: mockPool.mockVerifyLedgerIntegrity,
            });

            expect(res.status).toBe(200);
            expect(res.body.settled).toBe(true);
            expect(res.body.instruction_id).toBe('inst_missing_meta');
            expect(mockPool.getLedgerWriteCount()).toBe(1);
            expect(mockPool.getDb().instructions.get('inst_missing_meta').state).toBe('SETTLED');
        });
    });
});
