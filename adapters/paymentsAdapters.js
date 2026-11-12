'use strict';

// PAYMENTS ADAPTER
const { toCanonicalDecimal, decimalCompare } = require('../core/orchestrator/financialDecimal');
const logger = require('../logger');

// Stripe Limits for Fiat Testnet/Live Operations
const STRIPE_MIN_AMOUNT_CENTS = Object.freeze({
    USD: 50n, // $0.50
    EUR: 50n, // €0.50
    CAD: 50n, // $0.50
    GBP: 30n, // £0.30
    JPY: 50n, // ¥50
});
const STRIPE_MAX_AMOUNT_CENTS = 99999999n; // $999,999.99 (99,999,999 minor units)

// Explicitly Supported Card Payment Methods
const SUPPORTED_CARD_METHODS = Object.freeze({
    CARD: 'pm_card_visa',
    VISA: 'pm_card_visa',
    MASTERCARD: 'pm_card_mastercard',
    AMEX: 'pm_card_amex',
});

// Unsupported Bank Rails that must NEVER be processed as card test rails (module-private immutable list)
const BANK_RAILS = Object.freeze([
    'SWIFT',
    'ISO20022',
    'ISO 20022',
    'ISO_20022',
    'NEFT',
    'RTGS',
    'IMPS',
    'ACH',
    'FEDWIRE',
    'FED_WIRE',
    'FED WIRE',
    'CHAPS',
    'SEPA',
    'FASTER_PAYMENTS',
    'FASTER PAYMENTS',
    'FASTERPAYMENTS',
    'WIRE',
    'NIUM',
    'NIUM_SWIFT',
    'NIUM SWIFT',
    'NIUMSWIFT',
    'BANK_TRANSFER',
    'BANK TRANSFER',
    'BANKTRANSFER',
]);

/**
 * Checks if a given candidate string matches any known bank rail identifier,
 * normalizing separators (spaces, hyphens, underscores) and capitalization.
 *
 * @param {string} str - Candidate rail/purpose/method string
 * @returns {boolean}
 */
function isBankRailIdentifier(str) {
    if (!str || typeof str !== 'string') return false;
    const rawUpper = str.trim().toUpperCase();
    const underscore = rawUpper.replace(/[\s-]+/g, '_');
    const compact = rawUpper.replace(/[^A-Z0-9]/g, '');

    return BANK_RAILS.some((r) => {
        const rUnderscore = r.replace(/[\s-]+/g, '_');
        const rCompact = r.replace(/[^A-Z0-9]/g, '');
        return (
            rawUpper.includes(r) || underscore.includes(rUnderscore) || compact.includes(rCompact)
        );
    });
}

/**
 * Converts a fiat decimal amount string to Stripe integer minor units (cents / yen)
 * without using IEEE 754 floating-point arithmetic.
 *
 * @param {string|number} amount - Decimal string representation
 * @param {string} currency - Fiat currency code ('USD', 'EUR', 'GBP', 'CAD', 'JPY')
 * @returns {number} Integer minor units expected by Stripe
 */
function toStripeMinorUnits(amount, currency) {
    const curr = (currency || '').toUpperCase();
    if (!['USD', 'EUR', 'GBP', 'CAD', 'JPY'].includes(curr)) {
        throw new Error(`Unsupported Stripe fiat currency: '${currency}'`);
    }

    const {
        toCanonicalDecimal,
        toCanonicalMinorUnits,
        getAssetScale,
    } = require('../core/orchestrator/financialDecimal');
    const scale = getAssetScale(curr);
    const canonical = toCanonicalDecimal(amount, curr);
    const minorUnitsBigInt = toCanonicalMinorUnits(amount, curr);

    // Reject non-positive amounts
    if (minorUnitsBigInt <= 0n) {
        throw new Error(
            `Invalid Stripe amount: '${amount}'. Amount must be strictly greater than zero.`
        );
    }

    const minUnits = STRIPE_MIN_AMOUNT_CENTS[curr] || 50n;
    if (minorUnitsBigInt < minUnits) {
        const minStr =
            scale === 0 ? String(minUnits) : (Number(minUnits) / 10 ** scale).toFixed(scale);
        throw new RangeError(
            `Amount '${canonical}' is below Stripe minimum transaction limit of ${minStr} ${curr}`
        );
    }

    if (minorUnitsBigInt > STRIPE_MAX_AMOUNT_CENTS) {
        const maxStr = scale === 0 ? String(STRIPE_MAX_AMOUNT_CENTS) : '999,999.99';
        throw new RangeError(
            `Amount '${canonical}' exceeds Stripe maximum transaction limit of ${maxStr} ${curr}`
        );
    }

    if (minorUnitsBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`Amount '${canonical}' exceeds safe integer representation`);
    }

    return Number(minorUnitsBigInt);
}

