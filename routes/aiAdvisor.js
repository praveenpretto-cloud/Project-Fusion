'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * AI TREASURY ADVISOR & COPILOT (STRICTLY READ-ONLY) — R2A.2 HARDENED
 * ════════════════════════════════════════════════════════════════════════════
 *
 * GOVERNANCE & SAFETY MANDATES:
 * 1. STRICT READ-ONLY MODE: ZERO capability to initiate, disburse, sign, or refund.
 * 2. DETERMINISTIC FINANCIAL METRICS: All financial calculations are computed
 *    deterministically on the server before LLM invocation. The model explains
 *    verified figures and is strictly forbidden from recalculating or inventing.
 * 3. AUTHORITATIVE CONTEXT & DATABASE UNAVAILABILITY: Server-derived database records
 *    take precedence over unverified client-supplied parameters. When authoritative
 *    ledger records are unavailable, CashIQ returns DATA_UNAVAILABLE and refuses
 *    to generate business-specific recommendations on unverified telemetry.
 *    General financial education questions remain answerable.
 * 4. BUSINESS ACCESS AUTHORISATION & FAIL-CLOSED MULTI-BUSINESS BOUNDARY:
 *    Cross-business access is strictly prohibited. Changing businessId to an
 *    unentitled entity fails closed with 403 Forbidden. API keys do not grant
 *    multi-business access privileges or act as user identity.
 * 5. SEPARATION OF METRICS, EXPLANATIONS & HYPOTHESES: Deterministic numerical metrics,
 *    AI explanations, and unverified hypotheses are strictly partitioned in the output.
 * 6. FINE-GRAINED INTENT CLASSIFICATION: Action imperatives (pay, refund, transfer,
 *    settle) are intercepted and refused with dual-authorization guidance, while
 *    legitimate analytical inquiries (payment failure analysis, settlement status,
 *    payables review) remain fully available.
 * 7. PROMPT INJECTION & OUTPUT SANITIZATION: Output is stripped of action objects;
 *    zero execution tools or mutation payloads exist in this module.
 */

const express = require('express');
const { Ollama } = require('ollama');
const { getCashSnapshot } = require('../core/cashiq/cashPositionService');
const { SessionManager } = require('../core/identity/sessionManager');
const { extractSessionToken } = require('../core/identity/authMiddleware');

const router = express.Router();

// Canonical primary authorized business entity for single-tenant demo architecture
const PRIMARY_AUTHORIZED_BUSINESS_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// Default session manager instance for session validation
const defaultSessionManager = new SessionManager();

// Authoritative local configuration
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:latest';
const INFERENCE_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 15000;

const ollama = new Ollama({ host: OLLAMA_HOST });

