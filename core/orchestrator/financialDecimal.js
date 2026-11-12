'use strict';

/**
 * EXACT FINANCIAL DECIMAL UTILITY
 *
 * Provides deterministic canonical decimal string representations and exact arithmetic
 * for Project Fusion's cryptographic double-entry ledger without relying on JavaScript
 * IEEE 754 64-bit floating-point numbers (which suffer from precision loss, silent rounding,
 * and Number.MAX_SAFE_INTEGER collapse).
 */

const ASSET_PRECISION = {
    // Verified sandbox / testnet rails
    XLM: 7,
    USD: 2,
    EUR: 2,
    GBP: 2,
    INR: 2,
    CAD: 2,
    SGD: 2,
    AUD: 2,
    NZD: 2,
    CHF: 2,
    CNY: 2,
    HKD: 2,
    SEK: 2,
    NOK: 2,
    DKK: 2,
    PLN: 2,
    MXN: 2,
    BRL: 2,
    ZAR: 2,

    // Zero-decimal currencies (ISO 4217 standard)
    JPY: 0,
    KRW: 0,
    VND: 0,
    CLP: 0,
    PYG: 0,
    UGX: 0,
    BIF: 0,
    DJF: 0,
    GNF: 0,
    RWF: 0,
    VUV: 0,
    XAF: 0,
    XOF: 0,
    XPF: 0,

    // Three-decimal currencies (ISO 4217 standard)
    KWD: 3,
    BHD: 3,
    OMR: 3,
    JOD: 3,
    TND: 3,

    // Policy consistency for simulated digital assets (strictly no execution privileges)
    BTC: 8,
    ETH: 18,
    USDC: 6,
};

const ASSET_MIN_AMOUNT = {
    ETH: '0.000000000000000001',
    BTC: '0.00000001',
    XLM: '0.0000001',
    USDC: '0.000001',
    USD: '0.01',
    EUR: '0.01',
    GBP: '0.01',
    INR: '0.01',
    CAD: '0.01',
    SGD: '0.01',
    CNY: '0.01',
};

/**
 * Resolves the canonical scale (decimal places) for a given currency code or numeric scale.
 *
 * @param {string|number} currencyOrScale - Currency ISO code (e.g. 'USD', 'XLM') or explicit integer scale
 * @returns {number} Decimal places
 */
function getAssetScale(currencyOrScale) {
    if (
        typeof currencyOrScale === 'number' &&
        Number.isInteger(currencyOrScale) &&
        currencyOrScale >= 0
    ) {
        return currencyOrScale;
    }
    if (typeof currencyOrScale === 'string') {
        const key = currencyOrScale.trim().toUpperCase();
        if (Object.prototype.hasOwnProperty.call(ASSET_PRECISION, key)) {
            return ASSET_PRECISION[key];
        }
        if (/^\d+$/.test(currencyOrScale)) {
            return parseInt(currencyOrScale, 10);
        }
    }
    return 2; // Default institutional fiat scale (cents)
}

/**
 * Normalizes any numeric input into a deterministic canonical decimal string.
 * - Never converts values into JavaScript Number/float.
 * - Strips leading zeroes on the integer component.
 * - Enforces asset-specific precision policy based on currencyOrScale.
 * - Allows normalization of trailing zero column padding (e.g. from PostgreSQL NUMERIC(38,7)).
 * - Rejects any input whose significant fractional digits exceed the permitted scale (no silent rounding).
 * - Rejects scientific notation, malformed decimals, null, and empty strings.
 *
 * @param {string|number|bigint} val - The financial value to format
 * @param {string|number} currencyOrScale - Asset currency symbol (e.g. 'XLM', 'USD') or integer scale (default 2)
 * @returns {string} Canonical decimal string representation (e.g., "100.00", "1.0000000")
 */
