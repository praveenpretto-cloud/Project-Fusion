require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const API_KEY = process.env.API_SECRET_KEY;
const PORT = process.env.PORT || 3000;
const TRANSACTION_COUNT = 50; // Reduced for debugging, will increase to 50 if successful

// DB Config
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// mTLS Agent setup with higher maxSockets to allow parallelism
const httpsAgent = new https.Agent({
    key: fs.readFileSync(path.join(__dirname, 'certs', 'client.key')),
    cert: fs.readFileSync(path.join(__dirname, 'certs', 'client.crt')),
    ca: fs.readFileSync(path.join(__dirname, 'certs', 'ca.crt')),
    rejectUnauthorized: true,
    maxSockets: 100, // Allow up to 100 concurrent connections
});

async function seedBalances() {
    console.log('🌱 SEEDING BALANCES FOR TEST USERS...');
    const client = await pool.connect();
    try {
        const queries = [];
        for (let i = 1; i <= TRANSACTION_COUNT; i++) {
            queries.push(
                client.query(
                    `INSERT INTO balances (account_id, currency, balance) 
                     VALUES ($1, 'USD', 100000.00) 
                     ON CONFLICT (account_id, currency) 
                     DO UPDATE SET balance = 100000.00`,
                    [`User_Stripe_Scale_${i}`]
                )
            );
        }
        await Promise.all(queries);
        console.log('✅ Balances seeded.');
    } catch (err) {
        console.error('❌ Seeding failed:', err);
        process.exit(1);
    } finally {
        client.release();
    }
}

function makeRequest(path, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: PORT,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEY,
                'x-idempotency-key': `batch_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            },
            agent: httpsAgent,
            timeout: 5000, // Fail fast after 5s
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        });

        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function runFullFlow(i) {
    const amount = parseFloat((10 + i / 10).toFixed(2));
    const sender = `User_Stripe_Scale_${i}`;
    const recipient = `Merchant_Scale_${i}`;
    const adapter = 'ADAPTER_PAYNOW';

    console.log(`[${i}] Starting...`);

    try {
        // 1. Initiate
        const init = await makeRequest('/api/instruction/initiate', 'POST', {
            amount,
            currency: 'USD',
            sender,
            recipient,
            purpose: 'PAYMENT', // 'PAYMENT' triggers real Stripe API, 'STRIPE_SCALE_TEST' triggers mock
        });
        if (init.status !== 200 && init.status !== 201)
            throw new Error(`Initiate failed: ${init.status}`);
        const instructionId = init.data.instructionId;
        console.log(`[${i}] Init OK: ${instructionId}`);

        // 2. Policy
        const policy = await makeRequest('/api/policy/evaluate', 'POST', { instructionId });
        if (policy.status !== 200) throw new Error(`Policy failed: ${policy.status}`);
        console.log(`[${i}] Policy OK`);

        // 3. Route
        const route = await makeRequest('/api/orchestration/route', 'POST', { instructionId });
        if (route.status !== 200) throw new Error(`Route failed: ${route.status}`);
        console.log(`[${i}] Route OK`);

        // 4. Execute
        const adapterToUse = route.data.selectedAdapter; // ✅ Use dynamic adapter from Orchestrator
        console.log(`[${i}] Selected Adapter: ${adapterToUse}`);
        const exec = await makeRequest('/api/adapter/execute', 'POST', { instructionId, adapter: adapterToUse });
        if (exec.status !== 200) throw new Error(`Execute failed: ${exec.status}`);

        if (!exec.data || !exec.data.adapter_result) {
            throw new Error('Invalid response structure');
        }

        const txId = exec.data.adapter_result.intent_id || exec.data.adapter_result.stripe_intent;

        if (!txId) {
            throw new Error(
                `Transaction failed: ${exec.data.adapter_result.error || 'Unknown error'}`
            );
        }

        console.log(`[${i}] Success! Ref: ${txId.substring(0, 10)}...`);
        return true;
    } catch (err) {
        console.error(`[${i}] FAIL: ${err.message}`);
        return false;
    }
}

async function startBatch() {
    await seedBalances();

    console.log(`\n🚀 STARTING STRIPE HIGH-THROUGHPUT TEST (${TRANSACTION_COUNT} TXs)`);
    console.log('===========================================================');

    const startTime = Date.now();

    // Create array of promises to run in parallel
    const promises = [];
    for (let i = 1; i <= TRANSACTION_COUNT; i++) {
        promises.push(runFullFlow(i));
    }

    // Wait for all to complete
    const results = await Promise.all(promises);

    const endTime = Date.now();
    const durationSec = (endTime - startTime) / 1000;
    const successCount = results.filter((r) => r === true).length;

    console.log('\n\n===========================================================');
    console.log(`📊 RESULTS`);
    console.log(`Total Time: ${durationSec.toFixed(2)}s`);
    console.log(`Successful: ${successCount}/${TRANSACTION_COUNT}`);
    if (durationSec > 0) {
        console.log(`TPS:        ${(successCount / durationSec).toFixed(2)}`);
    }
    console.log('===========================================================\n');
}

startBatch().catch(console.error);