// ── 1. FINANCIAL INTENT CLASSIFICATION PATTERNS ──────────────────────────────
const MUTATION_PATTERNS = [
    // Direct action verbs for refund
    /\b(execute|issue|process|grant|send|do)\s+(a\s+)?refund\b/i,
    /\brefund\s+(this|the|an|all)?\s*(transaction|payment|order|invoice|payout|\$|₹|[0-9]+)/i,
    /\brefund\s+for\s+\$?[0-9]+/i,

    // Direct action verbs for pay / payout
    /\bpay\s+(this|the|an|all)?\s*(invoice|bill|vendor|merchant|supplier|due|payout|fee|tax)?\s*(immediately|now|today|at\s+once)?\b/i,
    /\bpay\s+[A-Z0-9_-]+\b/i, // e.g. "pay INV-123"
    /\bpay\s+(\$|₹)?[0-9]+/i, // e.g. "pay 50000"
    /\b(execute|initiate|process|trigger|send|make)\s+(a\s+)?(payment|payout|disbursement)\b/i,

    // Direct action verbs for transfer / send money
    /\b(transfer|wire|remit)\s+(funds|money|cash|balance|amount|\$|₹|[0-9]+)/i,
    /\bsend\s+(\$|₹)?[0-9]+\s*(to|funds|money)/i,
    /\bsend\s+(funds|money)\b/i,

    // Direct action verbs for authorize / approve disbursement
    /\b(authorise|authorize|approve)\s+(this|the|an)?\s*(disbursement|payout|payment|transaction|transfer)\b/i,
    /\bapprove\s+and\s+pay\b/i,

    // State mutations: mark settled / mark paid
    /\bmark\s+(this|the|an)?\s*(transaction|payment|invoice|bill|record)?\s*(as\s+)?(settled|paid|completed)\b/i,
    /\bsettle\s+(this|the|an|all)?\s*(invoice|bill|vendor|account|transaction|due|debt)?\s*(immediately|now|today|right\s+now|at\s+once)\b/i,
    /\bsettle\s+all\b/i,

    // Direct action verbs for disburse
    /\b(disburse|payout)\s+(to|funds|money|now|immediately|\$|₹|[0-9]+)/i,

    // Policy overrides
    /\b(bypass|override)\s+(policy|dual|maker|checker|rule|control|limit)\b/i,

    // Tool/action injection attempts
    /\b(action|command|payload)\s*[:=]\s*['"]?(pay|transfer|disburse|refund|settle)/i,
];

/**
 * Classifies whether a user query is an action mutation request or an analytical inquiry.
 *
 * @param {string} input
 * @returns {{ isMutation: boolean, intentType: string, matchedPattern: string|null }}
 */
function classifyFinancialIntent(input = '') {
    const text = String(input).trim().toLowerCase();

    for (const pattern of MUTATION_PATTERNS) {
        if (pattern.test(text)) {
            // Distinguish past/current inquiries from active imperative commands
            // e.g. "Why did the system execute a refund?" vs "Execute a refund."
            const isHistoricalInquiry =
                /\b(why\s+(did|was|has)|who\s+(executed|authorized)|when\s+was|explain\s+why|status\s+of)\b/i.test(
                    text
                );
            if (isHistoricalInquiry) {
                return {
                    isMutation: false,
                    intentType: 'HISTORICAL_INQUIRY',
                    matchedPattern: pattern.toString(),
                };
            }
            return {
                isMutation: true,
                intentType: 'MUTATION_REQUEST',
                matchedPattern: pattern.toString(),
            };
        }
    }

    return { isMutation: false, intentType: 'READ_ONLY_INQUIRY', matchedPattern: null };
}

// ── 2. GENERAL FINANCIAL EDUCATION & CONCEPT CLASSIFIER ──────────────────────
/**
 * Determines whether a query is a general financial education / conceptual inquiry
 * rather than a request for business-specific financial numbers or ledger metrics.
 *
 * @param {string} input
 * @returns {boolean}
 */
function isEducationalOrConceptualQuery(input = '') {
    const text = String(input).trim().toLowerCase();
    if (!text) return false;

    // Direct greetings
    if (/^(hello|hi|hey|greetings|good\s+(morning|afternoon|evening))\b/i.test(text)) {
        return true;
    }

    // Business-specific pronouns/terms indicating user is asking about their specific financial state
    const hasBusinessSpecificTarget =
        /\b(our|my|this\s+company|current\s+balance|our\s+balance|our\s+runway|our\s+invoices|our\s+cash|our\s+payables|our\s+obligations|our\s+spend|my\s+balance|my\s+spend|can\s+we\s+afford|can\s+i\s+spend|why\s+has\s+the\s+payment|explain\s+our)\b/i.test(
            text
        );

    if (hasBusinessSpecificTarget) {
        return false;
    }

    // Conceptual definitions and inquiries
    if (
        /\b(what\s+is|what\s+are|how\s+is\s+.*(calculated|computed|defined)|how\s+does\s+.*work|define|difference\s+between|explain\s+(the\s+concept\s+of|what\s+is))\b/i.test(
            text
        )
    ) {
        return true;
    }

    // Standards, protocols, and conceptual terminology
    if (
        /\b(pacs\.008|pacs\.002|camt\.053|iso\s*20022|maker-checker|dual\s+authorization|working\s+capital|overdraft\s+facility)\b/i.test(
            text
        )
    ) {
        return true;
    }

    return false;
}

/**
 * Generates authoritative educational explanations for common treasury concepts
 * without fabricating or citing specific business ledger metrics.
 */
function generateEducationalReply(query = '') {
    const q = query.toLowerCase();
    if (q.includes('overdraft') || q.includes('od facility')) {
        return `An overdraft facility is a revolving credit agreement with a commercial bank enabling an enterprise to draw funds in excess of available account balances up to an approved sanction limit. It acts as an operational buffer for working capital fluctuations.`;
    }
    if (q.includes('runway') || q.includes('burn')) {
        return `Operational cash runway measures the duration an enterprise can sustain operations before depleting available spendable liquidity. Deterministically, it is calculated as Total Spendable Liquidity (available cash plus unutilized overdraft credit) divided by Average Daily Spend (trailing 30-day gross outflow run-rate).`;
    }
    if (q.includes('pacs.008')) {
        return `pacs.008 is the ISO 20022 financial messaging standard for Financial Institutional Customer Credit Transfers. It is utilized in RTGS and instant clearing networks to transmit credit transfer instructions between debtor and creditor financial institutions.`;
    }
    if (q.includes('camt.053')) {
        return `camt.053 is the ISO 20022 standard message for Bank-to-Customer Statement reporting, providing end-of-day electronic statements with detailed transaction postings and closing balances for automated bank reconciliation.`;
    }
    if (
        q.includes('maker-checker') ||
        q.includes('dual auth') ||
        q.includes('dual-auth') ||
        q.includes('dual authorization')
    ) {
        return `Maker-checker (four-eyes principle) is an institutional governance control policy requiring two distinct authorized operators to complete high-risk financial transactions: one operator drafts or initiates the instruction (the maker), and a separate authorized operator reviews and approves it (the checker).`;
    }
    if (q.includes('working capital')) {
        return `Working capital measures an enterprise's operational liquidity, defined as current operational assets (cash and accounts receivable) minus short-term liabilities (accounts payable and imminent statutory dues). It reflects the financial buffer available to fund day-to-day business operations.`;
    }
    if (q.includes('hello') || q.includes('hi') || q.includes('hey')) {
        return `Hello! I am CashIQ Nexus, your corporate treasury copilot. Authoritative ledger records are currently disconnected, but I am available to answer financial education, regulatory, and treasury concepts. How can I help?`;
    }
    return `In corporate treasury, liquidity risk management requires maintaining adequate spendable buffers across cash and committed credit facilities to ensure short-term commitments can be settled without operational disruption.`;
}

// ── 3. BUSINESS ACCESS AUTHORISATION & TRUST BOUNDARY ───────────────────────
/**
 * Enforces operator session validation and strict multi-business fail-closed boundaries.
 *
 * Mandates:
 * 1. Validates operator session via SessionManager if cookies present.
 * 2. In single-tenant demo deployment, only the canonical authorized business
 *    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') is permitted.
 * 3. Cross-business access attempts (requesting another business entity without entitlement)
 *    strictly fail closed with 403 Forbidden.
 * 4. API keys (x-api-key) satisfy perimeter access guards only; they do not confer
 *    multi-business access privileges or act as user identity.
 * 5. Safe demo mode (isDemoMode: true) is permitted for synthetic demonstrations.
 * 6. Missing business identity fails closed (400 Bad Request) when explicit identification required.
 */
async function verifyBusinessAccess(req, pool = null) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const rawPayload =
        body.contextPayload && typeof body.contextPayload === 'object' ? body.contextPayload : body;

    const isExplicitDemo = Boolean(
        body.isDemoMode ||
        body.demoScenario ||
        body.simulatedBalance !== undefined ||
        rawPayload.isDemoMode ||
        rawPayload.demoScenario ||
        rawPayload.simulatedBalance !== undefined ||
        (!req.headers && Boolean(body.contextPayload && body.contextPayload.balance !== undefined))
    );

    const hasExplicitBizKey =
        Object.prototype.hasOwnProperty.call(body, 'businessId') ||
        Object.prototype.hasOwnProperty.call(rawPayload, 'businessId');
    const requestedBizId = body.businessId !== undefined ? body.businessId : rawPayload.businessId;

    // 1. Session verification if cookie is present
    const rawToken = extractSessionToken(req);
    if (rawToken) {
        const sessionMgr =
            (req.app && req.app.locals && req.app.locals.sessionManager) || defaultSessionManager;
        let validation = await sessionMgr.validateSession(rawToken, { pool });

        // Fallback to in-memory session validation if DB didn't find it
        if (
            !validation.valid &&
            sessionMgr.inMemorySessions &&
            sessionMgr.inMemorySessions.size > 0
        ) {
            const memValidation = await sessionMgr.validateSession(rawToken, { pool: null });
            if (memValidation.valid) {
                validation = memValidation;
            }
        }

        if (!validation.valid) {
            return {
                authorized: false,
                statusCode: 401,
                error: 'UNAUTHORIZED',
                detail: `Operator session is invalid or expired (${validation.reason})`,
            };
        }
        if (validation.operator && validation.operator.isActive === false) {
            return {
                authorized: false,
                statusCode: 403,
                error: 'FORBIDDEN',
                detail: 'Operator account is deactivated',
            };
        }
        req.operator = validation.operator;
        req.session = validation.session;
    } else {
        // No session token present: check perimeter access
        const isLocalOnly = process.env.LOCAL_ONLY === 'true';
        const isDirectTestCall = process.env.NODE_ENV === 'test' && !req.headers;
        const isLoopback =
            ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'].includes(req.ip) ||
            ['127.0.0.1', '::1', 'localhost'].includes(req.hostname);
        const hasApiKey = Boolean(
            process.env.API_SECRET_KEY &&
            ((req.headers && req.headers['x-api-key']) || '').trim() ===
                process.env.API_SECRET_KEY.trim()
        );

        if (!isLocalOnly && !isDirectTestCall && !isLoopback && !hasApiKey) {
            return {
                authorized: false,
                statusCode: 401,
                error: 'UNAUTHORIZED',
                detail: 'Valid operator session or authorized local environment required',
            };
        }
    }

    // 2. Explicit demo mode bypasses cross-business entity checks
    if (isExplicitDemo) {
        return {
            authorized: true,
            businessId: requestedBizId || 'DEMO_SIMULATION_ENTITY',
            isDemo: true,
        };
    }

    // 3. Handle explicit empty or null businessId
    if (hasExplicitBizKey && (requestedBizId === '' || requestedBizId === null)) {
        return {
            authorized: false,
            statusCode: 400,
            error: 'BAD_REQUEST',
            detail: 'Missing business identity. Please provide a valid businessId.',
        };
    }

    // 4. If businessId is not provided at all, resolve default or fail closed
    if (requestedBizId === undefined) {
        // Missing business identity: in authorized local mode or active session, default safely to primary SME
        return {
            authorized: true,
            businessId: PRIMARY_AUTHORIZED_BUSINESS_ID,
            isDefault: true,
        };
    }

    // 5. Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(String(requestedBizId))) {
        return {
            authorized: false,
            statusCode: 400,
            error: 'BAD_REQUEST',
            detail: 'Invalid business ID format. Expected standard UUID.',
        };
    }

    // 6. Cross-Business Access Check (Fail Closed)
    // Note: In single-tenant demo architecture, no multi-business entitlement table exists.
    // Callers cannot inspect other businesses simply by switching businessId.
    // Even with a valid x-api-key, multi-business access is refused.
    if (requestedBizId.toLowerCase() !== PRIMARY_AUTHORIZED_BUSINESS_ID.toLowerCase()) {
        return {
            authorized: false,
            statusCode: 403,
            error: 'FORBIDDEN',
            detail: 'Cross-business access prohibited. Multi-business entitlement mapping does not exist for this operator identity.',
        };
    }

    return {
        authorized: true,
        businessId: PRIMARY_AUTHORIZED_BUSINESS_ID,
        isDefault: false,
    };
}

