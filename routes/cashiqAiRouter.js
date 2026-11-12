'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * CASHIQ INTELLIGENCE AI ROUTER (CHAT & CASHFLOW ADVISOR)
 * ════════════════════════════════════════════════════════════════════════════
 * 
 * STRICT DEMO & READ-ONLY GOVERNANCE MANDATES:
 * 1. STRICT READ-ONLY ADVISORY: ZERO financial mutation capabilities. No payment
 *    initiation, refund, settlement, or signing.
 * 2. DETERMINISTIC FALLBACKS: Fails closed to structured treasury-grade markdown
 *    if the local Ollama daemon is offline or inference times out.
 * 3. LOCAL_ONLY / CONTAINMENT: Requires loopback access or valid x-api-key.
 * 4. ISOLATED ROUTER STACK: Keeps aiInvestigateRouter stack pristine for
 *    synthetic investigation tests while restoring CashOverviewTab functionality.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const logger = require('../logger');
const { handleChat, handleCashflowAdvisor } = require('./aiAdvisor');

const router = express.Router();

// Rate limiter: 60 requests per minute
const cashiqAiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'CashIQ AI rate limit exceeded. Please wait before submitting further requests.',
    },
});

router.use(cashiqAiLimiter);

/**
 * Local-only / Workstream 0 Access Guard
 */
function accessGuard(req, res, next) {
    const isLocalOnly = process.env.LOCAL_ONLY === 'true';
    const isLoopback =
        ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'].includes(req.ip) ||
        ['127.0.0.1', '::1', 'localhost'].includes(req.hostname);

    if (isLocalOnly || isLoopback) {
        return next();
    }

    const clientKey = (req.headers['x-api-key'] || '').trim();
    const secretKey = (process.env.API_SECRET_KEY || '').trim();

    if (secretKey && clientKey === secretKey) {
        return next();
    }

    logger.warn(`[CASHIQ AI ROUTER] 401 Unauthorized access attempt from ${req.ip}`);
    return res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Access restricted to local development environment or authenticated API clients.',
    });
}

router.use(accessGuard);

// ── POST /api/ai/chat — CASHIQ CFO ADVISORY CHAT (READ-ONLY) ─────────────────
router.post('/chat', handleChat);

// ── POST /api/ai/cashflow-advisor — CASHFLOW ADVISORY REPORT (READ-ONLY) ──────
router.post('/cashflow-advisor', handleCashflowAdvisor);

module.exports = router;

