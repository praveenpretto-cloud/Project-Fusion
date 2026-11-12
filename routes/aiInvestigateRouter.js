'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * AI PAYMENT OPERATIONS COPILOT — INVESTIGATION ROUTER
 * ════════════════════════════════════════════════════════════════════════════
 * 
 * STRICT DEMO & PORTFOLIO GOVERNANCE MANDATES:
 * 1. SYNTHETIC-ONLY BOUNDARY: This API operates exclusively against pre-validated
 *    synthetic payment exception scenarios (CASE-01 to CASE-15).
 * 2. ZERO PERSISTENT DATABASE ACCESS: Queries to persistent fusion_db or actual
 *    customer accounts are strictly rejected.
 * 3. ZERO FINANCIAL MUTATION: Strictly read-only analytical copilot. No payment
 *    execution, retry, refund, or settlement capabilities exist in this module.
 * 4. FOUR-EYES DEFENSE: All recommendations are strictly non-autonomous operational
 *    checks requiring human dual authorization.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const logger = require('../logger');
const { syntheticStore, CASE_ID_REGEX } = require('../core/ai/synthetic/syntheticStore');
const { InvestigationOrchestrator } = require('../core/ai/orchestrator');
const { AgentLoop } = require('../core/ai/orchestrator/agentLoop');
const { ToolRegistry } = require('../core/ai/tools/toolRegistry');
const { createModelProvider } = require('../core/ai/providers');
const { sanitizeString } = require('../core/ai/validators/sanitizer');
const { createDlpContext } = require('../core/ai/security/dlpMasker');
const { telemetry, SPAN_NAMES, FUSION_AI_ATTRIBUTES } = require('../core/ai/observability');

const defaultToolRegistry = new ToolRegistry({ enableRAG: true });

const router = express.Router();

// ── RATE LIMITING & SECURITY BOUNDARIES ──────────────────────────────────────
const aiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute window
    max: 60, // 60 requests per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Investigation rate limit exceeded. Please wait before submitting further requests.'
    }
});

router.use(aiLimiter);

/**
 * Local-only / Workstream 0 Access Guard
 */
function accessGuard(req, res, next) {
    const isLocalOnly = process.env.LOCAL_ONLY === 'true';
    const isLoopback = [
        '127.0.0.1',
        '::1',
        '::ffff:127.0.0.1',
        'localhost'
    ].includes(req.ip) || [
        '127.0.0.1',
        '::1',
        'localhost'
    ].includes(req.hostname);

    if (isLocalOnly || isLoopback) {
        return next();
    }

    const clientKey = (req.headers['x-api-key'] || '').trim();
    const secretKey = (process.env.API_SECRET_KEY || '').trim();

    if (secretKey && clientKey === secretKey) {
        return next();
    }

    logger.warn(`[AI INVESTIGATE ROUTER] 401 Unauthorized access attempt from ${req.ip}`);
    return res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Access restricted to local development environment or authenticated API clients.'
    });
}

router.use(accessGuard);

// ── GET /api/ai/synthetic-cases ──────────────────────────────────────────────
router.get('/synthetic-cases', (req, res) => {
    try {
        const cases = syntheticStore.listCases();
        return res.status(200).json({
            success: true,
            count: cases.length,
            cases
        });
    } catch (err) {
        logger.error(`[AI INVESTIGATE ROUTER] Error listing synthetic cases: ${err.message}`);
        return res.status(500).json({
            success: false,
            error: 'INTERNAL_ERROR',
            message: 'Unable to retrieve synthetic case catalog.'
        });
    }
});

