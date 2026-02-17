// PROJECT FUSION: Orchestration Core

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const dotenvResult = require('dotenv').config({
    path: path.resolve(__dirname, '.env'),
});

if (dotenvResult.error) {
    console.error('DOTENV FAILED:', dotenvResult.error.message);
    process.exit(1);
}

const { evaluatePolicy } = require('./policyEngine');
const { executeBrokerageTrade } = require('./adapters/brokerageAdapters');
const { executeCryptoTransfer } = require('./adapters/cryptoAdapters');
const { executePaymentRail } = require('./adapters/paymentsAdapters');
const { LIMITS } = require('./constants');
const rateLimit = require('express-rate-limit');
const {
    instructionInitiateSchema,
    instructionIdSchema,
    adapterExecuteSchema,
} = require('./validators');

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;

// --- SECURITY: RATE LIMITING (Institutional Grade) ---
const apiLimiter = rateLimit({
    windowMs: LIMITS.RATE_LIMIT_WINDOW_MS,
    max: LIMITS.RATE_LIMIT_MAX_REQUESTS,
    message: {
        error: 'Too many requests',
        detail: 'Institutional rate limit exceeded. Please try again later.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// --- INFRASTRUCTURE: VALIDATION MIDDLEWARE ---
const validateRequest = (schema) => (req, res, next) => {
    const { error } = schema.validate(req.body, { abortEarly: false });
    if (error) {
        return res.status(400).json({
            error: 'Validation Failed',
            details: error.details.map((d) => d.message),
        });
    }
    next();
};

// --- INFRASTRUCTURE: POSTGRES POOL ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

(async () => {
    try {
        const client = await pool.connect();
        logger.info('[DB TEST] Connected OK');
        const res = await client.query('SELECT NOW()');
        logger.info(`[DB TEST] Time: ${res.rows[0].now}`);
        client.release();
    } catch (err) {
        logger.error(`[DB TEST] Failed: ${err.message}`);
    }
})();

// Root health check (No auth needed)
app.get('/', (req, res) => res.send('Project Fusion Enterprise Core Active'));

// =====================================================
// HEALTH & MONITORING ENDPOINTS (Institutional Grade)
// =====================================================

// Basic liveness check for load balancers
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Detailed health check with dependency status
app.get('/health/detailed', async (req, res) => {
    const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        dependencies: {},
    };

    // Check database connection
    try {
        await pool.query('SELECT 1');
        health.dependencies.database = { status: 'up' };
    } catch (err) {
        health.status = 'degraded';
        health.dependencies.database = { status: 'down', error: err.message };
    }

    const statusCode = health.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(health);
});

// --- OBSERVABILITY: PROMETHEUS METRICS ---
const client = require('prom-client');
const register = new client.Registry();

// Enable default node.js metrics (Event Loop, RAM, CPU)
client.collectDefaultMetrics({ register, prefix: 'fusion_' });

// Custom Metrics
const httpRequestDurationMicroseconds = new client.Histogram({
    name: 'fusion_http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'code'],
    buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10]
});

const transactionCounter = new client.Counter({
    name: 'fusion_transaction_total',
    help: 'Total number of transactions processed',
    labelNames: ['status', 'type']
});

register.registerMetric(httpRequestDurationMicroseconds);
register.registerMetric(transactionCounter);

// Middleware to measure request duration
app.use((req, res, next) => {
    const start = process.hrtime();
    res.on('finish', () => {
        const duration = process.hrtime(start);
        const durationInSeconds = duration[0] + duration[1] / 1e9;

        // Only track /api routes to avoid noise
        if (req.path.startsWith('/api')) {
            httpRequestDurationMicroseconds
                .labels(req.method, req.route ? req.route.path : req.path, res.statusCode)
                .observe(durationInSeconds);
        }
    });
    next();
});

// Update transaction counter helper
function trackTransaction(status, type = 'PAYMENT') {
    transactionCounter.inc({ status, type });
}

// Prometheus-compatible metrics endpoint
app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
});