function toCanonicalDecimal(val, currencyOrScale = 2) {
    if (val === null || val === undefined) {
        throw new TypeError('Financial amount cannot be null or undefined');
    }

    if (typeof val === 'number') {
        if (!Number.isFinite(val)) {
            throw new TypeError(`Invalid financial numeric value: '${val}'`);
        }
        if (val > Number.MAX_SAFE_INTEGER || val < Number.MIN_SAFE_INTEGER) {
            throw new TypeError(
                'Number exceeds MAX_SAFE_INTEGER. Pass large financial amounts as a string to avoid IEEE 754 precision loss.'
            );
        }
    }

    const str = String(val).trim();
    if (!str) {
        throw new TypeError('Financial amount cannot be empty string');
    }

    const match = str.match(/^([+-])?(\d+)(?:\.(\d+))?$/);
    if (!match) {
        throw new TypeError(`Invalid financial numeric value: '${val}'`);
    }

    const isNegative = match[1] === '-';
    let intPart = match[2].replace(/^0+(?=\d)/, ''); // Remove leading zeroes, keeping at least one digit
    let fracPart = match[3] || '';

    const scale = getAssetScale(currencyOrScale);

    if (fracPart.length > scale) {
        // Check if the extra digits beyond scale are all zeroes (e.g. from DB NUMERIC(38,7) padding)
        const extraDigits = fracPart.slice(scale);
        if (!/^0+$/.test(extraDigits)) {
            const assetName =
                typeof currencyOrScale === 'string' ? currencyOrScale : 'specified currency';
            throw new RangeError(
                `Financial amount '${val}' exceeds maximum precision of ${scale} decimal places for ${assetName}`
            );
        }
        // Extra digits are purely trailing zero padding; safe to normalize to asset scale
        fracPart = fracPart.slice(0, scale);
    } else if (fracPart.length < scale) {
        fracPart = fracPart.padEnd(scale, '0');
    }

    if (scale === 0) {
        if (intPart === '0') return '0';
        return `${isNegative ? '-' : ''}${intPart}`;
    }

    // Treat "-0.00" as "0.00"
    if (intPart === '0' && /^0+$/.test(fracPart)) {
        return `0.${fracPart}`;
    }

    return `${isNegative ? '-' : ''}${intPart}.${fracPart}`;
}

/**
 * Exact arbitrary-precision decimal addition using string/BigInt manipulation.
 * Zero floating-point operations. Automatically handles arbitrary-precision inputs
 * with half-up rounding to target scale.
 *
 * @param {string|number|bigint} valA
 * @param {string|number|bigint} valB
 * @param {string|number} currencyOrScale
 * @returns {string} Exact canonical sum
 */
function decimalAdd(valA, valB, currencyOrScale = 2) {
    const a = parseDecimalParts(valA);
    const b = parseDecimalParts(valB);
    const scale = getAssetScale(currencyOrScale);

    const maxScale = Math.max(a.scale, b.scale, scale);
    const padA = a.fracPart.padEnd(maxScale, '0');
    const padB = b.fracPart.padEnd(maxScale, '0');

    const bigA = (a.isNegative ? -1n : 1n) * BigInt(a.intPart + padA);
    const bigB = (b.isNegative ? -1n : 1n) * BigInt(b.intPart + padB);
    let sum = bigA + bigB;

    if (maxScale > scale) {
        const shift = maxScale - scale;
        const divisor = 10n ** BigInt(shift);
        let quotient = sum / divisor;
        const remainder = sum % divisor;
        const absRemainder = remainder < 0n ? -remainder : remainder;
        const half = divisor / 2n;
        if (absRemainder >= half) {
            quotient += sum < 0n ? -1n : 1n;
        }
        sum = quotient;
    } else if (maxScale < scale) {
        sum = sum * 10n ** BigInt(scale - maxScale);
    }

    const isNeg = sum < 0n;
    const absSum = isNeg ? -sum : sum;
    return formatRawBigInt(absSum, scale, isNeg);
}

