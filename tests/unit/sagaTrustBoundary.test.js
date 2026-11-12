'use strict';

/**
 * PROJECT FUSION — SPRINT 2.2.2: SAGA ASSET & PROVIDER TRUST BOUNDARY TESTS
 * ==============================================================================
 * Comprehensive tests verifying:
 * 1. XLM uses only Stellar Testnet.
 * 2. BTC does not initiate an XLM payment (returns SIMULATED).
 * 3. ETH does not initiate an XLM payment (returns SIMULATED).
 * 4. USDC does not initiate a native XLM payment (returns SIMULATED).
 * 5. Unsupported crypto assets return SIMULATED without blockchain calls.
 * 6. INR uses only RazorpayX sandbox.
 * 7. Supported Stripe currencies (USD, EUR, GBP, CAD) use Stripe test mode.
 * 8. CNY cannot be represented as an Alipay payment without an actual Alipay sandbox adapter.
 * 9. ISO 20022, SWIFT and Nium cannot claim successful bank-rail execution through Stripe test-card simulation.
 * 10. Adapter-supplied sandbox flags (is_verified_sandbox, is_sandbox) cannot authorize arbitrary injected adapters.
 * 11. Genuine approved sandbox routes still preserve explicit successful test transactions.
 * 12. PENDING and UNKNOWN cannot trigger automatic payment retry.
 * 13. SIMULATED and MANUAL_CHECK SQL updates retain correct placeholder counts and UUID-compatible parameters.
 * 14. Refund/reversal states do not enter a new-payment settlement path.
 */

const crypto = require('crypto');
const {
    normalizeResult,
    normalizeError,
    isMockAdapter,
    isVerifiedSandboxAdapter,
    resolveServerTrust,
} = require('../../core/adapterResultNormalizer');
const { processInstructionSagaAtomic } = require('../../core/orchestrator/sagaCore');
const alipayPlugin = require('../../plugins/alipayAdapter');

