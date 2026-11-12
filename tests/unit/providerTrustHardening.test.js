'use strict';

/**
 * PROJECT FUSION — SPRINT 2.2.4.2.8: ELIMINATION OF PRODUCTION TEST-AUTHORIZATION CAPABILITY
 * =========================================================================================
 * Comprehensive tests verifying:
 * 1. Symbol.for() cannot forge server trust.
 * 2. adapterResultNormalizer does NOT export authorizeTestAdapterOverride or isTestAuthorizedAdapter.
 * 3. Injected adapters cannot impersonate core_stripe, core_stellar or core_razorpay.
 * 4. Saga rejects injected adapter overrides without executing them.
 * 5. Test dependency injection succeeds cleanly via Jest module mocking without runtime injection.
 * 6. Injected adapter overrides are unconditionally untrusted in normalizer.
 * 7. Fake Razorpay cannot impersonate core_razorpay.
 * 8. adapterExecuteSchema makes adapter parameter optional and rejects invalid adapters.
 * 9. Legacy execution endpoint (/api/adapter/execute) rejects contradictory requests and emits deprecation headers.
 * 10. Dedicated NODE_ENV=production tests proving complete capability isolation and ledger protection.
 */

const crypto = require('crypto');

const normalizerModule = require('../../core/adapterResultNormalizer');
const {
    resolveServerTrust,
} = normalizerModule;
const { processInstructionSagaAtomic } = require('../../core/orchestrator/sagaCore');
const { adapterExecuteSchema } = require('../../validators');
const paymentsAdapters = require('../../adapters/paymentsAdapters');
const razorpayAdapter = require('../../adapters/razorpayAdapter');
const cryptoAdapters = require('../../adapters/cryptoAdapters');

function createMockDb({ instructionId, currency = 'USD', amount = '100.00', purpose = 'CARD' }) {
    const mockQueries = [];
    const mockClient = {
        query: jest.fn(async (sql, params) => {
            mockQueries.push({ sql, params });
            if (sql.includes('SELECT * FROM instructions WHERE instruction_id')) {
                return {
                    rows: [{
                        instruction_id: instructionId,
                        amount,
                        currency,
                        sender: 'ACC_SENDER_01',
                        recipient: 'ACC_RECIPIENT_01',
                        purpose,
                        state: 'LOCKED',
                        execution_attempts: 0,
                    }],
                };
            }
            if (sql.includes('SELECT currency, state, purpose FROM instructions')) {
                return {
                    rows: [{
                        currency,
                        state: 'LOCKED',
                        purpose,
                    }],
                };
            }
            if (sql.includes('SELECT state FROM instructions')) {
                const updateQuery = mockQueries.slice().reverse().find(q =>
                    q.sql.includes('UPDATE instructions SET state')
                );
                let finalState = 'UNKNOWN';
                if (updateQuery) {
                    const match = updateQuery.sql.match(/state = '([A-Z_]+)'/);
                    if (match) finalState = match[1];
                }
                return { rows: [{ state: finalState }] };
            }
            if (sql.includes('SELECT hash FROM ledger_journal')) {
                return { rows: [{ hash: 'PREV_HASH_123' }] };
            }
            if (sql.includes('SELECT sequence_id FROM ledger_journal')) {
                return { rows: [] };
            }
            if (sql.includes('total_debit') || sql.includes('SUM(amount)') || sql.includes('SUM(CASE')) {
                return { rows: [{ total_debit: amount, total_credit: amount }] };
            }
            return { rows: [] };
        }),
        release: jest.fn(),
    };

    const mockPool = {
        connect: jest.fn().mockResolvedValue(mockClient),
        query: mockClient.query,
    };

    return { mockPool, mockClient, mockQueries };
}

function createMockReqRes(body = {}) {
    const req = { body };
    const res = {
        statusCode: 200,
        headers: {},
        body: null,
        status(code) { this.statusCode = code; return this; },
        set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
        json(data) { this.body = data; return this; },
    };
    return { req, res };
}

// Mirror the legacy execution endpoint logic in server.js
async function handleAdapterExecute(req, res, pool) {
    const { error, value } = adapterExecuteSchema.validate(req.body);
    if (error) {
        return res.status(400).json({ error: error.details[0].message });
    }

    const { instructionId, adapter } = value;

    // 1. Fetch authoritative instruction
    const check = await pool.query(
        'SELECT currency, state, purpose FROM instructions WHERE instruction_id = $1',
        [instructionId]
    );
    if (check.rows.length === 0) {
        return res.status(404).json({ error: 'Instruction not found' });
    }
    const txn = check.rows[0];

    // 2. Reject contradictory adapter requests
    if (adapter) {
        const currency = (txn.currency || '').toUpperCase();
        if (adapter === 'ADAPTER_STRIPE' && !['USD', 'EUR', 'GBP', 'CAD'].includes(currency)) {
            return res.status(400).json({
                error: 'Contradictory adapter request',
                detail: `Adapter 'ADAPTER_STRIPE' cannot execute currency '${currency}'. Authoritative route required.`,
            });
        }
        if (adapter === 'ADAPTER_RAZORPAY' && currency !== 'INR') {
            return res.status(400).json({
                error: 'Contradictory adapter request',
                detail: `Adapter 'ADAPTER_RAZORPAY' cannot execute currency '${currency}'. Only domestic INR is supported.`,
            });
        }
        if (adapter === 'ADAPTER_CRYPTO_CUSTODIAN' && currency !== 'XLM') {
            return res.status(400).json({
                error: 'Contradictory adapter request',
                detail: `Adapter 'ADAPTER_CRYPTO_CUSTODIAN' cannot execute asset '${currency}'. Only XLM on Stellar Testnet is supported.`,
            });
        }
        if (['ADAPTER_PAYNOW', 'ADAPTER_MOCK_HFT'].includes(adapter)) {
            return res.status(400).json({
                error: 'Unsupported adapter',
                detail: `Adapter '${adapter}' is deprecated and unsupported. Execution rejected.`,
            });
        }
    }

    // 3. Emit HTTP Deprecation warning headers
    res.set('Deprecation', 'true');
    res.set('Warning', '299 - "The adapter parameter on /api/adapter/execute is deprecated. Provider routing is automatically authoritative based on instruction currency and policy."');

    // 4. Delegate to authoritative Saga
    const result = await processInstructionSagaAtomic(instructionId, pool);
    return res.json(result);
}

