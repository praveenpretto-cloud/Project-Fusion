const fs = require('fs');
const https = require('https');
const axios = require('axios');
const { Pool } = require('pg');
require('dotenv').config();

// Configuration
const BASE_URL = 'https://localhost:3000';
const DB_CONFIG = {
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'fusion_db',
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
};

// mTLS Agent
const agent = new https.Agent({
    rejectUnauthorized: false,
    key: fs.readFileSync('certs/client.key'),
    cert: fs.readFileSync('certs/client.crt'),
    ca: fs.readFileSync('certs/ca.crt'),
});

const api = axios.create({
    baseURL: BASE_URL,
    httpsAgent: agent,
    headers: {
        'x-api-key': process.env.API_SECRET_KEY,
        'Content-Type': 'application/json',
    },
});

const pool = new Pool(DB_CONFIG);

describe('💰 End-to-End Settlement Flow', () => {
    let instructionId;
    const testUser = `user_e2e_${Date.now()}`;
    const testRecipient = `recipient_e2e_${Date.now()}`;

    // Setup: Seed Data
    beforeAll(async () => {
        const client = await pool.connect();
        try {
            await client.query(
                `
                INSERT INTO balances (account_id, balance, currency)
                VALUES ($1, 5000.00, 'USD')
                ON CONFLICT (account_id, currency) DO UPDATE SET balance = 5000.00
            `,
                [testUser]
            );
        } finally {
            client.release();
        }
    });

    afterAll(async () => {
        await pool.end();
    });

    test('1. Initiate Instruction', async () => {
        const res = await api.post(
            '/api/instruction/initiate',
            {
                amount: 100.0,
                currency: 'USD',
                sender: testUser,
                recipient: testRecipient,
                purpose: 'PAYMENT',
            },
            {
                headers: { 'x-idempotency-key': `e2e_init_${Date.now()}` },
            }
        );
        expect(res.status).toBe(200);
        expect(res.data.instructionId).toBeDefined();
        instructionId = res.data.instructionId;
    });

    test('2. Evaluate Policy', async () => {
        const res = await api.post(
            '/api/policy/evaluate',
            {
                instructionId,
            },
            {
                headers: { 'x-idempotency-key': `e2e_pol_${Date.now()}` },
            }
        );
        expect(res.status).toBe(200);
        expect(res.data.state).toBe('LOCKED');
    });

    test('3. Route & Execute', async () => {
        // Step A: Route
        const routeRes = await api.post(
            '/api/orchestration/route',
            {
                instructionId,
            },
            {
                headers: { 'x-idempotency-key': `e2e_route_${Date.now()}` },
            }
        );
        expect(routeRes.status).toBe(200);
        const adapter = routeRes.data.selectedAdapter;

        // Step B: Execute
        const execRes = await api.post(
            '/api/adapter/execute',
            {
                instructionId,
                adapter,
            },
            {
                headers: { 'x-idempotency-key': `e2e_exec_${Date.now()}` },
            }
        );
        expect(execRes.status).toBe(200);
        expect(execRes.data.adapter_result.status).toBe('SUCCESS');
    });

    test('4. Verify Final State (DB)', async () => {
        const res = await pool.query('SELECT state FROM instructions WHERE instruction_id = $1', [
            instructionId,
        ]);
        expect(res.rows[0].state).toBe('SETTLED');
    });
});