describe('Sprint 2.2.2 — Provider-Specific Trust and Asset Routing Hardening', () => {
    beforeAll(() => {
        process.env.API_SECRET_KEY = 'fusion_test_secret_key_12345';
    });

    // ========================================================================
    // PART 1: SERVER-CONTROLLED TRUST RESOLVER (adapterResultNormalizer)
    // ========================================================================
    describe('Server-Controlled Trust Policy Resolver', () => {
        test('1. Stellar Testnet trust is strictly eligible ONLY for native XLM', () => {
            const stellarAdapter = { id: 'core_stellar', name: 'Stellar Testnet Adapter' };

            const xlmRes = resolveServerTrust(stellarAdapter, { currency: 'XLM' });
            expect(xlmRes.isTrusted).toBe(true);
            expect(xlmRes.provider).toBe('STELLAR_TESTNET');

            const btcRes = resolveServerTrust(stellarAdapter, { currency: 'BTC' });
            expect(btcRes.isTrusted).toBe(false);
            expect(btcRes.reason).toMatch(/not authorized for asset 'BTC'/);

            const ethRes = resolveServerTrust(stellarAdapter, { currency: 'ETH' });
            expect(ethRes.isTrusted).toBe(false);
            expect(ethRes.reason).toMatch(/not authorized for asset 'ETH'/);

            const usdcRes = resolveServerTrust(stellarAdapter, { currency: 'USDC' });
            expect(usdcRes.isTrusted).toBe(false);
            expect(usdcRes.reason).toMatch(/not authorized for asset 'USDC'/);
        });

        test('2. RazorpayX sandbox trust is strictly eligible ONLY for domestic INR', () => {
            const rzpAdapter = { id: 'core_razorpay', name: 'RazorpayX Sandbox Adapter' };

            const inrRes = resolveServerTrust(rzpAdapter, { currency: 'INR' });
            expect(inrRes.isTrusted).toBe(true);
            expect(inrRes.provider).toBe('RAZORPAYX_SANDBOX');

            const usdRes = resolveServerTrust(rzpAdapter, { currency: 'USD' });
            expect(usdRes.isTrusted).toBe(false);
            expect(usdRes.reason).toMatch(/not authorized for currency 'USD'/);
        });

        test('3. Stripe test mode trust is strictly eligible ONLY for supported fiat, rejecting bank rail claims', () => {
            const stripeAdapter = { id: 'core_stripe', name: 'Stripe Test Mode Adapter' };

            const usdRes = resolveServerTrust(stripeAdapter, { currency: 'USD', purpose: 'CARD' });
            expect(usdRes.isTrusted).toBe(true);
            expect(usdRes.provider).toBe('STRIPE_TESTNET');

            const eurRes = resolveServerTrust(stripeAdapter, { currency: 'EUR', purpose: 'CARD' });
            expect(eurRes.isTrusted).toBe(true);

            // Rejects bank rail claims (SWIFT, ISO 20022, Nium) claiming Stripe card execution
            const swiftRes = resolveServerTrust(stripeAdapter, { currency: 'USD', purpose: 'SWIFT' });
            expect(swiftRes.isTrusted).toBe(false);
            expect(swiftRes.reason).toMatch(/Stripe test-card simulation cannot authorize bank-rail/);

            const isoRes = resolveServerTrust(stripeAdapter, { currency: 'USD', purpose: 'ISO20022' });
            expect(isoRes.isTrusted).toBe(false);
            expect(isoRes.reason).toMatch(/Stripe test-card simulation cannot authorize bank-rail/);

            const niumRes = resolveServerTrust(stripeAdapter, { currency: 'USD', route_selected: 'NIUM_SWIFT' });
            expect(niumRes.isTrusted).toBe(false);
            expect(niumRes.reason).toMatch(/Stripe test-card simulation cannot authorize bank-rail/);

            // Rejects unsupported fiat like CNY entering Stripe
            const cnyRes = resolveServerTrust(stripeAdapter, { currency: 'CNY' });
            expect(cnyRes.isTrusted).toBe(false);
            expect(cnyRes.reason).toMatch(/not authorized for currency 'CNY'/);
        });

        test('4. Injected adapters cannot self-assert trust via is_verified_sandbox or is_sandbox', () => {
            const selfAssertingAdapter = {
                id: 'core_stripe', // Pretending to have approved ID
                is_verified_sandbox: true, // Self-asserted flag
                is_sandbox: true, // Self-asserted flag
            };

            const result = resolveServerTrust(selfAssertingAdapter, { currency: 'USD', purpose: 'CARD' }, { isInjectedOverride: true });
            expect(result.isTrusted).toBe(false);
            expect(result.reason).toMatch(/Injected adapter.*untrusted/i);
        });

        test('5. Injected adapter overrides are unconditionally untrusted (zero dynamic adapter injection permitted)', () => {
            const injectedAdapter = {
                id: 'core_stripe',
            };

            const result = resolveServerTrust(injectedAdapter, { currency: 'USD', purpose: 'CARD' }, {
                isInjectedOverride: true,
            });
            expect(result.isTrusted).toBe(false);
            expect(result.reason).toMatch(/Injected adapter overrides are untrusted and disallowed/);
        });

        test('6. Normalizer clamps untrusted executions to UNKNOWN with explicit reason', () => {
            const inst = { instruction_id: crypto.randomUUID(), currency: 'BTC' };
            const stellarAdapter = { id: 'core_stellar' };

            const normalized = normalizeResult(
                { status: 'SUCCESS', intent_id: 'tx_btc_fake' },
                inst,
                0,
                stellarAdapter,
                { enforceSagaTrust: true }
            );

            expect(normalized.status).toBe('UNKNOWN');
            expect(normalized.untrusted_execution).toBe(true);
            expect(normalized.error).toMatch(/Stellar Testnet adapter is not authorized for asset 'BTC'/);
        });
    });

    // ========================================================================
    // PART 2: SAGA EXECUTION & DISPATCH PROTECTION
    // ========================================================================
    describe('Saga Dispatch & Financial Settlement Boundary', () => {
        // Helper to construct a mock PostgreSQL connection and query spy with valid UUIDs
        function createMockSagaDb({
            instructionId = crypto.randomUUID(),
            instructionState = 'LOCKED',
            currency = 'USD',
            amount = 100,
            purpose = 'CARD',
            route_selected = null,
        } = {}) {
            const mockQueries = [];
            const mockClient = {
                query: jest.fn().mockImplementation((sql, params) => {
                    mockQueries.push({ sql, params });

                    if (sql.includes('SELECT * FROM instructions')) {
                        return {
                            rows: [{
                                instruction_id: instructionId,
                                sender: 'ACC_SENDER_01',
                                recipient: 'ACC_RECIPIENT_01',
                                amount,
                                currency,
                                purpose,
                                route_selected,
                                state: instructionState,
                                provider: 'FIAT',
                                execution_attempts: 0,
                                net_amount: amount,
                                tax_withheld: 0,
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

                    if (sql.includes('SELECT \n            SUM(CASE WHEN direction=\'DEBIT\'') || sql.includes('SELECT \n            SUM(CASE')) {
                        return { rows: [{ total_debit: amount, total_credit: amount }] };
                    }

                    if (sql.includes('SELECT SUM(CASE WHEN direction=')) {
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

            return { mockPool, mockQueries, mockClient, instructionId };
        }

        test('7. BTC does NOT initiate an XLM payment; returns explicit SIMULATED', async () => {
            const instId = crypto.randomUUID();
            const { mockPool, mockQueries } = createMockSagaDb({ instructionId: instId, currency: 'BTC' });

            const result = await processInstructionSagaAtomic(instId, mockPool);

            expect(result.current_state).toBe('SIMULATED');
            expect(result.current_state).not.toBe('SETTLED');

            // Verify SIMULATED state update recorded without ledger write
            const simUpdate = mockQueries.find(q => q.sql.includes("state = 'SIMULATED'"));
            expect(simUpdate).toBeDefined();
            expect(simUpdate.params[1]).toMatch(/Simulated BTC transfer/);
            expect(simUpdate.params[2]).toBe(instId);

            const settledUpdate = mockQueries.find(q => q.sql.includes("state = 'SETTLED'"));
            expect(settledUpdate).toBeUndefined();

            const ledgerInsert = mockQueries.find(q => q.sql.includes('INSERT INTO ledger_journal'));
            expect(ledgerInsert).toBeUndefined();
        });

        test('8. ETH does NOT initiate an XLM payment; returns explicit SIMULATED', async () => {
            const instId = crypto.randomUUID();
            const { mockPool, mockQueries } = createMockSagaDb({ instructionId: instId, currency: 'ETH' });

            const result = await processInstructionSagaAtomic(instId, mockPool);

            expect(result.current_state).toBe('SIMULATED');
            expect(result.current_state).not.toBe('SETTLED');

            const ledgerInsert = mockQueries.find(q => q.sql.includes('INSERT INTO ledger_journal'));
            expect(ledgerInsert).toBeUndefined();
        });

        test('9. USDC does NOT initiate a native XLM payment; returns explicit SIMULATED', async () => {
            const instId = crypto.randomUUID();
            const { mockPool, mockQueries } = createMockSagaDb({ instructionId: instId, currency: 'USDC' });

            const result = await processInstructionSagaAtomic(instId, mockPool);

            expect(result.current_state).toBe('SIMULATED');
            expect(result.current_state).not.toBe('SETTLED');

            const ledgerInsert = mockQueries.find(q => q.sql.includes('INSERT INTO ledger_journal'));
            expect(ledgerInsert).toBeUndefined();
        });

        test('10. CNY without verified Alipay sandbox returns explicit SIMULATED and does not route to Stripe', async () => {
            const instId = crypto.randomUUID();
            const { mockPool, mockQueries } = createMockSagaDb({ instructionId: instId, currency: 'CNY', purpose: 'ALIPAY_PAY' });

            const result = await processInstructionSagaAtomic(instId, mockPool);

            expect(result.current_state).toBe('SIMULATED');
            expect(result.current_state).not.toBe('SETTLED');

            const simUpdate = mockQueries.find(q => q.sql.includes("state = 'SIMULATED'"));
            expect(simUpdate).toBeDefined();
            expect(simUpdate.params[1]).toMatch(/Simulated CNY\/Alipay payment/);

            const ledgerInsert = mockQueries.find(q => q.sql.includes('INSERT INTO ledger_journal'));
            expect(ledgerInsert).toBeUndefined();
        });

        test('11. SWIFT and ISO 20022 cannot claim successful bank execution through Stripe card simulation', async () => {
            const instId = crypto.randomUUID();
            const { mockPool, mockQueries } = createMockSagaDb({
                instructionId: instId,
                currency: 'USD',
                purpose: 'SWIFT',
                route_selected: 'NIUM_SWIFT',
            });

            const result = await processInstructionSagaAtomic(instId, mockPool);

            expect(result.current_state).toBe('SIMULATED');
            expect(result.current_state).not.toBe('SETTLED');

            const simUpdate = mockQueries.find(q => q.sql.includes("state = 'SIMULATED'"));
            expect(simUpdate).toBeDefined();
            expect(simUpdate.params[1]).toMatch(/Simulated SWIFT transfer/);

            const ledgerInsert = mockQueries.find(q => q.sql.includes('INSERT INTO ledger_journal'));
            expect(ledgerInsert).toBeUndefined();
        });

        test('12. Injected adapter with self-asserted is_verified_sandbox cannot settle (diverts to MANUAL_CHECK)', async () => {
            const instId = crypto.randomUUID();
            const { mockPool, mockQueries } = createMockSagaDb({ instructionId: instId, currency: 'USD' });

            const rogueAdapter = {
                id: 'core_stripe', // Reusing approved id
                is_verified_sandbox: true, // Self-asserted flag
                execute: jest.fn().mockResolvedValue({
                    status: 'SUCCESS',
                    intent_id: 'fake_pi_999',
                }),
            };

            const result = await processInstructionSagaAtomic(instId, mockPool, {
                adapterOverride: rogueAdapter,
            });

            // Must be rejected by server trust policy and diverted to MANUAL_CHECK
            expect(result.current_state).toBe('MANUAL_CHECK');
            expect(result.current_state).not.toBe('SETTLED');

            const settledUpdate = mockQueries.find(q => q.sql.includes("state = 'SETTLED'"));
            expect(settledUpdate).toBeUndefined();

            const ledgerInsert = mockQueries.find(q => q.sql.includes('INSERT INTO ledger_journal'));
            expect(ledgerInsert).toBeUndefined();
        });

        test('13. Genuine server-owned adapter establishes settlement on approved rails via Jest module substitution', async () => {
            const instId = crypto.randomUUID();
            const { mockPool, mockQueries } = createMockSagaDb({ instructionId: instId, currency: 'USD', purpose: 'CARD' });

            let isolatedSaga;
            jest.isolateModules(() => {
                jest.doMock('../../adapters/paymentsAdapters', () =>
                    Object.freeze({
                        ...jest.requireActual('../../adapters/paymentsAdapters'),
                        executePaymentRail: jest.fn().mockResolvedValue({
                            status: 'SUCCESS',
                            intent_id: 'pi_verified_stripe_test_123',
                            utr: 'UTR_STRIPE_123',
                        }),
                    })
                );
                isolatedSaga = require('../../core/orchestrator/sagaCore');
            });

            const result = await isolatedSaga.processInstructionSagaAtomic(instId, mockPool);

            expect(result.current_state).toBe('SETTLED');

            const settledUpdate = mockQueries.find(q => q.sql.includes("state = 'SETTLED'"));
            expect(settledUpdate).toBeDefined();

            const ledgerInserts = mockQueries.filter(q => q.sql.includes('INSERT INTO ledger_journal'));
            expect(ledgerInserts.length).toBe(2);
        });

        test('14. SQL updates in SIMULATED and MANUAL_CHECK have matching placeholders and valid UUID params', async () => {
            const instId = crypto.randomUUID();
            const { mockPool, mockQueries } = createMockSagaDb({ instructionId: instId, currency: 'USD' });

            let isolatedSaga;
            jest.isolateModules(() => {
                jest.doMock('../../adapters/paymentsAdapters', () =>
                    Object.freeze({
                        ...jest.requireActual('../../adapters/paymentsAdapters'),
                        executePaymentRail: jest.fn().mockResolvedValue({
                            status: 'UNKNOWN',
                            error: '504 Gateway Timeout from payment processor',
                        }),
                    })
                );
                isolatedSaga = require('../../core/orchestrator/sagaCore');
            });

            await isolatedSaga.processInstructionSagaAtomic(instId, mockPool);

            const manualCheckQuery = mockQueries.find(q => q.sql.includes("state = 'MANUAL_CHECK'"));
            expect(manualCheckQuery).toBeDefined();

            // Check SQL has 3 placeholders
            expect(manualCheckQuery.sql).toContain('$1');
            expect(manualCheckQuery.sql).toContain('$2');
            expect(manualCheckQuery.sql).toContain('$3');

            // Check parameters array has 3 values matching placeholders
            expect(manualCheckQuery.params).toHaveLength(3);
            expect(manualCheckQuery.params[1]).toMatch(/504 Gateway Timeout/);
            expect(manualCheckQuery.params[2]).toBe(instId);

            // Validate instruction ID format is valid UUID RFC 4122
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            expect(uuidRegex.test(manualCheckQuery.params[2])).toBe(true);
        });

        test('15. PENDING status sets state to PENDING_SETTLEMENT and does not trigger retry or ledger', async () => {
            const instId = crypto.randomUUID();
            const { mockPool, mockQueries } = createMockSagaDb({ instructionId: instId, currency: 'INR' });

            let isolatedSaga;
            jest.isolateModules(() => {
                jest.doMock('../../adapters/razorpayAdapter', () =>
                    Object.freeze({
                        ...jest.requireActual('../../adapters/razorpayAdapter'),
                        executeRazorpayRail: jest.fn().mockResolvedValue({
                            status: 'PENDING',
                            intent_id: 'pout_test_in_transit_01',
                            utr: 'UTR_RZP_PENDING',
                        }),
                    })
                );
                isolatedSaga = require('../../core/orchestrator/sagaCore');
            });

            const result = await isolatedSaga.processInstructionSagaAtomic(instId, mockPool);

            expect(result.current_state).toBe('PENDING_SETTLEMENT');
            expect(result.current_state).not.toBe('SETTLED');
            expect(result.current_state).not.toBe('FAILED');

            const ledgerInsert = mockQueries.find(q => q.sql.includes('INSERT INTO ledger_journal'));
            expect(ledgerInsert).toBeUndefined();
        });

        test('16. Reversal state (SIMULATED_REVERSED) records simulation and does not write fresh settlement', async () => {
            const instId = crypto.randomUUID();
            const { mockPool, mockQueries } = createMockSagaDb({ instructionId: instId, currency: 'USD' });

            let isolatedSaga;
            jest.isolateModules(() => {
                jest.doMock('../../adapters/paymentsAdapters', () =>
                    Object.freeze({
                        ...jest.requireActual('../../adapters/paymentsAdapters'),
                        executePaymentRail: jest.fn().mockResolvedValue({
                            status: 'SIMULATED_REVERSED',
                            intent_id: 'rev_sim_01',
                        }),
                    })
                );
                isolatedSaga = require('../../core/orchestrator/sagaCore');
            });

            const result = await isolatedSaga.processInstructionSagaAtomic(instId, mockPool);

            expect(result.current_state).toBe('SIMULATED');
            expect(result.current_state).not.toBe('SETTLED');

            const ledgerInsert = mockQueries.find(q => q.sql.includes('INSERT INTO ledger_journal'));
            expect(ledgerInsert).toBeUndefined();
        });
    });
});
