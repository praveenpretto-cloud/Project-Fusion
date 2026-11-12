const axios = require('axios');
const API_BASE = 'http://localhost:3000/api';
const API_KEY = 'fusion_bank_secret_key_2025';

async function triggerBatch() {
    console.log('[PROBE] Triggering Multi-XLM Batch (3x Serialization Test)...');
    const idKey = 'xlm-batch-' + Date.now();

    try {
        // 1. Initiate 3 transactions in one bulk payload
        const payload = [
            {
                sender: 'GENERIC_USER_099',
                recipient: 'STELLAR_REC_A',
                amount: 1.0,
                currency: 'XLM',
                purpose: 'BATCH_TEST_A',
                auth_token: 'afat_test_001',
            },
            {
                sender: 'GENERIC_USER_099',
                recipient: 'STELLAR_REC_B',
                amount: 1.0,
                currency: 'XLM',
                purpose: 'BATCH_TEST_B',
                auth_token: 'afat_test_001',
            },
            {
                sender: 'GENERIC_USER_099',
                recipient: 'STELLAR_REC_C',
                amount: 1.0,
                currency: 'XLM',
                purpose: 'BATCH_TEST_C',
                auth_token: 'afat_test_001',
            },
        ];

        console.log('1. Initiating Bulk...');
        const init = await axios.post(`${API_BASE}/instruction/initiate`, payload, {
            headers: { 'x-api-key': API_KEY, 'x-idempotency-key': idKey + '-init' },
        });

        const ids = init.data.instructionIds;
        console.log('IDs:', ids);

        // 2. Approve ALL
        console.log('2. Approving Batch...');
        await axios.post(
            `${API_BASE}/instruction/approve`,
            { instructionIds: ids, approved_by: 'AUDITOR' },
            {
                headers: { 'x-api-key': API_KEY, 'x-idempotency-key': idKey + '-appr' },
            }
        );

        // 3. Evaluate Policies (Batch)
        console.log('3. Policy Sweep...');
        for (let id of ids) {
            await axios.post(
                `${API_BASE}/policy/evaluate`,
                { instructionId: id },
                {
                    headers: { 'x-api-key': API_KEY, 'x-idempotency-key': id + '-poly' },
                }
            );
        }

        // 4. Run Routing (Batch)
        console.log('4. Routing Sweep...');
        for (let id of ids) {
            await axios.post(
                `${API_BASE}/orchestration/route`,
                { instructionId: id },
                {
                    headers: { 'x-api-key': API_KEY, 'x-idempotency-key': id + '-rout' },
                }
            );
        }

        // 5. Execute via Registry (The real test!)
        // In server.js, /api/adapter/execute handles individual instructions,
        // but the batchProcessor uses AdapterRegistry.executeBatchConcurrently.
        // I will trigger a mock batch execution by calling the adapter execute for each ID (which is sequential in this script).

        console.log('5. Executing Sequential Trial...');
        for (let id of ids) {
            console.log(`Executing ${id}...`);
            const exec = await axios.post(
                `${API_BASE}/adapter/execute`,
                { instructionId: id, adapter: 'ADAPTER_CRYPTO_CUSTODIAN' },
                {
                    headers: { 'x-api-key': API_KEY, 'x-idempotency-key': id + '-exec' },
                }
            );
            console.log(`ID ${id} -> ${exec.data.state} ${exec.data.adapter_result?.error || ''}`);
        }
    } catch (err) {
        console.log(
            'PROBE FAILED:',
            err.response ? JSON.stringify(err.response.data) : err.message
        );
    }
}
triggerBatch();
