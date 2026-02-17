// FINAL BATCH EXECUTION

require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.API_SECRET_KEY;
const PORT = process.env.PORT || 3000;

// mTLS Agent setup
const httpsAgent = new https.Agent({
    key: fs.readFileSync(path.join(__dirname, 'certs', 'client.key')),
    cert: fs.readFileSync(path.join(__dirname, 'certs', 'client.crt')),
    ca: fs.readFileSync(path.join(__dirname, 'certs', 'ca.crt')),
    rejectUnauthorized: true,
});

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

async function runFullFlow(amount, currency, sender, recipient, adapter) {
    console.log(`\n➡️  NEW TRANSACTION: ${amount} ${currency} | ${sender} -> ${recipient}`);

    try {
        // 1. Initiate
        const init = await makeRequest('/api/instruction/initiate', 'POST', {
            amount,
            currency,
            sender,
            recipient,
            purpose: 'FINAL_BATCH_VERIFICATION',
        });
        if (init.status !== 200 && init.status !== 201)
            throw new Error(`Initiate failed: ${JSON.stringify(init.data)}`);
        const instructionId = init.data.instructionId;
        console.log(`   [1] ID: ${instructionId}`);

        // 2. Policy
        const policy = await makeRequest('/api/policy/evaluate', 'POST', { instructionId });
        if (policy.status !== 200) throw new Error(`Policy failed: ${JSON.stringify(policy.data)}`);
        console.log('   [2] Policy: APPROVED');

        // 3. Route
        const route = await makeRequest('/api/orchestration/route', 'POST', { instructionId });
        if (route.status !== 200) throw new Error(`Route failed: ${JSON.stringify(route.data)}`);
        console.log(`   [3] Routed: ${route.data.selectedAdapter}`);

        // 4. Execute
        const exec = await makeRequest('/api/adapter/execute', 'POST', { instructionId, adapter });
        if (exec.status !== 200) throw new Error(`Execute failed: ${JSON.stringify(exec.data)}`);

        if (!exec.data || !exec.data.adapter_result) {
            console.error('DEBUG: Invalid response structure:', JSON.stringify(exec.data));
            throw new Error('Invalid response structure');
        }

        const txId =
            exec.data.adapter_result.blockchain_hash || exec.data.adapter_result.stripe_intent;

        if (!txId) {
            console.error('DEBUG: Transaction failed or missing hash:', JSON.stringify(exec.data));
            throw new Error(
                `Transaction failed: ${exec.data.adapter_result.error || 'Unknown error'}`
            );
        }

        console.log(`   [4] Settled! Ref: ${txId.substring(0, 16)}...`);
        return true;
    } catch (err) {
        console.error(`   ❌ FAIL: ${err.message}`);
        return false;
    }
}

async function startBatch() {
    console.log('\n🚀 STARTING FINAL BATCH EXECUTION (10 TRANSACTIONS)');
    console.log('==================================================');

    let successCount = 0;

    // 5 STRIPE TRANSACTIONS (USD)
    console.log('\n💵 RAIL: STRIPE (USD)');
    for (let i = 1; i <= 5; i++) {
        const amount = parseFloat((10 + i).toFixed(2));
        const success = await runFullFlow(
            amount,
            'USD',
            `User_Fiat_${i}`,
            `Merchant_${i}`,
            'ADAPTER_PAYNOW'
        );
        if (success) successCount++;
    }

    // 5 STELLAR TRANSACTIONS (XLM)
    console.log('\n🌌 RAIL: STELLAR (XLM)');
    for (let i = 1; i <= 5; i++) {
        const success = await runFullFlow(
            1.0,
            'XLM',
            `Batch_Crypto_Sender_${i}`,
            `Recipient_Node_${i}`,
            'ADAPTER_CRYPTO_CUSTODIAN'
        );
        if (success) successCount++;
    }

    console.log('\n==================================================');
    console.log(`📊 BATCH SUMMARY: ${successCount}/10 Successful`);
    console.log('==================================================\n');
}

startBatch().catch(console.error);
