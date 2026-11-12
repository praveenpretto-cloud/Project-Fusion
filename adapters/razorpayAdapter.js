'use strict';

// RAZORPAY ADAPTER (Indian Payment Aggregator)
// Integrates with RazorpayX Payouts API for INR Fiat Disbursements

async function executeRazorpayRail(instruction) {
    const { getAdapterCredential } = require('../vaultProvider');
    const logger = require('../logger');
    const { amount, currency, recipient } = instruction;
    const instructionId = instruction.instructionId || instruction.instruction_id;

    const keyId = getAdapterCredential('RAZORPAY_KEY_ID');
    const keySecret = getAdapterCredential('RAZORPAY_KEY_SECRET');
    const accountNumber = process.env.RAZORPAYX_ACCOUNT_NUMBER || '2323230040153680';

    logger.info(
        `[RAZORPAYX] Executing Payout for ${amount} ${currency} (Rail: LIVE_RAZORPAYX_TESTNET)`
    );

    // MOCK BYPASS DISABLED — ALL PAYOUTS ARE NOW PROCESSED VIA REAL RAZORPAYX TESTNET

    try {
        const { validateProviderCredentialMode } = require('../core/configValidator');
        validateProviderCredentialMode({
            provider: 'core_razorpay',
            keyId,
            keySecret,
            environment: process.env.NETWORK_ENVIRONMENT || 'sandbox',
            endpoint: 'https://api.razorpay.com',
        });

        const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
        const headers = { 'Content-Type': 'application/json', Authorization: auth };

        logger.info(
            `[RAZORPAY REAL] 🟢 Initiating RazorpayX Payout API call for ${amount} ${currency}...`
        );

        // 1. Create recipient contact
        const contactController = new AbortController();
        const contactTimeout = setTimeout(() => contactController.abort(), 20000);
        let res = await fetch('https://api.razorpay.com/v1/contacts', {
            method: 'POST',
            headers,
            signal: contactController.signal,
            body: JSON.stringify({
                name: recipient,
                email: 'sandbox.recipient@example.com',
                contact: '919999999999',
                type: 'vendor',
                reference_id: `ct_${instructionId.slice(0, 15)}`,
            }),
        });
        clearTimeout(contactTimeout);
        let contact = await res.json();
        if (contact.error && contact.error.code)
            throw new Error(contact.error.description || contact.error.reason || 'Contact failed');

        // 2. Create fund account
        const fundController = new AbortController();
        const fundTimeout = setTimeout(() => fundController.abort(), 20000);
        res = await fetch('https://api.razorpay.com/v1/fund_accounts', {
            method: 'POST',
            headers,
            signal: fundController.signal,
            body: JSON.stringify({
                contact_id: contact.id,
                account_type: 'bank_account',
                bank_account: {
                    name: recipient,
                    ifsc: 'HDFC0000053', // Sandbox default
                    account_number: '765432123456789', // Sandbox default
                },
            }),
        });
        clearTimeout(fundTimeout);
        let fundAccount = await res.json();
        if (fundAccount.error && fundAccount.error.code)
            throw new Error(fundAccount.error.description || 'FundAccount failed');

        // 3. Initiate Payout
        const payoutController = new AbortController();
        const payoutTimeout = setTimeout(() => payoutController.abort(), 20000);
        const { toCanonicalMinorUnits } = require('../core/orchestrator/financialDecimal');
        const minorUnitsBigInt = toCanonicalMinorUnits(amount, 'INR');
        if (minorUnitsBigInt <= 0n) {
            throw new Error(`Invalid Razorpay amount: '${amount}'. Amount must be strictly greater than zero.`);
        }
        if (minorUnitsBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new RangeError(`Razorpay amount '${amount}' exceeds safe integer representation`);
        }
        const amountInPaise = Number(minorUnitsBigInt);
        res = await fetch('https://api.razorpay.com/v1/payouts', {
            method: 'POST',
            headers,
            signal: payoutController.signal,
            body: JSON.stringify({
                account_number: accountNumber,
                fund_account_id: fundAccount.id,
                amount: amountInPaise,
                currency: currency.toUpperCase(),
                mode: 'IMPS',
                purpose: 'payout',
                queue_if_low_balance: true,
                reference_id: `payout_${instructionId.slice(0, 10)}_${Date.now()}`.slice(0, 30),
                narration: 'Project Fusion IFSCA',
            }),
        });
        clearTimeout(payoutTimeout);
        let payout = await res.json();
        if (payout.error && payout.error.code && payout.error.code !== 'NA')
            throw new Error(payout.error.description || payout.error.reason || 'Payout failed');

        return {
            status: payout.status === 'processed' ? 'SUCCESS' : 'PROCESSING',
            intent_id: payout.id,
            utr: payout.utr || null,
            timestamp: new Date().toISOString(),
        };
    } catch (err) {
        logger.error(`[RAZORPAY ERROR] ${err.message || JSON.stringify(err)}`);
        return { status: 'FAILED', error: err.message || 'Razorpay Gateway Error' };
    }
}

