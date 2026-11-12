'use strict';

const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const { toCanonicalDecimal } = require('../core/orchestrator/financialDecimal');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

/**
 * Computes canonical SHA-256 payload hash for a ledger entry.
 * Uses exact financial decimal string formatting (scale 2, never JS IEEE 754 floats).
 * Exactly matches core/orchestrator/ledgerUtils.js writeLedger() specification.
 */
function computePayloadHash(entry, timestampIso) {
    let ts = timestampIso;
    if (!ts) {
        if (entry.timestamp instanceof Date) {
            ts = entry.timestamp.toISOString();
        } else if (typeof entry.timestamp === 'string') {
            ts = entry.timestamp.endsWith('Z')
                ? entry.timestamp
                : new Date(entry.timestamp.replace(' ', 'T') + 'Z').toISOString();
        } else {
            ts = new Date(entry.timestamp).toISOString();
        }
    }

    const amt = toCanonicalDecimal(entry.amount, entry.currency || 2);
    const canonicalPayload = `${entry.prev_hash}${entry.entry_id}${entry.instruction_id}${entry.account_id}${entry.direction}${amt}${entry.currency}${ts}`;
    const canonicalHash = crypto.createHash('sha256').update(canonicalPayload).digest('hex');

    if (entry.hash && entry.hash === canonicalHash) {
        return canonicalHash;
    }

    // Historical fallback 1: support legacy unscaled parseFloat hash if historical record matches
    if (entry.hash) {
        const legacyAmt = parseFloat(entry.amount);
        const legacyPayload = `${entry.prev_hash}${entry.entry_id}${entry.instruction_id}${entry.account_id}${entry.direction}${legacyAmt}${entry.currency}${ts}`;
        const legacyHash = crypto.createHash('sha256').update(legacyPayload).digest('hex');
        if (legacyHash === entry.hash) {
            return legacyHash;
        }
    }

    // Historical fallback 2: support legacy scale 2 hash (pre-sprint 2.2.4.2.2 records)
    if (entry.hash) {
        try {
            const scale2Amt = toCanonicalDecimal(entry.amount, 2);
            const scale2Payload = `${entry.prev_hash}${entry.entry_id}${entry.instruction_id}${entry.account_id}${entry.direction}${scale2Amt}${entry.currency}${ts}`;
            const scale2Hash = crypto.createHash('sha256').update(scale2Payload).digest('hex');
            if (scale2Hash === entry.hash) {
                return scale2Hash;
            }
        } catch {
            // Ignore if amount cannot be coerced to scale 2
        }
    }

    return canonicalHash;
}

/**
 * Reconstructs the linear cryptographic ledger chain from a DAG by traversing prev_hash.
 * Detects forks, cycles, duplicate hashes, missing predecessors, and disconnected entries.
 */
