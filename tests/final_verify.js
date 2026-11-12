const axios = require('axios');

const API_BASE = 'http://localhost:3000/api';
const API_KEY = 'fusion_bank_secret_key_2025';
const AUTH_TOKEN = 'afat_test-final-verify-99';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTest(label, currency, recipient, amount, adapter) {
    console.log(`\n--- [TEST] ${label} (${currency}) ---`);
    const idKey = `${label.toLowerCase()}-${Date.now()}`;

    try {
        console.log(' 1. INITIATING...');
        const init = await axios.post(
            `${API_BASE}/instruction/initiate`,
            {
                sender: 'GENERIC_USER_099',
                recipient,
                amount,
                currency,
                purpose: 'FINAL_VERIFY',
                auth_token: AUTH_TOKEN,
            },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-init` } }
        );
        const id = init.data.instructionId;
        console.log('    [OK] ID:', id);

        await sleep(1000);
        console.log(' 2. APPROVING...');
        await axios.post(
            `${API_BASE}/instruction/approve`,
            { instructionIds: [id], approved_by: 'AUDITOR' },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-appr` } }
        );

        await sleep(1000);
        console.log(' 3. EVALUATING...');
        const poly = await axios.post(
            `${API_BASE}/policy/evaluate`,
            { instructionId: id },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-poly` } }
        );
        if (poly.data.state !== 'LOCKED')
            throw new Error(`Policy Rejected: ${poly.data.policy_permit.rationale}`);
        console.log('    [OK] LOCKED');

        await sleep(1000);
        console.log(' 4. ROUTING...');
        const rout = await axios.post(
            `${API_BASE}/orchestration/route`,
            { instructionId: id },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-rout` } }
        );
        console.log('    [OK] ROUTED TO:', rout.data.selectedAdapter);

        await sleep(1000);
        console.log(` 5. EXECUTING (${adapter})...`);
        const exec = await axios.post(
            `${API_BASE}/adapter/execute`,
            { instructionId: id, adapter },
            { headers: { 'x-api-key': API_KEY, 'x-idempotency-key': `${idKey}-exec` } }
        );

        const resData = exec.data;
        const adapterRes = resData.adapter_result || {};

        if (adapter === 'ADAPTER_CRYPTO_CUSTODIAN') {
            const hash = adapterRes.blockchain_hash || adapterRes.intent_id;
            console.log('    [SUCCESS] Stellar Hash:', hash);
            if (hash)
                console.log(
                    '    [SUCCESS] Explorer:',
                    `https://stellar.expert/explorer/testnet/tx/${hash}`
                );
        } else {
            const intentId = adapterRes.intent_id || adapterRes.id;
            console.log(`    [SUCCESS] ${label} ID:`, intentId);
        }

        console.log('    [DETAILS] Full State:', resData.state);
    } catch (err) {
        console.log(
            '    [FAILED] Error:',
            err.response ? JSON.stringify(err.response.data) : err.message
        );
    }
}

async function verifyAll() {
    console.log('[VERIFICATION] Starting Real-Rail Triple Probe...');
    await runTest('STRIPE', 'USD', 'STRIPE_VENDOR_099', 5.0, 'ADAPTER_STRIPE');
    await sleep(2000);
    await runTest('RAZORPAY', 'INR', 'RAZOR_VENDOR_099', 100.0, 'ADAPTER_RAZORPAY');
    await sleep(2000);
    await runTest('STELLAR', 'XLM', 'STELLAR_REC_099', 1.0, 'ADAPTER_CRYPTO_CUSTODIAN');
    console.log('\n[VERIFICATION] Complete.');
}

verifyAll();
