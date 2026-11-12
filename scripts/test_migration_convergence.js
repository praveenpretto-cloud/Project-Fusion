'use strict';

const { Pool, Client } = require('pg');
const { runAllMigrations } = require('./migrate_all');

async function testConvergence() {
    const adminClient = new Client({
        user: 'praveen',
        host: 'localhost',
        port: 5432,
        database: 'postgres',
    });

    await adminClient.connect();

    try {
        console.log('[CONVERGENCE] Creating test databases...');
        await adminClient.query('DROP DATABASE IF EXISTS fusion_test_fresh_db;');
        await adminClient.query('CREATE DATABASE fusion_test_fresh_db;');

        await adminClient.query('DROP DATABASE IF EXISTS fusion_test_upgrade_db;');
        await adminClient.query('CREATE DATABASE fusion_test_upgrade_db;');

        // 1. Fresh Install Test
        console.log('[CONVERGENCE] 1. Running Fresh Install on fusion_test_fresh_db...');
        await runAllMigrations({
            user: 'praveen',
            host: 'localhost',
            port: 5432,
            database: 'fusion_test_fresh_db',
        });

        // 2. Upgrade Test
        console.log(
            '[CONVERGENCE] 2. Running Upgrade Test on fusion_test_upgrade_db (000..020 then 021)...'
        );
        // Run up to 020 first
        const fs = require('fs');
        const path = require('path');
        const upPool = new Pool({
            user: 'praveen',
            host: 'localhost',
            port: 5432,
            database: 'fusion_test_upgrade_db',
        });
        const upClient = await upPool.connect();

        // Apply schema + 001..020
        const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
        const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
        await upClient.query(schemaSql);
        await upClient.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                migration_name VARCHAR(255) PRIMARY KEY,
                checksum VARCHAR(64),
                execution_time_ms INTEGER,
                status VARCHAR(50) DEFAULT 'APPLIED',
                applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);

        const files = fs
            .readdirSync(migrationsDir)
            .filter((f) => f.endsWith('.sql') && f <= '020_void_lifecycle_and_table_protection.sql')
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        const crypto = require('crypto');
        for (const file of files) {
            const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
            const checksum = crypto.createHash('sha256').update(sql).digest('hex');
            await upClient.query(sql);
            await upClient.query(
                `INSERT INTO schema_migrations (migration_name, checksum, execution_time_ms, status) VALUES ($1, $2, 1, 'APPLIED')`,
                [file, checksum]
            );
        }
        upClient.release();
        await upPool.end();

        // Now run migrate_all on fusion_test_upgrade_db to apply forward upgrade
        console.log('[CONVERGENCE] Applying forward migration 021 via migrator...');
        await runAllMigrations({
            user: 'praveen',
            host: 'localhost',
            port: 5432,
            database: 'fusion_test_upgrade_db',
        });

        // 3. Compare schemas of fresh vs upgrade
        console.log('[CONVERGENCE] 3. Comparing schemas between Fresh and Upgrade databases...');
        const freshPool = new Pool({
            user: 'praveen',
            host: 'localhost',
            port: 5432,
            database: 'fusion_test_fresh_db',
        });
        const upgradePool = new Pool({
            user: 'praveen',
            host: 'localhost',
            port: 5432,
            database: 'fusion_test_upgrade_db',
        });

        const getObjectsQuery = `
            SELECT 'TABLE' as type, table_schema || '.' || table_name as obj_name 
            FROM information_schema.tables WHERE table_schema IN ('public', 'identity')
            UNION ALL
            SELECT 'COLUMN' as type, table_schema || '.' || table_name || '.' || column_name as obj_name 
            FROM information_schema.columns WHERE table_schema IN ('public', 'identity')
            UNION ALL
            SELECT 'ROUTINE' as type, routine_schema || '.' || routine_name as obj_name 
            FROM information_schema.routines WHERE routine_schema IN ('public', 'identity')
            ORDER BY 1, 2;
        `;

        const freshRes = await freshPool.query(getObjectsQuery);
        const upgradeRes = await upgradePool.query(getObjectsQuery);

        const freshSet = new Set(freshRes.rows.map((r) => `${r.type}:${r.obj_name}`));
        const upgradeSet = new Set(upgradeRes.rows.map((r) => `${r.type}:${r.obj_name}`));

        let diffCount = 0;
        for (const item of freshSet) {
            if (!upgradeSet.has(item)) {
                console.error(`[DIFF] Missing in upgrade DB: ${item}`);
                diffCount++;
            }
        }
        for (const item of upgradeSet) {
            if (!freshSet.has(item)) {
                console.error(`[DIFF] Extra in upgrade DB: ${item}`);
                diffCount++;
            }
        }

        if (diffCount === 0) {
            console.log(
                `[CONVERGENCE] ✅ Perfect Convergence! Fresh and Upgrade paths yield identical schema (${freshSet.size} objects matched).`
            );
        } else {
            throw new Error(
                `Schema drift detected: ${diffCount} differences between fresh and upgrade databases`
            );
        }

        await freshPool.end();
        await upgradePool.end();

        // Cleanup disposable test databases
        await adminClient.query('DROP DATABASE IF EXISTS fusion_test_fresh_db;');
        await adminClient.query('DROP DATABASE IF EXISTS fusion_test_upgrade_db;');
        console.log('[CONVERGENCE] Cleaned up disposable databases.');
    } finally {
        await adminClient.end();
    }
}

testConvergence().catch((err) => {
    console.error('[CONVERGENCE FATAL]', err);
    process.exit(1);
});
