'use strict';

const { Pool } = require('pg');
const path = require('path');
const { reconstructChain, computePayloadHash } = require('./verify_integrity');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

/**
 * WORKSTREAM 4: Safe Historical Ledger Sequence Backfill
 *
 * Reconstructs deterministic ordering strictly via cryptographic DAG links (prev_hash),
 * asserts 100% chain integrity, assigns monotonic sequence IDs starting from 1,
 * and synchronizes PostgreSQL sequence generator.
 *
 * Aborts immediately without modifying data if chain is ambiguous, broken, or tampered.
 */
async function backfillLedgerSequences(options = {}) {
    console.log('[BACKFILL] Initializing safe historical sequence backfill...');

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
        await client.query('BEGIN');

        // 1. Transaction-level advisory lock to prevent concurrent writes
        await client.query('SELECT pg_advisory_xact_lock(998877)');

        // 2. Query all entries with timezone-safe UTC normalization
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
        `);

        const rows = res.rows;
        console.log(`[BACKFILL] Inspecting ${rows.length} rows for chain reconstruction...`);

        if (rows.length === 0) {
            console.log('[BACKFILL] Ledger is empty. No sequences to backfill.');
            await client.query('COMMIT');
            return { success: true, backfilledCount: 0 };
        }

        // 3. Reconstruct DAG chain strictly by following prev_hash from GENESIS_HASH
        const reconstruction = reconstructChain(rows);
        if (!reconstruction.success) {
            const err = new Error(
                `BACKFILL_ABORT: Chain structure defect [${reconstruction.error}]: ${reconstruction.message}`
            );
            err.code = reconstruction.error;
            throw err;
        }

        const chain = reconstruction.chain;

        // 4. Validate cryptographic integrity for every entry in the chain
        for (let i = 0; i < chain.length; i++) {
            const entry = chain[i];
            const expectedPrev = i === 0 ? 'GENESIS_HASH' : chain[i - 1].hash;
            if (entry.prev_hash !== expectedPrev) {
                throw new Error(
                    `BACKFILL_ABORT: Broken linkage at entry ${entry.entry_id}. Expected: ${expectedPrev}, Actual: ${entry.prev_hash}`
                );
            }

            const computedHash = computePayloadHash(entry);
            if (computedHash !== entry.hash) {
                throw new Error(
                    `BACKFILL_ABORT: Payload hash mismatch at entry ${entry.entry_id}. Stored: ${entry.hash}, Computed: ${computedHash}`
                );
            }
        }

        // 5. Update sequence_id deterministically according to reconstructed chain order
        // Temporarily invert sequence_id values to prevent unique constraint collisions during reassignment
        await client.query('UPDATE ledger_journal SET sequence_id = -sequence_id');

        for (let i = 0; i < chain.length; i++) {
            const deterministicSeq = i + 1;
            const entry = chain[i];
            await client.query('UPDATE ledger_journal SET sequence_id = $1 WHERE entry_id = $2', [
                deterministicSeq,
                entry.entry_id,
            ]);
        }

        // 6. Synchronize the PostgreSQL sequence generator with max sequence_id
        const maxSeq = chain.length;
        await client.query("SELECT setval('ledger_journal_sequence_id_seq', $1, true)", [maxSeq]);

        await client.query('COMMIT');
        console.log(
            `[BACKFILL] ✅ Successfully backfilled ${maxSeq} ledger entries in strict hash-chain order. Sequence generator synchronized to ${maxSeq}.`
        );

        return { success: true, backfilledCount: maxSeq };
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[BACKFILL] ❌ Aborted sequence backfill: ${err.message}`);
        throw err;
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

    backfillLedgerSequences({ dbConfig })
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('[BACKFILL FATAL]', err.message);
            process.exit(1);
        });
}

module.exports = { backfillLedgerSequences };
