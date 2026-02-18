const axios = require('axios');
const https = require('https');

const API_URL = 'https://localhost:3000/api';
const API_KEY = 'fusion_bank_secret_key_2025';
const TOTAL_TXNS = 200;
const CONCURRENCY_LIMIT = 5; // Safe concurrency for Stripe Testnet

const agent = new https.Agent({ rejectUnauthorized: false });
const client = axios.create({
    httpsAgent: agent,
    headers: { 'x-api-key': API_KEY },
    validateStatus: () => true
});

async function runSingleTransaction(index) {
    const amount = (Math.random() * (50 - 10) + 10).toFixed(2);
    const idempotencyPrefix = `stress_${Date.now()}_${index}`;
    const start = Date.now();

    try {
        // 1. INITIATE
        const initRes = await client.post(`${API_URL}/instruction/initiate`, {
            amount: parseFloat(amount),
            currency: 'USD',
            sender: 'user_stripe_test',
            recipient: 'user_merchant_e2e',
            purpose: 'PAYMENT_DEMO_REAL'
        }, { headers: { 'x-idempotency-key': `${idempotencyPrefix}_init` } });

        if (initRes.status !== 200) throw new Error(`Init Failed: ${initRes.status}`);
        const { instructionId } = initRes.data;

        // 2. POLICY
        const polRes = await client.post(`${API_URL}/policy/evaluate`, { instructionId }, {
            headers: { 'x-idempotency-key': `${idempotencyPrefix}_pol` }
        });
        if (polRes.status !== 200) throw new Error(`Policy Failed: ${polRes.status}`);

        // 3. ROUTE
        const routeRes = await client.post(`${API_URL}/orchestration/route`, { instructionId }, {
            headers: { 'x-idempotency-key': `${idempotencyPrefix}_route` }
        });
        if (routeRes.status !== 200) throw new Error(`Route Failed: ${routeRes.status}`);
        const { selectedAdapter } = routeRes.data;

        // 4. EXECUTE
        const execRes = await client.post(`${API_URL}/adapter/execute`, { instructionId, adapter: selectedAdapter }, {
            headers: { 'x-idempotency-key': `${idempotencyPrefix}_exec` }
        });

        if (execRes.status !== 200) throw new Error(`Exec Failed: ${execRes.status} - ${JSON.stringify(execRes.data)}`);

        const duration = Date.now() - start;
        console.log(`✅ [#${index}] Success (${duration}ms) - Intent: ${execRes.data.adapter_result.intent_id}`);
        return true;
    } catch (err) {
        console.error(`❌ [#${index}] Error: ${err.message}`);
        return false;
    }
}

async function runBatch() {
    console.log(`🚀 STARTING STRESS TEST: ${TOTAL_TXNS} Real Transactions (Concurrency: ${CONCURRENCY_LIMIT})`);
    const startTime = Date.now();

    let activePromises = [];
    let completed = 0;
    let successCount = 0;

    for (let i = 0; i < TOTAL_TXNS; i++) {
        // Create promise
        const p = runSingleTransaction(i).then(result => {
            completed++;
            if (result) successCount++;
            // Remove self from active list
            activePromises.splice(activePromises.indexOf(p), 1);
        });

        activePromises.push(p);

        // If limit reached, wait for ONE to finish before adding next
        if (activePromises.length >= CONCURRENCY_LIMIT) {
            await Promise.race(activePromises);
        }
    }

    // Wait for remaining
    await Promise.all(activePromises);

    const totalTime = (Date.now() - startTime) / 1000;
    const tps = (completed / totalTime).toFixed(2);

    console.log(`\n------------------------------------------------`);
    console.log(`✅ TEST COMPLETE`);
    console.log(`   Count: ${completed}/${TOTAL_TXNS}`);
    console.log(`   Success: ${successCount}`);
    console.log(`   Time: ${totalTime.toFixed(2)}s`);
    console.log(`   Avg TPS: ${tps}`);
    console.log(`------------------------------------------------`);

    // Log to JSON for parsing if needed
    const fs = require('fs');
    fs.writeFileSync('stress_test_result.json', JSON.stringify({
        total: TOTAL_TXNS,
        success: successCount,
        time_seconds: totalTime,
        tps: tps
    }, null, 2));
}

runBatch();
