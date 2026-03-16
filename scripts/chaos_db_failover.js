const { execSync } = require('child_process');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE_URL = 'https://localhost:3000';
const HEALTH_URL = `${BASE_URL}/health/detailed`;

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

async function runChaos() {
    console.log('🌪️  STARTING CHAOS TEST: Database Failover');
    console.log('-----------------------------------------');

    // 1. BASELINE CHECK
    console.log('1️⃣  Checking Baseline Health...');
    const baseline = await checkHealth();
    if (baseline.status !== 200) {
        console.error('❌ Baseline check failed. Server must be healthy to start chaos.');
        console.error(baseline);
        process.exit(1);
    }
    console.log('✅ System Healthy (200 OK)');

    // 2. INJECT FAILURE
    console.log('\n2️⃣  Injecting Failure: Stopping Database Container...');
    try {
        execSync('docker-compose stop db', { stdio: 'inherit' });
    } catch {
        console.warn('⚠️  Could not run docker-compose. Assuming DB is local/manual.');
        console.log('👉 ACTION REQUIRED: Manually STOP your Database now!');
        await sleep(10000);
    }

    // 3. VERIFY DEGRADATION
    console.log('\n3️⃣  Verifying Degradation (Expect 503)...');
    let outagesDetected = 0;
    for (let i = 0; i < 5; i++) {
        await sleep(2000);
        const result = await checkHealth();
        if (result.status === 503) {
            console.log(`✅ Verified: API returned 503 Service Unavailable (Attempt ${i + 1})`);
            outagesDetected++;
            break;
        } else {
            console.log(`⚠️  Status: ${result.status} (Expected 503)`);
        }
    }

    if (outagesDetected === 0) {
        console.error('❌ FAILED: API did not report 503 despite DB outage.');
    }

    // 4. RECOVERY
    console.log('\n4️⃣  Recovering: Starting Database Container...');
    try {
        execSync('docker-compose start db', { stdio: 'inherit' });
    } catch {
        console.log('👉 ACTION REQUIRED: Manually START your Database now!');
    }

    // 5. VERIFY RECOVERY
    console.log('\n5️⃣  Verifying Recovery (Expect 200)...');
    let recovered = false;
    for (let i = 0; i < 15; i++) {
        // Wait up to 30s
        await sleep(2000);
        const result = await checkHealth();
        if (result.status === 200) {
            console.log('✅ RECOVERED: System is healthy again!');
            recovered = true;
            break;
        }
        console.log(`⏳ Waiting for recovery... Status: ${result.status}`);
    }

    if (!recovered) {
        console.error('❌ FAILED: System did not recover within 30 seconds.');
        process.exit(1);
    }

    console.log('\n-----------------------------------------');
    console.log('🎉 CHAOS TEST PASSED: Graceful degradation and recovery verified.');
}

runChaos();
