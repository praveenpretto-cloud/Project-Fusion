'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * PROGRAMMABLE CONDITIONS ENGINE
 * GIFT City IFSC — Invoice Payment Milestone Converter
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Converts raw invoice payment terms into structured saga steps that the
 * existing Saga orchestrator (sagaCore.js / exporterFxManagement.js) can
 * execute atomically with compensating rollback on failure.
 *
 * GIFT IFSC PSR 2024 Escrow Rules:
 *  - Any conditional hold (non-immediate payment) must be treated as escrow
 *    activity under Payment Services Regulations 2024.
 *  - Escrow must be held with an IBU/IBC (International Banking Unit /
 *    International Banking Connection) in GIFT City.
 *  - For this prototype, escrow is implemented as a shadow-debit on the
 *    existing `balances` table with `escrow_required: true` flagged in the
 *    saga config for the operator to review before triggering.
 *  - No INR wallets — only permitted foreign currencies (USD, EUR, GBP, SGD etc.)
 *
 * Default Exporter Rules (GIFT City Best Practice):
 *  - 70-90% advance hold at receipt (liquidity management)
 *  - Remaining on milestones: shipment proof → quality cert → buyer acceptance
 *
 * TRIGGER TYPES:
 *  - 'due_date'     : Release on calendar date (no oracle needed)
 *  - 'oracle'       : Release on logistics oracle confirmation (e.g. eSHARE, DGFT)
 *  - 'api'          : Release on external API callback (buyer ERP / CRM)
 *  - 'manual'       : Release on explicit human approval
 */

const logger = require('../../logger');

// ─── REGEX PATTERNS FOR CONDITION PARSING ────────────────────────────────────

// Matches: "50% on shipment", "50 percent on delivery", "50% upon shipment"
const PCT_MILESTONE_REGEX = /(\d+(?:\.\d+)?)\s*%?\s*(?:percent)?\s*(?:on|upon|after|at)\s+([\w\s]+?)(?:,|;|$|and)/gi;

// Matches: "Net 30", "net-60", "net 90 days", "30 days from invoice"
const NET_TERMS_REGEX = /(?:net[-\s]?)(\d+)(?:\s*days?)?/i;

// Matches: "within 30 days", "within 60 days of"
const WITHIN_DAYS_REGEX = /within\s+(\d+)\s*days?/i;

// Maps milestone keywords to structured trigger types
const MILESTONE_MAP = {
    shipment: { milestone: 'shipment_proof', triggerType: 'oracle', defaultDays: 30 },
    dispatch: { milestone: 'shipment_proof', triggerType: 'oracle', defaultDays: 30 },
    delivery: { milestone: 'delivery_confirmed', triggerType: 'oracle', defaultDays: 45 },
    receipt: { milestone: 'goods_receipt', triggerType: 'oracle', defaultDays: 30 },
    acceptance: { milestone: 'buyer_acceptance', triggerType: 'api', defaultDays: 60 },
    approval: { milestone: 'buyer_acceptance', triggerType: 'api', defaultDays: 60 },
    quality: { milestone: 'quality_cert', triggerType: 'oracle', defaultDays: 45 },
    inspection: { milestone: 'quality_cert', triggerType: 'oracle', defaultDays: 45 },
    'letter of credit': { milestone: 'lc_confirmed', triggerType: 'api', defaultDays: 14 },
    lc: { milestone: 'lc_confirmed', triggerType: 'api', defaultDays: 14 },
    advance: { milestone: 'advance_payment', triggerType: 'due_date', defaultDays: 0 },
    upfront: { milestone: 'advance_payment', triggerType: 'due_date', defaultDays: 0 },
};

// Rail selection based on currency and amount
const RAIL_SELECTOR = {
    // > $50k cross-border: FCSS (GIFT City RTGS)
    large_foreign: 'fcss_or_stablecoin',
    // Standard cross-border fiat
    foreign: 'stripe_or_airwallex',
    // Crypto/stablecoin bridge
    crypto: 'stellar_usdc_bridge',
    // INR leg (not used for invoice holds — foreign currency only per GIFT IFSC PSR 2024)
    inr: 'razorpay',
};

/**
 * Selects the appropriate payment rail based on currency and amount.
 * GIFT IFSC PSR 2024: Only permitted foreign currencies — no INR e-wallets.
 *
 * @param {string} currency
 * @param {number} amount
 * @returns {string} Rail identifier
 */
