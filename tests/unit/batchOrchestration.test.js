'use strict';

/**
 * PROJECT FUSION — SPRINT 2.2: BATCH ORCHESTRATION & NORMALIZATION TESTS
 * =======================================================================
 * Unit tests verifying:
 * 1. Mixed Stellar and fiat input ordering preservation
 * 2. Asynchronous executions completing out-of-order resolved to exact input indices
 * 3. Rejected fiat adapter handled gracefully without crashing batch
 * 4. Rejected crypto adapter handled gracefully without crashing batch
 * 5. Missing adapter handled gracefully (no undefined slots)
 * 6. Empty input batch returns empty array
 * 7. Single-item batch (fiat and crypto) handled correctly
 * 8. Multiple transactions with unique instruction IDs correlated 1:1
 * 9. Explicit input_index and instruction_id presence in every result
 * 10. Individual failure isolation (one failure does not corrupt other results)
 * 11. executeBatchPreservingOrder alias functions identically
 *
 * MANDATORY REGRESSION TESTS (FINANCIAL SAFETY & CONSERVATIVE NORMALIZATION):
 * 12. Explicit SUCCESS preserved
 * 13. Explicit FAILED preserved
 * 14. Explicit SIMULATED preserved (SIMULATED never becomes SUCCESS)
 * 15. Explicit PENDING preserved
 * 16. Explicit UNKNOWN preserved
 * 17. Missing status with an error resolves to FAILED
 * 18. success: false resolves to FAILED
 * 19. success: true without explicit status resolves to UNKNOWN (never infer SUCCESS)
 * 20. Boolean false resolves to FAILED
 * 21. Boolean true resolves to UNKNOWN (never infer SUCCESS)
 * 22. Null or undefined response resolves to UNKNOWN
 * 23. Unclassified object resolves to UNKNOWN
 * 24. Unknown status string resolves to UNKNOWN with raw_status preserved
 * 25. Complete mixed-status batch preserves 1:1 correlation and original indices
 */

const { AdapterRegistry } = require('../../core/AdapterRegistry');

