'use strict';

/**
 * api/cashiq.js — CashIQ Intelligence API
 * =========================================
 * All routes mounted at /api/cashiq
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const logger = require('../logger');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const { getCashSnapshot, getTransactions } = require('../core/cashiq/cashPositionService');
const { importBankStatementCSV } = require('../adapters/aaStub');
const { syncObligationsFromZoho } = require('../adapters/zohoAdapter');
const { runSentinelSweep } = require('../core/cashiq/cashSentinel');

// ── HELPERS ──────────────────────────────────────────────────────────────────
function ok(res, data, status = 200) {
    return res.status(status).json({ success: true, timestamp: new Date().toISOString(), ...data });
}
function fail(res, message, detail = null, status = 400) {
    return res
        .status(status)
        .json({ success: false, error: message, detail, timestamp: new Date().toISOString() });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cashiq/businesses — list all businesses
// ─────────────────────────────────────────────────────────────────────────────
router.get('/businesses', async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        const r = await pool.query(
            `SELECT b.business_id, b.name, b.gstin, b.incorporation_type, b.industry, b.city,
                    c.name AS ca_name, b.onboarded_at, b.whatsapp_config
             FROM businesses b LEFT JOIN ca_profiles c ON c.ca_id = b.ca_id
             ORDER BY b.onboarded_at DESC`
        );
        return ok(res, { businesses: r.rows, total: r.rows.length });
    } catch (err) {
        logger.error(`[CASHIQ] GET /businesses: ${err.message}`);
        return fail(res, 'Failed to fetch businesses', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cashiq/consolidated/dashboard — Holding Company master dashboard
// ─────────────────────────────────────────────────────────────────────────────
router.get('/consolidated/dashboard', async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        // 1. Get all businesses
        const bizQuery = `SELECT business_id, name, industry, city FROM businesses ORDER BY onboarded_at ASC`;
        const bizResult = await pool.query(bizQuery);
        const businesses = bizResult.rows;

        // 2. Get balances per business
        const balQuery = `
            SELECT
                a.business_id,
                SUM(
                    COALESCE(
                        (SELECT t.balance_after
                         FROM bank_transactions t
                         WHERE t.account_id = a.account_id AND t.balance_after IS NOT NULL
                         ORDER BY t.txn_date DESC, t.imported_at DESC LIMIT 1),
                        0
                    )
                ) as total_balance
            FROM business_bank_accounts a
            WHERE a.is_active = TRUE
            GROUP BY a.business_id
        `;
        const balResult = await pool.query(balQuery);
        const balMap = balResult.rows.reduce(
            (acc, row) => ({ ...acc, [row.business_id]: Number(row.total_balance) }),
            {}
        );

        // 3. Get 30d cash flows per business
        const flowQuery = `
            SELECT business_id, direction, SUM(amount) as total_amount
            FROM bank_transactions
            WHERE txn_date >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY business_id, direction
        `;
        const flowResult = await pool.query(flowQuery);
        const flowMap = {};
        flowResult.rows.forEach((row) => {
            if (!flowMap[row.business_id]) flowMap[row.business_id] = { inflow: 0, outflow: 0 };
            if (row.direction === 'CREDIT')
                flowMap[row.business_id].inflow = Number(row.total_amount);
            if (row.direction === 'DEBIT')
                flowMap[row.business_id].outflow = Number(row.total_amount);
        });

        // 4. Get unpaid obligations per business
        const obQuery = `
            SELECT business_id, obligation_type, SUM(amount) as total_amount
            FROM obligations
            WHERE status != 'PAID'
            GROUP BY business_id, obligation_type
        `;
        const obResult = await pool.query(obQuery);
        const obMap = {};
        obResult.rows.forEach((row) => {
            if (!obMap[row.business_id]) obMap[row.business_id] = { ap: 0, ar: 0 };
            if (row.obligation_type === 'PAYABLE')
                obMap[row.business_id].ap = Number(row.total_amount);
            if (row.obligation_type === 'RECEIVABLE')
                obMap[row.business_id].ar = Number(row.total_amount);
        });

        // Combine into unified structure
        let totalLiquidity = 0;
        let totalInflow = 0;
        let totalOutflow = 0;
        let totalAP = 0;
        let totalAR = 0;

        const entities = businesses.map((b) => {
            const balance = balMap[b.business_id] || 0;
            const inflow = flowMap[b.business_id]?.inflow || 0;
            const outflow = flowMap[b.business_id]?.outflow || 0;
            const ap = obMap[b.business_id]?.ap || 0;
            const ar = obMap[b.business_id]?.ar || 0;

            totalLiquidity += balance;
            totalInflow += inflow;
            totalOutflow += outflow;
            totalAP += ap;
            totalAR += ar;

            return {
                business_id: b.business_id,
                name: b.name,
                industry: b.industry,
                metrics: { balance, inflow, outflow, ap, ar },
            };
        });

        // Calculate Global Runway
        const avgDailyBurn = totalOutflow / 30;
        const globalRunwayDays = avgDailyBurn > 0 ? Math.floor(totalLiquidity / avgDailyBurn) : 999;

        return ok(res, {
            global_metrics: {
                total_liquidity: totalLiquidity,
                total_inflow_30d: totalInflow,
                total_outflow_30d: totalOutflow,
                net_cashflow_30d: totalInflow - totalOutflow,
                total_ap: totalAP,
                total_ar: totalAR,
                global_runway_days: globalRunwayDays,
            },
            entities,
        });
    } catch (err) {
        logger.error(`[CASHIQ] GET /consolidated/dashboard: ${err.message}`);
        return fail(res, 'Failed to fetch consolidated dashboard', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cashiq/onboard-business — create a new business
// ─────────────────────────────────────────────────────────────────────────────
router.post('/onboard-business', async (req, res) => {
    const pool = req.app.locals.pool;
    const { name, gstin, incorporation_type, industry, city, ca_id } = req.body;

    if (!name) return fail(res, 'Business name is required');

    try {
        const r = await pool.query(
            `INSERT INTO businesses (name, gstin, incorporation_type, industry, city, ca_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING business_id, name, gstin, city, onboarded_at`,
            [
                name,
                gstin || null,
                incorporation_type || null,
                industry || null,
                city || null,
                ca_id || null,
            ]
        );
        const biz = r.rows[0];

        // Seed default alert rules
        await pool.query(
            `INSERT INTO alert_rules (business_id, rule_type, threshold_value, threshold_days, is_active)
             VALUES
               ($1, 'LOW_BALANCE',     100000, NULL, TRUE),
               ($1, 'LARGE_DEBIT',     NULL,   NULL, TRUE),
               ($1, 'UPCOMING_GST',    NULL,   3,    TRUE),
               ($1, 'UPCOMING_EMI',    NULL,   5,    TRUE),
               ($1, 'OVERDUE_INVOICE', NULL,   NULL, TRUE)`,
            [biz.business_id]
        );

        logger.info(`[CASHIQ] New business onboarded: ${biz.name} (${biz.business_id})`);
        return ok(
            res,
            { business: biz, message: `${biz.name} onboarded with default alert rules.` },
            201
        );
    } catch (err) {
        if (err.message.includes('unique') || err.message.includes('duplicate')) {
            return fail(res, 'A business with this GSTIN already exists', null, 409);
        }
        logger.error(`[CASHIQ] onboard-business: ${err.message}`);
        return fail(res, 'Failed to onboard business', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cashiq/:businessId/snapshot — full cash snapshot
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:businessId/snapshot', async (req, res) => {
    const pool = req.app.locals.pool;
    const { businessId } = req.params;
    const { from, to } = req.query;

    try {
        const snapshot = await getCashSnapshot(pool, businessId, { from, to });
        if (!snapshot) return fail(res, 'Business not found', null, 404);
        return ok(res, { snapshot });
    } catch (err) {
        logger.error(`[CASHIQ] snapshot error: ${err.message}`);
        return fail(res, 'Failed to generate cash snapshot', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cashiq/:businessId/historical-trends
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:businessId/historical-trends', async (req, res) => {
    const pool = req.app.locals.pool;
    const { businessId } = req.params;
    try {
        const result = await pool.query(
            `
            SELECT 
                TO_CHAR(txn_date, 'YYYY-MM') as month,
                SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) as inflow,
                SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) as outflow
            FROM bank_transactions
            WHERE business_id = $1 AND txn_date >= CURRENT_DATE - INTERVAL '36 months'
            GROUP BY TO_CHAR(txn_date, 'YYYY-MM')
            ORDER BY month ASC
        `,
            [businessId]
        );
        return ok(res, { trends: result.rows });
    } catch (err) {
        logger.error(`[CASHIQ] historical-trends error: ${err.message}`);
        return fail(res, 'Failed to fetch historical trends', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cashiq/:businessId/fx-exposures
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:businessId/fx-exposures', async (req, res) => {
    const pool = req.app.locals.pool;
    const { businessId } = req.params;
    try {
        const result = await pool.query(
            `
            SELECT 
                exposure_id, vendor_name, currency, foreign_amount, 
                base_rate, current_rate, target_date, status,
                (foreign_amount * base_rate) as base_inr_value,
                (foreign_amount * current_rate) as current_inr_value,
                ((foreign_amount * current_rate) - (foreign_amount * base_rate)) as unrealized_loss
            FROM fx_exposures
            WHERE business_id = $1 AND status = 'OPEN'
            ORDER BY target_date ASC
        `,
            [businessId]
        );
        return ok(res, { exposures: result.rows });
    } catch (err) {
        logger.error(`[CASHIQ] fx-exposures error: ${err.message}`);
        return fail(res, 'Failed to fetch fx exposures', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cashiq/:businessId/transactions — paginated transaction feed
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:businessId/transactions', async (req, res) => {
    const pool = req.app.locals.pool;
    const { businessId } = req.params;
    const { category, direction, page = 1, limit = 20 } = req.query;

    try {
        const result = await getTransactions(pool, businessId, {
            category,
            direction,
            page: parseInt(page),
            limit: Math.min(parseInt(limit), 100),
        });
        return ok(res, result);
    } catch (err) {
        logger.error(`[CASHIQ] transactions error: ${err.message}`);
        return fail(res, 'Failed to fetch transactions', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cashiq/:businessId/obligations — upcoming + overdue obligations
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:businessId/obligations', async (req, res) => {
    const pool = req.app.locals.pool;
    const { businessId } = req.params;
    const { from, to } = req.query;
    const days = parseInt(req.query.days || 60);

    try {
        let query = `SELECT obligation_id, obligation_type, description, due_date,
                    amount, currency, status, source, source_ref,
                    CURRENT_DATE - due_date AS days_overdue,
                    due_date - CURRENT_DATE AS days_until
             FROM obligations
             WHERE business_id = $1`;
        const params = [businessId];

        if (from && to) {
            query += ` AND due_date >= $2 AND due_date <= $3`;
            params.push(from, to);
        } else {
            query += ` AND (due_date >= CURRENT_DATE - 60 AND due_date <= CURRENT_DATE + $2::integer
                     OR status = 'OVERDUE')`;
            params.push(days);
        }

        query += ` ORDER BY due_date ASC`;

        const r = await pool.query(query, params);
        return ok(res, { obligations: r.rows, total: r.rows.length });
    } catch (err) {
        logger.error(`[CASHIQ] obligations error: ${err.message}`);
        return fail(res, 'Failed to fetch obligations', err.message, 500);
    }
});
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cashiq/:businessId/budgets/variance
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:businessId/budgets/variance', async (req, res) => {
    const { businessId } = req.params;
    const pool = req.app.locals.pool;
    try {
        const query = `
            SELECT 
                d.name AS department_name,
                b.category,
                b.monthly_limit,
                COALESCE(SUM(t.amount), 0) AS actual_spend,
                (b.monthly_limit - COALESCE(SUM(t.amount), 0)) AS variance,
                CASE WHEN COALESCE(SUM(t.amount), 0) > b.monthly_limit THEN true ELSE false END as is_over_budget
            FROM budgets b
            JOIN departments d ON b.department_id = d.id
            LEFT JOIN bank_transactions t ON t.category = b.category 
                AND t.business_id = d.business_id 
                AND t.direction = 'DEBIT'
                AND t.txn_date >= date_trunc('month', CURRENT_DATE)
            WHERE d.business_id = $1
            GROUP BY d.name, b.category, b.monthly_limit
            ORDER BY d.name ASC, b.category ASC
        `;
        const r = await pool.query(query, [businessId]);
        return ok(res, { variance: r.rows });
    } catch (err) {
        logger.error(`[CASHIQ] budgets/variance error: ${err.message}`);
        return fail(res, 'Failed to fetch budget variance', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/cashiq/:businessId/whatsapp
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:businessId/whatsapp', async (req, res) => {
    const { businessId } = req.params;
    const { whatsapp_config } = req.body;
    const pool = req.app.locals.pool;

    try {
        const query = `
            UPDATE businesses 
            SET whatsapp_config = $1, updated_at = NOW()
            WHERE business_id = $2
            RETURNING whatsapp_config
        `;
        const r = await pool.query(query, [whatsapp_config || '{}', businessId]);
        if (r.rowCount === 0) return fail(res, 'Business not found', null, 404);

        return ok(res, { whatsapp_config: r.rows[0].whatsapp_config });
    } catch (err) {
        logger.error(`[CASHIQ] whatsapp error: ${err.message}`);
        return fail(res, 'Failed to update whatsapp config', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cashiq/:businessId/alerts — active alert events
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:businessId/alerts', async (req, res) => {
    const pool = req.app.locals.pool;
    const { businessId } = req.params;
    const showAll = req.query.all === 'true';

    try {
        const r = await pool.query(
            `SELECT event_id, severity, title, message, is_read, triggered_at
             FROM alert_events
             WHERE business_id = $1 ${showAll ? '' : 'AND is_read = FALSE'}
             ORDER BY triggered_at DESC LIMIT 50`,
            [businessId]
        );
        return ok(res, { alerts: r.rows, total: r.rows.length });
    } catch (err) {
        logger.error(`[CASHIQ] alerts error: ${err.message}`);
        return fail(res, 'Failed to fetch alerts', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/cashiq/:businessId/alerts/:eventId/read — mark alert as read
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:businessId/alerts/:eventId/read', async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        await pool.query(
            `UPDATE alert_events SET is_read = TRUE WHERE event_id = $1 AND business_id = $2`,
            [req.params.eventId, req.params.businessId]
        );
        return ok(res, { message: 'Alert marked as read' });
    } catch (err) {
        return fail(res, 'Failed to update alert', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cashiq/:businessId/alert-rules — get alert rules
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:businessId/alert-rules', async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        const r = await pool.query(
            `SELECT rule_id, rule_type, threshold_value, threshold_days, is_active
             FROM alert_rules WHERE business_id = $1 ORDER BY rule_type`,
            [req.params.businessId]
        );
        return ok(res, { rules: r.rows });
    } catch (err) {
        return fail(res, 'Failed to fetch alert rules', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/cashiq/:businessId/alert-rules/:ruleId — update a rule threshold
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:businessId/alert-rules/:ruleId', async (req, res) => {
    const pool = req.app.locals.pool;
    const { threshold_value, threshold_days, is_active } = req.body;

    try {
        const updates = [];
        const params = [];
        let idx = 1;

        if (threshold_value !== undefined) {
            updates.push(`threshold_value = $${idx++}`);
            params.push(threshold_value);
        }
        if (threshold_days !== undefined) {
            updates.push(`threshold_days = $${idx++}`);
            params.push(threshold_days);
        }
        if (is_active !== undefined) {
            updates.push(`is_active = $${idx++}`);
            params.push(is_active);
        }

        if (updates.length === 0) return fail(res, 'No fields to update');

        params.push(req.params.ruleId, req.params.businessId);
        await pool.query(
            `UPDATE alert_rules SET ${updates.join(', ')} WHERE rule_id = $${idx} AND business_id = $${idx + 1}`,
            params
        );
        return ok(res, { message: 'Alert rule updated' });
    } catch (err) {
        return fail(res, 'Failed to update alert rule', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cashiq/:businessId/accounts — list bank accounts
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:businessId/accounts', async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        const r = await pool.query(
            `SELECT a.account_id, a.bank_name, a.account_type, a.account_number_masked,
                    a.data_source, a.is_active, a.last_synced_at, a.od_limit,
                    COALESCE(
                        (SELECT t.balance_after
                         FROM bank_transactions t
                         WHERE t.account_id = a.account_id AND t.balance_after IS NOT NULL
                         ORDER BY t.txn_date DESC, t.imported_at DESC LIMIT 1), 0
                    ) AS balance
             FROM business_bank_accounts a
             WHERE a.business_id = $1
             ORDER BY a.bank_name`,
            [req.params.businessId]
        );
        return ok(res, { accounts: r.rows });
    } catch (err) {
        return fail(res, 'Failed to fetch accounts', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cashiq/:businessId/accounts — add a bank account
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:businessId/accounts', async (req, res) => {
    const pool = req.app.locals.pool;
    const { bank_name, account_number_masked, account_type, od_limit } = req.body;

    if (!bank_name) return fail(res, 'bank_name is required');

    try {
        const r = await pool.query(
            `INSERT INTO business_bank_accounts (business_id, bank_name, account_number_masked, account_type, od_limit)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING account_id, bank_name, account_type, od_limit`,
            [
                req.params.businessId,
                bank_name,
                account_number_masked || null,
                account_type || 'CURRENT',
                od_limit !== undefined && od_limit !== null ? parseFloat(od_limit) : 2000000.0,
            ]
        );
        return ok(res, { account: r.rows[0] }, 201);
    } catch (err) {
        return fail(res, 'Failed to add account', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cashiq/:businessId/accounts/:accountId/od-limit — update overdraft limit
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:businessId/accounts/:accountId/od-limit', async (req, res) => {
    const pool = req.app.locals.pool;
    const { od_limit } = req.body;

    if (od_limit === undefined || od_limit === null) return fail(res, 'od_limit is required');
    const numericLimit = parseFloat(od_limit);
    if (isNaN(numericLimit)) return fail(res, 'od_limit must be a number');

    try {
        const r = await pool.query(
            `UPDATE business_bank_accounts
             SET od_limit = $1
             WHERE business_id = $2 AND account_id = $3
             RETURNING account_id, bank_name, od_limit`,
            [numericLimit, req.params.businessId, req.params.accountId]
        );
        if (r.rows.length === 0) return fail(res, 'Account not found', null, 404);
        return ok(res, { account: r.rows[0] });
    } catch (err) {
        return fail(res, 'Failed to update overdraft limit', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cashiq/:businessId/accounts/:accountId/import-statement
// Upload a bank statement CSV (multipart/form-data, field: "statement")
// ─────────────────────────────────────────────────────────────────────────────
router.post(
    '/:businessId/accounts/:accountId/import-statement',
    upload.single('statement'),
    async (req, res) => {
        const pool = req.app.locals.pool;
        const { businessId, accountId } = req.params;

        if (!req.file) {
            return fail(res, 'No file uploaded. Send a CSV as multipart field "statement"');
        }

        try {
            const csvText = req.file.buffer.toString('utf8');
            const result = await importBankStatementCSV(pool, businessId, accountId, csvText);
            return ok(res, {
                message: `Imported ${result.imported} transactions, skipped ${result.skipped}.`,
                ...result,
            });
        } catch (err) {
            logger.error(`[CASHIQ] import-statement: ${err.message}`);
            return fail(res, 'Failed to import bank statement', err.message, 500);
        }
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cashiq/:businessId/sync-zoho — trigger Zoho obligation sync
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:businessId/sync-zoho', async (req, res) => {
    const pool = req.app.locals.pool;
    const { businessId } = req.params;

    try {
        const result = await syncObligationsFromZoho(pool, businessId);
        return ok(res, {
            message: `Synced ${result.synced} obligation(s) from Zoho Books.`,
            ...result,
        });
    } catch (err) {
        logger.error(`[CASHIQ] sync-zoho: ${err.message}`);
        return fail(res, 'Zoho sync failed', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cashiq/sentinel/sweep — manually trigger a CashSentinel sweep
// ─────────────────────────────────────────────────────────────────────────────
router.post('/sentinel/sweep', async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        await runSentinelSweep(pool);
        return ok(res, { message: 'CashSentinel sweep complete. Check /alerts for new events.' });
    } catch (err) {
        return fail(res, 'Sentinel sweep failed', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cashiq/verify-gstin/:gstin — verify GSTIN registry details
// ─────────────────────────────────────────────────────────────────────────────
router.get('/verify-gstin/:gstin', async (req, res) => {
    const { gstin } = req.params;
    const gstinClean = (gstin || '').toUpperCase().trim();

    // Regular expression for Indian GSTIN (15 chars)
    const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    if (!gstinRegex.test(gstinClean)) {
        return fail(
            res,
            'Invalid GSTIN format. Must be 15 characters matching standard GSTIN format.',
            null,
            400
        );
    }

    // Mock GST Registry databases
    let tradeName = 'Alternative SME Enterprises';
    let legalName = 'Alternative SME Enterprises Pvt Ltd';
    let address = '32, Gandhi Road, T Nagar, Chennai, Tamil Nadu, 600017';
    let taxpayerType = 'Regular';

    if (gstinClean === '33AABCC1234D1Z5') {
        tradeName = 'Coimbatore Textile Mills';
        legalName = 'COIMBATORE TEXTILE MILLS PRIVATE LIMITED';
        address = '12, Avinashi Road, Coimbatore, Tamil Nadu, 641018';
    } else if (gstinClean === '33AATV9876E1Z2') {
        tradeName = 'TechVista Solutions';
        legalName = 'TECHVISTA SOLUTIONS LLP';
        address = '45, OMR IT Corridor, Chennai, Tamil Nadu, 600096';
    }

    return ok(res, {
        gstin: gstinClean,
        legalName,
        tradeName,
        taxpayerType,
        status: 'Active',
        address,
        verifiedAt: new Date().toISOString(),
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cashiq/:businessId/tds-confirm — mark TDS obligation as paid
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:businessId/tds-confirm', async (req, res) => {
    const pool = req.app.locals.pool;
    const { businessId } = req.params;
    const { obligationId } = req.body;

    if (!obligationId) return fail(res, 'obligationId is required in body');

    try {
        const r = await pool.query(
            `UPDATE obligations 
             SET status = 'PAID', updated_at = NOW() 
             WHERE obligation_id = $1 AND business_id = $2
             RETURNING obligation_id, status`,
            [obligationId, businessId]
        );

        if (r.rows.length === 0) {
            return fail(res, 'Obligation not found for this business', null, 404);
        }

        logger.info(
            `[CASHIQ] TDS Obligation marked as paid: ${obligationId} for business ${businessId}`
        );
        return ok(res, {
            message: 'TDS Obligation marked as paid successfully',
            obligation: r.rows[0],
        });
    } catch (err) {
        logger.error(`[CASHIQ] tds-confirm error: ${err.message}`);
        return fail(res, 'Failed to update TDS obligation status', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cashiq/:businessId/export-audit — export transactions as CSV
//
// CURRENCY RESOLUTION HIERARCHY & DATA PROVENANCE (R3C.2.1):
// In the core schema (001_cashiq_core.sql), bank_transactions omits a native
// 'currency' column. To prevent unverified records from being silently mislabeled
// INR, currency resolution follows a strict 4-tier hierarchy:
// 1. Explicit transaction currency (raw_json->>'currency' or raw_json->>'currency_code').
// 2. Explicit verified account-level currency (raw_json->>'account_currency').
// 3. Domestic-only ingestion contract, used ONLY when the ingestion path explicitly
//    enforces an INR restriction (raw_json->>'domestic_contract' = 'true' or
//    raw_json->>'domestic_enforcement' = 'INR').
//    NOTE: Account Aggregator (AA) consent by itself does NOT imply INR, as Indian
//    banks also manage EEFC (Exchange Earners' Foreign Currency) and FCNR accounts.
// 4. Otherwise, returns 'UNKNOWN'.
//
// GOVERNANCE MANDATE: Zero silent INR assumptions from GSTIN or AA consent alone.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:businessId/export-audit', async (req, res) => {
    const pool = req.app.locals.pool;
    const { businessId } = req.params;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!businessId || !uuidRegex.test(businessId)) {
        return fail(res, 'Invalid business ID format. Expected standard UUID.', null, 400);
    }

    try {
        const r = await pool.query(
            `SELECT t.txn_id, a.bank_name, a.account_number_masked, t.txn_date, 
                    t.narration, t.direction, t.amount, t.balance_after, 
                    CASE 
                        -- 1. Explicit transaction currency takes priority
                        WHEN t.raw_json->>'currency' IS NOT NULL AND TRIM(t.raw_json->>'currency') <> '' 
                            THEN UPPER(TRIM(t.raw_json->>'currency'))
                        WHEN t.raw_json->>'currency_code' IS NOT NULL AND TRIM(t.raw_json->>'currency_code') <> '' 
                            THEN UPPER(TRIM(t.raw_json->>'currency_code'))
                        -- 2. Explicit verified account currency
                        WHEN t.raw_json->>'account_currency' IS NOT NULL AND TRIM(t.raw_json->>'account_currency') <> '' 
                            THEN UPPER(TRIM(t.raw_json->>'account_currency'))
                        -- 3. Domestic-only source contract with proven INR enforcement
                        WHEN t.raw_json->>'domestic_contract' = 'true' OR t.raw_json->>'domestic_enforcement' = 'INR'
                            THEN 'INR'
                        -- 4. Missing or unverified currency returns UNKNOWN (AA consent does not imply INR)
                        ELSE 'UNKNOWN'
                    END AS currency, 
                    t.category
             FROM bank_transactions t
             LEFT JOIN business_bank_accounts a ON a.account_id = t.account_id
             LEFT JOIN businesses b ON b.business_id = t.business_id
             WHERE t.business_id = $1
             ORDER BY t.txn_date DESC`,
            [businessId]
        );

        // Build CSV string
        let csvContent =
            'Transaction ID,Bank Name,Account Number,Date,Narration,Direction,Amount,Balance After,Currency,Category\n';
        for (const row of r.rows) {
            const dateStr = new Date(row.txn_date).toISOString().split('T')[0];
            const escapedNarration = `"${(row.narration || '').replace(/"/g, '""')}"`;
            csvContent += `${row.txn_id},${row.bank_name || ''},${row.account_number_masked || ''},${dateStr},${escapedNarration},${row.direction},${row.amount},${row.balance_after || ''},${row.currency || 'UNKNOWN'},${row.category || 'UNCLASSIFIED'}\n`;
        }

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename=cashiq_audit_business_${businessId}.csv`
        );
        return res.status(200).send(csvContent);
    } catch (err) {
        logger.error(`[CASHIQ] export-audit error: ${err.message}`);
        return fail(res, 'Failed to export audit log', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// VENDOR & CUSTOMER CONTACTS — Full CRUD
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/cashiq/:businessId/contacts
router.get('/:businessId/contacts', async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        // Ensure table exists (auto-create for prototype convenience)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS vendor_contacts (
                contact_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                business_id     UUID NOT NULL,
                name            VARCHAR(255) NOT NULL,
                type            VARCHAR(20) NOT NULL CHECK (type IN ('VENDOR', 'CUSTOMER')),
                gstin           VARCHAR(20),
                pan             VARCHAR(15),
                email           VARCHAR(255),
                phone           VARCHAR(30),
                bank_name       VARCHAR(100),
                ifsc            VARCHAR(15),
                account_number  VARCHAR(30),
                outstanding_balance DECIMAL(20,2) DEFAULT 0,
                total_paid      DECIMAL(20,2) DEFAULT 0,
                last_txn_date   DATE,
                payment_terms_days INTEGER DEFAULT 30,
                notes           TEXT,
                created_at      TIMESTAMP DEFAULT NOW(),
                updated_at      TIMESTAMP DEFAULT NOW()
            )
        `);
        const r = await pool.query(
            `SELECT contact_id AS id, name, type, gstin, pan, email, phone,
                    bank_name, ifsc, account_number, outstanding_balance, total_paid,
                    last_txn_date, payment_terms_days, notes, created_at
             FROM vendor_contacts
             WHERE business_id = $1
             ORDER BY type, name`,
            [req.params.businessId]
        );
        return ok(res, { contacts: r.rows, total: r.rows.length });
    } catch (err) {
        logger.error(`[CASHIQ] contacts GET: ${err.message}`);
        return fail(res, 'Failed to fetch contacts', err.message, 500);
    }
});

// POST /api/cashiq/:businessId/contacts — create contact
router.post('/:businessId/contacts', async (req, res) => {
    const pool = req.app.locals.pool;
    const {
        name,
        type,
        gstin,
        pan,
        email,
        phone,
        bank_name,
        ifsc,
        account_number,
        payment_terms_days,
        notes,
    } = req.body;

    if (!name) return fail(res, 'Contact name is required');
    if (!type || !['VENDOR', 'CUSTOMER'].includes(type))
        return fail(res, 'type must be VENDOR or CUSTOMER');

    try {
        const r = await pool.query(
            `INSERT INTO vendor_contacts
             (business_id, name, type, gstin, pan, email, phone, bank_name, ifsc,
              account_number, payment_terms_days, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING contact_id AS id, name, type, gstin, pan`,
            [
                req.params.businessId,
                name,
                type,
                gstin || null,
                pan || null,
                email || null,
                phone || null,
                bank_name || null,
                ifsc || null,
                account_number || null,
                payment_terms_days || 30,
                notes || null,
            ]
        );
        logger.info(
            `[CASHIQ] Contact created: ${name} (${type}) for business ${req.params.businessId}`
        );
        return ok(
            res,
            { contact: r.rows[0], message: `${type} '${name}' added to directory.` },
            201
        );
    } catch (err) {
        logger.error(`[CASHIQ] contacts POST: ${err.message}`);
        return fail(res, 'Failed to create contact', err.message, 500);
    }
});

// PUT /api/cashiq/:businessId/contacts/:contactId — update contact
router.put('/:businessId/contacts/:contactId', async (req, res) => {
    const pool = req.app.locals.pool;
    const fields = [
        'name',
        'type',
        'gstin',
        'pan',
        'email',
        'phone',
        'bank_name',
        'ifsc',
        'account_number',
        'payment_terms_days',
        'notes',
    ];
    const updates = [];
    const params = [];
    let idx = 1;

    fields.forEach((f) => {
        if (req.body[f] !== undefined) {
            updates.push(`${f} = $${idx++}`);
            params.push(req.body[f]);
        }
    });
    if (updates.length === 0) return fail(res, 'No fields to update');

    updates.push(`updated_at = NOW()`);
    params.push(req.params.contactId, req.params.businessId);

    try {
        await pool.query(
            `UPDATE vendor_contacts SET ${updates.join(', ')}
             WHERE contact_id = $${idx} AND business_id = $${idx + 1}`,
            params
        );
        return ok(res, { message: 'Contact updated' });
    } catch (err) {
        logger.error(`[CASHIQ] contacts PUT: ${err.message}`);
        return fail(res, 'Failed to update contact', err.message, 500);
    }
});

// DELETE /api/cashiq/:businessId/contacts/:contactId
router.delete('/:businessId/contacts/:contactId', async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        await pool.query(`DELETE FROM vendor_contacts WHERE contact_id = $1 AND business_id = $2`, [
            req.params.contactId,
            req.params.businessId,
        ]);
        return ok(res, { message: 'Contact deleted' });
    } catch (err) {
        return fail(res, 'Failed to delete contact', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT SCHEDULING — Schedule future-dated instructions
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/cashiq/:businessId/scheduled-payments
router.get('/:businessId/scheduled-payments', async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS scheduled_payments (
                schedule_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                business_id     UUID NOT NULL,
                label           VARCHAR(255),
                amount          DECIMAL(20,2) NOT NULL,
                currency        VARCHAR(10) NOT NULL DEFAULT 'INR',
                recipient_name  VARCHAR(255) NOT NULL,
                purpose         VARCHAR(100) NOT NULL DEFAULT 'VENDOR_PAYMENT',
                scheduled_date  DATE NOT NULL,
                recurrence      VARCHAR(20) DEFAULT 'ONCE',
                status          VARCHAR(20) DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','PROCESSING','DONE','CANCELLED','FAILED')),
                note            TEXT,
                created_at      TIMESTAMP DEFAULT NOW()
            )
        `);
        const r = await pool.query(
            `SELECT schedule_id AS id, label, amount, currency, recipient_name, purpose,
                    scheduled_date, recurrence, status, note, created_at
             FROM scheduled_payments
             WHERE business_id = $1
             ORDER BY scheduled_date ASC`,
            [req.params.businessId]
        );
        return ok(res, { payments: r.rows, total: r.rows.length });
    } catch (err) {
        logger.error(`[CASHIQ] scheduled-payments GET: ${err.message}`);
        return fail(res, 'Failed to fetch scheduled payments', err.message, 500);
    }
});

// POST /api/cashiq/:businessId/scheduled-payments — create a scheduled payment
router.post('/:businessId/scheduled-payments', async (req, res) => {
    const pool = req.app.locals.pool;
    const { label, amount, currency, recipient_name, purpose, scheduled_date, recurrence, note } =
        req.body;

    if (!amount || parseFloat(amount) <= 0) return fail(res, 'Valid amount is required');
    if (!recipient_name) return fail(res, 'recipient_name is required');
    if (!scheduled_date) return fail(res, 'scheduled_date is required (YYYY-MM-DD)');

    // Validate scheduled_date is in the future
    if (new Date(scheduled_date) <= new Date()) {
        return fail(res, 'scheduled_date must be a future date');
    }

    try {
        const r = await pool.query(
            `INSERT INTO scheduled_payments
             (business_id, label, amount, currency, recipient_name, purpose,
              scheduled_date, recurrence, note)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING schedule_id AS id, label, amount, currency, scheduled_date, status`,
            [
                req.params.businessId,
                label || `${purpose || 'Payment'} to ${recipient_name}`,
                parseFloat(amount),
                currency || 'INR',
                recipient_name,
                purpose || 'VENDOR_PAYMENT',
                scheduled_date,
                recurrence || 'ONCE',
                note || null,
            ]
        );
        logger.info(
            `[CASHIQ] Scheduled payment created: ${amount} ${currency} to ${recipient_name} on ${scheduled_date}`
        );
        return ok(
            res,
            { payment: r.rows[0], message: `Payment scheduled for ${scheduled_date}.` },
            201
        );
    } catch (err) {
        logger.error(`[CASHIQ] scheduled-payments POST: ${err.message}`);
        return fail(res, 'Failed to schedule payment', err.message, 500);
    }
});

// DELETE /api/cashiq/:businessId/scheduled-payments/:scheduleId — cancel scheduled payment
router.delete('/:businessId/scheduled-payments/:scheduleId', async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        await pool.query(
            `UPDATE scheduled_payments SET status = 'CANCELLED'
             WHERE schedule_id = $1 AND business_id = $2 AND status = 'SCHEDULED'`,
            [req.params.scheduleId, req.params.businessId]
        );
        return ok(res, { message: 'Payment cancelled' });
    } catch (err) {
        return fail(res, 'Failed to cancel scheduled payment', err.message, 500);
    }
});

// GET /api/cashiq/:businessId/search — search across invoices, instructions, contacts, obligations
router.get('/:businessId/search', async (req, res) => {
    const pool = req.app.locals.pool;
    const { businessId } = req.params;
    const qStr = (req.query.q || '').trim();
    if (!qStr) {
        return ok(res, { results: [] });
    }
    const q = '%' + qStr.toLowerCase() + '%';

    try {
        const invoicesRes = await pool.query(
            `SELECT invoice_id AS id, total_amount AS amount, currency, seller_name, buyer_name, state, 'invoice' AS type
             FROM invoices
             WHERE LOWER(invoice_id) LIKE $1 OR 
                   LOWER(seller_name) LIKE $1 OR 
                   LOWER(buyer_name) LIKE $1
             LIMIT 5`,
            [q]
        );

        const instructionsRes = await pool.query(
            `SELECT instruction_id AS id, amount, currency, sender, recipient, purpose, state, 'instruction' AS type
             FROM instructions
             WHERE LOWER(sender) LIKE $1 OR LOWER(recipient) LIKE $1 OR LOWER(purpose) LIKE $1 OR LOWER(state) LIKE $1
             LIMIT 5`,
            [q]
        );

        const contactsRes = await pool.query(
            `SELECT contact_id AS id, name, type AS contact_type, gstin, pan, email, 'contact' AS type
             FROM vendor_contacts
             WHERE business_id = $1 AND (
                 LOWER(name) LIKE $2 OR 
                 LOWER(email) LIKE $2 OR 
                 LOWER(gstin) LIKE $2 OR 
                 LOWER(pan) LIKE $2
             )
             LIMIT 5`,
            [businessId, q]
        );

        const obligationsRes = await pool.query(
            `SELECT obligation_id AS id, obligation_type, description, amount, currency, status, 'obligation' AS type
             FROM obligations
             WHERE business_id = $1 AND (
                 LOWER(description) LIKE $2 OR 
                 LOWER(obligation_type) LIKE $2 OR 
                 LOWER(status) LIKE $2
             )
             LIMIT 5`,
            [businessId, q]
        );

        const combinedResults = [
            ...invoicesRes.rows.map((r) => ({
                ...r,
                label: `Invoice ${r.id.substring(0, 8)}: ${r.seller_name} → ${r.buyer_name} (${r.currency} ${r.amount})`,
            })),
            ...instructionsRes.rows.map((r) => ({
                ...r,
                label: `Instruction ${r.id.substring(0, 8)}: ${r.sender} → ${r.recipient} (${r.currency} ${r.amount}) [${r.state}]`,
            })),
            ...contactsRes.rows.map((r) => ({
                ...r,
                label: `${r.contact_type === 'VENDOR' ? '🏪 Vendor' : '👤 Customer'}: ${r.name} (${r.email || 'No email'})`,
            })),
            ...obligationsRes.rows.map((r) => ({
                ...r,
                label: `Obligation: ${r.description || r.obligation_type} (${r.currency} ${r.amount}) [${r.status}]`,
            })),
        ];

        return ok(res, { results: combinedResults });
    } catch (err) {
        logger.error(`[CASHIQ] Search GET error: ${err.message}`);
        return fail(res, 'Search query failed', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cashiq/:businessId/obligations/:id/discount — SME Receivables: Get Paid Early
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:businessId/obligations/:id/discount', async (req, res) => {
    const pool = req.app.locals.pool;
    const { businessId, id } = req.params;

    try {
        // 1. Fetch obligation and verify it's a receivable
        const obRes = await pool.query(
            `SELECT obligation_id, amount, currency, status, obligation_type 
             FROM obligations 
             WHERE obligation_id = $1 AND business_id = $2`,
            [id, businessId]
        );

        if (obRes.rows.length === 0) return fail(res, 'Obligation not found', null, 404);
        const ob = obRes.rows[0];

        if (ob.obligation_type !== 'INVOICE_DUE') {
            return fail(res, 'Only INVOICE_DUE (Receivables) can be discounted.');
        }
        if (ob.status === 'FACTORED') {
            return fail(res, 'This invoice has already been factored.');
        }

        const amount = parseFloat(ob.amount || 0);
        if (amount <= 0) return fail(res, 'Invalid invoice amount.');

        // 2. Simulate Factoring: 1.5% fee
        const fee = amount * 0.015;
        const advance = amount - fee;

        // 3. Update Obligation status to FACTORED
        await pool.query(
            `UPDATE obligations SET status = 'FACTORED', updated_at = NOW() 
             WHERE obligation_id = $1`,
            [id]
        );

        // 4. Deposit advance into SME's Virtual Account (Simulation)
        // Find the primary virtual account for this business
        const vaRes = await pool.query(
            `SELECT account_id FROM virtual_accounts WHERE business_id = $1 LIMIT 1`,
            [businessId]
        );

        if (vaRes.rows.length > 0) {
            const vAccountId = vaRes.rows[0].account_id;
            await pool.query(
                `INSERT INTO virtual_account_balances (account_id, currency, available_balance, updated_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (account_id, currency) 
                 DO UPDATE SET available_balance = virtual_account_balances.available_balance + EXCLUDED.available_balance, updated_at = NOW()`,
                [vAccountId, ob.currency, advance]
            );
        }

        logger.info(
            `[CASHIQ] Invoice ${id} Factored! Fee: ${fee}, Advance: ${advance} ${ob.currency}`
        );
        return ok(res, {
            message: 'Invoice factored successfully!',
            advance_amount: advance,
            fee_amount: fee,
            status: 'FACTORED',
        });
    } catch (err) {
        logger.error(`[CASHIQ] discount error: ${err.message}`);
        return fail(res, 'Failed to factor invoice', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cashiq/:businessId/obligations/:id/dunning — SME Receivables: Smart Dunning
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:businessId/obligations/:id/dunning', async (req, res) => {
    const pool = req.app.locals.pool;
    const { businessId, id } = req.params;

    try {
        const obRes = await pool.query(
            `SELECT obligation_id, status FROM obligations WHERE obligation_id = $1 AND business_id = $2`,
            [id, businessId]
        );

        if (obRes.rows.length === 0) return fail(res, 'Obligation not found', null, 404);

        // Simulate sending a Razorpay payment link via WhatsApp
        await pool.query(
            `UPDATE obligations SET status = 'DUNNING_SENT', updated_at = NOW() 
             WHERE obligation_id = $1`,
            [id]
        );

        logger.info(`[CASHIQ] Smart Dunning executed for obligation ${id}`);
        return ok(res, {
            message: 'Payment link generated and WhatsApp reminder sent to buyer.',
            status: 'DUNNING_SENT',
        });
    } catch (err) {
        logger.error(`[CASHIQ] dunning error: ${err.message}`);
        return fail(res, 'Failed to send dunning reminder', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cashiq/:businessId/ar-reminders — Fetch AR collection reminder history
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:businessId/ar-reminders', async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ar_reminders (
                reminder_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                business_id     UUID NOT NULL,
                invoice_id      VARCHAR(100) NOT NULL,
                party           VARCHAR(255) NOT NULL,
                channel         VARCHAR(20) NOT NULL,
                status          VARCHAR(50) DEFAULT 'SENT',
                sent_at         TIMESTAMP DEFAULT NOW()
            )
        `);
        const r = await pool.query(
            `SELECT * FROM ar_reminders WHERE business_id = $1 ORDER BY sent_at DESC`,
            [req.params.businessId]
        );
        return ok(res, { reminders: r.rows });
    } catch (err) {
        logger.error(`[AR-REMINDER] GET error: ${err.message}`);
        return fail(res, 'Failed to fetch ar reminders', err.message, 500);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cashiq/:businessId/ar-reminder — Send AR collection reminder
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:businessId/ar-reminder', async (req, res) => {
    const { businessId } = req.params;
    const { invoiceId, party, amount, daysOutstanding, channel } = req.body;
    // channel: 'WHATSAPP' | 'EMAIL'

    if (!invoiceId || !party || !amount || !daysOutstanding) {
        return fail(res, 'Missing required fields: invoiceId, party, amount, daysOutstanding');
    }
    if (!['WHATSAPP', 'EMAIL'].includes(channel)) {
        return fail(res, "channel must be 'WHATSAPP' or 'EMAIL'");
    }
    if (daysOutstanding <= 30) {
        return fail(res, 'Reminders can only be sent for invoices overdue by more than 30 days');
    }

    const pool = req.app.locals.pool;

    try {
        // Fetch business name for the reminder message
        const bizRes = await pool.query('SELECT name FROM businesses WHERE business_id = $1', [
            businessId,
        ]);
        const businessName = bizRes.rows[0]?.name || 'Your Vendor';

        // Format amount in Indian locale
        const formattedAmount = new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 0,
        }).format(amount);

        // Build the reminder message
        const reminderMessage =
            channel === 'WHATSAPP'
                ? [
                      `Dear *${party}*,`,
                      ``,
                      `This is a friendly reminder from *${businessName}* regarding Invoice *${invoiceId}*.`,
                      ``,
                      `📋 *Invoice:* ${invoiceId}`,
                      `💰 *Amount Due:* ${formattedAmount}`,
                      `⏰ *Days Outstanding:* ${daysOutstanding} days`,
                      ``,
                      daysOutstanding > 45
                          ? `⚠️ This payment has exceeded 45 days and may trigger penalties under *Section 43B(h)* of the Income Tax Act.`
                          : `Please arrange payment at your earliest convenience.`,
                      ``,
                      `For any queries, kindly contact your account manager.`,
                      ``,
                      `Thank you,`,
                      `*${businessName} Finance Team*`,
                  ].join('\n')
                : [
                      `Dear ${party},`,
                      ``,
                      `We hope this email finds you well.`,
                      ``,
                      `This is a formal reminder from ${businessName} regarding the following outstanding invoice:`,
                      ``,
                      `  Invoice Number : ${invoiceId}`,
                      `  Amount Due     : ${formattedAmount}`,
                      `  Days Overdue   : ${daysOutstanding} days`,
                      ``,
                      daysOutstanding > 45
                          ? `Please note that this payment has exceeded 45 days and may be subject to interest and disallowance of expenses under Section 43B(h) of the Income Tax Act.`
                          : `We kindly request you to arrange payment at your earliest convenience.`,
                      ``,
                      `If you have already made the payment, please disregard this notice and share the UTR/transaction reference with us.`,
                      ``,
                      `Warm regards,`,
                      `${businessName} Finance Team`,
                  ].join('\n');

        // In production: call Twilio WhatsApp API or SMTP/SendGrid here.
        // For prototype: log and return mock success.
        logger.info(
            `[AR-REMINDER] ${channel} reminder triggered for invoice ${invoiceId} | Party: ${party} | Days: ${daysOutstanding} | Business: ${businessId}`
        );

        // Persist to DB
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ar_reminders (
                reminder_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                business_id     UUID NOT NULL,
                invoice_id      VARCHAR(100) NOT NULL,
                party           VARCHAR(255) NOT NULL,
                channel         VARCHAR(20) NOT NULL,
                status          VARCHAR(50) DEFAULT 'SENT',
                sent_at         TIMESTAMP DEFAULT NOW()
            )
        `);
        const r = await pool.query(
            `INSERT INTO ar_reminders (business_id, invoice_id, party, channel) VALUES ($1, $2, $3, $4) RETURNING *`,
            [businessId, invoiceId, party, channel]
        );

        return ok(res, {
            message: `${channel === 'WHATSAPP' ? 'WhatsApp' : 'Email'} reminder sent to ${party}.`,
            reminder: r.rows[0],
            reminderPreview: reminderMessage,
        });
    } catch (err) {
        logger.error(`[AR-REMINDER] Error: ${err.message}`);
        return fail(res, 'Failed to send reminder', err.message, 500);
    }
});

module.exports = router;