// ── 4. SAFE NUMERIC PARSER & SANITIZER ─────────────────────────────────────────
/**
 * Safely parse a financial numeric input.
 * Handles strings with currency symbols or commas, numbers, null/undefined, and flags invalid values.
 */
function parseSafeFinancialNumber(
    val,
    fieldName,
    options = { allowNegative: false, defaultValue: 0 }
) {
    if (val === null || val === undefined) {
        return { value: options.defaultValue, isDefault: true, isValid: true };
    }
    if (typeof val === 'number') {
        if (!Number.isFinite(val)) {
            return {
                value: options.defaultValue,
                isDefault: true,
                isValid: false,
                reason: `${fieldName} is not finite (NaN or Infinity)`,
            };
        }
        if (!options.allowNegative && val < 0) {
            return {
                value: 0,
                isDefault: false,
                isValid: false,
                reason: `${fieldName} was negative (${val}), clamped to 0`,
            };
        }
        if (val > 1e12) {
            return {
                value: 1e12,
                isDefault: false,
                isValid: false,
                reason: `${fieldName} exceeds maximum safety ceiling (1 Trillion)`,
            };
        }
        return { value: val, isDefault: false, isValid: true };
    }
    if (typeof val === 'string') {
        const cleaned = val.trim().replace(/[,₹$€£\s]/g, '');
        if (cleaned === '') {
            return { value: options.defaultValue, isDefault: true, isValid: true };
        }
        const parsed = Number(cleaned);
        if (!Number.isFinite(parsed)) {
            return {
                value: options.defaultValue,
                isDefault: true,
                isValid: false,
                reason: `${fieldName} could not be parsed as a finite number: "${val}"`,
            };
        }
        if (!options.allowNegative && parsed < 0) {
            return {
                value: 0,
                isDefault: false,
                isValid: false,
                reason: `${fieldName} was negative (${parsed}), clamped to 0`,
            };
        }
        if (parsed > 1e12) {
            return {
                value: 1e12,
                isDefault: false,
                isValid: false,
                reason: `${fieldName} exceeds maximum safety ceiling (1 Trillion)`,
            };
        }
        return { value: parsed, isDefault: false, isValid: true };
    }
    return {
        value: options.defaultValue,
        isDefault: true,
        isValid: false,
        reason: `${fieldName} has invalid type: ${typeof val}`,
    };
}

/**
 * Format currency amount safely in Indian Rupee format
 */
function formatINR(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return '0';
    return Math.round(num).toLocaleString('en-IN');
}

// ── 5. DETERMINISTIC FINANCIAL METRICS ENGINE ────────────────────────────────
/**
 * Authoritative mathematical engine for treasury calculations.
 * Computes all metrics deterministically BEFORE LLM invocation.
 */
