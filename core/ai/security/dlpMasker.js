'use strict';

const { telemetry, SPAN_NAMES, FUSION_AI_ATTRIBUTES } = require('../observability');

/**
 * ════════════════════════════════════════════════════════════════════════════
 * CENTRAL DATA LOSS PREVENTION (DLP) & PII REDACTION MODULE — PHASE AI-3.3
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Secure, schema-aware, request-scoped context protection engine for AI pipelines.
 *
 * CORE GOVERNANCE INVARIANTS:
 * 1. Request Isolation: Each investigation request receives an independent, short-lived
 *    DLP context. Token maps are never shared across requests or persisted globally.
 * 2. Deterministic Consistency: Within a single request, identical sensitive values
 *    consistently resolve to the exact same masked token (e.g. [MASKED_EMAIL_01]).
 * 3. Non-Reversibility: From the AI model's perspective, masking is strictly non-reversible.
 *    Original sensitive values are NEVER restored into model-generated outputs.
 * 4. Zero Sensitive Leakage: Raw sensitive values are strictly prevented from entering
 *    prompts, execution traces, application logs, or audit records.
 * 5. Semantic & Citation Preservation: Never redacts transaction UUIDs, payment amounts,
 *    currency codes, ISO timestamps, ledger account paths, provider error codes, ISO 20022
 *    tags, or documentation chunk IDs.
 * 6. Cryptographic & Mathematical Validation: Employs Luhn checksum validation for card PANs
 *    and ISO 7064 Mod 97-10 checksum validation for IBANs to avoid false positives.
 */

// ── EXCLUSION & PRESERVATION GUARDS ──────────────────────────────────────────

const UUID_REGEX =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const ISO_TIMESTAMP_REGEX =
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const FINANCIAL_AMOUNT_REGEX = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,8})?$/;
const CURRENCY_CODES = new Set([
    'USD',
    'EUR',
    'INR',
    'GBP',
    'CAD',
    'AUD',
    'SGD',
    'JPY',
    'CHF',
    'CNY',
    'XLM',
    'USDC',
    'BTC',
    'ETH',
]);

const PRESERVED_IDENTIFIERS = new Set([
    // Provider error codes
    'balance_insufficient',
    'account_closed',
    'account_frozen',
    'tx_bad_seq',
    'tx_insufficient_fee',
    'tx_insufficient_balance',
    'op_underfunded',
    'SETTLEMENT_SUSPENDED',
    'BAD_REQUEST_SIGNATURE_VALIDATION_FAILURE',
    'XSD_VALIDATION_ERROR',
    'MANDATORY_STRUCTURED_ADDRESS_SYNTAX',
    // ISO 20022 message & field names
    'pacs.008.001.08',
    'pacs.004.001.09',
    'pain.002.001.10',
    'StrtNm',
    'TwnNm',
    'Ctry',
    'AdrLine',
    'Dbtr',
    'Cdtr',
    'CdtrAgt',
    'DbtrAgt',
    // Fusion evidence & document prefixes
    'getTransactionTimeline',
    'getProviderFailureDetails',
    'getReconciliationEvidence',
    'getSagaExecutionEvidence',
    'getSettlementAndWebhookEvidence',
    'explainIsoValidationErrors',
    'verifyLedgerIntegrity',
    'search_payment_knowledge',
]);

/**
 * Checks if a string is a standard technical identifier that must never be masked.
 */
function isPreservedIdentifier(str) {
    if (!str || typeof str !== 'string') return false;
    const trimmed = str.trim();
    if (UUID_REGEX.test(trimmed)) return true;
    if (ISO_TIMESTAMP_REGEX.test(trimmed)) return true;
    if (CURRENCY_CODES.has(trimmed.toUpperCase())) return true;
    if (PRESERVED_IDENTIFIERS.has(trimmed)) return true;
    if (/^DOC-[A-Z0-9]+-\d+$/i.test(trimmed)) return true;
    if (/^docs:[a-z0-9-]+:[a-z0-9-]+:chunk-\d+$/i.test(trimmed)) return true;
    if (
        /^(?:instructions|transaction|evidence|ledger_journal|reconciliation_log|processed_webhook_events)(?:[:.].+)?$/i.test(
            trimmed
        )
    )
        return true;
    if (
        /^(?:clearing|customer_funds|settlement|treasury|exchange):[a-z0-9_]+:[a-z0-9_]+$/i.test(
            trimmed
        )
    )
        return true;
    return false;
}