describe('Project Fusion — Sprint 2.2: Batch Orchestration & Correlation', () => {
    let registry;

    beforeEach(() => {
        registry = new AdapterRegistry();
    });

    // Helper to register mock fiat and crypto adapters
    function registerMockAdapters({
        fiatHandler = async (inst) => ({ status: 'SUCCESS', rail: 'MOCK_FIAT', currency: inst.currency }),
        cryptoHandler = async (inst) => ({ status: 'SUCCESS', rail: 'STELLAR_TESTNET', currency: inst.currency }),
    } = {}) {
        registry.registerCoreAdapters([
            {
                id: 'mock_fiat_adapter',
                name: 'Mock Fiat Adapter',
                supports: (inst) => ['USD', 'EUR', 'GBP', 'INR', 'CAD'].includes(inst.currency),
                execute: fiatHandler,
                rollback: async () => ({ status: 'ROLLED_BACK' }),
            },
            {
                id: 'mock_crypto_adapter',
                name: 'Mock Crypto Stellar Adapter',
                supports: (inst) => ['XLM', 'BTC', 'ETH', 'USDC'].includes(inst.currency),
                execute: cryptoHandler,
                rollback: async () => ({ status: 'ROLLED_BACK' }),
            },
        ]);
    }

    test('1. Mixed Stellar and fiat input ordering is strictly preserved', async () => {
        registerMockAdapters();

        const instructions = [
            { instruction_id: 'inst_0_crypto', currency: 'XLM', amount: 10 },
            { instruction_id: 'inst_1_fiat', currency: 'USD', amount: 100 },
            { instruction_id: 'inst_2_crypto', currency: 'USDC', amount: 50 },
            { instruction_id: 'inst_3_fiat', currency: 'INR', amount: 5000 },
            { instruction_id: 'inst_4_crypto', currency: 'XLM', amount: 25 },
        ];

        const results = await registry.executeBatchConcurrently(instructions);

        expect(results).toHaveLength(5);
        expect(results[0].instruction_id).toBe('inst_0_crypto');
        expect(results[0].currency).toBe('XLM');
        expect(results[0].input_index).toBe(0);

        expect(results[1].instruction_id).toBe('inst_1_fiat');
        expect(results[1].currency).toBe('USD');
        expect(results[1].input_index).toBe(1);

        expect(results[2].instruction_id).toBe('inst_2_crypto');
        expect(results[2].currency).toBe('USDC');
        expect(results[2].input_index).toBe(2);

        expect(results[3].instruction_id).toBe('inst_3_fiat');
        expect(results[3].currency).toBe('INR');
        expect(results[3].input_index).toBe(3);

        expect(results[4].instruction_id).toBe('inst_4_crypto');
        expect(results[4].currency).toBe('XLM');
        expect(results[4].input_index).toBe(4);
    });

    test('2. Asynchronous fiat transactions completing out of order are mapped to exact input positions', async () => {
        const delays = {
            inst_slow: 40,
            inst_fast: 5,
        };

        registerMockAdapters({
            fiatHandler: async (inst) => {
                const delay = delays[inst.instruction_id] || 10;
                await new Promise((r) => setTimeout(r, delay));
                return { status: 'SUCCESS', delay_ms: delay };
            },
        });

        const instructions = [
            { instruction_id: 'inst_slow', currency: 'USD', amount: 500 },
            { instruction_id: 'inst_fast', currency: 'EUR', amount: 100 },
        ];

        const results = await registry.executeBatchConcurrently(instructions);

        expect(results).toHaveLength(2);
        expect(results[0].instruction_id).toBe('inst_slow');
        expect(results[0].input_index).toBe(0);
        expect(results[0].delay_ms).toBe(40);

        expect(results[1].instruction_id).toBe('inst_fast');
        expect(results[1].input_index).toBe(1);
        expect(results[1].delay_ms).toBe(5);
    });

    test('3. Rejected fiat adapter is normalized without failing the batch', async () => {
        registerMockAdapters({
            fiatHandler: async (inst) => {
                if (inst.instruction_id === 'inst_fiat_bad') {
                    const err = new Error('Stripe API 504 Gateway Timeout');
                    err.code = 'ETIMEDOUT';
                    err.details = { upstream_provider: 'stripe_test' };
                    throw err;
                }
                return { status: 'SUCCESS', rail: 'STRIPE_TESTNET' };
            },
        });

        const instructions = [
            { instruction_id: 'inst_fiat_good_1', currency: 'USD', amount: 100 },
            { instruction_id: 'inst_fiat_bad', currency: 'USD', amount: 200 },
            { instruction_id: 'inst_fiat_good_2', currency: 'EUR', amount: 300 },
        ];

        const results = await registry.executeBatchConcurrently(instructions);

        expect(results).toHaveLength(3);
        expect(results[0].status).toBe('SUCCESS');
        expect(results[0].instruction_id).toBe('inst_fiat_good_1');

        expect(results[1].status).toBe('FAILED');
        expect(results[1].instruction_id).toBe('inst_fiat_bad');
        expect(results[1].input_index).toBe(1);
        expect(results[1].error).toMatch(/Stripe API 504 Gateway Timeout/);
        expect(results[1].error_code).toBe('ETIMEDOUT');
        expect(results[1].error_details).toEqual({ upstream_provider: 'stripe_test' });

        expect(results[2].status).toBe('SUCCESS');
        expect(results[2].instruction_id).toBe('inst_fiat_good_2');
    });

    test('4. Rejected crypto adapter is normalized without failing the batch', async () => {
        registerMockAdapters({
            cryptoHandler: async (inst) => {
                if (inst.instruction_id === 'inst_crypto_bad') {
                    const err = new Error('Horizon submission error: op_underfunded');
                    err.code = 'STELLAR_OP_UNDERFUNDED';
                    throw err;
                }
                return { status: 'SUCCESS', hash: 'stellar_tx_hash_mock' };
            },
        });

        const instructions = [
            { instruction_id: 'inst_crypto_good_1', currency: 'XLM', amount: 10 },
            { instruction_id: 'inst_crypto_bad', currency: 'XLM', amount: 9999999 },
            { instruction_id: 'inst_crypto_good_2', currency: 'USDC', amount: 20 },
        ];

        const results = await registry.executeBatchConcurrently(instructions);

        expect(results).toHaveLength(3);
        expect(results[0].status).toBe('SUCCESS');
        expect(results[0].input_index).toBe(0);

        expect(results[1].status).toBe('FAILED');
        expect(results[1].instruction_id).toBe('inst_crypto_bad');
        expect(results[1].input_index).toBe(1);
        expect(results[1].error).toMatch(/op_underfunded/);
        expect(results[1].error_code).toBe('STELLAR_OP_UNDERFUNDED');

        expect(results[2].status).toBe('SUCCESS');
        expect(results[2].input_index).toBe(2);
    });

    test('5. Missing adapter is handled gracefully without leaving undefined array positions', async () => {
        registerMockAdapters();

        const instructions = [
            { instruction_id: 'inst_usd', currency: 'USD', amount: 100 },
            { instruction_id: 'inst_unsupported_fiat', currency: 'BRL', amount: 500 },
            { instruction_id: 'inst_xlm', currency: 'XLM', amount: 50 },
        ];

        const results = await registry.executeBatchConcurrently(instructions);

        expect(results).toHaveLength(3);
        expect(results[0].status).toBe('SUCCESS');
        expect(results[0].input_index).toBe(0);

        expect(results[1].status).toBe('FAILED');
        expect(results[1].instruction_id).toBe('inst_unsupported_fiat');
        expect(results[1].input_index).toBe(1);
        expect(results[1].error).toMatch(/No fiat adapter found/);

        expect(results[2].status).toBe('SUCCESS');
        expect(results[2].input_index).toBe(2);

        expect(results.every((r) => r !== undefined)).toBe(true);
    });

    test('6. Empty input batch returns empty array immediately', async () => {
        registerMockAdapters();

        const results = await registry.executeBatchConcurrently([]);
        expect(results).toEqual([]);

        const resultsNull = await registry.executeBatchConcurrently(null);
        expect(resultsNull).toEqual([]);
    });

    test('7. Single-item batch functions correctly for both fiat and crypto', async () => {
        registerMockAdapters();

        const fiatSingle = [{ instruction_id: 'inst_single_fiat', currency: 'USD', amount: 150 }];
        const resFiat = await registry.executeBatchConcurrently(fiatSingle);
        expect(resFiat).toHaveLength(1);
        expect(resFiat[0].instruction_id).toBe('inst_single_fiat');
        expect(resFiat[0].input_index).toBe(0);
        expect(resFiat[0].status).toBe('SUCCESS');

        const cryptoSingle = [{ instruction_id: 'inst_single_crypto', currency: 'XLM', amount: 75 }];
        const resCrypto = await registry.executeBatchConcurrently(cryptoSingle);
        expect(resCrypto).toHaveLength(1);
        expect(resCrypto[0].instruction_id).toBe('inst_single_crypto');
        expect(resCrypto[0].input_index).toBe(0);
        expect(resCrypto[0].status).toBe('SUCCESS');
    });

    test('8. Multiple transactions with unique instruction IDs are 1:1 correlated', async () => {
        registerMockAdapters();

        const instructions = Array.from({ length: 8 }, (_, i) => ({
            instruction_id: `uuid-test-${i}-${Date.now()}`,
            currency: i % 2 === 0 ? 'XLM' : 'USD',
            amount: (i + 1) * 10,
        }));

        const results = await registry.executeBatchConcurrently(instructions);

        expect(results).toHaveLength(8);
        instructions.forEach((inst, i) => {
            expect(results[i].instruction_id).toBe(inst.instruction_id);
            expect(results[i].input_index).toBe(i);
        });
    });

    test('9. Explicit input_index and instruction_id are present in every result item', async () => {
        registerMockAdapters();

        const instructions = [
            { instruction_id: 'alpha', currency: 'USD', amount: 10 },
            { instruction_id: 'beta', currency: 'XLM', amount: 20 },
            { instruction_id: 'gamma', currency: 'EUR', amount: 30 },
        ];

        const results = await registry.executeBatchConcurrently(instructions);

        results.forEach((r, idx) => {
            expect(r).toHaveProperty('input_index');
            expect(r).toHaveProperty('instruction_id');
            expect(r.input_index).toBe(idx);
            expect(r.instruction_id).toBe(instructions[idx].instruction_id);
        });
    });

    test('10. One transaction failing does not corrupt or abort preceding or subsequent results', async () => {
        registerMockAdapters({
            fiatHandler: async (inst) => {
                if (inst.instruction_id === 'failing_item_3') {
                    throw new Error('Simulated upstream gateway failure');
                }
                return { status: 'SUCCESS', payout_ref: `ref_${inst.instruction_id}` };
            },
            cryptoHandler: async (inst) => {
                return { status: 'SUCCESS', tx_id: `stellar_${inst.instruction_id}` };
            },
        });

        const instructions = [
            { instruction_id: 'item_0', currency: 'USD', amount: 10 },
            { instruction_id: 'item_1', currency: 'XLM', amount: 20 },
            { instruction_id: 'item_2', currency: 'EUR', amount: 30 },
            { instruction_id: 'failing_item_3', currency: 'USD', amount: 40 },
            { instruction_id: 'item_4', currency: 'XLM', amount: 50 },
            { instruction_id: 'item_5', currency: 'INR', amount: 60 },
        ];

        const results = await registry.executeBatchConcurrently(instructions);

        expect(results).toHaveLength(6);
        expect(results[0].status).toBe('SUCCESS');
        expect(results[1].status).toBe('SUCCESS');
        expect(results[2].status).toBe('SUCCESS');
        expect(results[3].status).toBe('FAILED');
        expect(results[3].error).toMatch(/Simulated upstream gateway failure/);
        expect(results[4].status).toBe('SUCCESS');
        expect(results[5].status).toBe('SUCCESS');

        for (let i = 0; i < 6; i++) {
            expect(results[i].input_index).toBe(i);
            expect(results[i].instruction_id).toBe(instructions[i].instruction_id);
        }
    });

    test('11. executeBatchPreservingOrder alias functions identically to executeBatchConcurrently', async () => {
        registerMockAdapters();

        const instructions = [
            { instruction_id: 'alias_1', currency: 'USD', amount: 10 },
            { instruction_id: 'alias_2', currency: 'XLM', amount: 20 },
        ];

        const results = await registry.executeBatchPreservingOrder(instructions);
        expect(results).toHaveLength(2);
        expect(results[0].instruction_id).toBe('alias_1');
        expect(results[1].instruction_id).toBe('alias_2');
    });

    // ========================================================================
    // MANDATORY CONSERVATIVE NORMALIZATION REGRESSION TESTS
    // ========================================================================
    describe('Mandatory Conservative Normalization Rules (Financial Invariants)', () => {
        test('1. Explicit SUCCESS retains status SUCCESS', async () => {
            registerMockAdapters({
                fiatHandler: async () => ({ status: 'SUCCESS', intent_id: 'pi_success_001' }),
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_exp_success', currency: 'USD', amount: 100 },
            ]);

            expect(results[0].status).toBe('SUCCESS');
            expect(results[0].intent_id).toBe('pi_success_001');
            expect(results[0].input_index).toBe(0);
        });

        test('2. Explicit FAILED retains status FAILED', async () => {
            registerMockAdapters({
                fiatHandler: async () => ({ status: 'FAILED', error: 'Card was declined by issuing bank' }),
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_exp_failed', currency: 'USD', amount: 100 },
            ]);

            expect(results[0].status).toBe('FAILED');
            expect(results[0].error).toMatch(/Card was declined/);
            expect(results[0].input_index).toBe(0);
        });

        test('3. Explicit SIMULATED retains status SIMULATED and never becomes SUCCESS', async () => {
            registerMockAdapters({
                cryptoHandler: async () => ({ status: 'SIMULATED', intent_id: 'sim_stellar_001', note: 'Mock run' }),
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_exp_sim', currency: 'XLM', amount: 100 },
            ]);

            expect(results[0].status).toBe('SIMULATED');
            expect(results[0].status).not.toBe('SUCCESS');
            expect(results[0].intent_id).toBe('sim_stellar_001');
            expect(results[0].input_index).toBe(0);
        });

        test('4. Explicit PENDING retains status PENDING', async () => {
            registerMockAdapters({
                fiatHandler: async () => ({ status: 'PENDING', intent_id: 'pi_in_transit_001' }),
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_exp_pending', currency: 'USD', amount: 100 },
            ]);

            expect(results[0].status).toBe('PENDING');
            expect(results[0].intent_id).toBe('pi_in_transit_001');
            expect(results[0].input_index).toBe(0);
        });

        test('5. Explicit UNKNOWN retains status UNKNOWN', async () => {
            registerMockAdapters({
                fiatHandler: async () => ({ status: 'UNKNOWN', utr: null, note: 'Provider status uncertain' }),
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_exp_unknown', currency: 'INR', amount: 1000 },
            ]);

            expect(results[0].status).toBe('UNKNOWN');
            expect(results[0].status).not.toBe('SUCCESS');
            expect(results[0].input_index).toBe(0);
        });

        test('6. Missing status with an error field resolves strictly to FAILED', async () => {
            registerMockAdapters({
                fiatHandler: async () => ({ error: 'Connection reset by peer' }),
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_err_no_status', currency: 'USD', amount: 100 },
            ]);

            expect(results[0].status).toBe('FAILED');
            expect(results[0].status).not.toBe('SUCCESS');
            expect(results[0].error).toBe('Connection reset by peer');
            expect(results[0].input_index).toBe(0);
        });

        test('7. Missing status with success: false resolves strictly to FAILED', async () => {
            registerMockAdapters({
                fiatHandler: async () => ({ success: false, reason: 'Insufficient liquidity' }),
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_success_false', currency: 'USD', amount: 100 },
            ]);

            expect(results[0].status).toBe('FAILED');
            expect(results[0].status).not.toBe('SUCCESS');
            expect(results[0].input_index).toBe(0);
        });

        test('8. success: true without explicit status resolves to UNKNOWN (never infer financial success)', async () => {
            registerMockAdapters({
                fiatHandler: async () => ({ success: true, tracking_id: 'track_998' }),
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_success_true_no_status', currency: 'USD', amount: 100 },
            ]);

            // INVARIANT: Never infer financial success from success: true!
            expect(results[0].status).toBe('UNKNOWN');
            expect(results[0].status).not.toBe('SUCCESS');
            expect(results[0].tracking_id).toBe('track_998');
            expect(results[0].input_index).toBe(0);
        });

        test('9. Boolean false resolves strictly to FAILED', async () => {
            registerMockAdapters({
                fiatHandler: async () => false,
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_bool_false', currency: 'USD', amount: 100 },
            ]);

            expect(results[0].status).toBe('FAILED');
            expect(results[0].status).not.toBe('SUCCESS');
            expect(results[0].input_index).toBe(0);
        });

        test('10. Boolean true resolves to UNKNOWN (never infer financial success)', async () => {
            registerMockAdapters({
                fiatHandler: async () => true,
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_bool_true', currency: 'USD', amount: 100 },
            ]);

            expect(results[0].status).toBe('UNKNOWN');
            expect(results[0].status).not.toBe('SUCCESS');
            expect(results[0].input_index).toBe(0);
        });

        test('11. Null or undefined response resolves to UNKNOWN', async () => {
            registerMockAdapters({
                fiatHandler: async () => null,
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_null_resp', currency: 'USD', amount: 100 },
            ]);

            expect(results[0].status).toBe('UNKNOWN');
            expect(results[0].status).not.toBe('SUCCESS');
            expect(results[0].input_index).toBe(0);
        });

        test('12. Unclassified object resolves to UNKNOWN', async () => {
            registerMockAdapters({
                fiatHandler: async () => ({ random_payload_key: 12345, provider_blob: 'ok' }),
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_unclassified', currency: 'USD', amount: 100 },
            ]);

            expect(results[0].status).toBe('UNKNOWN');
            expect(results[0].status).not.toBe('SUCCESS');
            expect(results[0].random_payload_key).toBe(12345);
            expect(results[0].input_index).toBe(0);
        });

        test('13. Unknown status string resolves to UNKNOWN and preserves raw_status', async () => {
            registerMockAdapters({
                fiatHandler: async () => ({ status: 'STRIPE_STATUS_WEIRD_CODE', intent_id: 'pi_weird_001' }),
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_unknown_str', currency: 'USD', amount: 100 },
            ]);

            expect(results[0].status).toBe('UNKNOWN');
            expect(results[0].status).not.toBe('SUCCESS');
            expect(results[0].raw_status).toBe('STRIPE_STATUS_WEIRD_CODE');
            expect(results[0].intent_id).toBe('pi_weird_001');
            expect(results[0].input_index).toBe(0);
        });

        test('14. Complete mixed-status batch preserves 1:1 correlation and original indices', async () => {
            const responses = {
                inst_m_0: { status: 'SUCCESS', rail: 'STRIPE' },
                inst_m_1: { status: 'FAILED', error: 'Decline' },
                inst_m_2: { status: 'SIMULATED', rail: 'MOCK_RAIL' },
                inst_m_3: { status: 'PENDING', rail: 'RAZORPAYX' },
                inst_m_4: { status: 'UNKNOWN', raw_status: 'QUEUED' },
                inst_m_5: false, // Boolean false -> FAILED
                inst_m_6: { success: true }, // success:true without status -> UNKNOWN
            };

            registerMockAdapters({
                fiatHandler: async (inst) => responses[inst.instruction_id],
                cryptoHandler: async (inst) => responses[inst.instruction_id],
            });

            const instructions = [
                { instruction_id: 'inst_m_0', currency: 'USD' },
                { instruction_id: 'inst_m_1', currency: 'XLM' },
                { instruction_id: 'inst_m_2', currency: 'EUR' },
                { instruction_id: 'inst_m_3', currency: 'XLM' },
                { instruction_id: 'inst_m_4', currency: 'INR' },
                { instruction_id: 'inst_m_5', currency: 'USD' },
                { instruction_id: 'inst_m_6', currency: 'USDC' },
            ];

            const results = await registry.executeBatchConcurrently(instructions);

            expect(results).toHaveLength(7);

            expect(results[0].status).toBe('SUCCESS');
            expect(results[0].instruction_id).toBe('inst_m_0');
            expect(results[0].input_index).toBe(0);

            expect(results[1].status).toBe('FAILED');
            expect(results[1].instruction_id).toBe('inst_m_1');
            expect(results[1].input_index).toBe(1);

            expect(results[2].status).toBe('SIMULATED');
            expect(results[2].instruction_id).toBe('inst_m_2');
            expect(results[2].input_index).toBe(2);

            expect(results[3].status).toBe('PENDING');
            expect(results[3].instruction_id).toBe('inst_m_3');
            expect(results[3].input_index).toBe(3);

            expect(results[4].status).toBe('UNKNOWN');
            expect(results[4].instruction_id).toBe('inst_m_4');
            expect(results[4].input_index).toBe(4);

            expect(results[5].status).toBe('FAILED');
            expect(results[5].instruction_id).toBe('inst_m_5');
            expect(results[5].input_index).toBe(5);

            expect(results[6].status).toBe('UNKNOWN');
            expect(results[6].instruction_id).toBe('inst_m_6');
            expect(results[6].input_index).toBe(6);
        });

        test('15. SUCCESS with non-empty error string resolves to UNKNOWN (contradiction)', async () => {
            registerMockAdapters({
                fiatHandler: async () => ({ status: 'SUCCESS', error: 'Transaction flagged by risk engine' }),
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_contra_str', currency: 'USD', amount: 100 },
            ]);

            expect(results[0].status).toBe('UNKNOWN');
            expect(results[0].contradiction_detected).toBe(true);
            expect(results[0].contradiction_reason).toMatch(/conflicting success\/error flags/);
            expect(results[0].raw_status).toBe('SUCCESS');
            expect(results[0].input_index).toBe(0);
        });

        test('16. SUCCESS with Error instance resolves to UNKNOWN (contradiction)', async () => {
            registerMockAdapters({
                fiatHandler: async () => ({ status: 'SUCCESS', error: new Error('Post-execution settlement warning') }),
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_contra_err_obj', currency: 'USD', amount: 100 },
            ]);

            expect(results[0].status).toBe('UNKNOWN');
            expect(results[0].contradiction_detected).toBe(true);
            expect(results[0].raw_status).toBe('SUCCESS');
        });

        test('17. SUCCESS with non-empty errors array resolves to UNKNOWN (contradiction)', async () => {
            registerMockAdapters({
                fiatHandler: async () => ({ status: 'SUCCESS', errors: ['Provider reported partial decline'] }),
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_contra_arr', currency: 'USD', amount: 100 },
            ]);

            expect(results[0].status).toBe('UNKNOWN');
            expect(results[0].contradiction_detected).toBe(true);
        });

        test('18. SUCCESS with empty errors array [] preserves SUCCESS (no false contradiction)', async () => {
            registerMockAdapters({
                fiatHandler: async () => ({ status: 'SUCCESS', errors: [], intent_id: 'pi_clean_001' }),
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_clean_empty_err', currency: 'USD', amount: 100 },
            ]);

            expect(results[0].status).toBe('SUCCESS');
            expect(results[0].contradiction_detected).toBeUndefined();
            expect(results[0].intent_id).toBe('pi_clean_001');
        });

        test('19. FAILED with success: true resolves to UNKNOWN (contradiction)', async () => {
            registerMockAdapters({
                fiatHandler: async () => ({ status: 'FAILED', success: true }),
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_contra_fail_succ', currency: 'USD', amount: 100 },
            ]);

            expect(results[0].status).toBe('UNKNOWN');
            expect(results[0].contradiction_detected).toBe(true);
            expect(results[0].raw_status).toBe('FAILED');
        });

        test('20. PROCESSING with non-empty error resolves to UNKNOWN (contradiction)', async () => {
            registerMockAdapters({
                fiatHandler: async () => ({ status: 'PROCESSING', error: 'Network timeout during dispatch' }),
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_contra_proc', currency: 'USD', amount: 100 },
            ]);

            expect(results[0].status).toBe('UNKNOWN');
            expect(results[0].contradiction_detected).toBe(true);
            expect(results[0].raw_status).toBe('PROCESSING');
        });

        test('21. PROCESSING without error standardizes to PENDING with raw_status preserved', async () => {
            registerMockAdapters({
                fiatHandler: async () => ({ status: 'PROCESSING', intent_id: 'proc_123' }),
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'inst_proc_clean', currency: 'USD', amount: 100 },
            ]);

            expect(results[0].status).toBe('PENDING');
            expect(results[0].raw_status).toBe('PROCESSING');
            expect(results[0].intent_id).toBe('proc_123');
        });

        test('22. Input instruction_id is authoritative; conflicting adapter ID stored in adapter_instruction_id', async () => {
            registerMockAdapters({
                fiatHandler: async () => ({
                    status: 'SUCCESS',
                    instruction_id: 'rogue_adapter_inst_999', // Conflicting ID from adapter
                    charge_id: 'ch_12345',
                }),
            });

            const results = await registry.executeBatchConcurrently([
                { instruction_id: 'authoritative_input_id', currency: 'USD', amount: 100 },
            ]);

            expect(results[0].instruction_id).toBe('authoritative_input_id');
            expect(results[0].adapter_instruction_id).toBe('rogue_adapter_inst_999');
            expect(results[0].input_index).toBe(0);
        });

        test('23. Missing input instruction_id defaults deterministically to instruction_${idx}', async () => {
            registerMockAdapters({
                fiatHandler: async () => ({ status: 'SUCCESS' }),
            });

            const results = await registry.executeBatchConcurrently([
                { currency: 'USD', amount: 50 },
            ]);

            expect(results[0].instruction_id).toBe('instruction_0');
            expect(results[0].input_index).toBe(0);
        });

        test('24. Mock adapter returning SUCCESS is defensively clamped to SIMULATED', async () => {
            registry.registerCoreAdapters([
                {
                    id: 'plugin_alipay_mock',
                    name: 'Alipay Mock Plugin',
                    is_mock: true,
                    supports: (inst) => inst.currency === 'CNY',
                    execute: async () => ({ status: 'SUCCESS', intent_id: 'ali_mock_99' }), // Rogue mock attempting SUCCESS
                    rollback: async () => ({ status: 'MOCK_REVERSED' }),
                },
                {
                    id: 'adapter_mock_paypal',
                    name: 'PayPal Mock Adapter',
                    supports: (inst) => inst.currency === 'GBP',
                    execute: async () => ({ status: 'SUCCESS', intent_id: 'pp_mock_88' }), // Prefixed mock attempting SUCCESS
                    rollback: async () => ({ status: 'MOCK_REVERSED' }),
                },
            ]);

            const instructions = [
                { instruction_id: 'inst_cny_mock', currency: 'CNY', amount: 100 },
                { instruction_id: 'inst_gbp_mock', currency: 'GBP', amount: 200 },
            ];

            const results = await registry.executeBatchConcurrently(instructions);

            // Both mock adapters must have SUCCESS clamped to SIMULATED
            expect(results[0].status).toBe('SIMULATED');
            expect(results[0].status).not.toBe('SUCCESS');
            expect(results[0].intent_id).toBe('ali_mock_99');

            expect(results[1].status).toBe('SIMULATED');
            expect(results[1].status).not.toBe('SUCCESS');
            expect(results[1].intent_id).toBe('pp_mock_88');
        });
    });
});