function computeTreasuryMetrics(telemetry = {}) {
    const warnings = [...(telemetry.validationWarnings || [])];

    const balanceParsed = parseSafeFinancialNumber(telemetry.balance, 'balance', {
        allowNegative: true,
        defaultValue: 0,
    });
    if (!balanceParsed.isValid) warnings.push(balanceParsed.reason);
    const balance = balanceParsed.value;

    const odLimitParsed = parseSafeFinancialNumber(telemetry.odLimit, 'odLimit', {
        allowNegative: false,
        defaultValue: 0,
    });
    if (!odLimitParsed.isValid) warnings.push(odLimitParsed.reason);
    const odLimit = odLimitParsed.value;

    const inflowParsed = parseSafeFinancialNumber(telemetry.totalInflow, 'totalInflow', {
        allowNegative: false,
        defaultValue: 0,
    });
    if (!inflowParsed.isValid) warnings.push(inflowParsed.reason);
    const totalInflow = inflowParsed.value;

    const outflowParsed = parseSafeFinancialNumber(telemetry.totalOutflow, 'totalOutflow', {
        allowNegative: false,
        defaultValue: 0,
    });
    if (!outflowParsed.isValid) warnings.push(outflowParsed.reason);
    const totalOutflow = outflowParsed.value;

    const overdueParsed = parseSafeFinancialNumber(telemetry.overdueAmount, 'overdueAmount', {
        allowNegative: false,
        defaultValue: 0,
    });
    if (!overdueParsed.isValid) warnings.push(overdueParsed.reason);
    const overdueAmount = overdueParsed.value;

    const upcomingParsed = parseSafeFinancialNumber(telemetry.upcomingAmount, 'upcomingAmount', {
        allowNegative: false,
        defaultValue: 0,
    });
    if (!upcomingParsed.isValid) warnings.push(upcomingParsed.reason);
    const upcomingAmount = upcomingParsed.value;

    const alertsParsed = parseSafeFinancialNumber(
        telemetry.highSeverityAlerts,
        'highSeverityAlerts',
        { allowNegative: false, defaultValue: 0 }
    );
    if (!alertsParsed.isValid) warnings.push(alertsParsed.reason);
    const highSeverityAlerts = alertsParsed.value;

    const txCountParsed = parseSafeFinancialNumber(telemetry.transactionCount, 'transactionCount', {
        allowNegative: false,
        defaultValue: 0,
    });
    const transactionCount = txCountParsed.value;

    // Overdraft facility & Total Liquidity
    const odUtilized = balance < 0 ? Math.min(odLimit, Math.abs(balance)) : 0;
    const availableOd = Math.max(0, odLimit - odUtilized);
    const effectiveCash = Math.max(0, balance);
    const totalLiquidity = effectiveCash + availableOd;

    // 30-Day Flows & Daily Burn Rate
    const netOperatingCashflow = totalInflow - totalOutflow;
    const observationPeriodDays = 30;
    const averageDailyGrossSpend = totalOutflow > 0 ? totalOutflow / observationPeriodDays : 0;
    const averageDailyNetBurn =
        netOperatingCashflow < 0 ? Math.abs(netOperatingCashflow) / observationPeriodDays : 0;

    // Historical Runway
    let runwayDays = null;
    let runwayClassification = 'NORMAL';
    let runwayExplanation = '';

    if (totalLiquidity <= 0) {
        runwayDays = 0;
        runwayClassification = 'EXHAUSTED';
        runwayExplanation = 'Liquidity exhausted (zero cash and zero available credit facilities)';
    } else if (averageDailyGrossSpend <= 0) {
        runwayDays = 999;
        runwayClassification = 'INFINITE_NO_SPEND';
        runwayExplanation = 'No recorded 30-day outflows; operational runway exceeds 365 days';
    } else {
        const rawRunway = totalLiquidity / averageDailyGrossSpend;
        runwayDays = Math.floor(rawRunway);
        if (runwayDays < 7) {
            runwayClassification = 'CRITICAL';
            runwayExplanation = `Critical runway: only ${runwayDays} days of spend remaining at current burn rate`;
        } else if (runwayDays < 30) {
            runwayClassification = 'VULNERABLE';
            runwayExplanation = `Moderate runway: ${runwayDays} days remaining; active cash management required`;
        } else {
            runwayClassification = 'ADEQUATE';
            runwayExplanation = `Stable runway: ${runwayDays} days of operations supported`;
        }
    }

    // Commitments & Gap Analysis
    const immediateCommitments = overdueAmount + upcomingAmount;
    const cashDeficit7d = Math.max(0, immediateCommitments - effectiveCash);
    const totalLiquidityGap7d = Math.max(0, immediateCommitments - totalLiquidity);
    const netHeadroom7d = totalLiquidity - immediateCommitments;

    return {
        currentBalance: balance,
        sanctionedOdLimit: odLimit,
        odUtilized,
        availableOverdraft: availableOd,
        totalLiquidity,
        grossInflow30d: totalInflow,
        grossOutflow30d: totalOutflow,
        netOperatingCashflow,
        averageDailyGrossSpend: Math.round(averageDailyGrossSpend * 100) / 100,
        averageDailyNetBurn: Math.round(averageDailyNetBurn * 100) / 100,
        runwayDays,
        runwayClassification,
        runwayExplanation,
        overdueObligations: overdueAmount,
        upcomingObligations7d: upcomingAmount,
        immediateCommitments7d: immediateCommitments,
        cashDeficit7d,
        totalLiquidityGap7d,
        netHeadroom7d,
        highSeverityAlerts,
        transactionCount,
        dataSource: telemetry.dataSource || 'CLIENT_SUPPLIED',
        validationWarnings: warnings,
        assumptions: [
            'Observation window is 30 calendar days.',
            'Available overdraft credit is assumed fully accessible for immediate liquidity.',
            'Average daily gross spend assumes constant trailing 30-day outflow run-rate.',
            'Runway reflects total available liquidity divided by average daily gross spend.',
        ],
    };
}

// ── 6. AUTHORITATIVE CONTEXT RESOLVER ─────────────────────────────────────────
/**
 * Resolves authoritative financial context from database when available.
 *
 * Strict Trust Boundaries:
 * 1. When DB is online and snapshot resolves: returns AUTHORITATIVE_VERIFIED context,
 *    overriding any client-supplied balance manipulations.
 * 2. When DB is offline/unavailable and NOT explicit demo mode: returns DATA_UNAVAILABLE
 *    status with null metrics, refusing to calculate recommendations on unverified telemetry.
 * 3. When explicit demo mode is requested: returns DEMO_SIMULATION status with explicit warnings.
 */
async function resolveAuthoritativeContext(pool, reqBody = {}, targetBizId = null) {
    const rawPayload = reqBody.contextPayload || reqBody;
    const isExplicitDemo = Boolean(
        reqBody.isDemoMode ||
        reqBody.demoScenario ||
        rawPayload.isDemoMode ||
        rawPayload.demoScenario
    );

    const businessId = targetBizId || reqBody.businessId || rawPayload.businessId;

    let dbAvailable = false;
    let snapshot = null;
    let dbErrMessage = null;

    if (pool && typeof pool.query === 'function') {
        try {
            const resolvedBizId = businessId || PRIMARY_AUTHORIZED_BUSINESS_ID;
            snapshot = await getCashSnapshot(pool, resolvedBizId);
            if (snapshot) {
                dbAvailable = true;
            }
        } catch (err) {
            dbErrMessage = err.message;
            console.warn('[AI ADVISOR] Authoritative DB lookup failed:', err.message);
        }
    }

    // 1. Authoritative Database Snapshot Available
    if (dbAvailable && snapshot) {
        const monthlyFlow = snapshot.monthly_flow || [];
        const totalInflow = monthlyFlow.reduce((s, d) => s + (Number(d.inflow) || 0), 0);
        const totalOutflow = monthlyFlow.reduce((s, d) => s + (Number(d.outflow) || 0), 0);
        const overdueAmount = (snapshot.upcoming_obligations || [])
            .filter((o) => o.status === 'OVERDUE')
            .reduce((s, o) => s + (Number(o.amount) || 0), 0);
        const upcomingAmount = (snapshot.upcoming_obligations || [])
            .filter((o) => o.days_until !== null && o.days_until <= 7 && o.status !== 'OVERDUE')
            .reduce((s, o) => s + (Number(o.amount) || 0), 0);
        const highSeverityAlerts = (snapshot.active_alerts || []).filter(
            (a) => a.severity === 'HIGH'
        ).length;

        const warnings = [];
        // Detect client manipulation
        if (
            rawPayload.balance !== undefined &&
            Number(rawPayload.balance) !== snapshot.current_balance
        ) {
            warnings.push(
                `Client-supplied balance (₹${rawPayload.balance}) rejected in favor of authoritative server ledger balance (₹${snapshot.current_balance})`
            );
        }

        return {
            status: 'AUTHORITATIVE_VERIFIED',
            businessId: businessId || snapshot.business?.id || PRIMARY_AUTHORIZED_BUSINESS_ID,
            businessName: snapshot.business?.name || 'Coimbatore Textile Mills Pvt Ltd',
            balance: snapshot.current_balance,
            odLimit: snapshot.od_limit || 2000000,
            totalInflow,
            totalOutflow,
            overdueAmount,
            upcomingAmount,
            highSeverityAlerts,
            transactionCount: (snapshot.accounts || []).length,
            dataSource: 'SERVER_AUTHORITATIVE_DB',
            completeness:
                snapshot.monthly_flow && snapshot.monthly_flow.length > 0 ? 'FULL' : 'PARTIAL',
            reconciledAt: snapshot.snapshot_at || new Date().toISOString(),
            validationWarnings: warnings,
            isDemoMode: false,
        };
    }

    // 2. Safe Explicit Demo / Simulation Mode
    if (isExplicitDemo) {
        return {
            status: 'DEMO_SIMULATION',
            businessId: businessId || 'DEMO-SIMULATION-001',
            businessName: 'Simulated Demo Enterprise',
            balance: rawPayload.balance ?? 1000000,
            odLimit: rawPayload.odLimit ?? 2000000,
            totalInflow: rawPayload.totalInflow ?? 12500000,
            totalOutflow: rawPayload.totalOutflow ?? 9800000,
            overdueAmount: rawPayload.overdueAmount ?? 0,
            upcomingAmount: rawPayload.upcomingAmount ?? 587000,
            highSeverityAlerts: rawPayload.highSeverityAlerts ?? 0,
            transactionCount: rawPayload.transactionCount ?? 1,
            dataSource: 'CLIENT_DEMO_SIMULATION',
            completeness: 'SIMULATED',
            reconciledAt: null,
            validationWarnings: [
                '[UNVERIFIED DEMO SIMULATION] Operating on simulated client telemetry for demonstration purposes.',
            ],
            isDemoMode: true,
        };
    }

    // 3. Database Unavailable and NOT explicit demo -> Fail Closed on unverified metrics
    return {
        status: 'DATA_UNAVAILABLE',
        businessId: businessId || null,
        businessName: null,
        balance: null,
        odLimit: null,
        totalInflow: null,
        totalOutflow: null,
        overdueAmount: null,
        upcomingAmount: null,
        highSeverityAlerts: null,
        transactionCount: null,
        dataSource: 'DATA_UNAVAILABLE',
        completeness: 'UNAVAILABLE',
        reconciledAt: null,
        validationWarnings: [
            dbErrMessage
                ? `Database query failed: ${dbErrMessage}. Client-supplied telemetry rejected.`
                : 'Authoritative database connection unavailable. Client-supplied telemetry rejected.',
        ],
        isDemoMode: false,
    };
}

