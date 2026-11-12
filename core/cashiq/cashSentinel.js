'use strict';

/**
 * cashSentinel.js — CashSentinel Alert Engine
 * =============================================
 * Evaluates alert rules every hour for all active businesses.
 * Writes triggered events to alert_events.
 * WhatsApp delivery hook is present but no-ops until WhatsApp Business API is configured.
 */

const cron = require('node-cron');
const logger = require('../../logger');
const { runScheduledPaymentsSweep } = require('./paymentScheduler');

const ALERT_COOLDOWN_MINUTES = 120; // Don't re-fire same alert within 2 hours

/**
 * Evaluate all alert rules for all businesses and write events.
 * @param {object} pool - PostgreSQL pool
 */
async function runSentinelSweep(pool) {
    logger.info('[CASHSENTINEL] Starting alert sweep...');

    try {
        const businesses = await pool.query(
            `SELECT b.business_id, b.name FROM businesses b`
        );

        let totalFired = 0;

        for (const biz of businesses.rows) {
            const fired = await evaluateBusinessAlerts(pool, biz.business_id, biz.name);
            totalFired += fired;
        }

        logger.info(`[CASHSENTINEL] Sweep complete — ${totalFired} new alert(s) fired.`);
    } catch (err) {
        logger.error(`[CASHSENTINEL] Sweep error: ${err.message}`);
    }
}

async function evaluateBusinessAlerts(pool, businessId, businessName) {
    const rulesRes = await pool.query(
        `SELECT rule_id, rule_type, threshold_value, threshold_days
         FROM alert_rules WHERE business_id = $1 AND is_active = TRUE`,
        [businessId]
    );

    let fired = 0;

    for (const rule of rulesRes.rows) {
        try {
            const alert = await evaluateRule(pool, businessId, rule);
            if (alert) {
                const wasCooledDown = await isInCooldown(pool, businessId, rule.rule_id, ALERT_COOLDOWN_MINUTES);
                if (!wasCooledDown) {
                    await writeAlertEvent(pool, businessId, rule.rule_id, alert);
                    await deliverAlert(businessName, alert); // WhatsApp stub
                    fired++;
                }
            }
        } catch (err) {
            logger.error(`[CASHSENTINEL] Rule eval error (${rule.rule_type}): ${err.message}`);
        }
    }

    return fired;
}

async function evaluateRule(pool, businessId, rule) {
    const { rule_type, threshold_value, threshold_days } = rule;

    switch (rule_type) {

        case 'LOW_BALANCE': {
            // Check aggregate balance across all accounts
            const r = await pool.query(
                `SELECT COALESCE(SUM(sub.balance), 0) AS total
                 FROM (
                     SELECT DISTINCT ON (account_id)
                         account_id,
                         balance_after AS balance
                     FROM bank_transactions
                     WHERE business_id = $1 AND balance_after IS NOT NULL
                     ORDER BY account_id, txn_date DESC, imported_at DESC
                 ) sub`,
                [businessId]
            );
            const balance = parseFloat(r.rows[0]?.total || 0);
            const threshold = parseFloat(threshold_value || 100000);
            if (balance < threshold) {
                return {
                    severity: 'HIGH',
                    title: 'Low Cash Balance',
                    message: `Current aggregate balance ₹${fmt(balance)} is below your alert threshold of ₹${fmt(threshold)}. Review upcoming obligations.`,
                };
            }
            break;
        }

        case 'UPCOMING_GST': {
            const days = threshold_days || 3;
            const r = await pool.query(
                `SELECT description, due_date, amount FROM obligations
                 WHERE business_id = $1
                   AND obligation_type IN ('GST_PAYMENT', 'GST_FILING')
                   AND status = 'UPCOMING'
                   AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $2::integer`,
                [businessId, days]
            );
            if (r.rows.length > 0) {
                const ob = r.rows[0];
                return {
                    severity: 'MEDIUM',
                    title: `GST Due in ${days} Days`,
                    message: `${ob.description} is due on ${ob.due_date}${ob.amount > 0 ? ` — Amount: ₹${fmt(ob.amount)}` : ''}. File on time to avoid penalties.`,
                };
            }
            break;
        }

        case 'UPCOMING_EMI': {
            const days = threshold_days || 5;
            const r = await pool.query(
                `SELECT description, due_date, amount FROM obligations
                 WHERE business_id = $1
                   AND obligation_type = 'EMI'
                   AND status = 'UPCOMING'
                   AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $2::integer`,
                [businessId, days]
            );
            if (r.rows.length > 0) {
                const ob = r.rows[0];
                return {
                    severity: 'MEDIUM',
                    title: 'EMI Due Soon',
                    message: `${ob.description} (₹${fmt(ob.amount)}) is due on ${ob.due_date}. Ensure sufficient balance.`,
                };
            }
            break;
        }

        case 'OVERDUE_INVOICE': {
            const r = await pool.query(
                `SELECT description, due_date, amount,
                        CURRENT_DATE - due_date AS days_overdue
                 FROM obligations
                 WHERE business_id = $1
                   AND status = 'OVERDUE'
                 ORDER BY days_overdue DESC LIMIT 1`,
                [businessId]
            );
            if (r.rows.length > 0) {
                const ob = r.rows[0];
                return {
                    severity: 'HIGH',
                    title: 'Overdue Invoice',
                    message: `${ob.description} (₹${fmt(ob.amount)}) is ${ob.days_overdue} day(s) overdue. Follow up with the vendor/client immediately.`,
                };
            }
            break;
        }

        case 'LARGE_DEBIT': {
            // Flag if any single debit in the last 7 days is > 30% of avg monthly inflow
            const avgRes = await pool.query(
                `SELECT AVG(daily_in) AS avg_monthly_inflow FROM (
                     SELECT txn_date, SUM(amount) AS daily_in
                     FROM bank_transactions
                     WHERE business_id = $1 AND direction = 'CREDIT' AND txn_date >= CURRENT_DATE - 60
                     GROUP BY txn_date
                 ) sub`,
                [businessId]
            );
            const avgInflow = parseFloat(avgRes.rows[0]?.avg_monthly_inflow || 0);
            if (avgInflow === 0) break;

            const threshold = avgInflow * 0.3;
            const r = await pool.query(
                `SELECT amount, narration, txn_date FROM bank_transactions
                 WHERE business_id = $1
                   AND direction = 'DEBIT'
                   AND amount > $2
                   AND txn_date >= CURRENT_DATE - 7
                 ORDER BY amount DESC LIMIT 1`,
                [businessId, threshold]
            );
            if (r.rows.length > 0) {
                const t = r.rows[0];
                return {
                    severity: 'MEDIUM',
                    title: 'Large Debit Detected',
                    message: `A debit of ₹${fmt(t.amount)} (${t.narration}) on ${t.txn_date} is unusually large. Review if expected.`,
                };
            }
            break;
        }

        default:
            break;
    }

    return null;
}