/**
 * Parses numeric input into exact decimal components without floating-point conversion.
 *
 * @param {string|number|bigint} val
 * @returns {{ isNegative: boolean, intPart: string, fracPart: string, scale: number, rawBigInt: bigint }}
 */
function parseDecimalParts(val) {
    if (val === null || val === undefined) {
        throw new TypeError('Financial amount cannot be null or undefined');
    }

    if (typeof val === 'number') {
        if (!Number.isFinite(val)) {
            throw new TypeError(`Invalid financial numeric value: '${val}'`);
        }
        if (val > Number.MAX_SAFE_INTEGER || val < Number.MIN_SAFE_INTEGER) {
            throw new TypeError(
                'Number exceeds MAX_SAFE_INTEGER. Pass large financial amounts as a string to avoid IEEE 754 precision loss.'
            );
        }
    }

    const str = String(val).trim();
    if (!str) {
        throw new TypeError('Financial amount cannot be empty string');
    }

    const match = str.match(/^([+-])?(\d+)(?:\.(\d+))?$/);
    if (!match) {
        throw new TypeError(`Invalid financial numeric value: '${val}'`);
    }

    const isNegative = match[1] === '-';
    let intPart = match[2].replace(/^0+(?=\d)/, '');
    let fracPart = match[3] || '';

    return {
        isNegative,
        intPart,
        fracPart,
        scale: fracPart.length,
        rawBigInt: BigInt(intPart + fracPart),
    };
}

/**
 * Formats a raw BigInt value into a canonical decimal string at the target scale.
 */
function formatRawBigInt(bigIntVal, scale, isNeg) {
    if (bigIntVal === 0n) {
        return scale > 0 ? '0.' + '0'.repeat(scale) : '0';
    }
    const str = bigIntVal.toString().padStart(scale + 1, '0');
    const intPart = scale > 0 ? str.slice(0, -scale) || '0' : str;
    const fracPart = scale > 0 ? str.slice(-scale) : '';
    const prefix = isNeg && (intPart !== '0' || !/^0+$/.test(fracPart)) ? '-' : '';
    return scale > 0 ? prefix + intPart + '.' + fracPart : prefix + intPart;
}

/**
 * Exact decimal subtraction (valA - valB) using BigInt manipulation.
 * Automatically handles arbitrary-precision inputs with half-up rounding to target scale.
 *
 * @param {string|number|bigint} valA
 * @param {string|number|bigint} valB
 * @param {string|number} currencyOrScale
 * @returns {string} Exact canonical difference
 */
function decimalSubtract(valA, valB, currencyOrScale = 2) {
    const a = parseDecimalParts(valA);
    const b = parseDecimalParts(valB);
    const scale = getAssetScale(currencyOrScale);

    const maxScale = Math.max(a.scale, b.scale, scale);
    const padA = a.fracPart.padEnd(maxScale, '0');
    const padB = b.fracPart.padEnd(maxScale, '0');

    const bigA = (a.isNegative ? -1n : 1n) * BigInt(a.intPart + padA);
    const bigB = (b.isNegative ? -1n : 1n) * BigInt(b.intPart + padB);
    let diff = bigA - bigB;

    if (maxScale > scale) {
        const shift = maxScale - scale;
        const divisor = 10n ** BigInt(shift);
        let quotient = diff / divisor;
        const remainder = diff % divisor;
        const absRemainder = remainder < 0n ? -remainder : remainder;
        const half = divisor / 2n;
        if (absRemainder >= half) {
            quotient += diff < 0n ? -1n : 1n;
        }
        diff = quotient;
    } else if (maxScale < scale) {
        diff = diff * 10n ** BigInt(scale - maxScale);
    }

    const isNeg = diff < 0n;
    const absDiff = isNeg ? -diff : diff;
    return formatRawBigInt(absDiff, scale, isNeg);
}