// ── POST /api/ai/investigate ─────────────────────────────────────────────────
router.post('/investigate', async (req, res) => {
    try {
        // 1. Request Body Structure Validation
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
            return res.status(400).json({
                success: false,
                error: 'INVALID_REQUEST',
                message: 'Request payload must be a non-empty JSON object.'
            });
        }

        // Payload size guard (max 32KB)
        const payloadString = JSON.stringify(req.body);
        if (payloadString.length > 32768) {
            return res.status(413).json({
                success: false,
                error: 'PAYLOAD_TOO_LARGE',
                message: 'Investigation request payload exceeds maximum permitted size of 32KB.'
            });
        }

        const { caseId, question, model, providerType } = req.body;

        // 2. Strict Synthetic Case Identifier Validation
        if (!caseId || typeof caseId !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'MISSING_CASE_ID',
                message: 'Synthetic caseId is required (e.g., CASE-01 to CASE-15). Arbitrary transaction queries are prohibited.'
            });
        }

        const cleanCaseId = caseId.trim().toUpperCase();
        if (!CASE_ID_REGEX.test(cleanCaseId)) {
            return res.status(400).json({
                success: false,
                error: 'INVALID_CASE_ID_FORMAT',
                message: `Invalid synthetic case ID format '${cleanCaseId}'. Format must match CASE-01 through CASE-15.`
            });
        }

        const syntheticCase = syntheticStore.getCaseById(cleanCaseId);
        if (!syntheticCase) {
            return res.status(404).json({
                success: false,
                error: 'UNKNOWN_CASE_ID',
                message: `Synthetic case '${cleanCaseId}' not found in registry.`
            });
        }

        // 3. Question Validation & Sanitization
        let cleanQuestion = syntheticCase.question || '';
        if (question !== undefined && question !== null) {
            if (typeof question !== 'string') {
                return res.status(400).json({
                    success: false,
                    error: 'INVALID_QUESTION_TYPE',
                    message: 'Question must be a string.'
                });
            }
            if (question.length > 500) {
                return res.status(400).json({
                    success: false,
                    error: 'QUESTION_TOO_LONG',
                    message: 'Question exceeds maximum length of 500 characters.'
                });
            }
            cleanQuestion = sanitizeString(question, 500);
        }

        // 4. Model Provider Configuration
        // Determine whether to use mock provider or ollama provider
        const resolvedProviderType = providerType || process.env.AI_PROVIDER_TYPE || 'ollama';

        let modelProvider;
        if (resolvedProviderType === 'mock') {
            modelProvider = createModelProvider('mock');

            // Align mock provider behavior with test case expectation
            if (syntheticCase.forcedProviderStatus) {
                modelProvider.setForcedStatus(syntheticCase.forcedProviderStatus);
            } else {
                modelProvider.setForcedStatus('SUCCESS');
                const toolNames = Object.keys(syntheticCase.evidence || {});
                const primaryTool = toolNames[0] || 'getTransactionTimeline';
                modelProvider.setMockResponse({
                    summary: `Investigation summary for ${syntheticCase.transactionId}: ${syntheticCase.groundedFinding}`,
                    status: 'COMPLETED',
                    confirmed_findings: [
                        {
                            claim: syntheticCase.groundedFinding,
                            evidence_references: [primaryTool],
                            source_field: `${primaryTool}.status`
                        }
                    ],
                    hypotheses: [],
                    missing_information: [],
                    recommended_checks: ['VERIFY_PROVIDER_STATUS'],
                    evidence_references: toolNames.length > 0 ? toolNames : ['getTransactionTimeline'],
                    limitations: ['Advisory decision support only. Human review required.']
                });
            }
        } else {
            modelProvider = createModelProvider('ollama', {
                defaultModel: model || process.env.OLLAMA_MODEL || 'llama3.1:latest',
                timeoutMs: 30000
            });
        }

        // 5. Instantiate Orchestrator with Controlled Database Boundary
        const orchestrator = new InvestigationOrchestrator({
            dbClient: syntheticStore.createControlledDbBoundary(),
            modelProvider,
            timeoutMs: 30000
        });

        const dlpContext = createDlpContext();

        // 6. Execute Deterministic Investigation Pipeline
        const outcome = await orchestrator.investigate({
            transactionId: syntheticCase.transactionId,
            question: cleanQuestion,
            explicitIntent: syntheticCase.intent,
            model,
            evidenceOverride: syntheticCase.evidence || {},
            dlpContext
        });

        // 7. Structured Response Mapping (Fail-closed error translation)
        if (outcome.success) {
            return res.status(200).json({
                success: true,
                status: 'REPORT_GENERATED',
                investigation_id: outcome.investigation_id,
                case_id: cleanCaseId,
                transaction_id: outcome.transaction_id,
                intent: outcome.intent,
                report: outcome.report,
                raw_evidence: outcome.raw_evidence,
                dlp_audit: outcome.dlp_audit || null,
                warnings: outcome.warnings || [],
                latency_ms: outcome.latency_ms
            });
        }

        // Handle specific failure statuses
        switch (outcome.status) {
            case 'AI_UNAVAILABLE':
                return res.status(503).json({
                    success: false,
                    status: 'AI_UNAVAILABLE',
                    investigation_id: outcome.investigation_id,
                    case_id: cleanCaseId,
                    transaction_id: outcome.transaction_id,
                    error: 'Local AI inference service is unavailable (Ollama offline). Copilot requires local model runtime.',
                    latency_ms: outcome.latency_ms
                });

            case 'MODEL_TIMEOUT':
            case 'TIMEOUT':
                return res.status(504).json({
                    success: false,
                    status: 'TIMEOUT',
                    investigation_id: outcome.investigation_id,
                    case_id: cleanCaseId,
                    transaction_id: outcome.transaction_id,
                    error: 'AI inference timed out after 30000ms threshold.',
                    latency_ms: outcome.latency_ms
                });

            case 'MODEL_OUTPUT_INVALID':
                return res.status(502).json({
                    success: false,
                    status: 'MODEL_OUTPUT_INVALID',
                    investigation_id: outcome.investigation_id,
                    case_id: cleanCaseId,
                    transaction_id: outcome.transaction_id,
                    error: 'Model output was malformed or failed JSON parsing.',
                    latency_ms: outcome.latency_ms
                });

            case 'REPORT_VALIDATION_FAILED':
                return res.status(422).json({
                    success: false,
                    status: 'REPORT_VALIDATION_FAILED',
                    investigation_id: outcome.investigation_id,
                    case_id: cleanCaseId,
                    transaction_id: outcome.transaction_id,
                    error: 'Generated report failed evidence citation or schema validation.',
                    validation_errors: outcome.validation_errors || [],
                    candidate_report: outcome.candidate_report || null,
                    latency_ms: outcome.latency_ms
                });

            case 'INTENT_CLARIFICATION_REQUIRED':
                return res.status(400).json({
                    success: false,
                    status: 'INTENT_CLARIFICATION_REQUIRED',
                    investigation_id: outcome.investigation_id,
                    case_id: cleanCaseId,
                    transaction_id: outcome.transaction_id,
                    error: outcome.reason || 'Intent clarification required.'
                });

            default:
                return res.status(400).json({
                    success: false,
                    status: outcome.status || 'INVESTIGATION_FAILED',
                    investigation_id: outcome.investigation_id,
                    case_id: cleanCaseId,
                    transaction_id: outcome.transaction_id,
                    error: outcome.message || outcome.error || 'Investigation could not be completed.'
                });
        }
    } catch (err) {
        logger.error(`[AI INVESTIGATE ROUTER] Unexpected handler error: ${err.message}`);
        // Never expose stack trace or internal runtime details
        return res.status(500).json({
            success: false,
            error: 'INTERNAL_SERVER_ERROR',
            message: 'An unexpected internal error occurred during payment investigation.'
        });
    }
});

