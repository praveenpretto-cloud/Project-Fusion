const axios = require('axios');
const https = require('https');

const API_URL = 'https://localhost:3000/api';
const API_KEY = 'fusion_bank_secret_key_2025';

// Ignore self-signed certs
const agent = new https.Agent({ rejectUnauthorized: false });
const client = axios.create({ httpsAgent: agent, headers: { 'x-api-key': API_KEY } });

async function runStripeFlow() {
    try {
        console.log('1. INITIATING...');
        const initRes = await client.post(
            `${API_URL}/instruction/initiate`,
            {
                amount: 50.0,
                currency: 'USD',
                sender: 'user_e2e_check',
                recipient: 'user_merchant_e2e',
                purpose: 'STRIPE_SCALE_TEST',
            },
            {
                headers: { 'x-idempotency-key': `manual_${Date.now()}` },
            }
        );
        console.log('   ✅ Initiated:', initRes.data);
        const { instructionId } = initRes.data;

        console.log('2. EVALUATING POLICY...');
        const polRes = await client.post(`${API_URL}/policy/evaluate`, { instructionId });
        console.log('   ✅ Policy:', polRes.data);

        console.log('3. ROUTING...');
        const routeRes = await client.post(`${API_URL}/orchestration/route`, { instructionId });
        console.log('   ✅ Route:', routeRes.data);
        const { selectedAdapter } = routeRes.data;

        if (selectedAdapter !== 'ADAPTER_STRIPE') {
            console.error('   ❌ WRONG ADAPTER:', selectedAdapter);
            process.exit(1);
        }

        console.log('4. EXECUTING ADAPTER...');
        const execRes = await client.post(`${API_URL}/adapter/execute`, {
            instructionId,
            adapter: selectedAdapter,
        });
        console.log('   ✅ Execute:', execRes.data);

        console.log('\nSUCCESS: Full Stripe Flow Verified.');
    } catch (err) {
        console.error('❌ FAILURE:', err.response ? err.response.data : err.message);
        process.exit(1);
    }
}

runStripeFlow();
