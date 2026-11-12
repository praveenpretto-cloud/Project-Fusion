const axios = require('axios');

const API_BASE = 'http://localhost:3000/api';
const API_KEY = 'fusion_bank_secret_key_2025';
const AUTH_TOKEN = 'afat_test-testnet-verification-99';

async function verifyAll() {
    console.log('[VERIFICATION] Starting Real-World Testnet Probe (Stripe, Razorpay, Stellar)...');

    // 1. STRIPE (USD)
    try {
        console.log('\n--- STRIPE (USD) ---');
        const idKey = `stripe-probe-${Date.now()}`;
        const init = await axios.post(
            `${API_BASE}/instruction/initiate`,
            {
                sender: 'GENERIC_USER_099',
                recipient: 'STRIPE_VENDOR_001',
                amount: 5.0,
                currency: 'USD',
                purpose: 'STRIPE_TESTNET_VERIFY',
                auth_token: AUTH_TOKEN,
            },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-init` } }
        );
        const id = init.data.instructionId;
        await axios.post(
            `${API_BASE}/instruction/approve`,
            { instructionIds: [id], approved_by: 'PROBE' },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-appr` } }
        );
        await axios.post(
            `${API_BASE}/policy/evaluate`,
            { instructionId: id },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-poly` } }
        );
        await axios.post(
            `${API_BASE}/orchestration/route`,
            { instructionId: id },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-rout` } }
        );
        const exec = await axios.post(
            `${API_BASE}/adapter/execute`,
            { instructionId: id, adapter: 'ADAPTER_STRIPE' },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-exec` } }
        );
        console.log('[SUCCESS] Stripe Intent ID:', exec.data.intent_id);
    } catch (err) {
        console.log('[FAILED] Stripe:', err.response ? err.response.data : err.message);
    }

    // 2. RAZORPAY (INR)
    try {
        console.log('\n--- RAZORPAY (INR) ---');
        const idKey = `razor-probe-${Date.now()}`;
        const init = await axios.post(
            `${API_BASE}/instruction/initiate`,
            {
                sender: 'GENERIC_USER_099',
                recipient: 'RAZOR_VENDOR_001',
                amount: 100.0,
                currency: 'INR',
                purpose: 'RAZORPAY_TESTNET_VERIFY',
                auth_token: AUTH_TOKEN,
            },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-init` } }
        );
        const id = init.data.instructionId;
        await axios.post(
            `${API_BASE}/instruction/approve`,
            { instructionIds: [id], approved_by: 'PROBE' },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-appr` } }
        );
        await axios.post(
            `${API_BASE}/policy/evaluate`,
            { instructionId: id },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-poly` } }
        );
        await axios.post(
            `${API_BASE}/orchestration/route`,
            { instructionId: id },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-rout` } }
        );
        const exec = await axios.post(
            `${API_BASE}/adapter/execute`,
            { instructionId: id, adapter: 'ADAPTER_RAZORPAY' },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-exec` } }
        );
        console.log('[SUCCESS] Razorpay Payout ID:', exec.data.intent_id);
    } catch (err) {
        console.log('[FAILED] Razorpay:', err.response ? err.response.data : err.message);
    }

    // 3. STELLAR (XLM)
    try {
        console.log('\n--- STELLAR (XLM) ---');
        const idKey = `stellar-probe-${Date.now()}`;
        const init = await axios.post(
            `${API_BASE}/instruction/initiate`,
            {
                sender: 'GENERIC_USER_099',
                recipient: 'STELLAR_ENTITY_001',
                amount: 2.0,
                currency: 'XLM',
                purpose: 'STELLAR_TESTNET_VERIFY',
                auth_token: AUTH_TOKEN,
            },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-init` } }
        );
        const id = init.data.instructionId;
        await axios.post(
            `${API_BASE}/instruction/approve`,
            { instructionIds: [id], approved_by: 'PROBE' },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-appr` } }
        );
        await axios.post(
            `${API_BASE}/policy/evaluate`,
            { instructionId: id },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-poly` } }
        );
        await axios.post(
            `${API_BASE}/orchestration/route`,
            { instructionId: id },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-rout` } }
        );
        const exec = await axios.post(
            `${API_BASE}/adapter/execute`,
            { instructionId: id, adapter: 'ADAPTER_CRYPTO_CUSTODIAN' },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-exec` } }
        );
        console.log('[SUCCESS] Stellar Tx Hash:', exec.data.blockchain_hash);
    } catch (err) {
        console.log('[FAILED] Stellar:', err.response ? err.response.data : err.message);
    }
}

verifyAll();