// ── POST /api/ai/agent-investigate — BOUNDED AGENTIC INVESTIGATION (PHASE AI-3.1)
router.post('/agent-investigate', async (req, res) => {
    try {
        // 1. Request Body Structure Validation
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
            return res.status(400).json({
                success: false,
                error: 'INVALID_REQUEST',
                message: 'Request payload must be a non-empty JSON object.'
            });
        }

        // Payload size guard (max 32KB)
        const payloadString = JSON.stringify(req.body);
        if (payloadString.length > 32768) {
            return res.status(413).json({
                success: false,
                error: 'PAYLOAD_TOO_LARGE',
                message: 'Agent request payload exceeds maximum permitted size of 32KB.'
            });
        }

        const { caseId, question, model, providerType, maxRounds, overallDeadlineMs } = req.body;

        // 2. Strict Synthetic Case Identifier Validation
        if (!caseId || typeof caseId !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'MISSING_CASE_ID',
                message: 'Synthetic caseId is required (e.g., CASE-01 to CASE-15). Arbitrary transaction queries are prohibited.'
            });
        }

        const cleanCaseId = caseId.trim().toUpperCase();
        if (!CASE_ID_REGEX.test(cleanCaseId)) {
            return res.status(400).json({
                success: false,
                error: 'INVALID_CASE_ID_FORMAT',
                message: `Invalid synthetic case ID format '${cleanCaseId}'. Format must match CASE-01 through CASE-15.`
            });
        }

        const syntheticCase = syntheticStore.getCaseById(cleanCaseId);
        if (!syntheticCase) {
            return res.status(404).json({
                success: false,
                error: 'UNKNOWN_CASE_ID',
                message: `Synthetic case '${cleanCaseId}' not found in registry.`
            });
        }

        // 3. Question Validation & Sanitization
        let cleanQuestion = syntheticCase.question || '';
        if (question !== undefined && question !== null) {
            if (typeof question !== 'string') {
                return res.status(400).json({
                    success: false,
                    error: 'INVALID_QUESTION_TYPE',
                    message: 'Question must be a string.'
                });
            }
            if (question.length > 500) {
                return res.status(400).json({
                    success: false,
                    error: 'QUESTION_TOO_LONG',
                    message: 'Question exceeds maximum length of 500 characters.'
                });
            }
            cleanQuestion = sanitizeString(question, 500);
        }

        // 4. Model Provider Configuration
        const resolvedProviderType = providerType || process.env.AI_PROVIDER_TYPE || 'ollama';
        let modelProvider;

        if (resolvedProviderType === 'mock') {
            modelProvider = createModelProvider('mock');
            if (syntheticCase.forcedProviderStatus) {
                modelProvider.setForcedStatus(syntheticCase.forcedProviderStatus);
            }
        } else {
            modelProvider = createModelProvider('ollama', {
                defaultModel: model || process.env.OLLAMA_MODEL || 'llama3.1:latest'
            });
            const ping = await modelProvider.ping();
            if (!ping.available) {
                return res.status(503).json({
                    success: false,
                    status: 'AI_UNAVAILABLE',
                    case_id: cleanCaseId,
                    error: ping.error || 'Local Ollama service unavailable',
                    message: 'Local Ollama daemon is offline or configured model is missing.'
                });
            }
        }

        // 5. Execution Limits Sanitization
        const safeMaxRounds = typeof maxRounds === 'number' && maxRounds >= 1 && maxRounds <= 6
            ? Math.floor(maxRounds)
            : 4;
        const safeDeadlineMs = typeof overallDeadlineMs === 'number' && overallDeadlineMs >= 5000 && overallDeadlineMs <= 120000
            ? Math.floor(overallDeadlineMs)
            : 90000;

        // 6. Agent Loop Execution within Tracing Root Span
        return await telemetry.withSpan(SPAN_NAMES.INVESTIGATION_HTTP_REQUEST, async (rootSpan) => {
            rootSpan.setAttribute(FUSION_AI_ATTRIBUTES.CASE_ID, cleanCaseId);
            rootSpan.setAttribute(FUSION_AI_ATTRIBUTES.INTENT, syntheticCase.intent || 'FAILURE_INVESTIGATION');
            telemetry.recordInvestigationStart({ intent: syntheticCase.intent || 'FAILURE_INVESTIGATION' });
            const reqStart = Date.now();

            const agent = new AgentLoop({
                toolRegistry: defaultToolRegistry,
                modelProvider,
                options: {
                    maxRounds: safeMaxRounds,
                    overallDeadlineMs: safeDeadlineMs
                }
            });

            const dlpContext = createDlpContext();

            const outcome = await agent.run({
                syntheticCase,
                question: cleanQuestion,
                model,
                dlpContext
            });

            const reqDuration = Date.now() - reqStart;
            const isSuccess = outcome.status === 'REPORT_GENERATED';
            telemetry.recordInvestigationEnd(reqDuration, isSuccess, {
                intent: syntheticCase.intent || 'FAILURE_INVESTIGATION',
                status: outcome.status
            });

            rootSpan.setAttribute(FUSION_AI_ATTRIBUTES.STATUS, outcome.status);
            rootSpan.setAttribute(FUSION_AI_ATTRIBUTES.INVESTIGATION_ID, outcome.investigation_id);

            // 7. Response Mapping
            switch (outcome.status) {
                case 'REPORT_GENERATED':
                    return res.status(200).json({
                        success: true,
                        status: 'REPORT_GENERATED',
                        investigation_id: outcome.investigation_id,
                        case_id: cleanCaseId,
                        transaction_id: outcome.transaction_id,
                        intent: outcome.intent,
                        report: outcome.report,
                        trace: outcome.trace,
                        dlp_audit: outcome.dlp_audit || null,
                        metrics: {
                            rounds: outcome.rounds,
                            tool_executions: outcome.tool_executions,
                            latency_ms: outcome.latency_ms
                        },
                        warnings: outcome.warnings || []
                    });

                case 'AI_UNAVAILABLE':
                    return res.status(503).json({
                        success: false,
                        status: 'AI_UNAVAILABLE',
                        investigation_id: outcome.investigation_id,
                        case_id: cleanCaseId,
                        error: outcome.error || 'Local Ollama model unavailable.',
                        latency_ms: outcome.latency_ms
                    });

                case 'MODEL_TIMEOUT':
                case 'DEADLINE_EXCEEDED':
                    return res.status(504).json({
                        success: false,
                        status: outcome.status,
                        investigation_id: outcome.investigation_id,
                        case_id: cleanCaseId,
                        rounds: outcome.rounds,
                        tool_executions: outcome.tool_executions,
                        trace: outcome.trace || [],
                        error: outcome.message || 'Investigation exceeded deadline.',
                        latency_ms: outcome.latency_ms
                    });

                case 'MODEL_OUTPUT_INVALID':
                    return res.status(502).json({
                        success: false,
                        status: 'MODEL_OUTPUT_INVALID',
                        investigation_id: outcome.investigation_id,
                        case_id: cleanCaseId,
                        rounds: outcome.rounds,
                        tool_executions: outcome.tool_executions,
                        trace: outcome.trace || [],
                        error: outcome.message || 'Model output failed schema JSON parsing.',
                        latency_ms: outcome.latency_ms
                    });

                case 'REPORT_VALIDATION_FAILED':
                    return res.status(422).json({
                        success: false,
                        status: 'REPORT_VALIDATION_FAILED',
                        investigation_id: outcome.investigation_id,
                        case_id: cleanCaseId,
                        rounds: outcome.rounds,
                        tool_executions: outcome.tool_executions,
                        trace: outcome.trace || [],
                        validation_errors: outcome.validation_errors || [],
                        candidate_report: outcome.candidate_report || null,
                        latency_ms: outcome.latency_ms
                    });

                default:
                    return res.status(400).json({
                        success: false,
                        status: outcome.status || 'INVESTIGATION_FAILED',
                        investigation_id: outcome.investigation_id,
                        case_id: cleanCaseId,
                        rounds: outcome.rounds,
                        tool_executions: outcome.tool_executions,
                        trace: outcome.trace || [],
                        error: outcome.message || outcome.error || 'Agent investigation could not be completed.'
                    });
            }
        });

    } catch (err) {
        logger.error(`[AI AGENT INVESTIGATE] Unexpected handler error: ${err.message}`);
        return res.status(500).json({
            success: false,
            error: 'INTERNAL_SERVER_ERROR',
            message: 'An unexpected internal error occurred during agentic investigation.'
        });
    }
});

