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
 * WORKSTREAM 0 CONTAINMENT:
 * Unauthenticated KYC onboarding and synthetic balance faucet endpoint is permanently disabled.
 * No customer creation or balance crediting is permitted through prototype routes.
 */
router.post('/onboard', (req, res) => {
    return res.status(503).json({
        error: 'KYC onboarding and synthetic balance faucet endpoint is disabled pending security upgrade (Workstream 0 containment).',
    });
});

module.exports = router;
