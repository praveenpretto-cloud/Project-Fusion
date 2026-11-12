'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * NON-CUSTODIAL CONNECTED BANK API MODULE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Connected Banking Model: Fusion does NOT store or manage customer funds.
 * There is no "Top Up" wallet.
 *
 * Fusion aggregates balances directly from the SME's actual connected bank
 * accounts (e.g., ICICI, HDFC, RazorpayX) using Account Aggregator rails.
 *
 * Endpoints:
 *   GET  /api/virtual-account/balance   — Aggregated balance of all connected banks
 *   GET  /api/virtual-account/all-balances — Breakdowns per bank
 */

const express = require('express');
const router = express.Router();

function getPool(req) {
    return req.app.locals.pool;
}

// =====================================================
// GET /api/virtual-account/balance
// Returns the user's current Aggregated Bank Balance.
// =====================================================
router.get('/balance', async (req, res) => {
    const pool = getPool(req);
    const logger = req.app.locals.logger;
    const { user_id, currency = 'INR' } = req.query;

    if (!user_id) {
        return res.status(400).json({ error: 'user_id query param is required' });
    }

    try {
        // Map legacy user_id to business_id (using the first business as default)
        const bizRes = await pool.query(`SELECT business_id FROM businesses LIMIT 1`);
        if (bizRes.rows.length === 0) return res.json({ virtual_balance: 0 });
        const businessId = bizRes.rows[0].business_id;

        // Sum the latest balance of all active connected bank accounts
        const result = await pool.query(
            `
            SELECT SUM(latest_balance) AS total_balance
            FROM (
                SELECT COALESCE(
                    (SELECT t.balance_after
                     FROM bank_transactions t
                     WHERE t.account_id = a.account_id AND t.balance_after IS NOT NULL
                     ORDER BY t.txn_date DESC, t.imported_at DESC LIMIT 1), 0
                ) AS latest_balance
                FROM business_bank_accounts a
                WHERE a.business_id = $1 AND a.is_active = TRUE
            ) subq
        `,
            [businessId]
        );

        // If no bank transactions exist, fallback to 0 or a simulated initial balance for demo
        let aggregated_balance = result.rows[0].total_balance
            ? parseFloat(result.rows[0].total_balance)
            : 0;

        // [SIMULATION] If totally zero, simulate a connected bank balance for the demo UI
        if (aggregated_balance === 0) aggregated_balance = 2500000;

        res.json({
            user_id: user_id,
            currency,
            virtual_balance: aggregated_balance, // Renamed for legacy UI compatibility
            last_updated: new Date().toISOString(),
            status: 'CONNECTED_BANK_AGGREGATION',
        });
    } catch (err) {
        logger.error(`[CONNECTED_BANK ERROR] Balance query failed: ${err.message}`);
        res.status(500).json({ error: 'Balance lookup failed' });
    }
});

// =====================================================
// GET /api/virtual-account/all-balances
// Returns all connected bank balances for the dashboard.
// =====================================================
router.get('/all-balances', async (req, res) => {
    const pool = getPool(req);
    const logger = req.app.locals.logger;

    try {
        const bizRes = await pool.query(`SELECT business_id FROM businesses LIMIT 1`);
        const businessId = bizRes.rows.length > 0 ? bizRes.rows[0].business_id : null;

        let data = [];
        if (businessId) {
            const result = await pool.query(
                `
                SELECT a.bank_name AS account_id, 'INR' AS currency, 
                       COALESCE(
                           (SELECT t.balance_after
                            FROM bank_transactions t
                            WHERE t.account_id = a.account_id AND t.balance_after IS NOT NULL
                            ORDER BY t.txn_date DESC, t.imported_at DESC LIMIT 1), 0
                       ) AS virtual_balance,
                       NOW() AS updated_at
                FROM business_bank_accounts a
                WHERE a.business_id = $1 AND a.is_active = TRUE
            `,
                [businessId]
            );
            data = result.rows;
        }

        // [SIMULATION]
        if (data.length === 0) {
            data = [
                {
                    account_id: 'ICICI Current *8821',
                    currency: 'INR',
                    virtual_balance: 1500000,
                    updated_at: new Date().toISOString(),
                },
                {
                    account_id: 'HDFC Nodal *4401',
                    currency: 'INR',
                    virtual_balance: 1000000,
                    updated_at: new Date().toISOString(),
                },
            ];
        }

        res.json({
            status: 'success',
            data: data,
            timestamp: new Date().toISOString(),
        });
    } catch (err) {
        logger.error(`[CONNECTED_BANK ERROR] All-balances query failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to fetch connected balances' });
    }
});

// Deprecated endpoint - returns 400
router.post('/top-up', (req, res) => {
    res.status(400).json({
        error: 'Project Fusion is Non-Custodial. Wallet top-ups are not supported. Please link a corporate bank account.',
    });
});

module.exports = router;