// ── POST /api/ai/agent-investigate/stream (Server-Sent Events) ────────────────
router.post('/agent-investigate/stream', async (req, res) => {
    // Configure SSE Response Headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();

    let clientDisconnected = false;
    req.on('close', () => {
        clientDisconnected = true;
    });

    const sendEvent = (eventType, data = {}) => {
        if (clientDisconnected || res.writableEnded) return;
        try {
            res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
            if (typeof res.flush === 'function') res.flush();
        } catch (err) {
            // Socket write error handled safely
        }
    };

    try {
        const { caseId, question, providerType, model, maxRounds, overallDeadlineMs } = req.body || {};

        if (!caseId) {
            sendEvent('investigation.failed', { error: 'MISSING_CASE_ID', message: 'Field caseId is mandatory.' });
            return res.end();
        }

        const cleanCaseId = sanitizeString(String(caseId).trim(), 30);
        if (!CASE_ID_REGEX.test(cleanCaseId)) {
            sendEvent('investigation.failed', { error: 'INVALID_CASE_ID_FORMAT', message: 'Case ID must match format CASE-XX.' });
            return res.end();
        }

        const syntheticCase = syntheticStore.getCaseById(cleanCaseId);
        if (!syntheticCase) {
            sendEvent('investigation.failed', { error: 'SYNTHETIC_CASE_NOT_FOUND', message: `Unknown synthetic case: ${cleanCaseId}` });
            return res.end();
        }

        let cleanQuestion = syntheticCase.question || '';
        if (question !== undefined && question !== null) {
            if (typeof question !== 'string' || question.length > 500) {
                sendEvent('investigation.failed', { error: 'INVALID_QUESTION', message: 'Question must be a string under 500 characters.' });
                return res.end();
            }
            cleanQuestion = sanitizeString(question, 500);
        }

        const resolvedProviderType = providerType || process.env.AI_PROVIDER_TYPE || 'ollama';
        let modelProvider;

        if (resolvedProviderType === 'mock') {
            modelProvider = createModelProvider('mock');
            if (syntheticCase.forcedProviderStatus) {
                modelProvider.setForcedStatus(syntheticCase.forcedProviderStatus);
            }
        } else {
            modelProvider = createModelProvider('ollama', {
                defaultModel: model || process.env.OLLAMA_MODEL || 'llama3.1:latest'
            });
            const ping = await modelProvider.ping();
            if (!ping.available) {
                sendEvent('investigation.failed', {
                    error: 'AI_UNAVAILABLE',
                    message: ping.error || 'Local Ollama daemon is offline or configured model is missing.'
                });
                return res.end();
            }
        }

        const safeMaxRounds = typeof maxRounds === 'number' && maxRounds >= 1 && maxRounds <= 6
            ? Math.floor(maxRounds)
            : 4;
        const safeDeadlineMs = typeof overallDeadlineMs === 'number' && overallDeadlineMs >= 5000 && overallDeadlineMs <= 120000
            ? Math.floor(overallDeadlineMs)
            : 90000;

        await telemetry.withSpan(SPAN_NAMES.INVESTIGATION_HTTP_REQUEST, async (rootSpan) => {
            rootSpan.setAttribute(FUSION_AI_ATTRIBUTES.CASE_ID, cleanCaseId);
            rootSpan.setAttribute(FUSION_AI_ATTRIBUTES.INTENT, syntheticCase.intent || 'FAILURE_INVESTIGATION');
            telemetry.recordInvestigationStart({ intent: syntheticCase.intent || 'FAILURE_INVESTIGATION' });
            const reqStart = Date.now();
            const traceId = rootSpan.spanContext().traceId;

            sendEvent('investigation.started', {
                case_id: cleanCaseId,
                transaction_id: syntheticCase.transactionId,
                intent: syntheticCase.intent,
                trace_id: traceId
            });

            const agent = new AgentLoop({
                toolRegistry: defaultToolRegistry,
                modelProvider,
                options: {
                    maxRounds: safeMaxRounds,
                    overallDeadlineMs: safeDeadlineMs
                },
                onEvent: (evt) => {
                    sendEvent(evt.type, { ...evt, trace_id: traceId });
                }
            });

            const outcome = await agent.run({
                syntheticCase,
                question: cleanQuestion,
                model: model || null
            });

            const totalDuration = Date.now() - reqStart;
            rootSpan.setAttribute(FUSION_AI_ATTRIBUTES.STATUS, outcome.status);
            telemetry.recordInvestigationEnd(totalDuration, outcome.success, {
                intent: syntheticCase.intent,
                status: outcome.status
            });

            if (outcome.success) {
                sendEvent('investigation.completed', {
                    success: true,
                    status: outcome.status,
                    investigation_id: outcome.investigation_id,
                    case_id: cleanCaseId,
                    transaction_id: syntheticCase.transactionId,
                    intent: outcome.intent,
                    report: outcome.report,
                    trace: outcome.trace || [],
                    metrics: {
                        rounds: outcome.rounds,
                        tool_executions: outcome.tool_executions,
                        latency_ms: outcome.latency_ms
                    },
                    trace_id: traceId
                });
            } else {
                sendEvent('investigation.failed', {
                    success: false,
                    status: outcome.status,
                    investigation_id: outcome.investigation_id,
                    case_id: cleanCaseId,
                    transaction_id: syntheticCase.transactionId,
                    error: outcome.message || outcome.error,
                    validation_errors: outcome.validation_errors || [],
                    trace: outcome.trace || [],
                    trace_id: traceId
                });
            }

            res.end();
        });

    } catch (err) {
        logger.error(`[AI AGENT STREAM] Unexpected error: ${err.message}`);
        sendEvent('investigation.failed', {
            error: 'INTERNAL_SERVER_ERROR',
            message: 'An unexpected internal error occurred during streamed investigation.'
        });
        res.end();
    }
});

