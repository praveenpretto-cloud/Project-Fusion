const https = require('https');
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

const API_KEY = process.env.API_SECRET_KEY;
const PORT = process.env.PORT || 3000;

// Setup DB
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// Setup HTTPS Agent
const agent = new https.Agent({
    rejectUnauthorized: false,
    key: fs.readFileSync('certs/client.key'),
    cert: fs.readFileSync('certs/client.crt'),
    ca: fs.readFileSync('certs/ca.crt'),
});

function makeRequest(path, method, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: 'localhost',
                port: PORT,
                path: '/api' + path,
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': API_KEY,
                    'x-idempotency-key': `recovery_test_${Date.now()}`,
                },
                agent: agent,
            },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => resolve(JSON.parse(data)));
            }
        );
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function runRecoveryProof() {
    console.log("🔥 STARTING 'GHOST MONEY' RECOVERY PROOF 🔥");
    console.log('------------------------------------------');

    try {
        // 1. Create a REAL Valid Transaction first
        console.log('1. Creating a valid transaction...');
        const init = await makeRequest('/instruction/initiate', 'POST', {
            amount: 15.0,
            currency: 'USD',
            sender: 'user_123_test',
            recipient: 'user_456_test',
            purpose: 'RECOVERY_TEST',
        });
        const id = init.instructionId;
        console.log(`   Instruction Created: ${id}`);

        await makeRequest('/policy/evaluate', 'POST', { instructionId: id });
        await makeRequest('/orchestration/route', 'POST', { instructionId: id });

        // Execute fully to get a real Stripe ID
        console.log('   Executing to get real Stripe ID...');
        const exec = await makeRequest('/adapter/execute', 'POST', {
            instructionId: id,
            adapter: 'ADAPTER_SWIFT', // Maps to Stripe in code
        });

        if (exec.state !== 'SETTLED') {
            throw new Error("Setup failed: Transaction didn't settle initially");
        }

        const realIntentId = exec.adapter_result.intent_id;
        console.log(`   ✅ Setup Complete. External ID: ${realIntentId}`);

        // 2. SIMULATE THE CRASH (The "Ghost Money" Scenario)
        // We manually force the DB back to 'PENDING_EXECUTION' and age it.
        // This simulates: Adapter succeeded, but Server crashed BEFORE getting to 'SETTLED'.
        console.log('\n2. 💥 SIMULATING SERVER CRASH (Ghost Money State)...');
        console.log("   Manually rolling back DB state to 'PENDING_EXECUTION'...");

        await pool.query(
            `
            UPDATE instructions 
            SET state = 'PENDING_EXECUTION', 
                updated_at = NOW() - INTERVAL '5 minutes'
            WHERE instruction_id = $1
        `,
            [id]
        );

        // Verify it's broken
        const check = await pool.query('SELECT state FROM instructions WHERE instruction_id = $1', [
            id,
        ]);
        console.log(`   Current DB State: ${check.rows[0].state} (Should be PENDING_EXECUTION)`);
        console.log(
            "   (Money has moved at Stripe, but DB thinks it's pending. This is Ghost Money.)"
        );

        // 3. WAIT FOR RECONCILER
        console.log('\n3. ⏳ Waiting for Auto-Healing Worker (Runs every 60s)...');

        // Poll every 5 seconds until fixed
        // Poll every 5 seconds until fixed (Max 125s, covering the 60s worker loop safely)
        let attempts = 0;
        while (attempts < 25) {
            await new Promise((r) => setTimeout(r, 5000));
            process.stdout.write('.');

            const poll = await pool.query(
                'SELECT state, updated_at FROM instructions WHERE instruction_id = $1',
                [id]
            );
            if (poll.rows[0].state === 'SETTLED') {
                console.log('\n\n✅ RECOVERY DETECTED!');
                console.log(`   State is now: ${poll.rows[0].state}`);
                console.log(`   Fixed At: ${poll.rows[0].updated_at}`);
                console.log('------------------------------------------');
                console.log('PROOF: The system automatically detected the discrepancy');
                console.log('       and synchronized the ledger with the external rail.');
                process.exit(0);
            }
            attempts++;
        }

        console.log('\n❌ Timeout waiting for recovery. Is the worker running?');
        process.exit(1);
    } catch (e) {
        console.error(e);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

runRecoveryProof();
