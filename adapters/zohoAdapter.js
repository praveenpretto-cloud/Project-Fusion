'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════
 * ZOHO ADAPTER — adapters/zohoAdapter.js
 * Handles Zoho Books OAuth token refresh + invoice fetch + normalize
 * ═══════════════════════════════════════════════════════════════════
 */

const https = require('https');
const querystring = require('querystring');
const logger = require('../logger');

// ── HOST CONFIGURATION (defaults to India .in, overridable via env) ────────
const ZOHO_DOMAIN = process.env.ZOHO_DOMAIN || 'in';
const ACCOUNTS_HOST = process.env.ZOHO_ACCOUNTS_HOST || `accounts.zoho.${ZOHO_DOMAIN}`;
const API_HOST = process.env.ZOHO_API_HOST || `www.zohoapis.${ZOHO_DOMAIN}`;

// ── TOKEN CACHE (in-memory, refreshed automatically) ─────────────────────────
let _cachedToken = null;
let _tokenExpiresAt = 0;

/**
 * Gets a valid Zoho access token, refreshing if expired.
 */
async function getAccessToken() {
    const now = Date.now();
    if (_cachedToken && now < _tokenExpiresAt - 60000) {
        return _cachedToken;
    }

    logger.info('[ZOHO] Refreshing OAuth access token...');

    const postData = querystring.stringify({
        refresh_token: process.env.ZOHO_REFRESH_TOKEN,
        client_id:     process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type:    'refresh_token',
    });

    return new Promise((resolve, reject) => {
        const options = {
            hostname: ACCOUNTS_HOST,
            path:     '/oauth/v2/token',
            method:   'POST',
            headers: {
                'Content-Type':   'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
            },
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error || !json.access_token) {
                        return reject(new Error(`Zoho token refresh failed: ${json.error || 'no access_token'}`));
                    }
                    _cachedToken = json.access_token;
                    _tokenExpiresAt = now + (json.expires_in || 3600) * 1000;
                    logger.info('[ZOHO] ✅ Access token refreshed successfully');
                    resolve(_cachedToken);
                } catch (e) {
                    reject(new Error(`Zoho token parse error: ${e.message}`));
                }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

/**
 * Makes an authenticated GET request to Zoho Books API.
 */
async function zohoGet(path, params = {}) {
    const token = await getAccessToken();
    const orgId = process.env.ZOHO_ORG_ID;

    // Build query string safely — always include org id, then any extra params
    const qs = new URLSearchParams({ organization_id: orgId, ...params }).toString();

    return new Promise((resolve, reject) => {
        const options = {
            hostname: API_HOST,
            path:     `/books/v3${path}?${qs}`,
            method:   'GET',
            headers: {
                'Authorization': `Zoho-oauthtoken ${token}`,
                'Content-Type':  'application/json',
            },
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 400 || (json.code !== undefined && json.code !== 0)) {
                        return reject(new Error(`Zoho API error [${json.code || res.statusCode}]: ${json.message || data}`));
                    }
                    resolve(json);
                } catch (e) {
                    reject(new Error(`Zoho API parse error: ${e.message}`));
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Makes an authenticated POST/PUT request to Zoho Books API.
 */
async function zohoPost(path, body, method = 'POST') {
    const token = await getAccessToken();
    const orgId = process.env.ZOHO_ORG_ID;
    const bodyStr = JSON.stringify(body);

    return new Promise((resolve, reject) => {
        const options = {
            hostname: API_HOST,
            path:     `/books/v3${path}?organization_id=${orgId}`,
            method,
            headers: {
                'Authorization':  `Zoho-oauthtoken ${token}`,
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
            },
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 400 || (json.code !== undefined && json.code !== 0)) {
                        return reject(new Error(`Zoho API error [${json.code || res.statusCode}]: ${json.message || data}`));
                    }
                    resolve(json);
                } catch (e) {
                    reject(new Error(`Zoho POST parse error: ${e.message}`));
                }
            });
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

/**
 * Fetches unpaid/sent invoices from Zoho Books.
 * @returns {Array} Array of raw Zoho invoice objects
 */
async function fetchPendingInvoices() {
    logger.info('[ZOHO] Fetching pending invoices from Zoho Books...');
    // Status 'unpaid' in Zoho Books captures sent, overdue, and partially_paid invoices
    const response = await zohoGet('/invoices', { status: 'unpaid', sort_column: 'due_date', sort_order: 'A' });

    if (!response.invoices) {
        logger.warn('[ZOHO] No invoices returned from Zoho API');
        return [];
    }

    logger.info(`[ZOHO] ✅ Fetched ${response.invoices.length} pending invoice(s)`);
    return response.invoices;
}

/**
 * Fetches a single invoice's full details by Zoho invoice ID.
 */
async function fetchInvoiceById(zohoInvoiceId) {
    const response = await zohoGet(`/invoices/${zohoInvoiceId}`);
    if (!response.invoice) {
        throw new Error(`Invoice ${zohoInvoiceId} not found in Zoho`);
    }
    return response.invoice;
}

/**
 * Marks a Zoho invoice as paid after Fusion settles it.
 * @param {string} zohoInvoiceId
 * @param {Object} paymentDetails - { amount, date, reference (UTR/intent_id), mode, customerId }
 */
async function markInvoicePaid(zohoInvoiceId, paymentDetails) {
    logger.info(`[ZOHO] Marking invoice ${zohoInvoiceId} as paid in Zoho Books...`);

    // Zoho Books customerpayments API requires customer_id
    let customerId = paymentDetails.customerId || paymentDetails.customer_id;
    if (!customerId) {
        try {
            const inv = await fetchInvoiceById(zohoInvoiceId);
            customerId = inv.customer_id;
        } catch (fetchErr) {
            logger.warn(`[ZOHO] Could not pre-fetch customer_id for invoice ${zohoInvoiceId}: ${fetchErr.message}`);
        }
    }

    const payload = {
        customer_id:     customerId,
        payment_mode:    paymentDetails.mode || 'bank_transfer',
        amount:          paymentDetails.amount,
        date:            paymentDetails.date || new Date().toISOString().split('T')[0],
        reference_number: paymentDetails.reference || '',
        description:     `Settled via Project Fusion | Ref: ${paymentDetails.reference}`,
        invoices: [
            {
                invoice_id:     zohoInvoiceId,
                amount_applied: paymentDetails.amount,
            },
        ],
    };

    const response = await zohoPost('/customerpayments', payload);

    if (response.code !== 0) {
        throw new Error(`Zoho mark-paid failed: ${response.message}`);
    }

    logger.info(`[ZOHO] ✅ Invoice ${zohoInvoiceId} marked as paid. Payment ID: ${response.payment?.payment_id}`);
    return response.payment;
}

/**
 * Normalizes a Zoho invoice object into Fusion's InvoiceInstruction schema.
 * This is the bridge between Zoho's API shape and what InvoiceProcessor expects.
 *
 * @param {Object} zohoInvoice - Raw invoice from Zoho Books API
 * @returns {Object} Normalized invoice object compatible with InvoiceProcessor
 */
function normalizeZohoInvoice(zohoInvoice) {
    // Default to INR for Indian businesses (not USD)
    const currency = (zohoInvoice.currency_code || 'INR').toUpperCase();
    const total    = parseFloat(zohoInvoice.total || zohoInvoice.balance || 0);

    return {
        // Core identifiers
        invoiceId:       `ZOHO-${zohoInvoice.invoice_id}`,
        zohoInvoiceId:   zohoInvoice.invoice_id,
        invoiceNumber:   zohoInvoice.invoice_number || zohoInvoice.invoice_id,
        sourceType:      'zoho',

        // Dates
        invoiceDate:     zohoInvoice.date || new Date().toISOString().split('T')[0],
        dueDate:         zohoInvoice.due_date || null,
        paymentTermsDays: zohoInvoice.payment_terms || 30,

        // Financials
        totalAmount:     total,
        currency,
        balance:         parseFloat(zohoInvoice.balance || total),

        // Parties
        seller: {
            name:    process.env.ZOHO_ORG_NAME || 'Fusion Seller',
            gstPan:  zohoInvoice.gst_no || null,
        },
        buyer: {
            name:    zohoInvoice.customer_name || 'Unknown Buyer',
            email:   zohoInvoice.email || null,
            zohoId:  zohoInvoice.customer_id || null,
        },

        // Line items
        lineItems: (zohoInvoice.line_items || []).map(li => ({
            description: li.description || li.name,
            quantity:    li.quantity || 1,
            rate:        parseFloat(li.rate || 0),
            amount:      parseFloat(li.item_total || 0),
        })),

        // Instruction fields (maps into Fusion's instruction schema)
        amount:    total,
        sender:    zohoInvoice.customer_name || 'ZOHO_BUYER',
        recipient: process.env.ZOHO_ORG_NAME || 'FUSION_SELLER',
        purpose:   currency === 'INR' ? 'DOMESTIC_PAYMENT' : 'EXPORT_INVOICE',

        // Raw Zoho metadata preserved for audit
        _zohoRaw: {
            status:         zohoInvoice.status,
            invoice_number: zohoInvoice.invoice_number,
            reference:      zohoInvoice.reference_number,
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// CASHIQ EXTENSIONS — Invoice & Bill Sync for Obligations Table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all outstanding customer invoices from Zoho (unpaid, sorted by due date).
 * Used by CashIQ to populate the obligations timeline.
 * @returns {Array} Array of raw Zoho invoice objects
 */
async function getOutstandingInvoices() {
    logger.info('[ZOHO_CASHIQ] Fetching outstanding customer invoices...');
    try {
        const res = await zohoGet('/invoices', {
            status: 'unpaid',
            sort_column: 'due_date',
            sort_order: 'A',
        });
        logger.info(`[ZOHO_CASHIQ] ✅ Found ${(res.invoices || []).length} outstanding invoice(s)`);
        return res.invoices || [];
    } catch (err) {
        logger.warn(`[ZOHO_CASHIQ] getOutstandingInvoices failed (using stub): ${err.message}`);
        return [];
    }
}

/**
 * Fetch all outstanding vendor bills from Zoho Books.
 * @returns {Array} Array of raw Zoho bill objects
 */
async function getVendorBills() {
    logger.info('[ZOHO_CASHIQ] Fetching vendor bills...');
    try {
        const res = await zohoGet('/bills', {
            status: 'unpaid',
            sort_column: 'due_date',
            sort_order: 'A',
        });
        logger.info(`[ZOHO_CASHIQ] ✅ Found ${(res.bills || []).length} vendor bill(s)`);
        return res.bills || [];
    } catch (err) {
        logger.warn(`[ZOHO_CASHIQ] getVendorBills failed (using stub): ${err.message}`);
        return [];
    }
}

/**
 * Sync outstanding invoices and vendor bills from Zoho into the obligations table.
 *
 * @param {object} pool        - PostgreSQL pool
 * @param {string} businessId  - UUID of the business in CashIQ
 * @returns {{ synced: number, errors: string[] }}
 */
async function syncObligationsFromZoho(pool, businessId) {
    const [invoices, bills] = await Promise.all([getOutstandingInvoices(), getVendorBills()]);

    let synced = 0;
    const errors = [];

    // Sync customer invoices (receivables — things you'll receive)
    for (const inv of invoices) {
        try {
            const dueDate = inv.due_date || inv.date;
            if (!dueDate) continue;

            const isOverdue = new Date(dueDate) < new Date();

            await pool.query(
                `INSERT INTO obligations
                    (business_id, obligation_type, description, due_date, amount, currency, status, source, source_ref)
                 VALUES ($1,'INVOICE_DUE',$2,$3,$4,$5,$6,'ZOHO',$7)
                 ON CONFLICT DO NOTHING`,
                [
                    businessId,
                    `${inv.customer_name || 'Customer'} — ${inv.invoice_number || inv.invoice_id}`,
                    dueDate,
                    parseFloat(inv.balance || inv.total || 0),
                    (inv.currency_code || 'INR').toUpperCase(),
                    isOverdue ? 'OVERDUE' : 'UPCOMING',
                    inv.invoice_id,
                ]
            );
            synced++;
        } catch (err) {
            errors.push(`Invoice ${inv.invoice_id}: ${err.message}`);
        }
    }

    // Sync vendor bills (payables — things you owe)
    for (const bill of bills) {
        try {
            const dueDate = bill.due_date || bill.date;
            if (!dueDate) continue;

            const isOverdue = new Date(dueDate) < new Date();

            await pool.query(
                `INSERT INTO obligations
                    (business_id, obligation_type, description, due_date, amount, currency, status, source, source_ref)
                 VALUES ($1,'VENDOR_PAYMENT',$2,$3,$4,$5,$6,'ZOHO',$7)
                 ON CONFLICT DO NOTHING`,
                [
                    businessId,
                    `${bill.vendor_name || 'Vendor'} — ${bill.bill_number || bill.bill_id}`,
                    dueDate,
                    parseFloat(bill.balance || bill.total || 0),
                    (bill.currency_code || 'INR').toUpperCase(),
                    isOverdue ? 'OVERDUE' : 'UPCOMING',
                    bill.bill_id,
                ]
            );
            synced++;
        } catch (err) {
            errors.push(`Bill ${bill.bill_id}: ${err.message}`);
        }
    }

    logger.info(`[ZOHO_CASHIQ] Sync complete — ${synced} obligations upserted, ${errors.length} errors`);
    return { synced, errors };
}

module.exports = {
    fetchPendingInvoices,
    fetchInvoiceById,
    markInvoicePaid,
    normalizeZohoInvoice,
    // CashIQ sync entrypoint
    syncObligationsFromZoho,
};

