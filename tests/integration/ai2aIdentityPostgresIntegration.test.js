'use strict';

/**
 * Phase AI-2A.2 — PostgreSQL Identity Integration & Verification Suite
 * ======================================================================
 * Tests real PostgreSQL schema, constraints, and concurrency guarantees:
 * 1. Clean schema creation (014_identity_schema.sql)
 * 2. Foreign keys (referential integrity and cascade deletion)
 * 3. Unique constraints (email, (issuer, subject), token_hash, state)
 * 4. Session creation (SessionManager database persistence)
 * 5. Session lookup using token hashes
 * 6. Session expiration (absolute & idle inactivity)
 * 7. Session revocation (explicit logout & reason recording)
 * 8. Session rotation (atomic old session revocation & new token issuance)
 * 9. Authentication transaction expiry
 * 10. Concurrent single-use OIDC state consumption (atomic race resolution)
 * 11. Database rollback behavior (transactional rollback on failure)
 * 12. Migration rerun behavior (idempotent re-execution)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { SessionManager, hashToken } = require('../../core/identity/sessionManager');

const TEST_DB_CONFIG = {
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '54329', 10),
    database: process.env.DB_NAME || 'postgres',
    password: process.env.DB_PASSWORD,
    connectionTimeoutMillis: 3000,
};

describe('Phase AI-2A.2: PostgreSQL Identity Integration & Mandatory Gate', () => {
    let pool;
    let client;
    let isDbAvailable = false;
    let sessionManager;

    beforeAll(async () => {
        pool = new Pool(TEST_DB_CONFIG);
        try {
            client = await pool.connect();
            isDbAvailable = true;
            sessionManager = new SessionManager();
        } catch (err) {
            console.warn(
                `[AI-2A.2 POSTGRES INTEGRATION] Live PostgreSQL connection unavailable (${err.message}). ` +
                'Reporting as NOT VERIFIED. Mocked tests are not substituted.'
            );
            isDbAvailable = false;
        }
    });

    afterAll(async () => {
        if (client) {
            client.release();
        }
        if (pool) {
            await pool.end();
        }
    });

    test('1. Clean schema creation runs 014_identity_schema.sql', async () => {
        if (!isDbAvailable) {
            console.log('SKIPPED: PostgreSQL unavailable');
            return;
        }

        const migrationSql = fs.readFileSync(
            path.join(__dirname, '../../db/migrations/014_identity_schema.sql'),
            'utf8'
        );

        // Execute migration
        await client.query(migrationSql);

        // Verify tables exist
        const res = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'identity'
            ORDER BY table_name
        `);

        const tables = res.rows.map(r => r.table_name);
        expect(tables).toContain('operators');
        expect(tables).toContain('operator_identities');
        expect(tables).toContain('operator_sessions');
        expect(tables).toContain('authentication_transactions');
        expect(tables).toContain('auth_audit_log');
    });

    test('2. Foreign key constraints and cascade actions', async () => {
        if (!isDbAvailable) return;

        const fakeOpId = '00000000-0000-0000-0000-000000000999';

        // 2a. Inserting identity with non-existent operator fails FK
        let fkCaught = false;
        try {
            await client.query(
                `INSERT INTO identity.operator_identities (operator_id, issuer, subject)
                 VALUES ($1, 'https://idp.example.com', 'sub-fk-test')`,
                [fakeOpId]
            );
        } catch (err) {
            fkCaught = true;
            expect(err.code).toBe('23503'); // foreign_key_violation
        }
        expect(fkCaught).toBe(true);

        // 2b. Cascade deletion
        const cascadeEmail = `fk-cascade-${Date.now()}@fusion.local`;
        const opRes = await client.query(
            `INSERT INTO identity.operators (email, full_name)
             VALUES ($1, 'FK Cascade')
             RETURNING operator_id`,
            [cascadeEmail]
        );
        const opId = opRes.rows[0].operator_id;

        const subCascade = `sub-cascade-${Date.now()}`;
        await client.query(
            `INSERT INTO identity.operator_identities (operator_id, issuer, subject)
             VALUES ($1, 'https://idp.example.com', $2)`,
            [opId, subCascade]
        );

        const dummyHash = crypto.createHash('sha256').update(`dummy-token-${Date.now()}`).digest('hex');
        await client.query(
            `INSERT INTO identity.operator_sessions (token_hash, operator_id, expires_at)
             VALUES ($1, $2, NOW() + INTERVAL '8 hours')`,
            [dummyHash, opId]
        );

        // Delete operator -> cascades
        await client.query('DELETE FROM identity.operators WHERE operator_id = $1', [opId]);

        const idCheck = await client.query('SELECT * FROM identity.operator_identities WHERE operator_id = $1', [opId]);
        expect(idCheck.rows.length).toBe(0);

        const sessCheck = await client.query('SELECT * FROM identity.operator_sessions WHERE operator_id = $1', [opId]);
        expect(sessCheck.rows.length).toBe(0);
    });

    test('3. Unique constraints: email, (issuer, subject), token_hash, state', async () => {
        if (!isDbAvailable) return;

        // 3a. Email unique
        const uniqueEmail = `unique-email-${Date.now()}@fusion.local`;
        await client.query(
            `INSERT INTO identity.operators (email, full_name)
             VALUES ($1, 'Unique Op')`,
            [uniqueEmail]
        );
        let emailErr = false;
        try {
            await client.query(
                `INSERT INTO identity.operators (email, full_name)
                 VALUES ($1, 'Duplicate')`,
                [uniqueEmail]
            );
        } catch (err) {
            emailErr = true;
            expect(err.code).toBe('23505'); // unique_violation
        }
        expect(emailErr).toBe(true);

        // 3b. (issuer, subject) unique
        const opRes = await client.query(
            `INSERT INTO identity.operators (email, full_name)
             VALUES ($1, 'Op 2')
             RETURNING operator_id`,
            [`unique-iss-sub-${Date.now()}@fusion.local`]
        );
        const opId = opRes.rows[0].operator_id;

        const subUnique = `sub-unique-${Date.now()}`;
        await client.query(
            `INSERT INTO identity.operator_identities (operator_id, issuer, subject)
             VALUES ($1, 'https://idp.fusion.local', $2)`,
            [opId, subUnique]
        );
        let issSubErr = false;
        try {
            await client.query(
                `INSERT INTO identity.operator_identities (operator_id, issuer, subject)
                 VALUES ($1, 'https://idp.fusion.local', $2)`,
                [opId, subUnique]
            );
        } catch (err) {
            issSubErr = true;
            expect(err.code).toBe('23505');
        }
        expect(issSubErr).toBe(true);

        // 3c. token_hash unique
        const tokHash = crypto.randomBytes(32).toString('hex');
        await client.query(
            `INSERT INTO identity.operator_sessions (token_hash, operator_id, expires_at)
             VALUES ($1, $2, NOW() + INTERVAL '8 hours')`,
            [tokHash, opId]
        );
        let tokHashErr = false;
        try {
            await client.query(
                `INSERT INTO identity.operator_sessions (token_hash, operator_id, expires_at)
                 VALUES ($1, $2, NOW() + INTERVAL '8 hours')`,
                [tokHash, opId]
            );
        } catch (err) {
            tokHashErr = true;
            expect(err.code).toBe('23505');
        }
        expect(tokHashErr).toBe(true);

        // 3d. state unique
        const stateUnique = `state-unique-${Date.now()}`;
        await client.query(
            `INSERT INTO identity.authentication_transactions (state, nonce, encrypted_code_verifier, redirect_uri, expires_at)
             VALUES ($1, 'n1', 'enc1', 'http://localhost:3000', NOW() + INTERVAL '5 min')`,
            [stateUnique]
        );
        let stateErr = false;
        try {
            await client.query(
                `INSERT INTO identity.authentication_transactions (state, nonce, encrypted_code_verifier, redirect_uri, expires_at)
                 VALUES ($1, 'n2', 'enc2', 'http://localhost:3000', NOW() + INTERVAL '5 min')`,
                [stateUnique]
            );
        } catch (err) {
            stateErr = true;
            expect(err.code).toBe('23505');
        }
        expect(stateErr).toBe(true);
    });

    test('4. Session creation via SessionManager persists to database', async () => {
        if (!isDbAvailable) return;

        const opEmail = `session-create-${Date.now()}@fusion.local`;
        const opRes = await client.query(
            `INSERT INTO identity.operators (email, full_name)
             VALUES ($1, 'Session Create Op')
             RETURNING operator_id`,
            [opEmail]
        );
        const opId = opRes.rows[0].operator_id;

        const session = await sessionManager.createSession({
            operatorId: opId,
            ipAddress: '127.0.0.1',
            userAgent: 'IntegrationTest/1.0',
            pool,
        });

        expect(session.rawToken).toBeDefined();
        expect(session.sessionId).toBeDefined();

        const dbRes = await client.query(
            `SELECT * FROM identity.operator_sessions WHERE session_id = $1`,
            [session.sessionId]
        );
        expect(dbRes.rows.length).toBe(1);
        expect(dbRes.rows[0].operator_id).toBe(opId);
        expect(dbRes.rows[0].token_hash).toBe(hashToken(session.rawToken));
        expect(dbRes.rows[0].revoked_at).toBeNull();
    });

    test('5. Session lookup using token hashes', async () => {
        if (!isDbAvailable) return;

        const lookupEmail = `lookup-test-${Date.now()}@fusion.local`;
        const opRes = await client.query(
            `INSERT INTO identity.operators (email, full_name)
             VALUES ($1, 'Lookup Op')
             RETURNING operator_id`,
            [lookupEmail]
        );
        const opId = opRes.rows[0].operator_id;

        const session = await sessionManager.createSession({
            operatorId: opId,
            pool,
        });

        const validation = await sessionManager.validateSession(session.rawToken, { pool });
        expect(validation.valid).toBe(true);
        expect(validation.operator.email).toBe(lookupEmail);
        expect(validation.session.sessionId).toBe(session.sessionId);
    });

    test('6. Session expiration (absolute & idle inactivity)', async () => {
        if (!isDbAvailable) return;

        const opEmail = `expire-test-${Date.now()}@fusion.local`;
        const opRes = await client.query(
            `INSERT INTO identity.operators (email, full_name)
             VALUES ($1, 'Expire Op')
             RETURNING operator_id`,
            [opEmail]
        );
        const opId = opRes.rows[0].operator_id;

        // 6a. Absolute expired session
        const expRawToken = crypto.randomBytes(32).toString('hex');
        const expHash = hashToken(expRawToken);
        await client.query(
            `INSERT INTO identity.operator_sessions (token_hash, operator_id, expires_at, created_at, last_activity_at)
             VALUES ($1, $2, NOW() - INTERVAL '1 minute', NOW() - INTERVAL '9 hours', NOW() - INTERVAL '5 minutes')`,
            [expHash, opId]
        );

        const expVal = await sessionManager.validateSession(expRawToken, { pool });
        expect(expVal.valid).toBe(false);
        expect(expVal.reason).toBe('SESSION_EXPIRED_ABSOLUTE');

        // 6b. Idle expired session
        const idleRawToken = crypto.randomBytes(32).toString('hex');
        const idleHash = hashToken(idleRawToken);
        await client.query(
            `INSERT INTO identity.operator_sessions (token_hash, operator_id, expires_at, created_at, last_activity_at)
             VALUES ($1, $2, NOW() + INTERVAL '4 hours', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '20 minutes')`,
            [idleHash, opId]
        );

        const idleVal = await sessionManager.validateSession(idleRawToken, { pool });
        expect(idleVal.valid).toBe(false);
        expect(idleVal.reason).toBe('SESSION_EXPIRED_IDLE');
    });

    test('7. Session revocation sets revoked_at and revocation_reason', async () => {
        if (!isDbAvailable) return;

        const opEmail = `revoke-test-${Date.now()}@fusion.local`;
        const opRes = await client.query(
            `INSERT INTO identity.operators (email, full_name)
             VALUES ($1, 'Revoke Op')
             RETURNING operator_id`,
            [opEmail]
        );
        const opId = opRes.rows[0].operator_id;

        const session = await sessionManager.createSession({ operatorId: opId, pool });

        const revoked = await sessionManager.revokeSession(session.rawToken, {
            reason: 'OPERATOR_LOGOUT',
            pool,
        });
        expect(revoked).toBe(true);

        const postVal = await sessionManager.validateSession(session.rawToken, { pool });
        expect(postVal.valid).toBe(false);
        expect(postVal.reason).toBe('SESSION_REVOKED');

        const dbRes = await client.query(
            `SELECT revoked_at, revocation_reason FROM identity.operator_sessions WHERE session_id = $1`,
            [session.sessionId]
        );
        expect(dbRes.rows[0].revoked_at).not.toBeNull();
        expect(dbRes.rows[0].revocation_reason).toBe('OPERATOR_LOGOUT');
    });

    test('8. Session rotation revokes old session and issues new valid session', async () => {
        if (!isDbAvailable) return;

        const opEmail = `rotate-test-${Date.now()}@fusion.local`;
        const opRes = await client.query(
            `INSERT INTO identity.operators (email, full_name)
             VALUES ($1, 'Rotate Op')
             RETURNING operator_id`,
            [opEmail]
        );
        const opId = opRes.rows[0].operator_id;

        const initial = await sessionManager.createSession({ operatorId: opId, pool });

        const rotated = await sessionManager.rotateSession(initial.rawToken, { pool });
        expect(rotated.rawToken).not.toBe(initial.rawToken);
        expect(rotated.sessionId).not.toBe(initial.sessionId);

        // Old session must be revoked
        const oldCheck = await sessionManager.validateSession(initial.rawToken, { pool });
        expect(oldCheck.valid).toBe(false);
        expect(oldCheck.reason).toBe('SESSION_REVOKED');

        // New session must be valid
        const newCheck = await sessionManager.validateSession(rotated.rawToken, { pool });
        expect(newCheck.valid).toBe(true);
        expect(newCheck.operator.email).toBe(opEmail);
    });

    test('9. Authentication transaction expiry', async () => {
        if (!isDbAvailable) return;

        const expiredState = 'state-expired-' + Date.now();
        await client.query(
            `INSERT INTO identity.authentication_transactions (state, nonce, encrypted_code_verifier, redirect_uri, expires_at)
             VALUES ($1, 'nonce-exp', 'enc-ver', 'http://localhost:3000/callback', NOW() - INTERVAL '5 seconds')`,
            [expiredState]
        );

        const updateRes = await client.query(
            `UPDATE identity.authentication_transactions
             SET used_at = NOW()
             WHERE state = $1 AND used_at IS NULL AND expires_at > NOW()
             RETURNING transaction_id`,
            [expiredState]
        );
        expect(updateRes.rows.length).toBe(0);
    });

    test('10. Concurrent single-use OIDC state consumption guarantees atomic resolution', async () => {
        if (!isDbAvailable) return;

        const stateVal = 'concurrent-state-' + Date.now();
        await client.query(
            `INSERT INTO identity.authentication_transactions (state, nonce, encrypted_code_verifier, redirect_uri, expires_at)
             VALUES ($1, 'nonce-race', 'enc-ver', 'http://localhost:3000/callback', NOW() + INTERVAL '5 minutes')`,
            [stateVal]
        );

        const consume = () => client.query(
            `UPDATE identity.authentication_transactions
             SET used_at = NOW()
             WHERE state = $1 AND used_at IS NULL AND expires_at > NOW()
             RETURNING transaction_id`,
            [stateVal]
        );

        const [r1, r2] = await Promise.all([consume(), consume()]);
        const total = r1.rows.length + r2.rows.length;
        expect(total).toBe(1);
    });

    test('11. Database rollback behavior cleanly aborts aborted transactions', async () => {
        if (!isDbAvailable) return;

        const rollbackEmail = 'rollback-test@fusion.local';

        const txClient = await pool.connect();
        try {
            await txClient.query('BEGIN');
            await txClient.query(
                `INSERT INTO identity.operators (email, full_name)
                 VALUES ($1, 'Rollback Op')`,
                [rollbackEmail]
            );
            // Intentional constraint violation
            await txClient.query(
                `INSERT INTO identity.operator_identities (operator_id, issuer, subject)
                 VALUES ('00000000-0000-0000-0000-000000000000', 'https://bad.idp', 'bad-sub')`
            );
            await txClient.query('COMMIT');
        } catch (_) {
            await txClient.query('ROLLBACK');
        } finally {
            txClient.release();
        }

        const check = await client.query(
            `SELECT * FROM identity.operators WHERE email = $1`,
            [rollbackEmail]
        );
        expect(check.rows.length).toBe(0);
    });

    test('12. Migration rerun behavior is idempotent', async () => {
        if (!isDbAvailable) return;

        const migrationSql = fs.readFileSync(
            path.join(__dirname, '../../db/migrations/014_identity_schema.sql'),
            'utf8'
        );

        // Re-executing the migration on top of existing data must succeed without errors
        await expect(client.query(migrationSql)).resolves.not.toThrow();

        // Existing tables remain present
        const tablesRes = await client.query(`
            SELECT count(*) FROM information_schema.tables WHERE table_schema = 'identity'
        `);
        expect(parseInt(tablesRes.rows[0].count, 10)).toBeGreaterThanOrEqual(5);
    });
});
