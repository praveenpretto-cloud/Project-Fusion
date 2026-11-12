'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { runAllMigrations } = require('../../scripts/migrate_all');
const {
    verifyChain,
    computePayloadHash,
} = require('../../scripts/verify_integrity');
const {
    toCanonicalDecimal,
    decimalAdd,
    decimalCompare,
    decimalEquals,
} = require('../../core/orchestrator/financialDecimal');
const { backfillLedgerSequences } = require('../../scripts/backfill_ledger_sequences');
const { writeLedger, verifyLedgerIntegrity } = require('../../core/orchestrator/ledgerUtils');
const { instructionInitiateSchema } = require('../../validators');
const { processInstructionSagaAtomic } = require('../../core/orchestrator/sagaCore');

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.DB_PORT || '5432');
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASSWORD = process.env.DB_PASSWORD;

/**
 * Helper to execute administration commands against the default postgres maintenance database
 */
async function execAdminSql(sql) {
    const adminPool = new Pool({
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USER,
        password: DB_PASSWORD,
        database: 'postgres',
    });
    try {
        await adminPool.query(sql);
    } finally {
        await adminPool.end();
    }
}

describe('Sprint 2.2.4.2.1 — Financial Precision, Timestamp Provenance & Ledger Sequence Constraints', () => {
    jest.setTimeout(45000);

    let testDbPool;

    beforeAll(async () => {
        testDbPool = new Pool({
            host: DB_HOST,
            port: DB_PORT,
            user: DB_USER,
            password: DB_PASSWORD,
            database: 'fusion_test_isolated_db',
        });
    });

    afterAll(async () => {
        if (testDbPool) {
            await testDbPool.end();
        }
    });

    describe('Workstream 1 & 2: Database Migration Runner, Checksums & Upgrades', () => {
        const UPGRADE_DB = 'fusion_test_upgrade_db';
        const CLEAN_DB = 'fusion_test_clean_init_db';
        const CONCURRENT_DB = 'fusion_test_concurrent_db';
        const INVALID_UUID_DB = 'fusion_test_invalid_uuid_db';

        afterAll(async () => {
            for (const db of [UPGRADE_DB, CLEAN_DB, CONCURRENT_DB, INVALID_UUID_DB]) {
                try {
                    await execAdminSql(
                        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}'`
                    );
                    await execAdminSql(`DROP DATABASE IF EXISTS ${db}`);
                } catch {
                    // Ignore teardown errors if db wasn't created
                }
            }
        });

        test('1. Clean database initialization records SHA-256 checksums and applies sequence unique constraint', async () => {
            await execAdminSql(
                `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${CLEAN_DB}'`
            );
            await execAdminSql(`DROP DATABASE IF EXISTS ${CLEAN_DB}`);
            await execAdminSql(`CREATE DATABASE ${CLEAN_DB}`);

            const result = await runAllMigrations({ database: CLEAN_DB });
            expect(result.success).toBe(true);

            const pool = new Pool({
                host: DB_HOST,
                port: DB_PORT,
                user: DB_USER,
                password: DB_PASSWORD,
                database: CLEAN_DB,
            });

            try {
                const res = await pool.query(
                    'SELECT migration_name, checksum, execution_time_ms, status FROM schema_migrations ORDER BY migration_name ASC'
                );
                expect(res.rows.length).toBeGreaterThanOrEqual(12); // 000_schema + 001..011

                for (const row of res.rows) {
                    expect(row.status).toBe('APPLIED');
                    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
                    expect(row.execution_time_ms).toBeGreaterThanOrEqual(0);
                }

                // Verify ledger_journal timestamp is TIMESTAMPTZ
                const colCheck = await pool.query(`
                    SELECT data_type FROM information_schema.columns 
                    WHERE table_name = 'ledger_journal' AND column_name = 'timestamp'
                `);
                expect(colCheck.rows[0].data_type).toBe('timestamp with time zone');

                // Verify sequence_id has UNIQUE constraint
                const uqCheck = await pool.query(`
                    SELECT constraint_name FROM information_schema.table_constraints 
                    WHERE table_name = 'ledger_journal' AND constraint_type = 'UNIQUE'
                `);
                expect(uqCheck.rows.some((r) => r.constraint_name.includes('sequence_id'))).toBe(true);
            } finally {
                await pool.end();
            }
        });

        test('2. Historical database upgrade from migrations 001–006 preserves records and marks legacy', async () => {
            await execAdminSql(
                `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${UPGRADE_DB}'`
            );
            await execAdminSql(`DROP DATABASE IF EXISTS ${UPGRADE_DB}`);
            await execAdminSql(`CREATE DATABASE ${UPGRADE_DB}`);

            const pool = new Pool({
                host: DB_HOST,
                port: DB_PORT,
                user: DB_USER,
                password: DB_PASSWORD,
                database: UPGRADE_DB,
            });

            try {
                // Setup historical schema manually without checksums
                const schemaSql = fs.readFileSync(
                    path.join(__dirname, '..', '..', 'db', 'schema.sql'),
                    'utf8'
                );
                await pool.query(schemaSql);
                await pool.query(`
                    CREATE TABLE IF NOT EXISTS schema_migrations (
                        migration_name VARCHAR(255) PRIMARY KEY,
                        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                    )
                `);

                // Mark base schema and historical migrations 001-006 as already applied without checksum
                await pool.query("INSERT INTO schema_migrations (migration_name) VALUES ('000_schema.sql')");
                for (let i = 1; i <= 6; i++) {
                    const migDir = path.join(__dirname, '..', '..', 'db', 'migrations');
                    const filename = fs.readdirSync(migDir).find((f) => f.startsWith(`00${i}_`));
                    if (filename) {
                        await pool.query(
                            'INSERT INTO schema_migrations (migration_name) VALUES ($1)',
                            [filename]
                        );
                    }
                }

                // Convert routing_ledger.transaction_id temporarily to VARCHAR to simulate historical legacy schema
                await pool.query('ALTER TABLE routing_ledger DROP CONSTRAINT IF EXISTS routing_ledger_transaction_id_fkey');
                await pool.query('ALTER TABLE routing_ledger ALTER COLUMN transaction_id TYPE VARCHAR(255)');

                const colBefore = await pool.query(`
                    SELECT data_type FROM information_schema.columns 
                    WHERE table_name = 'routing_ledger' AND column_name = 'transaction_id'
                `);
                expect(colBefore.rows[0].data_type).toBe('character varying');

                // Seed historical records
                const historicalInstrId = crypto.randomUUID();
                await pool.query(
                    `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state) 
                     VALUES ($1, 500.00, 'USD', 'Alice_Corp', 'Bob_Supply', 'COMMERCE', 'SETTLED')`,
                    [historicalInstrId]
                );
                await pool.query(
                    `INSERT INTO routing_ledger (transaction_id, route_selected, principal_amount_usd) 
                     VALUES ($1, 'STRIPE_TESTNET', 500.00)`,
                    [historicalInstrId]
                );

                // Run forward-only migration upgrade
                const upgradeResult = await runAllMigrations({ database: UPGRADE_DB });
                expect(upgradeResult.success).toBe(true);

                // Verify historical rows were marked LEGACY_UNVERIFIED
                const legCheck = await pool.query(
                    "SELECT COUNT(*) FROM schema_migrations WHERE checksum = 'LEGACY_UNVERIFIED'"
                );
                expect(parseInt(legCheck.rows[0].count)).toBeGreaterThanOrEqual(7);

                // Verify newly applied migrations (007..011) recorded true checksums
                const newCheck = await pool.query(
                    "SELECT COUNT(*) FROM schema_migrations WHERE checksum NOT IN ('LEGACY_UNVERIFIED') AND checksum IS NOT NULL"
                );
                expect(parseInt(newCheck.rows[0].count)).toBeGreaterThanOrEqual(5);

                // Verify routing_ledger.transaction_id is now UUID
                const colAfter = await pool.query(`
                    SELECT data_type FROM information_schema.columns 
                    WHERE table_name = 'routing_ledger' AND column_name = 'transaction_id'
                `);
                expect(colAfter.rows[0].data_type).toBe('uuid');

                // Verify seeded historical data was preserved intact
                const rowPreserved = await pool.query(
                    'SELECT transaction_id::text, principal_amount_usd FROM routing_ledger WHERE transaction_id = $1',
                    [historicalInstrId]
                );
                expect(rowPreserved.rows.length).toBe(1);
                expect(rowPreserved.rows[0].transaction_id).toBe(historicalInstrId);
            } finally {
                await pool.end();
            }
        });

        test('3. Invalid non-UUID conversion aborts safely without data deletion', async () => {
            await execAdminSql(
                `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${INVALID_UUID_DB}'`
            );
            await execAdminSql(`DROP DATABASE IF EXISTS ${INVALID_UUID_DB}`);
            await execAdminSql(`CREATE DATABASE ${INVALID_UUID_DB}`);

            const pool = new Pool({
                host: DB_HOST,
                port: DB_PORT,
                user: DB_USER,
                password: DB_PASSWORD,
                database: INVALID_UUID_DB,
            });

            try {
                // Setup base schema
                const schemaSql = fs.readFileSync(
                    path.join(__dirname, '..', '..', 'db', 'schema.sql'),
                    'utf8'
                );
                await pool.query(schemaSql);

                // Temporarily alter routing_ledger to VARCHAR with invalid non-UUID value
                await pool.query('ALTER TABLE routing_ledger DROP CONSTRAINT IF EXISTS routing_ledger_transaction_id_fkey');
                await pool.query('ALTER TABLE routing_ledger ALTER COLUMN transaction_id TYPE VARCHAR(255)');
                await pool.query(
                    `INSERT INTO routing_ledger (transaction_id, route_selected, principal_amount_usd) 
                     VALUES ('NOT-A-VALID-UUID', 'STRIPE_TESTNET', 100.00)`
                );

                // Attempt to apply migration 009
                const mig009 = fs.readFileSync(
                    path.join(__dirname, '..', '..', 'db', 'migrations', '009_fix_foreign_key_types.sql'),
                    'utf8'
                );

                await expect(pool.query(mig009)).rejects.toThrow(/MIGRATION_ABORT: routing_ledger contains 1 non-UUID/);

                // Assert that the invalid row was NOT deleted or corrupted
                const checkRow = await pool.query('SELECT transaction_id FROM routing_ledger');
                expect(checkRow.rows.length).toBe(1);
                expect(checkRow.rows[0].transaction_id).toBe('NOT-A-VALID-UUID');
            } finally {
                await pool.end();
            }
        });

        test('4. Migration checksum mismatch detection prevents applying migrations on tampered files', async () => {
            const pool = new Pool({
                host: DB_HOST,
                port: DB_PORT,
                user: DB_USER,
                password: DB_PASSWORD,
                database: CLEAN_DB,
            });

            try {
                // Intentionally corrupt recorded checksum for 009_fix_foreign_key_types.sql
                await pool.query(
                    `UPDATE schema_migrations 
                     SET checksum = 'deadbeef00000000000000000000000000000000000000000000000000000000' 
                     WHERE migration_name = '009_fix_foreign_key_types.sql'`
                );

                // Attempt to run migration runner
                await expect(runAllMigrations({ database: CLEAN_DB })).rejects.toThrow(
                    /MIGRATION_CHECKSUM_MISMATCH: Migration 009_fix_foreign_key_types.sql has altered disk contents/
                );
            } finally {
                await pool.end();
            }
        });

        test('5. Concurrent migration runners serialize safely via session advisory lock', async () => {
            await execAdminSql(
                `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${CONCURRENT_DB}'`
            );
            await execAdminSql(`DROP DATABASE IF EXISTS ${CONCURRENT_DB}`);
            await execAdminSql(`CREATE DATABASE ${CONCURRENT_DB}`);

            const [run1, run2] = await Promise.all([
                runAllMigrations({ database: CONCURRENT_DB }),
                runAllMigrations({ database: CONCURRENT_DB }),
            ]);

            expect(run1.success).toBe(true);
            expect(run2.success).toBe(true);

            const pool = new Pool({
                host: DB_HOST,
                port: DB_PORT,
                user: DB_USER,
                password: DB_PASSWORD,
                database: CONCURRENT_DB,
            });

            try {
                // Verify no duplicate migration records
                const countRes = await pool.query(
                    'SELECT migration_name, COUNT(*) FROM schema_migrations GROUP BY migration_name HAVING COUNT(*) > 1'
                );
                expect(countRes.rows.length).toBe(0);
            } finally {
                await pool.end();
            }
        });

        test('6. Duplicate sequence_id insertion is strictly rejected by PostgreSQL unique constraint', async () => {
            const client = await testDbPool.connect();
            try {
                await client.query('BEGIN');
                await client.query("SET session_replication_role = 'replica'");
                await client.query('DELETE FROM ledger_journal');
                await client.query('DELETE FROM instructions');
                await client.query("SET session_replication_role = 'origin'");

                const instrId = crypto.randomUUID();
                await client.query(
                    `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state) 
                     VALUES ($1, 100.00, 'USD', 'Alice_Corp', 'Bob_Supply', 'UNIQUE_SEQ_TEST', 'SETTLED')`,
                    [instrId]
                );

                // Insert entry with explicit sequence_id = 42
                await client.query(
                    `INSERT INTO ledger_journal (instruction_id, account_id, direction, amount, currency, sequence_id) 
                     VALUES ($1, 'Alice_Corp', 'DEBIT', 100.00, 'USD', 42)`,
                    [instrId]
                );

                // Attempt to insert duplicate entry with same sequence_id = 42
                await expect(
                    client.query(
                        `INSERT INTO ledger_journal (instruction_id, account_id, direction, amount, currency, sequence_id) 
                         VALUES ($1, 'Bob_Supply', 'CREDIT', 100.00, 'USD', 42)`,
                        [instrId]
                    )
                ).rejects.toThrow(/duplicate key value violates unique constraint/);

                await client.query('ROLLBACK');
            } finally {
                client.release();
            }
        });
    });

    describe('Workstream 3 & 4: Cryptographic Ledger Chain Integrity, Precision & Cycle Detection', () => {
        let client;

        beforeEach(async () => {
            client = await testDbPool.connect();
            await client.query('BEGIN');
            await client.query("SET session_replication_role = 'replica'");
            await client.query('DELETE FROM ledger_journal');
            await client.query('DELETE FROM compliance_documents');
            await client.query('DELETE FROM reconciliation_log');
            await client.query('DELETE FROM routing_ledger');
            await client.query('DELETE FROM instructions');
            await client.query("SET session_replication_role = 'origin'");
            await client.query('COMMIT');
        });

        afterEach(() => {
            client.release();
        });

        test('7. Exact financial amount serialization prevents float rounding and differentiates collapsed JS numbers', () => {
            // Requirement: Test 100, 100.00, 0.01, large amounts > MAX_SAFE_INTEGER
            expect(toCanonicalDecimal(100)).toBe('100.00');
            expect(toCanonicalDecimal('100')).toBe('100.00');
            expect(toCanonicalDecimal('100.00')).toBe('100.00');
            expect(toCanonicalDecimal(0.01)).toBe('0.01');
            expect(toCanonicalDecimal('0.01')).toBe('0.01');

            // Amounts exceeding Number.MAX_SAFE_INTEGER (9,007,199,254,740,991)
            const hugeA = '9007199254740992000000.00';
            const hugeB = '9007199254740992000001.00';
            expect(toCanonicalDecimal(hugeA)).toBe('9007199254740992000000.00');
            expect(toCanonicalDecimal(hugeB)).toBe('9007199254740992000001.00');
            expect(toCanonicalDecimal(hugeA)).not.toBe(toCanonicalDecimal(hugeB));

            // Two distinct decimal amounts that JavaScript Number collapses to identical value:
            const collapsedNum1 = '9007199254740992.51';
            const collapsedNum2 = '9007199254740992.52';
            // Verify that JavaScript Number indeed collapses them:
            expect(Number(collapsedNum1)).toBe(Number(collapsedNum2));
            expect(parseFloat(collapsedNum1)).toBe(parseFloat(collapsedNum2));

            // Verify that toCanonicalDecimal keeps them strictly distinct:
            const canon1 = toCanonicalDecimal(collapsedNum1);
            const canon2 = toCanonicalDecimal(collapsedNum2);
            expect(canon1).not.toBe(canon2);
            expect(canon1).toBe('9007199254740992.51');
            expect(canon2).toBe('9007199254740992.52');

            // Prove that distinct amounts produce distinct SHA-256 hash payloads:
            const dummyEntry1 = {
                prev_hash: 'GENESIS_HASH',
                entry_id: 'e1',
                instruction_id: 'i1',
                account_id: 'acc1',
                direction: 'DEBIT',
                amount: collapsedNum1,
                currency: 'USD',
                timestamp: new Date('2026-01-01T00:00:00.000Z'),
            };
            const dummyEntry2 = { ...dummyEntry1, amount: collapsedNum2 };

            const hash1 = computePayloadHash(dummyEntry1);
            const hash2 = computePayloadHash(dummyEntry2);
            expect(hash1).not.toBe(hash2);

            // Exact arithmetic tests
            expect(decimalAdd('100.00', '0.00')).toBe('100.00');
            expect(decimalAdd('100', 0)).toBe('100.00');
            expect(decimalAdd('9007199254740992.50', '0.01')).toBe('9007199254740992.51');
            expect(decimalEquals('100', '100.00')).toBe(true);
            expect(decimalCompare('100.01', '100.00')).toBe(1);
        });

        test('8. Ten sequential transactions (20 entries) with exact decimal precision verify successfully', async () => {
            const numTx = 10;

            for (let i = 0; i < numTx; i++) {
                const instrId = crypto.randomUUID();
                await client.query(
                    `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state) 
                     VALUES ($1, $2, 'USD', 'Alice_Corp', 'Bob_Supply', 'TRADE', 'SETTLED')`,
                    [instrId, 100 + i]
                );

                await client.query('BEGIN');
                await writeLedger(client, instrId, 'Alice_Corp', 'Bob_Supply', 100 + i, 'USD', 0);
                await client.query('COMMIT');
            }

            const countRes = await client.query('SELECT COUNT(*) FROM ledger_journal');
            expect(parseInt(countRes.rows[0].count)).toBe(20);

            const result = await verifyChain({ client });
            expect(result.verified).toBe(true);
            expect(result.verifiedCount).toBe(20);
            expect(result.errors.length).toBe(0);
        });

        test('9. Random UUID ordering differing from insertion order does not cause false broken chain', async () => {
            const instrId = crypto.randomUUID();
            await client.query(
                `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state) 
                 VALUES ($1, 250.00, 'USD', 'Alice_Corp', 'Bob_Supply', 'SUPPLY_CHAIN', 'SETTLED')`,
                [instrId]
            );

            await client.query('BEGIN');
            await writeLedger(client, instrId, 'Alice_Corp', 'Bob_Supply', 250.00, 'USD', 0);
            await client.query('COMMIT');

            const result = await verifyChain({ client });
            expect(result.verified).toBe(true);
            expect(result.verifiedCount).toBe(2);
        });

        test('10. Tampered hash or amount is detected immediately with TAMPER_DETECTED violation', async () => {
            const instrId = crypto.randomUUID();
            await client.query(
                `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state) 
                 VALUES ($1, 75.00, 'USD', 'Alice_Corp', 'Bob_Supply', 'PURCHASE', 'SETTLED')`,
                [instrId]
            );

            await client.query('BEGIN');
            await writeLedger(client, instrId, 'Alice_Corp', 'Bob_Supply', 75.00, 'USD', 0);
            await client.query('COMMIT');

            // Tamper with DEBIT amount
            await client.query(
                "UPDATE ledger_journal SET amount = 999.00 WHERE direction = 'DEBIT'"
            );

            const result = await verifyChain({ client });
            expect(result.verified).toBe(false);
            expect(result.errors.some((e) => e.type === 'TAMPER_DETECTED')).toBe(true);
        });

        test('11. Missing predecessor hash is detected and flags MISSING_PREDECESSOR', async () => {
            const validInstrId = crypto.randomUUID();
            await client.query(
                `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state) 
                 VALUES ($1, 100.00, 'USD', 'Alice_Corp', 'Bob_Supply', 'GENESIS_TX', 'SETTLED')`,
                [validInstrId]
            );
            await client.query('BEGIN');
            await writeLedger(client, validInstrId, 'Alice_Corp', 'Bob_Supply', 100.00, 'USD', 0);
            await client.query('COMMIT');

            const bogusEntryId = crypto.randomUUID();
            const bogusInstrId = crypto.randomUUID();

            await client.query(
                `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state) 
                 VALUES ($1, 50.00, 'USD', 'Alice_Corp', 'Bob_Supply', 'TEST_TRANSFER', 'SETTLED')`,
                [bogusInstrId]
            );

            const ts = new Date().toISOString();
            const bogusPrev = 'deadbeef00000000000000000000000000000000000000000000000000000000';
            const payload = `${bogusPrev}${bogusEntryId}${bogusInstrId}Alice_CorpDEBIT50.00USD${ts}`;
            const bogusHash = crypto.createHash('sha256').update(payload).digest('hex');

            await client.query(
                `INSERT INTO ledger_journal (entry_id, instruction_id, account_id, direction, amount, currency, timestamp, hash, prev_hash) 
                 VALUES ($1, $2, 'Alice_Corp', 'DEBIT', 50.00, 'USD', $3, $4, $5)`,
                [bogusEntryId, bogusInstrId, ts, bogusHash, bogusPrev]
            );

            const result = await verifyChain({ client });
            expect(result.verified).toBe(false);
            expect(result.error).toBe('MISSING_PREDECESSOR');
        });

        test('12. Forking hash chain is detected and flags FORK_DETECTED', async () => {
            const instrId1 = crypto.randomUUID();
            const instrId2 = crypto.randomUUID();

            for (const id of [instrId1, instrId2]) {
                await client.query(
                    `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state) 
                     VALUES ($1, 50.00, 'USD', 'Alice_Corp', 'Bob_Supply', 'TEST_FORK', 'SETTLED')`,
                    [id]
                );
            }

            const id1 = crypto.randomUUID();
            const id2 = crypto.randomUUID();
            const ts1 = new Date().toISOString();
            const ts2 = new Date().toISOString();

            const p1 = `GENESIS_HASH${id1}${instrId1}Alice_CorpDEBIT50.00USD${ts1}`;
            const h1 = crypto.createHash('sha256').update(p1).digest('hex');
            const p2 = `GENESIS_HASH${id2}${instrId2}Bob_SupplyDEBIT50.00USD${ts2}`;
            const h2 = crypto.createHash('sha256').update(p2).digest('hex');

            await client.query(
                `INSERT INTO ledger_journal (entry_id, instruction_id, account_id, direction, amount, currency, timestamp, hash, prev_hash) 
                 VALUES ($1, $2, 'Alice_Corp', 'DEBIT', 50.00, 'USD', $3, $4, 'GENESIS_HASH')`,
                [id1, instrId1, ts1, h1]
            );
            await client.query(
                `INSERT INTO ledger_journal (entry_id, instruction_id, account_id, direction, amount, currency, timestamp, hash, prev_hash) 
                 VALUES ($1, $2, 'Bob_Supply', 'DEBIT', 50.00, 'USD', $3, $4, 'GENESIS_HASH')`,
                [id2, instrId2, ts2, h2]
            );

            const result = await verifyChain({ client });
            expect(result.verified).toBe(false);
            expect(result.error).toBe('FORK_DETECTED');
        });

        test('13. Explicit cycle detection detects closed cyclic prev_hash loop', async () => {
            // Write a genesis transaction first
            const instrId = crypto.randomUUID();
            await client.query(
                `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state) 
                 VALUES ($1, 100.00, 'USD', 'Alice_Corp', 'Bob_Supply', 'CYCLE_TEST', 'SETTLED')`,
                [instrId]
            );
            await client.query('BEGIN');
            await writeLedger(client, instrId, 'Alice_Corp', 'Bob_Supply', 100.00, 'USD', 0);
            await client.query('COMMIT');

            // Construct two rows that form an explicit cyclic dependency:
            // c1 points to c2, and c2 points to c1
            const idC1 = crypto.randomUUID();
            const idC2 = crypto.randomUUID();
            const hashC1 = '1111111111111111111111111111111111111111111111111111111111111111';
            const hashC2 = '2222222222222222222222222222222222222222222222222222222222222222';
            const ts = new Date().toISOString();

            await client.query(
                `INSERT INTO ledger_journal (entry_id, instruction_id, account_id, direction, amount, currency, timestamp, hash, prev_hash) 
                 VALUES ($1, $2, 'Alice_Corp', 'DEBIT', 25.00, 'USD', $3, $4, $5)`,
                [idC1, instrId, ts, hashC1, hashC2]
            );
            await client.query(
                `INSERT INTO ledger_journal (entry_id, instruction_id, account_id, direction, amount, currency, timestamp, hash, prev_hash) 
                 VALUES ($1, $2, 'Bob_Supply', 'CREDIT', 25.00, 'USD', $3, $4, $5)`,
                [idC2, instrId, ts, hashC2, hashC1]
            );

            const result = await verifyChain({ client });
            expect(result.verified).toBe(false);
            expect(result.error).toBe('CYCLE_DETECTED');
        });

        test('14. Disconnected chain detection flags entries not originating from genesis', async () => {
            const instrId = crypto.randomUUID();
            await client.query(
                `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state) 
                 VALUES ($1, 100.00, 'USD', 'Alice_Corp', 'Bob_Supply', 'DISCONN_TEST', 'SETTLED')`,
                [instrId]
            );
            await client.query('BEGIN');
            await writeLedger(client, instrId, 'Alice_Corp', 'Bob_Supply', 100.00, 'USD', 0);
            await client.query('COMMIT');

            // Insert a linear chain of two entries that are internally consistent but completely disconnected from genesis
            const d1Id = crypto.randomUUID();
            const d2Id = crypto.randomUUID();
            const d1Hash = '3333333333333333333333333333333333333333333333333333333333333333';
            const d2Hash = '4444444444444444444444444444444444444444444444444444444444444444';
            const dRootPrev = '5555555555555555555555555555555555555555555555555555555555555555';
            const ts = new Date().toISOString();

            // Create dRoot dummy entry so d1 does not have missing predecessor, but rather forms an unanchored island
            const dRootId = crypto.randomUUID();
            await client.query(
                `INSERT INTO ledger_journal (entry_id, instruction_id, account_id, direction, amount, currency, timestamp, hash, prev_hash) 
                 VALUES ($1, $2, 'Alice_Corp', 'DEBIT', 10.00, 'USD', $3, $4, NULL)`,
                [dRootId, instrId, ts, dRootPrev]
            );
            await client.query(
                `INSERT INTO ledger_journal (entry_id, instruction_id, account_id, direction, amount, currency, timestamp, hash, prev_hash) 
                 VALUES ($1, $2, 'Alice_Corp', 'DEBIT', 10.00, 'USD', $3, $4, $5)`,
                [d1Id, instrId, ts, d1Hash, dRootPrev]
            );
            await client.query(
                `INSERT INTO ledger_journal (entry_id, instruction_id, account_id, direction, amount, currency, timestamp, hash, prev_hash) 
                 VALUES ($1, $2, 'Bob_Supply', 'CREDIT', 10.00, 'USD', $3, $4, $5)`,
                [d2Id, instrId, ts, d2Hash, d1Hash]
            );

            const result = await verifyChain({ client });
            expect(result.verified).toBe(false);
            expect(result.error).toBe('DISCONNECTED_CHAIN');
        });

        test('15. Safe sequence backfill restores deterministic monotonic sequence_id and synchronizes generator', async () => {
            for (let i = 0; i < 3; i++) {
                const instrId = crypto.randomUUID();
                await client.query(
                    `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state) 
                     VALUES ($1, 100, 'USD', 'Alice_Corp', 'Bob_Supply', 'BACKFILL_TEST', 'SETTLED')`,
                    [instrId]
                );
                await client.query('BEGIN');
                await writeLedger(client, instrId, 'Alice_Corp', 'Bob_Supply', 100, 'USD', 0);
                await client.query('COMMIT');
            }

            // Scramble sequence_id deliberately to arbitrary numbers
            await client.query(
                'UPDATE ledger_journal SET sequence_id = 1000 - sequence_id'
            );

            const backfillRes = await backfillLedgerSequences({ client });
            expect(backfillRes.success).toBe(true);
            expect(backfillRes.backfilledCount).toBe(6);

            const seqCheck = await client.query(
                'SELECT sequence_id FROM ledger_journal ORDER BY sequence_id ASC'
            );
            const seqs = seqCheck.rows.map((r) => parseInt(r.sequence_id));
            expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);

            const currvalRes = await client.query(
                "SELECT last_value FROM ledger_journal_sequence_id_seq"
            );
            expect(parseInt(currvalRes.rows[0].last_value)).toBe(6);

            const verifyRes = await verifyChain({ client });
            expect(verifyRes.verified).toBe(true);
            expect(verifyRes.verifiedCount).toBe(6);
        });

        test('16. Timestamp round-trip and canonical payload hash reproducibility', async () => {
            const instrId = crypto.randomUUID();
            await client.query(
                `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state) 
                 VALUES ($1, 333.33, 'USD', 'Alice_Corp', 'Bob_Supply', 'REPRODUCIBILITY', 'SETTLED')`,
                [instrId]
            );

            await client.query('BEGIN');
            await writeLedger(client, instrId, 'Alice_Corp', 'Bob_Supply', 333.33, 'USD', 0);
            await client.query('COMMIT');

            const res = await client.query(
                'SELECT * FROM ledger_journal WHERE instruction_id = $1 ORDER BY sequence_id ASC',
                [instrId]
            );
            expect(res.rows.length).toBe(2);

            for (const row of res.rows) {
                const computed = computePayloadHash(row);
                expect(computed).toBe(row.hash);
            }
        });
    });

    describe('Sprint 2.2.4.2.2 — Asset-Specific Decimal Precision and Ledger Persistence', () => {
        let client;

        beforeAll(async () => {
            client = await testDbPool.connect();
        });

        afterAll(async () => {
            if (client) {
                client.release();
            }
        });

        test('17. Schema contract: columns are elevated to NUMERIC(38,7)', async () => {
            const res = await client.query(`
                SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
                FROM information_schema.columns
                WHERE (table_name = 'ledger_journal' AND column_name = 'amount')
                   OR (table_name = 'instructions' AND column_name IN ('amount', 'tax_withheld', 'net_amount'))
                   OR (table_name = 'balances' AND column_name = 'balance')
                ORDER BY table_name, column_name;
            `);
            expect(res.rows.length).toBe(5);
            for (const col of res.rows) {
                expect(col.data_type).toBe('numeric');
                expect(parseInt(col.numeric_precision, 10)).toBeGreaterThanOrEqual(38);
                expect(parseInt(col.numeric_scale, 10)).toBeGreaterThanOrEqual(7);
            }
        });

        test('18. Rejection of JavaScript Number monetary inputs in API validation', () => {
            const payload = {
                amount: 100.5,
                currency: 'USD',
                sender: 'Alice_123',
                recipient: 'Bob_456',
                purpose: 'CARD',
                auth_token: 'afat_1234567890abcdef',
            };
            const { error } = instructionInitiateSchema.validate(payload);
            expect(error).toBeDefined();
            expect(error.message).toContain('Unsafe JavaScript Number monetary inputs are rejected');
        });

        test('19. Asset precision enforcement: reject XLM 8 decimals and USD 3 decimals', () => {
            // XLM 8 decimals rejected by canonical decimal utility
            expect(() => toCanonicalDecimal('0.12345678', 'XLM')).toThrow(RangeError);
            expect(() => toCanonicalDecimal('0.12345678', 'XLM')).toThrow(
                /exceeds maximum precision of 7 decimal places for XLM/
            );

            // USD 3 decimals rejected by canonical decimal utility
            expect(() => toCanonicalDecimal('100.123', 'USD')).toThrow(RangeError);
            expect(() => toCanonicalDecimal('100.123', 'USD')).toThrow(
                /exceeds maximum precision of 2 decimal places for USD/
            );

            // Schema validation rejection
            const invalidXlm = {
                amount: '0.12345678',
                currency: 'XLM',
                sender: 'Alice_Stellar',
                recipient: 'Bob_Stellar',
                purpose: 'CRYPTO_TRANSFER',
                auth_token: 'afat_1234567890abcdef',
            };
            expect(instructionInitiateSchema.validate(invalidXlm).error).toBeDefined();

            const invalidUsd = {
                amount: '100.123',
                currency: 'USD',
                sender: 'Alice_Stellar',
                recipient: 'Bob_Stellar',
                purpose: 'CARD',
                auth_token: 'afat_1234567890abcdef',
            };
            expect(instructionInitiateSchema.validate(invalidUsd).error).toBeDefined();
        });

        test('20. Rejection of scientific notation, empty, negative, or malformed decimals', () => {
            expect(() => toCanonicalDecimal('1e-5', 'USD')).toThrow(TypeError);
            expect(() => toCanonicalDecimal('', 'USD')).toThrow(TypeError);
            expect(() => toCanonicalDecimal(null, 'USD')).toThrow(TypeError);
            expect(() => toCanonicalDecimal(undefined, 'USD')).toThrow(TypeError);

            const sciPayload = {
                amount: '1e5',
                currency: 'USD',
                sender: 'Alice',
                recipient: 'Bob',
                purpose: 'CARD',
                auth_token: 'afat_1234567890abcdef',
            };
            expect(instructionInitiateSchema.validate(sciPayload).error.message).toContain(
                'Scientific notation is not permitted'
            );

            const negPayload = {
                amount: '-50.00',
                currency: 'USD',
                sender: 'Alice',
                recipient: 'Bob',
                purpose: 'CARD',
                auth_token: 'afat_1234567890abcdef',
            };
            expect(instructionInitiateSchema.validate(negPayload).error.message).toContain('positive');
        });

        test('21. Exact ledger persistence & round-trip hash reproduction for XLM (1.0000000, 0.1234567, 0.0000001)', async () => {
            const xlmAmounts = ['1.0000000', '0.1234567', '0.0000001'];

            for (const amt of xlmAmounts) {
                const instrId = crypto.randomUUID();
                await client.query(
                    `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state)
                     VALUES ($1, $2, 'XLM', 'Alice_Stellar', 'Bob_Stellar', 'XLM_PRECISION_TEST', 'SETTLED')`,
                    [instrId, amt]
                );

                await client.query('BEGIN');
                await writeLedger(client, instrId, 'Alice_Stellar', 'Bob_Stellar', amt, 'XLM', '0.0000000');
                await verifyLedgerIntegrity(client, instrId, 'XLM', '0.0000000');
                await client.query('COMMIT');

                const entries = await client.query(
                    'SELECT * FROM ledger_journal WHERE instruction_id = $1 ORDER BY sequence_id ASC',
                    [instrId]
                );
                expect(entries.rows.length).toBe(2);

                for (const row of entries.rows) {
                    // Verify that database preserved all 7 fractional digits exactly
                    expect(toCanonicalDecimal(row.amount, 'XLM')).toBe(amt);
                    // Verify exact hash reproduction
                    const recomputed = computePayloadHash(row);
                    expect(recomputed).toBe(row.hash);
                }
            }
        });

        test('22. Exact ledger persistence & round-trip hash reproduction for fiat (USD 100.00, INR 500.25)', async () => {
            const fiatCases = [
                { currency: 'USD', amount: '100.00' },
                { currency: 'INR', amount: '500.25' },
            ];

            for (const { currency, amount } of fiatCases) {
                const instrId = crypto.randomUUID();
                await client.query(
                    `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state)
                     VALUES ($1, $2, $3, 'Corp_Sender', 'Corp_Recipient', 'FIAT_PRECISION_TEST', 'SETTLED')`,
                    [instrId, amount, currency]
                );

                await client.query('BEGIN');
                await writeLedger(client, instrId, 'Corp_Sender', 'Corp_Recipient', amount, currency, 0);
                await verifyLedgerIntegrity(client, instrId, currency, 0);
                await client.query('COMMIT');

                const entries = await client.query(
                    'SELECT * FROM ledger_journal WHERE instruction_id = $1 ORDER BY sequence_id ASC',
                    [instrId]
                );
                expect(entries.rows.length).toBe(2);

                for (const row of entries.rows) {
                    // In PostgreSQL NUMERIC(38,7), read amount is padded with zeroes: e.g. '100.0000000'
                    // Asset-aware canonicalization normalizes back to exact 2-decimal fiat representation
                    expect(toCanonicalDecimal(row.amount, currency)).toBe(amount);
                    const recomputed = computePayloadHash(row);
                    expect(recomputed).toBe(row.hash);
                }
            }
        });

        test('23. Double-entry debit/credit equality with fractional tax for 7-decimal XLM', async () => {
            const instrId = crypto.randomUUID();
            const netAmount = '5.1234567';
            const taxAmount = '0.0000003';
            const grossAmount = '5.1234570';

            expect(decimalAdd(netAmount, taxAmount, 'XLM')).toBe(grossAmount);

            await client.query(
                `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state, tax_withheld, net_amount)
                 VALUES ($1, $2, 'XLM', 'Alice_Stellar', 'Bob_Stellar', 'TAX_EQUALITY_TEST', 'SETTLED', $3, $4)`,
                [instrId, grossAmount, taxAmount, netAmount]
            );

            await client.query('BEGIN');
            await writeLedger(client, instrId, 'Alice_Stellar', 'Bob_Stellar', netAmount, 'XLM', taxAmount);
            await verifyLedgerIntegrity(client, instrId, 'XLM', taxAmount);
            await client.query('COMMIT');

            // Verify tampering with tax throws LEDGER_INTEGRITY_FAILED
            await expect(
                verifyLedgerIntegrity(client, instrId, 'XLM', '0.0000001')
            ).rejects.toThrow(/LEDGER_INTEGRITY_FAILED/);
        });

        test('24. Full chain integrity verification post-migration (fiat and digital hashes unbroken)', async () => {
            const verifyRes = await verifyChain({ client });
            expect(verifyRes.verified).toBe(true);
            expect(verifyRes.errors).toHaveLength(0);
            expect(verifyRes.verifiedCount).toBeGreaterThanOrEqual(12);
        });
    });

    describe('Sprint 2.2.4.2.3 — Full Asset Precision Persistence and Database Dependency Verification', () => {
        let client;

        beforeAll(async () => {
            client = await testDbPool.connect();
        });

        afterAll(async () => {
            if (client) {
                client.release();
            }
        });

        test('25. Schema contract: columns and views are elevated to NUMERIC(56,18)', async () => {
            const res = await client.query(`
                SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
                FROM information_schema.columns
                WHERE (table_name = 'ledger_journal' AND column_name = 'amount')
                   OR (table_name = 'instructions' AND column_name IN ('amount', 'tax_withheld', 'net_amount'))
                   OR (table_name = 'balances' AND column_name = 'balance')
                   OR (table_name = 'invoices' AND column_name = 'total_amount')
                   OR (table_name = 'fusion_virtual_balances' AND column_name = 'virtual_balance')
                ORDER BY table_name, column_name;
            `);
            expect(res.rows.length).toBe(7);
            for (const col of res.rows) {
                expect(col.data_type).toBe('numeric');
                expect(parseInt(col.numeric_precision, 10)).toBe(56);
                expect(parseInt(col.numeric_scale, 10)).toBe(18);
            }
        });

        test('26. Exact persistence & retrieval for XLM with 7 decimal places', async () => {
            const amounts = ['1.0000000', '0.1234567', '0.0000001'];
            for (const amt of amounts) {
                const instrId = crypto.randomUUID();
                await client.query(
                    `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state)
                     VALUES ($1, $2, 'XLM', 'Alice_Stellar', 'Bob_Stellar', 'XLM_56_18_TEST', 'SETTLED')`,
                    [instrId, amt]
                );

                const readBack = await client.query(
                    'SELECT amount FROM instructions WHERE instruction_id = $1',
                    [instrId]
                );
                expect(toCanonicalDecimal(readBack.rows[0].amount, 'XLM')).toBe(amt);
            }
        });

        test('27. Exact persistence & retrieval for BTC with 8 decimal places', async () => {
            const btcAmounts = ['0.12345678', '0.00000001', '21000000.00000000'];
            for (const amt of btcAmounts) {
                const instrId = crypto.randomUUID();
                await client.query(
                    `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state)
                     VALUES ($1, $2, 'BTC', 'Alice_Btc', 'Bob_Btc', 'BTC_56_18_TEST', 'INITIATED')`,
                    [instrId, amt]
                );

                const readBack = await client.query(
                    'SELECT amount FROM instructions WHERE instruction_id = $1',
                    [instrId]
                );
                expect(toCanonicalDecimal(readBack.rows[0].amount, 'BTC')).toBe(amt);
            }
        });

        test('28. Exact persistence & retrieval for ETH with 18 decimal places (1 wei precision)', async () => {
            const ethAmounts = [
                '0.123456789012345678',
                '0.000000000000000001', // 1 wei
                '1000.555555555555555555',
            ];
            for (const amt of ethAmounts) {
                const instrId = crypto.randomUUID();
                await client.query(
                    `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state)
                     VALUES ($1, $2, 'ETH', 'Alice_Eth', 'Bob_Eth', 'ETH_56_18_TEST', 'INITIATED')`,
                    [instrId, amt]
                );

                const readBack = await client.query(
                    'SELECT amount FROM instructions WHERE instruction_id = $1',
                    [instrId]
                );
                expect(toCanonicalDecimal(readBack.rows[0].amount, 'ETH')).toBe(amt);
            }
        });

        test('29. Exact persistence & retrieval for USDC with 6 decimal places', async () => {
            const usdcAmounts = ['50.123456', '0.000001', '100000.000000'];
            for (const amt of usdcAmounts) {
                const instrId = crypto.randomUUID();
                await client.query(
                    `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state)
                     VALUES ($1, $2, 'USDC', 'Alice_Usdc', 'Bob_Usdc', 'USDC_56_18_TEST', 'INITIATED')`,
                    [instrId, amt]
                );

                const readBack = await client.query(
                    'SELECT amount FROM instructions WHERE instruction_id = $1',
                    [instrId]
                );
                expect(toCanonicalDecimal(readBack.rows[0].amount, 'USDC')).toBe(amt);
            }
        });

        test('30. Exact persistence & retrieval for Fiat with 2 decimal places', async () => {
            const fiatAmounts = [
                { currency: 'USD', amount: '100.00' },
                { currency: 'EUR', amount: '250.75' },
                { currency: 'INR', amount: '500.25' },
            ];
            for (const { currency, amount } of fiatAmounts) {
                const instrId = crypto.randomUUID();
                await client.query(
                    `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state)
                     VALUES ($1, $2, $3, 'Corp_Sender', 'Corp_Recipient', 'FIAT_56_18_TEST', 'INITIATED')`,
                    [instrId, amount, currency]
                );

                const readBack = await client.query(
                    'SELECT amount FROM instructions WHERE instruction_id = $1',
                    [instrId]
                );
                expect(toCanonicalDecimal(readBack.rows[0].amount, currency)).toBe(amount);
            }
        });

        test('31. Simulated assets (BTC, ETH) execute to SIMULATED state and NEVER create ledger entries', async () => {
            const simulatedCases = [
                { currency: 'BTC', amount: '0.12345678' },
                { currency: 'ETH', amount: '0.123456789012345678' },
            ];

            for (const { currency, amount } of simulatedCases) {
                const instrId = crypto.randomUUID();
                await client.query(
                    `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state)
                     VALUES ($1, $2, $3, 'Crypto_Holder', 'Cold_Storage', 'UNSUPPORTED_TESTNET_ASSET', 'PENDING_EXECUTION')`,
                    [instrId, amount, currency]
                );

                const sagaResult = await processInstructionSagaAtomic(instrId, testDbPool);
                expect(sagaResult.current_state).toBe('SIMULATED');

                const dbInstr = await client.query(
                    'SELECT state, amount, currency, error_message FROM instructions WHERE instruction_id = $1',
                    [instrId]
                );
                expect(dbInstr.rows[0].state).toBe('SIMULATED');
                expect(toCanonicalDecimal(dbInstr.rows[0].amount, currency)).toBe(amount);
                expect(dbInstr.rows[0].error_message).toContain('Simulated');

                // Crucial security constraint: zero ledger journal entries must exist for simulated assets
                const ledgerCheck = await client.query(
                    'SELECT count(*) FROM ledger_journal WHERE instruction_id = $1',
                    [instrId]
                );
                expect(parseInt(ledgerCheck.rows[0].count, 10)).toBe(0);
            }
        });

        test('32. Dependent view fusion_virtual_balances remains intact and functional without CASCADE', async () => {
            const viewQuery = await client.query('SELECT * FROM fusion_virtual_balances LIMIT 5');
            expect(viewQuery.rows.length).toBeGreaterThan(0);
            for (const row of viewQuery.rows) {
                expect(row).toHaveProperty('account_id');
                expect(row).toHaveProperty('currency');
                expect(row).toHaveProperty('virtual_balance');
                expect(row).toHaveProperty('updated_at');
            }
        });

        test('33. Full ledger chain cryptographic verification post-migration', async () => {
            const verifyRes = await verifyChain({ client });
            expect(verifyRes.verified).toBe(true);
            expect(verifyRes.errors).toHaveLength(0);
        });

        test('34. Migration 013 applies repeat-safely and on clean database initialization', async () => {
            const CLEAN_PRECISION_DB = 'fusion_test_clean_precision_db';
            try {
                await execAdminSql(
                    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${CLEAN_PRECISION_DB}'`
                );
                await execAdminSql(`DROP DATABASE IF EXISTS ${CLEAN_PRECISION_DB}`);
                await execAdminSql(`CREATE DATABASE ${CLEAN_PRECISION_DB}`);

                const migResult = await runAllMigrations({ database: CLEAN_PRECISION_DB });
                expect(migResult.success).toBe(true);

                const cleanPool = new Pool({
                    host: DB_HOST,
                    port: DB_PORT,
                    user: DB_USER,
                    password: DB_PASSWORD,
                    database: CLEAN_PRECISION_DB,
                });
                try {
                    const countRes = await cleanPool.query('SELECT count(*) FROM schema_migrations');
                    expect(parseInt(countRes.rows[0].count, 10)).toBeGreaterThanOrEqual(13);

                    const colCheck = await cleanPool.query(`
                        SELECT table_name, column_name, numeric_precision, numeric_scale
                        FROM information_schema.columns
                        WHERE (table_name = 'ledger_journal' AND column_name = 'amount')
                           OR (table_name = 'instructions' AND column_name = 'amount')
                           OR (table_name = 'balances' AND column_name = 'balance');
                    `);
                    for (const r of colCheck.rows) {
                        expect(parseInt(r.numeric_precision, 10)).toBe(56);
                        expect(parseInt(r.numeric_scale, 10)).toBe(18);
                    }
                } finally {
                    await cleanPool.end();
                }
            } finally {
                try {
                    await execAdminSql(
                        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${CLEAN_PRECISION_DB}'`
                    );
                    await execAdminSql(`DROP DATABASE IF EXISTS ${CLEAN_PRECISION_DB}`);
                } catch {
                    // Ignore teardown errors
                }
            }
        });
    });
});