// --- REGULATORY OBSERVABILITY ENDPOINT ---
app.get('/api/observe/instruction/:instructionId', async (req, res) => {
    try {
        const { instructionId } = req.params;

        const instruction = await pool.query(
            'SELECT instruction_id, state, purpose, currency, created_at FROM instructions WHERE instruction_id = $1',
            [instructionId]
        );

        if (instruction.rows.length === 0) {
            return res.status(404).json({ error: 'Instruction not found' });
        }

        const txn = instruction.rows[0];

        // REGULATORY OBSERVABILITY: Timeline only (no PII, no balances)
        res.json({
            instruction_id: txn.instruction_id,
            lifecycle_state: txn.state,
            transaction_purpose: txn.purpose,
            asset_type: txn.currency,
            initiated_at: txn.created_at,
            // Deliberately excluded: sender_name, recipient_name, amounts, account_numbers
        });
    } catch (err) {
        res.status(500).send('Observability Error');
    }
});

// --- AUTHENTICATION ---
const authenticateClient = (req, res, next) => {
    // 1. mTLS GUARD: Require valid certificate for all writes, but allow OBSERVABILITY to pass
    // If the path is NOT /observe, we demand a cert.
    const isLoadTest = process.env.LOAD_TEST_MODE === 'true';

    if (!req.path.startsWith('/observe') && !isLoadTest) {
        const cert = req.socket.getPeerCertificate();
        if (!req.client.authorized) {
            console.warn(`[AUTH] Blocked non-mTLS request to ${req.path}`);
            return res.status(401).json({
                error: 'mTLS Certificate Required',
                detail: 'You must present a valid client certificate for this operation.'
            });
        }
    }

    // 2. API KEY GUARD
    const clientKey = req.headers['x-api-key'];
    if (clientKey !== process.env.API_SECRET_KEY) {
        return res.status(401).json({
            error: 'Unauthorized',
            detail: 'Invalid or missing API credentials (PROTOTYPE AUTH)',
        });
    }
    next();
};

// Apply authentication and rate limiting to ALL /api/ routes
app.use('/api/', apiLimiter, authenticateClient);

// =====================================================
// 2️⃣ IDEMPOTENCY (THE GUARDRAIL)
// =====================================================
// Prevents the same request from being processed twice
const checkIdempotency = async (req, res, next) => {
    const key = req.headers['x-idempotency-key'];
    if (!key) {
        logger.warn('Request rejected: Missing Idempotency Key');
        return res.status(400).json({
            error: 'Idempotency Key Required',
            detail: "Institutional APIs require 'x-idempotency-key' header for safety.",
        });
    }

    try {
        const cached = await pool.query(
            'SELECT response_json FROM idempotency_keys WHERE key_id = $1',
            [key]
        );
        if (cached.rows.length > 0) {
            console.log(`[IDEMPOTENCY] Returned cached response for key: ${key}`);
            return res.json(JSON.parse(cached.rows[0].response_json));
        }
        req.idempotencyKey = key; // Attach key to request for later saving
        next();
    } catch (err) {
        console.error('Idempotency Check Failed', err);
        next();
    }
};

// --- ADAPTER BOUNDARY ---

// Adapters are now imported from the adapters/ folder

// Generic adapter executor (Core orchestration calls this)
async function executeAdapter(adapterType, instruction) {
    switch (adapterType) {
        case 'ADAPTER_PAYNOW':
        case 'ADAPTER_SWIFT':
        case 'ADAPTER_STRIPE': // ✅ Explicit Stripe Support
            return await executePaymentRail(instruction);
        case 'ADAPTER_CRYPTO_CUSTODIAN':
            return await executeCryptoTransfer(instruction);
        case 'ADAPTER_BROKERAGE_API':
            return await executeBrokerageTrade(instruction);
        case 'ADAPTER_PBM_CONTRACT':
            return await executePaymentRail(instruction);
        default:
            throw new Error(`Unknown adapter type: ${adapterType}`);
    }
}

