'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * PDF INVOICE PARSER
 * Pattern-Estimated Regex Engine for Indian SME Invoice Formats
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Handles messy Indian SME invoices including:
 *  - Inconsistent layouts (logo-first, table-first, address-first)
 *  - Mixed English/Tamil/Hindi text (Unicode normalised)
 *  - GST invoices (GSTIN format: 22AAAAA0000A1Z5)
 *  - Scanned PDFs with OCR artifacts (pdf2json handles text layer)
 *  - Line items in variable column orders
 *  - Multiple date formats (DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, "15 Jan 2025")
 *
 * ARCHITECTURE:
 *  1. pdf2json extracts raw text with coordinates
 *  2. Text is joined into a flat string for regex matching
 *  3. Regex patterns attempt extraction in priority order
 *  4. Missing fields get null with a validation warning (not silently ignored)
 *  5. Returns the same normalised InvoiceObject shape as CSV parser
 *
 * LIMITATIONS (honest prototype notes):
 *  - pdf2json only works on PDFs with a text layer (not purely scanned images)
 *  - For image-only PDFs, OCR pre-processing (e.g. Tesseract) would be needed
 *  - Line item extraction is best-effort; complex tables may need manual review
 */

const PdfParser = require('pdf2json');
const crypto = require('crypto');
const logger = require('../../logger');

// ─── REGEX PATTERNS ───────────────────────────────────────────────────────────

/**
 * Date patterns — Indian SME invoices use inconsistent formats.
 * Priority: ISO > DD/MM/YYYY > DD-MM-YYYY > "15 January 2025"
 */
const DATE_PATTERNS = [
    /(\d{4}-\d{2}-\d{2})/,                                                       // ISO: 2025-01-15
    /(\d{2})[/.-](\d{2})[/.-](\d{4})/,                                    // DD/MM/YYYY or DD-MM-YYYY
    /(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})/i, // "15 Jan 2025"
];

const MONTH_MAP = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    january: '01', february: '02', march: '03', april: '04', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

// GSTIN: 15-character GST identification number
const GSTIN_REGEX = /\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1})\b/g;

