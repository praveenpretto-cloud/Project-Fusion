'use strict';

const { executeMockRail, createMockPlugin } = require('../../adapters/mockAdapters');

describe('Task 2: Simulation Isolation & Ledger Protection', () => {
    beforeAll(() => {
        process.env.API_SECRET_KEY = 'fusion_test_secret_key_12345';
    });

    describe('MockAdapter Contract Verification', () => {
        test("executeMockRail returns status: 'SIMULATED' and NEVER 'SUCCESS'", async () => {
            const result = await executeMockRail({ instruction_id: 'inst-test-001', amount: 500, currency: 'USD' });
            expect(result.status).toBe('SIMULATED');
            expect(result.status).not.toBe('SUCCESS');
            expect(result.simulated).toBe(true);
            expect(result.settlement_confirmed).toBe(false);
            expect(result.intent_id).toMatch(/^sim_/);
        });

        test('createMockPlugin returns registry-compliant object returning SIMULATED status', async () => {
            const plugin = createMockPlugin('CRYPTO');
            expect(typeof plugin.execute).toBe('function');
            expect(typeof plugin.rollback).toBe('function');

            const res = await plugin.execute({ instruction_id: 'inst-test-002' });
            expect(res.status).toBe('SIMULATED');
            expect(res.status).not.toBe('SUCCESS');
        });
    });

    describe('Saga Ledger Protection: SIMULATED must never produce SETTLED or write ledger', () => {
        test('injected mock adapter returning SIMULATED marks state as SIMULATED and skips ledger', async () => {
            const mockQueries = [];
            const mockClient = {
                query: jest.fn().mockImplementation((sql, params) => {
                    mockQueries.push({ sql, params });
                    if (sql.includes('SELECT * FROM instructions')) {
                        return {
                            rows: [{
                                instruction_id: 'mock-instruction-uuid',
                                sender: 'ACC_SENDER',
                                recipient: 'ACC_RECIPIENT',
                                amount: 100,
                                currency: 'USD',
                                state: 'LOCKED',
                                provider: 'MOCK',
                                execution_attempts: 0,
                            }],
                        };
                    }
                    if (sql.includes('SELECT state FROM instructions')) {
                        return { rows: [{ state: 'SIMULATED' }] };
                    }
                    return { rows: [] };
                }),
                release: jest.fn(),
            };

            const mockPool = {
                connect: jest.fn().mockResolvedValue(mockClient),
                query: mockClient.query,
            };

            let isolatedSaga;
            jest.isolateModules(() => {
                jest.doMock('../../adapters/paymentsAdapters', () =>
                    Object.freeze({
                        ...jest.requireActual('../../adapters/paymentsAdapters'),
                        executePaymentRail: jest.fn().mockResolvedValue({
                            status: 'SIMULATED',
                            intent_id: 'sim_load_test_9999',
                            simulated: true,
                        }),
                    })
                );
                isolatedSaga = require('../../core/orchestrator/sagaCore');
            });

            const result = await isolatedSaga.processInstructionSagaAtomic('mock-instruction-uuid', mockPool);
            jest.dontMock('../../adapters/paymentsAdapters');

            expect(result.status).toBe('SUCCESS');
            expect(result.current_state).toBe('SIMULATED');
            expect(result.current_state).not.toBe('SETTLED');

            // Verify SIMULATED state update query was executed
            const simulatedStateUpdate = mockQueries.find(q =>
                q.sql.includes("UPDATE instructions SET state = 'SIMULATED'")
            );
            expect(simulatedStateUpdate).toBeDefined();

            // Verify that SETTLED update was NEVER executed
            const settledStateUpdate = mockQueries.find(q =>
                q.sql.includes("UPDATE instructions SET state = 'SETTLED'")
            );
            expect(settledStateUpdate).toBeUndefined();

            // Verify that ledger_entries table was NEVER touched
            const ledgerInsert = mockQueries.find(q =>
                q.sql.includes('INSERT INTO ledger_entries') || q.sql.includes('writeLedger')
            );
            expect(ledgerInsert).toBeUndefined();
        });
    });

    describe('Real Provider Adapters: Synthetic returns removed from catch blocks', () => {
        test('executePaymentRail returns FAILED when Stripe throws', async () => {
            const { executePaymentRail } = jest.requireActual('../../adapters/paymentsAdapters');
            const mockInstruction = {
                instruction_id: 'test-inst-fail',
                amount: 100,
                currency: 'USD',
                sender: 'sender_test',
                recipient: 'recipient_test',
            };

            // In our test environment, Stripe SDK might fail network or card
            const res = await executePaymentRail(mockInstruction);
            // Must be FAILED, never simulated SUCCESS
            expect(['FAILED', 'PROCESSING']).toContain(res.status);
            expect(res.intent_id).toBeUndefined();
        });
    });
});