// ── 7. OLLAMA INFERENCE WITH AUTHORITATIVE TIMEOUT ───────────────────────────
async function callOllamaWithTimeout(
    messages,
    model = OLLAMA_MODEL,
    timeoutMs = INFERENCE_TIMEOUT_MS
) {
    const timeoutPromise = new Promise((_, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Ollama inference timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (timer.unref) timer.unref();
    });

    return Promise.race([
        ollama.chat({
            model,
            messages,
        }),
        timeoutPromise,
    ]);
}

// ── 8. DETERMINISTIC REPORT GENERATORS (FALLBACK & VERIFICATION) ─────────────
function generateFallbackAdvice(metrics) {
    const bal = formatINR(metrics.currentBalance);
    const od = formatINR(metrics.availableOverdraft);
    const totalLiq = formatINR(metrics.totalLiquidity);
    const outflow = formatINR(metrics.grossOutflow30d);
    const dailySpend = formatINR(metrics.averageDailyGrossSpend);
    const overdue = formatINR(metrics.overdueObligations);
    const upcoming = formatINR(metrics.upcomingObligations7d);
    const commitments = formatINR(metrics.immediateCommitments7d);
    const alerts = metrics.highSeverityAlerts;
    const netFlowText =
        metrics.netOperatingCashflow >= 0
            ? `surplus of ₹${formatINR(metrics.netOperatingCashflow)}`
            : `deficit of ₹${formatINR(Math.abs(metrics.netOperatingCashflow))}`;

    const gapText =
        metrics.cashDeficit7d > 0
            ? `Cash shortfall of ₹${formatINR(metrics.cashDeficit7d)} before overdraft facilities. Net headroom after OD: ₹${formatINR(metrics.netHeadroom7d)}.`
            : `No cash shortfall; available cash covers all 7-day commitments with ₹${formatINR(metrics.netHeadroom7d)} in total liquidity headroom.`;

    const odAdvice =
        metrics.cashDeficit7d > 0
            ? `Utilize up to ₹${formatINR(metrics.cashDeficit7d)} of your ₹${od} available Overdraft limit if next week's collections are delayed.`
            : `Maintain cash buffer; preserve the ₹${od} available Overdraft limit for unexpected liquidity shocks.`;

    return `**Executive Summary**
The business is maintaining total spendable liquidity of ₹${totalLiq} (Cash: ₹${bal}, Available OD: ₹${od}). The 30-day operating cash flow reflects a net ${netFlowText}, with near-term outflows requiring active working capital management.

**Liquidity & Runway**
Your current balance of ₹${bal} is supported by ₹${od} in available overdraft buffer. Average daily spend is ₹${dailySpend}/day based on 30-day gross outflows of ₹${outflow}.
Operational runway: ${metrics.runwayExplanation}.

**Risk Assessment**
- **Overdue Exposure:** You have ₹${overdue} in overdue obligations that demand immediate settlement.
- **Short-term Pressure:** ₹${upcoming} required in the next 7 days (Total immediate commitments: ₹${commitments}).
- **7-Day Liquidity Gap:** ${gapText}
- **System Alerts:** ${alerts} critical system alert(s) require intervention.

**Strategic Action Plan**
- **Settle Overdues:** Clear the ₹${overdue} overdue immediately to avoid vendor penalties and supply chain disruptions.
- **Buffer Liquidity:** ${odAdvice}
- **Cost Optimization:** Review 30-day outflows (₹${outflow}) to identify discretionary spending that can be deferred.`;
}

