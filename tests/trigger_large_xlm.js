const axios = require('axios');
const API_BASE = 'http://localhost:3000/api';
const API_KEY = 'fusion_bank_secret_key_2025';

async function triggerLarge() {
    console.log('[PROBE] Triggering Large XLM Transfer (15,000 XLM)...');
    const idKey = 'xlm-large-' + Date.now();
    const config = (key) => ({
        headers: { 'x-api-key': API_KEY, 'x-idempotency-key': idKey + '-' + key },
    });

    try {
        console.log('1. Initiating...');
        const init = await axios.post(
            `${API_BASE}/instruction/initiate`,
            {
                sender: 'GENERIC_USER_099',
                recipient: 'STELLAR_REC_LARGE',
                amount: 15000.0,
                currency: 'XLM',
                purpose: 'DEBUG_LARGE_REFILL',
                auth_token: 'afat_test_large',
            },
            config('init')
        );

        const id = init.data.instructionId;
        console.log('ID:', id);

        console.log('2. Approving...');
        await axios.post(
            `${API_BASE}/instruction/approve`,
            { instructionIds: [id], approved_by: 'AUDITOR' },
            config('appr')
        );

        console.log('3. Evaluating...');
        await axios.post(`${API_BASE}/policy/evaluate`, { instructionId: id }, config('poly'));

        console.log('4. Routing...');
        await axios.post(`${API_BASE}/orchestration/route`, { instructionId: id }, config('rout'));

        console.log('5. Executing Adapter (Expected to refill twice)...');
        const exec = await axios.post(
            `${API_BASE}/adapter/execute`,
            { instructionId: id, adapter: 'ADAPTER_CRYPTO_CUSTODIAN' },
            config('exec')
        );

        console.log('RESULT:', exec.data.state);
        if (exec.data.adapter_result) {
            console.log('ADAPTER RESULT:', exec.data.adapter_result.status);
            if (exec.data.adapter_result.error)
                console.log('ERROR:', exec.data.adapter_result.error);
        }
    } catch (err) {
        console.log(
            'PROBE FAILED:',
            err.response ? JSON.stringify(err.response.data) : err.message
        );
    }
}
triggerLarge();
