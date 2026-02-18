const axios = require('axios');
const https = require('https');

const API_URL = 'https://localhost:3000/api';
const API_KEY = 'fusion_bank_secret_key_2025';

const agent = new https.Agent({ rejectUnauthorized: false });
const client = axios.create({
    httpsAgent: agent,
    headers: { 'x-api-key': API_KEY },
    validateStatus: () => true
});

async function runRealStripeTransaction() {
    console.log('🚀 EXECUTING REAL STRIPE TRANSACTION');
    console.log('   (This will appear in your Stripe Dashboard)');
    try {
        // 1. INITIATE
        console.log('\n1. INITIATING...');
        const initRes = await client.post(`${API_URL}/instruction/initiate`, {
            amount: 12.50, // Specific amount to easily find
            currency: 'USD',
            sender: 'user_stripe_test',
            recipient: 'user_merchant_e2e',
            purpose: 'PAYMENT_DEMO_REAL' // 👈 This triggers the REAL Stripe Adapter
        }, {
            headers: { 'x-idempotency-key': `real_${Date.now()}_init` }
        });

        if (initRes.status !== 200) {
            console.error('❌ INITIATE FAILED:', initRes.data);
            process.exit(1);
        }
        const { instructionId } = initRes.data;
        console.log(`   ✅ instructionId: ${instructionId}`);

        // 2. POLICY
        console.log('\n2. EVALUATING POLICY...');
        const polRes = await client.post(`${API_URL}/policy/evaluate`, { instructionId }, {
            headers: { 'x-idempotency-key': `real_${Date.now()}_pol` }
        });
        if (polRes.status !== 200) {
            console.error('❌ POLICY FAILED:', polRes.data);
            process.exit(1);
        }

        // 3. ROUTE
        console.log('\n3. ROUTING...');
        const routeRes = await client.post(`${API_URL}/orchestration/route`, { instructionId }, {
            headers: { 'x-idempotency-key': `real_${Date.now()}_route` }
        });
        if (routeRes.status !== 200) {
            console.error('❌ ROUTE FAILED:', routeRes.data);
            process.exit(1);
        }

        const { selectedAdapter } = routeRes.data;
        if (selectedAdapter !== 'ADAPTER_STRIPE') {
            console.error(`❌ WRONG ADAPTER SELECTED: ${selectedAdapter}`);
            process.exit(1);
        }
        console.log(`   ✅ Adapter Selected: ${selectedAdapter}`);

        // 4. EXECUTE
        console.log('\n4. EXECUTING REAL ADAPTER...');
        const execRes = await client.post(`${API_URL}/adapter/execute`, { instructionId, adapter: selectedAdapter }, {
            headers: { 'x-idempotency-key': `real_${Date.now()}_exec` }
        });

        if (execRes.status !== 200) {
            console.error('❌ EXECUTE FAILED:', execRes.data);
            process.exit(1);
        }

        const fs = require('fs');
        fs.writeFileSync('stripe_result.json', JSON.stringify(execRes.data, null, 2));

        console.log('\n✅ SUCCESS: Real Transaction Completed!');
        console.log('------------------------------------------------');
        console.log('🔍 STRIPE INTENT ID:', execRes.data.adapter_result.intent_id);
        console.log('   Check your Stripe Dashboard for this ID.');
        console.log('------------------------------------------------');

    } catch (err) {
        console.error('❌ EXCEPTION:', err.message);
        if (err.response) console.error('   RESPONSE:', err.response.data);
    }
}

runRealStripeTransaction();