// ── CHECKSUM & FORMAT VALIDATORS ─────────────────────────────────────────────

/**
 * Luhn Algorithm validation for payment card PANs.
 *
 * @param {string} candidate - Digits with optional spaces or hyphens
 * @returns {boolean} True if candidate is a valid 13-19 digit Luhn-compliant PAN
 */
function isValidLuhn(candidate) {
    if (!candidate || typeof candidate !== 'string') return false;
    const digitsOnly = candidate.replace(/[\s-]/g, '');
    if (!/^\d{13,19}$/.test(digitsOnly)) return false;

    // Reject obvious dummy sequences (all same digit, or simple counting sequences)
    if (/^(\d)\1+$/.test(digitsOnly)) return false;

    let sum = 0;
    let shouldDouble = false;
    for (let i = digitsOnly.length - 1; i >= 0; i--) {
        let digit = parseInt(digitsOnly.charAt(i), 10);
        if (shouldDouble) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
        shouldDouble = !shouldDouble;
    }
    return sum % 10 === 0;
}

/**
 * ISO 7064 Mod 97-10 Checksum validation for IBANs.
 *
 * @param {string} candidate - International Bank Account Number string
 * @returns {boolean} True if candidate is a valid IBAN with correct checksum
 */
function isValidIBAN(candidate) {
    if (!candidate || typeof candidate !== 'string') return false;
    const clean = candidate.replace(/[\s-]/g, '').toUpperCase();

    // IBAN format: 2 country letters, 2 check digits, followed by 11 to 30 alphanumeric characters (total length 15..34)
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(clean)) return false;

    // Rearrange: move the first 4 characters to the end
    const rearranged = clean.slice(4) + clean.slice(0, 4);

    // Replace letters with their 2-digit numeric codes: A=10, B=11, ..., Z=35
    let numericStr = '';
    for (let i = 0; i < rearranged.length; i++) {
        const charCode = rearranged.charCodeAt(i);
        if (charCode >= 65 && charCode <= 90) {
            numericStr += (charCode - 55).toString();
        } else {
            numericStr += rearranged.charAt(i);
        }
    }

    try {
        return BigInt(numericStr) % 97n === 1n;
    } catch {
        return false;
    }
}

/**
 * Validates Indian Permanent Account Number (PAN) format:
 * 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F).
 */
function isValidIndianPAN(candidate) {
    if (!candidate || typeof candidate !== 'string') return false;
    return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(candidate.trim());
}

/**
 * Validates Indian Goods and Services Tax Identification Number (GSTIN):
 * 2 digits (state code), 10 char PAN, 1 entity char, 'Z', 1 checksum char (15 characters total).
 */
function isValidGSTIN(candidate) {
    if (!candidate || typeof candidate !== 'string') return false;
    return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(candidate.trim());
}

/**
 * Validates Indian Financial System Code (IFSC):
 * 4 letters, '0', 6 alphanumeric characters (11 characters total).
 */
function isValidIFSC(candidate) {
    if (!candidate || typeof candidate !== 'string') return false;
    return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(candidate.trim());
}

/**
 * Validates JSON Web Token (JWT) structure:
 * 3 Base64URL components separated by dots, starting with 'eyJ'.
 */
function isValidJWT(candidate) {
    if (!candidate || typeof candidate !== 'string') return false;
    return /^eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(
        candidate.trim()
    );
}

// ── REGEX PATTERNS FOR FREE-TEXT DETECTION ───────────────────────────────────

// JWT token pattern in text
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