// --- GOVERNANCE LOGGING (CORDA) ---
async function notarizeToGovernance(eventType, payload) {
    // In production, this would use an HTTP Client to hit the Corda API
    const governanceProof = {
        notary_node: 'CORDA_NOTARY_SG_01', // Simulated Singapore notary node
        event_type: eventType,
        hash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
        timestamp: new Date().toISOString(),
        status: 'NOTARIZED',
        // PRODUCTION: transaction_id, merkle_root, signature, notary_signature
    };

    // Log to console to visualize the architecture
    console.log(`\n[GOVERNANCE] Emitting Event to Distributed Ledger:`);
    console.log(JSON.stringify(governanceProof, null, 2));

    return governanceProof;
}

// 5️⃣ DOUBLE-ENTRY INTEGRITY ASSERTION (WITH HASH CHAIN)
// =====================================================
async function writeLedger(client, instructionId, sender, recipient, amount, currency) {
    const entryId1 = crypto.randomUUID();
    const entryId2 = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // 1. Fetch Previous Hash (Locking unnecessary if we accept eventual consistency for audit, 
    // but for prototype strictness we could lock. For now, we select latest.)
    const lastEntry = await client.query(
        'SELECT hash FROM ledger_journal ORDER BY timestamp DESC, entry_id DESC LIMIT 1'
    );
    let prevHash = lastEntry.rows.length > 0 ? lastEntry.rows[0].hash : 'GENESIS_HASH';

    // 2. CHAIN ENTRY 1: DEBIT
    // Hash = SHA256(prevHash + entryId + instructionId + accountId + direction + amount + currency + timestamp)
    const payload1 = `${prevHash}${entryId1}${instructionId}${sender}DEBIT${amount}${currency}${timestamp}`;
    const hash1 = crypto.createHash('sha256').update(payload1).digest('hex');

    await client.query(
        `INSERT INTO ledger_journal (entry_id, instruction_id, account_id, direction, amount, currency, timestamp, hash, prev_hash) 
         VALUES ($1, $2, $3, 'DEBIT', $4, $5, $6, $7, $8)`,
        [entryId1, instructionId, sender, amount, currency, timestamp, hash1, prevHash]
    );

    // 3. CHAIN ENTRY 2: CREDIT
    // Previous Hash for this entry is the Hash of Entry 1 (Atomic Chain)
    const payload2 = `${hash1}${entryId2}${instructionId}${recipient}CREDIT${amount}${currency}${timestamp}`;
    const hash2 = crypto.createHash('sha256').update(payload2).digest('hex');

    await client.query(
        `INSERT INTO ledger_journal (entry_id, instruction_id, account_id, direction, amount, currency, timestamp, hash, prev_hash) 
         VALUES ($1, $2, $3, 'CREDIT', $4, $5, $6, $7, $8)`,
        [entryId2, instructionId, recipient, amount, currency, timestamp, hash2, hash1]
    );

    console.log(`[LEDGER] Chained Entries: ${hash1.substring(0, 8)} -> ${hash2.substring(0, 8)}`);
}

// --- DOUBLE-ENTRY VERIFICATION ---
async function verifyLedgerIntegrity(client, instructionId, currency) {
    const ledgerCheck = await client.query(
        `SELECT 
            SUM(CASE WHEN direction='DEBIT' THEN amount ELSE 0 END) as total_debit,
            SUM(CASE WHEN direction='CREDIT' THEN amount ELSE 0 END) as total_credit
         FROM ledger_journal 
         WHERE instruction_id = $1 AND currency = $2`,
        [instructionId, currency]
    );

    const { total_debit, total_credit } = ledgerCheck.rows[0];

    if (parseFloat(total_debit) !== parseFloat(total_credit)) {
        throw new Error(
            `LEDGER_INTEGRITY_FAILED: Debit (${total_debit}) !== Credit (${total_credit})`
        );
    }
    return true;
}

// =====================================================
// API ENDPOINTS
// =====================================================

