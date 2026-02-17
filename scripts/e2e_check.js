const fs = require('fs');
const https = require('https');
const axios = require('axios');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Config
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
    key: fs.readFileSync(path.join(__dirname, '..', 'certs', 'client.key')),
    cert: fs.readFileSync(path.join(__dirname, '..', 'certs', 'client.crt')),
    ca: fs.readFileSync(path.join(__dirname, '..', 'certs', 'ca.crt')),
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

async function run() {
    console.log('🚀 Starting Zero-Budget E2E Check...');
    const testUser = `user_e2e_${Date.now()}`;
    const testRecipient = `recipient_e2e_${Date.now()}`;
    let instructionId;

    try {
        // 1. Seed
        console.log('1️⃣ Seeding DB...');
        const client = await pool.connect();
        await client.query(`
            INSERT INTO balances (account_id, balance, currency)
            VALUES ($1, 5000.00, 'USD')
            ON CONFLICT (account_id, currency) DO UPDATE SET balance = 5000.00
        `, [testUser]);
        client.release();
        console.log('✅ Seeded.');

        // 2. Initiate
        console.log('2️⃣ Initiating Transaction...');
        const initRes = await api.post('/api/instruction/initiate', {
            amount: 100.00,
            currency: 'USD',
            sender: testUser,
            recipient: testRecipient,
            purpose: 'PAYMENT',
        }, {
            headers: { 'x-idempotency-key': `e2e_init_${Date.now()}` }
        });
        console.log('Init Response:', initRes.status, initRes.data);
        if (initRes.status !== 200) throw new Error(`Init Failed: ${initRes.status}`);
        instructionId = initRes.data.instructionId;
        console.log(`✅ Initiated: ${instructionId}`);

        // 3. Policy
        console.log('3️⃣ Evaluating Policy...');
        const polRes = await api.post('/api/policy/evaluate', {
            instructionId,
        }, {
            headers: { 'x-idempotency-key': `e2e_pol_${Date.now()}` }
        });
        console.log('Policy Response:', polRes.status, JSON.stringify(polRes.data));
        if (polRes.status !== 200) throw new Error(`Policy Failed: ${polRes.status}`);
        console.log(`✅ Policy: ${polRes.data.state}`);

        // 4. Route
        console.log('4️⃣ Routing...');
        const routeRes = await api.post('/api/orchestration/route', {
            instructionId,
        }, {
            headers: { 'x-idempotency-key': `e2e_route_${Date.now()}` }
        });
        console.log('Route Response:', routeRes.status, routeRes.data);
        const adapter = routeRes.data.selectedAdapter;
        console.log(`✅ Routed to: ${adapter}`);

        // 5. Execute
        console.log('5️⃣ Executing...');
        const execRes = await api.post('/api/adapter/execute', {
            instructionId,
            adapter,
        }, {
            headers: { 'x-idempotency-key': `e2e_exec_${Date.now()}` }
        });
        console.log('Execute Response:', execRes.status, execRes.data);
        if (execRes.data.adapter_result.status !== 'SUCCESS') throw new Error(`Execution Failed: ${JSON.stringify(execRes.data)}`);
        console.log(`✅ Executed: ${execRes.data.status}`);

        // 6. Verify
        console.log('6️⃣ Verifying DB State...');
        const verRes = await pool.query('SELECT state FROM instructions WHERE instruction_id = $1', [instructionId]);
        const finalState = verRes.rows[0].state;
        console.log('DB State:', finalState);
        if (finalState !== 'SETTLED') throw new Error(`DB State mismatch: ${finalState}`);
        console.log(`✅ Final State: ${finalState}`);

        console.log('\n✨ E2E TEST PASSED!');
        process.exit(0);
    } catch (err) {
        console.error('\n❌ E2E TEST FAILED:', err.message);
        if (err.response) {
            console.error('Response Data:', JSON.stringify(err.response.data));
            console.error('Response Status:', err.response.status);
        }
        process.exit(1);
    } finally {
        await pool.end();
    }
}

run();
