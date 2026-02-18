const axios = require('axios');
const https = require('https');

const API_URL = 'https://localhost:3000/api';
const API_KEY = 'fusion_bank_secret_key_2025';

const agent = new https.Agent({ rejectUnauthorized: false });
const client = axios.create({
    httpsAgent: agent,
    headers: { 'x-api-key': API_KEY },
    validateStatus: () => true // Don't throw on error status
});

async function runStripeFlow() {
    console.log('🚀 STARTING STRIPE FLOW DEBUG');
    try {
        // 1. INITIATE
        console.log('\n1. INITIATING...');
        const initRes = await client.post(`${API_URL}/instruction/initiate`, {
            amount: 50.00,
            currency: 'USD',
            sender: 'user_e2e_check',
            recipient: 'user_merchant_e2e',
            purpose: 'STRIPE_SCALE_TEST'
        }, {
            headers: { 'x-idempotency-key': `manual_${Date.now()}` }
        });

        console.log(`   STATUS: ${initRes.status}`);
        console.log('   DATA:', JSON.stringify(initRes.data, null, 2));

        if (initRes.status !== 200) {
            console.error('❌ INITIATE FAILED');
            process.exit(1);
        }

        const { instructionId } = initRes.data;
        if (!instructionId) {
            console.error('❌ NO INSTRUCTION ID');
            process.exit(1);
        }
        console.log(`   ✅ instructionId: ${instructionId}`);

        // 2. POLICY
        console.log('\n2. EVALUATING POLICY...');
        const polRes = await client.post(`${API_URL}/policy/evaluate`, { instructionId }, {
            headers: { 'x-idempotency-key': `manual_pol_${Date.now()}` }
        });
        console.log(`   STATUS: ${polRes.status}`);
        console.log('   DATA:', JSON.stringify(polRes.data, null, 2));

        if (polRes.status !== 200) {
            console.error('❌ POLICY FAILED');
            process.exit(1);
        }

        // 3. ROUTE
        console.log('\n3. ROUTING...');
        const routeRes = await client.post(`${API_URL}/orchestration/route`, { instructionId }, {
            headers: { 'x-idempotency-key': `manual_route_${Date.now()}` }
        });
        console.log(`   STATUS: ${routeRes.status}`);
        console.log('   DATA:', JSON.stringify(routeRes.data, null, 2));

        if (routeRes.status !== 200) {
            console.error('❌ ROUTE FAILED');
            process.exit(1);
        }

        const { selectedAdapter } = routeRes.data;
        if (selectedAdapter !== 'ADAPTER_STRIPE') {
            console.error(`❌ WRONG ADAPTER: ${selectedAdapter}`);
            process.exit(1);
        }

        // 4. EXECUTE
        console.log('\n4. EXECUTING ADAPTER...');
        const execRes = await client.post(`${API_URL}/adapter/execute`, { instructionId, adapter: selectedAdapter }, {
            headers: { 'x-idempotency-key': `manual_exec_${Date.now()}` }
        });
        console.log(`   STATUS: ${execRes.status}`);
        console.log('   DATA:', JSON.stringify(execRes.data, null, 2));

        if (execRes.status !== 200) {
            console.error('❌ EXECUTE FAILED');
            process.exit(1);
        }

        console.log('\n✅ SUCCESS: Full Stripe Flow Verified.');
    } catch (err) {
        console.error('❌ EXCEPTION:', err.message);
        if (err.response) console.error('   RESPONSE:', err.response.data);
    }
}

runStripeFlow();