async function isInCooldown(pool, businessId, ruleId, minutes) {
    const r = await pool.query(
        `SELECT 1 FROM alert_events
         WHERE business_id = $1 AND rule_id = $2
           AND triggered_at > NOW() - INTERVAL '${minutes} minutes'
         LIMIT 1`,
        [businessId, ruleId]
    );
    return r.rows.length > 0;
}

async function writeAlertEvent(pool, businessId, ruleId, alert) {
    await pool.query(
        `INSERT INTO alert_events (business_id, rule_id, severity, title, message)
         VALUES ($1, $2, $3, $4, $5)`,
        [businessId, ruleId, alert.severity, alert.title, alert.message]
    );
    logger.info(`[CASHSENTINEL] Alert fired — ${alert.severity}: ${alert.title}`);
}

/**
 * Delivery hook — WhatsApp message delivery.
 * No-ops until WhatsApp Business API is configured.
 */
async function deliverAlert(businessName, alert) {
    // TODO (Phase 1.5): Integrate WhatsApp Business API (Twilio or Meta direct)
    // await whatsappClient.sendMessage(businessPhone, formatAlertMessage(alert));
    logger.info(`[CASHSENTINEL] [WHATSAPP_STUB] Would send to ${businessName}: "${alert.title}"`);
}

function fmt(n) {
    return parseFloat(n).toLocaleString('en-IN');
}

/**
 * Start the CashSentinel scheduled cron job.
 * Runs every hour. Call this once on server startup.
 *
 * @param {object} pool - PostgreSQL pool
 */
function startSentinel(pool) {
    // Run immediately on startup
    runSentinelSweep(pool).catch(e => logger.error(`[CASHSENTINEL] Startup sweep failed: ${e.message}`));
    runScheduledPaymentsSweep(pool).catch(e => logger.error(`[SCHEDULER] Startup payment sweep failed: ${e.message}`));

    // Then every hour
    cron.schedule('0 * * * *', () => {
        runSentinelSweep(pool).catch(e => logger.error(`[CASHSENTINEL] Scheduled sweep failed: ${e.message}`));
        runScheduledPaymentsSweep(pool).catch(e => logger.error(`[SCHEDULER] Scheduled payment sweep failed: ${e.message}`));
    });

    logger.info('[CASHSENTINEL] ✅ Alert sentinel and Payment Scheduler started.');
}

module.exports = { startSentinel, runSentinelSweep };
