'use strict';

const crypto = require('crypto');
const { toCanonicalDecimal } = require('../../orchestrator/financialDecimal');

/**
 * PURE CANONICAL LEDGER PAYLOAD HASH HELPER
 *
 * Computes canonical SHA-256 payload hash for a ledger entry.
 * Exactly matches core/orchestrator/ledgerUtils.js writeLedger() specification.
 * Supports legacy historical fallbacks documented in scripts/verify_integrity.js.
 *
 * Zero database connections, zero dotenv calls, zero CLI side effects.
 *
 * @param {object} entry - Ledger entry object
 * @param {string|Date} [timestampIso] - Optional ISO timestamp override
 * @returns {{ hash: string, format: 'CANONICAL' | 'LEGACY_FLOAT' | 'LEGACY_SCALE_2' }}
 */
function computePayloadHash(entry, timestampIso) {
    if (!entry) {
        throw new Error('computePayloadHash: entry object is required');
    }

    let ts = timestampIso;
    if (!ts) {
        if (entry.timestamp instanceof Date) {
            ts = entry.timestamp.toISOString();
        } else if (typeof entry.timestamp === 'string') {
            ts = entry.timestamp.endsWith('Z')
                ? entry.timestamp
                : new Date(entry.timestamp.replace(' ', 'T') + 'Z').toISOString();
        } else if (entry.timestamp) {
            ts = new Date(entry.timestamp).toISOString();
        } else {
            ts = new Date().toISOString();
        }
    }

    const amt = toCanonicalDecimal(entry.amount, entry.currency || 2);
    const canonicalPayload = `${entry.prev_hash}${entry.entry_id}${entry.instruction_id}${entry.account_id}${entry.direction}${amt}${entry.currency}${ts}`;
    const canonicalHash = crypto.createHash('sha256').update(canonicalPayload).digest('hex');

    if (entry.hash && entry.hash === canonicalHash) {
        return { hash: canonicalHash, format: 'CANONICAL' };
    }

    // Historical fallback 1: support legacy unscaled parseFloat hash if historical record matches
    if (entry.hash) {
        const legacyAmt = parseFloat(entry.amount);
        const legacyPayload = `${entry.prev_hash}${entry.entry_id}${entry.instruction_id}${entry.account_id}${entry.direction}${legacyAmt}${entry.currency}${ts}`;
        const legacyHash = crypto.createHash('sha256').update(legacyPayload).digest('hex');
        if (legacyHash === entry.hash) {
            return { hash: legacyHash, format: 'LEGACY_FLOAT' };
        }
    }

    // Historical fallback 2: support legacy scale 2 hash (pre-sprint 2.2.4.2.2 records)
    if (entry.hash) {
        try {
            const scale2Amt = toCanonicalDecimal(entry.amount, 2);
            const scale2Payload = `${entry.prev_hash}${entry.entry_id}${entry.instruction_id}${entry.account_id}${entry.direction}${scale2Amt}${entry.currency}${ts}`;
            const scale2Hash = crypto.createHash('sha256').update(scale2Payload).digest('hex');
            if (scale2Hash === entry.hash) {
                return { hash: scale2Hash, format: 'LEGACY_SCALE_2' };
            }
        } catch {
            // Ignore if amount cannot be coerced to scale 2
        }
    }

    return { hash: canonicalHash, format: 'CANONICAL' };
}

module.exports = {
    computePayloadHash,
};
