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
 * WORKSTREAM 0 CONTAINMENT:
 * Insecure plaintext OTP exposure, console delivery, and database-identifier pseudo-tokens
 * are permanently disabled. Public authentication routes return safe unavailable responses
 * pending Phase AI-2A enterprise identity and session implementation.
 */
router.post('/otp/generate', (req, res) => {
    return res.status(503).json({
        error: 'OTP generation service is temporarily disabled pending security upgrade (Workstream 0 containment / AI-2A).',
    });
});

router.post('/otp/verify', (req, res) => {
    return res.status(503).json({
        error: 'OTP verification service is temporarily disabled pending security upgrade (Workstream 0 containment / AI-2A).',
    });
});

module.exports = router;