function reconstructChain(rawRows) {
    if (!rawRows || rawRows.length === 0) {
        return { success: true, chain: [] };
    }

    // 1. Check for duplicate entry IDs
    const seenEntryIds = new Set();
    for (const r of rawRows) {
        if (seenEntryIds.has(r.entry_id)) {
            return {
                success: false,
                error: 'DUPLICATE_ENTRY_ID',
                message: `Duplicate entry_id detected: ${r.entry_id}`,
                entryId: r.entry_id,
            };
        }
        seenEntryIds.add(r.entry_id);
    }

    // 2. Check for duplicate hashes (among rows with non-null hashes)
    const seenHashes = new Set();
    for (const r of rawRows) {
        if (r.hash) {
            if (seenHashes.has(r.hash)) {
                return {
                    success: false,
                    error: 'DUPLICATE_HASH',
                    message: `Duplicate hash detected: ${r.hash}`,
                    entryId: r.entry_id,
                };
            }
            seenHashes.add(r.hash);
        }
    }

    // 3. Index rows by hash and by prev_hash
    const entryByHash = new Map();
    const entriesByPrevHash = new Map();

    for (const r of rawRows) {
        if (r.hash) {
            entryByHash.set(r.hash, r);
        }
        if (r.prev_hash) {
            if (!entriesByPrevHash.has(r.prev_hash)) {
                entriesByPrevHash.set(r.prev_hash, []);
            }
            entriesByPrevHash.get(r.prev_hash).push(r);
        }
    }

    // 4. Graph Cycle Detection across all subgraphs (connected or disconnected)
    const cycleVisited = new Set();
    const inStack = new Set();

    for (const r of rawRows) {
        if (!r.hash || cycleVisited.has(r.entry_id)) continue;
        let curr = r;
        const stack = [];
        while (curr && curr.prev_hash && curr.prev_hash !== 'GENESIS_HASH') {
            if (inStack.has(curr.entry_id)) {
                return {
                    success: false,
                    error: 'CYCLE_DETECTED',
                    message: `Cycle detected in hash chain involving entry ${curr.entry_id}`,
                    entryId: curr.entry_id,
                };
            }
            if (cycleVisited.has(curr.entry_id)) break;
            cycleVisited.add(curr.entry_id);
            inStack.add(curr.entry_id);
            stack.push(curr.entry_id);

            const pred = entryByHash.get(curr.prev_hash);
            curr = pred;
        }
        for (const id of stack) {
            inStack.delete(id);
        }
    }

    // 5. Identify Genesis blocks (prev_hash === 'GENESIS_HASH')
    const genesisEntries = entriesByPrevHash.get('GENESIS_HASH') || [];
    if (genesisEntries.length === 0) {
        return {
            success: false,
            error: 'MISSING_GENESIS',
            message: 'No entry found with prev_hash = GENESIS_HASH',
        };
    }
    if (genesisEntries.length > 1) {
        return {
            success: false,
            error: 'FORK_DETECTED',
            message: `Multiple entries point to GENESIS_HASH: ${genesisEntries.map((e) => e.entry_id).join(', ')}`,
            entries: genesisEntries,
        };
    }

    // 6. Detect forks anywhere in the predecessor mapping
    for (const [prevHash, entries] of entriesByPrevHash.entries()) {
        if (entries.length > 1) {
            return {
                success: false,
                error: 'FORK_DETECTED',
                message: `Fork detected at prev_hash ${prevHash}: ${entries.map((e) => e.entry_id).join(', ')}`,
                prevHash,
                entries,
            };
        }
    }

    // 7. Trace linear chain from Genesis
    const ordered = [];
    const visited = new Set();
    let current = genesisEntries[0];

    while (current) {
        ordered.push(current);
        visited.add(current.entry_id);

        const nextList = entriesByPrevHash.get(current.hash) || [];
        if (nextList.length === 1) {
            const next = nextList[0];
            if (visited.has(next.entry_id)) {
                return {
                    success: false,
                    error: 'CYCLE_DETECTED',
                    message: `Cycle detected in hash chain at entry ${next.entry_id}`,
                    entryId: next.entry_id,
                };
            }
            current = next;
        } else {
            // End of connected chain from genesis
            current = null;
        }
    }

    // 8. Check for Disconnected / Orphaned entries
    const rowsWithHash = rawRows.filter((r) => Boolean(r.hash));
    if (ordered.length < rowsWithHash.length) {
        const disconnected = rowsWithHash.filter((r) => !visited.has(r.entry_id));
        const missingPred = disconnected.find((r) => r.prev_hash && !entryByHash.has(r.prev_hash));

        if (missingPred) {
            return {
                success: false,
                error: 'MISSING_PREDECESSOR',
                message: `Entry ${missingPred.entry_id} references non-existent prev_hash: ${missingPred.prev_hash}`,
                entryId: missingPred.entry_id,
                prevHash: missingPred.prev_hash,
            };
        }

        return {
            success: false,
            error: 'DISCONNECTED_CHAIN',
            message: `${disconnected.length} disconnected entries found that do not trace to genesis.`,
            disconnectedEntries: disconnected.map((d) => d.entry_id),
        };
    }

    return {
        success: true,
        chain: ordered,
    };
}

/**
 * Verifies full ledger integrity:
 * 1. DAG reconstruction from prev_hash.
 * 2. Predecessor hash linkage.
 * 3. SHA-256 payload reproducibility without timezone distortion or float loss.
 * 4. Sequence ID monotonic progression.
 */
