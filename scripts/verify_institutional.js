// INSTITUTIONAL GRADE VERIFICATION SCRIPT

require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_SECRET_KEY;

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
                'x-idempotency-key': `verify_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            },
            agent: httpsAgent,
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    const parsed = path.includes('/metrics') ? data : JSON.parse(data);
                    resolve({ status: res.statusCode, data: parsed });
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

async function runVerification() {
    console.log('\n========================================');
    console.log('INSTITUTIONAL GRADE VERIFICATION');
    console.log('========================================\n');

    let passed = 0;
    let failed = 0;

    // Test 1: Basic Health Endpoint
    console.log('📋 TEST 1: Basic Health Endpoint');
    try {
        const result = await makeRequest('/health');
        if (result.status === 200 && result.data.status === 'healthy') {
            console.log('✅ PASS: Health endpoint returns 200 and healthy status');
            passed++;
        } else {
            console.log('❌ FAIL: Unexpected health response');
            failed++;
        }
    } catch (err) {
        console.log('❌ FAIL:', err.message);
        failed++;
    }

    // Test 2: Detailed Health Check
    console.log('\n📋 TEST 2: Detailed Health Endpoint');
    try {
        const result = await makeRequest('/health/detailed');
        if (result.status === 200 && result.data.dependencies.database.status === 'up') {
            console.log('✅ PASS: Database health check passes');
            passed++;
        } else {
            console.log('❌ FAIL: Database health check failed');
            failed++;
        }
    } catch (err) {
        console.log('❌ FAIL:', err.message);
        failed++;
    }

    // Test 3: Metrics Endpoint
    console.log('\n📋 TEST 3: Prometheus Metrics Endpoint');
    try {
        const result = await makeRequest('/metrics');
        if (result.status === 200 && result.data.includes('fusion_requests_total')) {
            console.log('✅ PASS: Metrics endpoint returns Prometheus format');
            passed++;
        } else {
            console.log('❌ FAIL: Metrics format incorrect');
            failed++;
        }
    } catch (err) {
        console.log('❌ FAIL:', err.message);
        failed++;
    }

    // Test 4: End-to-End Stellar Transaction
    console.log('\n📋 TEST 4: Stellar Transaction (Vault-Signed with HMAC Keys)');
    try {
        // Initiate
        const initResult = await makeRequest('/api/instruction/initiate', 'POST', {
            amount: 5.0,
            currency: 'XLM',
            sender: 'Verification_Test_Sender',
            recipient: 'Verification_Test_Recipient',
            purpose: 'INSTITUTIONAL_GRADE_TEST',
        });

        const instructionId = initResult.data.instructionId;
        console.log(`  → Instruction initiated: ${instructionId}`);

        // Policy
        const policyRes = await makeRequest('/api/policy/evaluate', 'POST', { instructionId });
        if (policyRes.status !== 200) {
            console.log('  ❌ Policy Error:', policyRes.data);
            throw new Error('Policy evaluation failed');
        }
        console.log('  → Policy evaluated');

        // Route
        const routeRes = await makeRequest('/api/orchestration/route', 'POST', { instructionId });
        if (routeRes.status !== 200) {
            console.log('  ❌ Route Error:', routeRes.data);
            throw new Error('Routing failed');
        }
        console.log('  → Routed to crypto adapter');

        // Execute
        const execResult = await makeRequest('/api/adapter/execute', 'POST', {
            instructionId,
            adapter: 'ADAPTER_CRYPTO_CUSTODIAN',
        });

        if (execResult.data.adapter_result && execResult.data.adapter_result.blockchain_hash) {
            console.log('✅ PASS: Stellar transaction succeeded with vault-signed keys');
            console.log(
                `  → Blockchain Hash: ${execResult.data.adapter_result.blockchain_hash.substring(0, 16)}...`
            );
            passed++;
        } else {
            console.log('❌ FAIL: Stellar transaction failed');
            console.log(execResult.data);
            failed++;
        }
    } catch (err) {
        console.log('❌ FAIL:', err.message);
        failed++;
    }

    // Test 5: Input Validation (Should Reject)
    console.log('\n📋 TEST 5: Input Validation Middleware (Joi)');
    try {
        const result = await makeRequest('/api/instruction/initiate', 'POST', {
            amount: -100, // Should be rejected by Joi
            currency: 'USD',
            sender: 'Alice',
            recipient: 'Bob',
            purpose: 'TEST',
        });

        if (result.status === 400 && result.data.error === 'Validation Failed') {
            console.log('✅ PASS: Joi middleware correctly rejected invalid amount (-100)');
            passed++;
        } else {
            console.log(
                '❌ FAIL: Validation middleware did not reject negative amount or returned wrong status'
            );
            console.log('   Status:', result.status, 'Data:', result.data);
            failed++;
        }
    } catch (err) {
        console.log('❌ FAIL:', err.message);
        failed++;
    }

    // Summary
    console.log('\n========================================');
    console.log('VERIFICATION SUMMARY');
    console.log('========================================');
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`📊 Success Rate: ${Math.round((passed / (passed + failed)) * 100)}%`);

    if (failed === 0) {
        console.log('\n🎉 ALL CRITICAL TESTS PASSED!');
        console.log('System meets institutional grade prototype standards.');
    } else {
        console.log('\n⚠️  Some tests failed. Review above.');
    }

    console.log('\n========================================\n');
}

runVerification().catch(console.error);
