'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const logger = require('../logger');
const { evaluateVelocity } = require('../core/cashiq/velocityEngine');

// Mock WebAuthn library functions for the demo
// In production, we'd use @simplewebauthn/server
function generateAuthenticationOptions(user) {
    return {
        challenge: crypto.randomBytes(32).toString('base64url'),
        timeout: 60000,
        userVerification: 'required',
        allowCredentials: [
            {
                id: user.webauthn_credential_id,
                type: 'public-key',
                transports: ['internal'],
            },
        ],
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBAUTHN ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/auth/webauthn/generate-options', async (req, res) => {
    const pool = req.app.locals.pool;
    const userId = req.headers['x-user-id'] || 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // Default to CFO/Checker

    try {
        const userRes = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
        if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });

        const user = userRes.rows[0];

        // If user has no credentials registered, we would normally do registration here.
        // For the demo, we assume they have a credential setup (or we bypass it).
        const options = generateAuthenticationOptions(user);

        // Store challenge in DB or session (mocking by sending back)
        res.json(options);
    } catch (err) {
        logger.error(`[WEBAUTHN] Error generating options: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

router.post('/auth/webauthn/verify', async (req, res) => {
    const pool = req.app.locals.pool;
    const { instructionId } = req.body;
    const userId = req.headers['x-user-id'] || 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const ipAddress = req.ip || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'Unknown';

    try {
        // 1. Verify cryptographic signature (Mocked success for demo)
        const isVerified = true;
        if (!isVerified) return res.status(401).json({ error: 'Invalid WebAuthn signature' });

        // 2. Fetch the instruction
        const instRes = await pool.query('SELECT * FROM instructions WHERE instruction_id = $1', [
            instructionId,
        ]);
        if (instRes.rows.length === 0)
            return res.status(404).json({ error: 'Instruction not found' });
        const instruction = instRes.rows[0];

        // 3. Log the approval in instruction_approvals
        await pool.query(
            `INSERT INTO instruction_approvals (instruction_id, checker_id, auth_method, ip_address, user_agent)
             VALUES ($1, $2, 'WEBAUTHN', $3, $4)`,
            [instructionId, userId, ipAddress, userAgent]
        );

        // 4. Check how many approvals we have
        const appRes = await pool.query(
            'SELECT COUNT(*) as count FROM instruction_approvals WHERE instruction_id = $1',
            [instructionId]
        );
        const currentApprovals = parseInt(appRes.rows[0].count);

        if (currentApprovals >= instruction.required_approvals) {
            // All required approvals met! Transition to INITIATED to be picked up by Saga Engine
            await pool.query(
                "UPDATE instructions SET state = 'INITIATED', updated_at = NOW() WHERE instruction_id = $1",
                [instructionId]
            );
            logger.info(
                `[APPROVAL] Instruction ${instructionId} fully approved. Transitioning to INITIATED.`
            );
            res.json({
                success: true,
                message: 'Payment fully approved and queued for execution.',
                status: 'INITIATED',
            });
        } else {
            logger.info(
                `[APPROVAL] Instruction ${instructionId} approved by ${userId}. Needs ${instruction.required_approvals - currentApprovals} more.`
            );
            res.json({
                success: true,
                message: `Approval recorded. Requires ${instruction.required_approvals - currentApprovals} more checker(s).`,
                status: 'PENDING_APPROVAL',
            });
        }
    } catch (err) {
        logger.error(`[WEBAUTHN] Error verifying signature: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP WEBHOOK (Maker requests payment via WhatsApp)
// ─────────────────────────────────────────────────────────────────────────────

router.post('/webhook', async (req, res) => {
    const pool = req.app.locals.pool;
    // Format from Twilio or Meta Graph API
    const { Body, From } = req.body;

    logger.info(`[WHATSAPP] Received message from ${From}: ${Body}`);

    // In a real scenario, the LLM parses this. For the demo, we mock the extraction.
    // E.g., Body: "Pay Vendor XYZ 6000000"
    const amountMatch = Body ? Body.match(/\d+/) : null;
    const amount = amountMatch ? parseFloat(amountMatch[0]) : 50000;
    const businessId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // Mock business

    try {
        // 1. Evaluate Velocity
        const velocity = await evaluateVelocity(pool, businessId, amount);
        const requiredApprovals = velocity.requiresTwoCheckers ? 2 : 1;

        // 2. Create the PENDING_APPROVAL instruction
        const insertRes = await pool.query(
            `
            INSERT INTO instructions (sender, recipient, amount, currency, state, required_approvals, purpose, source)
            VALUES ($1, 'dummy-vendor-id', $2, 'INR', 'PENDING_APPROVAL', $3, 'WhatsApp Payout', 'WHATSAPP')
            RETURNING instruction_id
        `,
            [businessId, amount, requiredApprovals]
        );

        const instructionId = insertRes.rows[0].instruction_id;

        // 3. Trigger WhatsApp interactive message back to the Checker (Founder)
        const magicLink = `http://localhost:3000/approve/${instructionId}`;

        logger.info(
            `[WHATSAPP] Created PENDING_APPROVAL payout ${instructionId}. Required Approvals: ${requiredApprovals}. Link: ${magicLink}`
        );

        // Normally we'd do a POST to Meta's WhatsApp API here to send the template.

        res.json({ success: true, instructionId, magicLink, requiredApprovals });
    } catch (err) {
        logger.error(`[WHATSAPP] Webhook error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
