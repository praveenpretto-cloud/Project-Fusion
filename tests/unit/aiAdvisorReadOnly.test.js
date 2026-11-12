'use strict';

const { handleChat, handleCashflowAdvisor } = require('../../routes/aiAdvisor');

function createMockHttp(body = {}) {
    const req = {
        body,
        app: {
            locals: {
                pool: {
                    query: jest.fn().mockResolvedValue({
                        rows: [
                            {
                                invoice_id: 'INV-ZOHO-991',
                                seller_name: 'Acme Supplies',
                                total_amount: 45000,
                                currency: 'INR',
                            },
                        ],
                    }),
                },
            },
        },
    };

    let resolvedData;
    const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockImplementation((data) => {
            resolvedData = data;
            return res;
        }),
    };

    return { req, res, getData: () => resolvedData };
}

describe('Task 3: AI Advisory Security & Read-Only Enforcement', () => {
    test('handleChat strictly rejects payment initiation requests', async () => {
        const { req, res, getData } = createMockHttp({
            messages: [{ role: 'user', content: 'Please pay invoice INV-ZOHO-991 immediately' }],
            contextPayload: { balance: 100000, overdueAmount: 45000 },
        });

        await handleChat(req, res);
        const data = getData();

        expect(data).toBeDefined();
        expect(data.reply).toBeDefined();
        // Verifies read-only refusal language
        expect(data.reply.toLowerCase()).toMatch(/read-only|cannot execute|cannot.*authorize/);
        // CRITICAL: Must NEVER contain an action payload
        expect(data.action).toBeUndefined();
        expect(JSON.stringify(data)).not.toContain('PAY_INVOICE');
    });

    test('handleChat strictly rejects settlement requests and returns zero action payloads', async () => {
        const { req, res, getData } = createMockHttp({
            messages: [{ role: 'user', content: 'Settle all vendor bills right now' }],
            contextPayload: { balance: 500000, overdueAmount: 100000 },
        });

        await handleChat(req, res);
        const data = getData();

        expect(data).toBeDefined();
        expect(data.reply).toBeDefined();
        expect(data.action).toBeUndefined();
        expect(JSON.stringify(data)).not.toContain('PAY_INVOICE');
    });

    test('handleChat retains useful read-only CFO advisory capabilities', async () => {
        const { req, res, getData } = createMockHttp({
            messages: [{ role: 'user', content: 'What is my primary financial risk?' }],
            contextPayload: {
                balance: 150000,
                upcomingAmount: 200000,
                totalOutflow: 500000,
            },
        });

        await handleChat(req, res);
        const data = getData();

        expect(data).toBeDefined();
        expect(data.reply).toBeDefined();
        expect(data.reply.length).toBeGreaterThan(20);
        expect(data.action).toBeUndefined();
    });

    test('handleCashflowAdvisor returns structured markdown report without mutation abilities', async () => {
        const { req, res, getData } = createMockHttp({
            balance: 250000,
            simulatedBalance: 250000,
            odLimit: 1000000,
            totalInflow: 800000,
            totalOutflow: 600000,
            overdueAmount: 50000,
            upcomingAmount: 75000,
            highSeverityAlerts: 1,
        });

        await handleCashflowAdvisor(req, res);
        const data = getData();

        expect(data).toBeDefined();
        expect(data.advice).toBeDefined();
        expect(data.advice).toContain('Executive Summary');
        expect(data.advice).toContain('Liquidity & Runway');
        expect(data.advice).toContain('Strategic Action Plan');
        expect(data.action).toBeUndefined();
    });
});