// Invoice number patterns
const INVOICE_NO_REGEX = /(?:invoice\s*(?:no|number|#|num)[\s:.]*|inv[\s#:.]*|bill\s*no[\s:.]*)([\w/-]+)/i;

// Amount patterns (Indian format: 1,00,000 or 100,000 or 1000.00)
const AMOUNT_REGEX = /(?:total[^:]*[:$₹]?\s*)([\d,]+(?:\.\d{1,2})?)/i;
const GRAND_TOTAL_REGEX = /(?:grand\s+total|total\s+amount|net\s+payable|amount\s+due|total\s+due)[^\d]*([\d,]+(?:\.\d{1,2})?)/i;

// Currency detection
const CURRENCY_REGEX = /\b(USD|EUR|GBP|INR|SGD|AED|JPY|CAD|CHF|AUD)\b/i;
const RUPEE_SYMBOL_REGEX = /[₹]/;

// Payment terms
const PAYMENT_TERMS_REGEX = /(?:payment\s+terms?|due\s+date?|terms?\s+of\s+payment)[^:]*:?\s*([^\n]{3,60})/i;

// Indian state names for address parsing
const INDIAN_STATES = [
    'Tamil Nadu', 'Maharashtra', 'Karnataka', 'Gujarat', 'Delhi',
    'Telangana', 'West Bengal', 'Rajasthan', 'Uttar Pradesh', 'Kerala',
    'Andhra Pradesh', 'Punjab', 'Haryana', 'Bihar', 'Madhya Pradesh',
    'Odisha', 'Jharkhand', 'Assam', 'Himachal Pradesh', 'Uttarakhand',
    'Goa', 'Chhattisgarh', 'Jammu', 'Kashmir', 'Sikkim', 'Tripura',
    'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Arunachal Pradesh',
];

// City patterns common in Indian B2B invoices
const COMMON_INDIAN_CITIES = [
    'Chennai', 'Mumbai', 'Bangalore', 'Bengaluru', 'Delhi', 'Hyderabad',
    'Kolkata', 'Pune', 'Ahmedabad', 'Surat', 'Jaipur', 'Lucknow',
    'Kanpur', 'Nagpur', 'Visakhapatnam', 'Indore', 'Thane', 'Bhopal',
    'Pimpri', 'Patna', 'Vadodara', 'Ghaziabad', 'Ludhiana', 'Agra',
    'Nashik', 'Faridabad', 'Meerut', 'Rajkot', 'Varanasi', 'Coimbatore',
    'Madurai', 'Tiruchirappalli', 'Tirunelveli', 'Salem', 'Erode', 'Tirupur',
];

// ─── DATE NORMALISATION ────────────────────────────────────────────────────────

/**
 * Normalises any detected date string to ISO 8601 format (YYYY-MM-DD).
 *
 * @param {string} rawDate
 * @returns {string|null} ISO date string or null
 */
function normaliseDate(rawDate) {
    if (!rawDate) return null;

    const trimmed = rawDate.trim();

    // Pattern 1: Already ISO
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

    // Pattern 2: DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
    const ddmmyyyy = trimmed.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (ddmmyyyy) {
        const [, dd, mm, yyyy] = ddmmyyyy;
        return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    }

    // Pattern 3: "15 Jan 2025" or "15 January 2025"
    const textDate = trimmed.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if (textDate) {
        const [, dd, mon, yyyy] = textDate;
        const mm = MONTH_MAP[mon.toLowerCase()];
        if (mm) return `${yyyy}-${mm}-${dd.padStart(2, '0')}`;
    }

    // Pattern 4: MM/DD/YYYY (US format — less common in India but possible)
    const mmddyyyy = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mmddyyyy) {
        const [, mm, dd, yyyy] = mmddyyyy;
        // Heuristic: if first part > 12, it must be DD not MM
        if (parseInt(mm) > 12) {
            return `${yyyy}-${dd.padStart(2, '0')}-${mm.padStart(2, '0')}`;
        }
        return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    }

    return null;
}

/**
 * Cleans an amount string from Indian format to a float.
 * "1,00,000.50" → 100000.50
 *
 * @param {string} raw
 * @returns {number}
 */
function cleanAmount(raw) {
    if (!raw) return 0;
    return parseFloat(raw.replace(/,/g, '')) || 0;
}

/**
 * Extracts all text from a pdf2json parse result into a flat string.
 * Handles multi-page PDFs and preserves newlines between text blocks.
 *
 * @param {Object} pdfData - Raw pdf2json output
 * @returns {string} Flat text content
 */
function extractTextFromPdfData(pdfData) {
    if (!pdfData || !pdfData.Pages) return '';

    const lines = [];

    for (const page of pdfData.Pages) {
        if (!page.Texts) continue;

        // Sort text items by Y position (top-to-bottom), then X (left-to-right)
        const sortedTexts = [...page.Texts].sort((a, b) => {
            const yDiff = a.y - b.y;
            return Math.abs(yDiff) > 0.5 ? yDiff : a.x - b.x;
        });

        let currentY = null;
        let currentLine = [];

        for (const textItem of sortedTexts) {
            if (currentY === null || Math.abs(textItem.y - currentY) > 0.5) {
                if (currentLine.length > 0) {
                    lines.push(currentLine.join(' '));
                }
                currentLine = [];
                currentY = textItem.y;
            }

            if (textItem.R && Array.isArray(textItem.R)) {
                for (const run of textItem.R) {
                    if (run.T) {
                        // Decode URI component (pdf2json encodes special chars)
                        try {
                            currentLine.push(decodeURIComponent(run.T));
                        } catch {
                            currentLine.push(run.T);
                        }
                    }
                }
            }
        }

        if (currentLine.length > 0) {
            lines.push(currentLine.join(' '));
        }

        lines.push('---PAGE_BREAK---');
    }

    return lines.join('\n');
}

/**
 * Attempts to extract a structured address from a block of text.
 * Uses Indian-specific city and state dictionaries as anchors.
 *
 * @param {string} textBlock
 * @param {string} country - Default 'IN'
 * @returns {Object} Partial structured address
 */
function extractAddressBlock(textBlock, country = 'IN') {
    const address = {
        streetName: null,
        buildingNumber: null,
        townName: null,
        countrySubDivision: null,
        postCode: null,
        country,
    };

    // Extract PIN code first (6 digits for India)
    const pinMatch = textBlock.match(/\b(\d{6})\b/);
    if (pinMatch) address.postCode = pinMatch[1];

    // Find state
    for (const state of INDIAN_STATES) {
        if (new RegExp(`\\b${state}\\b`, 'i').test(textBlock)) {
            address.countrySubDivision = state;
            break;
        }
    }

    // Find city
    for (const city of COMMON_INDIAN_CITIES) {
        if (new RegExp(`\\b${city}\\b`, 'i').test(textBlock)) {
            address.townName = city;
            break;
        }
    }

    // Extract street from first line-ish content (best effort)
    const lines = textBlock.split(/\n/).map(l => l.trim()).filter(l => l.length > 3);
    if (lines.length > 0) {
        // Probable street: first line that isn't a company name (doesn't start with caps only)
        const streetLine = lines.find(l => /\d/.test(l) && l.length > 5) || lines[0];
        if (streetLine) {
            // Try to split building number from street name
            const buildingMatch = streetLine.match(/^((?:No\.?\s*)?[\d/-]+[A-Z]?)\s*[,:]?\s*(.+)$/i);
            if (buildingMatch) {
                address.buildingNumber = buildingMatch[1].replace(/^No\.?\s*/i, '').trim();
                address.streetName = buildingMatch[2].trim();
            } else {
                address.streetName = streetLine;
            }
        }
    }

    return address;
}

/**
 * Parses line items from the PDF text. Best-effort extraction.
 * Looks for tabular patterns: description | qty | unit price | total
 *
 * @param {string} text
 * @returns {Array<{description, quantity, unitPrice, lineTotal}>}
 */
function extractLineItems(text) {
    const lineItems = [];

    // Line item pattern: text followed by numbers (qty, price, total)
    // e.g. "Product Name   5   1000.00   5000.00"
    const lineItemRegex = /^(.{5,50}?)\s+(\d+(?:\.\d+)?)\s+([\d,]+(?:\.\d{1,2})?)\s+([\d,]+(?:\.\d{1,2})?)$/gm;
    const matches = [...text.matchAll(lineItemRegex)];

    for (const match of matches) {
        const [, description, quantity, unitPrice, lineTotal] = match;
        const desc = description.trim();

        // Filter out header rows and noise
        if (/^(description|item|product|particulars|service|qty|quantity|hsn|gst)/i.test(desc)) continue;
        if (desc.length < 3) continue;

        lineItems.push({
            description: desc,
            quantity: parseFloat(quantity),
            unitPrice: cleanAmount(unitPrice),
            lineTotal: cleanAmount(lineTotal),
        });
    }

    return lineItems.slice(0, 20); // Cap at 20 items to prevent runaway parsing
}

/**
 * Extracts GSTIN from text. Returns first match (seller) and second match (buyer) if available.
 *
 * @param {string} text
 * @returns {{ sellerGstin: string|null, buyerGstin: string|null }}
 */
function extractGstins(text) {
    const matches = [...text.matchAll(GSTIN_REGEX)].map(m => m[1]);
    return {
        sellerGstin: matches[0] || null,
        buyerGstin: matches[1] || null,
    };
}

/**
 * MAIN PDF PARSING FUNCTION
 *
 * Parses a PDF buffer using pdf2json and extracts an invoice object.
 * Returns a Promise that resolves to the normalised InvoiceObject.
 *
 * @param {Buffer} pdfBuffer
 * @returns {Promise<Object>} Normalised InvoiceObject (same shape as CSV parser)
 */
async function parsePdfInvoice(pdfBuffer) {
    logger.info('[PDF_PARSER] Beginning PDF extraction...');

    return new Promise((resolve, reject) => {
        const pdfParser = new PdfParser(null, 1); // '1' = suppress verbose logging

        pdfParser.on('pdfParser_dataError', (errData) => {
            logger.error(`[PDF_PARSER] ❌ Extraction failed: ${errData.parserError}`);
            reject(new Error(`PDF parsing failed: ${errData.parserError}`));
        });

        pdfParser.on('pdfParser_dataReady', (pdfData) => {
            try {
                const rawText = extractTextFromPdfData(pdfData);
                logger.info(`[PDF_PARSER] Extracted ${rawText.length} characters from ${pdfData.Pages?.length || 0} page(s)`);

                // ── INVOICE ID ──────────────────────────────────────────────
                const invoiceNoMatch = rawText.match(INVOICE_NO_REGEX);
                const invoiceId = invoiceNoMatch
                    ? invoiceNoMatch[1].trim().replace(/\s+/g, '-')
                    : `PDF-INV-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

                // ── DATES ───────────────────────────────────────────────────
                // Find all date-like strings and pick the first two
                const allDates = [];
                for (const pattern of DATE_PATTERNS) {
                    const matches = [...rawText.matchAll(new RegExp(pattern, 'g'))];
                    for (const m of matches) {
                        const normalised = normaliseDate(m[0]);
                        if (normalised && !allDates.includes(normalised)) {
                            allDates.push(normalised);
                        }
                    }
                }

                const invoiceDate = allDates[0] || new Date().toISOString().split('T')[0];
                // Due date: look for "due date" label, else invoice date + 90 days
                let dueDate = allDates[1] || null;
                if (!dueDate) {
                    const dueMs = new Date(invoiceDate).getTime() + (90 * 24 * 60 * 60 * 1000);
                    dueDate = new Date(dueMs).toISOString().split('T')[0];
                }

                // ── CURRENCY ────────────────────────────────────────────────
                const currencyMatch = rawText.match(CURRENCY_REGEX);
                let currency = currencyMatch ? currencyMatch[1].toUpperCase() : null;
                if (!currency && RUPEE_SYMBOL_REGEX.test(rawText)) currency = 'INR';
                if (!currency) currency = 'USD'; // Default for cross-border

                // ── TOTAL AMOUNT ────────────────────────────────────────────
                let totalAmount = 0;
                const grandTotalMatch = rawText.match(GRAND_TOTAL_REGEX);
                if (grandTotalMatch) {
                    totalAmount = cleanAmount(grandTotalMatch[1]);
                } else {
                    const amountMatch = rawText.match(AMOUNT_REGEX);
                    if (amountMatch) totalAmount = cleanAmount(amountMatch[1]);
                }

                // ── GSTIN / PAN ─────────────────────────────────────────────
                const { sellerGstin, buyerGstin } = extractGstins(rawText);
                const gstPan = sellerGstin
                    ? sellerGstin.substring(2, 12)  // PAN is chars 3-12 of GSTIN
                    : null;

                // ── PAYMENT TERMS ────────────────────────────────────────────
                let paymentTermsDays = 90; // Default for Indian exporters
                let rawConditions = '';

                const paymentTermsMatch = rawText.match(PAYMENT_TERMS_REGEX);
                if (paymentTermsMatch) {
                    rawConditions = paymentTermsMatch[1].trim();
                    // Try to extract numeric days from terms
                    const daysMatch = rawConditions.match(/(\d+)\s*days?/i);
                    if (daysMatch) paymentTermsDays = parseInt(daysMatch[1]);
                    const netMatch = rawConditions.match(NET_TERMS_REGEX_LOCAL);
                    if (netMatch) paymentTermsDays = parseInt(netMatch[1]);
                }

                // ── COMPANY NAMES ────────────────────────────────────────────
                // Heuristic: First capitalised block before GSTIN = seller name
                const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
                let sellerName = null;
                let buyerName = null;

                // First non-trivial line is often the company name
                for (const line of lines.slice(0, 10)) {
                    if (line.length > 5 && /^[A-Z]/.test(line) && !/invoice|tax|gst|bill/i.test(line)) {
                        sellerName = line;
                        break;
                    }
                }

                // Buyer name: look for "Bill To", "Ship To", "Buyer" label
                const buyerMatch = rawText.match(/(?:bill\s+to|ship\s+to|buyer|sold\s+to)[:\s]+([^\n]{5,60})/i);
                if (buyerMatch) buyerName = buyerMatch[1].trim();

                // ── ADDRESSES ────────────────────────────────────────────────
                // Split text around "Bill To" / "Ship To" / mid-document for seller vs buyer blocks
                const [sellerBlock, buyerBlock] = splitSellerBuyerBlocks(rawText);

                const sellerAddress = extractAddressBlock(sellerBlock, 'IN');
                const buyerAddress = extractAddressBlock(buyerBlock, 'IN');

                // Populate missing fields with placeholder so validation can flag them
                const ensureAddress = (addr, name) => ({
                    streetName: addr.streetName || `[EXTRACTED_FROM_PDF: ${name || 'Unknown'}]`,
                    buildingNumber: addr.buildingNumber || '1',
                    townName: addr.townName || '[UNKNOWN_TOWN]',
                    countrySubDivision: addr.countrySubDivision || '[UNKNOWN_STATE]',
                    postCode: addr.postCode || '000000',
                    country: addr.country || 'IN',
                });

                // ── LINE ITEMS ───────────────────────────────────────────────
                const lineItems = extractLineItems(rawText);

                // ── FINAL OBJECT ─────────────────────────────────────────────
                const invoiceObj = {
                    invoiceId,
                    invoiceDate,
                    dueDate,
                    totalAmount,
                    currency,
                    seller: {
                        name: sellerName || '[EXTRACTED_FROM_PDF]',
                        gstPan: gstPan ? `GSTIN:${sellerGstin}|PAN:${gstPan}` : null,
                        structuredAddress: ensureAddress(sellerAddress, sellerName),
                    },
                    buyer: {
                        name: buyerName || '[EXTRACTED_FROM_PDF]',
                        gstPan: buyerGstin ? `GSTIN:${buyerGstin}` : null,
                        structuredAddress: ensureAddress(buyerAddress, buyerName),
                    },
                    lineItems,
                    paymentTermsDays,
                    rawConditions,
                    extractedConditions: [], // Will be populated by conditionsEngine
                    sourceType: 'pdf',
                    _pdfMeta: {
                        pages: pdfData.Pages?.length || 0,
                        textLength: rawText.length,
                        extractionConfidence: calculateConfidence({
                            hasInvoiceId: !!invoiceNoMatch,
                            hasAmount: totalAmount > 0,
                            hasGstin: !!sellerGstin,
                            hasAddress: !!(sellerAddress.townName),
                            hasLineItems: lineItems.length > 0,
                        }),
                    },
                };

                logger.info(`[PDF_PARSER] ✅ Extracted invoice ${invoiceId} | ${currency} ${totalAmount} | Confidence: ${invoiceObj._pdfMeta.extractionConfidence}`);
                resolve(invoiceObj);

            } catch (parseErr) {
                logger.error(`[PDF_PARSER] ❌ Post-extraction failure: ${parseErr.message}`);
                reject(parseErr);
            }
        });

        pdfParser.parseBuffer(pdfBuffer);
    });
}

// Local reference to NET_TERMS_REGEX (avoid circular ref)
const NET_TERMS_REGEX_LOCAL = /(?:net[-\s]?)(\d+)(?:\s*days?)?/i;

/**
 * Splits the raw text into seller and buyer address blocks.
 * Uses "Bill To" / "Ship To" as natural separators.
 *
 * @param {string} text
 * @returns {[string, string]} [sellerBlock, buyerBlock]
 */
function splitSellerBuyerBlocks(text) {
    const splitPatterns = [
        /(?:bill\s+to|ship\s+to|consignee|buyer|sold\s+to)/i,
        /(?:invoice\s+to|deliver\s+to|pay(?:ment)?\s+to)/i,
    ];

    for (const pattern of splitPatterns) {
        const idx = text.search(pattern);
        if (idx > 50) { // Must have some seller content before the split
            return [text.substring(0, idx), text.substring(idx)];
        }
    }

    // Fallback: split at document midpoint
    const mid = Math.floor(text.length / 2);
    return [text.substring(0, mid), text.substring(mid)];
}

/**
 * Calculates an extraction confidence score (0-1) based on how many key fields were found.
 * Used for audit/logging — does NOT affect processing.
 *
 * @param {Object} flags
 * @returns {string} 'HIGH' | 'MEDIUM' | 'LOW'
 */
function calculateConfidence(flags) {
    const score = Object.values(flags).filter(Boolean).length;
    const total = Object.values(flags).length;
    const ratio = score / total;

    if (ratio >= 0.8) return 'HIGH';
    if (ratio >= 0.5) return 'MEDIUM';
    return 'LOW';
}

module.exports = {
    parsePdfInvoice,
};