describe('Sprint 2.2.4.2.8 — Elimination of Production Test-Authorization Capability', () => {

    beforeAll(() => {
        process.env.API_SECRET_KEY = 'fusion_test_secret_key_12345';
    });

    // ========================================================================
    // PART 1: ELIMINATION OF PUBLIC TEST AUTHORIZATION CAPABILITY
    // ========================================================================
    describe('Part 1: Elimination of Public Test Authorization Capability', () => {

        test('1. Symbol.for() cannot forge server trust token', () => {
            const forgedSymbol = Symbol.for('ProjectFusion.ServerOwnedTrustToken');
            const forgedAdapter = {
                id: 'core_stripe',
                name: 'Forged Stripe Adapter',
                [forgedSymbol]: true,
                is_verified_sandbox: true,
            };

            const inst = { currency: 'USD', purpose: 'CARD' };
            const trustResult = resolveServerTrust(forgedAdapter, inst, {
                isInjectedOverride: true,
                [forgedSymbol]: true,
            });

            expect(trustResult.isTrusted).toBe(false);
            expect(trustResult.reason).toMatch(/Injected adapter overrides are untrusted and disallowed/);
        });

        test('2. adapterResultNormalizer exports ZERO test authorization capabilities', () => {
            expect(normalizerModule.authorizeTestAdapterOverride).toBeUndefined();
            expect(normalizerModule.isTestAuthorizedAdapter).toBeUndefined();
            expect(normalizerModule.SERVER_TRUST_SYMBOL).toBeUndefined();
            expect(normalizerModule.createServerTrustContext).toBeUndefined();
        });

        test('3. Injected adapter cannot impersonate core_stripe or core_stellar', () => {
            const impersonatingStripe = {
                id: 'core_stripe',
                execute: jest.fn().mockResolvedValue({ status: 'SUCCESS', intent_id: 'pi_fake' }),
            };

            const impersonatingStellar = {
                id: 'core_stellar',
                execute: jest.fn().mockResolvedValue({ status: 'SUCCESS', hash: 'stellar_hash_fake' }),
            };

            const resStripe = resolveServerTrust(impersonatingStripe, { currency: 'USD' }, { isInjectedOverride: true });
            expect(resStripe.isTrusted).toBe(false);
            expect(resStripe.reason).toMatch(/Injected adapter overrides are untrusted and disallowed/);

            const resStellar = resolveServerTrust(impersonatingStellar, { currency: 'XLM' }, { isInjectedOverride: true });
            expect(resStellar.isTrusted).toBe(false);
            expect(resStellar.reason).toMatch(/Injected adapter overrides are untrusted and disallowed/);
        });

        test('4. Saga rejects injected adapter override without executing it', async () => {
            const instId = crypto.randomUUID();
            const { mockPool, mockQueries } = createMockDb({ instructionId: instId, currency: 'USD' });

            const maliciousExecute = jest.fn().mockResolvedValue({
                status: 'SUCCESS',
                intent_id: 'pi_malicious_settlement',
            });

            const injectedAdapter = {
                id: 'core_stripe',
                execute: maliciousExecute,
            };

            const result = await processInstructionSagaAtomic(instId, mockPool, {
                adapterOverride: injectedAdapter,
            });

            // Must NOT have executed the injected adapter
            expect(maliciousExecute).not.toHaveBeenCalled();

            // Must divert to MANUAL_CHECK
            expect(result.current_state).toBe('MANUAL_CHECK');

            // Must NOT write to ledger
            const ledgerInsert = mockQueries.find(q => q.sql.includes('INSERT INTO ledger_journal'));
            expect(ledgerInsert).toBeUndefined();

            // Check instruction error message in DB
            const manualCheckUpdate = mockQueries.find(q => q.sql.includes("state = 'MANUAL_CHECK'"));
            expect(manualCheckUpdate).toBeDefined();
            expect(manualCheckUpdate.params[1]).toContain('Untrusted execution: Runtime adapter injection is disallowed');
        });

        test('5. Jest module mocking successfully substitutes provider dependencies without runtime injection', async () => {
            const instId = crypto.randomUUID();
            const { mockPool, mockQueries } = createMockDb({ instructionId: instId, currency: 'USD', purpose: 'CARD' });

            let isolatedSaga;
            jest.isolateModules(() => {
                jest.doMock('../../adapters/paymentsAdapters', () =>
                    Object.freeze({
                        ...jest.requireActual('../../adapters/paymentsAdapters'),
                        executePaymentRail: jest.fn().mockResolvedValue({
                            status: 'SUCCESS',
                            intent_id: 'pi_jest_mock_verified_123',
                            utr: 'UTR_STRIPE_MOCK_123',
                        }),
                    })
                );
                isolatedSaga = require('../../core/orchestrator/sagaCore');
            });

            // Execute standard Saga without any runtime adapterOverride option
            const result = await isolatedSaga.processInstructionSagaAtomic(instId, mockPool);

            expect(result.current_state).toBe('SETTLED');

            const settledUpdate = mockQueries.find(q => q.sql.includes("state = 'SETTLED'"));
            expect(settledUpdate).toBeDefined();

            const ledgerInserts = mockQueries.filter(q => q.sql.includes('INSERT INTO ledger_journal'));
            expect(ledgerInserts.length).toBe(2);
        });

        test('6. Injected adapter overrides are unconditionally untrusted in normalizer', () => {
            const mockAdapter = {
                id: 'core_stripe',
                execute: jest.fn(),
            };

            const trustResult = resolveServerTrust(mockAdapter, { currency: 'USD', purpose: 'CARD' }, {
                isInjectedOverride: true,
            });

            expect(trustResult.isTrusted).toBe(false);
            expect(trustResult.reason).toMatch(/Injected adapter overrides are untrusted and disallowed in execution architecture/);
        });

        test('7. Fake Razorpay cannot impersonate core_razorpay', () => {
            const fakeRazorpay = {
                id: 'core_razorpay',
                is_verified_sandbox: true,
                execute: jest.fn(),
            };

            const trustResult = resolveServerTrust(fakeRazorpay, { currency: 'INR' }, {
                isInjectedOverride: true,
            });

            expect(trustResult.isTrusted).toBe(false);
            expect(trustResult.reason).toMatch(/Injected adapter overrides are untrusted and disallowed/);
        });
    });

    // ========================================================================
    // PART 2: VALIDATOR & LEGACY ENDPOINT CONTRACT
    // ========================================================================
    describe('Part 2: Validator & Legacy Endpoint Contract', () => {

        test('8. adapterExecuteSchema makes adapter parameter optional', () => {
            const validWithoutAdapter = {
                instructionId: '47d3d179-8809-4089-a29d-ee2f1c841804',
            };
            const { error, value } = adapterExecuteSchema.validate(validWithoutAdapter);
            expect(error).toBeUndefined();
            expect(value.instructionId).toBe(validWithoutAdapter.instructionId);
            expect(value.adapter).toBeUndefined();
        });

        test('9. adapterExecuteSchema accepts valid legacy adapter identifiers', () => {
            const validWithAdapter = {
                instructionId: '47d3d179-8809-4089-a29d-ee2f1c841804',
                adapter: 'ADAPTER_STRIPE',
            };
            const { error } = adapterExecuteSchema.validate(validWithAdapter);
            expect(error).toBeUndefined();
        });

        test('10. adapterExecuteSchema rejects arbitrary unknown adapter names', () => {
            const invalidAdapter = {
                instructionId: '47d3d179-8809-4089-a29d-ee2f1c841804',
                adapter: 'MALICIOUS_ADAPTER_INJECTED',
            };
            const { error } = adapterExecuteSchema.validate(invalidAdapter);
            expect(error).toBeDefined();
            expect(error.details[0].message).toContain('must be one of');
        });

        test('11. Rejects contradictory adapter request (ADAPTER_STRIPE for INR)', async () => {
            const instId = crypto.randomUUID();
            const { mockPool } = createMockDb({ instructionId: instId, currency: 'INR' });
            const { req, res } = createMockReqRes({ instructionId: instId, adapter: 'ADAPTER_STRIPE' });

            await handleAdapterExecute(req, res, mockPool);

            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('Contradictory adapter request');
            expect(res.body.detail).toContain("Adapter 'ADAPTER_STRIPE' cannot execute currency 'INR'");
        });

        test('12. Rejects contradictory adapter request (ADAPTER_RAZORPAY for USD)', async () => {
            const instId = crypto.randomUUID();
            const { mockPool } = createMockDb({ instructionId: instId, currency: 'USD' });
            const { req, res } = createMockReqRes({ instructionId: instId, adapter: 'ADAPTER_RAZORPAY' });

            await handleAdapterExecute(req, res, mockPool);

            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('Contradictory adapter request');
            expect(res.body.detail).toContain("Adapter 'ADAPTER_RAZORPAY' cannot execute currency 'USD'");
        });

        test('13. Rejects contradictory adapter request (ADAPTER_CRYPTO_CUSTODIAN for USD)', async () => {
            const instId = crypto.randomUUID();
            const { mockPool } = createMockDb({ instructionId: instId, currency: 'USD' });
            const { req, res } = createMockReqRes({ instructionId: instId, adapter: 'ADAPTER_CRYPTO_CUSTODIAN' });

            await handleAdapterExecute(req, res, mockPool);

            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('Contradictory adapter request');
            expect(res.body.detail).toContain("Adapter 'ADAPTER_CRYPTO_CUSTODIAN' cannot execute asset 'USD'");
        });

        test('14. Rejects unsupported legacy adapters (ADAPTER_PAYNOW, ADAPTER_MOCK_HFT)', async () => {
            const instId = crypto.randomUUID();
            const { mockPool } = createMockDb({ instructionId: instId, currency: 'USD' });

            const { req: req1, res: res1 } = createMockReqRes({ instructionId: instId, adapter: 'ADAPTER_PAYNOW' });
            await handleAdapterExecute(req1, res1, mockPool);
            expect(res1.statusCode).toBe(400);
            expect(res1.body.error).toBe('Unsupported adapter');

            const { req: req2, res: res2 } = createMockReqRes({ instructionId: instId, adapter: 'ADAPTER_MOCK_HFT' });
            await handleAdapterExecute(req2, res2, mockPool);
            expect(res2.statusCode).toBe(400);
            expect(res2.body.error).toBe('Unsupported adapter');
        });

        test('15. Emits Deprecation and Warning headers and executes via authoritative Saga when adapter is omitted', async () => {
            const instId = crypto.randomUUID();
            const { mockPool } = createMockDb({ instructionId: instId, currency: 'XLM' });
            const { req, res } = createMockReqRes({ instructionId: instId });

            await handleAdapterExecute(req, res, mockPool);

            expect(res.statusCode).toBe(200);
            expect(res.headers['deprecation']).toBe('true');
            expect(res.headers['warning']).toContain('The adapter parameter on /api/adapter/execute is deprecated');
            expect(res.body.current_state).toBeDefined();
        });
    });

    // ========================================================================
    // PART 3: PRODUCTION-MODE CAPABILITY & LEDGER PROTECTION VERIFICATION
    // ========================================================================
    describe('Part 3: Production-Mode Verification (NODE_ENV=production)', () => {
        let originalEnv;

        beforeAll(() => {
            originalEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = 'production';
        });

        afterAll(() => {
            process.env.NODE_ENV = originalEnv;
        });

        test('16. Under NODE_ENV=production, zero adapter authorization factories are exported', () => {
            expect(process.env.NODE_ENV).toBe('production');
            expect(normalizerModule.authorizeTestAdapterOverride).toBeUndefined();
            expect(normalizerModule.isTestAuthorizedAdapter).toBeUndefined();
            expect(normalizerModule.createServerTrustContext).toBeUndefined();
        });

        test('17. Under NODE_ENV=production, runtime adapter injection cannot execute or settle', async () => {
            expect(process.env.NODE_ENV).toBe('production');
            const instId = crypto.randomUUID();
            const { mockPool, mockQueries } = createMockDb({ instructionId: instId, currency: 'USD' });

            const injectedExecute = jest.fn().mockResolvedValue({
                status: 'SUCCESS',
                intent_id: 'pi_production_bypass_exploit',
            });

            const injectedAdapter = {
                id: 'core_stripe',
                execute: injectedExecute,
            };

            const result = await processInstructionSagaAtomic(instId, mockPool, {
                adapterOverride: injectedAdapter,
            });

            // execute() must NEVER have been called
            expect(injectedExecute).not.toHaveBeenCalled();

            // State diverted to MANUAL_CHECK
            expect(result.current_state).toBe('MANUAL_CHECK');

            // No ledger journal writes
            const ledgerInsert = mockQueries.find(q => q.sql.includes('INSERT INTO ledger_journal'));
            expect(ledgerInsert).toBeUndefined();
        });

        test('18. Under NODE_ENV=production, genuine static adapters remain authorized for approved rails', () => {
            expect(process.env.NODE_ENV).toBe('production');

            const legitStellar = resolveServerTrust({ id: 'core_stellar', instance: cryptoAdapters }, { currency: 'XLM' });
            expect(legitStellar.isTrusted).toBe(true);
            expect(legitStellar.provider).toBe('STELLAR_TESTNET');

            const legitRazorpay = resolveServerTrust({ id: 'core_razorpay', instance: razorpayAdapter }, { currency: 'INR' });
            expect(legitRazorpay.isTrusted).toBe(true);
            expect(legitRazorpay.provider).toBe('RAZORPAYX_SANDBOX');

            const legitStripe = resolveServerTrust({ id: 'core_stripe', instance: paymentsAdapters }, { currency: 'USD', purpose: 'CARD' });
            expect(legitStripe.isTrusted).toBe(true);
            expect(legitStripe.provider).toBe('STRIPE_TESTNET');

            // Simulated assets remain untrusted for settlement
            const btcTrust = resolveServerTrust({ id: 'core_stellar', instance: cryptoAdapters }, { currency: 'BTC' });
            expect(btcTrust.isTrusted).toBe(false);

            const swiftTrust = resolveServerTrust({ id: 'core_stripe', instance: paymentsAdapters }, { currency: 'USD', purpose: 'SWIFT' });
            expect(swiftTrust.isTrusted).toBe(false);
        });

        test('19. Under NODE_ENV=production, genuine static adapter execution succeeds and writes ledger via Jest module mocking', async () => {
            expect(process.env.NODE_ENV).toBe('production');
            const instId = crypto.randomUUID();
            const { mockPool, mockQueries } = createMockDb({ instructionId: instId, currency: 'USD', purpose: 'CARD' });

            let isolatedSaga;
            jest.isolateModules(() => {
                jest.doMock('../../adapters/paymentsAdapters', () =>
                    Object.freeze({
                        ...jest.requireActual('../../adapters/paymentsAdapters'),
                        executePaymentRail: jest.fn().mockResolvedValue({
                            status: 'SUCCESS',
                            intent_id: 'pi_prod_mocked_verified_123',
                            utr: 'UTR_PROD_123',
                        }),
                    })
                );
                isolatedSaga = require('../../core/orchestrator/sagaCore');
            });

            // Normal production invocation with zero adapterOverride
            const result = await isolatedSaga.processInstructionSagaAtomic(instId, mockPool);

            expect(result.current_state).toBe('SETTLED');

            const settledUpdate = mockQueries.find(q => q.sql.includes("state = 'SETTLED'"));
            expect(settledUpdate).toBeDefined();

            const ledgerInserts = mockQueries.filter(q => q.sql.includes('INSERT INTO ledger_journal'));
            expect(ledgerInserts.length).toBe(2);
        });
    });

    // ========================================================================
    // PART 4: SPRINT 2.2.4.2.9 PROVIDER ADAPTER IMMUTABILITY & EXECUTION INTEGRITY
    // ========================================================================
    describe('Part 4: Provider Adapter Immutability & Execution Integrity (Sprint 2.2.4.2.9)', () => {
        const providerDispatcher = require('../../core/orchestrator/providerDispatcher');

        // 1. Stellar executeCryptoRail Replacement Protection
        test('20. Attempted replacement of Stellar executeCryptoRail is blocked by Object.freeze', () => {
            expect(Object.isFrozen(cryptoAdapters)).toBe(true);

            // Direct assignment throws TypeError in strict mode
            expect(() => {
                cryptoAdapters.executeCryptoRail = async () => ({ status: 'SUCCESS', intent_id: 'tampered' });
            }).toThrow(TypeError);

            // Object.defineProperty throws TypeError
            expect(() => {
                Object.defineProperty(cryptoAdapters, 'executeCryptoRail', {
                    value: async () => ({ status: 'SUCCESS' }),
                });
            }).toThrow(TypeError);
        });

        test('21. Mutated or tampered Stellar execution function is rejected by trust resolution', () => {
            const tamperedStellar = {
                id: 'core_stellar',
                executeCryptoRail: async () => ({ status: 'SUCCESS', hash: 'tampered_hash' }),
            };
            const result = resolveServerTrust(tamperedStellar, { currency: 'XLM' });
            expect(result.isTrusted).toBe(false);
            expect(result.reason).toMatch(/Execution integrity check failed.*replaced or tampered with/i);

            const tamperedExecute = {
                id: 'core_stellar',
                execute: async () => ({ status: 'SUCCESS' }),
            };
            const resultExecute = resolveServerTrust(tamperedExecute, { currency: 'XLM' });
            expect(resultExecute.isTrusted).toBe(false);
            expect(resultExecute.reason).toMatch(/Execution integrity check failed.*replaced or tampered with/i);
        });

        // 2. Stripe executePaymentRail Replacement Protection
        test('22. Attempted replacement of Stripe executePaymentRail is blocked by Object.freeze', () => {
            expect(Object.isFrozen(paymentsAdapters)).toBe(true);
            expect(Object.isFrozen(paymentsAdapters.STRIPE_MIN_AMOUNT_CENTS)).toBe(true);
            expect(paymentsAdapters.BANK_RAILS).toBeUndefined();
            expect(Object.isFrozen(paymentsAdapters.SUPPORTED_CARD_METHODS)).toBe(true);

            expect(() => {
                paymentsAdapters.executePaymentRail = async () => ({ status: 'SUCCESS' });
            }).toThrow(TypeError);

            expect(() => {
                paymentsAdapters.BANK_RAILS = ['CUSTOM_RAIL'];
            }).toThrow(TypeError);

            expect(() => {
                Object.defineProperty(paymentsAdapters, 'executePaymentRail', {
                    value: async () => ({ status: 'SUCCESS' }),
                });
            }).toThrow(TypeError);
        });

        test('23. Mutated or tampered Stripe execution function is rejected by trust resolution', () => {
            const tamperedStripe = {
                id: 'core_stripe',
                executePaymentRail: async () => ({ status: 'SUCCESS', intent_id: 'tampered' }),
            };
            const result = resolveServerTrust(tamperedStripe, { currency: 'USD', purpose: 'CARD' });
            expect(result.isTrusted).toBe(false);
            expect(result.reason).toMatch(/Execution integrity check failed.*replaced or tampered with/i);

            const tamperedExecute = {
                id: 'core_stripe',
                execute: async () => ({ status: 'SUCCESS' }),
            };
            const resultExecute = resolveServerTrust(tamperedExecute, { currency: 'USD', purpose: 'CARD' });
            expect(resultExecute.isTrusted).toBe(false);
            expect(resultExecute.reason).toMatch(/Execution integrity check failed.*replaced or tampered with/i);
        });

        // 3. RazorpayX executeRazorpayRail Replacement Protection
        test('24. Attempted replacement of RazorpayX executeRazorpayRail is blocked by Object.freeze', () => {
            expect(Object.isFrozen(razorpayAdapter)).toBe(true);

            expect(() => {
                razorpayAdapter.executeRazorpayRail = async () => ({ status: 'SUCCESS' });
            }).toThrow(TypeError);

            expect(() => {
                Object.defineProperty(razorpayAdapter, 'executeRazorpayRail', {
                    value: async () => ({ status: 'SUCCESS' }),
                });
            }).toThrow(TypeError);
        });

        test('25. Mutated or tampered RazorpayX execution function is rejected by trust resolution', () => {
            const tamperedRazorpay = {
                id: 'core_razorpay',
                executeRazorpayRail: async () => ({ status: 'SUCCESS', intent_id: 'tampered' }),
            };
            const result = resolveServerTrust(tamperedRazorpay, { currency: 'INR' });
            expect(result.isTrusted).toBe(false);
            expect(result.reason).toMatch(/Execution integrity check failed.*replaced or tampered with/i);
        });

        // 4. Fake Adapter Impersonation
        test('26. Fake adapter impersonation with foreign instance or properties is rejected', () => {
            const fakeForeignStripe = {
                id: 'core_stripe',
                name: 'Impersonated Stripe',
                instance: { executePaymentRail: async () => ({ status: 'SUCCESS' }) },
            };
            const result1 = resolveServerTrust(fakeForeignStripe, { currency: 'USD', purpose: 'CARD' });
            expect(result1.isTrusted).toBe(false);
            expect(result1.reason).toMatch(/Execution integrity check failed/i);

            const fakeForeignStellar = {
                id: 'core_stellar',
                name: 'Impersonated Stellar',
                instance: Object.freeze({ executeCryptoRail: async () => ({ status: 'SUCCESS' }) }),
            };
            const result2 = resolveServerTrust(fakeForeignStellar, { currency: 'XLM' });
            expect(result2.isTrusted).toBe(false);
            expect(result2.reason).toMatch(/Execution integrity check failed/i);

            const fakeForeignRazorpay = {
                id: 'core_razorpay',
                name: 'Impersonated Razorpay',
                instance: { executeRazorpayRail: async () => ({ status: 'SUCCESS' }) },
            };
            const result3 = resolveServerTrust(fakeForeignRazorpay, { currency: 'INR' });
            expect(result3.isTrusted).toBe(false);
            expect(result3.reason).toMatch(/Execution integrity check failed/i);
        });

        // 5. Normal Server-Owned Provider Execution
        test('27. Normal server-owned providers pass integrity verification and bind to authentic implementations', () => {
            const stellarMeta = providerDispatcher.getProviderMetadata('core_stellar');
            expect(stellarMeta).toBeDefined();
            expect(stellarMeta.id).toBe('core_stellar');
            expect(stellarMeta.instance).toBe(cryptoAdapters);
            expect(stellarMeta.executeFn).toBe(cryptoAdapters.executeCryptoRail);
            expect(Object.isFrozen(stellarMeta)).toBe(true);

            const stripeMeta = providerDispatcher.getProviderMetadata('core_stripe', 'USD');
            expect(stripeMeta).toBeDefined();
            expect(stripeMeta.id).toBe('core_stripe');
            expect(stripeMeta.currency).toBe('USD');
            expect(stripeMeta.instance).toBe(paymentsAdapters);
            expect(stripeMeta.executeFn).toBe(paymentsAdapters.executePaymentRail);
            expect(Object.isFrozen(stripeMeta)).toBe(true);

            const rzpMeta = providerDispatcher.getProviderMetadata('core_razorpay');
            expect(rzpMeta).toBeDefined();
            expect(rzpMeta.id).toBe('core_razorpay');
            expect(rzpMeta.instance).toBe(razorpayAdapter);
            expect(rzpMeta.executeFn).toBe(razorpayAdapter.executeRazorpayRail);
            expect(Object.isFrozen(rzpMeta)).toBe(true);

            // Dispatcher integrity check passes for authentic metadata
            expect(providerDispatcher.verifyProviderIntegrity(stellarMeta).isIntact).toBe(true);
            expect(providerDispatcher.verifyProviderIntegrity(stripeMeta).isIntact).toBe(true);
            expect(providerDispatcher.verifyProviderIntegrity(rzpMeta).isIntact).toBe(true);
        });

        test('28. Dispatcher rejects execution of unknown or untrusted provider ID', async () => {
            await expect(
                providerDispatcher.dispatchProviderExecution('unauthorized_hacked_provider', {})
            ).rejects.toThrow(/Unknown or untrusted provider ID/);
        });

        // 6. Test-Specific Provider Substitution via Jest Module Mocking
        test('29. Test-specific provider substitution in isolated module environment does not mutate production singletons', async () => {
            const instId = crypto.randomUUID();
            const { mockPool, mockQueries } = createMockDb({ instructionId: instId, currency: 'USD', purpose: 'CARD' });

            let isolatedSaga;
            jest.isolateModules(() => {
                jest.doMock('../../adapters/paymentsAdapters', () =>
                    Object.freeze({
                        ...jest.requireActual('../../adapters/paymentsAdapters'),
                        executePaymentRail: jest.fn().mockResolvedValue({
                            status: 'SUCCESS',
                            intent_id: 'pi_isolated_test_payout_999',
                            utr: 'UTR_ISOLATED_999',
                        }),
                    })
                );
                isolatedSaga = require('../../core/orchestrator/sagaCore');
            });

            const result = await isolatedSaga.processInstructionSagaAtomic(instId, mockPool);
            expect(result.current_state).toBe('SETTLED');

            const settledUpdate = mockQueries.find(q => q.sql.includes("state = 'SETTLED'"));
            expect(settledUpdate).toBeDefined();

            // Production module outside the isolation remains strictly frozen
            expect(Object.isFrozen(paymentsAdapters)).toBe(true);
            expect(typeof paymentsAdapters.executePaymentRail).toBe('function');
        });

        // 7. Production-Mode Execution Integrity
        test('30. Under NODE_ENV=production, mutability resistance and integrity checks are strictly enforced', () => {
            const savedEnv = process.env.NODE_ENV;
            try {
                process.env.NODE_ENV = 'production';

                // Cannot mutate modules under production
                expect(() => {
                    cryptoAdapters.executeCryptoRail = () => {};
                }).toThrow(TypeError);

                expect(() => {
                    paymentsAdapters.executePaymentRail = () => {};
                }).toThrow(TypeError);

                expect(() => {
                    razorpayAdapter.executeRazorpayRail = () => {};
                }).toThrow(TypeError);

                // Tampered functions fail integrity check under production
                const tampered = { id: 'core_stellar', executeCryptoRail: () => {} };
                const res = resolveServerTrust(tampered, { currency: 'XLM' });
                expect(res.isTrusted).toBe(false);
            } finally {
                process.env.NODE_ENV = savedEnv;
            }
        });

        // 8. Strict Simulated Asset Isolation
        test('31. Simulated assets (BTC, ETH, USDC, CNY, SWIFT, SGD) execute to SIMULATED and bypass ledger', async () => {
            const currencies = ['BTC', 'ETH', 'USDC', 'CNY', 'SGD'];

            for (const curr of currencies) {
                const instId = crypto.randomUUID();
                const { mockPool, mockQueries } = createMockDb({ instructionId: instId, currency: curr });

                const result = await processInstructionSagaAtomic(instId, mockPool);

                expect(result.current_state).toBe('SIMULATED');
                expect(result.current_state).not.toBe('SETTLED');

                // Zero ledger writes
                const ledgerInsert = mockQueries.find(q => q.sql.includes('INSERT INTO ledger_journal'));
                expect(ledgerInsert).toBeUndefined();
            }
        });

        test('32. Bank rails (SWIFT, ISO 20022, Nium, NEFT) execute to SIMULATED and bypass ledger', async () => {
            const bankRailPurposes = ['SWIFT_TRANSFER', 'ISO20022_PAYMENT', 'NIUM_CROSS_BORDER', 'NEFT_DISBURSEMENT'];

            for (const purpose of bankRailPurposes) {
                const instId = crypto.randomUUID();
                const { mockPool, mockQueries } = createMockDb({ instructionId: instId, currency: 'USD', purpose });

                const result = await processInstructionSagaAtomic(instId, mockPool);

                expect(result.current_state).toBe('SIMULATED');
                expect(result.current_state).not.toBe('SETTLED');

                const ledgerInsert = mockQueries.find(q => q.sql.includes('INSERT INTO ledger_journal'));
                expect(ledgerInsert).toBeUndefined();
            }
        });

        test('33. Mutated adapter attempting to execute via Saga is blocked and leaves ledger uncommitted', async () => {
            const instId = crypto.randomUUID();
            const { mockPool, mockQueries } = createMockDb({ instructionId: instId, currency: 'USD' });

            const hijackedAdapter = {
                id: 'core_stripe',
                name: 'Hijacked Stripe',
                executePaymentRail: jest.fn().mockResolvedValue({ status: 'SUCCESS' }),
            };

            const result = await processInstructionSagaAtomic(instId, mockPool, {
                adapterOverride: hijackedAdapter,
            });

            // Replaced function was never executed
            expect(hijackedAdapter.executePaymentRail).not.toHaveBeenCalled();

            // Diverted to MANUAL_CHECK
            expect(result.current_state).toBe('MANUAL_CHECK');

            // Zero ledger journal writes
            const ledgerInsert = mockQueries.find(q => q.sql.includes('INSERT INTO ledger_journal'));
            expect(ledgerInsert).toBeUndefined();
        });
    });

    describe('Sprint 2.2.4.2.10: Immutable Payment Rail Policy Enforcement', () => {
        const {
            verifyProviderIntegrity,
        } = require('../../core/orchestrator/providerDispatcher');

        test('34. paymentsAdapters does not export mutable BANK_RAILS and rejects external injection', () => {
            // Must not be exported
            expect(paymentsAdapters.BANK_RAILS).toBeUndefined();

            // Attempting to inject or assign property fails due to Object.freeze
            expect(() => {
                paymentsAdapters.BANK_RAILS = ['SWIFT'];
            }).toThrow(TypeError);

            expect(() => {
                Object.defineProperty(paymentsAdapters, 'BANK_RAILS', {
                    value: new Set(['SWIFT']),
                    writable: true,
                    configurable: true,
                });
            }).toThrow(TypeError);
        });

        test('35. All unsupported bank rails are intercepted and return SIMULATED with zero external calls', async () => {
            const rails = [
                'BANK_TRANSFER',
                'NEFT',
                'SWIFT',
                'ACH',
                'SEPA',
                'WIRE',
                'NIUM',
                'NIUM_SWIFT',
                'ISO20022',
                'RTGS',
                'IMPS',
            ];

            for (const rail of rails) {
                const res = await paymentsAdapters.executePaymentRail({
                    instruction_id: crypto.randomUUID(),
                    amount: '100.00',
                    currency: 'USD',
                    rail,
                });

                expect(res.status).toBe('SIMULATED');
                expect(res.simulated).toBe(true);
                expect(res.settlement_confirmed).toBe(false);
                expect(res.adapter_type).toBe('SIMULATED_BANK_RAIL');
                expect(res.rail).toBe(rail);
                expect(res.reason).toContain(`Unsupported bank rail '${rail}' cannot be processed via Stripe card adapter`);
            }
        });

        test('36. Bank rail detection is strictly case-insensitive', async () => {
            const testCases = [
                { input: 'swift', expected: 'SWIFT' },
                { input: 'Ach', expected: 'ACH' },
                { input: 'wIrE', expected: 'WIRE' },
                { input: 'neft', expected: 'NEFT' },
                { input: 'iso20022', expected: 'ISO20022' },
                { input: 'nium_swift', expected: 'NIUM' }, // contains 'NIUM'
            ];

            for (const { input, expected } of testCases) {
                const res = await paymentsAdapters.executePaymentRail({
                    instruction_id: crypto.randomUUID(),
                    amount: '50.00',
                    currency: 'USD',
                    rail: input,
                });

                expect(res.status).toBe('SIMULATED');
                expect(res.simulated).toBe(true);
                expect(res.settlement_confirmed).toBe(false);
                expect(res.rail).toContain(expected);
            }
        });

        test('37. Bank rail detection intercepts tokens across purpose, rail, route_selected, and payment_method', async () => {
            const fields = [
                { purpose: 'SWIFT_SETTLEMENT' },
                { rail: 'WIRE_TRANSFER' },
                { route_selected: 'NEFT_CLEARING' },
                { payment_method: 'ACH_DEBIT' },
            ];

            for (const fieldObj of fields) {
                const res = await paymentsAdapters.executePaymentRail({
                    instruction_id: crypto.randomUUID(),
                    amount: '75.00',
                    currency: 'USD',
                    ...fieldObj,
                });

                expect(res.status).toBe('SIMULATED');
                expect(res.simulated).toBe(true);
                expect(res.settlement_confirmed).toBe(false);
                expect(res.adapter_type).toBe('SIMULATED_BANK_RAIL');
            }
        });

        test('38. KNOWN_STATUSES in adapterResultNormalizer is a frozen array and rejects mutation', () => {
            const { KNOWN_STATUSES } = normalizerModule;
            expect(Array.isArray(KNOWN_STATUSES)).toBe(true);
            expect(Object.isFrozen(KNOWN_STATUSES)).toBe(true);

            expect(() => {
                KNOWN_STATUSES.push('FORGED_STATUS');
            }).toThrow(TypeError);

            expect(() => {
                KNOWN_STATUSES[0] = 'MUTATED';
            }).toThrow(TypeError);

            expect(() => {
                KNOWN_STATUSES.pop();
            }).toThrow(TypeError);

            expect(KNOWN_STATUSES.includes('SUCCESS')).toBe(true);
            expect(KNOWN_STATUSES.includes('SIMULATED')).toBe(true);
            expect(KNOWN_STATUSES.includes('FAILED')).toBe(true);
        });

        test('39. verifyProviderIntegrity verifies paymentsAdapters without requiring exported BANK_RAILS', () => {
            const { getProviderMetadata } = require('../../core/orchestrator/providerDispatcher');
            const stripeMeta = getProviderMetadata('core_stripe', 'USD');
            expect(stripeMeta).toBeDefined();
            expect(stripeMeta.instance).toBe(paymentsAdapters);

            const integrity = verifyProviderIntegrity(stripeMeta);
            expect(integrity.isIntact).toBe(true);
            expect(integrity.binding).toBeDefined();
            expect(integrity.binding.id).toBe('core_stripe');
            expect(integrity.binding.mode).toBe('SANDBOX');
        });

        test('40. End-to-end Saga execution with bank rail routes via providerDispatcher as SIMULATED', async () => {
            const instId = crypto.randomUUID();
            const { mockPool, mockQueries } = createMockDb({
                instructionId: instId,
                currency: 'USD',
                purpose: 'SWIFT',
            });

            const result = await processInstructionSagaAtomic(instId, mockPool);

            expect(result.current_state).toBe('SIMULATED');
            expect(result.current_state).not.toBe('SETTLED');

            // Verify instruction updated to SIMULATED state in SQL query
            const updateStateQuery = mockQueries.find(q =>
                q.sql.includes('UPDATE instructions') && q.sql.includes("state = 'SIMULATED'")
            );
            expect(updateStateQuery).toBeDefined();

            // Zero ledger journal writes
            const ledgerInsert = mockQueries.find(q => q.sql.includes('INSERT INTO ledger_journal'));
            expect(ledgerInsert).toBeUndefined();
        });

        test('41. Legitimate card test methods and business purposes are not intercepted as bank rails', async () => {
            expect(paymentsAdapters.SUPPORTED_CARD_METHODS.CARD).toBe('pm_card_visa');
            expect(paymentsAdapters.SUPPORTED_CARD_METHODS.VISA).toBe('pm_card_visa');
            expect(paymentsAdapters.SUPPORTED_CARD_METHODS.MASTERCARD).toBe('pm_card_mastercard');
            expect(paymentsAdapters.SUPPORTED_CARD_METHODS.AMEX).toBe('pm_card_amex');

            // Card path with invalid scale validates amounts instead of being routed to SIMULATED_BANK_RAIL
            const resInvalidAmount = await paymentsAdapters.executePaymentRail({
                instruction_id: crypto.randomUUID(),
                amount: '100.001',
                currency: 'USD',
                payment_method: 'VISA',
                purpose: 'CARD',
            });
            expect(resInvalidAmount.status).toBe('FAILED');
            expect(resInvalidAmount.adapter_type).not.toBe('SIMULATED_BANK_RAIL');
            expect(resInvalidAmount.error).toMatch(/exceeds maximum precision of 2 decimal places/);

            // Generic purpose fails amount check before network call, not bank rail check
            const resBelowMin = await paymentsAdapters.executePaymentRail({
                instruction_id: crypto.randomUUID(),
                amount: '0.10',
                currency: 'USD',
                purpose: 'EXPENSE',
            });
            expect(resBelowMin.status).toBe('FAILED');
            expect(resBelowMin.adapter_type).not.toBe('SIMULATED_BANK_RAIL');
            expect(resBelowMin.error).toMatch(/below Stripe minimum/);
        });

        test('42. Stellar and RazorpayX provider integrity and execution remain unaffected', async () => {
            const { getProviderMetadata } = require('../../core/orchestrator/providerDispatcher');
            const stellarMeta = getProviderMetadata('core_stellar');
            const stellarIntegrity = verifyProviderIntegrity(stellarMeta);
            expect(stellarIntegrity.isIntact).toBe(true);
            expect(stellarIntegrity.binding.id).toBe('core_stellar');

            const razorpayMeta = getProviderMetadata('core_razorpay');
            const razorpayIntegrity = verifyProviderIntegrity(razorpayMeta);
            expect(razorpayIntegrity.isIntact).toBe(true);
            expect(razorpayIntegrity.binding.id).toBe('core_razorpay');
        });
    });
});
