'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

/**
 * Robust Canonical Database Migration Runner for Project Fusion
 * Features:
 * - Session-level PostgreSQL advisory locking to serialize concurrent runners.
 * - SHA-256 checksum tracking for tamper detection and schema drift prevention.
 * - Safe handling of legacy unverified migrations.
 * - Full transactional execution per migration step.
 */
async function runAllMigrations(customConfig = {}) {
    const dbConfig = {
        user: customConfig.user || process.env.DB_USER || 'postgres',
        host: customConfig.host || process.env.DB_HOST || 'localhost',
        database: customConfig.database || process.env.DB_NAME || 'fusion_db',
        password:
            customConfig.password !== undefined ? customConfig.password : process.env.DB_PASSWORD,
        port: parseInt(customConfig.port || process.env.DB_PORT || '5432'),
    };

    const pool = new Pool(dbConfig);
    const client = await pool.connect();
    let lockAcquired = false;

    try {
        console.log(
            `[MIGRATOR] Connected to database: ${dbConfig.database} on ${dbConfig.host}:${dbConfig.port}`
        );

        // 1. Session-level advisory lock to prevent concurrent migration collisions
        console.log('[MIGRATOR] Acquiring session advisory lock (project_fusion_migrations)...');
        await client.query("SELECT pg_advisory_lock(hashtext('project_fusion_migrations'))");
        lockAcquired = true;
        console.log('[MIGRATOR] 🔒 Advisory lock acquired.');

        // 2. Ensure schema_migrations table exists with checksum tracking
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                migration_name VARCHAR(255) PRIMARY KEY,
                checksum VARCHAR(64),
                execution_time_ms INTEGER,
                status VARCHAR(50) DEFAULT 'APPLIED',
                applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
            ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum VARCHAR(64);
            ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS execution_time_ms INTEGER;
            ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'APPLIED';
        `);

        // 3. Mark pre-existing migrations without checksums as LEGACY_UNVERIFIED
        await client.query(`
            UPDATE schema_migrations 
            SET checksum = 'LEGACY_UNVERIFIED', status = 'LEGACY_UNVERIFIED' 
            WHERE checksum IS NULL;
        `);

        // 4. Base schema setup
        const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
        const schemaCheck = await client.query(
            'SELECT migration_name, checksum, status FROM schema_migrations WHERE migration_name = $1',
            ['000_schema.sql']
        );

        if (schemaCheck.rows.length === 0) {
            console.log('[MIGRATOR] Applying base schema db/schema.sql...');
            const schemaSql = fs.readFileSync(schemaPath, 'utf8');
            const schemaChecksum = crypto.createHash('sha256').update(schemaSql).digest('hex');
            const startMs = Date.now();

            await client.query('BEGIN');
            try {
                await client.query(schemaSql);
                const durationMs = Date.now() - startMs;
                await client.query(
                    `INSERT INTO schema_migrations (migration_name, checksum, execution_time_ms, status) 
                     VALUES ($1, $2, $3, 'APPLIED')`,
                    ['000_schema.sql', schemaChecksum, durationMs]
                );
                await client.query('COMMIT');
                console.log(
                    `[MIGRATOR] ✅ Base schema applied (checksum: ${schemaChecksum.substring(0, 8)}..., ${durationMs}ms).`
                );
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            }
        } else {
            const row = schemaCheck.rows[0];
            if (row.checksum && row.checksum !== 'LEGACY_UNVERIFIED') {
                const schemaSql = fs.readFileSync(schemaPath, 'utf8');
                const diskChecksum = crypto.createHash('sha256').update(schemaSql).digest('hex');
                if (diskChecksum !== row.checksum) {
                    throw new Error(
                        `MIGRATION_CHECKSUM_MISMATCH: db/schema.sql has been altered since application! Recorded: ${row.checksum}, Current: ${diskChecksum}`
                    );
                }
            } else {
                console.log('[MIGRATOR] ℹ️ Base schema recorded as LEGACY_UNVERIFIED.');
            }
            console.log('[MIGRATOR] ℹ️ Base schema already applied.');
        }

        // 5. Sequential numbered migrations
        const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
        const files = fs
            .readdirSync(migrationsDir)
            .filter((f) => f.endsWith('.sql'))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        for (const file of files) {
            const filePath = path.join(migrationsDir, file);
            const check = await client.query(
                'SELECT migration_name, checksum, status FROM schema_migrations WHERE migration_name = $1',
                [file]
            );

            if (check.rows.length > 0) {
                const row = check.rows[0];
                if (row.checksum && row.checksum !== 'LEGACY_UNVERIFIED') {
                    const currentSql = fs.readFileSync(filePath, 'utf8');
                    const currentChecksum = crypto
                        .createHash('sha256')
                        .update(currentSql)
                        .digest('hex');
                    if (currentChecksum !== row.checksum) {
                        throw new Error(
                            `MIGRATION_CHECKSUM_MISMATCH: Migration ${file} has altered disk contents! Recorded: ${row.checksum}, Current: ${currentChecksum}`
                        );
                    }
                } else {
                    console.log(
                        `[MIGRATOR] ℹ️ Migration ${file} recorded as ${row.status || 'LEGACY_UNVERIFIED'}. Skipping checksum comparison.`
                    );
                }
                console.log(`[MIGRATOR] ⏭️ Skipping already applied migration: ${file}`);
                continue;
            }

            console.log(`[MIGRATOR] Applying migration: ${file}...`);
            const sql = fs.readFileSync(filePath, 'utf8');
            const fileChecksum = crypto.createHash('sha256').update(sql).digest('hex');
            const startMs = Date.now();

            await client.query('BEGIN');
            try {
                await client.query(sql);
                const durationMs = Date.now() - startMs;
                await client.query(
                    `INSERT INTO schema_migrations (migration_name, checksum, execution_time_ms, status) 
                     VALUES ($1, $2, $3, 'APPLIED')
                     ON CONFLICT (migration_name) DO UPDATE 
                     SET checksum = EXCLUDED.checksum, 
                         execution_time_ms = EXCLUDED.execution_time_ms, 
                         status = EXCLUDED.status,
                         applied_at = NOW()`,
                    [file, fileChecksum, durationMs]
                );
                await client.query('COMMIT');
                console.log(
                    `[MIGRATOR] ✅ Successfully applied: ${file} (checksum: ${fileChecksum.substring(0, 8)}..., ${durationMs}ms)`
                );
            } catch (migErr) {
                await client.query('ROLLBACK');
                console.error(`[MIGRATOR] ❌ Failed to apply ${file}: ${migErr.message}`);
                throw migErr;
            }
        }

        console.log('[MIGRATOR] 🎉 All database migrations are up to date!');
        return { success: true };
    } finally {
        if (lockAcquired) {
            try {
                await client.query(
                    "SELECT pg_advisory_unlock(hashtext('project_fusion_migrations'))"
                );
                console.log('[MIGRATOR] 🔓 Released migration advisory lock.');
            } catch (unlockErr) {
                console.error('[MIGRATOR] ⚠️ Error releasing advisory lock:', unlockErr.message);
            }
        }
        client.release();
        await pool.end();
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const dbArg = args.find((a) => a.startsWith('--db='));
    const targetDb = dbArg ? dbArg.split('=')[1] : undefined;

    runAllMigrations(targetDb ? { database: targetDb } : {})
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('[MIGRATOR FATAL]', err);
            process.exit(1);
        });
}

module.exports = { runAllMigrations };