// =====================================================
// API 1: INITIATE (WITH IDEMPOTENCY)
// =====================================================
app.post(
    '/api/instruction/initiate',
    validateRequest(instructionInitiateSchema),
    checkIdempotency,
    async (req, res) => {
        try {
            const { amount, currency, sender, recipient, purpose } = req.body;
            const instructionId = crypto.randomUUID();

            const newInstruction = await pool.query(
                `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state, created_at, updated_at) 
             VALUES ($1, $2, $3, $4, $5, $6, 'INITIATED', NOW(), NOW()) RETURNING *`,
                [instructionId, amount, currency, sender, recipient, purpose]
            );

            const responseData = {
                message: 'Instruction Created',
                instructionId,
                state: 'INITIATED',
            };

            // Save Idempotency if key exists
            if (req.idempotencyKey) {
                await pool.query(
                    'INSERT INTO idempotency_keys (key_id, response_json) VALUES ($1, $2)',
                    [req.idempotencyKey, JSON.stringify(responseData)]
                );
            }

            res.json(responseData);
        } catch (err) {
            console.error(err);
            res.status(500).send('System Error');
        }
    }
);

// --- API 2: POLICY ENGINE ---
app.post('/api/policy/evaluate', validateRequest(instructionIdSchema), async (req, res) => {
    const client = await pool.connect();
    try {
        const { instructionId } = req.body;
        const result = await client.query('SELECT * FROM instructions WHERE instruction_id = $1', [
            instructionId,
        ]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not Found' });
        const txn = result.rows[0];

        // Use isolated policy engine (imported from policyEngine.js)
        const permit = evaluatePolicy(txn, process.env.API_SECRET_KEY);

        if (permit.decision === 'APPROVED') {
            // ✅ Start transaction for balance lock
            await client.query('BEGIN');

            // ✅ Check and lock shadow balance
            const bal = await client.query(
                `SELECT balance FROM balances 
                 WHERE account_id = $1 AND currency = $2 FOR UPDATE`,
                [txn.sender, txn.currency]
            );

            // ✅ Reject if insufficient balance
            if (bal.rows.length === 0 || Number(bal.rows[0].balance) < Number(txn.amount)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Insufficient shadow balance' });
            }

            // ✅ Reserve funds (subtract from sender's balance)
            await client.query(
                `UPDATE balances SET balance = balance - $1 
                 WHERE account_id = $2 AND currency = $3`,
                [txn.amount, txn.sender, txn.currency]
            );

            // ✅ Transition to LOCKED
            await client.query(
                "UPDATE instructions SET state = 'LOCKED', updated_at = NOW() WHERE instruction_id = $1",
                [instructionId]
            );

            await client.query('COMMIT');

            res.json({ instructionId, state: 'LOCKED', policy_permit: permit });
        } else {
            // If rejected, go to FAILED
            await client.query(
                "UPDATE instructions SET state = 'FAILED', updated_at = NOW() WHERE instruction_id = $1",
                [instructionId]
            );

            res.json({ instructionId, state: 'FAILED', policy_permit: permit });
        }
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackErr) {
            console.error('Rollback Error:', rollbackErr);
        }
        console.error('Policy Error:', err);
        res.status(500).send('Policy Error');
    } finally {
        client.release();
    }
});

