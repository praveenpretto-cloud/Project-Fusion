const express = require('express');
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
 * GENERATE OTP (Additional Factor of Authentication)
 * Generates a 6-digit OTP and logs it to console (simulating SMS delivery).
 */
router.post('/otp/generate', async (req, res) => {
    const { user_id } = req.body;

    if (!user_id) {
        return res.status(400).json({ error: 'Missing user_id' });
    }

    try {
        // Verify user exists and is KYC verified
        const userCheck = await pool.query('SELECT kyc_status FROM users WHERE user_id = $1', [
            user_id,
        ]);

        if (userCheck.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (userCheck.rows[0].kyc_status !== 'VERIFIED') {
            return res
                .status(403)
                .json({ error: 'User KYC is not verified. Complete onboarding first.' });
        }

        // Generate 6-digit OTP
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

        // Expiry 5 minutes from now
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

        const result = await pool.query(
            `INSERT INTO otps (user_id, otp_code, expires_at) VALUES ($1, $2, $3) RETURNING id`,
            [user_id, otpCode, expiresAt]
        );

        // DELIVER OTP (Simulation)
        console.log(`\n======================================`);
        console.log(`[SMS GATEWAY] Delivering OTP: ${otpCode}`);
        console.log(`Target: User ${user_id}`);
        console.log(`Expires: ${expiresAt.toISOString()}`);
        console.log(`======================================\n`);

        res.json({
            message: 'OTP generated and sent successfully',
            otp_id: result.rows[0].id,
            otp_code: otpCode, // DEMO PURPOSE: Return to frontend for automated AFA handshake
            expires_at: expiresAt,
        });
    } catch (err) {
        console.error('[OTP API] Error generating OTP:', err);
        res.status(500).json({ error: 'Failed to generate OTP' });
    }
});

/**
 * VERIFY OTP
 * Validates the OTP code against the database.
 * If successful, returns an auth_token to be used for transaction initiation.
 */
router.post('/otp/verify', async (req, res) => {
    const { user_id, otp_code } = req.body;

    if (!user_id || !otp_code) {
        return res.status(400).json({ error: 'Missing user_id or otp_code' });
    }

    try {
        // Find the latest active OTP for this user
        const result = await pool.query(
            `SELECT id, otp_code, expires_at, verified 
             FROM otps 
             WHERE user_id = $1 AND verified = FALSE 
             ORDER BY created_at DESC LIMIT 1`,
            [user_id]
        );

        if (result.rows.length === 0) {
            return res
                .status(400)
                .json({ error: 'No active OTP found. Please request a new one.' });
        }

        const otpRecord = result.rows[0];

        // Check expiry
        if (new Date() > otpRecord.expires_at) {
            return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
        }

        // Verify code
        if (otpRecord.otp_code !== otp_code) {
            return res.status(401).json({ error: 'Invalid OTP code' });
        }

        // Mark as verified
        await pool.query('UPDATE otps SET verified = TRUE WHERE id = $1', [otpRecord.id]);

        // Generate transient Auth Token representing successful AFA
        // In a real system, this could be a signed JWT. Here, we use the verified OTP's ID.
        const authToken = `afat_${otpRecord.id}`;

        res.json({
            message: 'OTP verified successfully. Proceed to transaction initiation.',
            auth_token: authToken,
        });
    } catch (err) {
        console.error('[OTP API] Error verifying OTP:', err);
        res.status(500).json({ error: 'Failed to verify OTP' });
    }
});

module.exports = router;