async function executePaymentRail(instruction) {
    const { amount, currency, sender, recipient } = instruction;
    const instructionId = instruction.instructionId || instruction.instruction_id;

    // WORKSTREAM 2: PAYMENT METHOD & BANK RAIL ISOLATION
    const rawCandidates = [
        instruction.purpose,
        instruction.rail,
        instruction.route_selected,
        instruction.payment_method,
    ]
        .filter(Boolean)
        .map((s) => String(s).trim());

    const isBankRail = rawCandidates.some((cand) => isBankRailIdentifier(cand));

    if (isBankRail) {
        const detectedCandidate = rawCandidates.find((cand) => isBankRailIdentifier(cand));
        const detectedRail = detectedCandidate ? detectedCandidate.toUpperCase() : 'BANK_RAIL';
        logger.warn(
            `[STRIPE] Rejected bank rail '${detectedRail}' on Stripe card adapter. Bank rails cannot be processed via card test rails.`
        );
        return {
            adapter_type: 'SIMULATED_BANK_RAIL',
            status: 'SIMULATED',
            simulated: true,
            settlement_confirmed: false,
            currency: currency,
            rail: detectedRail,
            reason: `Unsupported bank rail '${detectedRail}' cannot be processed via Stripe card adapter. Zero external calls executed.`,
            timestamp: new Date().toISOString(),
        };
    }

    // Payment method and purpose resolution:
    // Unknown payment methods MUST remain rejected rather than defaulting to a card token.
    let pmToUse = null;
    let selectedRail = 'CARD';

    if (instruction.payment_method) {
        const pmCandidate = String(instruction.payment_method).trim().toUpperCase();
        pmToUse = SUPPORTED_CARD_METHODS[pmCandidate] || null;
        selectedRail = pmCandidate;
        if (!pmToUse) {
            logger.warn(`[STRIPE] Unsupported payment_method '${pmCandidate}'. Failing closed.`);
            return {
                adapter_type: 'STRIPE_UNSUPPORTED',
                status: 'SIMULATED',
                simulated: true,
                settlement_confirmed: false,
                currency: currency,
                rail: pmCandidate,
                reason: `Unsupported payment method '${pmCandidate}' rejected. Stripe adapter only supports verified card test rails (${Object.keys(SUPPORTED_CARD_METHODS).join(', ')}).`,
                timestamp: new Date().toISOString(),
            };
        }
    } else {
        const rawPurpose = (
            instruction.purpose ||
            instruction.rail ||
            instruction.route_selected ||
            'CARD'
        ).toUpperCase();
        selectedRail = rawPurpose;
        pmToUse =
            SUPPORTED_CARD_METHODS[rawPurpose] ||
            (['PAYROLL', 'EXPENSE', 'SETTLEMENT', 'INVOICE'].includes(rawPurpose)
                ? 'pm_card_visa'
                : null);
        if (!pmToUse) {
            logger.warn(
                `[STRIPE] Unsupported payment rail/purpose '${rawPurpose}'. Failing closed.`
            );
            return {
                adapter_type: 'STRIPE_UNSUPPORTED',
                status: 'SIMULATED',
                simulated: true,
                settlement_confirmed: false,
                currency: currency,
                rail: rawPurpose,
                reason: `Unsupported payment rail '${rawPurpose}' rejected. Stripe adapter only supports verified card test rails.`,
                timestamp: new Date().toISOString(),
            };
        }
    }

    // WORKSTREAM 1: EXACT DECIMAL CONVERSION (ZERO FLOATING-POINT MATH)
    let minorUnits;
    try {
        minorUnits = toStripeMinorUnits(amount, currency);
    } catch (convErr) {
        logger.error(`[STRIPE CONVERSION ERROR] ${convErr.message}`);
        return {
            status: 'FAILED',
            error: convErr.message,
            timestamp: new Date().toISOString(),
        };
    }

    // SUPPORTED STRIPE EXECUTION PATH: VALIDATE TESTNET CREDENTIALS BEFORE NETWORK CALL
    const { getAdapterCredential } = require('../vaultProvider');
    const { validateProviderCredentialMode } = require('../core/configValidator');
    const stripeKey = getAdapterCredential('STRIPE_KEY');
    validateProviderCredentialMode({
        provider: 'core_stripe',
        credential: stripeKey,
        environment: process.env.NETWORK_ENVIRONMENT || 'sandbox',
        endpoint: 'https://api.stripe.com',
    });

    const stripe = require('stripe')(stripeKey, { timeout: 20000 });
    logger.info(
        `[STRIPE] Executing PaymentIntent for ${minorUnits} minor units ${currency} (Rail: LIVE_TESTNET, PM: ${pmToUse})`
    );

    try {
        logger.info(
            `[STRIPE REAL] 🟢 Initiating REAL API call to Stripe for ${minorUnits} minor units ${currency}...`
        );

        const intent = await stripe.paymentIntents.create({
            amount: minorUnits,
            currency: currency.toLowerCase(),
            payment_method_types: ['card'],
            payment_method: pmToUse,
            confirm: true,
            return_url: 'http://localhost:3000',
            metadata: {
                instruction_id: instructionId,
                instructionId,
                sender,
                recipient,
                simulated_rail: selectedRail === 'CARD' ? 'VISA' : selectedRail,
            },
        });

        return {
            status: intent.status === 'succeeded' ? 'SUCCESS' : intent.status.toUpperCase(),
            intent_id: intent.id,
            timestamp: new Date().toISOString(),
        };
    } catch (err) {
        logger.error(`[STRIPE ERROR] ${err.message}`);
        return { status: 'FAILED', error: err.message };
    }
}

