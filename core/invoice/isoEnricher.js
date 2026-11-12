'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ISO 20022 ENRICHER — GIFT City IFSC Compliance Module
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Enforces the ISO 20022 Nov 2026 mandatory structured address cutoff.
 * After Nov 2026, all payment messages sent via SWIFT/CCIL IFSC MUST use
 * fully structured addresses — no unstructured "AddressLine" fallback allowed.
 *
 * Regulatory References:
 *  - ISO 20022 CBPR+ Phase 2 structured address mandate (Nov 2026)
 *  - IFSCA Payment Services Regulations 2024 (GIFT City PSR 2024)
 *  - FEMA 1999 §8/§10 for export remittance reporting
 *
 * PURPOSE CODES (RBI/SWIFT):
 *  - IVPT: Invoice Payment
 *  - GDDS: Goods & Services
 *  - TRAD: Trade Finance
 *
 * DOCUMENT TYPES (ISO 20022 RemittanceInformation.Strd):
 *  - CINV: Commercial Invoice
 *  - CREN: Credit Note
 *  - DEBN: Debit Note
 */

const logger = require('../../logger');
const crypto = require('crypto');

// ─── REQUIRED STRUCTURED ADDRESS FIELDS ─────────────────────────────────────
const REQUIRED_ADDRESS_FIELDS = [
    'streetName',
    'townName',
    'countrySubDivision',
    'postCode',
    'country',
];

// Indian state codes for FEMA regulatory reporting
const INDIA_STATE_CODES = {
    'Tamil Nadu': 'TN',
    TN: 'TN',
    Maharashtra: 'MH',
    MH: 'MH',
    Karnataka: 'KA',
    KA: 'KA',
    Gujarat: 'GJ',
    GJ: 'GJ',
    Delhi: 'DL',
    DL: 'DL',
    Telangana: 'TG',
    TG: 'TG',
    'West Bengal': 'WB',
    WB: 'WB',
    Rajasthan: 'RJ',
    RJ: 'RJ',
    'Uttar Pradesh': 'UP',
    UP: 'UP',
    Kerala: 'KL',
    KL: 'KL',
    'Andhra Pradesh': 'AP',
    AP: 'AP',
    Punjab: 'PB',
    PB: 'PB',
    Haryana: 'HR',
    HR: 'HR',
    Bihar: 'BR',
    BR: 'BR',
    'Madhya Pradesh': 'MP',
    MP: 'MP',
};

/**
 * Validates a structured address against ISO 20022 requirements.
 * Returns array of missing/invalid field names. Empty array = valid.
 *
 * @param {Object} address - Address object to validate
 * @param {string} partyLabel - 'seller' or 'buyer' for error messages
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateStructuredAddress(address, partyLabel = 'party') {
    const errors = [];

    if (!address || typeof address !== 'object') {
        return { valid: false, errors: [`${partyLabel}.address is missing or not an object`] };
    }

    for (const field of REQUIRED_ADDRESS_FIELDS) {
        const val = address[field];
        if (!val || typeof val !== 'string' || val.trim() === '') {
            errors.push(
                `${partyLabel}.structuredAddress.${field} is required (ISO 20022 Nov 2026 mandate)`
            );
        }
    }

    // Country must be a valid ISO 3166-1 alpha-2 code (2 uppercase letters)
    if (address.country && !/^[A-Z]{2}$/.test(address.country)) {
        errors.push(
            `${partyLabel}.structuredAddress.country must be ISO 3166-1 alpha-2 (e.g. "IN", "US", "GB"). Got: "${address.country}"`
        );
    }

    // Post code for IN should be 6 digits
    if (address.country === 'IN' && address.postCode && !/^\d{6}$/.test(address.postCode)) {
        errors.push(
            `${partyLabel}.structuredAddress.postCode for India must be 6 digits. Got: "${address.postCode}"`
        );
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Normalises a state string to ISO 3166-2 subdivision code.
 * e.g. "Tamil Nadu" → "TN", "tamilnadu" → "TN"
 *
 * @param {string} state
 * @returns {string}
 */