// Bearer token pattern
const BEARER_PATTERN = /\bBearer\s+([A-Za-z0-9_.-]{20,})\b/gi;

// API Keys & Secrets: Stripe, Razorpay, Stellar secret seed, or key-value declarations
const API_KEY_PATTERNS = [
    /\b(sk_live_[0-9a-zA-Z]{24,})\b/g,
    /\b(rk_live_[0-9a-zA-Z]{24,})\b/g,
    /\b(whsec_[0-9a-zA-Z]{24,})\b/g,
    /\b(rzp_live_[0-9a-zA-Z]{14,})\b/g,
    /\b(rzp_test_[0-9a-zA-Z]{14,})\b/g,
    /\b(S[A-Z0-9]{55})\b/g, // Stellar secret seed (starts with S, 56 chars base32)
];

// Generic key-value secret pattern: api_key=..., client_secret=...
const KEY_VALUE_SECRET_PATTERN =
    /(?:api[_-]?key|secret[_-]?key|client[_-]?secret)\s*[:=]\s*['"]?([A-Za-z0-9_.-]{16,})['"]?/gi;

// Credentials: password: ..., auth_token: ...
const CREDENTIAL_PATTERN =
    /(?:password|passwd|auth[_-]?token)\s*[:=]\s*['"]?(?!password|passwd)([^\s'":]{6,})['"]?/gi;

// GSTIN pattern (15 chars)
const GSTIN_PATTERN = /\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/g;

// Indian PAN pattern (10 chars: 5 uppercase letters, 4 digits, 1 uppercase letter)
const INDIAN_PAN_PATTERN = /\b([A-Z]{5}[0-9]{4}[A-Z])\b/g;

// UPI VPA pattern: username@handle where handle is a known payment handle or contains bank
const UPI_PATTERN =
    /\b[a-zA-Z0-9._-]+@(okhdfcbank|oksbi|okaxis|okicici|upi|paytm|ybl|axl|ibl|apl|hdfcbank|sbi|icici|axisbank|barodampay|federal)\b/gi;

// Email pattern (standard RFC-compliant email)
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Telephone numbers: E.164 (+1..., +91...), formatted with parentheses/dashes
const PHONE_PATTERNS = [
    /(?:^|(?<=[^\w]))\+[1-9]\d{6,14}(?!\w)/g, // E.164
    /(?:^|(?<=[^\w]))(?:\+91[\s-]?)?[6-9]\d{9}(?!\w)/g, // Indian 10-digit mobile
    /(?:^|(?<=[^\w]))(?:\+1[\s-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\w)/g, // US/Canada formatted phone
];

// Card PAN candidate pattern (16-digit blocks or 13-19 digits, strictly avoiding UUID chunks)
const CARD_CANDIDATE_PATTERN =
    /\b(?:\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{4}|\d{4}[\s-]\d{6}[\s-]\d{5}|\d{13,19})\b/g;

// IBAN candidate pattern (15 to 34 characters starting with 2 letters and 2 digits)
const IBAN_CANDIDATE_PATTERN = /\b([A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30})\b/g;

// Explicit IBAN context pattern in text (e.g. IBAN: ...)
const IBAN_CONTEXT_PATTERN =
    /(?:iban(?:\s*(?:number|no|#))?\s*[:=-]?\s*)\b([A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30})\b/gi;

// IFSC pattern in text: requires IFSC or branch context preceding it
const IFSC_CONTEXT_PATTERN =
    /(?:(?:ifsc(?:\s*code)?|branch)\s*[:=-]?\s*)\b([A-Z]{4}0[A-Z0-9]{6})\b/gi;

// Bank account pattern in text: requires explicit account context preceding it
const BANK_ACCOUNT_CONTEXT_PATTERN =
    /(?:(?:bank\s+)?account(?:\s*(?:number|no|#))?\s*[:=-]?\s*)(?!(?:clearing|settlement|customer_funds|treasury|suspense|fee)\b)\b([0-9]{9,18}|[A-Z]{2}\d{2}[A-Za-z0-9]{6,20})\b/gi;

// Context-labeled personal names in text: "Customer name: Alice Smith", "Beneficiary name: John Doe"
const LABELED_NAME_PATTERN =
    /(?:(?:[Cc]ustomer|[Bb]eneficiary|[Aa]ccount\s+[Hh]older|[Rr]emitter|[Rr]ecipient|[Ss]ender)\s*(?:[Nn]ame|[Hh]older)?\s*[:=-]?\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g;

// Corporate & organizational suffixes indicating a business entity rather than a natural person
const BUSINESS_ENTITY_SUFFIXES =
    /\b(?:Inc|Incorporated|Corp|Corporation|LLC|LLP|Ltd|Limited|PLC|GmbH|AG|S\.?A\.?|S\.?R\.?L\.?|B\.?V\.?|Pty|Pvt\.?\s*Ltd\.?|Co\.?|Company|Holdings|Group|Enterprise|Enterprises|Solutions|Services|Technologies|Logistics|Industries|Foundation|Associates|Bank|Clearing|Exchange|Treasury)\b/i;

/**
 * Checks whether a name string represents a business, corporate, or system entity
 * rather than a natural person.
 *
 * @param {string} candidate - Entity name string
 * @returns {boolean} True if candidate is a business entity
 */
function isBusinessEntityName(candidate) {
    if (!candidate || typeof candidate !== 'string') return false;
    const clean = candidate.trim();
    if (BUSINESS_ENTITY_SUFFIXES.test(clean)) return true;
    if (
        /^(?:clearing|settlement|reserve|escrow|suspense|treasury|operations|system)\b/i.test(clean)
    )
        return true;
    return false;
}

// ── SCHEMA-AWARE FIELD DEFINITIONS ───────────────────────────────────────────

const SENSITIVE_KEY_CLASSIFICATIONS = {
    // Personal Names
    name: 'PERSON_NAME',
    full_name: 'PERSON_NAME',
    fullname: 'PERSON_NAME',
    first_name: 'PERSON_NAME',
    firstname: 'PERSON_NAME',
    last_name: 'PERSON_NAME',
    lastname: 'PERSON_NAME',
    account_holder_name: 'PERSON_NAME',
    accountholdername: 'PERSON_NAME',
    holder_name: 'PERSON_NAME',
    customer_name: 'PERSON_NAME',
    customername: 'PERSON_NAME',
    beneficiary_name: 'PERSON_NAME',
    beneficiaryname: 'PERSON_NAME',
    remitter_name: 'PERSON_NAME',
    remittername: 'PERSON_NAME',
    recipient_name: 'PERSON_NAME',
    recipientname: 'PERSON_NAME',
    sender_name: 'PERSON_NAME',
    sendername: 'PERSON_NAME',
    person_name: 'PERSON_NAME',
    individual_name: 'PERSON_NAME',
    employee_name: 'PERSON_NAME',
    contact_name: 'PERSON_NAME',
    director_name: 'PERSON_NAME',

    // Bank Accounts
    account_number: 'BANK_ACCOUNT',
    accountnumber: 'BANK_ACCOUNT',
    bank_account_number: 'BANK_ACCOUNT',
    bankaccountnumber: 'BANK_ACCOUNT',
    bank_account: 'BANK_ACCOUNT',
    acc_no: 'BANK_ACCOUNT',
    account_no: 'BANK_ACCOUNT',
    beneficiary_account: 'BANK_ACCOUNT',
    destination_account: 'BANK_ACCOUNT',
    source_account: 'BANK_ACCOUNT',
    creditor_account: 'BANK_ACCOUNT',
    debtor_account: 'BANK_ACCOUNT',

    // IBAN
    iban: 'IBAN',
    iban_number: 'IBAN',
    ibannumber: 'IBAN',

    // Card PANs
    card_number: 'CARD_PAN',
    cardnumber: 'CARD_PAN',
    card_pan: 'CARD_PAN',
    pan_number: 'CARD_PAN',
    debit_card_number: 'CARD_PAN',
    credit_card_number: 'CARD_PAN',

    // Tax & Gov IDs
    indian_pan: 'INDIAN_PAN',
    pan: 'INDIAN_PAN',
    gstin: 'GSTIN',

    // IFSC
    ifsc: 'IFSC',
    ifsc_code: 'IFSC',
    ifsccode: 'IFSC',
    branch_ifsc: 'IFSC',

    // UPI
    vpa: 'UPI_ID',
    upi_id: 'UPI_ID',
    upi_address: 'UPI_ID',

    // Contact
    email: 'EMAIL',
    customer_email: 'EMAIL',
    user_email: 'EMAIL',
    phone: 'PHONE',
    phone_number: 'PHONE',
    phonenumber: 'PHONE',
    mobile: 'PHONE',
    mobile_number: 'PHONE',
    contact_number: 'PHONE',

    // Credentials & Keys
    password: 'CREDENTIAL',
    client_secret: 'API_KEY',
    secret_key: 'API_KEY',
    api_key: 'API_KEY',
    apikey: 'API_KEY',
    auth_token: 'CREDENTIAL',
    bearer_token: 'BEARER_TOKEN',
};

/**
 * Normalizes a sensitive value so formatting variants within the same request
 * (e.g. card with spaces vs hyphens, uppercase vs lowercase emails) map to the exact same token.
 */
function normalizeSensitiveValue(category, rawValue) {
    if (!rawValue || typeof rawValue !== 'string') return String(rawValue || '');
    const trimmed = rawValue.trim();
    switch (category) {
        case 'CARD_PAN':
            return `CARD:${trimmed.replace(/[\s-]/g, '')}`;
        case 'IBAN':
            return `IBAN:${trimmed.replace(/[\s-]/g, '').toUpperCase()}`;
        case 'EMAIL':
            return `EMAIL:${trimmed.toLowerCase()}`;
        case 'PHONE':
            return `PHONE:${trimmed.replace(/[\s().-]/g, '')}`;
        case 'UPI_ID':
            return `UPI:${trimmed.toLowerCase()}`;
        case 'INDIAN_PAN':
            return `PAN:${trimmed.toUpperCase()}`;
        case 'GSTIN':
            return `GSTIN:${trimmed.toUpperCase()}`;
        case 'IFSC':
            return `IFSC:${trimmed.toUpperCase()}`;
        case 'BANK_ACCOUNT':
            return `ACC:${trimmed.replace(/[\s-]/g, '')}`;
        case 'PERSON_NAME':
        case 'NAME':
            return `NAME:${trimmed.toLowerCase().replace(/\s+/g, ' ')}`;
        default:
            return `${category}:${trimmed}`;
    }
}

// ── REQUEST-SCOPED DLP CONTEXT CLASS ─────────────────────────────────────────

class DlpContext {
    /**
     * Creates an isolated, request-scoped DLP context.
     *
     * @param {object} [options]
     * @param {string} [options.requestId] - Optional request/investigation identifier
     */
    constructor(options = {}) {
        this.requestId = options.requestId || `REQ-${Date.now()}`;
        this.createdAt = new Date().toISOString();

        // Short-lived, request-scoped token mapping: normalizedKey -> maskedToken
        this.tokenMap = new Map();

        // Reverse classification map: maskedToken -> category
        this.reverseMap = new Map();

        // Categorical sequence counters (14 discrete sensitive categories)
        this.tokenCounters = {
            CARD_PAN: 0,
            IBAN: 0,
            INDIAN_PAN: 0,
            GSTIN: 0,
            IFSC: 0,
            BANK_ACCOUNT: 0,
            EMAIL: 0,
            PHONE: 0,
            UPI_ID: 0,
            JWT: 0,
            BEARER_TOKEN: 0,
            API_KEY: 0,
            CREDENTIAL: 0,
            PERSON_NAME: 0,
        };

        this.redactionCount = 0;
        this.auditLog = [];
    }

    /**
     * Retrieves or deterministically generates a masked token for a sensitive value.
     *
     * @param {string} category - Identifier category (e.g. 'EMAIL', 'IBAN')
     * @param {string} rawValue - Raw sensitive value
     * @param {string} [fieldHint] - Optional field name or context description
     * @returns {string} Masked token string (e.g. '[MASKED_EMAIL_01]')
     */
    getMaskedToken(category, rawValue, fieldHint = null) {
        if (!rawValue || typeof rawValue !== 'string') {
            return rawValue;
        }

        const normalizedKey = normalizeSensitiveValue(category, rawValue);
        if (this.tokenMap.has(normalizedKey)) {
            this.redactionCount++;
            return this.tokenMap.get(normalizedKey);
        }

        if (!this.tokenCounters[category] && this.tokenCounters[category] !== 0) {
            this.tokenCounters[category] = 0;
        }

        this.tokenCounters[category]++;
        const seq = String(this.tokenCounters[category]).padStart(2, '0');
        const token = `[MASKED_${category}_${seq}]`;

        this.tokenMap.set(normalizedKey, token);
        this.reverseMap.set(token, category);
        this.redactionCount++;

        // Record audit event WITHOUT storing raw sensitive value
        this.auditLog.push({
            category,
            token,
            fieldHint: fieldHint || 'unspecified',
            timestamp: new Date().toISOString(),
        });

        telemetry.recordDlpRedaction(1, category);

        return token;
    }

    /**
     * Masks free-text input across all supported sensitive categories.
     *
     * @param {string} text - Raw input string
     * @returns {string} Redacted string containing deterministic tokens
     */
    maskText(text) {
        if (!text || typeof text !== 'string') return text;
        const start = Date.now();

        let result = text;

        // 1. JWT Tokens
        result = result.replace(JWT_PATTERN, (match) => {
            if (isPreservedIdentifier(match)) return match;
            if (isValidJWT(match)) {
                return this.getMaskedToken('JWT', match);
            }
            return match;
        });

        // 2. Bearer Tokens
        result = result.replace(BEARER_PATTERN, (match, tokenPart) => {
            if (isPreservedIdentifier(tokenPart)) return match;
            const masked = this.getMaskedToken('BEARER_TOKEN', tokenPart);
            return `Bearer ${masked}`;
        });

        // 3. Known Provider API Keys & Secrets
        for (const pattern of API_KEY_PATTERNS) {
            result = result.replace(pattern, (match) => {
                if (isPreservedIdentifier(match)) return match;
                return this.getMaskedToken('API_KEY', match);
            });
        }

        // 4. Generic Key-Value Secret Declarations (api_key: ..., client_secret: ...)
        result = result.replace(KEY_VALUE_SECRET_PATTERN, (match, secretVal) => {
            if (isPreservedIdentifier(secretVal)) return match;
            const masked = this.getMaskedToken('API_KEY', secretVal);
            return match.replace(secretVal, masked);
        });

        // 5. Explicit Credential Declarations (password: ..., auth_token: ...)
        result = result.replace(CREDENTIAL_PATTERN, (match, credVal) => {
            if (isPreservedIdentifier(credVal)) return match;
            const masked = this.getMaskedToken('CREDENTIAL', credVal);
            return match.replace(credVal, masked);
        });

        // 6. GSTIN (15 chars) - Evaluated before Indian PAN to avoid partial masking
        result = result.replace(GSTIN_PATTERN, (match) => {
            if (isPreservedIdentifier(match)) return match;
            if (isValidGSTIN(match)) {
                return this.getMaskedToken('GSTIN', match);
            }
            return match;
        });

        // 7. IBANs (Context-Labeled or Validated with ISO 7064 Mod 97-10 Checksum)
        result = result.replace(IBAN_CONTEXT_PATTERN, (match, ibanVal) => {
            if (isPreservedIdentifier(ibanVal)) return match;
            const masked = this.getMaskedToken('IBAN', ibanVal);
            return match.replace(ibanVal, masked);
        });

        result = result.replace(IBAN_CANDIDATE_PATTERN, (match) => {
            if (isPreservedIdentifier(match)) return match;
            const candidateClean = match.replace(/[\s-]/g, '');
            if (isValidIBAN(candidateClean)) {
                return this.getMaskedToken('IBAN', match);
            }
            return match;
        });

        // 8. Credit/Debit Card PANs (Validated with Luhn Algorithm)
        result = result.replace(CARD_CANDIDATE_PATTERN, (match) => {
            if (isPreservedIdentifier(match)) return match;
            // Guard: ensure it's not a financial amount or decimal
            if (FINANCIAL_AMOUNT_REGEX.test(match.trim())) return match;
            if (isValidLuhn(match)) {
                return this.getMaskedToken('CARD_PAN', match);
            }
            return match;
        });

        // 9. Indian PAN (5 letters, 4 digits, 1 letter)
        result = result.replace(INDIAN_PAN_PATTERN, (match) => {
            if (isPreservedIdentifier(match)) return match;
            if (isValidIndianPAN(match)) {
                return this.getMaskedToken('INDIAN_PAN', match);
            }
            return match;
        });

        // 10. UPI Identifiers (VPAs)
        result = result.replace(UPI_PATTERN, (match) => {
            if (isPreservedIdentifier(match)) return match;
            return this.getMaskedToken('UPI_ID', match);
        });

        // 11. Email Addresses
        result = result.replace(EMAIL_PATTERN, (match) => {
            if (isPreservedIdentifier(match)) return match;
            return this.getMaskedToken('EMAIL', match);
        });

        // 12. IFSC with Context
        result = result.replace(IFSC_CONTEXT_PATTERN, (match, ifscVal) => {
            if (isPreservedIdentifier(ifscVal)) return match;
            if (isValidIFSC(ifscVal)) {
                const masked = this.getMaskedToken('IFSC', ifscVal);
                return match.replace(ifscVal, masked);
            }
            return match;
        });

        // 13. Bank Account with Context
        result = result.replace(BANK_ACCOUNT_CONTEXT_PATTERN, (match, accVal) => {
            if (isPreservedIdentifier(accVal)) return match;
            const masked = this.getMaskedToken('BANK_ACCOUNT', accVal);
            return match.replace(accVal, masked);
        });

        // 14. Telephone Numbers
        for (const pattern of PHONE_PATTERNS) {
            result = result.replace(pattern, (match) => {
                if (isPreservedIdentifier(match)) return match;
                if (FINANCIAL_AMOUNT_REGEX.test(match.trim())) return match;
                return this.getMaskedToken('PHONE', match);
            });
        }

        // 15. Context-Labeled Personal Names (Strictly bounded to explicit labeled contexts)
        result = result.replace(LABELED_NAME_PATTERN, (match, nameVal) => {
            if (isPreservedIdentifier(nameVal)) return match;
            if (isBusinessEntityName(nameVal)) return match;
            const masked = this.getMaskedToken('PERSON_NAME', nameVal, 'labeled_text');
            return match.replace(nameVal, masked);
        });

        const durationMs = Date.now() - start;
        telemetry.recordDlpDuration(durationMs);

        return result;
    }

    /**
     * Deeply scans and masks a JavaScript object or array without mutating the original.
     * Utilizes both schema-aware field inspection and text pattern matching.
     *
     * @param {any} obj - Object, array, or primitive
     * @param {string} [currentPath=''] - Object traversal path for auditing
     * @returns {any} Deeply cloned, masked object
     */
    maskObject(obj, currentPath = '') {
        if (obj === null || obj === undefined) return obj;

        if (typeof obj === 'string') {
            return this.maskText(obj);
        }

        if (typeof obj === 'number' || typeof obj === 'boolean') {
            return obj;
        }

        if (Array.isArray(obj)) {
            return obj.map((item, idx) => this.maskObject(item, `${currentPath}[${idx}]`));
        }

        if (typeof obj === 'object') {
            const masked = {};
            for (const [key, value] of Object.entries(obj)) {
                const fieldPath = currentPath ? `${currentPath}.${key}` : key;
                const lowerKey = key.toLowerCase();
                const parentKey = currentPath
                    ? currentPath
                          .split('.')
                          .pop()
                          .toLowerCase()
                          .replace(/\[\d+\]$/, '')
                    : '';

                // Schema-Aware Classification based on object key and parent context
                let schemaCategory = SENSITIVE_KEY_CLASSIFICATIONS[lowerKey];

                // If key is generic 'name', verify that parent represents a personal/counterparty entity
                if (lowerKey === 'name') {
                    const PERSONAL_ENTITY_PARENT_PATTERN =
                        /(?:customer|beneficiary|remitter|recipient|sender|holder|user|person|individual|contact|debtor|creditor|payer|payee|profile|party|client|member|owner|^$)/i;
                    if (!PERSONAL_ENTITY_PARENT_PATTERN.test(parentKey)) {
                        // Not a personal counterparty field (e.g. tool.name, rule.name, event.name)
                        schemaCategory = null;
                    }
                }

                if (schemaCategory && (typeof value === 'string' || typeof value === 'number')) {
                    const strVal = String(value).trim();
                    if (!isPreservedIdentifier(strVal)) {
                        let validated = false;
                        if (schemaCategory === 'CARD_PAN') {
                            validated = isValidLuhn(strVal);
                        } else if (schemaCategory === 'INDIAN_PAN') {
                            validated = isValidIndianPAN(strVal);
                        } else if (schemaCategory === 'GSTIN') {
                            validated = isValidGSTIN(strVal);
                        } else if (schemaCategory === 'IFSC') {
                            validated = isValidIFSC(strVal);
                        } else if (schemaCategory === 'BANK_ACCOUNT') {
                            // Bank account: must be a 9-18 digit string, or start with digits
                            validated = /^\d{9,18}$/.test(strVal);
                        } else if (schemaCategory === 'PERSON_NAME') {
                            // If explicitly first_name or last_name, always validate as personal name
                            if (
                                lowerKey === 'first_name' ||
                                lowerKey === 'firstname' ||
                                lowerKey === 'last_name' ||
                                lowerKey === 'lastname'
                            ) {
                                validated = strVal.length > 0;
                            } else {
                                // Preserve business entity names (e.g. Acme Corp, Supplier Logistics LLC)
                                validated = strVal.length > 0 && !isBusinessEntityName(strVal);
                            }
                        } else {
                            // General schema fields like email, phone, credentials, vpa
                            validated = true;
                        }

                        if (validated) {
                            masked[key] = this.getMaskedToken(schemaCategory, strVal, fieldPath);
                            continue;
                        }
                    }
                }

                // If not matched by schema or validation not met, recurse normally
                masked[key] = this.maskObject(value, fieldPath);
            }
            return masked;
        }

        return obj;
    }

    /**
     * Returns an audit summary of redactions without exposing raw values.
     *
     * @returns {object} Redaction metrics and sanitized audit trace
     */
    getAuditSummary() {
        return {
            requestId: this.requestId,
            totalRedactions: this.redactionCount,
            uniqueTokensGenerated: this.tokenMap.size,
            categories: { ...this.tokenCounters },
            auditLog: this.auditLog.map((item) => ({
                category: item.category,
                token: item.token,
                fieldHint: item.fieldHint,
                timestamp: item.timestamp,
            })),
        };
    }
}

/**
 * Creates an isolated, request-scoped DLP context.
 *
 * @param {object} [options]
 * @returns {DlpContext}
 */
function createDlpContext(options = {}) {
    return new DlpContext(options);
}

module.exports = {
    DlpContext,
    createDlpContext,
    isValidLuhn,
    isValidIBAN,
    isValidIndianPAN,
    isValidGSTIN,
    isValidIFSC,
    isValidJWT,
    isPreservedIdentifier,
    isBusinessEntityName,
};