/**
 * Exact decimal multiplication (valA * valB) with half-up rounding.
 * Zero IEEE 754 floating-point operations.
 *
 * @param {string|number|bigint} valA
 * @param {string|number|bigint} valB
 * @param {string|number} currencyOrScale - Target scale or currency symbol
 * @returns {string} Exact canonical product
 */
function decimalMultiply(valA, valB, currencyOrScale = 2) {
    const a = parseDecimalParts(valA);
    const b = parseDecimalParts(valB);
    const scale = getAssetScale(currencyOrScale);
    const totalScale = a.scale + b.scale;
    const isNeg = a.isNegative !== b.isNegative;
    let prod = a.rawBigInt * b.rawBigInt;

    if (totalScale > scale) {
        const diff = totalScale - scale;
        const divisor = 10n ** BigInt(diff);
        let quotient = prod / divisor;
        const remainder = prod % divisor;
        const half = divisor / 2n;
        if (remainder >= half) {
            quotient += 1n;
        }
        prod = quotient;
    } else if (totalScale < scale) {
        const diff = scale - totalScale;
        prod = prod * 10n ** BigInt(diff);
    }

    return formatRawBigInt(prod, scale, isNeg);
}

/**
 * Exact decimal division (valA / valB) with half-up rounding.
 * Zero IEEE 754 floating-point operations.
 *
 * @param {string|number|bigint} valA
 * @param {string|number|bigint} valB
 * @param {string|number} currencyOrScale - Target scale or currency symbol
 * @returns {string} Exact canonical quotient
 */
function decimalDivide(valA, valB, currencyOrScale = 2) {
    const a = parseDecimalParts(valA);
    const b = parseDecimalParts(valB);
    if (b.rawBigInt === 0n) {
        throw new RangeError('Division by zero in financial calculation');
    }
    const scale = getAssetScale(currencyOrScale);
    const isNeg = a.isNegative !== b.isNegative;

    const powerA = scale + b.scale;
    const powerB = a.scale;
    let numA = a.rawBigInt;
    let numB = b.rawBigInt;
    if (powerA >= powerB) {
        numA = numA * 10n ** BigInt(powerA - powerB);
    } else {
        numB = numB * 10n ** BigInt(powerB - powerA);
    }
    let quotient = numA / numB;
    const remainder = numA % numB;
    if (remainder * 2n >= numB) {
        quotient += 1n;
    }

    return formatRawBigInt(quotient, scale, isNeg);
}

/**
 * Exact decimal comparison (-1: A < B, 0: A === B, 1: A > B).
 *
 * @param {string|number|bigint} valA
 * @param {string|number|bigint} valB
 * @param {string|number} currencyOrScale
 * @returns {number} -1, 0, or 1
 */
function decimalCompare(valA, valB, currencyOrScale = 2) {
    const scale = getAssetScale(currencyOrScale);
    const a = toCanonicalDecimal(valA, scale);
    const b = toCanonicalDecimal(valB, scale);

    const [intA, fracA] = a.split('.');
    const [intB, fracB] = b.split('.');

    const maxScale = Math.max(fracA.length, fracB.length);
    const padA = fracA.padEnd(maxScale, '0');
    const padB = fracB.padEnd(maxScale, '0');

    const bigA = BigInt(intA + padA);
    const bigB = BigInt(intB + padB);

    if (bigA < bigB) return -1;
    if (bigA > bigB) return 1;
    return 0;
}

/**
 * Checks exact decimal equality.
 *
 * @param {string|number|bigint} valA
 * @param {string|number|bigint} valB
 * @param {string|number} currencyOrScale
 * @returns {boolean} True if equal
 */
function decimalEquals(valA, valB, currencyOrScale = 2) {
    return decimalCompare(valA, valB, currencyOrScale) === 0;
}

/**
 * Exact decimal half-up rounding (round-half-away-from-zero) using BigInt.
 * Converts an arbitrary-precision intermediate decimal to the target scale.
 *
 * @param {string|number|bigint} val - Financial value to round
 * @param {string|number} currencyOrScale - Target scale or currency symbol
 * @returns {string} Exact canonical rounded decimal string
 */
