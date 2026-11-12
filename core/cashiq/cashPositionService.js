'use strict';

/**
 * cashPositionService.js — Core CashIQ Intelligence
 * ===================================================
 * getCashSnapshot(pool, businessId) is the single source of truth
 * consumed by the dashboard API and the WhatsApp briefing (future).
 */

/**
 * Returns the full cash snapshot for a business.
 *
 * @param {object} pool
 * @param {string} businessId
 * @returns {Promise<object>}
 */
async function getCashSnapshot(pool, businessId, { from, to } = {}) {
    const [business, accounts, obligations, alerts, monthlyFlow] = await Promise.all([
        getBusinessDetails(pool, businessId),
        getAccountBalances(pool, businessId),
        getUpcomingObligations(pool, businessId, { from, to }),
        getActiveAlerts(pool, businessId),
        getMonthlyFlow(pool, businessId, { from, to }),
    ]);

    if (!business) return null;

    // Aggregate balance across all active accounts
    const currentBalance = accounts.reduce((sum, a) => sum + (a.balance || 0), 0);
    const totalOdLimit   = accounts.reduce((sum, a) => sum + (a.od_limit || 0), 0);

    // Determine data completeness
    const hasManual = accounts.some(a => a.data_source === 'MANUAL');
    const hasAA     = accounts.some(a => a.data_source === 'AA_CONSENT');
    let dataCompleteness = 'MANUAL_ONLY';
    if (hasAA && hasManual) dataCompleteness = 'PARTIAL';
    if (hasAA && !hasManual) dataCompleteness = 'FULL';

    return {
        business: {
            id:   business.business_id,
            name: business.name,
            gstin: business.gstin,
            city:  business.city,
            ca_name: business.ca_name,
            ca_membership_number: business.ca_membership_number,
            ca_email: business.ca_email,
            ca_phone: business.ca_phone,
            ca_firm_name: business.ca_firm_name,
            ca_city: business.ca_city,
        },
        current_balance:    currentBalance,
        od_limit:           totalOdLimit,
        data_completeness:  dataCompleteness,
        accounts,
        upcoming_obligations: obligations,
        monthly_flow:       monthlyFlow,
        active_alerts:      alerts,
        snapshot_at:        new Date().toISOString(),
    };
}

async function getBusinessDetails(pool, businessId) {
    const r = await pool.query(
        `SELECT b.business_id, b.name, b.gstin, b.incorporation_type, b.industry, b.city,
                cp.name AS ca_name, cp.membership_number AS ca_membership_number,
                cp.email AS ca_email, cp.phone AS ca_phone, cp.firm_name AS ca_firm_name, cp.city AS ca_city
         FROM businesses b
         LEFT JOIN ca_profiles cp ON b.ca_id = cp.ca_id
         WHERE b.business_id = $1`,
        [businessId]
    );
    return r.rows[0] || null;
}

async function getAccountBalances(pool, businessId) {
    // Get each account's latest balance_after from transactions
    const r = await pool.query(
        `SELECT
            a.account_id, a.bank_name, a.account_type, a.data_source,
            a.account_number_masked, a.last_synced_at, a.od_limit,
            COALESCE(
                (SELECT t.balance_after
                 FROM bank_transactions t
                 WHERE t.account_id = a.account_id AND t.balance_after IS NOT NULL
                 ORDER BY t.txn_date DESC, t.imported_at DESC LIMIT 1),
                0
            ) AS balance
         FROM business_bank_accounts a
         WHERE a.business_id = $1 AND a.is_active = TRUE
         ORDER BY a.bank_name`,
        [businessId]
    );

    return r.rows.map(row => ({
        account_id:     row.account_id,
        bank_name:      row.bank_name,
        account_type:   row.account_type,
        data_source:    row.data_source,
        masked_number:  row.account_number_masked,
        balance:        parseFloat(row.balance),
        last_synced_at: row.last_synced_at,
        od_limit:       parseFloat(row.od_limit || 0),
    }));
}

async function getUpcomingObligations(pool, businessId, { from, to } = {}) {
    let query = `SELECT obligation_id, obligation_type, description, due_date,
                amount, currency, status, source
         FROM obligations
         WHERE business_id = $1`;
    const params = [businessId];

    if (from && to) {
        query += ` AND due_date >= $2 AND due_date <= $3`;
        params.push(from, to);
    } else {
        query += ` AND (due_date <= CURRENT_DATE + 30 OR status = 'OVERDUE')`;
    }

    query += ` ORDER BY due_date ASC`;

    const r = await pool.query(query, params);

    return r.rows.map(row => ({
        id:          row.obligation_id,
        type:        row.obligation_type,
        description: row.description,
        due_date:    row.due_date,
        amount:      row.amount ? parseFloat(row.amount) : null,
        currency:    row.currency,
        status:      row.status,
        days_until:  Math.ceil((new Date(row.due_date) - new Date()) / (1000 * 60 * 60 * 24)),
        source:      row.source,
    }));
}

async function getActiveAlerts(pool, businessId) {
    const r = await pool.query(
        `SELECT event_id, severity, title, message, is_read, triggered_at
         FROM alert_events
         WHERE business_id = $1 AND is_read = FALSE
         ORDER BY triggered_at DESC LIMIT 20`,
        [businessId]
    );
    return r.rows;
}

async function getMonthlyFlow(pool, businessId, { from, to } = {}) {
    let query = `SELECT
            txn_date::TEXT AS date,
            SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) AS inflow,
            SUM(CASE WHEN direction = 'DEBIT'  THEN amount ELSE 0 END) AS outflow
         FROM bank_transactions
         WHERE business_id = $1`;
    const params = [businessId];

    if (from && to) {
        query += ` AND txn_date >= $2 AND txn_date <= $3`;
        params.push(from, to);
    } else {
        query += ` AND txn_date >= CURRENT_DATE - 30`;
    }

    query += ` GROUP BY txn_date ORDER BY txn_date ASC`;

    const r = await pool.query(query, params);

    return r.rows.map(row => ({
        date:    row.date,
        inflow:  parseFloat(row.inflow),
        outflow: parseFloat(row.outflow),
        net:     parseFloat(row.inflow) - parseFloat(row.outflow),
    }));
}

/**
 * Returns paginated categorised transactions for a business.
 */
async function getTransactions(pool, businessId, { category, direction, page = 1, limit = 20 } = {}) {
    const offset = (page - 1) * limit;
    const conditions = ['t.business_id = $1'];
    const params = [businessId];
    let paramIdx = 2;

    if (category) {
        conditions.push(`t.category = $${paramIdx++}`);
        params.push(category);
    }
    if (direction) {
        conditions.push(`t.direction = $${paramIdx++}`);
        params.push(direction.toUpperCase());
    }

    const where = conditions.join(' AND ');

    const [dataRes, countRes] = await Promise.all([
        pool.query(
            `SELECT t.txn_id, t.txn_date, t.amount, t.direction, t.narration,
                    t.category, t.category_confidence, t.balance_after,
                    a.bank_name
             FROM bank_transactions t
             JOIN business_bank_accounts a ON a.account_id = t.account_id
             WHERE ${where}
             ORDER BY t.txn_date DESC, t.imported_at DESC
             LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
            [...params, limit, offset]
        ),
        pool.query(
            `SELECT COUNT(*) FROM bank_transactions t WHERE ${where}`,
            params
        ),
    ]);

    return {
        data:  dataRes.rows,
        total: parseInt(countRes.rows[0].count),
        page,
        limit,
    };
}

module.exports = { getCashSnapshot, getTransactions, getMonthlyFlow };