function selectRail(currency, amount) {
    const INR_CURRENCIES = ['INR'];
    const CRYPTO_CURRENCIES = ['USDC', 'USDT', 'XLM', 'BTC', 'ETH'];
    const FOREIGN_CURRENCIES = ['USD', 'EUR', 'GBP', 'SGD', 'AED', 'JPY', 'CHF', 'CAD'];

    if (INR_CURRENCIES.includes(currency)) {
        // WARNING: INR holds are NOT permitted under GIFT IFSC PSR 2024 for escrow
        logger.warn(`[CONDITIONS_ENGINE] ⚠️ INR currency detected for escrow step. GIFT IFSC PSR 2024 prohibits INR e-wallets for conditional holds.`);
        return RAIL_SELECTOR.inr;
    }

    if (CRYPTO_CURRENCIES.includes(currency)) {
        return RAIL_SELECTOR.crypto;
    }

    if (FOREIGN_CURRENCIES.includes(currency)) {
        return amount > 50000 ? RAIL_SELECTOR.large_foreign : RAIL_SELECTOR.foreign;
    }

    return RAIL_SELECTOR.foreign; // Default fallback
}

/**
 * Parses a raw conditions string into structured condition objects.
 * Handles: "50% on shipment, balance on acceptance", "net 60 days", etc.
 *
 * @param {string|string[]} rawConditions
 * @param {number} paymentTermsDays
 * @returns {Array<{milestone, percentage, triggerType, timeoutDays}>}
 */
function parseRawConditions(rawConditions, paymentTermsDays = 90) {
    const conditions = [];
    const text = Array.isArray(rawConditions) ? rawConditions.join(' ') : String(rawConditions || '');

    if (!text.trim()) return [];

    let totalAssigned = 0;
    const matches = [...text.matchAll(PCT_MILESTONE_REGEX)];

    for (const match of matches) {
        const percentage = parseFloat(match[1]);
        const milestoneRaw = match[2].trim().toLowerCase();

        // Find the best matching milestone
        let milestoneConfig = null;
        for (const [keyword, config] of Object.entries(MILESTONE_MAP)) {
            if (milestoneRaw.includes(keyword)) {
                milestoneConfig = config;
                break;
            }
        }

        if (!milestoneConfig) {
            // Unknown milestone — use manual approval as safe default
            milestoneConfig = { milestone: 'manual_review', triggerType: 'manual', defaultDays: paymentTermsDays };
        }

        conditions.push({
            milestone: milestoneConfig.milestone,
            percentage,
            triggerType: milestoneConfig.triggerType,
            timeoutDays: milestoneConfig.defaultDays,
        });

        totalAssigned += percentage;
    }

    // If no specific milestones parsed but we have payment terms, create a due-date release
    if (conditions.length === 0 && (paymentTermsDays > 0 || NET_TERMS_REGEX.test(text) || WITHIN_DAYS_REGEX.test(text))) {
        const netMatch = text.match(NET_TERMS_REGEX) || text.match(WITHIN_DAYS_REGEX);
        const days = netMatch ? parseInt(netMatch[1]) : paymentTermsDays;

        conditions.push({
            milestone: 'due_date_release',
            percentage: 100,
            triggerType: 'due_date',
            timeoutDays: days,
        });
        totalAssigned = 100;
    }

    // Assign remainder to final milestone if percentages don't add up to 100
    if (conditions.length > 0 && totalAssigned < 100) {
        const lastCondition = conditions[conditions.length - 1];
        lastCondition.percentage += (100 - totalAssigned);
        lastCondition.milestone = lastCondition.milestone.includes('acceptance')
            ? 'buyer_acceptance_or_due_date'
            : lastCondition.milestone;
    }

    return conditions;
}

/**
 * Generates default exporter conditions when no specific terms are provided.
 * Follows GIFT City best practice for export financing.
 *
 * Default structure:
 *  - 80% advance hold (escrow at IBU)
 *  - 50% of remainder on shipment proof (logistics oracle)
 *  - 50% of remainder on buyer acceptance or due date
 *
 * @param {number} paymentTermsDays
 * @returns {Array}
 */
function generateDefaultExporterConditions(paymentTermsDays) {
    const holdPct = 80;
    const releasePct1 = 10; // 50% of remaining 20%
    const releasePct2 = 10; // 50% of remaining 20%

    return [
        {
            milestone: 'compliance_pass',
            percentage: holdPct,
            triggerType: 'due_date',
            timeoutDays: 0,
        },
        {
            milestone: 'shipment_proof',
            percentage: releasePct1,
            triggerType: 'oracle',
            timeoutDays: 30,
        },
        {
            milestone: 'buyer_acceptance_or_due_date',
            percentage: releasePct2,
            triggerType: paymentTermsDays > 0 ? 'due_date' : 'api',
            timeoutDays: paymentTermsDays,
        },
    ];
}