// ── GET /api/ai/observability/traces/:traceId ─────────────────────────────────
// Strict boundary: Only accessible via loopback addresses. Rejects external callers even with API keys.
router.get('/observability/traces/:traceId', (req, res) => {
    const isLoopback = [
        '127.0.0.1',
        '::1',
        '::ffff:127.0.0.1',
        'localhost'
    ].includes(req.ip) || [
        '127.0.0.1',
        '::1',
        'localhost'
    ].includes(req.hostname) || (req.socket && [
        '127.0.0.1',
        '::1',
        '::ffff:127.0.0.1'
    ].includes(req.socket.remoteAddress));

    if (!isLoopback) {
        logger.warn(`[AI OBSERVABILITY] Rejection: trace endpoint accessed from non-loopback IP ${req.ip}`);
        return res.status(403).json({
            success: false,
            error: 'FORBIDDEN',
            message: 'Observability trace endpoint is strictly restricted to local loopback diagnostics.'
        });
    }

    const { traceId } = req.params;
    if (!traceId || !/^[a-f0-9]{32}$/i.test(traceId.trim())) {
        return res.status(400).json({
            success: false,
            error: 'INVALID_TRACE_ID',
            message: 'Trace ID must be a valid 32-character hexadecimal string.'
        });
    }

    const cleanTraceId = traceId.trim().toLowerCase();
    const spans = telemetry.localExporter.getSpansByTraceId(cleanTraceId);

    if (!spans || spans.length === 0) {
        return res.status(404).json({
            success: false,
            error: 'TRACE_NOT_FOUND',
            message: `No active or finished spans found for trace ID: ${cleanTraceId}. Note: In-memory ring buffer retains the latest 200 spans.`
        });
    }

    const spanMap = new Map();
    spans.forEach(s => spanMap.set(s.spanContext().spanId, s));

    const ALLOWED_ATTRIBUTE_KEYS = new Set([
        'gen_ai.system',
        'gen_ai.request.model',
        'gen_ai.response.model',
        'gen_ai.operation.name',
        'gen_ai.usage.input_tokens',
        'gen_ai.usage.output_tokens',
        'fusion.ai.investigation_id',
        'fusion.ai.case_id',
        'fusion.ai.intent',
        'fusion.ai.status',
        'fusion.ai.error_type',
        'fusion.ai.agent.round',
        'fusion.ai.tool.name',
        'fusion.ai.tool.status',
        'fusion.ai.tool.result_bytes',
        'fusion.ai.rag.provider',
        'fusion.ai.rag.top_k',
        'fusion.ai.rag.candidate_chunks',
        'fusion.ai.rag.returned_chunks',
        'fusion.ai.rag.match_type'
    ]);

    const sanitizedSpans = spans.map(s => {
        const spanId = s.spanContext().spanId;
        const parentId = s.parentSpanId || null;
        const parentSpan = parentId ? spanMap.get(parentId) : null;
        const parentName = parentSpan ? parentSpan.name : null;

        // Calculate duration in ms from hrtime
        let durationMs = 0;
        if (s.duration && Array.isArray(s.duration)) {
            durationMs = s.duration[0] * 1000 + (s.duration[1] / 1e6);
        }

        // Filter attributes to strictly allowlisted safe telemetry keys
        const safeAttrs = {};
        if (s.attributes && typeof s.attributes === 'object') {
            for (const [k, v] of Object.entries(s.attributes)) {
                if (ALLOWED_ATTRIBUTE_KEYS.has(k)) {
                    safeAttrs[k] = v;
                }
            }
        }

        return {
            span_id: spanId,
            trace_id: s.spanContext().traceId,
            name: s.name,
            parent_span_id: parentId,
            parent_name: parentName,
            duration_ms: Math.round(durationMs * 100) / 100,
            status: s.status ? (s.status.code === 1 ? 'OK' : s.status.code === 2 ? 'ERROR' : 'UNSET') : 'OK',
            attributes: safeAttrs
        };
    });

    const rootSpan = sanitizedSpans.find(s => !s.parent_span_id);
    const totalDurationMs = rootSpan ? rootSpan.duration_ms : sanitizedSpans.reduce((acc, s) => Math.max(acc, s.duration_ms), 0);

    return res.status(200).json({
        success: true,
        trace_id: cleanTraceId,
        spans_count: sanitizedSpans.length,
        total_duration_ms: totalDurationMs,
        spans: sanitizedSpans
    });
});

