/**
 * SCALED LOAD TEST SCRIPT (Institutional TPS Verification)
 * 
 * Simulates high-velocity institutional traffic.
 * - Concurrency: 100 requests (Parallel sockets)
 * - Total Requests: 5000
 * - Target TPS: > 500
 * - Endpoint: /api/instruction/initiate
 */

require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.API_SECRET_KEY;
const PORT = process.env.PORT || 3000;
const CONCURRENCY = 100;
const TOTAL_REQUESTS = 5000;

const httpsAgent = new https.Agent({
    key: fs.readFileSync(path.join(__dirname, 'certs', 'client.key')),
    cert: fs.readFileSync(path.join(__dirname, 'certs', 'client.crt')),
    ca: fs.readFileSync(path.join(__dirname, 'certs', 'ca.crt')),
    rejectUnauthorized: true,
    keepAlive: true,
    maxSockets: CONCURRENCY // Maximize socket reuse
});

function makeRequest(id) {
    return new Promise((resolve) => {
        const start = Date.now();
        const options = {
            hostname: 'localhost',
            port: PORT,
            path: '/api/instruction/initiate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEY,
                'x-idempotency-key': `load_${id}_${Math.random()}`
            },
            agent: httpsAgent
        };

        const body = JSON.stringify({
            amount: 10.00,
            currency: "USD",
            sender: "Load_Tester",
            recipient: "Load_Receiver",
            purpose: "TPS_SCALING_VERIFICATION"
        });

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                const duration = Date.now() - start;
                // Treat 200/201 as success
                resolve({
                    status: res.statusCode,
                    duration
                });
            });
        });

        req.on('error', (e) => resolve({ status: 'ERR', duration: Date.now() - start, error: e.message }));
        req.write(body);
        req.end();
    });
}

async function runLoadTest() {
    console.log(`\n🚀 STARTING INSTITUTIONAL SCALE TEST`);
    console.log(`-----------------------------------`);
    console.log(`Target: https://localhost:${PORT}`);
    console.log(`Requests: ${TOTAL_REQUESTS}`);
    console.log(`Concurrency: ${CONCURRENCY}\n`);

    const startTime = Date.now();
    let completed = 0;
    let success = 0;
    let failed = 0;
    const latencies = [];

    const queue = Array.from({ length: TOTAL_REQUESTS }, (_, i) => i);
    const workers = Array(CONCURRENCY).fill(null).map(async () => {
        while (queue.length > 0) {
            const id = queue.shift();
            const result = await makeRequest(id);
            latencies.push(result.duration);
            if (result.status === 200 || result.status === 201) {
                success++;
            } else {
                failed++;
            }
            completed++;
            if (completed % 250 === 0) process.stdout.write('█');
        }
    });

    await Promise.all(workers);

    const endTime = Date.now();
    const totalTimeMs = endTime - startTime;
    const totalTimeSec = totalTimeMs / 1000;
    const tps = Math.round(success / totalTimeSec);
    const avgLatency = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);

    console.log(`\n\n📊 SCALING RESULTS`);
    console.log(`---------------------`);
    console.log(`Time Taken: ${totalTimeSec.toFixed(2)}s`);
    console.log(`Successful: ${success}`);
    console.log(`Failed:     ${failed}`);
    console.log(`Avg Latency: ${avgLatency}ms`);
    console.log(`throughput:  ${tps} TPS`);
    console.log(`---------------------`);

    // Write strictly formatted JSON file for result parsing
    const report = {
        total_requests: TOTAL_REQUESTS,
        concurrency: CONCURRENCY,
        time_taken_sec: totalTimeSec,
        successful: success,
        failed: failed,
        avg_latency_ms: avgLatency,
        tps: tps
    };
    fs.writeFileSync('scale_report.json', JSON.stringify(report, null, 2));
}

runLoadTest();
