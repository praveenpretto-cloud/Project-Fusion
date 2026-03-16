const axios = require('axios');
const https = require('https');

const API_URL = 'https://localhost:3000/api';
const API_KEY = 'fusion_bank_secret_key_2025';
const SAMPLE_SIZE = 10;

const agent = new https.Agent({ rejectUnauthorized: false });
const client = axios.create({
    httpsAgent: agent,
    headers: { 'x-api-key': API_KEY },
    validateStatus: () => true,
});

async function runSingleTransaction(index) {
    // Random small amount between 1 and 10 XLM
    const amount = (Math.random() * (10 - 1) + 1).toFixed(2);
    const idempotencyPrefix = `stellar_batch_${Date.now()}_${index}`;

    console.log(`\n[${index + 1}/${SAMPLE_SIZE}] 🚀 Initiating ${amount} XLM...`);

    try {
        // 1. INITIATE
        const initRes = await client.post(
            `${API_URL}/instruction/initiate`,
            {
                amount: parseFloat(amount),
                currency: 'XLM',
                sender: 'Stellar_Test_Sender', // Consistent sender for funding stability
                recipient: 'Stellar_Test_Recipient',
                purpose: 'PAYMENT_DEMO_STELLAR',
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
        if (polRes.status !== 200) {
            console.error(`   ❌ POLICY FAILED: ${JSON.stringify(polRes.data)}`);
            return false;
        }

        // 3. ROUTE
        const routeRes = await client.post(
            `${API_URL}/orchestration/route`,
            { instructionId },
            {
                headers: { 'x-idempotency-key': `${idempotencyPrefix}_route` },
            }
        );
        if (routeRes.status !== 200) {
            console.error(`   ❌ ROUTE FAILED: ${JSON.stringify(routeRes.data)}`);
            return false;
        }

        const { selectedAdapter } = routeRes.data;
        if (selectedAdapter !== 'ADAPTER_CRYPTO_CUSTODIAN') {
            console.warn(`   ⚠️  Unexpected Adapter: ${selectedAdapter}`);
        }

        // 4. EXECUTE
        const execRes = await client.post(
            `${API_URL}/adapter/execute`,
            { instructionId, adapter: selectedAdapter },
            {
                headers: { 'x-idempotency-key': `${idempotencyPrefix}_exec` },
            }
        );

        if (execRes.status === 200) {
            const result = execRes.data.adapter_result || {};
            console.log(`   ✅ SUCCESS: ${instructionId}`);
            console.log(`      Hash: ${result.intent_id}`);
            console.log(`      Explorer: ${result.explorer_url || 'N/A'}`);
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
    console.log(`🌌 STARTING STELLAR TESTNET BATCH (${SAMPLE_SIZE} TXNs)`);
    console.log(`   Note: First txn may be slow (Friendbot funding)`);

    let successCount = 0;

    for (let i = 0; i < SAMPLE_SIZE; i++) {
        const success = await runSingleTransaction(i);
        if (success) successCount++;
        // Stellar testnet can be slow, wait a bit
        await new Promise((r) => setTimeout(r, 1000));
    }

    console.log(`\n------------------------------------------------`);
    console.log(`✅ BATCH COMPLETE: ${successCount}/${SAMPLE_SIZE} Successful`);
    console.log(`------------------------------------------------`);
}

runBatch();