/**
 * Converts an array of extracted conditions into Saga step definitions.
 * Each step maps 1:1 to a step the existing sagaCore / exporterFxManagement can execute.
 *
 * Saga step shape (compatible with existing orchestrators):
 * {
 *   stepId: string,           // Unique identifier for the step
 *   amountPct: number,        // % of totalAmount for this step
 *   amountAbsolute: number,   // Actual computed amount
 *   rail: string,             // Payment rail to use (fcss/stripe/stellar)
 *   condition: string,        // Trigger condition label
 *   triggerType: string,      // 'due_date' | 'oracle' | 'api' | 'manual'
 *   timeoutDays: number,      // Days before auto-release/escalation
 *   escrow_required: boolean, // GIFT IFSC PSR 2024 — flag escrow activity
 *   escrow_note: string,      // Prototype note for human review
 *   compensatingAction: string, // Action on rollback
 * }
 *
 * @param {Array} extractedConditions
 * @param {number} totalAmount
 * @param {string} currency
 * @returns {Array<Object>} Saga-compatible step array
 */
function conditionsToSagaSteps(extractedConditions, totalAmount, currency) {
    return extractedConditions.map((cond, index) => {
        const amountAbsolute = parseFloat(((cond.percentage / 100) * totalAmount).toFixed(4));
        const isEscrow = cond.triggerType !== 'due_date' || index > 0; // All non-immediate holds are escrow

        return {
            stepId: `step_${index + 1}_${cond.milestone.replace(/[^a-z0-9]/gi, '_')}`,
            amountPct: cond.percentage,
            amountAbsolute,
            currency,
            rail: selectRail(currency, amountAbsolute),
            condition: cond.milestone,
            triggerType: cond.triggerType,
            timeoutDays: cond.timeoutDays,
            escrow_required: isEscrow,
            // PROTOTYPE NOTE: Real escrow = IBU/IBC account at GIFT City.
            // For this prototype, we shadow-debit the `balances` table.
            escrow_note: isEscrow
                ? '[PROTOTYPE] Escrow simulated via shadow-debit on balances table. Production: IBU escrow account at GIFT City IBU required per PSR 2024.'
                : null,
            compensatingAction: `refund_hold_step_${index + 1}`,
            status: 'PENDING', // Initial step state
        };
    });
}

/**
 * MAIN ENTRY POINT
 *
 * Takes a full invoice object and produces a structured conditions array
 * and saga step array ready for the Saga orchestrator.
 *
 * @param {Object} invoice - Normalised invoice object
 * @returns {{ extractedConditions: Array, sagaSteps: Array, useDefaultRules: boolean }}
 */
function createProgrammableConditions(invoice) {
    const { invoiceId, totalAmount, currency, paymentTermsDays = 90, rawConditions } = invoice;

    logger.info(`[CONDITIONS_ENGINE] Processing conditions for invoice ${invoiceId} | ${currency} ${totalAmount} | ${paymentTermsDays}d terms`);

    let extractedConditions;
    let useDefaultRules = false;

    // Attempt to parse conditions from raw text
    const parsed = parseRawConditions(rawConditions, paymentTermsDays);

    if (parsed.length > 0) {
        extractedConditions = parsed;
        logger.info(`[CONDITIONS_ENGINE] Parsed ${parsed.length} condition(s) from raw terms for ${invoiceId}`);
    } else {
        // Fallback to default exporter rules
        extractedConditions = generateDefaultExporterConditions(paymentTermsDays);
        useDefaultRules = true;
        logger.info(`[CONDITIONS_ENGINE] No specific conditions found for ${invoiceId}. Applying default exporter rules (${paymentTermsDays}d terms).`);
    }

    // Validate total percentages add up to 100%
    const totalPct = extractedConditions.reduce((sum, c) => sum + c.percentage, 0);
    if (Math.abs(totalPct - 100) > 0.01) {
        logger.warn(`[CONDITIONS_ENGINE] ⚠️ Conditions for ${invoiceId} sum to ${totalPct}% (expected 100%). Normalising...`);
        // Normalise the last step to make total = 100
        if (extractedConditions.length > 0) {
            const diff = 100 - totalPct;
            extractedConditions[extractedConditions.length - 1].percentage += diff;
        }
    }

    const sagaSteps = conditionsToSagaSteps(extractedConditions, totalAmount, currency);

    logger.info(`[CONDITIONS_ENGINE] ✅ Generated ${sagaSteps.length} saga steps for ${invoiceId}. Escrow required: ${sagaSteps.some(s => s.escrow_required)}`);

    return {
        extractedConditions,
        sagaSteps,
        useDefaultRules,
        totalEscrowAmount: sagaSteps
            .filter(s => s.escrow_required)
            .reduce((sum, s) => sum + s.amountAbsolute, 0),
    };
}

module.exports = {
    createProgrammableConditions,
    parseRawConditions,
    conditionsToSagaSteps,
    generateDefaultExporterConditions,
    selectRail,
};