function normaliseStateCode(state) {
    if (!state) return '';
    const trimmed = state.trim();
    // Already a 2-letter code
    if (/^[A-Z]{2}$/.test(trimmed)) return trimmed;
    // Lookup
    return INDIA_STATE_CODES[trimmed] || trimmed.toUpperCase().substring(0, 2);
}

/**
 * Generates the ISO 20022 RemittanceInformation.Structured block for a CINV
 * (Commercial Invoice) reference. This is mandatory for SWIFT CBPR+ compliance.
 *
 * @param {string} invoiceId - The unique invoice identifier
 * @param {string} [purposeCode='IVPT'] - ISO 20022 purpose code
 * @returns {Object} Structured remittance information block
 */
function buildRemittanceInfo(invoiceId, purposeCode = 'IVPT') {
    return {
        RmtInf: {
            Strd: {
                RfrdDocInf: {
                    Tp: {
                        CdOrPrtry: {
                            Cd: 'CINV', // Commercial Invoice — ISO 20022 document type
                        },
                    },
                    Nb: invoiceId,
                    RltdDt: new Date().toISOString().split('T')[0],
                },
                AddtlRmtInf: `Invoice payment via Project Fusion GIFT City IFSC`,
            },
        },
        PurpCd: purposeCode, // IVPT = Invoice Payment, GDDS = Goods & Services
    };
}

/**
 * Generates the pacs.008 message envelope skeleton for CCIL IFSC/FCSS routing.
 * Based on ISO 20022 pacs.008.001.10 (Financial Institution Credit Transfer).
 *
 * @param {Object} enrichedInvoice - The fully enriched invoice object
 * @returns {Object} pacs.008 message object
 */
function buildPacs008Envelope(enrichedInvoice) {
    const msgId = `FUSN-${enrichedInvoice.invoiceId
        .replace(/[^A-Z0-9]/gi, '')
        .substring(0, 20)
        .toUpperCase()}-${Date.now()}`;
    const creationDateTime = new Date().toISOString();

    return {
        messageId: msgId,
        messageType: 'pacs.008.001.10',
        creationDateTime,
        settlementMethod: 'CLRG',
        clearingSystem: 'FCSS-CCIL-IFSC',
        regulatoryReporting: 'FEMA_SEC_8',
        instructedAmount: {
            value: enrichedInvoice.totalAmount,
            currency: enrichedInvoice.currency,
        },
        debtor: {
            name: enrichedInvoice.buyer.name,
            address: enrichedInvoice.buyer.structuredAddress,
        },
        creditor: {
            name: enrichedInvoice.seller.name,
            address: enrichedInvoice.seller.structuredAddress,
            gstPan: enrichedInvoice.seller.gstPan,
        },
        remittanceInformation: buildRemittanceInfo(
            enrichedInvoice.invoiceId,
            enrichedInvoice.purposeCode || 'IVPT'
        ),
    };
}

/**
 * MAIN ENRICHMENT FUNCTION
 *
 * Takes a normalised InvoiceObject and:
 * 1. Validates all structured addresses — REJECTS if any are unstructured
 * 2. Normalises state codes (Indian states → ISO 3166-2)
 * 3. Adds ISO 20022 RemittanceInformation.Strd block
 * 4. Generates pacs.008 message envelope
 * 5. Adds FEMA IBU reporting flag for inflows > $25,000
 * 6. Adds AML compliance pre-check placeholder
 *
 * @param {Object} invoice - Normalised invoice object from parseInvoice()
 * @returns {{ success: boolean, enriched: Object|null, validationErrors: string[] }}
 */
