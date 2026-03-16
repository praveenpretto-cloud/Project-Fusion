const axios = require('axios');
const https = require('https');

const API_URL = 'https://localhost:3000/api';
const API_KEY = 'fusion_bank_secret_key_2025';
const SAMPLE_SIZE = 50;

const agent = new https.Agent({ rejectUnauthorized: false });
const client = axios.create({
    httpsAgent: agent,
    headers: { 'x-api-key': API_KEY },
    validateStatus: () => true,
});

async function runSingleTransaction(index) {
    const amount = (Math.random() * (50 - 10) + 10).toFixed(2);
    const idempotencyPrefix = `batch_${Date.now()}_${index}`;

    console.log(`\n[${index + 1}/${SAMPLE_SIZE}] 💸 Initiating $${amount}...`);

    try {
        // 1. INITIATE
        const initRes = await client.post(
            `${API_URL}/instruction/initiate`,
            {
                amount: parseFloat(amount),
                currency: 'USD',
                sender: 'user_stripe_test',
                recipient: 'user_merchant_e2e',
                purpose: 'PAYMENT_DEMO_REAL',
            },
            { headers: { 'x-idempotency-key': `${idempotencyPrefix}_init` } }
        );

        if (initRes.status !== 200) {
            console.error(`   ❌ INIT FAILED: ${JSON.stringify(initRes.data)}`);
            return false;
        }
        const { instructionId } = initRes.data;

        // 2. POLICY
        const polRes = await client.post(
            `${API_URL}/policy/evaluate`,
            { instructionId },
            {
                headers: { 'x-idempotency-key': `${idempotencyPrefix}_pol` },
            }
        );
        if (polRes.status !== 200) return false;

        // 3. ROUTE
        const routeRes = await client.post(
            `${API_URL}/orchestration/route`,
            { instructionId },
            {
                headers: { 'x-idempotency-key': `${idempotencyPrefix}_route` },
            }
        );
        if (routeRes.status !== 200) return false;

        const { selectedAdapter } = routeRes.data;

        // 4. EXECUTE
        const execRes = await client.post(
            `${API_URL}/adapter/execute`,
            { instructionId, adapter: selectedAdapter },
            {
                headers: { 'x-idempotency-key': `${idempotencyPrefix}_exec` },
            }
        );

        if (execRes.status === 200) {
            console.log(
                `   ✅ SUCCESS: ${instructionId} | Intent: ${execRes.data.adapter_result.intent_id}`
            );
            return true;
        } else {
            console.error(`   ❌ EXEC FAILED: ${JSON.stringify(execRes.data)}`);
            return false;
        }
    } catch (err) {
        console.error(`   ❌ ERROR: ${err.message}`);
        return false;
    }
}

async function runBatch() {
    console.log(`🚀 STARTING BATCH OF ${SAMPLE_SIZE} REAL TRANSACTIONS ($10 - $50)`);
    let successCount = 0;

    for (let i = 0; i < SAMPLE_SIZE; i++) {
        const success = await runSingleTransaction(i);
        if (success) successCount++;
        // Small delay to prevent local port exhaustion or overwhelming the mock server
        await new Promise((r) => setTimeout(r, 200));
    }

    console.log(`\n------------------------------------------------`);
    console.log(`✅ BATCH COMPLETE: ${successCount}/${SAMPLE_SIZE} Successful`);
    console.log(`------------------------------------------------`);
}

runBatch();
