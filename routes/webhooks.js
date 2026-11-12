'use strict';

/**
 * PROJECT FUSION — WEBHOOK ROUTER
 * =================================
 * Dedicated endpoints for Stripe test mode and RazorpayX sandbox webhooks.
 * Enforces raw body preservation, cryptographic HMAC signature verification,
 * and persistent deduplication.
 */

const express = require('express');
const router = express.Router();
const logger = require('../logger');
const {
    verifyStripeSignature,
    verifyRazorpayXSignature,
    processWebhookEvent,
} = require('../core/webhooks/webhookProcessor');

/**
 * Helper to obtain the database pool from request context or app.locals.
 */
function getPool(req) {
    return req.app?.locals?.pool || req.pool;
}

/**
 * Extract raw body buffer from request.
 */
function getRawBody(req) {
    if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
    if (typeof req.rawBody === 'string') return Buffer.from(req.rawBody, 'utf8');
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
    if (req.body && typeof req.body === 'object') {
        return Buffer.from(JSON.stringify(req.body), 'utf8');
    }
    return Buffer.from('', 'utf8');
}

/**
 * STRIPE WEBHOOK HANDLER
 * POST /api/webhooks/stripe
 */
async function handleStripeWebhook(req, res) {
    const signature = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!signature) {
        logger.warn('[STRIPE WEBHOOK] ❌ Missing Stripe-Signature header');
        return res.status(400).json({ error: 'Missing Stripe-Signature header' });
    }

    if (!secret) {
        logger.error('[STRIPE WEBHOOK] ❌ STRIPE_WEBHOOK_SECRET is not configured');
        return res.status(500).json({ error: 'Webhook secret is not configured' });
    }

    const rawBody = getRawBody(req);
    let event;
    try {
        event = verifyStripeSignature(rawBody, signature, secret);
    } catch (err) {
        logger.warn(`[STRIPE WEBHOOK] ❌ Verification failed: ${err.message}`);
        return res.status(err.statusCode || 400).json({ error: err.message });
    }

    const pool = getPool(req);
    if (!pool) {
        logger.error('[STRIPE WEBHOOK] ❌ Database connection pool is unavailable');
        return res.status(500).json({ error: 'Database pool unavailable' });
    }

    const eventId = event.id;
    const eventType = event.type;
    const obj = event.data?.object || {};
    // For refund and charge events, obj.payment_intent links to parent PaymentIntent
    const intentId =
        obj.payment_intent ||
        (obj.object === 'payment_intent' ? obj.id : obj.id?.startsWith('pi_') ? obj.id : obj.id);
    const instructionId = obj.metadata?.instruction_id || obj.metadata?.instructionId;
    const failureReason = obj.last_payment_error?.message || 'Stripe payment failed';

    const result = await processWebhookEvent({
        pool,
        provider: 'STRIPE',
        eventId,
        eventType,
        intentId,
        instructionId,
        rawBody,
        payload: event,
        failureReason,
    });

    return res.status(result.status).json(result.body);
}

/**
 * RAZORPAYX WEBHOOK HANDLER
 * POST /api/webhooks/razorpay
 */
async function handleRazorpayWebhook(req, res) {
    const signature = req.headers['x-razorpay-signature'] || req.headers['X-Razorpay-Signature'];
    const secret = process.env.RAZORPAYX_WEBHOOK_SECRET;

    if (!signature) {
        logger.warn('[RAZORPAYX WEBHOOK] ❌ Missing X-Razorpay-Signature header');
        return res.status(400).json({ error: 'Missing X-Razorpay-Signature header' });
    }

    if (!secret) {
        logger.error('[RAZORPAYX WEBHOOK] ❌ RAZORPAYX_WEBHOOK_SECRET is not configured');
        return res.status(500).json({ error: 'Webhook secret is not configured' });
    }

    const rawBody = getRawBody(req);
    let isValid = false;
    try {
        isValid = verifyRazorpayXSignature(rawBody, signature, secret);
    } catch (err) {
        logger.error(`[RAZORPAYX WEBHOOK] ❌ Configuration/Security error: ${err.message}`);
        return res.status(err.statusCode || 500).json({ error: err.message });
    }

    if (!isValid) {
        logger.warn('[RAZORPAYX WEBHOOK] ❌ Invalid RazorpayX signature detected');
        return res.status(400).json({ error: 'Invalid RazorpayX signature' });
    }

    // Event ID extraction: Never generate using Date.now()! Missing ID is rejected.
    let payload = req.body;
    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch {
            payload = {};
        }
    }

    const eventId = req.headers['x-razorpay-event-id'] || payload?.event_id || payload?.id;
    if (!eventId) {
        logger.warn('[RAZORPAYX WEBHOOK] ❌ Missing event identifier');
        return res.status(400).json({ error: 'Missing required webhook event identifier' });
    }

    const pool = getPool(req);
    if (!pool) {
        logger.error('[RAZORPAYX WEBHOOK] ❌ Database connection pool is unavailable');
        return res.status(500).json({ error: 'Database pool unavailable' });
    }

    const eventType = payload?.event || payload?.type || 'payout.unknown';
    const payoutEntity =
        payload?.payload?.payout?.entity || payload?.payload?.payment?.entity || {};
    const intentId = payoutEntity.id || payload?.intent_id;
    const instructionId = payoutEntity.notes?.instruction_id || payoutEntity.reference_id;
    const failureReason =
        payoutEntity.status_details?.description ||
        payoutEntity.error?.description ||
        'RazorpayX payout failed';

    const result = await processWebhookEvent({
        pool,
        provider: 'RAZORPAYX',
        eventId,
        eventType,
        intentId,
        instructionId,
        rawBody,
        payload,
        failureReason,
    });

    return res.status(result.status).json(result.body);
}

/**
 * LEGACY GATEWAY WEBHOOK (NON-MUTATING)
 * POST /api/webhooks/gateway
 * Maintained non-mutating for security until compatibility requirements are reviewed.
 */
async function handleLegacyGatewayWebhook(req, res) {
    logger.warn(
        '[LEGACY WEBHOOK] ⚠️ Request received on deprecated non-mutating endpoint /api/webhooks/gateway. No state changes applied.'
    );
    return res.status(200).json({
        received: true,
        mutated: false,
        warning:
            'Legacy gateway endpoint is non-mutating for security. Use signed provider endpoints /api/webhooks/stripe or /api/webhooks/razorpay.',
    });
}

// Router Bindings
router.post('/stripe', handleStripeWebhook);
router.post('/razorpay', handleRazorpayWebhook);
router.post('/gateway', handleLegacyGatewayWebhook);

module.exports = {
    router,
    handleStripeWebhook,
    handleRazorpayWebhook,
    handleLegacyGatewayWebhook,
    getRawBody,
    getPool,
};