function enrichToISO(invoice) {
    logger.info(`[ISO_ENRICHER] Enriching invoice ${invoice.invoiceId} to ISO 20022...`);

    const validationErrors = [];

    // ── 1. VALIDATE SELLER ADDRESS ──────────────────────────────────────────
    const sellerCheck = validateStructuredAddress(invoice.seller?.structuredAddress, 'seller');
    if (!sellerCheck.valid) {
        validationErrors.push(...sellerCheck.errors);
    }

    // ── 2. VALIDATE BUYER ADDRESS ───────────────────────────────────────────
    const buyerCheck = validateStructuredAddress(invoice.buyer?.structuredAddress, 'buyer');
    if (!buyerCheck.valid) {
        validationErrors.push(...buyerCheck.errors);
    }

    // HARD STOP: ISO 20022 Nov 2026 mandate — no fallback to unstructured.
    if (validationErrors.length > 0) {
        logger.warn(
            `[ISO_ENRICHER] ⚠️ Validation failed for ${invoice.invoiceId}: ${validationErrors.join('; ')}`
        );
        return { success: false, enriched: null, validationErrors };
    }

    // ── 3. NORMALISE ADDRESS FIELDS ──────────────────────────────────────────
    const normaliseAddress = (addr) => {
        const safeAddr = addr || {};
        return {
            ...safeAddr,
            countrySubDivision: normaliseStateCode(safeAddr.countrySubDivision || 'TN'),
            country: (safeAddr.country || 'IN').toUpperCase(),
            postCode: (safeAddr.postCode || '000000').trim(),
            townName: (safeAddr.townName || 'Unknown').trim(),
            streetName: (safeAddr.streetName || 'Unknown').trim(),
            buildingNumber: (safeAddr.buildingNumber || '').trim() || '1', // Default to '1' if missing
        };
    };

    const enrichedSeller = {
        ...invoice.seller,
        structuredAddress: normaliseAddress(invoice.seller.structuredAddress),
    };

    const enrichedBuyer = {
        ...invoice.buyer,
        structuredAddress: normaliseAddress(invoice.buyer.structuredAddress),
    };

    // ── 4. FEMA REPORTING FLAG ────────────────────────────────────────────────
    // FEMA §10: IBU must report all inflows > $25,000 to RBI via EDPMS
    const requiresFemaIBUReport =
        invoice.totalAmount > 25000 &&
        ['USD', 'EUR', 'GBP', 'SGD', 'AED', 'JPY'].includes(invoice.currency);

    // ── 5. AML PRE-CHECK PLACEHOLDER ──────────────────────────────────────────
    // PRODUCTION: Call ComplyAdvantage / Chainalysis / Dow Jones API here.
    // Flag the result in the enriched object. Processing continues (non-blocking).
    const amlPreCheck = {
        performed: false, // Set to true when real AML API is integrated
        placeholder: true,
        note: '[PROTOTYPE] AML screening placeholder. Integrate ComplyAdvantage or equivalent before production.',
        timestamp: new Date().toISOString(),
    };

    // ── 6. BUILD ENRICHED INVOICE ────────────────────────────────────────────
    const enriched = {
        ...invoice,
        seller: enrichedSeller,
        buyer: enrichedBuyer,
        iso20022: {
            messageType: 'pacs.008.001.10',
            remittanceInfo: buildRemittanceInfo(invoice.invoiceId, invoice.purposeCode || 'IVPT'),
            pacs008Envelope: buildPacs008Envelope({
                ...invoice,
                seller: enrichedSeller,
                buyer: enrichedBuyer,
            }),
            femaReporting: {
                required: requiresFemaIBUReport,
                section: requiresFemaIBUReport ? 'FEMA_SEC_10_IBU' : null,
                threshold: '$25,000',
                reportingEntity: 'IBU_GIFT_CITY',
            },
        },
        amlPreCheck,
        enrichmentHash: crypto
            .createHash('sha256')
            .update(`${invoice.invoiceId}:${invoice.totalAmount}:${invoice.currency}:${Date.now()}`)
            .digest('hex'),
        enrichedAt: new Date().toISOString(),
        isoCompliant: true,
    };

    logger.info(
        `[ISO_ENRICHER] ✅ Invoice ${invoice.invoiceId} enriched. FEMA IBU: ${requiresFemaIBUReport}. Hash: ${enriched.enrichmentHash.slice(0, 16)}...`
    );

    return { success: true, enriched, validationErrors: [] };
}

module.exports = {
    enrichToISO,
    validateStructuredAddress,
    buildRemittanceInfo,
    buildPacs008Envelope,
    normaliseStateCode,
};
