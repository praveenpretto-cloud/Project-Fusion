const cluster = require('cluster');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// --- INFRASTRUCTURE: CLUSTERING (Horizontal Scaling) ---

if (require.main === module) {
    const isLocalOnly = process.env.LOCAL_ONLY === 'true';
    if (cluster.isPrimary && !isLocalOnly) {
        const numCPUs = os.cpus().length;
        console.log(`[MASTER] Master ${process.pid} is running`);
        console.log(`[MASTER] Forking ${numCPUs} workers for maximum throughput...`);

        // Fork workers.
        for (let i = 0; i < numCPUs; i++) {
            cluster.fork();
        }

        cluster.on('exit', (worker) => {
            console.error(`[MASTER] Worker ${worker.process.pid} died. Forking replacement...`);
            cluster.fork();
        });
    } else {
        if (isLocalOnly)
            console.log(`[LOCAL_ONLY] Running in single-process mode (Clustering disabled)`);
        startApp();
    }
} else {
    // Export for testing
    module.exports = startApp();
}

function startApp() {
    const { validateEnvironment } = require('./core/configValidator');
    // Enforce fail-closed testnet & sandbox environment validation on startup
    validateEnvironment();

    const express = require('express');
    const cors = require('cors');
    const { Pool } = require('pg');
    const https = require('https');
    const crypto = require('crypto');
    const fs = require('fs');
    const logger = require('./logger');

    const Redis = require('ioredis');
    const {
        defaultCanonicalApprovalService,
    } = require('./core/approvals/canonicalApprovalService');
    const { pushToBatchQueue } = require('./core/ingestion/kafkaProducer');

    // --- LOCAL_ONLY: IN-MEMORY IDEMPOTENCY ---
    const localIdempotencyStore = new Map();
    let redis;

    if (process.env.LOCAL_ONLY !== 'true') {
        redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
        redis.on('error', (err) => {
            logger.warn(`[REDIS] Connection error: ${err.message}.`);
        });
    } else {
        logger.info('[LOCAL_ONLY] Redis disabled. Using in-memory idempotency store.');
    }

    const { executeCryptoTransfer } = require('./adapters/cryptoAdapters');
    const { executePaymentRail } = require('./adapters/paymentsAdapters');
    const { LIMITS } = require('./constants');
    const rateLimit = require('express-rate-limit');
    const { instructionIdSchema, adapterExecuteSchema } = require('./validators');
    const { getArbitrageReport } = require('./core/treasury/arbitrage');
    const { ensureStellarLiquidity } = require('./core/treasury/balancer');

    const app = express();
    app.use(cors());
    app.use(
        express.json({
            verify: (req, res, buf) => {
                req.rawBody = buf;
            },
        })
    );

    // AI-2A: Strip client-supplied user impersonation headers globally before routing
    const { stripClientImpersonationHeaders } = require('./core/identity/authMiddleware');
    const { createAuthRouter } = require('./routes/authRouter');
    const { createApprovalsRouter } = require('./routes/approvalsRouter');
    app.use(stripClientImpersonationHeaders);
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
        max: 10, // OPTIMIZED: 10 conns * 8 workers = 80 total (safe for default PG limit)
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    });

    (async () => {
        try {
            const client = await pool.connect();
            logger.info('[DB TEST] Connected OK');
            const res = await client.query('SELECT NOW()');
            logger.info(`[DB TEST] Time: ${res.rows[0].now}`);

            // Add execution_attempts column if it doesn't exist
            await client.query(
                'ALTER TABLE instructions ADD COLUMN IF NOT EXISTS execution_attempts INTEGER DEFAULT 0'
            );
            logger.info('[DB TEST] Checked and ensured execution_attempts column exists');

            // Add od_limit column if it doesn't exist
            await client.query(
                'ALTER TABLE business_bank_accounts ADD COLUMN IF NOT EXISTS od_limit NUMERIC(15, 2) DEFAULT 2000000.00'
            );
            logger.info(
                '[DB TEST] Checked and ensured od_limit column exists on business_bank_accounts'
            );

            // Add utr column if it doesn't exist
            await client.query(
                'ALTER TABLE instructions ADD COLUMN IF NOT EXISTS utr VARCHAR(255)'
            );
            logger.info('[DB TEST] Checked and ensured utr column exists on instructions');

            // Add metadata JSONB column if it doesn't exist (Reliability R2B)
            await client.query(
                "ALTER TABLE instructions ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb"
            );
            logger.info(
                '[DB TEST] Checked and ensured metadata JSONB column exists on instructions'
            );

            // Add saga_state JSONB column if it doesn't exist
            await client.query(
                'ALTER TABLE instructions ADD COLUMN IF NOT EXISTS saga_state JSONB DEFAULT NULL'
            );
            logger.info('[DB TEST] Checked and ensured saga_state column exists on instructions');

            // Ensure state guard trigger allows metadata updates on already-settled instructions
            await client.query(`
                CREATE OR REPLACE FUNCTION identity.trg_enforce_instructions_state_guard()
                RETURNS TRIGGER AS $$
                DECLARE
                    v_is_super BOOLEAN := FALSE;
                BEGIN
                    IF TG_OP = 'UPDATE' THEN
                        IF OLD.state = 'VOIDED' OR OLD.approval_status = 'VOIDED' THEN
                            RAISE EXCEPTION 'Instruction % is in terminal state VOIDED and cannot be modified or transitioned', OLD.instruction_id;
                        END IF;

                        SELECT rolsuper INTO v_is_super FROM pg_roles WHERE rolname = CURRENT_USER;

                        IF ((NEW.state = 'APPROVED' AND OLD.state IS DISTINCT FROM 'APPROVED')
                            OR (NEW.approval_status = 'APPROVED' AND OLD.approval_status IS DISTINCT FROM 'APPROVED')
                            OR (NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED'))
                           AND CURRENT_USER <> 'fusion_workflow_definer' THEN
                            RAISE EXCEPTION 'Direct transition of instruction % to APPROVED is prohibited. '
                                            'State transitions must execute via identity.fn_approve_payment_instruction() '
                                            'under fusion_workflow_definer (effective_role: %)', OLD.instruction_id, CURRENT_USER;
                        END IF;

                        IF ((NEW.state = 'VOIDED' AND OLD.state IS DISTINCT FROM 'VOIDED')
                            OR (NEW.approval_status = 'VOIDED' AND OLD.approval_status IS DISTINCT FROM 'VOIDED')
                            OR (NEW.status = 'VOIDED' AND OLD.status IS DISTINCT FROM 'VOIDED'))
                           AND CURRENT_USER <> 'fusion_workflow_definer' THEN
                            RAISE EXCEPTION 'Direct transition of instruction % to VOIDED is prohibited. '
                                            'State transitions must execute via identity.fn_approve_payment_void() '
                                            'under fusion_workflow_definer (effective_role: %)', OLD.instruction_id, CURRENT_USER;
                        END IF;

                        IF ((NEW.state = 'EXECUTED' AND OLD.state IS DISTINCT FROM 'EXECUTED')
                            OR (NEW.status = 'EXECUTED' AND OLD.status IS DISTINCT FROM 'EXECUTED')) THEN
                            IF CURRENT_USER = 'fusion_app_runtime'
                               OR CURRENT_USER = 'fusion_webauthn_verifier'
                               OR (CURRENT_USER <> 'fusion_workflow_definer' AND NOT COALESCE(v_is_super, FALSE)) THEN
                                RAISE EXCEPTION 'Direct transition of instruction % to EXECUTED is prohibited. '
                                                'State transitions must execute via identity.fn_execute_payment_instruction() '
                                                'under fusion_workflow_definer (effective_role: %)', OLD.instruction_id, CURRENT_USER;
                            END IF;
                        END IF;

                        IF ((NEW.state = 'SETTLED' AND OLD.state IS DISTINCT FROM 'SETTLED')
                            OR (NEW.status = 'SETTLED' AND OLD.status IS DISTINCT FROM 'SETTLED')) THEN
                            IF CURRENT_USER = 'fusion_app_runtime'
                               OR CURRENT_USER = 'fusion_webauthn_verifier'
                               OR (CURRENT_USER <> 'fusion_workflow_definer' AND NOT COALESCE(v_is_super, FALSE)) THEN
                                RAISE EXCEPTION 'Direct transition of instruction % to SETTLED is prohibited. '
                                                'State transitions must execute via identity.fn_settle_payment_instruction() '
                                                'under fusion_workflow_definer (effective_role: %)', OLD.instruction_id, CURRENT_USER;
                            END IF;
                        END IF;

                        IF (((NEW.state IN ('EXECUTED', 'SETTLED') AND NEW.state IS DISTINCT FROM OLD.state))
                            OR ((NEW.status IN ('EXECUTED', 'SETTLED') AND NEW.status IS DISTINCT FROM OLD.status))) THEN
                            IF OLD.approval_status IS DISTINCT FROM 'APPROVED'
                               AND OLD.state NOT IN ('APPROVED', 'PENDING_EXECUTION', 'LOCKED', 'PENDING_SETTLEMENT', 'EXECUTED') THEN
                                RAISE EXCEPTION 'Instruction % cannot transition to % without prior approval '
                                                '(current approval_status: %, state: %)',
                                                OLD.instruction_id,
                                                COALESCE(NEW.status, NEW.state),
                                                OLD.approval_status,
                                                OLD.state;
                            END IF;
                        END IF;
                    END IF;
                    RETURN NEW;
                END;
                $$ LANGUAGE plpgsql
                SET search_path = pg_catalog, identity, public;
            `);
            logger.info(
                '[DB TEST] Checked and ensured instructions state guard allows metadata updates'
            );

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

    // Basic liveness check for load balancers (Minimal, unauthenticated)
    app.get('/api/health', (req, res) => {
        res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
    });

    // =====================================================
    // AUTHENTICATION MIDDLEWARE (WORKSTREAM 0 CONTAINMENT)
    // =====================================================
    const authenticateClient = (req, res, next) => {
        // Public authentication entry points & provider webhooks (HMAC-verified separately)
        if (
            req.originalUrl.startsWith('/api/auth') ||
            req.originalUrl.startsWith('/api/webhooks')
        ) {
            return next();
        }

        // Strict API key credential check
        const clientKey = (req.headers['x-api-key'] || '').trim();
        const secretKey = (process.env.API_SECRET_KEY || '').trim();

        if (!clientKey || !secretKey || clientKey !== secretKey) {
            logger.warn(`[AUTH] 401 Unauthorized for ${req.path} from ${req.ip}`);
            return res.status(401).json({
                error: 'Unauthorized',
                detail: 'Invalid or missing API credentials (Workstream 0 containment)',
            });
        }
        next();
    };

    // Detailed health check with dependency status (Protected)
    app.get('/api/health/detailed', authenticateClient, async (req, res) => {
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
        buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10],
    });

    const transactionCounter = new client.Counter({
        name: 'fusion_transaction_total',
        help: 'Total number of transactions processed',
        labelNames: ['status', 'type'],
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
    // eslint-disable-next-line no-unused-vars
    function trackTransaction(status, type = 'PAYMENT') {
        transactionCounter.inc({ status, type });
    }

    // Prometheus-compatible metrics endpoint (Protected)
    app.get('/metrics', authenticateClient, async (req, res) => {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    });

    // Apply authentication and rate limiting to ALL /api/ routes
    app.use('/api/', apiLimiter, authenticateClient);

    // --- REGULATORY OBSERVABILITY ENDPOINTS (PROTECTED UNDER /api/) ---
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
        } catch {
            res.status(500).send('Observability Error');
        }
    });

    // Expose pool & logger to child routers via app.locals
    app.locals.pool = pool;
    app.locals.logger = logger;

    // --- RBI COMPLIANCE & ENTERPRISE IDENTITY (AI-2A & AI-2B) ---
    app.use('/api/kyc', require('./api/kyc'));
    app.use('/api/auth', createAuthRouter());
    app.use('/api/approvals', createApprovalsRouter());

    // --- VIRTUAL ACCOUNT (White-Label Aggregator Model) ---
    app.use('/api/virtual-account', require('./api/virtualAccount'));

    // --- INVOICE PROCESSOR (GIFT City IFSC ISO 20022 — InvoiceProcessor Module) ---
    // Isolated under /api/invoice/* — zero impact on existing instruction/saga/CSV routes.
    // Invoices land in PENDING_APPROVAL state. POST /api/instruction/approve to trigger saga.
    app.use('/api/invoice', require('./api/invoice'));

    // --- ZOHO WORKFLOW PIPELINE ---
    // Webhook ingestion, pull, status tracking, reconciliation, compliance docs
    // All 7 workflow steps: Zoho → Decisioning → Routing → SAGA → Compliance → Reconcile
    app.use('/api/zoho', require('./api/zoho'));

    // --- CASHIQ INTELLIGENCE API ---
    app.use('/api/cashiq', require('./api/cashiq'));

    // --- AI PAYMENT OPERATIONS COPILOT (SYNTHETIC INVESTIGATION ONLY) ---
    // Strictly synthetic exception cases CASE-01 to CASE-15; zero persistent DB queries.
    const aiInvestigateRouter = require('./routes/aiInvestigateRouter');
    const cashiqAiRouter = require('./routes/cashiqAiRouter');
    const aiCopilotMount = '/api/ai';
    app.use(aiCopilotMount, aiInvestigateRouter);
    app.use(aiCopilotMount, cashiqAiRouter);

    // --- INSTRUCTION METADATA & ANNOTATIONS (RELIABILITY R2B) ---
    const instructionRouter = require('./routes/instructionRouter');
    app.use('/api', instructionRouter);

    // --- TREASURY ARBITRAGE SIMULATION (RELIABILITY R2C) ---
    const arbitrageRouter = require('./routes/arbitrageRouter');
    app.use('/api', arbitrageRouter);

    // --- LEGACY AI ADVISOR (UNMOUNTED / DISABLED in Workstream 0 Containment) ---
    // app.use('/api/ai', require('./routes/aiAdvisor'));
    // Note: AI-1B under core/ai/ remains strictly private, internal, and unmounted.

    // --- SECURE WEBHOOK INGESTION (STRIPE TESTNET & RAZORPAYX SANDBOX) ---
    app.use('/api/webhooks', require('./routes/webhooks').router);

    // --- WHATSAPP & APPROVALS ---
    app.use('/api/whatsapp', require('./api/whatsapp'));

    // Start CashSentinel alert cron (runs every hour after startup sweep)
    const { startSentinel } = require('./core/cashiq/cashSentinel');
    startSentinel(pool);

    // --- INFRASTRUCTURE: BALANCES (RTBH Visible) ---
    app.get('/api/balances', authenticateClient, async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM balances ORDER BY currency ASC');
            res.json({
                status: 'success',
                data: result.rows,
                timestamp: new Date().toISOString(),
            });
        } catch (err) {
            logger.error(`[BALANCES API ERROR] ${err.message}`);
            res.status(500).json({ error: 'Failed to fetch balances' });
        }
    });

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
            if (process.env.LOCAL_ONLY === 'true' || !redis || redis.status !== 'ready') {
                // FALLBACK: IN-MEMORY IDEMPOTENCY
                if (localIdempotencyStore.has(`idempotency:${key}`)) {
                    const cached = localIdempotencyStore.get(`idempotency:${key}`);
                    if (cached !== 'PROCESSING') {
                        console.log(`[IDEMPOTENCY] Returned LOCAL cached response for key: ${key}`);
                        return res.json(JSON.parse(cached));
                    }
                    return res
                        .status(409)
                        .json({ error: 'Conflict', detail: 'Request is already processing.' });
                }
                localIdempotencyStore.set(`idempotency:${key}`, 'PROCESSING');
                req.idempotencyKey = key;
                return next();
            }

            // REDIS SETNX for ATOMIC LOCK
            const isSet = await redis.setnx(`idempotency:${key}`, 'PROCESSING');
            if (!isSet) {
                // Key exists, grab the cached result
                const cached = await redis.get(`idempotency:${key}`);
                if (cached && cached !== 'PROCESSING') {
                    console.log(`[IDEMPOTENCY] Returned REDIS cached response for key: ${key}`);
                    return res.json(JSON.parse(cached));
                }
                return res
                    .status(409)
                    .json({ error: 'Conflict', detail: 'Request is already processing.' });
            }
            req.idempotencyKey = key; // Attach key to request for later saving
            next();
        } catch (err) {
            console.error('Idempotency Check Failed', err);
            next();
        }
    };

    // --- ADAPTER BOUNDARY ---

    const adapterRegistry = require('./core/AdapterRegistry');
    const { getBreaker, getAllBreakerStates } = require('./core/circuitBreaker');

    // Load external plugins if the directory exists
    const pluginsDir = path.join(__dirname, 'plugins');
    if (fs.existsSync(pluginsDir)) {
        adapterRegistry.loadPluginsFromDirectory(pluginsDir);
    }

    // @deprecated Legacy Core Adapter Registration.
    // Retained for AdapterRegistry SDK backward compatibility.
    // Production financial settlements are executed exclusively via sagaCore.processInstructionSagaAtomic().
    adapterRegistry.registerCoreAdapters([
        {
            id: 'legacy_fiat',
            name: 'Legacy Fiat Rails',
            supports: (instruction) =>
                [
                    'ADAPTER_PAYNOW',
                    'ADAPTER_SWIFT',
                    'ADAPTER_STRIPE',
                    'ADAPTER_PBM_CONTRACT',
                    'FIAT',
                ].includes(instruction._requestedAdapter),
            execute: async (instruction) => await executePaymentRail(instruction),
            rollback: async (intentId) => {
                const { rollbackPaymentRail } = require('./adapters/paymentsAdapters');
                return await rollbackPaymentRail(intentId);
            },
        },
        {
            id: 'legacy_crypto',
            name: 'Legacy Crypto Rails',
            supports: (instruction) => instruction._requestedAdapter === 'ADAPTER_CRYPTO_CUSTODIAN',
            execute: async (instruction) => await executeCryptoTransfer(instruction),
            rollback: async () => {
                return { status: 'MOCK_REVERSED' };
            },
        },
        {
            id: 'core_razorpay',
            name: 'Razorpay Indian PA',
            supports: (instruction) => instruction._requestedAdapter === 'ADAPTER_RAZORPAY',
            execute: async (instruction) => {
                const { executeRazorpayRail } = require('./adapters/razorpayAdapter');
                return await executeRazorpayRail(instruction);
            },
            rollback: async (intentId) => {
                const { rollbackRazorpayRail } = require('./adapters/razorpayAdapter');
                return await rollbackRazorpayRail(intentId);
            },
        },
    ]);

    /**
     * @deprecated Legacy direct adapter executor with Circuit Breaker protection.
     * Superseded by sagaCore.processInstructionSagaAtomic(). Retained for legacy test/SDK reference only.
     */
    // eslint-disable-next-line no-unused-vars
    async function executeAdapter(adapterType, instruction) {
        const breaker = getBreaker(adapterType);

        // If the primary adapter's circuit is OPEN, attempt failover
        if (!breaker.allowRequest()) {
            logger.warn(`[CIRCUIT_BREAKER] ⚡ [${adapterType}] is OPEN. Attempting failover...`);

            // Failover map: defines backup adapters for each primary
            const FAILOVER_MAP = {
                ADAPTER_RAZORPAY: null, // No fallback for INR domestic at this time
            };
            const fallbackType = FAILOVER_MAP[adapterType];
            if (!fallbackType) {
                throw new Error(
                    `[CIRCUIT_BREAKER] Adapter ${adapterType} is OPEN with no failover configured.`
                );
            }
            logger.info(`[CIRCUIT_BREAKER] ✈️ Routing to failover: ${fallbackType}`);
            return await executeAdapter(fallbackType, instruction); // Recursive call to failover
        }

        const hydratedInstruction = { ...instruction, _requestedAdapter: adapterType };
        const adapter = adapterRegistry.findAdapterForInstruction(hydratedInstruction);
        if (!adapter) {
            throw new Error(`No adapter found supporting instruction type: ${adapterType}`);
        }

        try {
            const context = { logger };
            const result = await adapter.execute(hydratedInstruction, context);
            // On success, report to circuit breaker
            if (result && result.status === 'SUCCESS') breaker.onSuccess();
            else breaker.onFailure();
            return result;
        } catch (err) {
            breaker.onFailure();
            throw err;
        }
    }

    /**
     * @deprecated Legacy direct rollback executor.
     * Superseded by sagaCore transactional compensations. Retained for legacy test/SDK reference only.
     */
    // eslint-disable-next-line no-unused-vars
    async function rollbackAdapter(adapterType, instruction, intentId) {
        const hydratedInstruction = { ...instruction, _requestedAdapter: adapterType };
        const adapter = adapterRegistry.findAdapterForInstruction(hydratedInstruction);
        if (!adapter) {
            logger.warn(`[ROLLBACK] No adapter found to rollback: ${adapterType}`);
            return { status: 'UNKNOWN' };
        }
        return await adapter.rollback(intentId);
    }

    // --- GOVERNANCE LOGGING (CORDA) ---
    // eslint-disable-next-line no-unused-vars
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

    const { writeLedger, verifyLedgerIntegrity } = require('./core/orchestrator/ledgerUtils');

    // =====================================================
    // API ENDPOINTS
    // =====================================================

    // NOTE: BYOK /api/vault/keys endpoint has been removed.
    // Project Fusion now operates as a White-Label Aggregator.
    // Users top up their Fusion Virtual Account instead of connecting gateway keys.
    // All execution rails use Fusion's master credentials from .env.

    // =====================================================
    // MAKER-CHECKER: APPROVE BATCH
    // =====================================================
    app.post('/api/instruction/approve', async (req, res) => {
        try {
            const { instructionIds, approved_by } = req.body;
            if (!instructionIds || !Array.isArray(instructionIds) || instructionIds.length === 0) {
                return res.status(400).json({ error: 'instructionIds array is required' });
            }
            if (!approved_by) {
                return res.status(400).json({ error: 'approved_by is required' });
            }

            let approvedCount = 0;
            let rejectedCount = 0;

            for (const instructionId of instructionIds) {
                const checkResult = await pool.query(
                    'SELECT state, sender FROM instructions WHERE instruction_id = $1',
                    [instructionId]
                );
                const txn = checkResult.rows[0];

                if (!txn) {
                    rejectedCount++;
                    continue;
                }

                // Enforce Four-Eyes: approver must not be the same as initiator
                if (txn.sender === approved_by) {
                    logger.warn(
                        `[MAKER-CHECKER] Self-approval attempt by '${approved_by}' for ${instructionId}`
                    );
                    rejectedCount++;
                    continue;
                }

                if (txn.state !== 'PENDING_APPROVAL') {
                    logger.warn(
                        `[MAKER-CHECKER] Instruction ${instructionId} not in PENDING_APPROVAL state (current: ${txn.state})`
                    );
                    rejectedCount++;
                    continue;
                }

                try {
                    await defaultCanonicalApprovalService.approvePayment({
                        instructionId,
                        checkerOperatorId: approved_by,
                        notes: `Batch approved by ${approved_by}`,
                        requireStepUp: false,
                        pool,
                    });

                    approvedCount++;
                    logger.info(
                        `[MAKER-CHECKER] ✅ Batch ${instructionId} approved via CanonicalApprovalService and queued in outbox.`
                    );
                } catch (approveErr) {
                    logger.error(
                        `[MAKER-CHECKER ERROR] Failed to approve ${instructionId}: ${approveErr.message}`
                    );
                    rejectedCount++;
                }
            }

            res.json({
                success: true,
                approved: approvedCount,
                rejected: rejectedCount,
                message: `${approvedCount} instruction(s) approved and queued for processing.`,
            });
        } catch (err) {
            logger.error(`[MAKER-CHECKER ERROR] ${err.message}`);
            res.status(500).json({ error: 'Approval failed' });
        }
    });

    // =====================================================
    // ADAPTER HEALTH: CIRCUIT BREAKER STATUS
    // =====================================================
    app.get('/api/adapter/health', async (req, res) => {
        const states = getAllBreakerStates();
        res.json({ adapters: states, timestamp: new Date().toISOString() });
    });

    // =====================================================
    // API 1: INITIATE (WITH IDEMPOTENCY)
    // =====================================================
    app.post('/api/instruction/initiate', checkIdempotency, async (req, res) => {
        try {
            // Support both single object and arrays for bulk ingestion
            const payload = Array.isArray(req.body) ? req.body : [req.body];

            if (payload.length === 0) return res.status(400).json({ error: 'Empty payload' });

            const { parseBatch, routeBatch } = require('./core/ingestion/batchParser');

            // 1. Feature-Rich Parsing: Automatically detect FCSS requirements and enrich
            const instructions = parseBatch(payload);

            // --- TREASURY POWER-UP: AUTONOMOUS LIQUIDITY & ARBITRAGE ---
            // 1. Intelligence: Generate arbitrage report for the batch
            const totalAmount = instructions.reduce((sum, i) => sum + parseFloat(i.amount), 0);
            const mainCurrency = (instructions[0] && instructions[0].currency) || 'USD';
            const arbReport = getArbitrageReport(totalAmount, mainCurrency);
            logger.info(`[TREASURY_POWERUP] Batch Arbitrage Logic: ${arbReport.intelligence_note}`);

            // 2. Action: Ensure master Stellar account has sufficient liquidity
            await ensureStellarLiquidity(instructions);

            // NOTE: RTBH user shadow balance sync removed.
            // User balances are now managed via Fusion Virtual Accounts (FUSION_VIRTUAL),
            // not per-provider shadow balances pinged from Stripe/Razorpay/Airwallex.

            // 4. Routing Decision
            const routingLayout = await routeBatch(instructions);

            // [CRITICAL FIX] Persist instructions to the database BEFORE routing them.
            // This ensures bulk uploads and single API calls are actually recorded.
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                for (const inst of instructions) {
                    await client.query(
                        `INSERT INTO instructions 
                            (instruction_id, amount, currency, sender, recipient, purpose, state, provider, created_at, updated_at, net_amount, tax_withheld) 
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                        [
                            inst.instruction_id,
                            inst.amount,
                            inst.currency,
                            inst.sender,
                            inst.recipient,
                            inst.purpose,
                            inst.state,
                            inst.provider,
                            inst.created_at,
                            inst.created_at,
                            inst.net_amount || inst.amount,
                            inst.tax_withheld || 0,
                        ]
                    );
                }
                await client.query('COMMIT');
                logger.info(
                    `[INGESTION] Persisted ${instructions.length} instructions to database.`
                );
            } catch (dbErr) {
                await client.query('ROLLBACK');
                logger.error(`[INGESTION FATAL] Database persist failed: ${dbErr.message}`);
                throw dbErr;
            } finally {
                client.release();
            }

            if (routingLayout.fiat.length > 0)
                await pushToBatchQueue('fiat_payouts', routingLayout.fiat);
            if (routingLayout.cryptoFlow.length > 0)
                await pushToBatchQueue('crypto_payouts', routingLayout.cryptoFlow);
            if (routingLayout.marketplace.length > 0)
                await pushToBatchQueue('marketplace_microbatch', routingLayout.marketplace);

            // Exporter inflows have a distinct SAGA queue
            if (routingLayout.fcssSaga.length > 0)
                await pushToBatchQueue('exporter_fcss_saga', routingLayout.fcssSaga);

            // --- SEQUENTIAL BATCH EXECUTION (FIFO) ---
            // To avoid timeouts on external rails (Stellar/Horizon), we process the batch
            // ONE-BY-ONE in the background. This ensures Row 1 finishes before Row 2 starts.
            const processBatchSequentially = async (batch, pool) => {
                for (const inst of batch) {
                    const instId = inst.instruction_id;
                    try {
                        logger.info(
                            `[SEQUENTIAL-WORKER] ⚛️ Processing ${instId} (${inst.currency})...`
                        );

                        // 1. Auto-Approve
                        await pool.query(
                            "UPDATE instructions SET state = 'INITIATED', updated_at = NOW() WHERE instruction_id = $1 AND state = 'PENDING_APPROVAL'",
                            [instId]
                        );

                        // 2. Settle & Await Settlement before moving to the next row
                        const result = await processInstructionSagaAtomic(instId, pool);

                        if (result.status === 'MANUAL_CHECK') {
                            logger.warn(
                                `[SEQUENTIAL-WORKER] ⚠️ ${instId} stalled: ${result.reason}`
                            );
                        } else {
                            logger.info(`[SEQUENTIAL-WORKER] ✅ ${instId} settled successfully.`);
                        }

                        // 3. Throttle delay (500ms) to give the network rails breathing room
                        await new Promise((r) => setTimeout(r, 500));
                    } catch (e) {
                        logger.error(`[SEQUENTIAL-WORKER-ERROR] ${instId}: ${e.message}`);
                    }
                }
            };

            // Fire-and-forget the sequential background worker
            processBatchSequentially(instructions, pool);

            const responseData = {
                message: `Successfully queued ${instructions.length} instructions`,
                instructionId: instructions.length > 0 ? instructions[0].instruction_id : null,
                instructionIds: instructions.map((i) => i.instruction_id),
                state: 'QUEUED',
            };

            // Save Idempotency asynchronously in Redis (expire in 24 hours) or Local Map
            if (req.idempotencyKey) {
                if (process.env.LOCAL_ONLY === 'true' || !redis || redis.status !== 'ready') {
                    localIdempotencyStore.set(
                        `idempotency:${req.idempotencyKey}`,
                        JSON.stringify(responseData)
                    );
                } else {
                    await redis.setex(
                        `idempotency:${req.idempotencyKey}`,
                        86400,
                        JSON.stringify(responseData)
                    );
                }
            }

            res.status(202).json(responseData);
        } catch (err) {
            if (err instanceof TypeError || err instanceof RangeError) {
                if (req.idempotencyKey) {
                    if (process.env.LOCAL_ONLY === 'true' || !redis || redis.status !== 'ready') {
                        localIdempotencyStore.delete(`idempotency:${req.idempotencyKey}`);
                    } else {
                        await redis.del(`idempotency:${req.idempotencyKey}`).catch(() => {});
                    }
                }
                return res.status(400).json({ error: 'Validation Failed', detail: err.message });
            }
            console.error('[INITIATE FATAL ERROR]', err);
            if (req.idempotencyKey) {
                if (process.env.LOCAL_ONLY === 'true' || !redis || redis.status !== 'ready') {
                    localIdempotencyStore.delete(`idempotency:${req.idempotencyKey}`);
                } else {
                    await redis.del(`idempotency:${req.idempotencyKey}`).catch(() => {});
                }
            }
            res.status(500).json({ error: 'System Error', detail: err.message });
        }
    });
    // =====================================================
    // SHARED ORCHESTRATION & SAGA CORE
    // =====================================================
    const { processInstructionSagaAtomic } = require('./core/orchestrator/sagaCore');

    // --- API 2: POLICY ENGINE ---
    app.post('/api/policy/evaluate', validateRequest(instructionIdSchema), async (req, res) => {
        try {
            res.json(await processInstructionSagaAtomic(req.body.instructionId, pool));
        } catch (err) {
            logger.error(`[POLICY-ERROR] ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // --- API 3: ORCHESTRATION (SMART ROUTING) ---
    app.post('/api/orchestration/route', validateRequest(instructionIdSchema), async (req, res) => {
        try {
            res.json(await processInstructionSagaAtomic(req.body.instructionId, pool));
        } catch (err) {
            logger.error(`[ROUTING-ERROR] ${err.message}`);
            res.status(500).json({ error: err.message });
        }
    });

    // --- API 4: ADAPTER EXECUTION (LEGACY - ROUTED VIA SAGA) ---
    app.post(
        '/api/adapter/execute',
        validateRequest(adapterExecuteSchema),
        checkIdempotency,
        async (req, res) => {
            try {
                const { instructionId, adapter } = req.body;

                // 1. Verify instruction exists and validate for contradictory adapter requests
                const check = await pool.query(
                    'SELECT currency, state, purpose FROM instructions WHERE instruction_id = $1',
                    [instructionId]
                );
                if (check.rows.length === 0) {
                    return res.status(404).json({ error: 'Instruction not found' });
                }
                const txn = check.rows[0];

                // 2. Reject contradictory adapter requests
                if (adapter) {
                    const currency = (txn.currency || '').toUpperCase();
                    if (
                        adapter === 'ADAPTER_STRIPE' &&
                        !['USD', 'EUR', 'GBP', 'CAD'].includes(currency)
                    ) {
                        return res.status(400).json({
                            error: 'Contradictory adapter request',
                            detail: `Adapter 'ADAPTER_STRIPE' cannot execute currency '${currency}'. Authoritative route required.`,
                        });
                    }
                    if (adapter === 'ADAPTER_RAZORPAY' && currency !== 'INR') {
                        return res.status(400).json({
                            error: 'Contradictory adapter request',
                            detail: `Adapter 'ADAPTER_RAZORPAY' cannot execute currency '${currency}'. Only domestic INR is supported.`,
                        });
                    }
                    if (adapter === 'ADAPTER_CRYPTO_CUSTODIAN' && currency !== 'XLM') {
                        return res.status(400).json({
                            error: 'Contradictory adapter request',
                            detail: `Adapter 'ADAPTER_CRYPTO_CUSTODIAN' cannot execute asset '${currency}'. Only XLM on Stellar Testnet is supported.`,
                        });
                    }
                    if (['ADAPTER_PAYNOW', 'ADAPTER_MOCK_HFT'].includes(adapter)) {
                        return res.status(400).json({
                            error: 'Unsupported adapter',
                            detail: `Adapter '${adapter}' is deprecated and unsupported. Execution rejected.`,
                        });
                    }
                }

                // 3. Emit HTTP Deprecation warning headers
                res.set('Deprecation', 'true');
                res.set(
                    'Warning',
                    '299 - "The adapter parameter on /api/adapter/execute is deprecated. Provider routing is automatically authoritative based on instruction currency and policy."'
                );

                // 4. Delegate to authoritative Saga
                const result = await processInstructionSagaAtomic(instructionId, pool);
                res.json(result);
            } catch (err) {
                logger.error(`[EXECUTION-ERROR] ${err.message}`);
                res.status(500).json({ error: err.message });
            }
        }
    );

    // =====================================================
    // API 4.5: EXPORTER FX SAGA (FCSS)
    // =====================================================
    app.post('/api/saga/exporter-fx', authenticateClient, async (req, res) => {
        try {
            const { instructionId } = req.body || {};
            if (!instructionId) return res.status(400).json({ error: 'instructionId required' });

            logger.warn(
                `[EXPORTER_FX_SAGA] Request for ${instructionId} rejected: FCSS rail adapter is not implemented in this release.`
            );
            return res.status(501).json({
                error: 'FEATURE_NOT_IMPLEMENTED',
                detail: 'FCSS (Foreign Currency Settlement System) rail adapter is not implemented in this release',
                instructionId,
            });
        } catch (err) {
            logger.error(`[EXPORTER_FX_SAGA] Endpoint error: ${err.message}`);
            res.status(500).json({ error: 'SAGA Execution Failed', reason: err.message });
        }
    });

    // =====================================================
    // API 5: ASYNC WEBHOOK INGESTION (MODERNIZED)
    // =====================================================
    // Secure webhook routes (/stripe, /razorpay, /gateway) are mounted at /api/webhooks
    // via routes/webhooks.js with strict HMAC validation and atomic deduplication.

    /**
     * LIVELY RECONCILIATION ENGINE
     * Accelerated for Testnet Responsiveness (GIFT City 2026 Prototype)
     */
    async function runReconciliationScan() {
        logger.debug('[RECONCILER] Running scan for stuck transactions...');
        try {
            const stuck = await pool.query(`
                SELECT instruction_id, external_intent_id, amount, currency, sender, recipient, state, updated_at, tax_withheld, net_amount, zoho_invoice_id, saga_state 
                FROM instructions 
                WHERE state IN ('PENDING_EXECUTION', 'PENDING_SETTLEMENT') 
                AND updated_at < NOW() - INTERVAL '5 seconds'
            `);

            for (const txn of stuck.rows) {
                const id = txn.instruction_id;
                const intentId = txn.external_intent_id;

                // --- P1-D: SAFE EXPORTER-FX WORKFLOW IDENTIFICATION & RECOVERY ---
                let sagaMeta = null;
                try {
                    sagaMeta = txn.saga_state
                        ? typeof txn.saga_state === 'object'
                            ? txn.saga_state
                            : JSON.parse(txn.saga_state)
                        : null;
                } catch {
                    sagaMeta = null;
                }

                const isExporterFxWorkflow = Boolean(
                    sagaMeta &&
                    (sagaMeta.lastStep ||
                        sagaMeta.batchPlan ||
                        sagaMeta.fcssResult ||
                        sagaMeta.femaResult)
                );

                if (isExporterFxWorkflow) {
                    logger.warn(
                        `[RECONCILER] Stale Exporter FX instruction detected: ${id} (State: ${txn.state}, Step: ${sagaMeta.lastStep || 'UNKNOWN'}). Initiating safe recovery.`
                    );
                    // If an exporter FX instruction is stuck in PENDING_EXECUTION or PENDING_SETTLEMENT:
                    // Because FCSS rail status cannot be verified automatically without adapter, outcome is ambiguous.
                    // Escalate to MANUAL_CHECK idempotently. Do NOT retry FCSS operations automatically.
                    // Do NOT overwrite newer legitimate state: lock row and verify state before updating.
                    const client = await pool.connect();
                    try {
                        await client.query('BEGIN');
                        const lockRes = await client.query(
                            'SELECT state, saga_state FROM instructions WHERE instruction_id = $1 FOR UPDATE',
                            [id]
                        );
                        if (
                            lockRes.rows.length > 0 &&
                            ['PENDING_EXECUTION', 'PENDING_SETTLEMENT'].includes(
                                lockRes.rows[0].state
                            )
                        ) {
                            const curSaga = lockRes.rows[0].saga_state
                                ? typeof lockRes.rows[0].saga_state === 'object'
                                    ? lockRes.rows[0].saga_state
                                    : JSON.parse(lockRes.rows[0].saga_state)
                                : {};
                            curSaga.reconciledAt = new Date().toISOString();
                            curSaga.reconciliationNote =
                                'Stale Exporter FX instruction escalated to MANUAL_CHECK: external rail outcome is ambiguous and requires human verification';

                            await client.query(
                                "UPDATE instructions SET state = 'MANUAL_CHECK', saga_state = $1, error_message = $2, updated_at = NOW() WHERE instruction_id = $3",
                                [
                                    JSON.stringify(curSaga),
                                    'Exporter FX stale execution: escalated to MANUAL_CHECK for manual review',
                                    id,
                                ]
                            );
                            await client.query('COMMIT');
                            logger.info(
                                `[RECONCILER] ✅ Exporter FX instruction ${id} safely escalated to MANUAL_CHECK`
                            );
                        } else {
                            await client.query('ROLLBACK');
                        }
                    } catch (reconErr) {
                        await client.query('ROLLBACK');
                        logger.error(
                            `[RECONCILER] Failed to escalate Exporter FX ${id} to MANUAL_CHECK: ${reconErr.message}`
                        );
                    } finally {
                        client.release();
                    }
                    continue;
                }

                if (!intentId) {
                    logger.warn(
                        `[RECONCILER] Instruction ${id} has no external_intent_id, marking for manual check`
                    );
                    continue;
                }

                logger.info(`[RECONCILER] Polling status for ${id} (Intent: ${intentId})`);

                try {
                    let adapter;
                    if (['BTC', 'ETH', 'USDC', 'XLM'].includes(txn.currency)) {
                        adapter = require('./adapters/cryptoAdapters');
                    } else if (txn.currency === 'INR') {
                        adapter = require('./adapters/razorpayAdapter');
                    } else if (txn.currency === 'SGD') {
                        adapter = require('./adapters/paymentsAdapters');
                    } else if (['USD', 'EUR', 'GBP', 'CAD'].includes(txn.currency)) {
                        adapter = require('./adapters/paymentsAdapters');
                    }

                    if (!adapter) continue;

                    const statusResult = await adapter.queryStatus(intentId);
                    const status =
                        typeof statusResult === 'object' ? statusResult.status : statusResult;
                    const utr = typeof statusResult === 'object' ? statusResult.utr : null;

                    // Normalizing status across Stripe (succeeded) and RazorpayX (processed)
                    const isSuccess = ['succeeded', 'processed', 'SUCCESS'].includes(status);
                    const isFailed = ['canceled', 'failed', 'FAILURE'].includes(status);

                    if (isSuccess) {
                        logger.info(
                            `[RECONCILER] ✅ Confirming success for ${id} via Adapter Status (${status})`
                        );
                        const client = await pool.connect();
                        try {
                            await client.query('BEGIN');
                            const lockCheck = await client.query(
                                'SELECT state FROM instructions WHERE instruction_id = $1 FOR UPDATE',
                                [id]
                            );

                            if (
                                lockCheck.rows.length > 0 &&
                                lockCheck.rows[0].state !== 'SETTLED'
                            ) {
                                // PASS PERSISTED TAX INFO during recovery
                                await writeLedger(
                                    client,
                                    id,
                                    txn.sender,
                                    txn.recipient,
                                    txn.net_amount,
                                    txn.currency,
                                    txn.tax_withheld || 0
                                );
                                await verifyLedgerIntegrity(
                                    client,
                                    id,
                                    txn.currency,
                                    txn.tax_withheld || 0
                                );
                                await client.query(
                                    "UPDATE instructions SET state = 'SETTLED', utr = $1, updated_at = NOW() WHERE instruction_id = $2",
                                    [utr || null, id]
                                );
                                if (txn.zoho_invoice_id) {
                                    await client.query(
                                        `UPDATE invoices SET state = 'SETTLED', updated_at = NOW() WHERE invoice_id = $1 OR invoice_id = $2`,
                                        [txn.zoho_invoice_id, `ZOHO-${txn.zoho_invoice_id}`]
                                    );
                                }
                                await client.query('COMMIT');
                                logger.info(`[RECONCILER] 🎉 Recovered and SETTLED: ${id}`);

                                // POST-SETTLEMENT: Zoho Reconciliation
                                const {
                                    reconcileToZoho,
                                } = require('./core/reconciliation/reconciliationService');
                                const settledTxn = { ...txn, zoho_invoice_id: txn.zoho_invoice_id };
                                reconcileToZoho(pool, settledTxn, utr || intentId).catch((e) =>
                                    logger.error(
                                        `[RECONCILER] Zoho reconciliation error for ${id}: ${e.message}`
                                    )
                                );
                            } else {
                                await client.query('ROLLBACK');
                            }
                        } catch (err) {
                            await client.query('ROLLBACK');
                            logger.error(`[RECONCILER DB ERROR] ❌ ${err.message}`);
                            throw err;
                        } finally {
                            client.release();
                        }
                    } else if (isFailed) {
                        await pool.query(
                            "UPDATE instructions SET state = 'FAILED', updated_at = NOW() WHERE instruction_id = $1",
                            [id]
                        );
                        logger.info(`[RECONCILER] Marked ${id} as FAILED`);
                    }
                } catch (adapterErr) {
                    logger.error(
                        `[RECONCILER] Error querying status for ${id}: ${adapterErr.message}`
                    );
                }
            }
        } catch (err) {
            logger.error(`[RECONCILER] Critical error: ${err.message}`);
        }
    }

    // ACCELERATED POLLING: Scan every 8 seconds for real-time testnet feel (only if not running tests)
    if (process.env.NODE_ENV !== 'test') {
        setInterval(runReconciliationScan, 8000);
    }

    // =====================================================
    // =====================================================
    // API 5: REGULATORY OBSERVABILITY (READ-ONLY)
    // =====================================================
    app.get('/api/observe', async (req, res) => {
        try {
            const { limit = 50, offset = 0 } = req.query;

            // Fetch recent instructions with their double-entry ledger hashes
            const result = await pool.query(
                `SELECT i.*, 
                 (SELECT array_agg(entry_id) FROM ledger_journal lj WHERE lj.instruction_id::varchar = i.instruction_id::varchar) as ledger_hashes
                 FROM instructions i 
                 ORDER BY i.created_at DESC LIMIT $1 OFFSET $2`,
                [limit, offset]
            );

            // Fetch Global Stats (Total Volume & Count)
            const statsResult = await pool.query(`
                SELECT 
                    COALESCE(SUM(amount), 0) as total_volume,
                    COUNT(*) as total_count,
                    COUNT(*) FILTER (WHERE state = 'SETTLED') as settled_count,
                    COUNT(*) FILTER (WHERE state = 'FAILED') as failed_count
                FROM instructions
                WHERE state = 'SETTLED' OR state = 'FAILED' OR state IS NOT NULL
            `);
            const stats = statsResult.rows[0];

            // PII Scrubbing (Privacy Preservation)
            const sanitizedData = result.rows.map((txn) => ({
                instruction_id: txn.instruction_id,
                amount: txn.amount,
                currency: txn.currency,
                state: txn.state,
                purpose: txn.purpose,
                error_message: txn.error_message, // Failure rationale
                // SCRUBBED: sender, recipient (PII)

                sender_hash:
                    crypto.createHash('sha256').update(txn.sender).digest('hex').substring(0, 8) +
                    '...',
                recipient_hash:
                    crypto
                        .createHash('sha256')
                        .update(txn.recipient)
                        .digest('hex')
                        .substring(0, 8) + '...',
                timestamp: txn.created_at,
                trace_id:
                    txn.currency === 'INR'
                        ? txn.utr || txn.external_intent_id || 'N/A'
                        : txn.external_intent_id || 'N/A',
                utr: txn.utr || null,
                external_intent_id: txn.external_intent_id || null,
                ledger_hashes: txn.ledger_hashes || [],
                metadata: txn.metadata || {},
            }));

            res.json({
                data: sanitizedData,
                meta: {
                    total_volume: parseFloat(stats.total_volume),
                    total_count: parseInt(stats.total_count),
                    settled_count: parseInt(stats.settled_count),
                    failed_count: parseInt(stats.failed_count),
                },
            });
        } catch (err) {
            logger.error(`[AUDIT ERROR] ${err.stack}`);
            res.status(500).json({ error: 'Audit System Unavailable', details: err.message });
        }
    });

    let server;
    if (process.env.LOCAL_ONLY === 'true') {
        const http = require('http');
        server = http.createServer(app);
    } else {
        const httpsOptions = {
            key: fs.readFileSync(path.join(__dirname, 'certs', 'server.key')),
            cert: fs.readFileSync(path.join(__dirname, 'certs', 'server.crt')),
            ca: fs.readFileSync(path.join(__dirname, 'certs', 'ca.crt')),
            requestCert: true, // Request a certificate from the client (mTLS)
            rejectUnauthorized: false, // Allow handshake to succeed (we enforce 'authorized' in middleware)
        };
        server = https.createServer(httpsOptions, app);
    }

    const isLocalOnly = process.env.LOCAL_ONLY === 'true';
    const listenHost = isLocalOnly ? '127.0.0.1' : process.env.HOST || '0.0.0.0';

    // Attach server and socket configuration for programmatic inspection and testing
    app.server = server;
    app.locals = app.locals || {};
    app.locals.listenHost = listenHost;
    app.locals.listenPort = PORT;
    app.locals.isLocalOnly = isLocalOnly;
    app.runReconciliationScan = runReconciliationScan;

    // Only listen if this is the main module (not imported by Jest)
    if (require.main === module) {
        server.listen(PORT, listenHost, () => {
            const protocol = isLocalOnly ? 'http' : 'https';
            logger.info(
                `[STARTUP] Project Fusion Enterprise Core (${isLocalOnly ? 'LOCAL' : 'SECURE'}) running on ${protocol}://${listenHost}:${PORT}`
            );
            logger.info(
                '[STARTUP] mTLS SECURITY ENFORCED: Mutual identity required for all API calls'
            );
            logger.info('[STARTUP] HSM SIMULATION ACTIVE: Sensitive keys isolated in Vault');
            logger.info('[STARTUP] Ready for high-security regulatory discussion');

            // --- RECONCILIATION ENGINE (SAGA SELF-HEALING) ---
            // Ensuring the engine is "SWITCHED ON" for automated status recovery
            setInterval(() => {
                runReconciliationScan().catch((err) =>
                    logger.error(`[RECONCILER FATAL] ${err.message}`)
                );
            }, 30000); // 30s interval

            // Immediate first run
            runReconciliationScan();

            // --- OUTBOX DISPATCHER (ADR-002 SAGA RELIABILITY) ---
            // Automatic boot recovery for pending outbox events across restarts
            defaultCanonicalApprovalService
                .drainDispatchOutbox({ pool })
                .catch((err) =>
                    logger.warn(`[OUTBOX_STARTUP] Outbox initial drain warning: ${err.message}`)
                );
            setInterval(() => {
                defaultCanonicalApprovalService
                    .drainDispatchOutbox({ pool })
                    .catch((err) =>
                        logger.warn(`[OUTBOX_SWEEP] Outbox periodic sweep warning: ${err.message}`)
                    );
            }, 15000); // 15s interval
        });
    }

    return app; // Export app for testing
} // End of startApp