async function verifyChain(options = {}) {
    console.log('🔐 Starting Ledger Integrity Verification...');

    let client = options.client;
    let pool = options.pool;
    let ownClient = false;

    if (!client) {
        const dbConfig = options.dbConfig || {
            user: process.env.DB_USER || 'postgres',
            host: process.env.DB_HOST || 'localhost',
            database: process.env.DB_NAME || 'fusion_db',
            password: process.env.DB_PASSWORD,
            port: parseInt(process.env.DB_PORT || '5432'),
        };
        pool = new Pool(dbConfig);
        client = await pool.connect();
        ownClient = true;
    }

    try {
        const res = await client.query(`
            SELECT 
                entry_id, 
                instruction_id, 
                account_id, 
                direction, 
                amount, 
                currency, 
                hash, 
                prev_hash, 
                sequence_id,
                CASE 
                    WHEN pg_typeof(timestamp) = 'timestamp with time zone'::regtype THEN timestamp
                    ELSE (timestamp AT TIME ZONE 'UTC')
                END AS timestamp
            FROM ledger_journal
            ORDER BY sequence_id ASC NULLS LAST
        `);

        const rows = res.rows;
        console.log(`Scanning ${rows.length} ledger entries...`);

        if (rows.length === 0) {
            console.log('ℹ️ Ledger is empty. Zero integrity violations.');
            return { verified: true, verifiedCount: 0, errors: [] };
        }

        // 1. Reconstruct DAG chain
        const reconstruction = reconstructChain(rows);
        if (!reconstruction.success) {
            console.error(
                `❌ LEDGER STRUCTURE DEFECT: [${reconstruction.error}] ${reconstruction.message}`
            );
            return {
                verified: false,
                verifiedCount: 0,
                error: reconstruction.error,
                message: reconstruction.message,
                errors: [reconstruction],
            };
        }

        const chain = reconstruction.chain;
        let verifiedCount = 0;
        const violations = [];

        // 2. Verify Cryptographic Integrity and Continuity
        let lastSequenceId = null;

        for (let i = 0; i < chain.length; i++) {
            const entry = chain[i];

            // Verify Linkage
            if (i === 0) {
                if (entry.prev_hash !== 'GENESIS_HASH') {
                    const msg = `Invalid genesis prev_hash: expected GENESIS_HASH, got ${entry.prev_hash}`;
                    console.error(`❌ BROKEN GENESIS at ${entry.entry_id}: ${msg}`);
                    violations.push({
                        type: 'BROKEN_GENESIS',
                        entryId: entry.entry_id,
                        message: msg,
                    });
                }
            } else {
                const prev = chain[i - 1];
                if (entry.prev_hash !== prev.hash) {
                    const msg = `Chain linkage broken. Expected prev: ${prev.hash}, Actual: ${entry.prev_hash}`;
                    console.error(`❌ BROKEN CHAIN at ${entry.entry_id}: ${msg}`);
                    violations.push({
                        type: 'BROKEN_CHAIN',
                        entryId: entry.entry_id,
                        message: msg,
                    });
                }
            }

            // Verify Hash Integrity (Re-Hash)
            const computedHash = computePayloadHash(entry);
            if (computedHash !== entry.hash) {
                const msg = `Payload tamper detected. Stored: ${entry.hash}, Computed: ${computedHash}`;
                console.error(`❌ TAMPER DETECTED at ${entry.entry_id}: ${msg}`);
                violations.push({
                    type: 'TAMPER_DETECTED',
                    entryId: entry.entry_id,
                    storedHash: entry.hash,
                    computedHash,
                });
            } else {
                verifiedCount++;
            }

            // Verify sequence monotonicity if sequence_id is present
            if (entry.sequence_id !== null && entry.sequence_id !== undefined) {
                const currentSeq = BigInt(entry.sequence_id);
                if (lastSequenceId !== null && currentSeq <= lastSequenceId) {
                    const msg = `Non-monotonic sequence_id detected: current ${currentSeq} <= previous ${lastSequenceId}`;
                    console.error(`❌ SEQUENCE ORDER ANOMALY at ${entry.entry_id}: ${msg}`);
                    violations.push({
                        type: 'NON_MONOTONIC_SEQUENCE',
                        entryId: entry.entry_id,
                        message: msg,
                    });
                }
                lastSequenceId = currentSeq;
            }
        }

        if (violations.length === 0) {
            console.log(`\n✅ INTEGRITY CONFIRMED: ${verifiedCount} blocks verified.`);
            console.log('   No tampering detected. Cryptographic DAG linkage is unbroken.');
            return { verified: true, verifiedCount, errors: [] };
        } else {
            console.error(
                `\n❌ VERIFICATION FAILED: ${violations.length} integrity violations found.`
            );
            return { verified: false, verifiedCount, errors: violations };
        }
    } finally {
        if (ownClient) {
            client.release();
            if (pool) await pool.end();
        }
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const dbArg = args.find((a) => a.startsWith('--db='));
    const targetDb = dbArg ? dbArg.split('=')[1] : undefined;

    const dbConfig = targetDb
        ? {
              user: process.env.DB_USER || 'postgres',
              host: process.env.DB_HOST || 'localhost',
              database: targetDb,
              password: process.env.DB_PASSWORD,
              port: parseInt(process.env.DB_PORT || '5432'),
          }
        : undefined;

    verifyChain({ dbConfig })
        .then((result) => {
            if (!result.verified) {
                process.exit(1);
            }
            process.exit(0);
        })
        .catch((err) => {
            console.error('Fatal Verification Error:', err.message);
            process.exit(1);
        });
}

module.exports = {
    verifyChain,
    reconstructChain,
    computePayloadHash,
    toCanonicalDecimal,
};