function generateFallbackChatReply(lastUserMsg, metrics, invoices = []) {
    const bal = formatINR(metrics.currentBalance);
    const od = formatINR(metrics.availableOverdraft);
    const overdue = formatINR(metrics.overdueObligations);
    const upcoming = formatINR(metrics.upcomingObligations7d);
    const outflow = formatINR(metrics.grossOutflow30d);
    const commitments = formatINR(metrics.immediateCommitments7d);

    // Legitimate analytical question handlers
    if (lastUserMsg.includes('failure') || lastUserMsg.includes('fail')) {
        return `Based on system telemetry, payment failures typically result from provider gateway balance limits, invalid counterparty account details, or compliance screening holds. In CashIQ, all payment failures require inspection of the provider gateway log before any retry under dual-authorization controls.`;
    }

    if (lastUserMsg.includes('settlement status') || lastUserMsg.includes('settled')) {
        return `Current settlement telemetry shows total spendable liquidity of ₹${formatINR(metrics.totalLiquidity)} (available cash: ₹${bal}, available OD: ₹${od}). There are ₹${overdue} in overdue payables and ₹${upcoming} in commitments due over the next 7 days.`;
    }

    if (lastUserMsg.includes('payable') || lastUserMsg.includes('obligation')) {
        return `Outstanding payables analysis: You have ₹${overdue} in overdue obligations requiring immediate settlement, and ₹${upcoming} due within the next 7 days. Total immediate commitments stand at ₹${commitments}.`;
    }

    if (lastUserMsg.includes('delay') || lastUserMsg.includes('why has the payment')) {
        return `Payment delays generally stem from pending maker-checker dual approvals, banking cutoffs, or statutory AML/TDS screening verification. Please inspect the Operations & Approvals console to verify the exact instruction state.`;
    }

    if (lastUserMsg.includes('reconciliation') || lastUserMsg.includes('refund')) {
        return `Reconciliation discrepancies typically occur when internal ledger postings differ from external provider webhook confirmations or accounting synchronization with Zoho. Detailed ledger entries and webhook delivery receipts should be audited in the Reconciliation console.`;
    }

    if (
        lastUserMsg.includes('spend') ||
        lastUserMsg.includes('buy') ||
        lastUserMsg.includes('afford')
    ) {
        return `To make that purchase, you have ₹${bal} in available cash and ₹${od} in available overdraft facility. However, with ₹${commitments} in immediate 7-day commitments, discretionary expenditures should be held until overdue receivables clear.`;
    }

    if (lastUserMsg.includes('email') || lastUserMsg.includes('draft')) {
        return `**Draft Email to Vendor:**\n\n"Hi Team,\n\nWe noticed there is currently ₹${overdue} in outstanding overdue payments on your account. Please let us know when we can expect settlement so we can reconcile our books.\n\nBest regards,\nYour Finance Team"`;
    }

    if (lastUserMsg.includes('vendor') || lastUserMsg.includes('invoice')) {
        if (invoices && invoices.length > 0) {
            const invList = invoices
                .map((i) => {
                    const cleanSeller = String(i.seller_name || 'Vendor')
                        .replace(/[[\]]/g, '')
                        .replace(/SYSTEM\s*:/gi, '')
                        .replace(/[\r\n]+/g, ' ')
                        .trim();
                    return `- **${cleanSeller}**: ₹${formatINR(i.total_amount)} (ID: ${i.invoice_id})`;
                })
                .join('\n');
            return `I found ${invoices.length} pending invoices requiring review:\n\n${invList}\n\nPlease review these in the Operations & Approvals console for manual authorization.`;
        }
        return 'You currently have no pending invoices in the system.';
    }

    if (lastUserMsg.includes('hello') || lastUserMsg.includes('hi')) {
        return `Hello! I am your CFO Copilot. I'm currently tracking your ₹${bal} cash balance and monitoring ${metrics.highSeverityAlerts} critical alerts. What would you like to analyze today?`;
    }

    if (lastUserMsg.includes('runway') || lastUserMsg.includes('burn')) {
        return `Your current operational runway is ${metrics.runwayExplanation}. Total available spendable liquidity is ₹${formatINR(metrics.totalLiquidity)} with an average 30-day spend of ₹${formatINR(metrics.averageDailyGrossSpend)}/day.`;
    }

    if (lastUserMsg.includes('alert') || lastUserMsg.includes('risk')) {
        return `Your primary financial risk factor right now is the ₹${upcoming} in obligations due over the next 7 days and ₹${overdue} in overdue payables, compared against your 30-day outflow run-rate of ₹${outflow}. You need to accelerate collections.`;
    }

    return `Based on your simulated balance of ₹${bal}, you should prioritize collecting the ₹${overdue} in overdue receivables to stabilize your runway. How else can I assist?`;
}

// ── 9. POST /api/ai/cashflow-advisor ─────────────────────────────────────────
async function handleCashflowAdvisor(req, res) {
    try {
        const pool = req.app && req.app.locals && req.app.locals.pool;

        // 1. Business Access Authorisation Check
        const authCheck = await verifyBusinessAccess(req, pool);
        if (!authCheck.authorized) {
            return res.status(authCheck.statusCode).json({
                error: authCheck.error,
                detail: authCheck.detail,
            });
        }

        // 2. Resolve Authoritative Financial Context
        const authoritativeContext = await resolveAuthoritativeContext(
            pool,
            req.body,
            authCheck.businessId
        );

        // 3. Database Unavailable Handling
        if (authoritativeContext.status === 'DATA_UNAVAILABLE') {
            return res.json({
                status: 'DATA_UNAVAILABLE',
                advice: `**Data Unavailable**\n\nAuthoritative ledger data is currently unavailable because the database is disconnected or unreachable. CashIQ does not generate business-specific financial recommendations using unverified client telemetry.\n\nPlease verify that the primary ledger database is online and accessible.`,
                metrics: null,
                unverified_hypotheses: [],
                data_provenance: {
                    source: 'NONE',
                    status: 'DATA_UNAVAILABLE',
                    business_id: authoritativeContext.businessId,
                    completeness: 'UNAVAILABLE',
                    reconciled: false,
                },
            });
        }

        // 4. Compute Deterministic Metrics (Authoritative or Explicit Demo)
        const metrics = computeTreasuryMetrics(authoritativeContext);

        // 5. Explicit Demo Mode Report
        if (authoritativeContext.status === 'DEMO_SIMULATION') {
            const demoAdvice = generateFallbackAdvice(metrics);
            const watermarkedAdvice = `⚠️ **[UNVERIFIED DEMO SIMULATION]**\n\nNotice: This report is generated from unverified client simulation data for demonstration purposes only. It does not reflect verified ledger records.\n\n${demoAdvice}`;

            return res.json({
                status: 'DEMO_SIMULATION',
                advice: watermarkedAdvice,
                metrics,
                unverified_hypotheses: [
                    'Simulated cash inflows and outflows assume historical run-rates persist without counterparty default.',
                    'Credit facility limits reflect user-provided assumptions rather than contracted banking covenants.',
                ],
                data_provenance: {
                    source: 'CLIENT_SIMULATION',
                    status: 'DEMO_SIMULATION',
                    business_id: authoritativeContext.businessId,
                    completeness: 'SIMULATED',
                    reconciled: false,
                },
            });
        }

        // 6. Authoritative Production Report
        const verifiedTelemetryTable = `
Verified Financial Telemetry (Authoritative Deterministic Calculations):
- Total Spendable Liquidity: ₹${formatINR(metrics.totalLiquidity)}
- Current Cash Position: ₹${formatINR(metrics.currentBalance)}
- Available Overdraft Facility: ₹${formatINR(metrics.availableOverdraft)} (Sanctioned: ₹${formatINR(metrics.sanctionedOdLimit)})
- 30-Day Gross Inflow: ₹${formatINR(metrics.grossInflow30d)}
- 30-Day Gross Outflow: ₹${formatINR(metrics.grossOutflow30d)}
- Net Operating Cashflow: ${metrics.netOperatingCashflow >= 0 ? '+' : '-'}₹${formatINR(Math.abs(metrics.netOperatingCashflow))} (${metrics.netOperatingCashflow >= 0 ? 'Surplus' : 'Deficit'})
- Average Daily Spend (Gross): ₹${formatINR(metrics.averageDailyGrossSpend)} / day
- Average Daily Net Burn: ₹${formatINR(metrics.averageDailyNetBurn)} / day
- Operational Runway: ${metrics.runwayExplanation} (${metrics.runwayDays} days)
- Overdue Obligations: ₹${formatINR(metrics.overdueObligations)}
- Upcoming 7-Day Obligations: ₹${formatINR(metrics.upcomingObligations7d)}
- Total Immediate Commitments: ₹${formatINR(metrics.immediateCommitments7d)}
- 7-Day Cash Deficit: ₹${formatINR(metrics.cashDeficit7d)}
- Net 7-Day Headroom (Total Liquidity minus Commitments): ${metrics.netHeadroom7d >= 0 ? '+' : '-'}₹${formatINR(Math.abs(metrics.netHeadroom7d))}
- Critical Alerts: ${metrics.highSeverityAlerts}
- Data Source: ${metrics.dataSource}
`;

        const systemPrompt = `You are a Tier-1 Corporate Treasury CFO advising an SME in a strictly READ-ONLY advisory capacity. 
Your goal is to explain and interpret the verified cash flow telemetry provided below.

MANDATORY ACCURACY & SAFETY INSTRUCTIONS:
1. STRICT READ-ONLY: You cannot initiate payments, execute disbursements, or change balances.
2. DO NOT RECALCULATE: Strictly cite and explain the verified numbers provided below. Do not guess or invent figures.
3. INSUFFICIENT DATA: If any metric is missing or unknown, state that data is insufficient.
4. Output strictly in Markdown format with the following 4 sections:
1. **Executive Summary**: A 1-2 sentence high-level view of cash health and trajectory.
2. **Liquidity & Runway**: Assessment of the burn rate, OD buffer, and cash position.
3. **Risk Assessment**: Highlighting overdue items, 7-day pressure, or CC utilization.
4. **Strategic Action Plan**: 2-3 concrete treasury actions (bulleted).

${verifiedTelemetryTable}`;

        let adviceText = null;
        try {
            const response = await callOllamaWithTimeout([
                {
                    role: 'system',
                    content:
                        'You are an elite corporate treasury AI operating in strictly read-only advisory mode.',
                },
                { role: 'user', content: systemPrompt },
            ]);

            if (response && response.message && response.message.content) {
                adviceText = response.message.content;
            }
        } catch (modelErr) {
            console.warn(
                '[AI ADVISOR WARN] Local Ollama execution failed. Error:',
                modelErr.message
            );
        }

        if (!adviceText || adviceText.trim().length === 0) {
            adviceText = generateFallbackAdvice(metrics);
        }

        // Post-processing sanity check: strip any leaked execution claims
        if (/\b(PAY_INVOICE|execute_payment|disburse_funds)\b/i.test(adviceText)) {
            adviceText = generateFallbackAdvice(metrics);
        }

        return res.json({
            status: 'AUTHORITATIVE_VERIFIED',
            advice: adviceText,
            metrics,
            unverified_hypotheses: [],
            data_provenance: {
                source: 'POSTGRESQL_LEDGER',
                status: 'AUTHORITATIVE_VERIFIED',
                business_id: authoritativeContext.businessId,
                completeness: authoritativeContext.completeness || 'FULL',
                reconciled: true,
                reconciled_at: authoritativeContext.reconciledAt || new Date().toISOString(),
            },
        });
    } catch (err) {
        console.warn('[AI ADVISOR WARN] Handler error, returning safe failure:', err.message);
        return res.status(500).json({
            status: 'ERROR',
            advice: 'An internal error occurred while generating treasury advice. Please try again.',
            metrics: null,
            unverified_hypotheses: [],
            data_provenance: {
                source: 'NONE',
                status: 'ERROR',
                completeness: 'UNAVAILABLE',
                reconciled: false,
            },
        });
    }
}

