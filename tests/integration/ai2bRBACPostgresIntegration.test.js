'use strict';

/**
 * Phase AI-2B.1 — PostgreSQL RBAC, Maker-Checker & Governance Integration Suite
 * =============================================================================
 * Validates real PostgreSQL 16 schema, triggers, constraints, and atomic transactions:
 * 1. Sequential migration execution: schema.sql, 014_identity, 015_rbac, 016_governance
 * 2. Approved role-permission matrix resolution:
 *      - OPS_OPERATOR (Maker): payment:initiate, payment:read, evidence:read
 *      - TREASURY_ANALYST (Checker): payment:approve, payment:reject, payment:read, payment:read:sensitive, treasury:read/manage
 *      - COMPLIANCE_OFFICER: compliance:read/write/hold/release, payment:read, sensitive read, evidence:read (NO payment:approve)
 *      - SYSTEM_ADMIN: admin:manage_roles/operators, system:config, audit:read (ZERO financial read)
 *      - AUDITOR: audit:read, evidence:read, compliance:read, treasury:read (strictly read-only)
 * 3. Database-level Four-Eyes check constraint: chk_maker_checker_distinct
 * 4. Database-level Maker Immutability Trigger: blocks SQL updates to maker_operator_id or terminal status
 * 5. Database-level Append-Only Trigger on identity.auth_audit_log: blocks UPDATE and DELETE
 * 6. Self-Elevation Protection: operators cannot grant roles to themselves
 * 7. Compliance Hold Workflow in PostgreSQL: hold blocks approval, release allows approval
 * 8. Real WebAuthn FIDO2 verification using @simplewebauthn/server with mandatory UV
 * 9. Atomic Transactional Boundaries: rollback on WebAuthn failure preserves database integrity
 * 10. Concurrency race conflict resolution (409 Conflict)
 * 11. Rejection workflow with audit trail
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { RbacService, PERMISSIONS, ROLES } = require('../../core/identity/rbacService');
const { WebAuthnService } = require('../../core/identity/webauthnService');
const { MakerCheckerService, APPROVAL_STATUS } = require('../../core/approvals/makerCheckerService');

const TEST_DB_CONFIG = {
    user: process.env.DB_USER || 'praveen',
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '54329', 10),
    database: process.env.DB_NAME || 'postgres',
    password: process.env.DB_PASSWORD,
    connectionTimeoutMillis: 3000,
};

describe('Phase AI-2B.1: PostgreSQL RBAC & Maker-Checker Integration Gate', () => {
    let pool;
    let client;
    let isDbAvailable = false;
    let rbacService;
    let webauthnService;
    let makerCheckerService;

    const opMaker = '00000000-0000-4000-8000-000000000002';       // dev-ops (OPS_OPERATOR)
    const opChecker = '00000000-0000-4000-8000-000000000001';     // dev-cfo (TREASURY_ANALYST - Checker)
    const opCompliance = '00000000-0000-4000-8000-000000000004';  // dev-compliance (COMPLIANCE_OFFICER)
    const opAdmin = '00000000-0000-4000-8000-000000000005';       // dev-admin (SYSTEM_ADMIN)
    const opAuditor = '00000000-0000-4000-8000-000000000003';     // dev-auditor (AUDITOR)
    let testInstructionId;

    beforeAll(async () => {
        pool = new Pool(TEST_DB_CONFIG);
        try {
            client = await pool.connect();
            const dbCheckRes = await client.query('SELECT current_database() AS db');
            console.log(`[AI-2B POSTGRES INTEGRATION] Connected to active test database: ${dbCheckRes.rows[0].db}`);
            isDbAvailable = true;
            rbacService = new RbacService();
            webauthnService = new WebAuthnService({ rpId: 'localhost' });
            makerCheckerService = new MakerCheckerService({
                rbacService,
                webauthnService,
                stepUpThreshold: 100000,
            });
        } catch (err) {
            console.warn(
                `[AI-2B.1 POSTGRES INTEGRATION] Live PostgreSQL connection unavailable (${err.message}). ` +
                'Reporting as NOT VERIFIED. Mocked tests are not substituted.'
            );
            isDbAvailable = false;
        }
    });

    afterAll(async () => {
        if (client) {
            client.release();
        }
        if (makerCheckerService && typeof makerCheckerService.close === 'function') {
            await makerCheckerService.close();
        }
        if (pool) {
            await pool.end();
        }
    });

    test('1. Runs schema migrations: base schema, 014 through 020 void lifecycle and table protection', async () => {
        if (!isDbAvailable) return;

        // Base schema
        const baseSql = fs.readFileSync(path.join(__dirname, '../../db/schema.sql'), 'utf8');
        await client.query(baseSql);

        // 014 Identity Schema
        const idSql = fs.readFileSync(path.join(__dirname, '../../db/migrations/014_identity_schema.sql'), 'utf8');
        await client.query(idSql);

        // 015 RBAC Schema
        const rbacSql = fs.readFileSync(path.join(__dirname, '../../db/migrations/015_rbac_schema.sql'), 'utf8');
        await client.query(rbacSql);

        // 016 Governance Corrections Schema
        const govSql = fs.readFileSync(path.join(__dirname, '../../db/migrations/016_rbac_governance_corrections.sql'), 'utf8');
        await client.query(govSql);

        // 017 Approval Security Closure Schema
        const closureSql = fs.readFileSync(path.join(__dirname, '../../db/migrations/017_approval_security_closure.sql'), 'utf8');
        await client.query(closureSql);

        // 018 Approved Instruction Immutability Schema
        const immutabilitySql = fs.readFileSync(path.join(__dirname, '../../db/migrations/018_approved_instruction_immutability.sql'), 'utf8');
        await client.query(immutabilitySql);

        // 019 Void Governance & Terminal States Schema
        const voidGovSql = fs.readFileSync(path.join(__dirname, '../../db/migrations/019_void_governance_and_terminal_states.sql'), 'utf8');
        await client.query(voidGovSql);

        // 020 Void Lifecycle & Financial Record Protection Schema
        const voidLifecycleSql = fs.readFileSync(path.join(__dirname, '../../db/migrations/020_void_lifecycle_and_table_protection.sql'), 'utf8');
        await client.query(voidLifecycleSql);

        // 021 Privilege & State Mutation Closure Schema
        const privilegeClosureSql = fs.readFileSync(path.join(__dirname, '../../db/migrations/021_privilege_and_state_closure.sql'), 'utf8');
        await client.query(privilegeClosureSql);

        // 022 WebAuthn Verifier Isolation & Workflow Context Schema
        const verifierIsolationSql = fs.readFileSync(path.join(__dirname, '../../db/migrations/022_webauthn_verifier_isolation_and_workflow_context.sql'), 'utf8');
        await client.query(verifierIsolationSql);

        // 023 Workflow Authorization & Verifier Least-Privilege Closure Schema
        const workflowAuthClosureSql = fs.readFileSync(path.join(__dirname, '../../db/migrations/023_workflow_auth_and_verifier_privilege_closure.sql'), 'utf8');
        await client.query(workflowAuthClosureSql);

        // 024 Payment Execution Authorization and Settlement Evidence
        const executionSettlementAuthSql = fs.readFileSync(path.join(__dirname, '../../db/migrations/024_execution_settlement_authorization_and_evidence.sql'), 'utf8');
        await client.query(executionSettlementAuthSql);

        // 025 Payment Execution and Settlement Evidence Hardening
        const evidenceHardeningSql = fs.readFileSync(path.join(__dirname, '../../db/migrations/025_execution_settlement_evidence_hardening.sql'), 'utf8');
        await client.query(evidenceHardeningSql);

        // Verify tables exist
        const res = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'identity' 
            ORDER BY table_name;
        `);
        const tables = res.rows.map((r) => r.table_name);

        expect(tables).toContain('roles');
        expect(tables).toContain('permissions');
        expect(tables).toContain('role_permissions');
        expect(tables).toContain('operator_role_assignments');
        expect(tables).toContain('webauthn_credentials');
        expect(tables).toContain('webauthn_challenges');
        expect(tables).toContain('payment_approvals');
        expect(tables).toContain('role_change_requests');
        expect(tables).toContain('payment_void_requests');
        expect(tables).toContain('verified_webauthn_assertions');
        expect(tables).toContain('payment_dispatch_records');
        expect(tables).toContain('payment_settlement_evidence');

        // Verify newly added columns in instructions & webauthn_challenges
        const instColsRes = await client.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'instructions';
        `);
        const instCols = instColsRes.rows.map((r) => r.column_name);
        expect(instCols).toContain('version');
        expect(instCols).toContain('environment');
        expect(instCols).toContain('destination_account');

        const challColsRes = await client.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'identity' AND table_name = 'webauthn_challenges';
        `);
        const challCols = challColsRes.rows.map((r) => r.column_name);
        expect(challCols).toContain('context_digest');
        expect(challCols).toContain('context_data');
        expect(challCols).toContain('instruction_id');

        // Verify challenge_id column in payment_void_requests (Migration 020)
        const voidColsRes = await client.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'identity' AND table_name = 'payment_void_requests';
        `);
        const voidCols = voidColsRes.rows.map((r) => r.column_name);
        expect(voidCols).toContain('challenge_id');

        // Reset operator role assignments to baseline canonical seed
        await client.query(`
            DELETE FROM identity.operator_role_assignments;
            INSERT INTO identity.operator_role_assignments (operator_id, role_id)
            SELECT o.operator_id, r.role_id
            FROM (
                VALUES
                    ('00000000-0000-4000-8000-000000000001'::uuid, 'TREASURY_ANALYST'),
                    ('00000000-0000-4000-8000-000000000002'::uuid, 'OPS_OPERATOR'),
                    ('00000000-0000-4000-8000-000000000003'::uuid, 'AUDITOR'),
                    ('00000000-0000-4000-8000-000000000004'::uuid, 'COMPLIANCE_OFFICER'),
                    ('00000000-0000-4000-8000-000000000005'::uuid, 'SYSTEM_ADMIN')
            ) AS v(op_id, r_key)
            JOIN identity.operators o ON o.operator_id = v.op_id
            JOIN identity.roles r ON r.role_key = v.r_key;
        `);
    });

    test('2. Verifies corrected role-permission matrix in PostgreSQL', async () => {
        if (!isDbAvailable) return;

        // OPS_OPERATOR (Maker)
        const opsPerms = await rbacService.getOperatorPermissions(opMaker, { pool });
        expect(opsPerms.has(PERMISSIONS.PAYMENT_INITIATE)).toBe(true);
        expect(opsPerms.has(PERMISSIONS.PAYMENT_READ)).toBe(true);
        expect(opsPerms.has(PERMISSIONS.EVIDENCE_READ)).toBe(true);
        expect(opsPerms.has(PERMISSIONS.PAYMENT_APPROVE)).toBe(false);

        // TREASURY_ANALYST (Checker)
        const cfoPerms = await rbacService.getOperatorPermissions(opChecker, { pool });
        expect(cfoPerms.has(PERMISSIONS.PAYMENT_APPROVE)).toBe(true);
        expect(cfoPerms.has(PERMISSIONS.PAYMENT_REJECT)).toBe(true);
        expect(cfoPerms.has(PERMISSIONS.PAYMENT_READ)).toBe(true);
        expect(cfoPerms.has(PERMISSIONS.PAYMENT_READ_SENSITIVE)).toBe(true);
        expect(cfoPerms.has(PERMISSIONS.TREASURY_READ)).toBe(true);
        expect(cfoPerms.has(PERMISSIONS.TREASURY_MANAGE)).toBe(true);
        expect(cfoPerms.has(PERMISSIONS.PAYMENT_INITIATE)).toBe(false); // Checker CANNOT initiate

        // COMPLIANCE_OFFICER
        const compPerms = await rbacService.getOperatorPermissions(opCompliance, { pool });
        expect(compPerms.has(PERMISSIONS.COMPLIANCE_HOLD)).toBe(true);
        expect(compPerms.has(PERMISSIONS.COMPLIANCE_RELEASE)).toBe(true);
        expect(compPerms.has(PERMISSIONS.COMPLIANCE_READ)).toBe(true);
        expect(compPerms.has(PERMISSIONS.COMPLIANCE_WRITE)).toBe(true);
        expect(compPerms.has(PERMISSIONS.PAYMENT_APPROVE)).toBe(false); // NO approval authority
        expect(compPerms.has(PERMISSIONS.PAYMENT_INITIATE)).toBe(false);

        // SYSTEM_ADMIN
        const adminPerms = await rbacService.getOperatorPermissions(opAdmin, { pool });
        expect(adminPerms.has(PERMISSIONS.ADMIN_MANAGE_ROLES)).toBe(true);
        expect(adminPerms.has(PERMISSIONS.ADMIN_MANAGE_OPERATORS)).toBe(true);
        expect(adminPerms.has(PERMISSIONS.SYSTEM_CONFIG)).toBe(true);
        expect(adminPerms.has(PERMISSIONS.PAYMENT_READ)).toBe(false); // Zero financial visibility

        // AUDITOR
        const auditPerms = await rbacService.getOperatorPermissions(opAuditor, { pool });
        expect(auditPerms.has(PERMISSIONS.AUDIT_READ)).toBe(true);
        expect(auditPerms.has(PERMISSIONS.EVIDENCE_READ)).toBe(true);
        expect(auditPerms.has(PERMISSIONS.PAYMENT_READ)).toBe(false);
        expect(auditPerms.has(PERMISSIONS.PAYMENT_INITIATE)).toBe(false);
        expect(auditPerms.has(PERMISSIONS.PAYMENT_APPROVE)).toBe(false);
    });

    test('3. Database enforces Four-Eyes check constraint: chk_maker_checker_distinct', async () => {
        if (!isDbAvailable) return;

        const instRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, purpose, state)
            VALUES (100000, 'INR', 'sender_acc', 'recipient_acc', 'dest_acc_1001', 'VENDOR_PAYOUT', 'INITIATED')
            RETURNING instruction_id;
        `);
        testInstructionId = instRes.rows[0].instruction_id;

        // Attempting to insert maker_operator_id === checker_operator_id
        await expect(
            client.query(
                `INSERT INTO identity.payment_approvals (
                    instruction_id, maker_operator_id, checker_operator_id, status, amount, currency
                 ) VALUES ($1, $2, $2, 'APPROVED', 100000, 'INR')`,
                [testInstructionId, opMaker]
            )
        ).rejects.toThrow(/chk_maker_checker_distinct/);
    });

    test('4. Database enforces Maker Immutability via PostgreSQL triggers', async () => {
        if (!isDbAvailable) return;

        // Submit approval
        await makerCheckerService.requestPaymentApproval({
            instructionId: testInstructionId,
            makerOperatorId: opMaker,
            amount: 250000,
            currency: 'INR',
            pool,
        });

        // Attempting direct SQL update of maker_operator_id on payment_approvals must fail
        await expect(
            client.query(
                `UPDATE identity.payment_approvals
                 SET maker_operator_id = $1
                 WHERE instruction_id = $2`,
                [opChecker, testInstructionId]
            )
        ).rejects.toThrow(/Maker identity is immutable once submitted/);

        // Attempting direct SQL update of maker_operator_id on instructions must fail
        await expect(
            client.query(
                `UPDATE instructions
                 SET maker_operator_id = $1
                 WHERE instruction_id = $2`,
                [opChecker, testInstructionId]
            )
        ).rejects.toThrow(/Instruction maker identity is immutable once assigned/);

        // Attempting to change instruction_id link must fail
        const otherInstRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, purpose, state)
            VALUES (50000, 'USD', 'acc_s', 'acc_r', 'TEST', 'INITIATED')
            RETURNING instruction_id;
        `);
        const otherInstId = otherInstRes.rows[0].instruction_id;

        await expect(
            client.query(
                `UPDATE identity.payment_approvals
                 SET instruction_id = $1
                 WHERE instruction_id = $2`,
                [otherInstId, testInstructionId]
            )
        ).rejects.toThrow(/Approval instruction link is immutable/);
    });

    test('5. Database enforces Append-Only trigger on identity.auth_audit_log', async () => {
        if (!isDbAvailable) return;

        // Ensure at least one audit record exists
        await client.query(`
            INSERT INTO identity.auth_audit_log (event_type, operator_id, metadata)
            VALUES ('TEST_AUDIT_EVENT', $1, '{"test": true}')
        `, [opAdmin]);

        // Attempting SQL UPDATE on audit log must be rejected by trigger
        await expect(
            client.query(
                `UPDATE identity.auth_audit_log
                 SET event_type = 'TAMPERED_EVENT'
                 WHERE operator_id = $1`,
                [opAdmin]
            )
        ).rejects.toThrow(/identity.auth_audit_log is append-only/);

        // Attempting SQL DELETE on audit log must be rejected by trigger
        await expect(
            client.query(
                `DELETE FROM identity.auth_audit_log
                 WHERE operator_id = $1`,
                [opAdmin]
            )
        ).rejects.toThrow(/identity.auth_audit_log is append-only/);
    });

    test('6. Privileged Role Administration: Defends against self-elevation in PostgreSQL', async () => {
        if (!isDbAvailable) return;

        await expect(
            rbacService.assignRoleToOperator({
                operatorId: opAdmin,
                roleKey: 'TREASURY_ANALYST',
                assignedBy: opAdmin, // Self-elevation
                pool,
            })
        ).rejects.toThrow(/Self-elevation prohibited: operators cannot grant roles to themselves/);
    });

    test('7. Compliance Hold Workflow in PostgreSQL: Hold blocks approval, release enables approval', async () => {
        if (!isDbAvailable) return;

        // 1. Compliance officer places hold
        const holdRes = await makerCheckerService.holdPayment({
            instructionId: testInstructionId,
            officerOperatorId: opCompliance,
            reason: 'High-risk recipient flagged during sanctions screening',
            pool,
        });
        expect(holdRes.compliance_held).toBe(true);

        // Verify instructions table synchronized
        const instHold = await client.query('SELECT compliance_held FROM instructions WHERE instruction_id = $1', [testInstructionId]);
        expect(instHold.rows[0].compliance_held).toBe(true);

        // 2. Checker approval must be blocked while hold is active
        await expect(
            makerCheckerService.approvePayment({
                instructionId: testInstructionId,
                checkerOperatorId: opChecker,
                requireStepUp: false,
                pool,
            })
        ).rejects.toThrow(/Payment instruction is under compliance hold and cannot be approved until released/);

        // 3. Compliance officer releases hold
        const releaseRes = await makerCheckerService.releaseHold({
            instructionId: testInstructionId,
            officerOperatorId: opCompliance,
            notes: 'Secondary documentation verified; false positive resolved',
            pool,
        });
        expect(releaseRes.compliance_held).toBe(false);

        // Verify instructions table cleared
        const instClear = await client.query('SELECT compliance_held FROM instructions WHERE instruction_id = $1', [testInstructionId]);
        expect(instClear.rows[0].compliance_held).toBe(false);
    });

    test('8. Real @simplewebauthn/server verification with synthetic credentials in PostgreSQL', async () => {
        if (!isDbAvailable) return;

        const testCredId = `cred_pg_${crypto.randomBytes(8).toString('hex')}`;
        const keyPair = crypto.generateKeyPairSync('ec', {
            namedCurve: 'prime256v1',
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });

        // 1. Generate challenge in DB
        const regCh = await webauthnService.generateChallenge({
            operatorId: opChecker,
            ceremonyType: 'registration',
            pool,
        });

        // 2. Register credential in DB
        const regRes = await webauthnService.registerCredential({
            operatorId: opChecker,
            credentialId: testCredId,
            publicKeyPem: keyPair.publicKey,
            challenge: regCh.challenge,
            pool,
        });
        expect(regRes.success).toBe(true);

        // 3. Challenge marked consumed
        const checkCh = await client.query(
            'SELECT consumed_at FROM identity.webauthn_challenges WHERE challenge = $1',
            [regCh.challenge]
        );
        expect(checkCh.rows[0].consumed_at).not.toBeNull();

        // 4. Generate authentication challenge
        const authCh = await webauthnService.generateChallenge({
            operatorId: opChecker,
            ceremonyType: 'authentication',
            pool,
        });

        // 5. Generate synthetic assertion with User Verification (UV = true)
        const assertion = webauthnService.createSyntheticAssertion({
            credentialId: testCredId,
            privateKey: keyPair.privateKey,
            challenge: authCh.challenge,
            counter: 1,
            userPresent: true,
            userVerified: true,
        });

        // 6. Verify assertion
        const verifyRes = await webauthnService.verifyAuthenticationAssertion({
            operatorId: opChecker,
            credentialId: testCredId,
            assertionResponse: assertion.response,
            pool,
            requireUserVerification: true,
        });
        expect(verifyRes.verified).toBe(true);
        expect(verifyRes.counter).toBe(1);

        // 7. Verify counter updated in PostgreSQL
        const credRow = await client.query(
            'SELECT counter FROM identity.webauthn_credentials WHERE credential_id = $1',
            [testCredId]
        );
        expect(Number(credRow.rows[0].counter)).toBe(1);
    });

    test('9. Atomic Transactional Boundary: WebAuthn failure cleanly rolls back PostgreSQL transaction', async () => {
        if (!isDbAvailable) return;

        // Attempt approval with invalid / forged WebAuthn assertion
        const forgedKeyPair = crypto.generateKeyPairSync('ec', {
            namedCurve: 'prime256v1',
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });

        const authCh = await webauthnService.generateChallenge({
            operatorId: opChecker,
            ceremonyType: 'authentication',
            pool,
        });

        const forgedAssertion = webauthnService.createSyntheticAssertion({
            credentialId: 'non_existent_or_forged',
            privateKey: forgedKeyPair.privateKey,
            challenge: authCh.challenge,
            counter: 2,
        });

        await expect(
            makerCheckerService.approvePayment({
                instructionId: testInstructionId,
                checkerOperatorId: opChecker,
                credentialId: 'non_existent_or_forged',
                webauthnAssertion: forgedAssertion.response,
                requireStepUp: true,
                pool,
            })
        ).rejects.toThrow();

        // Invariant: The instruction and approval must remain PENDING_APPROVAL after rollback
        const appRow = await client.query(
            'SELECT status, checker_operator_id FROM identity.payment_approvals WHERE instruction_id = $1',
            [testInstructionId]
        );
        expect(appRow.rows[0].status).toBe('PENDING_APPROVAL');
        expect(appRow.rows[0].checker_operator_id).toBeNull();

        const instRow = await client.query(
            'SELECT state, approval_status, checker_operator_id FROM instructions WHERE instruction_id = $1',
            [testInstructionId]
        );
        expect(instRow.rows[0].state).toBe('PENDING_APPROVAL');
        expect(instRow.rows[0].approval_status).toBe('PENDING_APPROVAL');
        expect(instRow.rows[0].checker_operator_id).toBeNull();
    });

    test('10. Independent Treasury Checker approves payment instruction with valid step-up in PostgreSQL', async () => {
        if (!isDbAvailable) return;

        const testCredId = `cred_pg_cfo_${crypto.randomBytes(6).toString('hex')}`;
        const keyPair = crypto.generateKeyPairSync('ec', {
            namedCurve: 'prime256v1',
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });

        // Register credential for opChecker
        const regCh = await webauthnService.generateChallenge({
            operatorId: opChecker,
            ceremonyType: 'registration',
            pool,
        });
        await webauthnService.registerCredential({
            operatorId: opChecker,
            credentialId: testCredId,
            publicKeyPem: keyPair.publicKey,
            challenge: regCh.challenge,
            pool,
        });

        // Generate challenge for approval
        const authCh = await webauthnService.generateChallenge({
            operatorId: opChecker,
            ceremonyType: 'authentication',
            pool,
        });

        const assertion = webauthnService.createSyntheticAssertion({
            credentialId: testCredId,
            privateKey: keyPair.privateKey,
            challenge: authCh.challenge,
            counter: 5,
            userVerified: true,
        });

        // Execute approval
        const approved = await makerCheckerService.approvePayment({
            instructionId: testInstructionId,
            checkerOperatorId: opChecker,
            credentialId: testCredId,
            webauthnAssertion: assertion.response,
            notes: 'Verified by Treasury Lead against bank statements',
            requireStepUp: true,
            pool,
        });

        expect(approved.status).toBe(APPROVAL_STATUS.APPROVED);
        expect(approved.checker_operator_id).toBe(opChecker);
        expect(approved.step_up_method).toBe('webauthn');

        // Verify database state
        const instApprovedRow = await client.query(
            'SELECT state, approval_status, checker_operator_id FROM instructions WHERE instruction_id = $1',
            [testInstructionId]
        );
        expect(instApprovedRow.rows[0].approval_status).toBe('APPROVED');
        expect(instApprovedRow.rows[0].checker_operator_id).toBe(opChecker);
    });

    test('11. Terminal state protection: Cannot modify or re-approve an already approved instruction', async () => {
        if (!isDbAvailable) return;

        // Attempting to approve again
        await expect(
            makerCheckerService.approvePayment({
                instructionId: testInstructionId,
                checkerOperatorId: opChecker,
                requireStepUp: false,
                pool,
            })
        ).rejects.toThrow(/Cannot approve instruction in status "APPROVED"/);

        // Attempting direct SQL update of terminal status must be rejected by immutability trigger
        await expect(
            client.query(
                `UPDATE identity.payment_approvals
                 SET status = 'PENDING_APPROVAL'
                 WHERE instruction_id = $1`,
                [testInstructionId]
            )
        ).rejects.toThrow(/Cannot modify approval in terminal state APPROVED/);
    });

    test('12. Rejection workflow in PostgreSQL marks status REJECTED and records reason', async () => {
        if (!isDbAvailable) return;

        const instRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, purpose, state)
            VALUES (75000, 'USD', 'sender_acc_2', 'recipient_acc_2', 'CONSULTING_FEE', 'INITIATED')
            RETURNING instruction_id;
        `);
        const rejectInstId = instRes.rows[0].instruction_id;

        await makerCheckerService.requestPaymentApproval({
            instructionId: rejectInstId,
            makerOperatorId: opMaker,
            amount: 75000,
            currency: 'USD',
            pool,
        });

        const rejected = await makerCheckerService.rejectPayment({
            instructionId: rejectInstId,
            checkerOperatorId: opChecker,
            rejectionReason: 'Suspicious vendor tax ID',
            pool,
        });

        expect(rejected.status).toBe(APPROVAL_STATUS.REJECTED);
        expect(rejected.rejection_reason).toBe('Suspicious vendor tax ID');

        const instRow = await client.query(
            'SELECT state, approval_status FROM instructions WHERE instruction_id = $1',
            [rejectInstId]
        );
        expect(instRow.rows[0].approval_status).toBe('REJECTED');
    });

    test('13. Audit events recorded in identity.auth_audit_log', async () => {
        if (!isDbAvailable) return;

        const auditRes = await client.query(`
            SELECT event_type, operator_id, metadata 
            FROM identity.auth_audit_log 
            ORDER BY created_at DESC 
            LIMIT 15;
        `);

        expect(auditRes.rows.length).toBeGreaterThan(0);
        const eventTypes = auditRes.rows.map((r) => r.event_type);

        expect(eventTypes).toContain('PAYMENT_APPROVAL_REQUESTED');
        expect(eventTypes).toContain('PAYMENT_APPROVED');
        expect(eventTypes).toContain('PAYMENT_REJECTED');
        expect(eventTypes).toContain('COMPLIANCE_HOLD_PLACED');
        expect(eventTypes).toContain('COMPLIANCE_HOLD_RELEASED');
    });

    test('14. Statement-level BEFORE TRUNCATE trigger blocks TRUNCATE on identity.auth_audit_log', async () => {
        if (!isDbAvailable) return;

        await expect(
            client.query('TRUNCATE TABLE identity.auth_audit_log')
        ).rejects.toThrow(/identity.auth_audit_log cannot be truncated. Audit trail is strictly immutable/);
    });

    test('15. Verifies dedicated audit table owner and role privileges on identity.auth_audit_log', async () => {
        if (!isDbAvailable) return;

        // Verify table owner is fusion_audit_owner
        const ownerRes = await client.query(`
            SELECT tableowner 
            FROM pg_tables 
            WHERE schemaname = 'identity' AND tablename = 'auth_audit_log';
        `);
        expect(ownerRes.rows[0].tableowner).toBe('fusion_audit_owner');

        // Verify role existence in pg_roles
        const rolesRes = await client.query(`
            SELECT rolname FROM pg_roles 
            WHERE rolname IN ('fusion_audit_owner', 'fusion_app_runtime', 'fusion_auditor');
        `);
        const roles = rolesRes.rows.map((r) => r.rolname);
        expect(roles).toContain('fusion_audit_owner');
        expect(roles).toContain('fusion_app_runtime');
        expect(roles).toContain('fusion_auditor');
    });

    test('16. Database trigger trg_instructions_material_freeze blocks modifying material details in PENDING_APPROVAL without version increment & cancellation', async () => {
        if (!isDbAvailable) return;

        const instRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, provider, purpose, state, approval_status, version)
            VALUES (200000, 'INR', 'sender_freeze', 'recipient_freeze', 'acc_freeze_01', 'RAZORPAYX_TEST', 'VENDOR_PAYOUT', 'PENDING_APPROVAL', 'PENDING_APPROVAL', 1)
            RETURNING instruction_id;
        `);
        const freezeInstId = instRes.rows[0].instruction_id;

        // Direct SQL modification of amount while in PENDING_APPROVAL must be rejected by trigger
        await expect(
            client.query(
                `UPDATE instructions
                 SET amount = 300000
                 WHERE instruction_id = $1`,
                [freezeInstId]
            )
        ).rejects.toThrow(/Material payment fields.*cannot be altered while in PENDING_APPROVAL or APPROVED without version increment and approval cancellation/);

        // Modification of recipient must also be rejected
        await expect(
            client.query(
                `UPDATE instructions
                 SET recipient = 'hacked_recipient'
                 WHERE instruction_id = $1`,
                [freezeInstId]
            )
        ).rejects.toThrow(/Material payment fields.*cannot be altered/);

        // Updating with version increment and cancelled status succeeds
        const updateRes = await client.query(
            `UPDATE instructions
             SET version = version + 1,
                 amount = 250000,
                 approval_status = 'CANCELLED',
                 state = 'INITIATED'
             WHERE instruction_id = $1
             RETURNING *`,
            [freezeInstId]
        );
        expect(updateRes.rows[0].version).toBe(2);
        expect(Number(updateRes.rows[0].amount)).toBe(250000);
        expect(updateRes.rows[0].approval_status).toBe('CANCELLED');
    });

    test('17. Database check constraint chk_dual_control_distinct_operators rejects self-approval of role change requests', async () => {
        if (!isDbAvailable) return;

        // Attempting to insert role change request where requester == approver must violate constraint
        await expect(
            client.query(`
                INSERT INTO identity.role_change_requests (
                    requesting_operator_id, target_operator_id, role_key, action, reason, status, approving_operator_id
                ) VALUES ($1, $2, 'TREASURY_ANALYST', 'ASSIGN', 'Self-approval test', 'APPROVED', $1)
            `, [opAdmin, opMaker])
        ).rejects.toThrow(/chk_dual_control_distinct_operators/);
    });

    test('18. Dual Control role change workflow in PostgreSQL enforces independent approval and logs audit', async () => {
        if (!isDbAvailable) return;

        // Provision a secondary SYSTEM_ADMIN operator in database
        const secondaryAdminId = '00000000-0000-4000-8000-000000000088';
        await client.query(`
            INSERT INTO identity.operators (operator_id, email, full_name, is_active)
            VALUES ($1, 'sec-admin@fusion.internal', 'Secondary Admin', TRUE)
            ON CONFLICT (operator_id) DO NOTHING;
        `, [secondaryAdminId]);

        const adminRoleRes = await client.query("SELECT role_id FROM identity.roles WHERE role_key = 'SYSTEM_ADMIN'");
        const adminRoleId = adminRoleRes.rows[0].role_id;

        await client.query(`
            INSERT INTO identity.operator_role_assignments (operator_id, role_id, is_active)
            VALUES ($1, $2, TRUE)
            ON CONFLICT (operator_id, role_id) DO UPDATE SET is_active = TRUE;
        `, [secondaryAdminId, adminRoleId]);

        // 1. opAdmin requests role change for opAuditor to become COMPLIANCE_OFFICER
        const req = await rbacService.requestRoleChange({
            requestingOperatorId: opAdmin,
            targetOperatorId: opAuditor,
            roleKey: ROLES.COMPLIANCE_OFFICER,
            action: 'ASSIGN',
            reason: 'Audit to Compliance rotation',
            pool,
        });

        expect(req.request_id).toBeDefined();
        expect(req.status).toBe('PENDING');

        // 2. opAdmin attempting to approve own request fails
        await expect(
            rbacService.approveRoleChange({
                requestId: req.request_id,
                approvingOperatorId: opAdmin,
                pool,
            })
        ).rejects.toThrow(/Dual control violation: An operator cannot approve their own role change request/);

        // 3. Independent secondary admin approves request
        const approved = await rbacService.approveRoleChange({
            requestId: req.request_id,
            approvingOperatorId: secondaryAdminId,
            pool,
        });

        expect(approved.status).toBe('APPROVED');
        expect(approved.approving_operator_id).toBe(secondaryAdminId);

        // 4. Verify role is active in database
        const perms = await rbacService.getOperatorPermissions(opAuditor, { pool });
        expect(perms.has(PERMISSIONS.COMPLIANCE_HOLD)).toBe(true);
        expect(perms.has(PERMISSIONS.COMPLIANCE_RELEASE)).toBe(true);

        // Clean up test role assignment to restore opAuditor baseline
        await client.query(`
            DELETE FROM identity.operator_role_assignments 
            WHERE operator_id = $1 AND role_id = (SELECT role_id FROM identity.roles WHERE role_key = 'COMPLIANCE_OFFICER')
        `, [opAuditor]);
    });

    test('19. WebAuthn Payment Context Binding verified in PostgreSQL', async () => {
        if (!isDbAvailable) return;

        const instRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, provider, environment, purpose, state, version)
            VALUES (150000, 'USD', 'corp_treasury', 'vendor_cross_border', 'acc_usd_cb_99', 'STRIPE_TEST', 'sandbox', 'SOFTWARE_LICENSE', 'INITIATED', 1)
            RETURNING instruction_id;
        `);
        const ctxInstId = instRes.rows[0].instruction_id;

        await makerCheckerService.requestPaymentApproval({
            instructionId: ctxInstId,
            makerOperatorId: opMaker,
            amount: 150000,
            currency: 'USD',
            pool,
        });

        // Register FIDO2 credential for opChecker
        const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const credId = `cred_pg_ctx_${Date.now()}`;
        const regChallenge = await webauthnService.generateChallenge({
            operatorId: opChecker,
            ceremonyType: 'registration',
            pool,
        });
        await webauthnService.registerCredential({
            operatorId: opChecker,
            credentialId: credId,
            publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }),
            challenge: regChallenge.challenge,
            pool,
        });

        // Generate challenge bound to payment context
        const details = await makerCheckerService.getApprovalDetails({ instructionId: ctxInstId, pool });
        const paymentContext = {
            approvalId: details.approval_id,
            instructionId: ctxInstId,
            version: 1,
            amount: '150000.00',
            currency: 'USD',
            beneficiary: details.recipient,
            destination_account: details.destination_account,
            provider: details.provider,
            environment: details.environment,
            action: 'APPROVE',
            checkerOperatorId: opChecker,
        };

        const challengeData = await webauthnService.generateChallenge({
            operatorId: opChecker,
            ceremonyType: 'authentication',
            paymentContext,
            pool,
        });

        expect(challengeData.contextDigest).toBeDefined();

        // Synthetic assertion with matching context
        const assertion = webauthnService.createSyntheticAssertion({
            credentialId: credId,
            privateKey: keyPair.privateKey,
            challenge: challengeData.challenge,
            counter: 1,
            userVerified: true,
        });

        const approved = await makerCheckerService.approvePayment({
            instructionId: ctxInstId,
            checkerOperatorId: opChecker,
            webauthnAssertion: assertion,
            credentialId: credId,
            requireStepUp: true,
            pool,
        });

        expect(approved.status).toBe(APPROVAL_STATUS.APPROVED);
        expect(approved.context_digest).toBe(challengeData.contextDigest);
    });

    test('20. Concurrent compliance hold and approval race serialization via SELECT ... FOR UPDATE', async () => {
        if (!isDbAvailable) return;

        const instRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, purpose, state)
            VALUES (80000, 'INR', 'race_sender', 'race_recipient', 'dest_race_001', 'INVOICE_SETTLEMENT', 'INITIATED')
            RETURNING instruction_id;
        `);
        const raceInstId = instRes.rows[0].instruction_id;

        await makerCheckerService.requestPaymentApproval({
            instructionId: raceInstId,
            makerOperatorId: opMaker,
            amount: 80000,
            currency: 'INR',
            pool,
        });

        // Place compliance hold
        await makerCheckerService.holdPayment({
            instructionId: raceInstId,
            officerOperatorId: opCompliance,
            reason: 'Concurrent sanctions screening check',
            pool,
        });

        // Attempting approval during hold must be blocked with COMPLIANCE_HOLD_ACTIVE
        await expect(
            makerCheckerService.approvePayment({
                instructionId: raceInstId,
                checkerOperatorId: opChecker,
                requireStepUp: false,
                pool,
            })
        ).rejects.toThrow(/Payment instruction is under compliance hold and cannot be approved until released/);

        // Release compliance hold
        await makerCheckerService.releaseHold({
            instructionId: raceInstId,
            officerOperatorId: opCompliance,
            notes: 'Screening passed cleanly',
            pool,
        });

        // Now approval succeeds
        const approved = await makerCheckerService.approvePayment({
            instructionId: raceInstId,
            checkerOperatorId: opChecker,
            requireStepUp: false,
            pool,
        });

        expect(approved.status).toBe(APPROVAL_STATUS.APPROVED);
    });

    test('21. DB Check Constraint chk_dual_control_target_distinct blocks target operator self-approval via direct SQL', async () => {
        if (!isDbAvailable) return;

        // Create a role change request: opAdmin requests role for opAuditor
        const reqRes = await client.query(`
            INSERT INTO identity.role_change_requests (requesting_operator_id, target_operator_id, role_key, action, reason, status)
            VALUES ($1, $2, 'TREASURY_ANALYST', 'ASSIGN', 'DB dual control test', 'PENDING')
            RETURNING request_id;
        `, [opAdmin, opAuditor]);
        const reqId = reqRes.rows[0].request_id;

        // Attempting direct SQL update setting approving_operator_id = target_operator_id must violate check constraint
        await expect(
            client.query(`
                UPDATE identity.role_change_requests
                SET approving_operator_id = $1, status = 'APPROVED', decided_at = NOW()
                WHERE request_id = $2
            `, [opAuditor, reqId])
        ).rejects.toThrow(/chk_dual_control_target_distinct/);

        // Finding 3: Role change governance records cannot be deleted
        await expect(
            client.query(`DELETE FROM identity.role_change_requests WHERE request_id = $1`, [reqId])
        ).rejects.toThrow(/Deletion of role change governance records is strictly prohibited/);
    });

    test('22. Hardened DB trigger trg_instructions_material_freeze strictly prevents modifying APPROVED instructions', async () => {
        if (!isDbAvailable) return;

        // Insert and approve an instruction
        const instRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, provider, environment, purpose, state, approval_status, version)
            VALUES (200000, 'USD', 'corp_client', 'vendor_frozen', 'acc_frozen_001', 'STRIPE_TEST', 'sandbox', 'ANNUAL_SUBSCRIPTION', 'APPROVED', 'APPROVED', 1)
            RETURNING instruction_id;
        `);
        const frozenInstId = instRes.rows[0].instruction_id;

        // Attempt 1: Direct SQL update altering amount (even with version increment)
        await expect(
            client.query(`
                UPDATE instructions
                SET amount = 300000, version = 2
                WHERE instruction_id = $1
            `, [frozenInstId])
        ).rejects.toThrow(/Approved payment instructions are strictly immutable/);

        // Attempt 2: Direct SQL update attempting to revert state to INITIATED
        await expect(
            client.query(`
                UPDATE instructions
                SET state = 'INITIATED', approval_status = 'CANCELLED'
                WHERE instruction_id = $1
            `, [frozenInstId])
        ).rejects.toThrow(/Illegal state transition from APPROVED to INITIATED|Approved payment instruction cannot be returned to/);

        // Attempt 3: Altering destination_account
        await expect(
            client.query(`
                UPDATE instructions
                SET destination_account = 'acc_hacked_iban_999'
                WHERE instruction_id = $1
            `, [frozenInstId])
        ).rejects.toThrow(/Approved payment instructions are strictly immutable/);

        // Verify material terms in PostgreSQL remain completely untouched
        const checkRes = await client.query(`SELECT amount, currency, destination_account, state, approval_status, version FROM instructions WHERE instruction_id = $1`, [frozenInstId]);
        const row = checkRes.rows[0];
        expect(Number(row.amount)).toBe(200000);
        expect(row.destination_account).toBe('acc_frozen_001');
        expect(row.state).toBe('APPROVED');
        expect(row.approval_status).toBe('APPROVED');
        expect(row.version).toBe(1);

        // Finding 3: Approved instructions cannot be deleted
        await expect(
            client.query(`DELETE FROM instructions WHERE instruction_id = $1`, [frozenInstId])
        ).rejects.toThrow(/Deletion of financial history is strictly prohibited/);
    });

    test('23. PostgreSQL Void Workflow: Approved instruction can be explicitly transitioned to VOIDED preserving audit trail', async () => {
        if (!isDbAvailable) return;

        const instRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, provider, environment, purpose, state, approval_status, version)
            VALUES (95000, 'INR', 'corp_client', 'vendor_void_test', 'acc_void_001', 'RAZORPAYX_TEST', 'sandbox', 'VENDOR_RETAINER', 'PENDING_APPROVAL', 'PENDING_APPROVAL', 1)
            RETURNING instruction_id;
        `);
        const voidInstId = instRes.rows[0].instruction_id;

        await makerCheckerService.requestPaymentApproval({
            instructionId: voidInstId,
            makerOperatorId: opMaker,
            amount: 95000,
            currency: 'INR',
            pool,
        });

        // Approve instruction
        await makerCheckerService.approvePayment({
            instructionId: voidInstId,
            checkerOperatorId: opChecker,
            requireStepUp: false,
            pool,
        });

        // Step 1: Request void (Dual Control - Maker/Ops Operator requests void)
        const voidReq = await makerCheckerService.requestPaymentVoid({
            instructionId: voidInstId,
            requesterOperatorId: opMaker,
            reason: 'Invoice retracted by counterparty prior to execution',
            pool,
        });
        expect(voidReq.status).toBe('PENDING');

        // Step 2: Approve void (Dual Control - Independent Treasury Analyst approves void)
        const voidRes = await makerCheckerService.approvePaymentVoid({
            instructionId: voidInstId,
            voidRequestId: voidReq.voidRequestId,
            approverOperatorId: opChecker,
            requireStepUp: false,
            pool,
        });

        expect(voidRes.state).toBe('VOIDED');
        expect(voidRes.approval_status).toBe('VOIDED');
        expect(voidRes.requesterOperatorId).toBe(opMaker);
        expect(voidRes.approverOperatorId).toBe(opChecker);

        // Check DB row
        const rowRes = await client.query(`SELECT state, approval_status, amount, destination_account FROM instructions WHERE instruction_id = $1`, [voidInstId]);
        const dbRow = rowRes.rows[0];
        expect(dbRow.state).toBe('VOIDED');
        expect(dbRow.approval_status).toBe('VOIDED');
        expect(Number(dbRow.amount)).toBe(95000);
        expect(dbRow.destination_account).toBe('acc_void_001');

        // Check payment_approvals status
        const appRes = await client.query(`SELECT status, rejection_reason, checker_operator_id FROM identity.payment_approvals WHERE instruction_id = $1`, [voidInstId]);
        expect(appRes.rows[0].status).toBe('VOIDED');
        expect(appRes.rows[0].rejection_reason).toBe('Invoice retracted by counterparty prior to execution');
        expect(appRes.rows[0].checker_operator_id).toBe(opChecker);

        // Check payment_void_requests table
        const vrRes = await client.query(`SELECT * FROM identity.payment_void_requests WHERE instruction_id = $1`, [voidInstId]);
        expect(vrRes.rows.length).toBe(1);
        expect(vrRes.rows[0].status).toBe('APPROVED');
        expect(vrRes.rows[0].requester_operator_id).toBe(opMaker);
        expect(vrRes.rows[0].approver_operator_id).toBe(opChecker);

        // Finding 3: Payment void requests and voided instructions cannot be deleted
        await expect(
            client.query(`DELETE FROM identity.payment_void_requests WHERE instruction_id = $1`, [voidInstId])
        ).rejects.toThrow(/Deletion of payment void requests is strictly prohibited/);

        await expect(
            client.query(`DELETE FROM identity.payment_approvals WHERE instruction_id = $1`, [voidInstId])
        ).rejects.toThrow(/Deletion of payment approval records is strictly prohibited/);

        await expect(
            client.query(`DELETE FROM instructions WHERE instruction_id = $1`, [voidInstId])
        ).rejects.toThrow(/Deletion of financial history is strictly prohibited/);
    });

    test('24. PostgreSQL Check Constraint & Trigger: payment_void_requests rejects self-approval directly in SQL', async () => {
        if (!isDbAvailable) return;

        const instRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, provider, environment, purpose, state, approval_status, version)
            VALUES (50000, 'INR', 'corp_client', 'vendor_dual_void', 'acc_void_002', 'RAZORPAYX_TEST', 'sandbox', 'VENDOR_RETAINER', 'APPROVED', 'APPROVED', 1)
            RETURNING instruction_id;
        `);
        const instId = instRes.rows[0].instruction_id;

        // Inserting void request with requester == approver violates check constraint chk_dual_control_void_distinct
        await expect(
            client.query(`
                INSERT INTO identity.payment_void_requests (
                    instruction_id, requester_operator_id, approver_operator_id, reason, status, instruction_version
                ) VALUES ($1, $2, $2, 'Self-approval void attempt', 'APPROVED', 1)
            `, [instId, opChecker])
        ).rejects.toThrow(/chk_dual_control_void_distinct|check constraint/i);

        // Inserting valid pending request, then attempting SQL update to self-approve
        const vrRes = await client.query(`
            INSERT INTO identity.payment_void_requests (
                instruction_id, requester_operator_id, reason, status, instruction_version
            ) VALUES ($1, $2, 'Valid pending void', 'PENDING', 1)
            RETURNING void_request_id;
        `, [instId, opChecker]);
        const vrId = vrRes.rows[0].void_request_id;

        // Updating approver to match requester triggers chk_dual_control_void_distinct
        await expect(
            client.query(`
                UPDATE identity.payment_void_requests
                SET approver_operator_id = $1, status = 'APPROVED'
                WHERE void_request_id = $2
            `, [opChecker, vrId])
        ).rejects.toThrow(/chk_dual_control_void_distinct|Dual control violation/i);

        // Finding 3: Payment void requests cannot be deleted
        await expect(
            client.query(`DELETE FROM identity.payment_void_requests WHERE instruction_id = $1`, [instId])
        ).rejects.toThrow(/Deletion of payment void requests is strictly prohibited/);
    });

    test('25. PostgreSQL Terminal State Protection (Finding 3): Every prohibited transition and mutation from VOIDED is rejected directly in SQL', async () => {
        if (!isDbAvailable) return;

        // Create an instruction in VOIDED state
        const instRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, provider, environment, purpose, state, approval_status, version)
            VALUES (75000, 'USD', 'corp_treasury', 'vendor_terminal_test', 'acc_term_001', 'STRIPE_TEST', 'sandbox', 'OPERATING_EXPENSE', 'VOIDED', 'VOIDED', 1)
            RETURNING instruction_id;
        `);
        const voidedInstId = instRes.rows[0].instruction_id;

        // 1. Prohibit returning to APPROVED
        await expect(
            client.query(`UPDATE instructions SET state = 'APPROVED', approval_status = 'APPROVED' WHERE instruction_id = $1`, [voidedInstId])
        ).rejects.toThrow(/is in terminal state VOIDED and cannot be modified or transitioned/);

        // 2. Prohibit returning to INITIATED
        await expect(
            client.query(`UPDATE instructions SET state = 'INITIATED', approval_status = 'CANCELLED' WHERE instruction_id = $1`, [voidedInstId])
        ).rejects.toThrow(/is in terminal state VOIDED and cannot be modified or transitioned/);

        // 3. Prohibit returning to PENDING_APPROVAL
        await expect(
            client.query(`UPDATE instructions SET state = 'PENDING_APPROVAL', approval_status = 'PENDING_APPROVAL' WHERE instruction_id = $1`, [voidedInstId])
        ).rejects.toThrow(/is in terminal state VOIDED and cannot be modified or transitioned/);

        // 4. Prohibit moving to EXECUTED / SETTLED
        await expect(
            client.query(`UPDATE instructions SET state = 'SETTLED' WHERE instruction_id = $1`, [voidedInstId])
        ).rejects.toThrow(/is in terminal state VOIDED and cannot be modified or transitioned/);

        // 5. Prohibit moving to LOCKED
        await expect(
            client.query(`UPDATE instructions SET state = 'LOCKED' WHERE instruction_id = $1`, [voidedInstId])
        ).rejects.toThrow(/is in terminal state VOIDED and cannot be modified or transitioned/);

        // 6. Prohibit moving to FAILED
        await expect(
            client.query(`UPDATE instructions SET state = 'FAILED' WHERE instruction_id = $1`, [voidedInstId])
        ).rejects.toThrow(/is in terminal state VOIDED and cannot be modified or transitioned/);

        // 7. Prohibit altering material terms (amount, destination_account, recipient)
        await expect(
            client.query(`UPDATE instructions SET amount = 999999 WHERE instruction_id = $1`, [voidedInstId])
        ).rejects.toThrow(/is in terminal state VOIDED and cannot be modified or transitioned/);

        await expect(
            client.query(`UPDATE instructions SET destination_account = 'acc_tampered' WHERE instruction_id = $1`, [voidedInstId])
        ).rejects.toThrow(/is in terminal state VOIDED and cannot be modified or transitioned/);

        // Finding 3 Verification: Attempting to delete VOIDED instruction directly in SQL is blocked
        await expect(
            client.query(`DELETE FROM instructions WHERE instruction_id = $1`, [voidedInstId])
        ).rejects.toThrow(/Deletion of financial history is strictly prohibited/);
    });

    test('26. PostgreSQL Approval Protection (Finding 3): Prohibit creating or modifying approvals for VOIDED instructions', async () => {
        if (!isDbAvailable) return;

        // Create an instruction in VOIDED state
        const instRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, provider, environment, purpose, state, approval_status, version)
            VALUES (25000, 'USD', 'corp_treasury', 'vendor_app_void_test', 'acc_term_002', 'STRIPE_TEST', 'sandbox', 'OPERATING_EXPENSE', 'VOIDED', 'VOIDED', 1)
            RETURNING instruction_id;
        `);
        const voidedInstId = instRes.rows[0].instruction_id;

        // 1. Prohibit inserting a new approval for a VOIDED instruction (prevents reuse of voided instructions)
        await expect(
            client.query(`
                INSERT INTO identity.payment_approvals (
                    instruction_id, maker_operator_id, status, amount, currency, instruction_version
                ) VALUES ($1, $2, 'PENDING_APPROVAL', 25000, 'USD', 1)
            `, [voidedInstId, opMaker])
        ).rejects.toThrow(/Cannot create approval for VOIDED instruction/);

        // 2. Insert valid approval on non-voided instruction, transition to VOIDED, then attempt modifying VOIDED approval
        const activeInstRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, provider, environment, purpose, state, approval_status, version)
            VALUES (30000, 'USD', 'corp_treasury', 'vendor_app_mod_test', 'acc_term_003', 'STRIPE_TEST', 'sandbox', 'OPERATING_EXPENSE', 'PENDING_APPROVAL', 'PENDING_APPROVAL', 1)
            RETURNING instruction_id;
        `);
        const activeInstId = activeInstRes.rows[0].instruction_id;

        const appRes = await client.query(`
            INSERT INTO identity.payment_approvals (
                instruction_id, maker_operator_id, status, amount, currency, instruction_version
            ) VALUES ($1, $2, 'PENDING_APPROVAL', 30000, 'USD', 1)
            RETURNING approval_id;
        `, [activeInstId, opMaker]);
        const appRowId = appRes.rows[0].approval_id;

        // Transition approval to VOIDED
        await client.query('SET ROLE fusion_workflow_definer');
        await client.query(`UPDATE identity.payment_approvals SET status = 'VOIDED' WHERE approval_id = $1`, [appRowId]);
        await client.query('RESET ROLE');

        // Attempting to modify terminal VOIDED approval is rejected
        await expect(
            client.query(`UPDATE identity.payment_approvals SET status = 'APPROVED' WHERE approval_id = $1`, [appRowId])
        ).rejects.toThrow(/is in terminal state VOIDED and cannot be modified|Direct update of payment_approvals to APPROVED is prohibited/);

        await expect(
            client.query(`UPDATE identity.payment_approvals SET approval_notes = 'Tampered notes' WHERE approval_id = $1`, [appRowId])
        ).rejects.toThrow(/is in terminal state VOIDED and cannot be modified/);

        // Finding 3 Verification: Attempting to delete financial approval records or voided instructions is blocked
        await expect(
            client.query(`DELETE FROM identity.payment_approvals WHERE instruction_id = $1`, [activeInstId])
        ).rejects.toThrow(/Deletion of payment approval records is strictly prohibited/);

        await expect(
            client.query(`DELETE FROM instructions WHERE instruction_id = $1`, [voidedInstId])
        ).rejects.toThrow(/Deletion of financial history is strictly prohibited/);
    });

    test('27. PostgreSQL Void-Request Lifecycle Enforcement (Finding 2): Terminal states, evidence validation, and challenge uniqueness', async () => {
        if (!isDbAvailable) return;

        // 1. Create a payment instruction in APPROVED state
        const instRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, provider, environment, purpose, state, approval_status, version)
            VALUES (85000, 'USD', 'corp_treasury', 'vendor_lifecycle_test', 'acc_lifecycle_001', 'STRIPE_TEST', 'sandbox', 'VENDOR_SETTLEMENT', 'APPROVED', 'APPROVED', 1)
            RETURNING instruction_id;
        `);
        const instructionId = instRes.rows[0].instruction_id;

        // 2. Insert a valid PENDING void request
        const vrRes = await client.query(`
            INSERT INTO identity.payment_void_requests (
                instruction_id, instruction_version, requester_operator_id, reason, status
            ) VALUES ($1, 1, $2, 'Operational duplicate payment detected', 'PENDING')
            RETURNING void_request_id;
        `, [instructionId, opMaker]);
        const voidRequestId = vrRes.rows[0].void_request_id;

        // 3. Create WebAuthn challenge for step-up binding
        const randChallenge = 'mock_fido2_challenge_' + crypto.randomUUID();
        const chRes = await client.query(`
            INSERT INTO identity.webauthn_challenges (
                operator_id, ceremony_type, challenge, context_digest, instruction_id, expires_at
            ) VALUES ($1, 'authentication', $2, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', $3, NOW() + INTERVAL '5 minutes')
            RETURNING challenge_id;
        `, [opChecker, randChallenge, instructionId]);
        const challengeId = chRes.rows[0].challenge_id;

        // 4. Adversarial Check A: Direct UPDATE to APPROVED without approver_operator_id must fail
        await expect(
            client.query(`
                UPDATE identity.payment_void_requests 
                SET status = 'APPROVED' 
                WHERE void_request_id = $1
            `, [voidRequestId])
        ).rejects.toThrow(/approver_operator_id is required|is prohibited/);

        // 5. Adversarial Check B: Direct UPDATE to APPROVED without valid context_digest must fail
        await expect(
            client.query(`
                UPDATE identity.payment_void_requests 
                SET status = 'APPROVED', approver_operator_id = $2, decided_at = NOW(), challenge_id = $3
                WHERE void_request_id = $1
            `, [voidRequestId, opChecker, challengeId])
        ).rejects.toThrow(/context_digest is required|is prohibited/);

        // 6. Adversarial Check C: Direct UPDATE to APPROVED without challenge_id must fail
        await expect(
            client.query(`
                UPDATE identity.payment_void_requests 
                SET status = 'APPROVED', approver_operator_id = $2, decided_at = NOW(),
                    context_digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
                WHERE void_request_id = $1
            `, [voidRequestId, opChecker])
        ).rejects.toThrow(/challenge_id is required|is prohibited/);

        // 7. Legitimate approval via atomic stored procedure identity.fn_approve_payment_void()
        const digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

        // 7A. Adversarial Check: Calling fn_approve_payment_void with an unverified challenge is strictly rejected
        await expect(
            client.query(`
                SELECT identity.fn_approve_payment_void($1, $2, $3, $4, $5) AS result;
            `, [voidRequestId, instructionId, opChecker, challengeId, digest])
        ).rejects.toThrow(/Cryptographically verified WebAuthn assertion for challenge .* not found/);

        // 7B. Record cryptographically verified WebAuthn assertion evidence
        await client.query(`
            INSERT INTO identity.webauthn_credentials (credential_id, operator_id, public_key, counter)
            VALUES ('cred_pg_ctx_001', $1, 'dummy_pub_key', 1)
            ON CONFLICT (credential_id) DO NOTHING;
        `, [opChecker]);

        const dummySigHash = crypto.createHash('sha256').update('synthetic_test_signature_data_' + challengeId).digest('hex');
        await client.query(`
            SELECT identity.fn_record_verified_webauthn_assertion($1, $2, $3, $4, $5);
        `, [challengeId, opChecker, 'cred_pg_ctx_001', dummySigHash, digest]);

        // 7C. Now legitimate approval via atomic stored procedure identity.fn_approve_payment_void() succeeds
        const approveProcRes = await client.query(`
            SELECT identity.fn_approve_payment_void($1, $2, $3, $4, $5) AS result;
        `, [voidRequestId, instructionId, opChecker, challengeId, digest]);
        expect(approveProcRes.rows[0].result.status).toBe('APPROVED');

        // Verify status in DB
        const verifiedVr = await client.query(`SELECT status FROM identity.payment_void_requests WHERE void_request_id = $1`, [voidRequestId]);
        expect(verifiedVr.rows[0].status).toBe('APPROVED');

        const verifiedInst = await client.query(`SELECT state, approval_status FROM instructions WHERE instruction_id = $1`, [instructionId]);
        expect(verifiedInst.rows[0].state).toBe('VOIDED');
        expect(verifiedInst.rows[0].approval_status).toBe('VOIDED');

        // 8. Adversarial Check D: Prohibit modifying approver_operator_id, reason, or context_digest on APPROVED void request
        await expect(
            client.query(`UPDATE identity.payment_void_requests SET reason = 'Tampered reason' WHERE void_request_id = $1`, [voidRequestId])
        ).rejects.toThrow(/strictly immutable/);

        // Immutability defense with distinct operator (opAdmin !== opMaker): blocked by immutability trigger
        await expect(
            client.query(`UPDATE identity.payment_void_requests SET approver_operator_id = $2 WHERE void_request_id = $1`, [voidRequestId, opAdmin])
        ).rejects.toThrow(/strictly immutable/);

        // Dual-control defense with same operator (opMaker === requester): blocked by chk_dual_control_void_distinct
        await expect(
            client.query(`UPDATE identity.payment_void_requests SET approver_operator_id = $2 WHERE void_request_id = $1`, [voidRequestId, opMaker])
        ).rejects.toThrow(/chk_dual_control_void_distinct/);

        await expect(
            client.query(`UPDATE identity.payment_void_requests SET context_digest = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' WHERE void_request_id = $1`, [voidRequestId])
        ).rejects.toThrow(/strictly immutable/);

        // 9. Adversarial Check E: Prohibit transition from APPROVED -> REJECTED
        await expect(
            client.query(`UPDATE identity.payment_void_requests SET status = 'REJECTED' WHERE void_request_id = $1`, [voidRequestId])
        ).rejects.toThrow(/strictly immutable/);

        // 10. Adversarial Check F: Challenge reuse / replay attack must fail via unique constraint uq_void_request_challenge
        const inst2Res = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, provider, environment, purpose, state, approval_status, version)
            VALUES (12000, 'USD', 'corp_treasury', 'vendor_replay_test', 'acc_replay_001', 'STRIPE_TEST', 'sandbox', 'VENDOR_SETTLEMENT', 'APPROVED', 'APPROVED', 1)
            RETURNING instruction_id;
        `);
        const instruction2Id = inst2Res.rows[0].instruction_id;

        const vr2Res = await client.query(`
            INSERT INTO identity.payment_void_requests (
                instruction_id, instruction_version, requester_operator_id, reason, status
            ) VALUES ($1, 1, $2, 'Another void request attempting challenge reuse', 'PENDING')
            RETURNING void_request_id;
        `, [instruction2Id, opMaker]);
        const voidRequest2Id = vr2Res.rows[0].void_request_id;

        // Attempting to use the already consumed challengeId on a second void request must fail with unique constraint violation
        await expect(
            client.query(`
                UPDATE identity.payment_void_requests SET challenge_id = $1 WHERE void_request_id = $2;
            `, [challengeId, voidRequest2Id])
        ).rejects.toThrow(/uq_void_request_challenge|duplicate key value/);

        // 11. Adversarial Check G: Double-approval on already approved void request fails
        await expect(
            client.query(`
                SELECT identity.fn_approve_payment_void($1, $2, $3, $4, $5);
            `, [voidRequestId, instructionId, opChecker, challengeId, digest])
        ).rejects.toThrow(/already VOIDED|is not in PENDING status/);

        // 12. Check PENDING -> REJECTED transition works, and REJECTED -> APPROVED is strictly rejected
        const inst3Res = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, provider, environment, purpose, state, approval_status, version)
            VALUES (15000, 'USD', 'corp_treasury', 'vendor_reject_test', 'acc_reject_001', 'STRIPE_TEST', 'sandbox', 'VENDOR_SETTLEMENT', 'APPROVED', 'APPROVED', 1)
            RETURNING instruction_id;
        `);
        const instruction3Id = inst3Res.rows[0].instruction_id;

        const vr3Res = await client.query(`
            INSERT INTO identity.payment_void_requests (
                instruction_id, instruction_version, requester_operator_id, reason, status
            ) VALUES ($1, 1, $2, 'Void request to be rejected', 'PENDING')
            RETURNING void_request_id;
        `, [instruction3Id, opMaker]);
        const voidRequest3Id = vr3Res.rows[0].void_request_id;

        // Reject void request
        await client.query(`
            UPDATE identity.payment_void_requests 
            SET status = 'REJECTED', approver_operator_id = $2, decided_at = NOW()
            WHERE void_request_id = $1
        `, [voidRequest3Id, opChecker]);

        const rejectedVr = await client.query(`SELECT status FROM identity.payment_void_requests WHERE void_request_id = $1`, [voidRequest3Id]);
        expect(rejectedVr.rows[0].status).toBe('REJECTED');

        // Transition REJECTED -> APPROVED must be strictly rejected
        await expect(
            client.query(`UPDATE identity.payment_void_requests SET status = 'APPROVED' WHERE void_request_id = $1`, [voidRequest3Id])
        ).rejects.toThrow(/strictly immutable|Direct update of payment_void_requests to APPROVED is prohibited/);
    });

    test('28. Least-Privilege Role Hardening (Finding 3): fusion_app_runtime role permissions', async () => {
        if (!isDbAvailable) return;

        await client.query('SET ROLE fusion_app_runtime');
        try {
            // 1. DELETE denied on instructions
            await expect(client.query('DELETE FROM public.instructions')).rejects.toThrow(/permission denied for table instructions/);

            // 2. DELETE denied on payment_approvals
            await expect(client.query('DELETE FROM identity.payment_approvals')).rejects.toThrow(/permission denied for table payment_approvals/);

            // 3. DELETE denied on payment_void_requests
            await expect(client.query('DELETE FROM identity.payment_void_requests')).rejects.toThrow(/permission denied for table payment_void_requests/);

            // 4. DELETE denied on routing_ledger
            await expect(client.query('DELETE FROM public.routing_ledger')).rejects.toThrow(/permission denied for table routing_ledger/);

            // 5. TRUNCATE denied on instructions
            await expect(client.query('TRUNCATE TABLE public.instructions')).rejects.toThrow(/permission denied for table instructions/);

            // 6. TRUNCATE denied on payment_approvals
            await expect(client.query('TRUNCATE TABLE identity.payment_approvals')).rejects.toThrow(/permission denied for table payment_approvals/);

            // 7. TRUNCATE denied on payment_void_requests
            await expect(client.query('TRUNCATE TABLE identity.payment_void_requests')).rejects.toThrow(/permission denied for table payment_void_requests/);

            // 8. TRUNCATE denied on routing_ledger
            await expect(client.query('TRUNCATE TABLE public.routing_ledger')).rejects.toThrow(/permission denied for table routing_ledger/);

            // 9. UPDATE denied on routing_ledger (strictly append-only)
            await expect(client.query('UPDATE public.routing_ledger SET status = \'SETTLED\'')).rejects.toThrow(/permission denied for table routing_ledger/);

            // 10. UPDATE denied on auth_audit_log (strictly append-only)
            await expect(client.query('UPDATE identity.auth_audit_log SET event_type = \'TAMPER\'')).rejects.toThrow(/permission denied for table auth_audit_log/);
        } finally {
            await client.query('RESET ROLE');
        }
    });

    test('29. Statement and Row-Level Destruction Protection (Finding 3): TRUNCATE and DELETE triggers prevent destruction even by table owners', async () => {
        if (!isDbAvailable) return;

        // Statement-Level TRUNCATE Block Triggers
        await expect(client.query('TRUNCATE TABLE public.instructions CASCADE')).rejects.toThrow(
            /Security violation: TRUNCATE is strictly prohibited on instructions/
        );

        await expect(client.query('TRUNCATE TABLE identity.payment_approvals CASCADE')).rejects.toThrow(
            /Security violation: TRUNCATE is strictly prohibited on payment_approvals/
        );

        await expect(client.query('TRUNCATE TABLE identity.payment_void_requests CASCADE')).rejects.toThrow(
            /Security violation: TRUNCATE is strictly prohibited on payment_void_requests/
        );

        await expect(client.query('TRUNCATE TABLE public.routing_ledger CASCADE')).rejects.toThrow(
            /Security violation: TRUNCATE is strictly prohibited on routing_ledger/
        );

        await expect(client.query('TRUNCATE TABLE identity.role_change_requests CASCADE')).rejects.toThrow(
            /Security violation: TRUNCATE is strictly prohibited on role_change_requests/
        );

        await expect(client.query('TRUNCATE TABLE identity.webauthn_challenges CASCADE')).rejects.toThrow(
            /Security violation: TRUNCATE is strictly prohibited on webauthn_challenges/
        );

        // Row-Level DELETE Block Triggers: Direct DELETE on audit and governance tables
        await expect(
            client.query('DELETE FROM identity.payment_void_requests')
        ).rejects.toThrow(/Deletion of payment void requests is strictly prohibited/);

        await expect(
            client.query('DELETE FROM identity.role_change_requests')
        ).rejects.toThrow(/Deletion of role change governance records is strictly prohibited/);

        // Insert a dummy instruction and ledger row to verify row-level DELETE block
        const ledgerInstRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, provider, environment, purpose, state)
            VALUES (100, 'USD', 'corp', 'vendor', 'acc_ledger_check', 'STRIPE_TEST', 'sandbox', 'CHECK', 'INITIATED')
            RETURNING instruction_id;
        `);
        const ledgerInstId = ledgerInstRes.rows[0].instruction_id;

        await client.query(`
            INSERT INTO public.routing_ledger (transaction_id, route_selected, status)
            VALUES ($1, 'FIAT', 'INITIATED')
        `, [ledgerInstId]);

        await expect(
            client.query('DELETE FROM public.routing_ledger')
        ).rejects.toThrow(/Accounting ledger is strictly append-only/);
    });

    test('30. Adversarial Direct-SQL Financial Mutation Tests under fusion_app_runtime (Finding 1)', async () => {
        if (!isDbAvailable) return;

        // Setup test instruction in PENDING_APPROVAL
        const instPenRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, provider, environment, purpose, state, approval_status, version)
            VALUES (5000, 'USD', 'corp_treasury', 'vendor_adv_test', 'acc_pending_adv', 'STRIPE_TEST', 'sandbox', 'VENDOR_SETTLEMENT', 'PENDING_APPROVAL', 'PENDING_APPROVAL', 1)
            RETURNING instruction_id;
        `);
        const pendingInstId = instPenRes.rows[0].instruction_id;

        // Setup approved instruction
        const instAppRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, provider, environment, purpose, state, approval_status, version)
            VALUES (8000, 'USD', 'corp_treasury', 'vendor_adv_test2', 'acc_appr_adv', 'STRIPE_TEST', 'sandbox', 'VENDOR_SETTLEMENT', 'APPROVED', 'APPROVED', 1)
            RETURNING instruction_id;
        `);
        const approvedInstId = instAppRes.rows[0].instruction_id;

        // Connect/switch to fusion_app_runtime role
        await client.query('SET ROLE fusion_app_runtime');
        try {
            // Adversarial Test 1: Set a PENDING instruction to APPROVED directly
            await expect(
                client.query(`UPDATE public.instructions SET state = 'APPROVED', approval_status = 'APPROVED' WHERE instruction_id = $1`, [pendingInstId])
            ).rejects.toThrow(/Direct transition of instruction .* to APPROVED is prohibited/);

            // Adversarial Test 2: Set an APPROVED instruction to VOIDED without the approved void workflow
            await expect(
                client.query(`UPDATE public.instructions SET state = 'VOIDED', approval_status = 'VOIDED' WHERE instruction_id = $1`, [approvedInstId])
            ).rejects.toThrow(/Direct transition of instruction .* to VOIDED is prohibited/);

            // Adversarial Test 3: Insert an approval record pretending another operator approved
            await expect(
                client.query(`
                    INSERT INTO identity.payment_approvals (instruction_id, maker_operator_id, checker_operator_id, status, amount, currency)
                    VALUES ($1, $2, $3, 'APPROVED', 5000, 'USD')
                `, [pendingInstId, opMaker, opChecker])
            ).rejects.toThrow(/Direct insertion of non-PENDING(_APPROVAL)? approval records is (strictly )?prohibited/);

            // Adversarial Test 4: Modify an existing approval record to APPROVED
            await client.query('RESET ROLE');
            const apprRes = await client.query(`
                INSERT INTO identity.payment_approvals (instruction_id, maker_operator_id, status, amount, currency)
                VALUES ($1, $2, 'PENDING_APPROVAL', 5000, 'USD')
                RETURNING approval_id;
            `, [pendingInstId, opMaker]);
            const testApprId = apprRes.rows[0].approval_id;

            await client.query('SET ROLE fusion_app_runtime');
            await expect(
                client.query(`UPDATE identity.payment_approvals SET status = 'APPROVED', checker_operator_id = $1 WHERE approval_id = $2`, [opChecker, testApprId])
            ).rejects.toThrow(/Direct update of payment_approvals to APPROVED is prohibited/);

            // Adversarial Test 5: Modify a void request to APPROVED using arbitrary non-null challenge and digest values
            await client.query('RESET ROLE');
            const vrTestRes = await client.query(`
                INSERT INTO identity.payment_void_requests (instruction_id, instruction_version, requester_operator_id, reason, status)
                VALUES ($1, 1, $2, 'Adversarial direct update attempt', 'PENDING')
                RETURNING void_request_id;
            `, [approvedInstId, opMaker]);
            const testVoidReqId = vrTestRes.rows[0].void_request_id;

            await client.query('SET ROLE fusion_app_runtime');
            await expect(
                client.query(`
                    UPDATE identity.payment_void_requests
                    SET status = 'APPROVED', approver_operator_id = $1, decided_at = NOW(), challenge_id = '00000000-0000-4000-8000-000000000099', context_digest = '0000000000000000000000000000000000000000000000000000000000000000'
                    WHERE void_request_id = $2
                `, [opChecker, testVoidReqId])
            ).rejects.toThrow(/Direct update of payment_void_requests to APPROVED is prohibited/);

            // Adversarial Test 6: Change the approver identity after approval
            await client.query('RESET ROLE');
            const approvedApprRes = await client.query(`
                INSERT INTO identity.payment_approvals (instruction_id, maker_operator_id, checker_operator_id, status, amount, currency, decided_at, context_digest)
                VALUES ($1, $2, $3, 'PENDING_APPROVAL', 8000, 'USD', NULL, NULL)
                RETURNING approval_id;
            `, [approvedInstId, opMaker, opChecker]);
            const approvedApprId = approvedApprRes.rows[0].approval_id;
            // Mark it approved via authorized workflow definer role
            await client.query('SET ROLE fusion_workflow_definer');
            await client.query(`
                UPDATE identity.payment_approvals
                SET status = 'APPROVED', checker_operator_id = $1, decided_at = NOW(), context_digest = '1111111111111111111111111111111111111111111111111111111111111111'
                WHERE approval_id = $2
            `, [opChecker, approvedApprId]);
            await client.query('RESET ROLE');

            await client.query('SET ROLE fusion_app_runtime');
            await expect(
                client.query(`UPDATE identity.payment_approvals SET checker_operator_id = $1 WHERE approval_id = $2`, [opMaker, approvedApprId])
            ).rejects.toThrow(/Cannot modify approval in terminal state|Approver identity is strictly immutable post-approval/);

            // Adversarial Test 7: Reuse an existing challenge against another void request
            await client.query('RESET ROLE');
            const chReuseRes = await client.query(`
                INSERT INTO identity.webauthn_challenges (operator_id, ceremony_type, challenge, context_digest, expires_at)
                VALUES ($1, 'authentication', 'mock_reuse_ch_' || gen_random_uuid(), '2222222222222222222222222222222222222222222222222222222222222222', NOW() + INTERVAL '5 minutes')
                RETURNING challenge_id;
            `, [opChecker]);
            const chReuseId = chReuseRes.rows[0].challenge_id;

            await client.query(`
                UPDATE identity.payment_void_requests SET challenge_id = $1 WHERE void_request_id = $2;
            `, [chReuseId, testVoidReqId]);

            const vrReuse2Res = await client.query(`
                INSERT INTO identity.payment_void_requests (instruction_id, instruction_version, requester_operator_id, reason, status)
                VALUES ($1, 1, $2, 'Second void request reusing challenge', 'PENDING')
                RETURNING void_request_id;
            `, [pendingInstId, opMaker]);
            const testVoidReq2Id = vrReuse2Res.rows[0].void_request_id;

            await client.query('SET ROLE fusion_app_runtime');
            await expect(
                client.query(`UPDATE identity.payment_void_requests SET challenge_id = $1 WHERE void_request_id = $2`, [chReuseId, testVoidReq2Id])
            ).rejects.toThrow(/uq_void_request_challenge|duplicate key value/);
        } finally {
            await client.query('RESET ROLE');
        }
    });

    test('31. Stored Function Security Attributes & WebAuthn Trust Boundary Verification (Finding 2)', async () => {
        if (!isDbAvailable) return;

        // 1. Verify owner of fn_approve_payment_void is dedicated non-login role fusion_workflow_definer
        const ownerRes = await client.query(`
            SELECT r.rolname, p.prosecdef, p.proconfig
            FROM pg_proc p
            JOIN pg_roles r ON p.proowner = r.oid
            JOIN pg_namespace n ON p.pronamespace = n.oid
            WHERE n.nspname = 'identity' AND p.proname = 'fn_approve_payment_void';
        `);
        expect(ownerRes.rows.length).toBeGreaterThan(0);
        expect(ownerRes.rows[0].rolname).toBe('fusion_workflow_definer');
        expect(ownerRes.rows[0].prosecdef).toBe(true);
        expect(ownerRes.rows[0].proconfig).toEqual(expect.arrayContaining(['search_path=pg_catalog, identity, public']));

        // 2. Verify owner of fn_approve_payment_instruction is fusion_workflow_definer
        const apprOwnerRes = await client.query(`
            SELECT r.rolname, p.prosecdef, p.proconfig
            FROM pg_proc p
            JOIN pg_roles r ON p.proowner = r.oid
            JOIN pg_namespace n ON p.pronamespace = n.oid
            WHERE n.nspname = 'identity' AND p.proname = 'fn_approve_payment_instruction';
        `);
        expect(apprOwnerRes.rows.length).toBeGreaterThan(0);
        expect(apprOwnerRes.rows[0].rolname).toBe('fusion_workflow_definer');
        expect(apprOwnerRes.rows[0].prosecdef).toBe(true);
        expect(apprOwnerRes.rows[0].proconfig).toEqual(expect.arrayContaining(['search_path=pg_catalog, identity, public']));

        // 3. Connect as fusion_app_runtime: cannot drop or alter stored functions
        await client.query('SET ROLE fusion_app_runtime');
        try {
            await expect(
                client.query('DROP FUNCTION identity.fn_approve_payment_void(UUID, UUID, UUID, UUID, VARCHAR(64))')
            ).rejects.toThrow(/must be owner of function|permission denied/);

            await expect(
                client.query('DROP FUNCTION identity.fn_approve_payment_instruction(UUID, UUID, UUID, UUID, VARCHAR(64), TEXT, VARCHAR(32))')
            ).rejects.toThrow(/must be owner of function|permission denied/);

            // 4. Cannot directly insert into verified_webauthn_assertions
            await expect(
                client.query(`
                    INSERT INTO identity.verified_webauthn_assertions (challenge_id, operator_id, credential_id, signature_hash, context_digest)
                    VALUES (gen_random_uuid(), '00000000-0000-4000-8000-000000000001', 'cred_fake', 'fake_hash_64_chars_____________________________________________', 'digest_fake')
                `)
            ).rejects.toThrow(/permission denied for table verified_webauthn_assertions/);
        } finally {
            await client.query('RESET ROLE');
        }
    });

    test('32. WebAuthn Attestation Isolation & Adversarial Tests under fusion_app_runtime vs fusion_webauthn_verifier (Finding 1)', async () => {
        if (!isDbAvailable) return;

        const fakeChallengeId = crypto.randomUUID();
        const fakeOperatorId = '00000000-0000-4000-8000-000000000001';
        const fakeCredId = 'cred_fake_adv';
        const fakeSigHash = 'a'.repeat(64);
        const fakeDigest = 'b'.repeat(64);

        // 1. Direct Adversarial Tests under authentic fusion_app_runtime connection
        const runtimePool = new Pool({
            user: 'fusion_app_runtime',
            password: 'fusion_app_runtime_secret_test',
            host: process.env.DB_HOST || '127.0.0.1',
            port: parseInt(process.env.DB_PORT || '5432', 10),
            database: process.env.DB_NAME || 'postgres',
        });

        const rClient = await runtimePool.connect();
        try {
            // (a) Attempt direct INSERT into verified assertion table
            await expect(
                rClient.query(`
                    INSERT INTO identity.verified_webauthn_assertions (
                        challenge_id, operator_id, credential_id, signature_hash, context_digest
                    ) VALUES ($1, $2, $3, $4, $5)
                `, [fakeChallengeId, fakeOperatorId, fakeCredId, fakeSigHash, fakeDigest])
            ).rejects.toThrow(/permission denied for table verified_webauthn_assertions/);

            // (b) Attempt to call fn_record_verified_webauthn_assertion directly
            await expect(
                rClient.query(`
                    SELECT identity.fn_record_verified_webauthn_assertion($1, $2, $3, $4, $5)
                `, [fakeChallengeId, fakeOperatorId, fakeCredId, fakeSigHash, fakeDigest])
            ).rejects.toThrow(/permission denied for function fn_record_verified_webauthn_assertion/);

            // (c) Attempt to assume verifier role
            await expect(
                rClient.query('SET ROLE fusion_webauthn_verifier')
            ).rejects.toThrow(/permission denied to set role "fusion_webauthn_verifier"/);

            // (d) Attempt to assume workflow definer role
            await expect(
                rClient.query('SET ROLE fusion_workflow_definer')
            ).rejects.toThrow(/permission denied to set role "fusion_workflow_definer"/);
        } finally {
            rClient.release();
            await runtimePool.end();
        }

        // 2. Setup genuine challenge and credential in database
        const testChUuid = crypto.randomUUID();
        const testChStr = 'genuine_adv_challenge_' + Date.now();
        const genuineDigest = crypto.createHash('sha256').update('genuine_context_' + Date.now()).digest('hex');

        await client.query(`
            INSERT INTO identity.webauthn_challenges (challenge_id, operator_id, challenge, ceremony_type, expires_at, context_digest)
            VALUES ($1, $2, $3, 'authentication', NOW() + INTERVAL '5 minutes', $4)
        `, [testChUuid, opChecker, testChStr, genuineDigest]);

        await client.query(`
            INSERT INTO identity.webauthn_credentials (credential_id, operator_id, public_key, counter)
            VALUES ($1, $2, 'test_pub_key_genuine', 0)
            ON CONFLICT (credential_id) DO NOTHING;
        `, ['cred_genuine_adv', opChecker]);

        // (e) Attempt to invoke approval with unverified challenge
        const instRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, provider, environment, purpose, state, approval_status, version)
            VALUES (9000, 'USD', 'corp', 'vendor', 'acc_unv', 'STRIPE_TEST', 'sandbox', 'UNVERIFIED_CHALLENGE_TEST', 'PENDING_APPROVAL', 'PENDING_APPROVAL', 1)
            RETURNING instruction_id;
        `);
        const instId = instRes.rows[0].instruction_id;

        const apprRes = await client.query(`
            INSERT INTO identity.payment_approvals (instruction_id, maker_operator_id, status, amount, currency, instruction_version)
            VALUES ($1, $2, 'PENDING_APPROVAL', 9000, 'USD', 1)
            RETURNING approval_id;
        `, [instId, opMaker]);
        const apprId = apprRes.rows[0].approval_id;

        await expect(
            client.query(`
                SELECT identity.fn_approve_payment_instruction($1, $2, $3, $4, $5, 'notes', 'webauthn')
            `, [apprId, instId, opChecker, testChUuid, genuineDigest])
        ).rejects.toThrow(/Cryptographic(ally verified)? WebAuthn assertion/i);

        // 3. Connect via dedicated isolated verifier principal (fusion_webauthn_verifier)
        const verifierPool = new Pool({
            user: 'fusion_webauthn_verifier',
            password: 'fusion_webauthn_verifier_secret_test',
            host: process.env.DB_HOST || '127.0.0.1',
            port: parseInt(process.env.DB_PORT || '5432', 10),
            database: process.env.DB_NAME || 'postgres',
        });

        let vClient;
        try {
            vClient = await verifierPool.connect();

            // Genuinely record verified assertion through verifier principal
            const genuineSigHash = crypto.createHash('sha256').update('genuine_sig_' + Date.now()).digest('hex');
            const recRes = await vClient.query(`
                SELECT identity.fn_record_verified_webauthn_assertion($1, $2, $3, $4, $5) AS assertion_id
            `, [testChUuid, opChecker, 'cred_genuine_adv', genuineSigHash, genuineDigest]);

            expect(recRes.rows.length).toBe(1);
            expect(recRes.rows[0].assertion_id).toBeDefined();

            // Verify that fusion_webauthn_verifier cannot execute financial approval procedures
            await expect(
                vClient.query(`
                    SELECT identity.fn_approve_payment_instruction($1, $2, $3, $4, $5, 'notes', 'webauthn')
                `, [apprId, instId, opChecker, testChUuid, genuineDigest])
            ).rejects.toThrow(/permission denied for function fn_approve_payment_instruction/);

            // Verify that fusion_webauthn_verifier cannot mutate financial records directly
            await expect(
                vClient.query(`UPDATE public.instructions SET amount = 1 WHERE instruction_id = $1`, [instId])
            ).rejects.toThrow(/permission denied for table instructions/);

            await expect(
                vClient.query(`INSERT INTO public.routing_ledger (transaction_id, route_selected, status) VALUES ($1, 'FIAT', 'LOCKED')`, [instId])
            ).rejects.toThrow(/permission denied for table routing_ledger/);
        } finally {
            if (vClient) vClient.release();
            await verifierPool.end();
        }

        // (g) Cross-operator assertion reuse: Attempt approval with another operator using opChecker's assertion
        await expect(
            client.query(`
                SELECT identity.fn_approve_payment_instruction($1, $2, $3, $4, $5, 'notes', 'webauthn')
            `, [apprId, instId, opMaker, testChUuid, genuineDigest])
        ).rejects.toThrow(/Dual control violation|operator mismatch/i);

        // (h) Context-digest substitution: Attempt approval with mismatched context digest
        const tamperedDigest = crypto.createHash('sha256').update('tampered_context').digest('hex');
        await expect(
            client.query(`
                SELECT identity.fn_approve_payment_instruction($1, $2, $3, $4, $5, 'notes', 'webauthn')
            `, [apprId, instId, opChecker, testChUuid, tamperedDigest])
        ).rejects.toThrow(/context digest mismatch/i);

        // 4. Now that assertion was recorded by verifier and parameters match, approval succeeds
        const approveSuccessRes = await client.query(`
            SELECT identity.fn_approve_payment_instruction($1, $2, $3, $4, $5, 'notes', 'webauthn') AS result
        `, [apprId, instId, opChecker, testChUuid, genuineDigest]);
        expect(approveSuccessRes.rows[0].result.status).toBe('APPROVED');

        // (f) Challenge reuse: Attempting approval again with now-consumed assertion fails
        await expect(
            client.query(`
                SELECT identity.fn_approve_payment_instruction($1, $2, $3, $4, $5, 'notes', 'webauthn')
            `, [apprId, instId, opChecker, testChUuid, genuineDigest])
        ).rejects.toThrow(/already been consumed|is already executed|status.*must be PENDING_APPROVAL|is in status APPROVED/i);
    });

    test('34. Migration 023: Role Login Isolation and Membership Closure (AI-2B.6.2 Finding 1)', async () => {
        if (!isDbAvailable) return;

        // Verify fusion_workflow_definer is NOLOGIN
        const definerLogin = await client.query(
            `SELECT rolcanlogin FROM pg_roles WHERE rolname = 'fusion_workflow_definer'`
        );
        expect(definerLogin.rows[0].rolcanlogin).toBe(false);

        // Verify no membership path: fusion_app_runtime is not a member of fusion_workflow_definer
        const appMembership = await client.query(`
            SELECT COUNT(*) AS n FROM pg_auth_members m
            WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'fusion_app_runtime')
              AND m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'fusion_workflow_definer')
        `);
        expect(appMembership.rows[0].n).toBe('0');

        // Verify no membership path: fusion_webauthn_verifier is not a member of fusion_workflow_definer
        const verifierMembership = await client.query(`
            SELECT COUNT(*) AS n FROM pg_auth_members m
            WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'fusion_webauthn_verifier')
              AND m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'fusion_workflow_definer')
        `);
        expect(verifierMembership.rows[0].n).toBe('0');

        // Verify trigger guards now use authoritative role check (not GUC denylist)
        const trigFn = await client.query(`
            SELECT pg_get_functiondef(oid) AS def
            FROM pg_proc
            WHERE proname = 'trg_enforce_instructions_state_guard'
              AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'identity')
        `);
        const trigBody = trigFn.rows[0].def;
        // Must NOT contain denylist pattern (old 022 style)
        expect(trigBody).not.toContain("IN ('fusion_app_runtime'");
        // Must contain authoritative check for fusion_workflow_definer (023 style)
        expect(trigBody).toContain("fusion_workflow_definer");
        expect(trigBody).toContain("CURRENT_USER <> 'fusion_workflow_definer'");

        // Verify fn_record_verified_webauthn_assertion uses SESSION_USER (not CURRENT_USER whitelist)
        const fnAssert = await client.query(`
            SELECT pg_get_functiondef(oid) AS def
            FROM pg_proc
            WHERE proname = 'fn_record_verified_webauthn_assertion'
              AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'identity')
        `);
        const fnBody = fnAssert.rows[0].def;
        expect(fnBody).toContain('SESSION_USER');
        expect(fnBody).not.toContain("'praveen'");
        expect(fnBody).not.toContain("'postgres'");
    });

    test('35. Migration 023: Verifier Column-Level Privilege Minimization (AI-2B.6.2 Finding 2)', async () => {
        if (!isDbAvailable) return;

        // Verify fusion_webauthn_verifier does NOT have table-level UPDATE on webauthn_credentials
        const credTablePriv = await client.query(`
            SELECT privilege_type FROM information_schema.role_table_grants
            WHERE grantee = 'fusion_webauthn_verifier'
              AND table_schema = 'identity'
              AND table_name = 'webauthn_credentials'
              AND privilege_type = 'UPDATE'
        `);
        expect(credTablePriv.rows.length).toBe(0);

        // Verify fusion_webauthn_verifier does NOT have table-level UPDATE on webauthn_challenges
        const challTablePriv = await client.query(`
            SELECT privilege_type FROM information_schema.role_table_grants
            WHERE grantee = 'fusion_webauthn_verifier'
              AND table_schema = 'identity'
              AND table_name = 'webauthn_challenges'
              AND privilege_type = 'UPDATE'
        `);
        expect(challTablePriv.rows.length).toBe(0);

        // Verify fusion_webauthn_verifier HAS column-level UPDATE on counter, last_used_at only
        const credColPriv = await client.query(`
            SELECT column_name FROM information_schema.column_privileges
            WHERE grantee = 'fusion_webauthn_verifier'
              AND table_schema = 'identity'
              AND table_name = 'webauthn_credentials'
              AND privilege_type = 'UPDATE'
            ORDER BY column_name
        `);
        const updatableCols = credColPriv.rows.map(r => r.column_name).sort();
        expect(updatableCols).toEqual(['counter', 'last_used_at']);

        // Verify fusion_webauthn_verifier HAS column-level UPDATE on consumed_at only for challenges
        const challColPriv = await client.query(`
            SELECT column_name FROM information_schema.column_privileges
            WHERE grantee = 'fusion_webauthn_verifier'
              AND table_schema = 'identity'
              AND table_name = 'webauthn_challenges'
              AND privilege_type = 'UPDATE'
            ORDER BY column_name
        `);
        const challUpdatableCols = challColPriv.rows.map(r => r.column_name).sort();
        expect(challUpdatableCols).toEqual(['consumed_at']);

        // Verify via DIRECT VERIFIER SESSION: attempt to update restricted columns
        const verifierPool35 = new Pool({
            user: 'fusion_webauthn_verifier',
            password: 'fusion_webauthn_verifier_secret_test',
            host: process.env.DB_HOST || '127.0.0.1',
            port: parseInt(process.env.DB_PORT || '5432', 10),
            database: process.env.DB_NAME || 'postgres',
        });

        let vClient35;
        const credId35 = `cred_priv_test_${Date.now()}`;
        const opId35 = opChecker;

        try {
            await client.query(`
                INSERT INTO identity.webauthn_credentials (credential_id, operator_id, public_key, counter)
                VALUES ($1, $2, 'test_priv_pub_key_35', 0)
                ON CONFLICT (credential_id) DO NOTHING
            `, [credId35, opId35]);

            vClient35 = await verifierPool35.connect();

            // Verifier can update counter + last_used_at
            await vClient35.query(
                `UPDATE identity.webauthn_credentials SET counter = 5, last_used_at = NOW() WHERE credential_id = $1`,
                [credId35]
            );

            // Verifier CANNOT change public_key
            await expect(
                vClient35.query(`UPDATE identity.webauthn_credentials SET public_key = 'MALICIOUS' WHERE credential_id = $1`, [credId35])
            ).rejects.toThrow(/permission denied/);

            // Verifier CANNOT change operator_id (credential hijacking)
            await expect(
                vClient35.query(`UPDATE identity.webauthn_credentials SET operator_id = $1 WHERE credential_id = $2`, [opAdmin, credId35])
            ).rejects.toThrow(/permission denied/);

            // Verifier CANNOT change credential_id
            await expect(
                vClient35.query(`UPDATE identity.webauthn_credentials SET credential_id = 'hijacked' WHERE credential_id = $1`, [credId35])
            ).rejects.toThrow(/permission denied/);

            // Verifier CANNOT INSERT new credentials
            await expect(
                vClient35.query(`INSERT INTO identity.webauthn_credentials (credential_id, operator_id, public_key, counter) VALUES ('fake_cred_35', $1, 'fake_key', 0)`, [opId35])
            ).rejects.toThrow(/permission denied/);

            // Create test challenge as superuser
            const challRes35 = await client.query(`
                INSERT INTO identity.webauthn_challenges (challenge, operator_id, ceremony_type, expires_at, context_digest)
                VALUES ('chall_priv_35_' || gen_random_uuid()::text, $1, 'authentication', NOW() + INTERVAL '5 minutes', $2)
                RETURNING challenge_id
            `, [opId35, crypto.createHash('sha256').update('test_context_priv_35').digest('hex')]);
            const challId35 = challRes35.rows[0].challenge_id;

            // Verifier CAN mark challenge consumed
            await vClient35.query(`UPDATE identity.webauthn_challenges SET consumed_at = NOW() WHERE challenge_id = $1`, [challId35]);

            // Verifier CANNOT change context_digest on challenges
            await expect(
                vClient35.query(`UPDATE identity.webauthn_challenges SET context_digest = 'malicious_digest' WHERE challenge_id = $1`, [challId35])
            ).rejects.toThrow(/permission denied/);

            // Verifier CANNOT change operator_id on challenges
            await expect(
                vClient35.query(`UPDATE identity.webauthn_challenges SET operator_id = $1 WHERE challenge_id = $2`, [opAdmin, challId35])
            ).rejects.toThrow(/permission denied/);

            // Verifier CANNOT execute fn_approve_payment_void
            await expect(
                vClient35.query(`SELECT identity.fn_approve_payment_void($1, $2, $3, $4, $5)`,
                    ['00000000-0000-4000-8000-100000000001', '00000000-0000-4000-8000-200000000001',
                     opChecker, '00000000-0000-4000-8000-300000000001', 'a'.repeat(64)])
            ).rejects.toThrow(/permission denied/);

            // Verifier CANNOT SET ROLE to fusion_workflow_definer
            await expect(
                vClient35.query('SET ROLE fusion_workflow_definer')
            ).rejects.toThrow(/permission denied|must be/);

            // Verifier CAN perform SELECT FOR UPDATE on challenges
            const challRes35b = await client.query(`
                INSERT INTO identity.webauthn_challenges (challenge, operator_id, ceremony_type, expires_at, context_digest)
                VALUES ('chall_fu_35_' || gen_random_uuid()::text, $1, 'authentication', NOW() + INTERVAL '5 minutes', $2)
                RETURNING challenge_id
            `, [opId35, crypto.createHash('sha256').update('test_fu_35').digest('hex')]);
            const challId35b = challRes35b.rows[0].challenge_id;

            await vClient35.query('BEGIN');
            const fuRes = await vClient35.query(`SELECT * FROM identity.webauthn_challenges WHERE challenge_id = $1 FOR UPDATE`, [challId35b]);
            await vClient35.query('ROLLBACK');
            expect(fuRes.rows.length).toBe(1);

            // Verifier CAN perform SELECT FOR UPDATE on credentials
            await vClient35.query('BEGIN');
            const fuCredRes = await vClient35.query(`SELECT * FROM identity.webauthn_credentials WHERE credential_id = $1 FOR UPDATE`, [credId35]);
            await vClient35.query('ROLLBACK');
            expect(fuCredRes.rows.length).toBe(1);

        } finally {
            if (vClient35) vClient35.release();
            await verifierPool35.end();
        }
    });

    test('33. Elimination of Internal Workflow GUC & Effective Role Enforcement (Finding 2)', async () => {
        if (!isDbAvailable) return;

        // Setup test instruction in PENDING_APPROVAL
        const gucInstRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, provider, environment, purpose, state, approval_status, version)
            VALUES (4500, 'USD', 'corp_treasury', 'vendor_guc_test', 'acc_guc', 'STRIPE_TEST', 'sandbox', 'GUC_BYPASS_TEST', 'PENDING_APPROVAL', 'PENDING_APPROVAL', 1)
            RETURNING instruction_id;
        `);
        const gucInstId = gucInstRes.rows[0].instruction_id;

        const gucApprRes = await client.query(`
            INSERT INTO identity.payment_approvals (instruction_id, maker_operator_id, status, amount, currency, instruction_version)
            VALUES ($1, $2, 'PENDING_APPROVAL', 4500, 'USD', 1)
            RETURNING approval_id;
        `, [gucInstId, opMaker]);
        const gucApprId = gucApprRes.rows[0].approval_id;

        const gucVoidRes = await client.query(`
            INSERT INTO identity.payment_void_requests (instruction_id, instruction_version, requester_operator_id, reason, status)
            VALUES ($1, 1, $2, 'GUC void test', 'PENDING')
            RETURNING void_request_id;
        `, [gucInstId, opMaker]);
        const gucVoidId = gucVoidRes.rows[0].void_request_id;

        // Switch role to fusion_app_runtime
        await client.query('SET ROLE fusion_app_runtime');
        try {
            // 1. Mandatory Adversarial Attempt 1: SET LOCAL pg_temp.fusion_internal_workflow = 'true'
            await client.query("SET LOCAL pg_temp.fusion_internal_workflow = 'true'");
            await expect(
                client.query(`UPDATE public.instructions SET status = 'APPROVED' WHERE instruction_id = $1`, [gucInstId])
            ).rejects.toThrow(/Direct transition of instruction .* to APPROVED is prohibited/);

            // 2. Mandatory Adversarial Attempt 2: SELECT set_config('pg_temp.fusion_internal_workflow', 'true', true)
            await client.query("SELECT set_config('pg_temp.fusion_internal_workflow', 'true', true)");
            await expect(
                client.query(`UPDATE public.instructions SET status = 'APPROVED' WHERE instruction_id = $1`, [gucInstId])
            ).rejects.toThrow(/Direct transition of instruction .* to APPROVED is prohibited/);

            // 3. Attempt direct changes to VOIDED under fusion_app_runtime
            await expect(
                client.query(`UPDATE public.instructions SET status = 'VOIDED' WHERE instruction_id = $1`, [gucInstId])
            ).rejects.toThrow(/Direct transition of instruction .* to VOIDED is prohibited/);

            // 4. Attempt direct changes to EXECUTED under fusion_app_runtime
            await expect(
                client.query(`UPDATE public.instructions SET status = 'EXECUTED' WHERE instruction_id = $1`, [gucInstId])
            ).rejects.toThrow(/Direct transition of instruction .* to EXECUTED is prohibited|cannot transition to EXECUTED without prior approval/);

            // 5. Attempt direct changes to SETTLED under fusion_app_runtime
            await expect(
                client.query(`UPDATE public.instructions SET status = 'SETTLED' WHERE instruction_id = $1`, [gucInstId])
            ).rejects.toThrow(/Direct transition of instruction .* to SETTLED is prohibited|cannot transition to SETTLED without prior approval/);

            // 6. Attempt direct updates to payment_approvals guard with GUC set
            await client.query("SET LOCAL pg_temp.fusion_internal_workflow = 'true'");
            await expect(
                client.query(`UPDATE identity.payment_approvals SET status = 'APPROVED' WHERE approval_id = $1`, [gucApprId])
            ).rejects.toThrow(/Direct update of payment_approvals to APPROVED is prohibited/);

            await expect(
                client.query(`UPDATE identity.payment_approvals SET status = 'VOIDED' WHERE approval_id = $1`, [gucApprId])
            ).rejects.toThrow(/Direct update of payment_approvals to VOIDED is prohibited/);

            // 7. Attempt direct updates to payment_void_requests guard with GUC set
            await client.query("SET LOCAL pg_temp.fusion_internal_workflow = 'true'");
            await expect(
                client.query(`UPDATE identity.payment_void_requests SET status = 'APPROVED' WHERE void_request_id = $1`, [gucVoidId])
            ).rejects.toThrow(/Direct update of payment_void_requests to APPROVED is prohibited/);
        } finally {
            await client.query('RESET ROLE');
        }
    });

    test('36. Payment Execution Authorization and Settlement Evidence (AI-2B.6.3 Finding 1)', async () => {
        if (!isDbAvailable) return;

        // Create APPROVED fixture instruction
        const instRes = await client.query(`
            INSERT INTO instructions (amount, currency, sender, recipient, destination_account, provider, environment, purpose, state, approval_status, version)
            VALUES (88000, 'USD', 'corp_treasury', 'vendor_exec_36', 'acc_dest_36', 'STRIPE_TEST', 'sandbox', 'EXECUTION_AUTH_TEST', 'APPROVED', 'APPROVED', 1)
            RETURNING instruction_id;
        `);
        const instId = instRes.rows[0].instruction_id;

        // Switch to fusion_app_runtime role to test adversarial boundary
        await client.query('SET ROLE fusion_app_runtime');

        try {
            // 1. Mandatory Adversarial: Direct SQL execution of an APPROVED instruction is blocked
            await expect(
                client.query(`UPDATE public.instructions SET state = 'EXECUTED' WHERE instruction_id = $1`, [instId])
            ).rejects.toThrow(/Direct transition of instruction .* to EXECUTED is prohibited/);

            // 2. Mandatory Adversarial: Direct SQL settlement of an APPROVED instruction is blocked
            await expect(
                client.query(`UPDATE public.instructions SET state = 'SETTLED' WHERE instruction_id = $1`, [instId])
            ).rejects.toThrow(/Direct transition of instruction .* to SETTLED is prohibited/);

            // 3. Execution without provider dispatch record / invalid parameters:
            // 3a. Missing idempotency key
            await expect(
                client.query(`SELECT identity.fn_execute_payment_instruction($1, $2, $3, $4, $5, $6)`,
                    [instId, opMaker, '', 'STRIPE_TEST', 'sandbox', JSON.stringify({ intent_id: 'pi_36_0' })])
            ).rejects.toThrow(/p_idempotency_key is required/);

            // 3b. Non-allowlisted provider
            await expect(
                client.query(`SELECT identity.fn_execute_payment_instruction($1, $2, $3, $4, $5, $6)`,
                    [instId, opMaker, 'idem_36_bad_prov', 'LIVE_SWIFT_UNTRUSTED', 'sandbox', JSON.stringify({ intent_id: 'pi_36_1' })])
            ).rejects.toThrow(/not in permitted sandbox\/testnet provider allowlist/);

            // 3c. Non-allowlisted environment
            await expect(
                client.query(`SELECT identity.fn_execute_payment_instruction($1, $2, $3, $4, $5, $6)`,
                    [instId, opMaker, 'idem_36_bad_env', 'STRIPE_TEST', 'production_live', JSON.stringify({ intent_id: 'pi_36_2' })])
            ).rejects.toThrow(/not in permitted sandbox\/testnet environment allowlist/);

            // 4. Settle without execution evidence:
            // 4a. Random dispatch_id
            await expect(
                client.query(`SELECT identity.fn_settle_payment_instruction($1, $2, $3, $4)`,
                    [instId, '00000000-0000-4000-8000-999999999999', 'pi_fake', JSON.stringify({ proof: 'none' })])
            ).rejects.toThrow(/Instruction .* must be in EXECUTED state before settlement|No authorized dispatch record .* found/);

            // 5. Legitimate execution via identity.fn_execute_payment_instruction
            const idemKey = `idem_exec_36_${Date.now()}`;
            const providerResult = {
                intent_id: 'pi_test_stripe_exec_36',
                status: 'succeeded',
                amount: 88000,
                currency: 'USD',
            };
            const execRes = await client.query(`
                SELECT identity.fn_execute_payment_instruction($1, $2, $3, $4, $5, $6) AS result
            `, [instId, opMaker, idemKey, 'STRIPE_TEST', 'sandbox', JSON.stringify(providerResult)]);

            expect(execRes.rows[0].result.status).toBe('EXECUTED');
            expect(execRes.rows[0].result.instruction_id).toBe(instId);
            const dispatchId = execRes.rows[0].result.dispatch_id;
            expect(dispatchId).toBeDefined();

            // Verify state in instructions table is now EXECUTED
            const checkExec = await client.query('SELECT state FROM instructions WHERE instruction_id = $1', [instId]);
            expect(checkExec.rows[0].state).toBe('EXECUTED');

            // 6. Mandatory Adversarial: Execute same instruction twice (blocked)
            await expect(
                client.query(`SELECT identity.fn_execute_payment_instruction($1, $2, $3, $4, $5, $6)`,
                    [instId, opMaker, `idem_exec_36_dup_${Date.now()}`, 'STRIPE_TEST', 'sandbox', JSON.stringify(providerResult)])
            ).rejects.toThrow(/has already been executed|duplicate execution blocked/);

            // 7. Mandatory Adversarial: Settle without valid dispatch record matching instruction
            const otherInstRes = await client.query(`
                SELECT instruction_id FROM instructions WHERE state = 'APPROVED' AND instruction_id <> $1 LIMIT 1
            `, [instId]);
            if (otherInstRes.rows.length > 0) {
                const otherId = otherInstRes.rows[0].instruction_id;
                await expect(
                    client.query(`SELECT identity.fn_settle_payment_instruction($1, $2, $3, $4)`,
                        [otherId, dispatchId, 'pi_test_stripe_exec_36', JSON.stringify({ verified: true })])
                ).rejects.toThrow(/Instruction .* must be in EXECUTED state before settlement|belongs to instruction .* not instruction/);
            }

            // 8. Mandatory Adversarial: Substitute provider transaction reference (anti-tamper)
            await expect(
                client.query(`SELECT identity.fn_settle_payment_instruction($1, $2, $3, $4)`,
                    [instId, dispatchId, 'pi_SUBSTITUTED_TAMPERED_REFERENCE', JSON.stringify({ proof: 'forged' })])
            ).rejects.toThrow(/substitution blocked/i);

            // 9. Legitimate settlement via identity.fn_settle_payment_instruction
            const settleRes = await client.query(`
                SELECT identity.fn_settle_payment_instruction($1, $2, $3, $4) AS result
            `, [instId, dispatchId, 'pi_test_stripe_exec_36', JSON.stringify({ confirmed: true, rail: 'STRIPE_TEST' })]);

            expect(settleRes.rows[0].result.status).toBe('SETTLED');
            expect(settleRes.rows[0].result.instruction_id).toBe(instId);

            // Verify state in instructions table is now SETTLED
            const checkSettle = await client.query('SELECT state, utr, external_intent_id FROM instructions WHERE instruction_id = $1', [instId]);
            expect(checkSettle.rows[0].state).toBe('SETTLED');
            expect(checkSettle.rows[0].external_intent_id).toBe('pi_test_stripe_exec_36');

            // 10. Mandatory Adversarial: Settle same instruction twice (blocked)
            await expect(
                client.query(`SELECT identity.fn_settle_payment_instruction($1, $2, $3, $4)`,
                    [instId, dispatchId, 'pi_test_stripe_exec_36', JSON.stringify({ retry: true })])
            ).rejects.toThrow(/is already SETTLED|duplicate settlement blocked/);

            // 11. Mandatory Adversarial: Attempt to execute or settle a VOIDED instruction
            const voidedRes = await client.query(`
                SELECT instruction_id FROM instructions WHERE state = 'VOIDED' LIMIT 1
            `);
            if (voidedRes.rows.length > 0) {
                const voidedId = voidedRes.rows[0].instruction_id;

                await expect(
                    client.query(`SELECT identity.fn_execute_payment_instruction($1, $2, $3, $4, $5, $6)`,
                        [voidedId, opMaker, `idem_voided_${Date.now()}`, 'STRIPE_TEST', 'sandbox', JSON.stringify({ test: true })])
                ).rejects.toThrow(/is VOIDED and cannot be executed/);

                await expect(
                    client.query(`SELECT identity.fn_settle_payment_instruction($1, $2, $3, $4)`,
                        [voidedId, dispatchId, 'pi_voided_attempt', JSON.stringify({ test: true })])
                ).rejects.toThrow(/is VOIDED and cannot be settled/);
            }

            // 12. Mandatory Adversarial: Tamper resistance on evidence tables (INSERT, UPDATE, DELETE denied)
            await expect(
                client.query(`
                    INSERT INTO identity.payment_dispatch_records (instruction_id, idempotency_key, provider, environment, provider_result)
                    VALUES ($1, 'fake_idem_app_runtime', 'STRIPE_TEST', 'sandbox', '{}')
                `, [instId])
            ).rejects.toThrow(/permission denied/);

            await expect(
                client.query(`
                    INSERT INTO identity.payment_settlement_evidence (instruction_id, dispatch_id, provider_tx_reference, provider, evidence_payload)
                    VALUES ($1, $2, 'fake_ref', 'STRIPE_TEST', '{}')
                `, [instId, dispatchId])
            ).rejects.toThrow(/permission denied/);

            await expect(
                client.query(`DELETE FROM identity.payment_dispatch_records WHERE instruction_id = $1`, [instId])
            ).rejects.toThrow(/permission denied/);

            await expect(
                client.query(`DELETE FROM identity.payment_settlement_evidence WHERE instruction_id = $1`, [instId])
            ).rejects.toThrow(/permission denied/);

        } finally {
            await client.query('RESET ROLE');
        }
    });

    test('37. WebAuthn Verifier Process and Role Isolation (AI-2B.6.3 Finding 2)', async () => {
        if (!isDbAvailable) return;

        // Switch to fusion_app_runtime role to test credential & assertion isolation
        await client.query('SET ROLE fusion_app_runtime');

        try {
            // 1. fusion_app_runtime CANNOT execute fn_record_verified_webauthn_assertion
            await expect(
                client.query(`SELECT identity.fn_record_verified_webauthn_assertion($1::uuid, $2::uuid, $3, $4, $5)`,
                    [
                        '00000000-0000-4000-8000-111111111111',
                        opChecker,
                        'cred_test_37',
                        'a'.repeat(64),
                        'b'.repeat(64)
                    ]
                )
            ).rejects.toThrow(/permission denied/);

            // 2. fusion_app_runtime CANNOT insert directly into verified_webauthn_assertions
            await expect(
                client.query(`
                    INSERT INTO identity.verified_webauthn_assertions (challenge_id, operator_id, credential_id, signature_hash, context_digest)
                    VALUES ('00000000-0000-4000-8000-111111111111', $1, 'cred_fake', 'sig_fake', 'digest_fake')
                `, [opChecker])
            ).rejects.toThrow(/permission denied/);

            // 3. fusion_app_runtime CANNOT update or delete verified_webauthn_assertions
            await expect(
                client.query(`UPDATE identity.verified_webauthn_assertions SET consumed_at = NOW()`)
            ).rejects.toThrow(/permission denied/);

            await expect(
                client.query(`DELETE FROM identity.verified_webauthn_assertions`)
            ).rejects.toThrow(/permission denied/);

        } finally {
            await client.query('RESET ROLE');
        }

        // Direct session as fusion_app_runtime: verify SET ROLE rejections
        const appPool37 = new Pool({
            user: 'fusion_app_runtime',
            password: 'fusion_app_runtime_secret_test',
            host: process.env.DB_HOST || '127.0.0.1',
            port: parseInt(process.env.DB_PORT || '5432', 10),
            database: process.env.DB_NAME || 'postgres',
        });

        let appClient37;
        try {
            appClient37 = await appPool37.connect();

            // 4. fusion_app_runtime CANNOT assume fusion_webauthn_verifier role
            await expect(
                appClient37.query('SET ROLE fusion_webauthn_verifier')
            ).rejects.toThrow(/permission denied|must be/);

            // 5. fusion_app_runtime CANNOT assume fusion_workflow_definer role
            await expect(
                appClient37.query('SET ROLE fusion_workflow_definer')
            ).rejects.toThrow(/permission denied|must be/);
        } finally {
            if (appClient37) appClient37.release();
            await appPool37.end();
        }

        // Direct session as fusion_webauthn_verifier: verify least privilege
        const verifierPool37 = new Pool({
            user: 'fusion_webauthn_verifier',
            password: 'fusion_webauthn_verifier_secret_test',
            host: process.env.DB_HOST || '127.0.0.1',
            port: parseInt(process.env.DB_PORT || '5432', 10),
            database: process.env.DB_NAME || 'postgres',
        });

        let vClient37;
        try {
            vClient37 = await verifierPool37.connect();

            // Verifier CANNOT execute fn_execute_payment_instruction
            await expect(
                vClient37.query(`SELECT identity.fn_execute_payment_instruction($1, $2, $3, $4, $5, $6)`,
                    ['00000000-0000-4000-8000-111111111111', opMaker, 'idem_v_37', 'STRIPE_TEST', 'sandbox', '{}'])
            ).rejects.toThrow(/permission denied/);

            // Verifier CANNOT execute fn_settle_payment_instruction
            await expect(
                vClient37.query(`SELECT identity.fn_settle_payment_instruction($1, $2, $3, $4)`,
                    ['00000000-0000-4000-8000-111111111111', '00000000-0000-4000-8000-222222222222', 'ref_v_37', '{}'])
            ).rejects.toThrow(/permission denied/);

            // Verifier CANNOT execute fn_approve_payment_instruction
            await expect(
                vClient37.query(`SELECT identity.fn_approve_payment_instruction($1, $2, $3, $4, $5, $6, $7)`,
                    ['00000000-0000-4000-8000-111111111111', '00000000-0000-4000-8000-222222222222', opChecker, null, 'digest', 'notes', 'none'])
            ).rejects.toThrow(/permission denied/);

            // Verifier CANNOT insert into payment_dispatch_records
            await expect(
                vClient37.query(`
                    INSERT INTO identity.payment_dispatch_records (instruction_id, idempotency_key, provider, environment, provider_result)
                    VALUES ('00000000-0000-4000-8000-111111111111', 'idem_v_fake', 'STRIPE_TEST', 'sandbox', '{}')
                `)
            ).rejects.toThrow(/permission denied/);

            // Verifier CANNOT insert into payment_settlement_evidence
            await expect(
                vClient37.query(`
                    INSERT INTO identity.payment_settlement_evidence (instruction_id, dispatch_id, provider_tx_reference, provider, evidence_payload)
                    VALUES ('00000000-0000-4000-8000-111111111111', '00000000-0000-4000-8000-222222222222', 'ref_v_fake', 'STRIPE_TEST', '{}')
                `)
            ).rejects.toThrow(/permission denied/);

        } finally {
            if (vClient37) vClient37.release();
            await verifierPool37.end();
        }
    });

    test('38. Adversarial Execution and Settlement Function Authorization & Evidence Integrity (AI-2B Final Verification)', async () => {
        if (!isDbAvailable) return;

        // Operators
        const opAuthorized = opMaker; // dev-ops (Operations Operator, has payment:initiate)
        const opAuditor = '00000000-0000-4000-8000-000000000003'; // dev-auditor (Auditor, lacks payment permissions)
        const opInvented = '00000000-dead-beef-cafe-000000000001'; // Invented operator ID

        // Create test instruction fixture in APPROVED state
        const instRes = await client.query(`
            INSERT INTO instructions (
                amount, currency, sender, recipient, destination_account,
                provider, environment, purpose, state, approval_status, version
            ) VALUES (
                35000, 'USD', 'corp_treasury', 'adversarial_vendor_38', 'acc_adv_38',
                'STRIPE_TEST', 'sandbox', 'ADVERSARIAL_TEST_38', 'APPROVED', 'APPROVED', 1
            ) RETURNING instruction_id;
        `);
        const instId = instRes.rows[0].instruction_id;

        // Switch to fusion_app_runtime
        await client.query('SET ROLE fusion_app_runtime');

        try {
            // 1. Direct invocation with invented operator ID (blocked)
            await expect(
                client.query(
                    'SELECT identity.fn_execute_payment_instruction($1, $2, $3, $4, $5, $6)',
                    [instId, opInvented, 'idem_test_38_1', 'STRIPE_TEST', 'sandbox', JSON.stringify({ intent_id: 'pi_test_38_1', status: 'succeeded' })]
                )
            ).rejects.toThrow(/not authorized for payment execution dispatch/);

            // 2a. Supply fabricated failed provider_result (blocked)
            await expect(
                client.query(
                    'SELECT identity.fn_execute_payment_instruction($1, $2, $3, $4, $5, $6)',
                    [instId, opAuthorized, 'idem_test_38_2a', 'STRIPE_TEST', 'sandbox', JSON.stringify({ status: 'FAILED', intent_id: 'pi_fail' })]
                )
            ).rejects.toThrow(/Provider execution result indicates failure or unverified status/);

            // 2b. Supply fabricated provider_result missing mandatory intent_id/tx_hash/utr (blocked)
            await expect(
                client.query(
                    'SELECT identity.fn_execute_payment_instruction($1, $2, $3, $4, $5, $6)',
                    [instId, opAuthorized, 'idem_test_38_2b', 'STRIPE_TEST', 'sandbox', JSON.stringify({ status: 'succeeded', forged: true })]
                )
            ).rejects.toThrow(/missing mandatory provider reference/);

            // 3. Simulated provider without simulation markers (blocked)
            await expect(
                client.query(
                    'SELECT identity.fn_execute_payment_instruction($1, $2, $3, $4, $5, $6)',
                    [instId, opAuthorized, 'idem_test_38_3', 'SIMULATED_BTC', 'sandbox', JSON.stringify({ status: 'succeeded', intent_id: 'real_looking_hash' })]
                )
            ).rejects.toThrow(/requires explicit simulation markers/);

            // 4. Operator lacking required authorization (Auditor blocked)
            await expect(
                client.query(
                    'SELECT identity.fn_execute_payment_instruction($1, $2, $3, $4, $5, $6)',
                    [instId, opAuditor, 'idem_test_38_4', 'STRIPE_TEST', 'sandbox', JSON.stringify({ status: 'succeeded', intent_id: 'pi_test_38_4' })]
                )
            ).rejects.toThrow(/not authorized for payment execution dispatch/);

            // Legitimate execution with authorized operator
            const idemKey = 'idem_legit_38_' + Date.now();
            const execRes = await client.query(
                'SELECT identity.fn_execute_payment_instruction($1, $2, $3, $4, $5, $6) AS res',
                [instId, opAuthorized, idemKey, 'STRIPE_TEST', 'sandbox', JSON.stringify({ status: 'succeeded', intent_id: 'pi_test_legit_38', amount: 35000 })]
            );
            expect(execRes.rows[0].res.status).toBe('EXECUTED');
            const dispatchId = execRes.rows[0].res.dispatch_id;
            expect(dispatchId).toBeDefined();

            // 5a. Settle with failed evidence_payload (blocked)
            await expect(
                client.query(
                    'SELECT identity.fn_settle_payment_instruction($1, $2, $3, $4)',
                    [instId, dispatchId, 'pi_test_legit_38', JSON.stringify({ status: 'FAILED' })]
                )
            ).rejects.toThrow(/indicates failed or rejected status/);

            // 5b. Settle with unconfirmed arbitrary evidence payload (blocked)
            await expect(
                client.query(
                    'SELECT identity.fn_settle_payment_instruction($1, $2, $3, $4)',
                    [instId, dispatchId, 'pi_test_legit_38', JSON.stringify({ arbitrary_field: 'unverified' })]
                )
            ).rejects.toThrow(/lacks verifiable confirmation indicators/);

            // 6. Fabricated substituted transaction reference (blocked)
            await expect(
                client.query(
                    'SELECT identity.fn_settle_payment_instruction($1, $2, $3, $4)',
                    [instId, dispatchId, 'pi_test_FABRICATED_REF_999', JSON.stringify({ confirmed: true })]
                )
            ).rejects.toThrow(/substitution blocked/i);

            // Legitimate settlement
            const settleRes = await client.query(
                'SELECT identity.fn_settle_payment_instruction($1, $2, $3, $4) AS res',
                [instId, dispatchId, 'pi_test_legit_38', JSON.stringify({ confirmed: true, rail: 'STRIPE_TEST' })]
            );
            expect(settleRes.rows[0].res.status).toBe('SETTLED');

            // 7. Duplicate execution and settlement (blocked)
            await expect(
                client.query(
                    'SELECT identity.fn_execute_payment_instruction($1, $2, $3, $4, $5, $6)',
                    [instId, opAuthorized, 'idem_dup_38_' + Date.now(), 'STRIPE_TEST', 'sandbox', JSON.stringify({ status: 'succeeded', intent_id: 'pi_test_legit_38' })]
                )
            ).rejects.toThrow(/duplicate execution blocked/);

            await expect(
                client.query(
                    'SELECT identity.fn_settle_payment_instruction($1, $2, $3, $4)',
                    [instId, dispatchId, 'pi_test_legit_38', JSON.stringify({ confirmed: true })]
                )
            ).rejects.toThrow(/duplicate settlement blocked/);

            // 8. Substitute another instruction dispatch reference (blocked)
            const otherInstRes = await client.query(`
                SELECT instruction_id FROM instructions WHERE state = 'APPROVED' AND instruction_id <> $1 LIMIT 1
            `, [instId]);
            if (otherInstRes.rows.length > 0) {
                const otherId = otherInstRes.rows[0].instruction_id;
                await expect(
                    client.query(
                        'SELECT identity.fn_settle_payment_instruction($1, $2, $3, $4)',
                        [otherId, dispatchId, 'pi_test_legit_38', JSON.stringify({ confirmed: true })]
                    )
                ).rejects.toThrow(/must be in EXECUTED state before settlement|belongs to instruction .* not instruction/);
            }

        } finally {
            await client.query('RESET ROLE');
        }
    });
});