async function queryStatus(intentId) {
    if (!intentId) return 'UNKNOWN';
    const { getAdapterCredential } = require('../vaultProvider');
    const stripeKey = getAdapterCredential('STRIPE_KEY');
    const stripe = require('stripe')(stripeKey, { timeout: 20000 });
    try {
        const intent = await stripe.paymentIntents.retrieve(intentId);
        return intent.status;
    } catch {
        return 'UNKNOWN';
    }
}
/**
 * Executes a compensating refund against a confirmed Stripe PaymentIntent.
 *
 * GOVERNANCE:
 * Preserves the original payment intent record in Stripe.
 * Refunds are modeled as distinct compensating operations with their own
 * provider refund reference ('re_...') rather than pretending the original
 * transaction never occurred.
 *
 * @param {string} intentId - Stripe PaymentIntent ID
 * @returns {Promise<{ status: string, operation: string, refund_id: string, payment_intent_id: string, timestamp: string }>}
 */
async function refundPaymentRail(intentId) {
    if (!intentId) throw new Error('Cannot refund: Missing Stripe Intent ID');
    const { getAdapterCredential } = require('../vaultProvider');
    const { validateProviderCredentialMode } = require('../core/configValidator');
    const stripeKey = getAdapterCredential('STRIPE_KEY');
    validateProviderCredentialMode({
        provider: 'core_stripe',
        credential: stripeKey,
        environment: process.env.NETWORK_ENVIRONMENT || 'sandbox',
        endpoint: 'https://api.stripe.com',
    });

    const stripe = require('stripe')(stripeKey, { timeout: 20000 });
    const logger = require('../logger');

    try {
        logger.warn(
            `[STRIPE REFUND] 🔄 Initiating compensating refund for PaymentIntent: ${intentId}`
        );
        const refund = await stripe.refunds.create({
            payment_intent: intentId,
        });
        logger.info(`[STRIPE REFUND] ✅ Compensating refund successful. Refund ID: ${refund.id}`);
        return {
            status: 'REFUNDED',
            operation: 'COMPENSATING_REFUND',
            refund_id: refund.id,
            payment_intent_id: intentId,
            timestamp: new Date().toISOString(),
        };
    } catch (err) {
        logger.error(`[STRIPE REFUND ERROR] ❌ Failed to refund: ${err.message}`);
        return { status: 'REFUND_FAILED', error: err.message };
    }
}

/**
 * Fetches real-time Stripe balance.
 * @returns {Promise<number>} - Balance in smallest currency unit (e.g., cents)
 */
async function getPaymentBalance() {
    const { getAdapterCredential } = require('../vaultProvider');
    const stripeKey = getAdapterCredential('STRIPE_KEY');
    const logger = require('../logger');

    // MOCK BYPASS FOR DEMO
    if (!stripeKey) throw new Error('Cannot retrieve balance: Missing Stripe API Key');

    const stripe = require('stripe')(stripeKey, { timeout: 20000 });
    try {
        const balance = await stripe.balance.retrieve();
        // Summing up available balances for simplicity
        return balance.available.reduce((sum, b) => sum + b.amount, 0);
    } catch (err) {
        logger.error(`[STRIPE BALANCE ERROR] ${err.message}`);
        throw err;
    }
}

module.exports = Object.freeze({
    executePaymentRail,
    queryStatus,
    refundPaymentRail,
    rollbackPaymentRail: refundPaymentRail, // Backward-compatibility alias
    getPaymentBalance,
    toStripeMinorUnits,
    STRIPE_MIN_AMOUNT_CENTS,
    STRIPE_MAX_AMOUNT_CENTS,
    SUPPORTED_CARD_METHODS,
});