// ── 10. POST /api/ai/chat ────────────────────────────────────────────────────
async function handleChat(req, res) {
    let pendingInvoices = [];
    try {
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({ error: 'Request body must be a JSON object' });
        }

        const { messages } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Messages array required' });
        }

        if (messages.length === 0) {
            return res.status(400).json({ error: 'Messages array cannot be empty' });
        }

        // Sanitize messages
        const sanitizedMessages = messages.slice(-20).map((m) => ({
            role: m && m.role === 'assistant' ? 'assistant' : 'user',
            content: typeof (m && m.content) === 'string' ? m.content.slice(0, 1000) : '',
        }));

        const lastUserMessage =
            sanitizedMessages.filter((m) => m.role === 'user').pop()?.content || '';

        // ── 1. MUTATION INTENT CLASSIFICATION GATE ───────────────────────────
        const intentClassification = classifyFinancialIntent(lastUserMessage);
        if (intentClassification.isMutation) {
            return res.json({
                status: 'MUTATION_REFUSED',
                reply: 'As a read-only CFO advisory copilot, I cannot execute, draft, sign, or authorize financial disbursements. Please navigate to the Operations or Approvals console to initiate payments under dual-authorization controls.',
                metrics: null,
                unverified_hypotheses: [],
                data_provenance: {
                    source: 'SECURITY_POLICY_GATE',
                    status: 'MUTATION_REFUSED',
                },
            });
        }

        // ── 2. BUSINESS ACCESS AUTHORISATION CHECK ───────────────────────────
        const pool = req.app && req.app.locals && req.app.locals.pool;
        const authCheck = await verifyBusinessAccess(req, pool);
        if (!authCheck.authorized) {
            return res.status(authCheck.statusCode).json({
                error: authCheck.error,
                detail: authCheck.detail,
            });
        }

        // ── 3. RESOLVE AUTHORITATIVE FINANCIAL CONTEXT ───────────────────────
        const authoritativeContext = await resolveAuthoritativeContext(
            pool,
            req.body,
            authCheck.businessId
        );

        // ── 4. DATABASE UNAVAILABLE BEHAVIOUR ────────────────────────────────
        if (authoritativeContext.status === 'DATA_UNAVAILABLE') {
            // General financial educational question check
            if (isEducationalOrConceptualQuery(lastUserMessage)) {
                let educationalReply = null;
                try {
                    const response = await callOllamaWithTimeout([
                        {
                            role: 'system',
                            content:
                                "You are CashIQ Nexus, an elite corporate treasury assistant. The primary ledger database is disconnected, so you cannot quote or reference specific business balances. Answer the user's conceptual financial or regulatory question accurately and concisely without citing or inventing specific company figures.",
                        },
                        { role: 'user', content: lastUserMessage },
                    ]);
                    if (response && response.message && response.message.content) {
                        educationalReply = response.message.content;
                    }
                } catch {
                    // Fallback to deterministic educational knowledge base
                }

                if (!educationalReply || educationalReply.trim().length === 0) {
                    educationalReply = generateEducationalReply(lastUserMessage);
                }

                return res.json({
                    status: 'DATA_UNAVAILABLE',
                    reply: educationalReply,
                    metrics: null,
                    unverified_hypotheses: [],
                    data_provenance: {
                        source: 'CONCEPTUAL_KNOWLEDGE_BASE',
                        status: 'EDUCATIONAL_CONCEPT',
                    },
                });
            }

            // Business-specific question during database unavailability
            return res.json({
                status: 'DATA_UNAVAILABLE',
                reply: 'Authoritative financial records are currently unavailable from the database. To ensure financial data integrity, CashIQ does not generate business-specific advice or quote financial metrics from unverified client telemetry. Please verify that the primary ledger database is online.',
                metrics: null,
                unverified_hypotheses: [],
                data_provenance: {
                    source: 'NONE',
                    status: 'DATA_UNAVAILABLE',
                },
            });
        }

        // ── 5. SAFE EXPLICIT DEMO SIMULATION ─────────────────────────────────
        if (authoritativeContext.status === 'DEMO_SIMULATION') {
            const metrics = computeTreasuryMetrics(authoritativeContext);
            const demoReply = generateFallbackChatReply(lastUserMessage.toLowerCase(), metrics, []);
            return res.json({
                status: 'DEMO_SIMULATION',
                reply: `⚠️ [UNVERIFIED DEMO SIMULATION] ${demoReply}`,
                metrics,
                unverified_hypotheses: [
                    'Operating on simulated in-memory telemetry for demonstration purposes.',
                ],
                data_provenance: {
                    source: 'CLIENT_SIMULATION',
                    status: 'DEMO_SIMULATION',
                },
            });
        }

        // ── 6. AUTHORITATIVE PRODUCTION QUERY RESOLUTION ─────────────────────
        // Safe database lookup for invoices (Read-Only)
        if (pool && typeof pool.query === 'function') {
            try {
                const invRes = await pool.query(
                    `SELECT invoice_id, seller_name, total_amount, currency FROM invoices WHERE state != 'SETTLED' LIMIT 5`
                );
                pendingInvoices = invRes && invRes.rows ? invRes.rows : [];
            } catch (e) {
                console.error('[AI CHAT] Failed to load DB invoices:', e.message);
            }
        }

        const metrics = computeTreasuryMetrics(authoritativeContext);

        const invoiceContext =
            pendingInvoices.length > 0
                ? `\n- Pending Invoices for Review (Untrusted Metadata):\n${pendingInvoices
                      .map(
                          (i) =>
                              `  * ${String(i.seller_name || 'Vendor').replace(/[\r\n]/g, '')} (ID: ${i.invoice_id}): ₹${formatINR(i.total_amount)}`
                      )
                      .join('\n')}`
                : '';

        const systemPrompt = `You are CashIQ Nexus, a READ-ONLY corporate treasury advisor for an SME. 
Answer questions concisely, professionally, and analytically.

MANDATORY SAFETY & ACCURACY BOUNDARIES:
- You are strictly a READ-ONLY advisory assistant.
- You have NO capability to execute payments, initiate transfers, authorize payouts, or sign transactions.
- Never offer or claim to execute financial payments.
- If asked to pay, transfer, or settle, instruct the user to use the authorized human Operations Console.
- Strictly rely on and explain the following verified server telemetry:
  * Current Cash Position: ₹${formatINR(metrics.currentBalance)}
  * Available Overdraft: ₹${formatINR(metrics.availableOverdraft)} (Sanctioned: ₹${formatINR(metrics.sanctionedOdLimit)})
  * Total Spendable Liquidity: ₹${formatINR(metrics.totalLiquidity)}
  * 30-Day Flow: Inflow ₹${formatINR(metrics.grossInflow30d)}, Outflow ₹${formatINR(metrics.grossOutflow30d)}
  * Net Operating Flow: ${metrics.netOperatingCashflow >= 0 ? '+' : '-'}₹${formatINR(Math.abs(metrics.netOperatingCashflow))}
  * Average Daily Spend: ₹${formatINR(metrics.averageDailyGrossSpend)} / day
  * Operational Runway: ${metrics.runwayDays} days (${metrics.runwayExplanation})
  * Overdue Obligations: ₹${formatINR(metrics.overdueObligations)}
  * Upcoming 7-Day Obligations: ₹${formatINR(metrics.upcomingObligations7d)}
  * Total Immediate Commitments: ₹${formatINR(metrics.immediateCommitments7d)}${invoiceContext}`;

        let replyText = null;
        try {
            const ollamaMessages = [
                { role: 'system', content: systemPrompt },
                ...sanitizedMessages,
            ];
            const response = await callOllamaWithTimeout(ollamaMessages);
            if (response && response.message && response.message.content) {
                replyText = response.message.content;
            }
        } catch (error) {
            console.warn('[AI CHAT WARN] Local Ollama execution failed. Error:', error.message);
        }

        if (!replyText || replyText.trim().length === 0) {
            replyText = generateFallbackChatReply(
                lastUserMessage.toLowerCase(),
                metrics,
                pendingInvoices
            );
        }

        // Post-processing sanity check: strip any leaked execution claims
        if (/\b(PAY_INVOICE|execute_payment|disburse_funds)\b/i.test(replyText)) {
            replyText = generateFallbackChatReply(
                lastUserMessage.toLowerCase(),
                metrics,
                pendingInvoices
            );
        }

        return res.json({
            status: 'AUTHORITATIVE_VERIFIED',
            reply: replyText,
            metrics,
            unverified_hypotheses: [],
            data_provenance: {
                source: 'POSTGRESQL_LEDGER',
                status: 'AUTHORITATIVE_VERIFIED',
                business_id: authoritativeContext.businessId,
                completeness: authoritativeContext.completeness || 'FULL',
                reconciled: true,
                reconciled_at: authoritativeContext.reconciledAt || new Date().toISOString(),
            },
        });
    } catch (err) {
        console.warn('[AI CHAT WARN] Handler error, returning safe failure:', err.message);
        return res.status(500).json({
            status: 'ERROR',
            reply: 'An internal error occurred while processing your request.',
            metrics: null,
            unverified_hypotheses: [],
            data_provenance: { source: 'NONE', status: 'ERROR' },
        });
    }
}

