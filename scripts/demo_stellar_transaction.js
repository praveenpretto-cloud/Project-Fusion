/**
 * Single Stellar Transaction Test
 * Demonstrates complete institutional flow with vault-signed keys
 */

require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.API_SECRET_KEY;
const PORT = process.env.PORT || 3000;

// mTLS Agent
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
                'x-idempotency-key': `stellar_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            },
            agent: httpsAgent,
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        });

        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function executeStellarTransaction() {
    console.log('\n🌌 STELLAR BLOCKCHAIN TRANSACTION TEST');
    console.log('==========================================\n');

    try {
        // Step 1: Initiate
        console.log('Step 1: Initiating instruction...');
        const initResult = await makeRequest('/api/instruction/initiate', 'POST', {
            amount: 5.0, // Under AML threshold
            currency: 'XLM',
            sender: 'Demo_Sender_XLM',
            recipient: 'Demo_Recipient_XLM',
            purpose: 'STELLAR_DEMO_TRANSACTION',
        });

        const instructionId = initResult.data.instructionId;
        console.log(`✅ Instruction ID: ${instructionId}`);
        console.log(`   State: ${initResult.data.state}\n`);

        // Step 2: Policy Evaluation
        console.log('Step 2: Evaluating policy & locking balance...');
        const policyResponse = await makeRequest('/api/policy/evaluate', 'POST', { instructionId });
        const permit = policyResponse.data.policy_permit;
        const isApproved = permit && permit.decision === 'APPROVED';

        console.log(`✅ Policy: ${isApproved ? 'APPROVED ✓' : 'REJECTED ✗'}`);

        if (!isApproved) {
            console.log(`   Reason: ${permit?.rationale || JSON.stringify(policyResponse.data)}`);
            console.log('\n❌ Transaction cannot proceed - policy rejection\n');
            return;
        }

        console.log(`   Permit ID: ${permit.permit_id}`);
        console.log(`   Signature: ${permit.prototype_signature?.substring(0, 16)}...\n`);

        // Step 3: Routing
        console.log('Step 3: Routing to crypto adapter...');
        const routeResult = await makeRequest('/api/orchestration/route', 'POST', {
            instructionId,
        });
        console.log(`✅ Adapter: ${routeResult.data.selectedAdapter}`);
        console.log(`   State: ${routeResult.data.state}\n`);

        // Step 4: Execute
        console.log('Step 4: Executing on Stellar Testnet...');
        console.log('   (Using HMAC-SHA256 vault-signed keys)');
        const execResult = await makeRequest('/api/adapter/execute', 'POST', {
            instructionId,
            adapter: 'ADAPTER_CRYPTO_CUSTODIAN',
        });

        if (execResult.data.adapter_result && execResult.data.adapter_result.blockchain_hash) {
            const result = execResult.data.adapter_result;
            console.log('\n🎉 SUCCESS! Transaction confirmed on blockchain\n');
            console.log('==========================================');
            console.log('TRANSACTION DETAILS:');
            console.log('==========================================');
            console.log(`Blockchain Hash: ${result.blockchain_hash}`);
            console.log(`Ledger Sequence: ${result.ledger}`);
            console.log(`Network: Stellar Testnet`);
            console.log(`Amount: 5.00 XLM`);
            console.log(`Sender: Demo_Sender_XLM`);
            console.log(`Recipient: Demo_Recipient_XLM`);
            console.log(`Key Security: Vault HMAC-SHA256 (32-byte entropy)`);
            console.log('==========================================');
            console.log('\n✅ Verify on StellarExpert:');
            console.log(`https://stellar.expert/explorer/testnet/tx/${result.blockchain_hash}`);
            console.log('\n');
        } else {
            console.log('\n❌ Transaction failed');
            console.log(JSON.stringify(execResult.data, null, 2));
        }
    } catch (err) {
        console.error('\n❌ Error:', err.message);
    }
}

executeStellarTransaction();
