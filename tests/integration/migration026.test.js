'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { runAllMigrations } = require('../../scripts/migrate_all');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASSWORD = process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : 'praveen123';

const TEST_BASE_DB = 'fusion_test_m026_base_db';
const TEST_EXEC_DB = 'fusion_test_m026_exec_db';

const OP_TREASURY_ANALYST = '00000000-0000-4000-8000-000000000001';
const OP_OPS_OPERATOR = '00000000-0000-4000-8000-000000000002';
const OP_AUDITOR = '00000000-0000-4000-8000-000000000003';
const OP_COMPLIANCE = '00000000-0000-4000-8000-000000000004';
const OP_SYSTEM_ADMIN = '00000000-0000-4000-8000-000000000005';
const DEMO_TENANT_ID = '00000000-0000-0000-0000-000000000001';

async function execAdminSql(sql) {
    const adminPool = new Pool({
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USER,
        password: DB_PASSWORD,
        database: 'postgres',
        connectionTimeoutMillis: 5000,
    });
    try {
        await adminPool.query(sql);
    } finally {
        await adminPool.end();
    }
}

async function terminateDb(dbName) {
    try {
        await execAdminSql(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}'`
        );
    } catch {
        // Ignore if db does not exist
    }
}

describe('Phase AI-2C.2: Migration 026 Implementation & Multi-Tenant Preconditions', () => {
    jest.setTimeout(60000);

    let migration026Sql;
    let migration026Checksum;

    beforeAll(async () => {
        const migPath = path.join(
            __dirname,
            '..',
            '..',
            'db',
            'migrations',
            '026_tenant_registry_memberships_provider_configs.sql'
        );
        migration026Sql = fs.readFileSync(migPath, 'utf8');
        migration026Checksum = crypto.createHash('sha256').update(migration026Sql).digest('hex');

        // Create isolated test base db and apply migrations 000..025
        await terminateDb(TEST_BASE_DB);
        await execAdminSql(`DROP DATABASE IF EXISTS ${TEST_BASE_DB}`);
        await execAdminSql(`CREATE DATABASE ${TEST_BASE_DB}`);

        // Apply migrations up to 025 on TEST_BASE_DB
        const basePool = new Pool({
            host: DB_HOST,
            port: DB_PORT,
            user: DB_USER,
            password: DB_PASSWORD,
            database: TEST_BASE_DB,
        });

        const client = await basePool.connect();
        try {
            // Apply 000_schema
            const schemaSql = fs.readFileSync(
                path.join(__dirname, '..', '..', 'db', 'schema.sql'),
                'utf8'
            );
            await client.query(schemaSql);
            await client.query(`
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    migration_name VARCHAR(255) PRIMARY KEY,
                    checksum VARCHAR(64),
                    execution_time_ms INTEGER,
                    status VARCHAR(50) DEFAULT 'APPLIED',
                    applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                );
            `);

            const migrationsDir = path.join(__dirname, '..', '..', 'db', 'migrations');
            const files = fs
                .readdirSync(migrationsDir)
                .filter((f) => f.endsWith('.sql') && f < '026_')
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

            for (const file of files) {
                const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
                const checksum = crypto.createHash('sha256').update(sql).digest('hex');
                await client.query('BEGIN');
                await client.query(sql);
                await client.query(
                    `INSERT INTO schema_migrations (migration_name, checksum, execution_time_ms, status)
                     VALUES ($1, $2, 1, 'APPLIED')`,
                    [file, checksum]
                );
                await client.query('COMMIT');
            }
        } finally {
            client.release();
            await basePool.end();
        }
    });

    afterAll(async () => {
        for (const db of [TEST_BASE_DB, TEST_EXEC_DB]) {
            await terminateDb(db);
            try {
                await execAdminSql(`DROP DATABASE IF EXISTS ${db}`);
            } catch {
                // Ignore teardown errors
            }
        }
    });

    describe('Precondition Fail-Closed Gate Verifications', () => {
        let pool;

        beforeAll(() => {
            pool = new Pool({
                host: DB_HOST,
                port: DB_PORT,
                user: DB_USER,
                password: DB_PASSWORD,
                database: TEST_BASE_DB,
            });
        });

        afterAll(async () => {
            if (pool) {
                await pool.end();
            }
        });

        test('1. Missing operator fails migration precondition', async () => {
            const client = await pool.connect();
            await client.query('BEGIN');
            try {
                // Delete one operator
                await client.query(
                    'DELETE FROM identity.operator_role_assignments WHERE operator_id = $1',
                    [OP_TREASURY_ANALYST]
                );
                await client.query('DELETE FROM identity.operators WHERE operator_id = $1', [
                    OP_TREASURY_ANALYST,
                ]);

                await expect(client.query(migration026Sql)).rejects.toThrow(
                    /MIGRATION 026 PRECONDITION FAILED: Expected exactly 5 operators/
                );
            } finally {
                await client.query('ROLLBACK');
                client.release();
            }
        });

        test('2. Unexpected operator fails migration precondition', async () => {
            const client = await pool.connect();
            await client.query('BEGIN');
            try {
                // Insert a 6th unmapped operator
                await client.query(`
                    INSERT INTO identity.operators (operator_id, email, full_name, is_active)
                    VALUES ('00000000-0000-4000-8000-000000000099', 'rogue@fusion.internal', 'Rogue Operator', TRUE)
                `);

                await expect(client.query(migration026Sql)).rejects.toThrow(
                    /MIGRATION 026 PRECONDITION FAILED: Expected exactly 5 operators/
                );
            } finally {
                await client.query('ROLLBACK');
                client.release();
            }
        });

        test('3. Inactive or NULL operator status fails migration precondition', async () => {
            const client = await pool.connect();
            await client.query('BEGIN');
            try {
                // Test FALSE status
                await client.query(
                    'UPDATE identity.operators SET is_active = FALSE WHERE operator_id = $1',
                    [OP_COMPLIANCE]
                );
                await expect(client.query(migration026Sql)).rejects.toThrow(
                    /MIGRATION 026 PRECONDITION FAILED: Found 1 operator\(s\) that are either unmapped, inactive, or have NULL status/
                );
            } finally {
                await client.query('ROLLBACK');
                client.release();
            }

            const clientNull = await pool.connect();
            await clientNull.query('BEGIN');
            try {
                // Drop NOT NULL temporarily in transaction to test NULL status handling
                await clientNull.query(
                    'ALTER TABLE identity.operators ALTER COLUMN is_active DROP NOT NULL'
                );
                await clientNull.query(
                    'UPDATE identity.operators SET is_active = NULL WHERE operator_id = $1',
                    [OP_COMPLIANCE]
                );
                await expect(clientNull.query(migration026Sql)).rejects.toThrow(
                    /MIGRATION 026 PRECONDITION FAILED: Found 1 operator\(s\) that are either unmapped, inactive, or have NULL status/
                );
            } finally {
                await clientNull.query('ROLLBACK');
                clientNull.release();
            }
        });

        test('4. Incorrect role mapping fails migration precondition', async () => {
            const client = await pool.connect();
            await client.query('BEGIN');
            try {
                // Swap role for operator 1: assign OPS_OPERATOR instead of TREASURY_ANALYST
                const opsRole = await client.query(
                    "SELECT role_id FROM identity.roles WHERE role_key = 'OPS_OPERATOR'"
                );
                await client.query(
                    'UPDATE identity.operator_role_assignments SET role_id = $1 WHERE operator_id = $2',
                    [opsRole.rows[0].role_id, OP_TREASURY_ANALYST]
                );

                await expect(client.query(migration026Sql)).rejects.toThrow(
                    /MIGRATION 026 PRECONDITION FAILED: Bidirectional role assignment discrepancies detected/
                );
            } finally {
                await client.query('ROLLBACK');
                client.release();
            }
        });

        test('5. Duplicate or extra active role assignments fail migration precondition', async () => {
            const client = await pool.connect();
            await client.query('BEGIN');
            try {
                // Assign a second active role to operator 1
                const auditorRole = await client.query(
                    "SELECT role_id FROM identity.roles WHERE role_key = 'AUDITOR'"
                );
                await client.query(
                    `INSERT INTO identity.operator_role_assignments (operator_id, role_id, is_active)
                     VALUES ($1, $2, TRUE)`,
                    [OP_TREASURY_ANALYST, auditorRole.rows[0].role_id]
                );

                await expect(client.query(migration026Sql)).rejects.toThrow(
                    /MIGRATION 026 PRECONDITION FAILED: 1 operator\(s\) have multiple active role assignments/
                );
            } finally {
                await client.query('ROLLBACK');
                client.release();
            }
        });

        test('6. NULL role-assignment status fails migration precondition', async () => {
            const client = await pool.connect();
            await client.query('BEGIN');
            try {
                // Drop NOT NULL temporarily in transaction to test NULL status handling
                await client.query(
                    'ALTER TABLE identity.operator_role_assignments ALTER COLUMN is_active DROP NOT NULL'
                );
                await client.query(
                    'UPDATE identity.operator_role_assignments SET is_active = NULL WHERE operator_id = $1',
                    [OP_AUDITOR]
                );

                await expect(client.query(migration026Sql)).rejects.toThrow(
                    /MIGRATION 026 PRECONDITION FAILED: 1 role assignment\(s\) have NULL is_active status/
                );
            } finally {
                await client.query('ROLLBACK');
                client.release();
            }
        });

        test('7. Pre-existing tenant records cause failure (fail-closed clean state)', async () => {
            const client = await pool.connect();
            await client.query('BEGIN');
            try {
                // Create identity.tenants and insert a pre-existing tenant
                await client.query(`
                    CREATE TABLE IF NOT EXISTS identity.tenants (
                        tenant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        slug VARCHAR(64) NOT NULL UNIQUE,
                        name VARCHAR(255) NOT NULL,
                        status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE'
                    );
                    INSERT INTO identity.tenants (tenant_id, slug, name)
                    VALUES ('99999999-9999-9999-9999-999999999999', 'pre-existing', 'Pre-existing Tenant');
                `);

                await expect(client.query(migration026Sql)).rejects.toThrow(
                    /MIGRATION 026 PRECONDITION FAILED: identity.tenants already contains 1 records/
                );
            } finally {
                await client.query('ROLLBACK');
                client.release();
            }
        });

        test('8. Pre-existing tenant-membership records cause failure (fail-closed clean state)', async () => {
            const client = await pool.connect();
            await client.query('BEGIN');
            try {
                // Create identity.tenants and identity.tenant_memberships with a pre-existing record
                await client.query(`
                    CREATE TABLE IF NOT EXISTS identity.tenants (
                        tenant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        slug VARCHAR(64) NOT NULL UNIQUE,
                        name VARCHAR(255) NOT NULL,
                        status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE'
                    );
                    CREATE TABLE IF NOT EXISTS identity.tenant_memberships (
                        membership_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        tenant_id UUID NOT NULL,
                        operator_id UUID NOT NULL
                    );
                    INSERT INTO identity.tenant_memberships (tenant_id, operator_id)
                    VALUES ('99999999-9999-9999-9999-999999999999', '00000000-0000-4000-8000-000000000001');
                `);

                await expect(client.query(migration026Sql)).rejects.toThrow(
                    /MIGRATION 026 PRECONDITION FAILED: identity.tenant_memberships already contains 1 records/
                );
            } finally {
                await client.query('ROLLBACK');
                client.release();
            }
        });

        test('9. Injected failure after role transfer rolls back the entire migration', async () => {
            const client = await pool.connect();
            await client.query('BEGIN');
            try {
                // Simulate an injected failure at the very end of the migration
                const corruptedMigrationSql =
                    migration026Sql +
                    "\nDO $$ BEGIN RAISE EXCEPTION 'INJECTED_TEST_FAILURE_AT_END'; END $$;";

                await expect(client.query(corruptedMigrationSql)).rejects.toThrow(
                    /INJECTED_TEST_FAILURE_AT_END/
                );

                // Rollback to verify nothing persisted from the failed migration attempt
                await client.query('ROLLBACK');
                await client.query('BEGIN');

                // Check that identity.tenants does not exist
                const tenantTableCheck = await client.query(
                    "SELECT to_regclass('identity.tenants') AS tbl"
                );
                expect(tenantTableCheck.rows[0].tbl).toBeNull();

                // Check that identity.platform_operator_role_assignments does not exist
                const platformTableCheck = await client.query(
                    "SELECT to_regclass('identity.platform_operator_role_assignments') AS tbl"
                );
                expect(platformTableCheck.rows[0].tbl).toBeNull();

                // Check that SYSTEM_ADMIN is STILL in identity.operator_role_assignments
                const sysAdminRole = await client.query(
                    `SELECT ora.is_active FROM identity.operator_role_assignments ora
                     JOIN identity.roles r ON ora.role_id = r.role_id
                     WHERE ora.operator_id = $1 AND r.role_key = 'SYSTEM_ADMIN'`,
                    [OP_SYSTEM_ADMIN]
                );
                expect(sysAdminRole.rows.length).toBe(1);
                expect(sysAdminRole.rows[0].is_active).toBe(true);
            } finally {
                await client.query('ROLLBACK');
                client.release();
            }
        });
    });

    describe('Execution, Schema Constraints & Downstream Integrity Verifications', () => {
        let execPool;

        beforeAll(async () => {
            // Create dedicated database TEST_EXEC_DB
            await terminateDb(TEST_EXEC_DB);
            await execAdminSql(`DROP DATABASE IF EXISTS ${TEST_EXEC_DB}`);
            await execAdminSql(`CREATE DATABASE ${TEST_EXEC_DB}`);

            // Apply all migrations including 026 via canonical migration runner
            const migResult = await runAllMigrations({
                database: TEST_EXEC_DB,
                host: DB_HOST,
                port: DB_PORT,
                user: DB_USER,
                password: DB_PASSWORD,
            });
            expect(migResult.success).toBe(true);

            execPool = new Pool({
                host: DB_HOST,
                port: DB_PORT,
                user: DB_USER,
                password: DB_PASSWORD,
                database: TEST_EXEC_DB,
            });
        });

        afterAll(async () => {
            if (execPool) {
                await execPool.end();
            }
        });

        test('10. SYSTEM_ADMIN receives a platform assignment but no tenant membership; demo tenant created with 4 financial operators', async () => {
            // A. Check demo tenant
            const tenantRes = await execPool.query(
                'SELECT * FROM identity.tenants WHERE tenant_id = $1',
                [DEMO_TENANT_ID]
            );
            expect(tenantRes.rows.length).toBe(1);
            expect(tenantRes.rows[0].slug).toBe('fusion-default-fintech');
            expect(tenantRes.rows[0].status).toBe('ACTIVE');
            expect(tenantRes.rows[0].retention_policy).toBe('DEMO_EPHEMERAL');

            // B. Check tenant memberships: exactly 4 financial operators
            const memRes = await execPool.query(
                'SELECT operator_id, is_active FROM identity.tenant_memberships WHERE tenant_id = $1 ORDER BY operator_id',
                [DEMO_TENANT_ID]
            );
            expect(memRes.rows.length).toBe(4);
            const memberIds = memRes.rows.map((r) => r.operator_id);
            expect(memberIds).toContain(OP_TREASURY_ANALYST);
            expect(memberIds).toContain(OP_OPS_OPERATOR);
            expect(memberIds).toContain(OP_AUDITOR);
            expect(memberIds).toContain(OP_COMPLIANCE);
            expect(memberIds).not.toContain(OP_SYSTEM_ADMIN);

            // C. Check SYSTEM_ADMIN in platform_operator_role_assignments
            const platRes = await execPool.query(
                `SELECT pora.*, r.role_key FROM identity.platform_operator_role_assignments pora
                 JOIN identity.roles r ON pora.role_id = r.role_id
                 WHERE pora.operator_id = $1`,
                [OP_SYSTEM_ADMIN]
            );
            expect(platRes.rows.length).toBe(1);
            expect(platRes.rows[0].role_key).toBe('SYSTEM_ADMIN');
            expect(platRes.rows[0].is_active).toBe(true);

            // D. Check SYSTEM_ADMIN is removed from identity.operator_role_assignments
            const oldRoleRes = await execPool.query(
                'SELECT * FROM identity.operator_role_assignments WHERE operator_id = $1',
                [OP_SYSTEM_ADMIN]
            );
            expect(oldRoleRes.rows.length).toBe(0);
        });

        test('11. Inactive historical role records remain preserved and are not discarded', async () => {
            // Check that the other 4 financial operators still have their assignments in operator_role_assignments
            const activeRoles = await execPool.query(
                'SELECT operator_id, is_active FROM identity.operator_role_assignments WHERE is_active = TRUE'
            );
            expect(activeRoles.rows.length).toBe(4);

            // Insert an inactive historical role for Treasury Analyst to simulate past revocation
            const auditorRoleId = (
                await execPool.query(
                    "SELECT role_id FROM identity.roles WHERE role_key = 'AUDITOR'"
                )
            ).rows[0].role_id;

            await execPool.query(
                `INSERT INTO identity.operator_role_assignments (operator_id, role_id, is_active, revoked_at)
                 VALUES ($1, $2, FALSE, NOW())`,
                [OP_TREASURY_ANALYST, auditorRoleId]
            );

            // Verify inactive historical assignment is preserved
            const inactiveRes = await execPool.query(
                'SELECT * FROM identity.operator_role_assignments WHERE operator_id = $1 AND is_active = FALSE',
                [OP_TREASURY_ANALYST]
            );
            expect(inactiveRes.rows.length).toBe(1);
            expect(inactiveRes.rows[0].is_active).toBe(false);
        });

        test('12. Role-catalog trigger blocks SYSTEM_ADMIN deletion and rename', async () => {
            // Attempt deletion of SYSTEM_ADMIN
            await expect(
                execPool.query("DELETE FROM identity.roles WHERE role_key = 'SYSTEM_ADMIN'")
            ).rejects.toThrow(/Cannot delete protected platform role SYSTEM_ADMIN/);

            // Attempt renaming of SYSTEM_ADMIN
            await expect(
                execPool.query(
                    "UPDATE identity.roles SET role_key = 'SUPER_ADMIN' WHERE role_key = 'SYSTEM_ADMIN'"
                )
            ).rejects.toThrow(/Cannot modify or rename protected platform role key SYSTEM_ADMIN/);
        });

        test('13. Trigger still permits deletion and update of ordinary roles', async () => {
            // Insert temporary ordinary role
            const insRes = await execPool.query(`
                INSERT INTO identity.roles (role_key, role_name, description)
                VALUES ('TEMP_AUDIT_ASSISTANT', 'Temporary Audit Assistant', 'Ephemeral test role')
                RETURNING role_id
            `);
            const tempRoleId = insRes.rows[0].role_id;

            // Updating ordinary role is permitted
            await execPool.query(
                "UPDATE identity.roles SET description = 'Updated description' WHERE role_id = $1",
                [tempRoleId]
            );

            // Deleting ordinary role is permitted
            const delRes = await execPool.query(
                'DELETE FROM identity.roles WHERE role_id = $1 RETURNING role_id',
                [tempRoleId]
            );
            expect(delRes.rows.length).toBe(1);
            expect(delRes.rows[0].role_id).toBe(tempRoleId);
        });

        test('14. Platform role allowlist trigger, provider check constraints, session columns, and migration checksum integrity', async () => {
            // A. Platform role allowlist blocks non-SYSTEM_ADMIN roles in platform_operator_role_assignments
            const opsRoleId = (
                await execPool.query(
                    "SELECT role_id FROM identity.roles WHERE role_key = 'OPS_OPERATOR'"
                )
            ).rows[0].role_id;

            await expect(
                execPool.query(
                    `INSERT INTO identity.platform_operator_role_assignments (operator_id, role_id)
                     VALUES ($1, $2)`,
                    [OP_OPS_OPERATOR, opsRoleId]
                )
            ).rejects.toThrow(/is not a permitted global platform role/);

            // B. Tenant provider configs: Valid provider/environment combination succeeds
            const provRes = await execPool.query(
                `INSERT INTO identity.tenant_provider_configs (
                    tenant_id, provider, config_alias, environment, account_reference, vault_secret_path
                ) VALUES ($1, 'STRIPE_TEST', 'stripe_primary', 'sandbox', 'acct_test123', 'vault://stripe/test1')
                RETURNING config_id`,
                [DEMO_TENANT_ID]
            );
            expect(provRes.rows.length).toBe(1);

            // C. Tenant provider configs: Invalid provider/environment combination fails
            await expect(
                execPool.query(
                    `INSERT INTO identity.tenant_provider_configs (
                        tenant_id, provider, config_alias, environment, account_reference, vault_secret_path
                    ) VALUES ($1, 'STRIPE_TEST', 'stripe_invalid', 'production', 'acct_live123', 'vault://stripe/live')`,
                    [DEMO_TENANT_ID]
                )
            ).rejects.toThrow(/chk_tenant_provider_env_valid_combination/);

            // D. Tenant provider configs: Mismatched environment (e.g. Stripe with testnet) fails
            await expect(
                execPool.query(
                    `INSERT INTO identity.tenant_provider_configs (
                        tenant_id, provider, config_alias, environment, account_reference, vault_secret_path
                    ) VALUES ($1, 'STRIPE_TEST', 'stripe_mismatch', 'testnet', 'acct_test123', 'vault://stripe/test')`,
                    [DEMO_TENANT_ID]
                )
            ).rejects.toThrow(/chk_tenant_provider_env_valid_combination/);

            // E. Tenant ledger heads exists and has primary key on tenant_id
            const headCheck = await execPool.query(
                `SELECT column_name, data_type FROM information_schema.columns
                 WHERE table_schema = 'identity' AND table_name = 'tenant_ledger_heads'`
            );
            const headCols = headCheck.rows.map((r) => r.column_name);
            expect(headCols).toContain('tenant_id');
            expect(headCols).toContain('head_sequence_id');
            expect(headCols).toContain('head_hash');

            // F. Nullable active_tenant_id on identity.operator_sessions
            const sessionColCheck = await execPool.query(
                `SELECT column_name, is_nullable FROM information_schema.columns
                 WHERE table_schema = 'identity' AND table_name = 'operator_sessions' AND column_name = 'active_tenant_id'`
            );
            expect(sessionColCheck.rows.length).toBe(1);
            expect(sessionColCheck.rows[0].is_nullable).toBe('YES');

            // G. Nullable tenant_id on identity.auth_audit_log with ON DELETE RESTRICT
            const auditColCheck = await execPool.query(
                `SELECT column_name, is_nullable FROM information_schema.columns
                 WHERE table_schema = 'identity' AND table_name = 'auth_audit_log' AND column_name = 'tenant_id'`
            );
            expect(auditColCheck.rows.length).toBe(1);
            expect(auditColCheck.rows[0].is_nullable).toBe('YES');

            // Verify foreign key delete action is RESTRICT ('r')
            const fkRuleCheck = await execPool.query(`
                SELECT c.confdeltype
                FROM pg_constraint c
                JOIN pg_namespace n ON n.oid = c.connamespace
                WHERE n.nspname = 'identity'
                  AND c.conrelid = 'identity.auth_audit_log'::regclass
                  AND c.confrelid = 'identity.tenants'::regclass
            `);
            expect(fkRuleCheck.rows.length).toBeGreaterThanOrEqual(1);
            expect(fkRuleCheck.rows[0].confdeltype).toBe('r'); // 'r' = RESTRICT

            // H. Checksum recorded in schema_migrations matches disk file
            const checkRes = await execPool.query(
                `SELECT checksum, status FROM schema_migrations
                 WHERE migration_name = '026_tenant_registry_memberships_provider_configs.sql'`
            );
            expect(checkRes.rows.length).toBe(1);
            expect(checkRes.rows[0].status).toBe('APPLIED');
            expect(checkRes.rows[0].checksum).toBe(migration026Checksum);
        });

        test('15. DEMO_EPHEMERAL retention policy on demo tenant & no universal institutional default', async () => {
            // Verify column default is NULL (no implicit institutional default)
            const colRes = await execPool.query(`
                SELECT column_default, is_nullable
                FROM information_schema.columns
                WHERE table_schema = 'identity' AND table_name = 'tenants' AND column_name = 'retention_policy'
            `);
            expect(colRes.rows.length).toBe(1);
            expect(colRes.rows[0].column_default).toBeNull();
            expect(colRes.rows[0].is_nullable).toBe('NO');

            // Attempting to create a tenant without an explicit retention policy fails
            await expect(
                execPool.query(`
                    INSERT INTO identity.tenants (slug, name)
                    VALUES ('tenant-missing-policy', 'Tenant Missing Policy')
                `)
            ).rejects.toThrow(/null value in column "retention_policy" of relation "tenants" violates not-null constraint/);
        });

        test('16. Audit-log append-only trigger prevents UPDATE and DELETE on audit records', async () => {
            // Insert an audit log record
            const insRes = await execPool.query(`
                INSERT INTO identity.auth_audit_log (event_type, operator_id, tenant_id)
                VALUES ('TEST_AUDIT_IMMUTABILITY', '${OP_TREASURY_ANALYST}', '${DEMO_TENANT_ID}')
                RETURNING audit_id
            `);
            const auditId = insRes.rows[0].audit_id;

            // Attempt UPDATE -> must be blocked by trg_audit_log_append_only
            await expect(
                execPool.query(
                    'UPDATE identity.auth_audit_log SET event_type = $1 WHERE audit_id = $2',
                    ['TAMPERED_EVENT', auditId]
                )
            ).rejects.toThrow(/identity\.auth_audit_log is append-only\. UPDATE and DELETE operations are strictly prohibited\./);

            // Attempt DELETE -> must be blocked by trg_audit_log_append_only
            await expect(
                execPool.query(
                    'DELETE FROM identity.auth_audit_log WHERE audit_id = $1',
                    [auditId]
                )
            ).rejects.toThrow(/identity\.auth_audit_log is append-only\. UPDATE and DELETE operations are strictly prohibited\./);
        });

        test('17. Tenant deletion restriction when audit records exist (ON DELETE RESTRICT)', async () => {
            // Attempt deleting demo tenant while audit record and memberships reference it
            await expect(
                execPool.query('DELETE FROM identity.tenants WHERE tenant_id = $1', [DEMO_TENANT_ID])
            ).rejects.toThrow(/violates foreign key constraint/);
        });
    });
});