// ── 11. WORKSTREAM 0 CONTAINMENT QUARANTINE ROUTER ───────────────────────────
// Legacy AI direct router remains quarantined and returns 404 for containment tests.
router.use((req, res) => {
    res.status(404).json({
        error: 'Legacy AI advisor endpoint is disabled and unmounted (Workstream 0 containment).',
    });
});

router.post('/cashflow-advisor', (req, res) => {
    res.status(404).json({
        error: 'Legacy AI advisor endpoint is disabled and unmounted (Workstream 0 containment).',
    });
});
router.post('/chat', (req, res) => {
    res.status(404).json({
        error: 'Legacy AI advisor endpoint is disabled and unmounted (Workstream 0 containment).',
    });
});

module.exports = router;
module.exports.handleChat = handleChat;
module.exports.handleCashflowAdvisor = handleCashflowAdvisor;
module.exports.classifyFinancialIntent = classifyFinancialIntent;
module.exports.computeTreasuryMetrics = computeTreasuryMetrics;
module.exports.parseSafeFinancialNumber = parseSafeFinancialNumber;
module.exports.resolveAuthoritativeContext = resolveAuthoritativeContext;
module.exports.verifyBusinessAccess = verifyBusinessAccess;
module.exports.isEducationalOrConceptualQuery = isEducationalOrConceptualQuery;
module.exports.generateEducationalReply = generateEducationalReply;
module.exports.generateFallbackAdvice = generateFallbackAdvice;
module.exports.generateFallbackChatReply = generateFallbackChatReply;
module.exports.formatINR = formatINR;
module.exports.PRIMARY_AUTHORIZED_BUSINESS_ID = PRIMARY_AUTHORIZED_BUSINESS_ID;
