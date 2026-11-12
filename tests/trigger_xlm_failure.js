
const axios = require('axios');
const API_BASE = 'http://localhost:3000/api';
const API_KEY = 'fusion_bank_secret_key_2025';

async function trigger() {
    console.log('[PROBE] Triggering XLM Batch with Idempotency...');
    const idKey = 'xlm-fail-' + Date.now();
    const config = (key) => ({ headers: { 'x-api-key': API_KEY, 'x-idempotency-key': idKey + '-' + key } });
    
    try {
        console.log('1. Initiating...');
        const init = await axios.post(`${API_BASE}/instruction/initiate`, {
            sender: 'GENERIC_USER_099',
            recipient: 'STELLAR_REC_FAIL_TEST',
            amount: 1.00,
            currency: 'XLM',
            purpose: 'DEBUG_FAILURE_VISIBILITY',
            auth_token: 'afat_test-final-verify-99'
        }, config('init'));
        
        const id = init.data.instructionId;
        console.log('ID:', id);

        console.log('2. Approving...');
        await axios.post(`${API_BASE}/instruction/approve`, { instructionIds: [id], approved_by: 'AUDITOR' }, config('appr'));
        
        console.log('3. Evaluating...');
        await axios.post(`${API_BASE}/policy/evaluate`, { instructionId: id }, config('poly'));
        
        console.log('4. Routing...');
        await axios.post(`${API_BASE}/orchestration/route`, { instructionId: id }, config('rout'));
        
        console.log('5. Executing Adapter...');
        const exec = await axios.post(`${API_BASE}/adapter/execute`, { instructionId: id, adapter: 'ADAPTER_CRYPTO_CUSTODIAN' }, config('exec'));
        
        console.log('RESULT:', exec.data.state);
        console.log('ERROR:', exec.data.adapter_result ? exec.data.adapter_result.error : 'No Adapter Error');
        
    } catch (err) {
        console.log('PROBE FAILED:', err.response ? JSON.stringify(err.response.data) : err.message);
    }
}
trigger();