function decimalRound(val, currencyOrScale = 2) {
    const scale = getAssetScale(currencyOrScale);
    return decimalMultiply(val, '1', scale);
}

/**
 * Trims insignificant trailing zeros from a canonical decimal string
 * while preserving at least `minScale` decimal places.
 *
 * @param {string} decimalStr - Canonical decimal string
 * @param {string|number} minScale - Minimum scale to retain (default 2)
 * @returns {string} Trimmed decimal string
 */
function trimTrailingZeros(decimalStr, minScale = 2) {
    if (!decimalStr || typeof decimalStr !== 'string' || !decimalStr.includes('.')) {
        return decimalStr;
    }
    const [intPart, fracPart] = decimalStr.split('.');
    let trimmedFrac = fracPart.replace(/0+$/, '');
    const targetMin = typeof minScale === 'number' ? minScale : getAssetScale(minScale);
    if (trimmedFrac.length < targetMin) {
        trimmedFrac = trimmedFrac.padEnd(targetMin, '0');
    }
    return trimmedFrac.length > 0 ? `${intPart}.${trimmedFrac}` : intPart;
}

/**
 * Converts a canonical decimal string into exact integer minor units (as BigInt)
 * without using IEEE 754 floating-point multiplication.
 *
 * @param {string|number|bigint} val - Amount to convert
 * @param {string|number} currencyOrScale - Asset currency code or explicit scale
 * @returns {bigint} Exact integer minor units (e.g. "19.99" USD -> 1999n, "1000" JPY -> 1000n, "10.125" KWD -> 10125n)
 */
function toCanonicalMinorUnits(val, currencyOrScale) {
    const scale = getAssetScale(currencyOrScale);
    const canonical = toCanonicalDecimal(val, scale);
    const isNegative = canonical.startsWith('-');
    const clean = isNegative ? canonical.slice(1) : canonical;
    const parts = clean.split('.');
    const intPart = parts[0];
    const fracPart = parts[1] || '';
    const combined = intPart + fracPart;
    const big = BigInt(combined);
    return isNegative ? -big : big;
}

/**
 * Converts exact integer minor units (BigInt or number or numeric string) back to a canonical decimal string.
 *
 * @param {bigint|number|string} minorUnits - Integer minor units
 * @param {string|number} currencyOrScale - Asset currency code or explicit scale
 * @returns {string} Canonical decimal string representation (e.g. 1999n USD -> "19.99", 1000n JPY -> "1000")
 */
function fromCanonicalMinorUnits(minorUnits, currencyOrScale) {
    if (minorUnits === null || minorUnits === undefined) {
        throw new TypeError('Minor units cannot be null or undefined');
    }
    const scale = getAssetScale(currencyOrScale);
    const str = String(minorUnits).trim();
    const isNegative = str.startsWith('-');
    const clean = isNegative ? str.slice(1) : str;
    if (!/^\d+$/.test(clean)) {
        throw new TypeError(`Invalid integer minor units value: '${minorUnits}'`);
    }
    if (scale === 0) {
        return (isNegative ? '-' : '') + clean;
    }
    const padded = clean.padStart(scale + 1, '0');
    const intPart = padded.slice(0, padded.length - scale);
    const fracPart = padded.slice(padded.length - scale);
    return (isNegative ? '-' : '') + intPart + '.' + fracPart;
}

module.exports = {
    ASSET_PRECISION,
    ASSET_MIN_AMOUNT,
    getAssetScale,
    toCanonicalDecimal,
    toCanonicalMinorUnits,
    fromCanonicalMinorUnits,
    parseDecimalParts,
    decimalAdd,
    decimalSubtract,
    decimalMultiply,
    decimalDivide,
    decimalRound,
    trimTrailingZeros,
    decimalCompare,
    decimalEquals,
};