// ── GET /api/ai/observability/metrics ─────────────────────────────────────────
// Strict boundary: Only accessible via loopback addresses. Rejects external callers even with API keys.
router.get('/observability/metrics', (req, res) => {
    const isLoopback = [
        '127.0.0.1',
        '::1',
        '::ffff:127.0.0.1',
        'localhost'
    ].includes(req.ip) || [
        '127.0.0.1',
        '::1',
        'localhost'
    ].includes(req.hostname) || (req.socket && [
        '127.0.0.1',
        '::1',
        '::ffff:127.0.0.1'
    ].includes(req.socket.remoteAddress));

    if (!isLoopback) {
        logger.warn(`[AI OBSERVABILITY] Rejection: metrics endpoint accessed from non-loopback IP ${req.ip}`);
        return res.status(403).json({
            success: false,
            error: 'FORBIDDEN',
            message: 'Observability metrics endpoint is strictly restricted to local loopback diagnostics.'
        });
    }

    try {
        const summary = telemetry.getMetricsSummary();
        return res.status(200).json({
            success: true,
            telemetry: summary
        });
    } catch (err) {
        logger.error(`[AI OBSERVABILITY] Error fetching metrics: ${err.message}`);
        return res.status(500).json({
            success: false,
            error: 'INTERNAL_ERROR',
            message: 'Unable to retrieve telemetry metrics summary.'
        });
    }
});

module.exports = router;