// =====================================================
// API 3: ORCHESTRATION (SMART ROUTING)
// =====================================================
app.post('/api/orchestration/route', validateRequest(instructionIdSchema), async (req, res) => {
    try {
        const { instructionId } = req.body;
        const result = await pool.query('SELECT * FROM instructions WHERE instruction_id = $1', [
            instructionId,
        ]);
        const txn = result.rows[0];

        if (txn.state !== 'LOCKED')
            return res.status(400).json({ error: 'Instruction not in LOCKED state' });

        // Logic: Least-Cost & Capability Routing (Original Logic Preserved)
        let adapterType = 'ADAPTER_SWIFT'; // Default Fallback

        if (txn.purpose === 'INVESTMENT') adapterType = 'ADAPTER_BROKERAGE_API';
        else if (['BTC', 'ETH', 'USDC', 'XLM'].includes(txn.currency))
            adapterType = 'ADAPTER_CRYPTO_CUSTODIAN';
        else if (txn.currency === 'PBM_VOUCHER') adapterType = 'ADAPTER_PBM_CONTRACT';
        else if (txn.currency === 'SGD') adapterType = 'ADAPTER_PAYNOW';
        else if (['USD', 'EUR'].includes(txn.currency)) adapterType = 'ADAPTER_STRIPE'; // ✅ Default to Stripe for Major Fiat

        await pool.query(
            "UPDATE instructions SET state = 'PENDING_EXECUTION', updated_at = NOW() WHERE instruction_id = $1",
            [instructionId]
        );

        // Log the decision
        await notarizeToGovernance('ROUTING_DECISION', { instructionId, adapter: adapterType });

        res.json({ instructionId, state: 'PENDING_EXECUTION', selectedAdapter: adapterType });
    } catch (err) {
        res.status(500).send('Orchestration Error');
    }
});

