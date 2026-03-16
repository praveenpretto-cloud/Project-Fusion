const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const router = express.Router();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

/**
 * MOCK KYC ONBOARDING ENDPOINT (FOR SANDBOX)
 * In production, this would integrate with Setu or Signzy.
 * For the sandbox, it validates basic input, creates a user,
 * and marks them as VERIFIED.
 */
router.post('/onboard', async (req, res) => {
    const { user_id, document_type, document_number } = req.body;

    if (!user_id || !document_type || !document_number) {
        return res.status(400).json({ error: 'Missing required onboarding fields' });
    }

    try {
        // 1. Simulate API Call to Setu / Signzy
        // (Wait 500ms to simulate network latency)
        await new Promise((resolve) => setTimeout(resolve, 500));

        // 2. Hash the PII (Never store raw document numbers per RBI)
        crypto.createHash('sha256').update(document_number).digest('hex');

        // 3. Generate a mock reference ID from the provider
        const kycReferenceId = `kyc_${crypto.randomUUID()}`;

        // 4. Store verification in database
        const result = await pool.query(
            `INSERT INTO users (user_id, kyc_status, kyc_verified_at, reference_id) 
             VALUES ($1, 'VERIFIED', NOW(), $2) 
             ON CONFLICT (user_id) 
             DO UPDATE SET kyc_status = 'VERIFIED', kyc_verified_at = NOW(), reference_id = $2
             RETURNING user_id, kyc_status, kyc_verified_at`,
            [user_id, kycReferenceId]
        );

        // Also create starting balances for sandbox testing purposes
        const sandboxCurrencies = ['SGD', 'USD', 'EUR', 'GBP', 'INR', 'BTC', 'XLM', 'ETH'];
        for (const curr of sandboxCurrencies) {
            await pool.query(
                `INSERT INTO balances (account_id, currency, balance) VALUES ($1, $2, 50000.00) ON CONFLICT DO NOTHING`,
                [user_id, curr]
            );
        }

        res.json({
            message: 'User successfully onboarded and KYC verified',
            user: result.rows[0],
            // DO NOT RETURN RAW PII
        });
    } catch (err) {
        console.error('[KYC API] Error during onboarding:', err);
        res.status(500).json({ error: 'Failed to process KYC onboarding' });
    }
});

module.exports = router;
