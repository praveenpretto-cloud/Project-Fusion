'use strict';

/**
 * Untrusted Evidence Sanitizer & Boundary Guard
 *
 * Sanitizes external metadata (counterparty labels, invoice notes, beneficiary descriptions,
 * provider messages) before injecting into model prompts.
 * Enforces length bounds and strips control characters without changing financial data.
 */

const MAX_STRING_LENGTH = 500;
const MAX_ERROR_LENGTH = 1000;

/**
 * Sanitizes a single string input.
 *
 * @param {string} str
 * @param {number} [maxLength=500]
 * @returns {string}
 */
function sanitizeString(str, maxLength = MAX_STRING_LENGTH) {
    if (str === null || str === undefined) {
        return null;
    }
    if (typeof str !== 'string') {
        return String(str);
    }

    // Strip ASCII control characters except newline and tab
    // eslint-disable-next-line no-control-regex
    let cleaned = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // Truncate if exceeds bounds
    if (cleaned.length > maxLength) {
        cleaned = `${cleaned.substring(0, maxLength)}... [TRUNCATED_BOUNDED_INPUT]`;
    }

    return cleaned.trim();
}

/**
 * Deeply sanitizes an evidence object or array, ensuring all nested strings are bounded.
 *
 * @param {any} obj
 * @param {number} [depth=0]
 * @returns {any}
 */
function sanitizeEvidenceObject(obj, depth = 0) {
    if (depth > 6 || obj === null || obj === undefined) {
        return obj;
    }

    if (typeof obj === 'string') {
        return sanitizeString(obj);
    }

    if (Array.isArray(obj)) {
        return obj.map((item) => sanitizeEvidenceObject(item, depth + 1));
    }

    if (typeof obj === 'object') {
        const sanitized = {};
        for (const [key, value] of Object.entries(obj)) {
            const cleanKey = sanitizeString(key, 64);
            if (key === 'error_message' || key === 'message') {
                sanitized[cleanKey] =
                    typeof value === 'string' ? sanitizeString(value, MAX_ERROR_LENGTH) : value;
            } else {
                sanitized[cleanKey] = sanitizeEvidenceObject(value, depth + 1);
            }
        }
        return sanitized;
    }

    return obj;
}

module.exports = {
    sanitizeString,
    sanitizeEvidenceObject,
    MAX_STRING_LENGTH,
};