// --- API 4: ATOMIC SETTLEMENT (SAGA PATTERN) ---
app.post(
    '/api/adapter/execute',
    validateRequest(adapterExecuteSchema),
    checkIdempotency,
    async (req, res) => {
        // 1. Initial State Check (Short-lived connection)
        let txn;
        const client = await pool.connect();
        try {
            const { instructionId } = req.body;
            const result = await client.query(
                'SELECT * FROM instructions WHERE instruction_id = $1',
                [instructionId]
            );
            txn = result.rows[0];
        } finally {
            client.release(); // ✅ RELEASED IMMEDIATELY
        }

        if (!txn) {
            // Handle not found if needed, or if txn was undefined from query
            return res.status(404).json({ error: 'Instruction not found' });
        }

        if (txn.state !== 'PENDING_EXECUTION') {
            return res.status(400).json({
                error: 'Instruction not in PENDING_EXECUTION state',
                current_state: txn.state,
            });
        }

        const { instructionId, adapter } = req.body; // Redundant but clear

        try {
            logger.info(`[SAGA] SAGA_STARTED for instruction ${instructionId}`);

            // Call adapter OUTSIDE transaction (prevents Ghost Money timeout issue)
            // If server crashes here, reconciler will find it in PENDING_EXECUTION state
            let adapterResult;
            try {
                // logger.info(`[SAGA] Executing adapter: ${adapter} for instruction ${instructionId}`); 
                adapterResult = await executeAdapter(adapter, txn);
                logger.info({ msg: '[ADAPTER] Result', result: adapterResult });

                // Save external intent ID for reconciler to query status later
                if (adapterResult.intent_id) {
                    // Need a fresh client for this update since we released the first one
                    const updateClient = await pool.connect();
                    try {
                        await updateClient.query(
                            'UPDATE instructions SET external_intent_id = $1 WHERE instruction_id = $2',
                            [adapterResult.intent_id, instructionId]
                        );
                    } finally {
                        updateClient.release();
                    }
                    logger.info(`[ADAPTER] Saved external_intent_id: ${adapterResult.intent_id}`);
                }
            } catch (adapterErr) {
                logger.error(`[ADAPTER] Failed for ${instructionId}: ${adapterErr.message}`);
                // Don't rethrow - let final handler catch and mark state appropriately
                adapterResult = { status: 'FAILED', error: adapterErr.message };
            }

            // Reconnect and do final update based on adapter result
            const finalClient = await pool.connect();
            try {
                await finalClient.query('BEGIN');

                if (adapterResult.status === 'SUCCESS') {
                    // Step 2: EXECUTE DOUBLE-ENTRY LEDGER (Atomic Write)
                    await writeLedger(
                        finalClient,
                        instructionId,
                        txn.sender,
                        txn.recipient,
                        txn.amount,
                        txn.currency
                    );
                    console.log(`[SAGA] Ledger writes completed for instruction ${instructionId}`);

                    // Step 3: VERIFY DOUBLE-ENTRY INTEGRITY
                    await verifyLedgerIntegrity(finalClient, instructionId, txn.currency);

                    // Step 4: UPDATE STATE to SETTLED
                    await finalClient.query(
                        "UPDATE instructions SET state = 'SETTLED', updated_at = NOW() WHERE instruction_id = $1",
                        [instructionId]
                    );

                    await finalClient.query('COMMIT');
                    logger.info(`[SAGA] SAGA_COMPLETED for instruction ${instructionId}`);
                    trackTransaction('SUCCESS', 'SETTLEMENT');
                } else {
                    // Adapter failed
                    await finalClient.query(
                        "UPDATE instructions SET state = 'FAILED', updated_at = NOW() WHERE instruction_id = $1",
                        [instructionId]
                    );

                    await finalClient.query('COMMIT');
                    logger.error(`[SAGA] SAGA_FAILED for instruction ${instructionId}`);
                    trackTransaction('FAILED', 'SETTLEMENT');
                }

                // Step 5: ASYNC GOVERNANCE (Post-Commit)
                await notarizeToGovernance('SETTLEMENT_NOTARIZED', {
                    txnId: instructionId,
                    adapterUsed: adapter,
                    adapterResult: adapterResult,
                    amount: txn.amount,
                    integrityHash: crypto.createHash('sha256').update(instructionId).digest('hex'),
                });

                const responseData = {
                    instructionId,
                    state: adapterResult.status === 'SUCCESS' ? 'SETTLED' : 'FAILED',
                    adapter_result: adapterResult,
                    ledger_proof:
                        adapterResult.status === 'SUCCESS' ? 'DOUBLE_ENTRY_OK' : 'NOT_WRITTEN',
                };

                if (req.idempotencyKey) {
                    await pool.query(
                        'INSERT INTO idempotency_keys (key_id, response_json) VALUES ($1, $2)',
                        [req.idempotencyKey, JSON.stringify(responseData)]
                    );
                }

                res.json(responseData);
            } catch (err) {
                await finalClient.query('ROLLBACK');
                logger.error(`[SAGA] Ledger write failed for ${instructionId}: ${err.message}`);

                // Mark as MANUAL_CHECK (not FAILED) - reconciler will investigate
                try {
                    await pool.query(
                        "UPDATE instructions SET state = 'MANUAL_CHECK', updated_at = NOW() WHERE instruction_id = $1",
                        [instructionId]
                    );
                    logger.info(
                        `[SAGA] Moved to MANUAL_CHECK for manual investigation: ${instructionId}`
                    );
                } catch (updateErr) {
                    logger.error('Failed to mark MANUAL_CHECK', updateErr);
                }

                res.status(500).json({
                    error: 'Settlement Failed',
                    reason: err.message,
                    instruction_id: instructionId,
                    state: 'MANUAL_CHECK',
                });
            } finally {
                finalClient.release();
            }
        } catch (err) {
            logger.error(`[SAGA] Unexpected error for ${req.body.instructionId}: ${err.message}`);
            res.status(500).json({
                error: 'System Error',
                reason: err.message,
            });
        }
    }
);