async function queryStatus(intentId) {
    if (!intentId) return { status: 'UNKNOWN', utr: null };
    const { getAdapterCredential } = require('../vaultProvider');
    const keyId = getAdapterCredential('RAZORPAY_KEY_ID');
    const keySecret = getAdapterCredential('RAZORPAY_KEY_SECRET');

    if (!keyId || !keySecret) return { status: 'UNKNOWN', utr: null };

    const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    try {
        const res = await fetch(`https://api.razorpay.com/v1/payouts/${intentId}`, {
            method: 'GET',
            headers: { Authorization: auth },
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        let payout = await res.json();
        // Map 'processed' to 'succeeded' for the unified reconciler
        return {
            status: payout.status === 'processed' ? 'succeeded' : (payout.status || 'UNKNOWN'),
            utr: payout.utr || null
        };
    } catch {
        clearTimeout(timeoutId);
        return { status: 'UNKNOWN', utr: null };
    }
}

async function rollbackRazorpayRail(intentId) {
    const logger = require('../logger');
    if (!intentId) throw new Error('Cannot reverse: Missing RazorpayX Intent ID');

    // Note: RazorpayX Payouts are generally irreversible once processed (IMPS/NEFT).
    // In a production environment, this function would either attempt to cancel a 'queued' payout,
    // or trigger an internal Ops ticket for manual recovery. For the SAGA MVP, we simulate
    // the compensating transaction API call.
    try {
        logger.warn(`[RAZORPAYX REVERSAL] 🔄 Initiating reversal for Payout: ${intentId}`);
        return { status: 'REVERSED', reversal_id: `rev_${intentId.slice(0, 10)}` };
    } catch (err) {
        logger.error(`[RAZORPAYX ROLLBACK ERROR] ❌ Failed to reverse: ${err.message}`);
        return { status: 'REVERSAL_FAILED', error: err.message };
    }
}

/**
 * Validates and normalizes integer paise.
 * Rejects negative, floating-point, unsafe integers, or non-numeric values.
 *
 * @param {unknown} val
 * @param {string} fieldName
 * @returns {bigint}
 */
function validatePaise(val, fieldName) {
    if (val === null || val === undefined) {
        throw new TypeError(`Missing balance field: '${fieldName}'`);
    }
    let big;
    if (typeof val === 'number') {
        if (!Number.isSafeInteger(val)) {
            throw new TypeError(`Unsafe numeric value for '${fieldName}': '${val}'`);
        }
        if (val < 0) {
            throw new RangeError(`Negative balance value for '${fieldName}': '${val}'`);
        }
        big = BigInt(val);
    } else if (typeof val === 'string') {
        const trimmed = val.trim();
        if (!/^\d+$/.test(trimmed)) {
            throw new TypeError(`Invalid integer paise string for '${fieldName}': '${val}'`);
        }
        big = BigInt(trimmed);
    } else if (typeof val === 'bigint') {
        if (val < 0n) {
            throw new RangeError(`Negative balance value for '${fieldName}': '${val}'`);
        }
        big = val;
    } else {
        throw new TypeError(`Invalid type for '${fieldName}': '${typeof val}'`);
    }
    return big;
}

/**
 * Converts integer paise to an exact canonical rupee decimal string (2 decimal places).
 * Zero floating-point arithmetic.
 *
 * @param {bigint} paiseBig
 * @returns {string} e.g. "100.00"
 */
function paiseToRupeesDecimal(paiseBig) {
    const { toCanonicalDecimal } = require('../core/orchestrator/financialDecimal');
    const isNeg = paiseBig < 0n;
    const abs = isNeg ? -paiseBig : paiseBig;
    const str = abs.toString().padStart(3, '0');
    const intPart = str.slice(0, -2);
    const fracPart = str.slice(-2);
    const rawDecimal = `${isNeg ? '-' : ''}${intPart}.${fracPart}`;
    return toCanonicalDecimal(rawDecimal, 'INR');
}

/**
 * Evaluates freshness of the provider timestamp against configured TTL policy.
 * Returns 'UNKNOWN' if timestamp is missing/invalid or if no threshold is configured.
 *
 * @param {number|null|undefined} refreshedAt - Unix epoch seconds
 * @returns {'FRESH'|'STALE'|'UNKNOWN'}
 */
function evaluateFreshness(refreshedAt) {
    if (
        refreshedAt === null ||
        refreshedAt === undefined ||
        typeof refreshedAt !== 'number' ||
        !Number.isFinite(refreshedAt) ||
        refreshedAt <= 0
    ) {
        return 'UNKNOWN';
    }

    const ttlEnv = process.env.RAZORPAY_BALANCE_FRESHNESS_TTL_SECONDS;
    if (!ttlEnv || !ttlEnv.trim()) {
        return 'UNKNOWN';
    }

    const ttlSeconds = parseInt(ttlEnv, 10);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
        return 'UNKNOWN';
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const ageSeconds = nowSeconds - refreshedAt;
    if (ageSeconds > ttlSeconds) {
        return 'STALE';
    }
    if (ageSeconds < -60) {
        return 'UNKNOWN';
    }
    return 'FRESH';
}

/**
 * Fetches a single page of banking_balances from RazorpayX API.
 * Ensures timeout covers both the HTTP network request and response body read.
 *
 * @param {number} skip - Offset for pagination
 * @param {number} count - Page limit (max 100)
 * @param {string} authHeader - Basic Auth header value
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Object>} - Parsed collection JSON
 */
async function fetchBalancePage(skip, count, authHeader, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const url = `https://api.razorpay.com/v1/banking_balances?count=${count}&skip=${skip}`;
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                Authorization: authHeader,
                'Content-Type': 'application/json',
                'User-Agent': 'Project-Fusion-RazorpayX-Adapter/2.0',
            },
            signal: controller.signal,
        });

        // Ensure response body read is also covered within the try/finally timeout scope
        const text = await res.text();

        if (res.status === 401) {
            throw new Error('RazorpayX authentication failed: Invalid or expired API credentials (HTTP 401)');
        }
        if (res.status === 403) {
            throw new Error('RazorpayX permission denied: Banking balance feature or account access not provisioned (HTTP 403)');
        }
        if (res.status === 404) {
            throw new Error('RazorpayX endpoint unavailable: Banking balance route not found (HTTP 404)');
        }
        if (!res.ok) {
            throw new Error(`RazorpayX API HTTP error: ${res.status} ${res.statusText || ''}`.trim());
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch {
            throw new Error('RazorpayX API returned malformed JSON response');
        }

        if (!data || typeof data !== 'object' || data.entity !== 'collection' || !Array.isArray(data.items)) {
            throw new Error("RazorpayX API returned malformed collection response: expected entity 'collection' with items array");
        }

        return data;
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`RazorpayX balance request timed out after ${timeoutMs}ms`);
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Fetches real-time RazorpayX account balance for the configured business account via official banking_balances API.
 * 
 * NOTE: Successful balance retrieval reflects provider account liquidity only and does NOT guarantee
 * that a subsequent payout instruction will succeed or bypass KYC/AML/anti-fraud checks.
 *
 * @returns {Promise<Object>} - Structured balance metadata conforming to institutional contract
 */
