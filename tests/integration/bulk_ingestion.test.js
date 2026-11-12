// Mock external infrastructure dependencies to allow testing integration logic
jest.mock('node-cron', () => ({
    schedule: jest.fn(() => ({ stop: jest.fn() })),
}));

jest.mock('../../core/ingestion/kafkaProducer', () => ({
    pushToBatchQueue: jest.fn().mockResolvedValue(true),
}));

jest.mock('ioredis', () => {
    return jest.fn().mockImplementation(() => ({
        setnx: jest.fn().mockResolvedValue(1),
        get: jest.fn().mockResolvedValue(null),
        setex: jest.fn().mockResolvedValue('OK'),
        del: jest.fn().mockResolvedValue(1)
    }));
});

// Mock database pool to bypass actual PG inserts during logic validation
jest.mock('pg', () => {
    const mockQuery = jest.fn().mockResolvedValue({ rows: [{kyc_status: 'VERIFIED', verified: true}] });
    return {
        Pool: jest.fn(() => ({
            query: mockQuery,
            connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() })
        }))
    };
});

const request = require('supertest');
const { pushToBatchQueue } = require('../../core/ingestion/kafkaProducer');

describe('Bulk Ingestion API', () => {
    let app;

    beforeAll(() => {
        app = require('../../server'); 
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should segregate a bulk array payload to correct Kafka topics', async () => {
        const payload = [
            { amount: '100.00', currency: 'USD', sender: '1', recipient: '2', purpose: 'PAYROLL', auth_token: 'afat_valid' },
            { amount: '500.000000', currency: 'USDC', sender: '1', recipient: '2', purpose: 'PAYROLL', auth_token: 'afat_valid' },
            { amount: '50.00', currency: 'EUR', sender: '3', recipient: '4', purpose: 'MARKETPLACE_PAYOUT', auth_token: 'afat_valid' }
        ];

        process.env.LOAD_TEST_MODE = 'true';
        process.env.API_SECRET_KEY = 'test_secret';

        const response = await request(app)
            .post('/api/instruction/initiate')
            .set('x-api-key', 'test_secret')
            .set('x-idempotency-key', 'bulk_test_1')
            .send(payload);

        expect(response.status).toBe(202);
        expect(response.body.state).toBe('QUEUED');
        expect(response.body.instructionIds.length).toBe(3);

        // Verify Kafka interactions
        expect(pushToBatchQueue).toHaveBeenCalledWith('fiat_payouts', expect.any(Array));
        expect(pushToBatchQueue).toHaveBeenCalledWith('crypto_payouts', expect.any(Array));
        expect(pushToBatchQueue).toHaveBeenCalledWith('marketplace_microbatch', expect.any(Array));

        // Allow fire-and-forget sequential worker (3 items * 500ms delay) to complete cleanly
        await new Promise((r) => setTimeout(r, 1600));
    });
});