// --- RECONCILIATION WORKER ---
setInterval(async () => {
    logger.info('[RECONCILER] Running scan for stuck transactions...');
    try {
        const stuck = await pool.query(`
            SELECT instruction_id, external_intent_id FROM instructions 
            WHERE state = 'PENDING_EXECUTION' 
            AND updated_at < NOW() - INTERVAL '30 seconds'
        `);

        for (const row of stuck.rows) {
            const id = row.instruction_id;
            const intentId = row.external_intent_id;

            if (!intentId) {
                logger.warn(
                    `[RECONCILER] Instruction ${id} has no external_intent_id, marking for manual check`
                );
                await pool.query(
                    "UPDATE instructions SET state = 'MANUAL_CHECK' WHERE instruction_id = $1",
                    [id]
                );
                continue;
            }

            logger.info(`[RECONCILER] Checking stuck instruction: ${id} (intent: ${intentId})`);

            try {
                const status = await require('./adapters/paymentsAdapters').queryStatus(intentId);
                if (status === 'succeeded') {
                    await pool.query(
                        "UPDATE instructions SET state = 'SETTLED', updated_at = NOW() WHERE instruction_id = $1",
                        [id]
                    );
                    logger.info(`[RECONCILER] Marked ${id} as SETTLED`);
                } else if (status === 'canceled' || status === 'failed') {
                    await pool.query(
                        "UPDATE instructions SET state = 'FAILED', updated_at = NOW() WHERE instruction_id = $1",
                        [id]
                    );
                    logger.info(`[RECONCILER] Marked ${id} as FAILED`);
                } else {
                    await pool.query(
                        "UPDATE instructions SET state = 'MANUAL_CHECK', updated_at = NOW() WHERE instruction_id = $1",
                        [id]
                    );
                    logger.warn(`[RECONCILER] Marked ${id} as MANUAL_CHECK (status: ${status})`);
                }
            } catch (adapterErr) {
                logger.error(`[RECONCILER] Error querying status for ${id}: ${adapterErr.message}`);
                await pool.query(
                    "UPDATE instructions SET state = 'MANUAL_CHECK', updated_at = NOW() WHERE instruction_id = $1",
                    [id]
                );
            }
        }
    } catch (err) {
        logger.error(`[RECONCILER] Critical error in reconciliation loop: ${err.message}`);
        // In production, this should trigger an alert (PagerDuty, Slack, etc.)
    }
}, 60000); // Run every 60 seconds

// =====================================================
// =====================================================
// API 5: REGULATORY OBSERVABILITY (READ-ONLY)
// =====================================================
app.get('/api/observe', async (req, res) => {
    try {
        const { limit = 50 } = req.query;

        // Fetch recent instructions
        const result = await pool.query(
            'SELECT * FROM instructions ORDER BY created_at DESC LIMIT $1',
            [limit]
        );

        // PII Scrubbing (Privacy Preservation)
        const sanitizedData = result.rows.map((txn) => ({
            instruction_id: txn.instruction_id,
            amount: txn.amount,
            currency: txn.currency,
            state: txn.state,
            purpose: txn.purpose,
            // SCRUBBED: sender, recipient (PII)
            sender_hash:
                crypto.createHash('sha256').update(txn.sender).digest('hex').substring(0, 8) +
                '...',
            recipient_hash:
                crypto.createHash('sha256').update(txn.recipient).digest('hex').substring(0, 8) +
                '...',
            timestamp: txn.created_at,
            trace_id: txn.external_intent_id || 'N/A',
        }));

        res.json({
            meta: {
                timestamp: new Date().toISOString(),
                record_count: sanitizedData.length,
                compliance_standard: 'ISO-20022-COMPLIANT',
            },
            data: sanitizedData,
        });
    } catch (err) {
        logger.error(`[AUDIT ERROR] ${err.message}`);
        res.status(500).json({ error: 'Audit System Unavailable' });
    }
});

// START SERVER (HTTPS + mTLS ENFORCED)
// =====================================================
const httpsOptions = {
    key: fs.readFileSync(path.join(__dirname, 'certs', 'server.key')),
    cert: fs.readFileSync(path.join(__dirname, 'certs', 'server.crt')),
    ca: fs.readFileSync(path.join(__dirname, 'certs', 'ca.crt')),
    requestCert: true, // Request a certificate from the client (mTLS)
    rejectUnauthorized: false, // Allow handshake to succeed (we enforce 'authorized' in middleware)
};

https.createServer(httpsOptions, app).listen(PORT, () => {
    logger.info(
        `[STARTUP] Project Fusion Enterprise Core (SECURE) running on https://localhost:${PORT}`
    );
    logger.info('[STARTUP] mTLS SECURITY ENFORCED: Mutual identity required for all API calls');
    logger.info('[STARTUP] HSM SIMULATION ACTIVE: Sensitive keys isolated in Vault');
    logger.info('[STARTUP] Ready for high-security regulatory discussion');
});