async function getRazorpayBalance() {
    const { getAdapterCredential } = require('../vaultProvider');
    const logger = require('../logger');

    const keyId = getAdapterCredential('RAZORPAY_KEY_ID');
    const keySecret = getAdapterCredential('RAZORPAY_KEY_SECRET');

    if (!keyId || !keySecret) {
        throw new Error('Cannot retrieve balance: Missing RazorpayX Credentials');
    }

    if (keyId.startsWith('rzp_live_')) {
        throw new Error("FATAL: Live mode credentials ('rzp_live_') are strictly prohibited in sandbox balance inquiry");
    }

    if (!keyId.startsWith('rzp_test_')) {
        throw new Error("FATAL: Razorpay adapter requires a valid sandbox credential starting with 'rzp_test_'");
    }

    const configuredAccount = process.env.RAZORPAYX_ACCOUNT_NUMBER;
    if (!configuredAccount || !configuredAccount.trim()) {
        throw new Error('Cannot retrieve balance: Missing RAZORPAYX_ACCOUNT_NUMBER configuration');
    }

    const authHeader = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const timeoutMs = parseInt(process.env.RAZORPAY_TIMEOUT_MS, 10) || 15000;
    const PAGE_SIZE = 100;

    let skip = 0;
    let matchedItem = null;
    let fullySearched = false;

    while (!matchedItem && !fullySearched) {
        let pageData;
        try {
            pageData = await fetchBalancePage(skip, PAGE_SIZE, authHeader, timeoutMs);
        } catch (pageErr) {
            if (skip > 0) {
                logger.error(`[RAZORPAY BALANCE ERROR] Incomplete pagination at skip=${skip}: ${pageErr.message}`);
                throw new Error(`Incomplete pagination during RazorpayX balance fetch at skip=${skip}: ${pageErr.message}`);
            }
            logger.error(`[RAZORPAY BALANCE ERROR] ${pageErr.message}`);
            throw pageErr;
        }

        const items = pageData.items;
        const match = items.find(it => it && String(it.account_number) === String(configuredAccount));
        if (match) {
            matchedItem = match;
            break;
        }

        if (items.length < PAGE_SIZE) {
            fullySearched = true;
            break;
        }

        skip += PAGE_SIZE;
    }

    if (!matchedItem) {
        logger.warn('[RAZORPAY BALANCE] Configured account was not found in banking_balances collection after complete search');
        return {
            status: 'ACCOUNT_NOT_FOUND',
            account_type: null,
            currency: 'INR',
            amount_paise: null,
            available_amount_paise: null,
            amount: null,
            available_amount: null,
            refreshed_at: null,
            freshness: 'UNKNOWN',
        };
    }

    // Validate account currency
    const itemCurrency = (matchedItem.currency || '').toUpperCase();
    if (itemCurrency !== 'INR') {
        throw new Error(`Unexpected account currency '${matchedItem.currency}': expected 'INR'`);
    }

    // Validate and convert exact monetary amounts
    const amountBig = validatePaise(matchedItem.amount, 'amount');
    const availableBig = validatePaise(matchedItem.available_amount, 'available_amount');

    const freshness = evaluateFreshness(matchedItem.refreshed_at);

    return {
        status: 'AVAILABLE',
        account_type: matchedItem.account_type || null,
        currency: 'INR',
        amount_paise: amountBig.toString(),
        available_amount_paise: availableBig.toString(),
        amount: paiseToRupeesDecimal(amountBig),
        available_amount: paiseToRupeesDecimal(availableBig),
        refreshed_at: Number.isFinite(matchedItem.refreshed_at) ? matchedItem.refreshed_at : null,
        freshness,
    };
}

module.exports = Object.freeze({
    executeRazorpayRail,
    queryStatus,
    rollbackRazorpayRail,
    getRazorpayBalance,
});
