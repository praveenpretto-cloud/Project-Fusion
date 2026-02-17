const { spawn } = require('child_process');
const https = require('https');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const HEALTH_URL = 'https://localhost:3000/health/detailed';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkHealth() {
    try {
        const res = await fetch(HEALTH_URL);
        const data = await res.json();
        return { status: res.status, data };
    } catch (err) {
        return { status: 0, error: err.message };
    }
}

async function startServer(envOverride = {}) {
    const env = { ...process.env, ...envOverride, LOAD_TEST_MODE: 'true' };
    const child = spawn('node', ['server.js'], { env, stdio: 'inherit' });
    console.log(`🚀 Started server (PID: ${child.pid}) with DB_PORT=${env.DB_PORT || 'default'}`);

    // Wait for startup
    await sleep(5000);
    return child;
}

async function runChaos() {
    console.log('🌪️  STARTING CHAOS TEST: Simulated DB Outage');
    console.log('-----------------------------------------');

    // 1. INJECT FAILURE (Wrong Port)
    console.log('\n1️⃣  Starting Server with BAD DB_PORT (5433)...');
    let badServer = await startServer({ DB_PORT: '5433' });

    console.log('🔍 Verifying Degradation (Expect 503)...');
    let degraded = false;
    for (let i = 0; i < 5; i++) {
        const result = await checkHealth();
        if (result.status === 503) {
            console.log(`✅ Verified: API returned 503 Service Unavailable`);
            degraded = true;
            break;
        }
        await sleep(1000);
    }

    if (!degraded) {
        console.error('❌ FAILED: Server did not report 503 with bad DB config.');
    }

    console.log('🛑 Stopping Bad Server...');
    badServer.kill();
    await sleep(2000);

    // 2. RECOVERY (Correct Port)
    console.log('\n2️⃣  Starting Server with GOOD DB_PORT (5432)...');
    let goodServer = await startServer({ DB_PORT: '5432' });

    console.log('🔍 Verifying Recovery (Expect 200)...');
    let recovered = false;
    for (let i = 0; i < 10; i++) {
        const result = await checkHealth();
        if (result.status === 200) {
            console.log(`✅ Verified: API returned 200 OK`);
            recovered = true;
            break;
        }
        await sleep(2000);
    }

    if (!recovered) {
        console.error('❌ FAILED: Server did not recover with good DB config.');
    }

    console.log('🛑 Stopping Good Server...');
    goodServer.kill();

    console.log('\n-----------------------------------------');
    if (degraded && recovered) {
        console.log('🎉 CHAOS TEST PASSED: Graceful degradation and recovery verified.');
    } else {
        console.log('❌ CHAOS TEST FAILED.');
        process.exit(1);
    }
}

runChaos();
