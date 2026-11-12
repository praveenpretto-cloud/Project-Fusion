'use strict';

/**
 * PROJECT FUSION — PHASE AI-2B UNIT TEST SUITE
 * ============================================
 * Comprehensive verification of:
 * 1. AI-2A.2 Preflight Corrections (RFC 6749 form-url-encoding, cross-host JWKS allowlist)
 * 2. Enterprise RBAC Roles, Permissions, and Assignment Lifecycle
 * 3. Central RBAC Middleware (requirePermission, requireAnyRole, default-deny)
 * 4. FIDO2 / WebAuthn Cryptographic Assertion Verification & Challenge Replay Defense
 * 5. Four-Eyes Maker-Checker Separation of Duties & Concurrency Control
 * 6. AI Permission Boundary (Zero mutation/approval authority for AI agents)
 */

const crypto = require('crypto');
const {
    ROLES,
    SENSITIVE_ROLES,
    PERMISSIONS,
    RbacService,
} = require('../../core/identity/rbacService');
const {
    WebAuthnService,
    computePaymentContextDigest,
    ALLOWED_PAYMENT_CONTEXT_ACTIONS,
} = require('../../core/identity/webauthnService');
const {
    MakerCheckerService,
    APPROVAL_STATUS,
} = require('../../core/approvals/makerCheckerService');
const {
    requirePermission,
    requireAnyRole,
} = require('../../core/identity/authMiddleware');
const {
    OidcClient,
    rfc6749FormUrlEncode,
} = require('../../core/identity/oidcClient');
const {
    validateEnvironment,
    assertPermittedProvider,
    assertPermittedEndpoint,
    assertPermittedNetwork,
    assertPermittedEnvironment,
    validateSimulationAdapter,
    validateProviderCredentialMode,
} = require('../../core/configValidator');

describe('Project Fusion — Phase AI-2B: Enterprise RBAC & Maker-Checker', () => {

    // =========================================================================
    // 1. PREFLIGHT CORRECTIONS (AI-2A.2 Gaps)
    // =========================================================================
    describe('1. AI-2A.2 Preflight Corrections', () => {
        test('rfc6749FormUrlEncode encodes spaces to "+" and reserved chars to "%HH"', () => {
            const raw = 'my client!*() with spaces & special ~ chars';
            const encoded = rfc6749FormUrlEncode(raw);

            // Space replaced by +
            expect(encoded).toContain('+');
            expect(encoded).not.toContain('%20');

            // RFC 6749 form-urlencoded reserved characters must be percent-encoded
            expect(encoded).toContain('%21'); // '!'
            expect(encoded).toContain('%2A'); // '*'
            expect(encoded).toContain('%28'); // '('
            expect(encoded).toContain('%29'); // ')'
            expect(encoded).toContain('%26'); // '&'

            // Unreserved characters like '~' are preserved
            expect(encoded).toContain('~');
        });

        test('OIDC client permits cross-host JWKS when host is in allowedJwksHosts allowlist', async () => {
            const mockKeys = [
                {
                    kid: 'google-key-1',
                    publicKey: 'MOCK_PUBLIC_KEY',
                },
            ];

            // Synthetic Google configuration: issuer accounts.google.com, JWKS www.googleapis.com
            const oidc = new OidcClient({
                issuer: 'https://accounts.google.com',
                clientId: 'google-enterprise-client',
                jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
                allowedJwksHosts: ['www.googleapis.com'],
                jwksFetcher: async () => mockKeys,
            });

            const keys = await oidc.fetchJwks();
            expect(keys.has('google-key-1')).toBe(true);
        });

        test('OIDC client rejects cross-host JWKS when host is NOT in allowlist', async () => {
            const oidc = new OidcClient({
                issuer: 'https://idp.corporate.com',
                clientId: 'corporate-client',
                jwksUri: 'https://attacker.evil.com/jwks',
                allowedJwksHosts: ['keys.corporate.com'], // attacker not in list
            });

            await expect(oidc.fetchJwks()).rejects.toThrow(
                /Untrusted JWKS endpoint: host "attacker.evil.com" does not match issuer "idp.corporate.com"/
            );
        });
    });

    // =========================================================================
    // 2. ENTERPRISE RBAC ROLES & PERMISSION HIERARCHY
    // =========================================================================
    describe('2. Enterprise RBAC Roles & Permissions', () => {
        let rbac;

        beforeEach(() => {
            rbac = new RbacService();
        });

        test('defines the 5 standard enterprise roles', () => {
            expect(ROLES.OPS_OPERATOR).toBe('OPS_OPERATOR');
            expect(ROLES.TREASURY_ANALYST).toBe('TREASURY_ANALYST');
            expect(ROLES.COMPLIANCE_OFFICER).toBe('COMPLIANCE_OFFICER');
            expect(ROLES.SYSTEM_ADMIN).toBe('SYSTEM_ADMIN');
            expect(ROLES.AUDITOR).toBe('AUDITOR');
        });

        test('OPS_OPERATOR has initiate permission but NOT approve permission', async () => {
            const opId = '00000000-0000-4000-8000-000000000002'; // dev-ops
            const permissions = await rbac.getOperatorPermissions(opId);

            expect(permissions.has(PERMISSIONS.PAYMENT_INITIATE)).toBe(true);
            expect(permissions.has(PERMISSIONS.PAYMENT_READ)).toBe(true);
            expect(permissions.has(PERMISSIONS.EVIDENCE_READ)).toBe(true);
            expect(permissions.has(PERMISSIONS.PAYMENT_APPROVE)).toBe(false);
            expect(permissions.has(PERMISSIONS.PAYMENT_REJECT)).toBe(false);
        });

        test('TREASURY_ANALYST is Checker with approve, reject, sensitive read, but NOT initiate permission', async () => {
            const cfoId = '00000000-0000-4000-8000-000000000001'; // dev-cfo
            const permissions = await rbac.getOperatorPermissions(cfoId);

            expect(permissions.has(PERMISSIONS.PAYMENT_APPROVE)).toBe(true);
            expect(permissions.has(PERMISSIONS.PAYMENT_REJECT)).toBe(true);
            expect(permissions.has(PERMISSIONS.PAYMENT_READ)).toBe(true);
            expect(permissions.has(PERMISSIONS.PAYMENT_READ_SENSITIVE)).toBe(true);
            expect(permissions.has(PERMISSIONS.TREASURY_READ)).toBe(true);
            expect(permissions.has(PERMISSIONS.TREASURY_MANAGE)).toBe(true);
            expect(permissions.has(PERMISSIONS.PAYMENT_INITIATE)).toBe(false); // Treasury is Checker, NOT Maker
        });

        test('COMPLIANCE_OFFICER has compliance hold and release but CANNOT approve or initiate payments', async () => {
            const compId = '00000000-0000-4000-8000-000000000004'; // dev-compliance
            const permissions = await rbac.getOperatorPermissions(compId);

            expect(permissions.has(PERMISSIONS.COMPLIANCE_READ)).toBe(true);
            expect(permissions.has(PERMISSIONS.COMPLIANCE_WRITE)).toBe(true);
            expect(permissions.has(PERMISSIONS.COMPLIANCE_HOLD)).toBe(true);
            expect(permissions.has(PERMISSIONS.COMPLIANCE_RELEASE)).toBe(true);
            expect(permissions.has(PERMISSIONS.PAYMENT_READ)).toBe(true);
            expect(permissions.has(PERMISSIONS.PAYMENT_READ_SENSITIVE)).toBe(true);
            expect(permissions.has(PERMISSIONS.EVIDENCE_READ)).toBe(true);

            // Compliance Officer CANNOT approve payments merely by virtue of role
            expect(permissions.has(PERMISSIONS.PAYMENT_APPROVE)).toBe(false);
            expect(permissions.has(PERMISSIONS.PAYMENT_REJECT)).toBe(false);
            expect(permissions.has(PERMISSIONS.PAYMENT_INITIATE)).toBe(false);
        });

        test('SYSTEM_ADMIN has admin and config permissions with ZERO financial visibility', async () => {
            const adminId = '00000000-0000-4000-8000-000000000005'; // dev-admin
            const permissions = await rbac.getOperatorPermissions(adminId);

            expect(permissions.has(PERMISSIONS.ADMIN_MANAGE_ROLES)).toBe(true);
            expect(permissions.has(PERMISSIONS.ADMIN_MANAGE_OPERATORS)).toBe(true);
            expect(permissions.has(PERMISSIONS.SYSTEM_CONFIG)).toBe(true);
            expect(permissions.has(PERMISSIONS.AUDIT_READ)).toBe(true);

            // Stripped of payment read, initiate, and approve
            expect(permissions.has(PERMISSIONS.PAYMENT_READ)).toBe(false);
            expect(permissions.has(PERMISSIONS.PAYMENT_INITIATE)).toBe(false);
            expect(permissions.has(PERMISSIONS.PAYMENT_APPROVE)).toBe(false);
        });

        test('AUDITOR has masked evidence and audit read with zero mutating or payment approval permissions', async () => {
            const auditorId = '00000000-0000-4000-8000-000000000003'; // dev-auditor
            const permissions = await rbac.getOperatorPermissions(auditorId);

            expect(permissions.has(PERMISSIONS.AUDIT_READ)).toBe(true);
            expect(permissions.has(PERMISSIONS.EVIDENCE_READ)).toBe(true);
            expect(permissions.has(PERMISSIONS.TREASURY_READ)).toBe(true);
            expect(permissions.has(PERMISSIONS.COMPLIANCE_READ)).toBe(true);

            // Zero mutating permissions
            expect(permissions.has(PERMISSIONS.PAYMENT_READ)).toBe(false);
            expect(permissions.has(PERMISSIONS.PAYMENT_INITIATE)).toBe(false);
            expect(permissions.has(PERMISSIONS.PAYMENT_APPROVE)).toBe(false);
            expect(permissions.has(PERMISSIONS.PAYMENT_REJECT)).toBe(false);
            expect(permissions.has(PERMISSIONS.ADMIN_MANAGE_ROLES)).toBe(false);
        });

        test('defends against self-elevation: operators cannot grant roles to themselves', async () => {
            const adminId = '00000000-0000-4000-8000-000000000005';

            await expect(
                rbac.assignRoleToOperator({
                    operatorId: adminId,
                    roleKey: ROLES.TREASURY_ANALYST,
                    assignedBy: adminId, // Self-elevation attempt
                })
            ).rejects.toThrow(/Self-elevation prohibited: operators cannot grant roles to themselves/);
        });

        test('assignRoleToOperator and revokeRoleFromOperator record before-and-after snapshots in audit logs', async () => {
            const testOpId = 'test-operator-assign';
            const adminId = '00000000-0000-4000-8000-000000000005';

            const assignRes = await rbac.assignRoleToOperator({
                operatorId: testOpId,
                roleKey: ROLES.OPS_OPERATOR,
                assignedBy: adminId,
            });

            expect(assignRes.beforeRoles).toEqual([]);
            expect(assignRes.afterRoles).toContain(ROLES.OPS_OPERATOR);

            const assignAudit = rbac.inMemoryAuditLogs.find((l) => l.eventType === 'ROLE_ASSIGNED');
            expect(assignAudit).toBeDefined();
            expect(assignAudit.metadata.beforeRoles).toEqual([]);
            expect(assignAudit.metadata.afterRoles).toContain(ROLES.OPS_OPERATOR);

            const revokeRes = await rbac.revokeRoleFromOperator({
                operatorId: testOpId,
                roleKey: ROLES.OPS_OPERATOR,
                revokedBy: adminId,
            });

            expect(revokeRes.beforeRoles).toContain(ROLES.OPS_OPERATOR);
            expect(revokeRes.afterRoles).not.toContain(ROLES.OPS_OPERATOR);

            const revokeAudit = rbac.inMemoryAuditLogs.find((l) => l.eventType === 'ROLE_REVOKED');
            expect(revokeAudit).toBeDefined();
            expect(revokeAudit.metadata.beforeRoles).toContain(ROLES.OPS_OPERATOR);
            expect(revokeAudit.metadata.afterRoles).not.toContain(ROLES.OPS_OPERATOR);
        });

        test('assertPermission fails closed with 403 when permission is missing', async () => {
            const opId = '00000000-0000-4000-8000-000000000002'; // OPS_OPERATOR
            await expect(
                rbac.assertPermission(opId, PERMISSIONS.PAYMENT_APPROVE)
            ).rejects.toThrow(/Access denied: operator lacks required permission/);

            const denialAudit = rbac.inMemoryAuditLogs.find((l) => l.eventType === 'PERMISSION_DENIED');
            expect(denialAudit).toBeDefined();
            expect(denialAudit.metadata.attemptedPermission).toBe(PERMISSIONS.PAYMENT_APPROVE);
        });
    });

    // =========================================================================
    // 3. CENTRAL RBAC MIDDLEWARE
    // =========================================================================
    describe('3. Central RBAC Middleware', () => {
        let rbac;

        beforeEach(() => {
            rbac = new RbacService();
        });

        test('requirePermission returns 401 when operator is not authenticated', async () => {
            const middleware = requirePermission(PERMISSIONS.PAYMENT_INITIATE, { rbacService: rbac });
            const req = { path: '/api/payout', method: 'POST' };
            const res = {
                status: jest.fn().mockReturnThis(),
                json: jest.fn(),
            };
            const next = jest.fn();

            await middleware(req, res, next);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(next).not.toHaveBeenCalled();
        });

        test('requirePermission allows request when operator possesses permission', async () => {
            const middleware = requirePermission(PERMISSIONS.PAYMENT_INITIATE, { rbacService: rbac });
            const req = {
                path: '/api/payout',
                method: 'POST',
                operator: { operatorId: '00000000-0000-4000-8000-000000000002' }, // OPS_OPERATOR
            };
            const res = {
                status: jest.fn().mockReturnThis(),
                json: jest.fn(),
            };
            const next = jest.fn();

            await middleware(req, res, next);
            expect(next).toHaveBeenCalled();
            expect(req.permissions).toContain(PERMISSIONS.PAYMENT_INITIATE);
        });

        test('requirePermission returns 403 Forbidden when operator lacks permission', async () => {
            const middleware = requirePermission(PERMISSIONS.PAYMENT_APPROVE, { rbacService: rbac });
            const req = {
                path: '/api/approvals/approve',
                method: 'POST',
                operator: { operatorId: '00000000-0000-4000-8000-000000000002' }, // OPS_OPERATOR lacks approve
            };
            const res = {
                status: jest.fn().mockReturnThis(),
                json: jest.fn(),
            };
            const next = jest.fn();

            await middleware(req, res, next);
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ error: 'Forbidden' })
            );
            expect(next).not.toHaveBeenCalled();
        });

        test('requireAnyRole permits matching role and blocks non-matching role', async () => {
            const middleware = requireAnyRole([ROLES.COMPLIANCE_OFFICER, ROLES.SYSTEM_ADMIN], { rbacService: rbac });
            const opReq = {
                path: '/api/compliance/logs',
                method: 'GET',
                operator: { operatorId: '00000000-0000-4000-8000-000000000002' }, // OPS_OPERATOR
            };
            const compReq = {
                path: '/api/compliance/logs',
                method: 'GET',
                operator: { operatorId: '00000000-0000-4000-8000-000000000004' }, // COMPLIANCE_OFFICER
            };
            const res = {
                status: jest.fn().mockReturnThis(),
                json: jest.fn(),
            };
            const next = jest.fn();

            await middleware(opReq, res, next);
            expect(res.status).toHaveBeenCalledWith(403);

            next.mockClear();
            await middleware(compReq, res, next);
            expect(next).toHaveBeenCalled();
        });
    });

    // =========================================================================
    // 4. WEBAUTHN / FIDO2 CRYPTOGRAPHIC SERVICE
    // =========================================================================
    describe('4. FIDO2 / WebAuthn Cryptographic Verification', () => {
        let webauthn;
        let testKeyPair;
        const operatorId = 'op_webauthn_test_01';
        const credentialId = 'cred_ec_secp256r1_01';

        beforeAll(() => {
            // Generate standard ECDSA P-256 (prime256v1) key pair
            testKeyPair = crypto.generateKeyPairSync('ec', {
                namedCurve: 'prime256v1',
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            });
        });

        beforeEach(async () => {
            webauthn = new WebAuthnService({ rpId: 'localhost', origin: 'http://localhost:3000' });
            // Register credential
            const regChallenge = await webauthn.generateChallenge({
                operatorId,
                ceremonyType: 'registration',
            });
            await webauthn.registerCredential({
                operatorId,
                credentialId,
                publicKeyPem: testKeyPair.publicKey,
                challenge: regChallenge.challenge,
            });
        });

        test('generates high-entropy single-use challenge with 5-minute TTL', async () => {
            const ch = await webauthn.generateChallenge({ operatorId });
            expect(ch.challenge).toBeDefined();
            expect(ch.challenge.length).toBeGreaterThan(32);
            expect(ch.rpId).toBe('localhost');
            expect(ch.expiresAt.getTime()).toBeGreaterThan(Date.now());
        });

        test('verifies legitimate cryptographic assertion generated by synthetic authenticator', async () => {
            const authChallenge = await webauthn.generateChallenge({ operatorId });

            const assertion = webauthn.createSyntheticAssertion({
                credentialId,
                privateKey: testKeyPair.privateKey,
                challenge: authChallenge.challenge,
                counter: 10,
            });

            const result = await webauthn.verifyAuthenticationAssertion({
                operatorId,
                credentialId,
                assertionResponse: assertion.response,
            });

            expect(result.verified).toBe(true);
            expect(result.counter).toBe(10);
        });

        test('rejects reused challenge (atomic challenge replay defense)', async () => {
            const authChallenge = await webauthn.generateChallenge({ operatorId });

            const assertion = webauthn.createSyntheticAssertion({
                credentialId,
                privateKey: testKeyPair.privateKey,
                challenge: authChallenge.challenge,
                counter: 11,
            });

            // First consumption succeeds
            await webauthn.verifyAuthenticationAssertion({
                operatorId,
                credentialId,
                assertionResponse: assertion.response,
            });

            // Replay attempt must fail
            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId,
                    credentialId,
                    assertionResponse: assertion.response,
                })
            ).rejects.toThrow(/already been consumed \(replay blocked\)/);
        });

        test('rejects assertion when authenticator counter regresses (clone detection)', async () => {
            const ch1 = await webauthn.generateChallenge({ operatorId });
            const assertion1 = webauthn.createSyntheticAssertion({
                credentialId,
                privateKey: testKeyPair.privateKey,
                challenge: ch1.challenge,
                counter: 50,
            });
            await webauthn.verifyAuthenticationAssertion({
                operatorId,
                credentialId,
                assertionResponse: assertion1.response,
            });

            // Second assertion with lower counter (clone attack)
            const ch2 = await webauthn.generateChallenge({ operatorId });
            const assertion2 = webauthn.createSyntheticAssertion({
                credentialId,
                privateKey: testKeyPair.privateKey,
                challenge: ch2.challenge,
                counter: 45, // < 50
            });

            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId,
                    credentialId,
                    assertionResponse: assertion2.response,
                })
            ).rejects.toThrow(/WebAuthn authenticator counter regression/);
        });

        test('rejects assertion with forged or tampered cryptographic signature', async () => {
            // Generate different key pair
            const forgedKeyPair = crypto.generateKeyPairSync('ec', {
                namedCurve: 'prime256v1',
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            });

            const authChallenge = await webauthn.generateChallenge({ operatorId });

            // Sign with wrong private key
            const assertion = webauthn.createSyntheticAssertion({
                credentialId,
                privateKey: forgedKeyPair.privateKey,
                challenge: authChallenge.challenge,
                counter: 12,
            });

            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId,
                    credentialId,
                    assertionResponse: assertion.response,
                })
            ).rejects.toThrow(/WebAuthn cryptographic assertion signature verification failed/);
        });

        test('rejects assertion from unauthorized foreign origin', async () => {
            const authChallenge = await webauthn.generateChallenge({ operatorId });

            const assertion = webauthn.createSyntheticAssertion({
                credentialId,
                privateKey: testKeyPair.privateKey,
                challenge: authChallenge.challenge,
                origin: 'https://evil-attacker.com',
                counter: 13,
            });

            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId,
                    credentialId,
                    assertionResponse: assertion.response,
                })
            ).rejects.toThrow(/Untrusted WebAuthn origin/);
        });

        test('rejects assertion when rpIdHash does not match expected RP ID', async () => {
            const authChallenge = await webauthn.generateChallenge({ operatorId });

            const assertion = webauthn.createSyntheticAssertion({
                credentialId,
                privateKey: testKeyPair.privateKey,
                challenge: authChallenge.challenge,
                rpId: 'wrong.rp.domain.com',
                counter: 14,
            });

            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId,
                    credentialId,
                    assertionResponse: assertion.response,
                })
            ).rejects.toThrow(/rpIdHash mismatch/);
        });

        test('rejects assertion if User Present (UP) bit is not set', async () => {
            const authChallenge = await webauthn.generateChallenge({ operatorId });

            const assertion = webauthn.createSyntheticAssertion({
                credentialId,
                privateKey: testKeyPair.privateKey,
                challenge: authChallenge.challenge,
                userPresent: false, // UP = 0
                counter: 15,
            });

            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId,
                    credentialId,
                    assertionResponse: assertion.response,
                })
            ).rejects.toThrow(/User presence \(UP\) flag not set/);
        });

        test('rejects assertion if User Verification (UV) bit is not set when requireUserVerification is true', async () => {
            const authChallenge = await webauthn.generateChallenge({ operatorId });

            const assertion = webauthn.createSyntheticAssertion({
                credentialId,
                privateKey: testKeyPair.privateKey,
                challenge: authChallenge.challenge,
                userPresent: true,
                userVerified: false, // UV = 0
                counter: 16,
            });

            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId,
                    credentialId,
                    assertionResponse: assertion.response,
                    requireUserVerification: true,
                })
            ).rejects.toThrow(/User verification \(UV\) flag required/);
        });
    });

    // =========================================================================
    // 5. MAKER-CHECKER FOUR-EYES PRINCIPLE & APPROVAL WORKFLOW
    // =========================================================================
    describe('5. Maker-Checker Four-Eyes Principle & Approval Security', () => {
        let rbac;
        let webauthn;
        let makerChecker;
        let testKeyPair;

        const makerId = '00000000-0000-4000-8000-000000000002';       // OPS_OPERATOR
        const checkerId = '00000000-0000-4000-8000-000000000001';     // TREASURY_ANALYST (Checker)
        const complianceId = '00000000-0000-4000-8000-000000000004';  // COMPLIANCE_OFFICER
        const auditorId = '00000000-0000-4000-8000-000000000003';     // AUDITOR
        const credentialId = 'cred_treasury_fido2';

        beforeAll(() => {
            testKeyPair = crypto.generateKeyPairSync('ec', {
                namedCurve: 'prime256v1',
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            });
        });

        beforeEach(async () => {
            rbac = new RbacService();
            webauthn = new WebAuthnService({ rpId: 'localhost', origin: 'http://localhost:3000' });
            makerChecker = new MakerCheckerService({
                rbacService: rbac,
                webauthnService: webauthn,
                stepUpThreshold: 100000,
                allowTestMockFallback: true,
            });

            // Register FIDO2 credential for Checker (TREASURY_ANALYST)
            const regCh = await webauthn.generateChallenge({
                operatorId: checkerId,
                ceremonyType: 'registration',
            });
            await webauthn.registerCredential({
                operatorId: checkerId,
                credentialId,
                publicKeyPem: testKeyPair.publicKey,
                challenge: regCh.challenge,
            });
        });

        test('Maker with payment:initiate submits instruction for approval successfully', async () => {
            const instructionId = 'inst_tx_101';
            const approval = await makerChecker.requestPaymentApproval({
                instructionId,
                makerOperatorId: makerId,
                amount: 500000,
                currency: 'INR',
                notes: 'Vendor invoice payment',
            });

            expect(approval.status).toBe(APPROVAL_STATUS.PENDING_APPROVAL);
            expect(approval.instructionId).toBe(instructionId);
            expect(approval.makerOperatorId).toBe(makerId);
        });

        test('Operator without payment:initiate cannot submit instruction for approval', async () => {
            const instructionId = 'inst_tx_unauth';
            await expect(
                makerChecker.requestPaymentApproval({
                    instructionId,
                    makerOperatorId: auditorId, // AUDITOR lacks initiate
                    amount: 50000,
                    currency: 'INR',
                })
            ).rejects.toThrow(/Access denied: operator lacks required permission "payment:initiate"/);
        });

        test('CRITICAL FOUR-EYES INVARIANT: Maker CANNOT approve their own payment instruction', async () => {
            const instructionId = 'inst_tx_self_approve';
            await makerChecker.requestPaymentApproval({
                instructionId,
                makerOperatorId: makerId,
                amount: 25000,
                currency: 'USD',
            });

            // Even if the maker temporarily has payment:approve, Maker != Checker must fail-closed!
            await rbac.assignRoleToOperator({
                operatorId: makerId,
                roleKey: ROLES.TREASURY_ANALYST,
            });

            await expect(
                makerChecker.approvePayment({
                    instructionId,
                    checkerOperatorId: makerId, // Self-approval attempt
                    requireStepUp: false,
                })
            ).rejects.toThrow(/Maker-Checker violation: An operator cannot approve their own payment instruction/);

            // Verify security audit log captured the violation attempt
            const violationAudit = rbac.inMemoryAuditLogs.find((l) => l.eventType === 'MAKER_CHECKER_VIOLATION_BLOCKED');
            expect(violationAudit).toBeDefined();
            expect(violationAudit.operatorId).toBe(makerId);
        });

        test('Checker without payment:approve cannot approve instruction', async () => {
            const instructionId = 'inst_tx_no_approve_perm';
            await makerChecker.requestPaymentApproval({
                instructionId,
                makerOperatorId: makerId,
                amount: 50000,
                currency: 'INR',
            });

            const unauthChecker = '00000000-0000-4000-8000-000000000005'; // SYSTEM_ADMIN lacks approve
            await expect(
                makerChecker.approvePayment({
                    instructionId,
                    checkerOperatorId: unauthChecker,
                    requireStepUp: false,
                })
            ).rejects.toThrow(/Access denied: operator lacks required permission "payment:approve"/);
        });

        test('Compliance hold blocks payment approval until released by compliance officer', async () => {
            const instructionId = 'inst_tx_compliance_hold';
            await makerChecker.requestPaymentApproval({
                instructionId,
                makerOperatorId: makerId,
                amount: 50000,
                currency: 'INR',
            });

            // 1. Compliance officer places hold
            const holdRecord = await makerChecker.holdPayment({
                instructionId,
                officerOperatorId: complianceId,
                reason: 'Sanctions hit requires manual beneficial ownership verification',
            });
            expect(holdRecord.compliance_held).toBe(true);

            // 2. Checker attempt to approve must be blocked by compliance hold
            await expect(
                makerChecker.approvePayment({
                    instructionId,
                    checkerOperatorId: checkerId,
                    requireStepUp: false,
                })
            ).rejects.toThrow(/Payment instruction is under compliance hold and cannot be approved until released/);

            // 3. Operator without compliance:release cannot release hold
            await expect(
                makerChecker.releaseHold({
                    instructionId,
                    officerOperatorId: makerId, // OPS_OPERATOR lacks release
                    notes: 'Self release attempt',
                })
            ).rejects.toThrow(/Access denied: operator lacks required permission "compliance:release"/);

            // 4. Compliance officer releases hold
            const releaseRecord = await makerChecker.releaseHold({
                instructionId,
                officerOperatorId: complianceId,
                notes: 'Beneficial ownership verified against registry',
            });
            expect(releaseRecord.compliance_held).toBe(false);

            // 5. Checker can now approve
            const approved = await makerChecker.approvePayment({
                instructionId,
                checkerOperatorId: checkerId,
                requireStepUp: false,
                notes: 'Approved after compliance release',
            });
            expect(approved.status).toBe(APPROVAL_STATUS.APPROVED);
        });

        test('Independent Checker approves instruction with WebAuthn step-up assertion', async () => {
            const instructionId = 'inst_tx_step_up_success';
            await makerChecker.requestPaymentApproval({
                instructionId,
                makerOperatorId: makerId,
                amount: 250000, // Exceeds 100k threshold
                currency: 'INR',
            });

            const authCh = await webauthn.generateChallenge({ operatorId: checkerId });
            const assertion = webauthn.createSyntheticAssertion({
                credentialId,
                privateKey: testKeyPair.privateKey,
                challenge: authCh.challenge,
                counter: 1,
            });

            const approved = await makerChecker.approvePayment({
                instructionId,
                checkerOperatorId: checkerId,
                credentialId,
                webauthnAssertion: assertion.response,
                notes: 'Treasury verified and approved',
            });

            expect(approved.status).toBe(APPROVAL_STATUS.APPROVED);
            expect(approved.checkerOperatorId).toBe(checkerId);
            expect(approved.stepUpMethod).toBe('webauthn');
        });

        test('Checker rejects instruction with auditable reason', async () => {
            const instructionId = 'inst_tx_reject';
            await makerChecker.requestPaymentApproval({
                instructionId,
                makerOperatorId: makerId,
                amount: 15000,
                currency: 'EUR',
            });

            const rejected = await makerChecker.rejectPayment({
                instructionId,
                checkerOperatorId: checkerId,
                rejectionReason: 'Invalid sanctions clearance',
            });

            expect(rejected.status).toBe(APPROVAL_STATUS.REJECTED);
            expect(rejected.checkerOperatorId).toBe(checkerId);
            expect(rejected.rejectionReason).toBe('Invalid sanctions clearance');
        });

        test('Concurrent approval race: second approval attempt fails with 409 Conflict', async () => {
            const instructionId = 'inst_tx_race';
            await makerChecker.requestPaymentApproval({
                instructionId,
                makerOperatorId: makerId,
                amount: 5000,
                currency: 'USD',
            });

            // First approval succeeds
            await makerChecker.approvePayment({
                instructionId,
                checkerOperatorId: checkerId,
                requireStepUp: false,
            });

            // Second approval attempt on already approved instruction
            await expect(
                makerChecker.approvePayment({
                    instructionId,
                    checkerOperatorId: checkerId,
                    requireStepUp: false,
                })
            ).rejects.toThrow(/Cannot approve instruction in status "APPROVED"/);
        });
    });

    // =========================================================================
    // 6. AI PERMISSION BOUNDARY ENFORCEMENT
    // =========================================================================
    describe('6. AI Operations Intelligence Permission Boundary', () => {
        let rbac;

        beforeEach(() => {
            rbac = new RbacService();
        });

        test('assertAiBoundary strictly prohibits AI principal from mutating payments', () => {
            const aiPrincipal = {
                clientType: 'ai_agent',
                isAi: true,
                role: 'AI_COPILOT',
            };

            expect(() => {
                rbac.assertAiBoundary(aiPrincipal);
            }).toThrow(/AI operations intelligence is strictly read-only. Payment initiation and approval are prohibited./);
        });

        test('AI evidence module exports only read-only evidence retrieval functions', () => {
            const evidenceModule = require('../../core/ai/evidence');
            const exportedKeys = Object.keys(evidenceModule);

            // Must only contain query/evidence/verification functions, zero mutating actions
            for (const key of exportedKeys) {
                expect(key).not.toMatch(/^(initiate|approve|execute|transfer|payout|create|update|delete|insert)/i);
            }
        });
    });

    // =========================================================================
    // 7. WEBAUTHN PAYMENT CONTEXT BINDING & VERIFICATION (AI-2B.2)
    // =========================================================================
    describe('7. WebAuthn Payment Context Binding & Verification', () => {
        let webauthn;
        let testKeyPair;
        let testCredId;
        const testOpId = '00000000-0000-4000-8000-000000000001';

        const basePaymentContext = {
            approvalId: 'appr_ctx_test_001',
            instructionId: 'inst_ctx_test_001',
            version: 1,
            amount: '50000.00',
            currency: 'USD',
            beneficiary: 'vendor_acct_42',
            destination_account: 'dest_acc_test_9999',
            provider: 'STRIPE_TEST',
            environment: 'sandbox',
            action: 'APPROVE',
            checkerOperatorId: testOpId,
        };

        beforeAll(() => {
            testKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
            testCredId = 'cred_payment_context_test';
        });

        beforeEach(async () => {
            webauthn = new WebAuthnService({ rpId: 'localhost' });
            const regChallenge = await webauthn.generateChallenge({
                operatorId: testOpId,
                ceremonyType: 'registration',
            });
            await webauthn.registerCredential({
                operatorId: testOpId,
                credentialId: testCredId,
                publicKeyPem: testKeyPair.publicKey.export({ type: 'spki', format: 'pem' }),
                challenge: regChallenge.challenge,
            });
        });

        test('computePaymentContextDigest produces deterministic SHA-256 digest regardless of object key order', () => {
            const digest1 = computePaymentContextDigest(basePaymentContext);

            // Reordered keys
            const reorderedContext = {
                currency: 'USD',
                action: 'APPROVE',
                amount: '50000.00',
                checkerOperatorId: testOpId,
                environment: 'sandbox',
                instructionId: 'inst_ctx_test_001',
                destination_account: 'dest_acc_test_9999',
                approvalId: 'appr_ctx_test_001',
                version: 1,
                provider: 'STRIPE_TEST',
                beneficiary: 'vendor_acct_42',
            };
            const digest2 = computePaymentContextDigest(reorderedContext);

            expect(digest1).toBe(digest2);
            expect(digest1).toMatch(/^[a-f0-9]{64}$/);
        });

        test('computePaymentContextDigest changes if any material payment field is altered', () => {
            const baseDigest = computePaymentContextDigest(basePaymentContext);

            // Alter amount
            expect(computePaymentContextDigest({ ...basePaymentContext, amount: '50001.00' })).not.toBe(baseDigest);
            // Alter currency
            expect(computePaymentContextDigest({ ...basePaymentContext, currency: 'EUR' })).not.toBe(baseDigest);
            // Alter beneficiary
            expect(computePaymentContextDigest({ ...basePaymentContext, beneficiary: 'vendor_acct_99' })).not.toBe(baseDigest);
            // Alter destination_account
            expect(computePaymentContextDigest({ ...basePaymentContext, destination_account: 'dest_acc_hacked_001' })).not.toBe(baseDigest);
            // Alter provider
            expect(computePaymentContextDigest({ ...basePaymentContext, provider: 'RAZORPAYX_TEST' })).not.toBe(baseDigest);
            // Alter environment
            expect(computePaymentContextDigest({ ...basePaymentContext, environment: 'testnet' })).not.toBe(baseDigest);
            // Alter instructionId
            expect(computePaymentContextDigest({ ...basePaymentContext, instructionId: 'other_inst' })).not.toBe(baseDigest);
            // Alter version
            expect(computePaymentContextDigest({ ...basePaymentContext, version: 2 })).not.toBe(baseDigest);
            // Alter checkerOperatorId
            expect(computePaymentContextDigest({ ...basePaymentContext, checkerOperatorId: '00000000-0000-4000-8000-000000000099' })).not.toBe(baseDigest);
            // Alter action (VOID is also an allowed action)
            expect(computePaymentContextDigest({ ...basePaymentContext, action: 'VOID' })).not.toBe(baseDigest);
        });

        test('generateChallenge with paymentContext stores contextDigest and returns it', async () => {
            const challengeData = await webauthn.generateChallenge({
                operatorId: testOpId,
                ceremonyType: 'authentication',
                paymentContext: basePaymentContext,
            });

            expect(challengeData.challenge).toBeDefined();
            expect(challengeData.contextDigest).toBeDefined();
            expect(challengeData.contextDigest).toBe(computePaymentContextDigest(basePaymentContext));
        });

        test('verifyAuthenticationAssertion succeeds when exact matching payment context is provided', async () => {
            const challengeData = await webauthn.generateChallenge({
                operatorId: testOpId,
                ceremonyType: 'authentication',
                paymentContext: basePaymentContext,
            });

            const assertion = webauthn.createSyntheticAssertion({
                credentialId: testCredId,
                privateKey: testKeyPair.privateKey,
                challenge: challengeData.challenge,
                counter: 1,
                userVerified: true,
            });

            const result = await webauthn.verifyAuthenticationAssertion({
                operatorId: testOpId,
                credentialId: testCredId,
                assertionResponse: assertion,
                expectedPaymentContext: basePaymentContext,
                requireUserVerification: true,
            });

            expect(result.verified).toBe(true);
            expect(result.operatorId).toBe(testOpId);
        });

        test('verifyAuthenticationAssertion rejects with PAYMENT_CONTEXT_MISMATCH if amount was altered', async () => {
            const challengeData = await webauthn.generateChallenge({
                operatorId: testOpId,
                ceremonyType: 'authentication',
                paymentContext: basePaymentContext,
            });

            const assertion = webauthn.createSyntheticAssertion({
                credentialId: testCredId,
                privateKey: testKeyPair.privateKey,
                challenge: challengeData.challenge,
                counter: 1,
            });

            const alteredContext = { ...basePaymentContext, amount: '999999.00' };

            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId: testOpId,
                    credentialId: testCredId,
                    assertionResponse: assertion,
                    expectedPaymentContext: alteredContext,
                })
            ).rejects.toThrow(/WebAuthn payment context mismatch: approval details have been altered or mismatched/);
        });

        test('verifyAuthenticationAssertion rejects JavaScript Number amounts to prevent float precision errors', async () => {
            const challengeData = await webauthn.generateChallenge({
                operatorId: testOpId,
                ceremonyType: 'authentication',
                paymentContext: basePaymentContext,
            });

            const assertion = webauthn.createSyntheticAssertion({
                credentialId: testCredId,
                privateKey: testKeyPair.privateKey,
                challenge: challengeData.challenge,
                counter: 1,
            });

            const numericContext = { ...basePaymentContext, amount: 50000 };

            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId: testOpId,
                    credentialId: testCredId,
                    assertionResponse: assertion,
                    expectedPaymentContext: numericContext,
                })
            ).rejects.toThrow(/JavaScript Number inputs are rejected to prevent IEEE 754 precision loss/);
        });

        test('verifyAuthenticationAssertion rejects with PAYMENT_CONTEXT_MISMATCH if submitted against different instructionId', async () => {
            const challengeData = await webauthn.generateChallenge({
                operatorId: testOpId,
                ceremonyType: 'authentication',
                paymentContext: basePaymentContext,
            });

            const assertion = webauthn.createSyntheticAssertion({
                credentialId: testCredId,
                privateKey: testKeyPair.privateKey,
                challenge: challengeData.challenge,
                counter: 1,
            });

            const differentInstructionContext = { ...basePaymentContext, instructionId: 'inst_hijacked_002' };

            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId: testOpId,
                    credentialId: testCredId,
                    assertionResponse: assertion,
                    expectedPaymentContext: differentInstructionContext,
                })
            ).rejects.toThrow(/WebAuthn payment context mismatch/);
        });

        test('verifyAuthenticationAssertion rejects with PAYMENT_CONTEXT_REQUIRED if paymentContext is omitted', async () => {
            const challengeData = await webauthn.generateChallenge({
                operatorId: testOpId,
                ceremonyType: 'authentication',
                paymentContext: basePaymentContext,
            });

            const assertion = webauthn.createSyntheticAssertion({
                credentialId: testCredId,
                privateKey: testKeyPair.privateKey,
                challenge: challengeData.challenge,
                counter: 1,
            });

            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId: testOpId,
                    credentialId: testCredId,
                    assertionResponse: assertion,
                    expectedPaymentContext: null,
                })
            ).rejects.toThrow(/Payment context is required to verify approval assertion/);
        });

        test('verifyAuthenticationAssertion rejects with PAYMENT_CONTEXT_MISMATCH if destination_account was altered', async () => {
            const challengeData = await webauthn.generateChallenge({
                operatorId: testOpId,
                ceremonyType: 'authentication',
                paymentContext: basePaymentContext,
            });

            const assertion = webauthn.createSyntheticAssertion({
                credentialId: testCredId,
                privateKey: testKeyPair.privateKey,
                challenge: challengeData.challenge,
                counter: 1,
            });

            const alteredContext = { ...basePaymentContext, destination_account: 'dest_acc_tampered_attacker_iban' };

            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId: testOpId,
                    credentialId: testCredId,
                    assertionResponse: assertion,
                    expectedPaymentContext: alteredContext,
                })
            ).rejects.toThrow(/WebAuthn payment context mismatch/);
        });

        test('verifyAuthenticationAssertion rejects with PAYMENT_CONTEXT_MISMATCH if beneficiary was altered', async () => {
            const challengeData = await webauthn.generateChallenge({
                operatorId: testOpId,
                ceremonyType: 'authentication',
                paymentContext: basePaymentContext,
            });

            const assertion = webauthn.createSyntheticAssertion({
                credentialId: testCredId,
                privateKey: testKeyPair.privateKey,
                challenge: challengeData.challenge,
                counter: 1,
            });

            const alteredContext = { ...basePaymentContext, beneficiary: 'fraudulent_syndicate_entity' };

            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId: testOpId,
                    credentialId: testCredId,
                    assertionResponse: assertion,
                    expectedPaymentContext: alteredContext,
                })
            ).rejects.toThrow(/WebAuthn payment context mismatch/);
        });

        test('verifyAuthenticationAssertion rejects with PAYMENT_CONTEXT_MISMATCH if currency was altered', async () => {
            const challengeData = await webauthn.generateChallenge({
                operatorId: testOpId,
                ceremonyType: 'authentication',
                paymentContext: basePaymentContext,
            });

            const assertion = webauthn.createSyntheticAssertion({
                credentialId: testCredId,
                privateKey: testKeyPair.privateKey,
                challenge: challengeData.challenge,
                counter: 1,
            });

            const alteredContext = { ...basePaymentContext, currency: 'EUR' };

            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId: testOpId,
                    credentialId: testCredId,
                    assertionResponse: assertion,
                    expectedPaymentContext: alteredContext,
                })
            ).rejects.toThrow(/WebAuthn payment context mismatch/);
        });

        test('verifyAuthenticationAssertion rejects with PAYMENT_CONTEXT_MISMATCH if provider was altered', async () => {
            const challengeData = await webauthn.generateChallenge({
                operatorId: testOpId,
                ceremonyType: 'authentication',
                paymentContext: basePaymentContext,
            });

            const assertion = webauthn.createSyntheticAssertion({
                credentialId: testCredId,
                privateKey: testKeyPair.privateKey,
                challenge: challengeData.challenge,
                counter: 1,
            });

            const alteredContext = { ...basePaymentContext, provider: 'RAZORPAYX_TEST' };

            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId: testOpId,
                    credentialId: testCredId,
                    assertionResponse: assertion,
                    expectedPaymentContext: alteredContext,
                })
            ).rejects.toThrow(/WebAuthn payment context mismatch/);
        });

        test('verifyAuthenticationAssertion rejects with PAYMENT_CONTEXT_MISMATCH if environment was altered', async () => {
            const challengeData = await webauthn.generateChallenge({
                operatorId: testOpId,
                ceremonyType: 'authentication',
                paymentContext: basePaymentContext,
            });

            const assertion = webauthn.createSyntheticAssertion({
                credentialId: testCredId,
                privateKey: testKeyPair.privateKey,
                challenge: challengeData.challenge,
                counter: 1,
            });

            const alteredContext = { ...basePaymentContext, environment: 'testnet' };

            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId: testOpId,
                    credentialId: testCredId,
                    assertionResponse: assertion,
                    expectedPaymentContext: alteredContext,
                })
            ).rejects.toThrow(/WebAuthn payment context mismatch/);
        });

        test('verifyAuthenticationAssertion rejects with PAYMENT_CONTEXT_MISMATCH if instruction version was altered', async () => {
            const challengeData = await webauthn.generateChallenge({
                operatorId: testOpId,
                ceremonyType: 'authentication',
                paymentContext: basePaymentContext,
            });

            const assertion = webauthn.createSyntheticAssertion({
                credentialId: testCredId,
                privateKey: testKeyPair.privateKey,
                challenge: challengeData.challenge,
                counter: 1,
            });

            const alteredContext = { ...basePaymentContext, version: 2 };

            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId: testOpId,
                    credentialId: testCredId,
                    assertionResponse: assertion,
                    expectedPaymentContext: alteredContext,
                })
            ).rejects.toThrow(/WebAuthn payment context mismatch/);
        });

        test('verifyAuthenticationAssertion rejects with OPERATOR_MISMATCH if checker identity was altered', async () => {
            const challengeData = await webauthn.generateChallenge({
                operatorId: testOpId,
                ceremonyType: 'authentication',
                paymentContext: basePaymentContext,
            });

            const assertion = webauthn.createSyntheticAssertion({
                credentialId: testCredId,
                privateKey: testKeyPair.privateKey,
                challenge: challengeData.challenge,
                counter: 1,
            });

            const otherOpId = '00000000-0000-4000-8000-000000000099';
            const alteredContext = { ...basePaymentContext, checkerOperatorId: otherOpId };

            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId: testOpId,
                    credentialId: testCredId,
                    assertionResponse: assertion,
                    expectedPaymentContext: alteredContext,
                })
            ).rejects.toThrow(/WebAuthn payment context mismatch/);
        });

        test('computePaymentContextDigest rejects missing or malformed required context fields without substitution', () => {
            // Missing destination_account
            const noDest = { ...basePaymentContext };
            delete noDest.destination_account;
            expect(() => computePaymentContextDigest(noDest)).toThrow(/Missing or invalid required payment context field: "destination_account"/);

            // Missing beneficiary
            const noBeneficiary = { ...basePaymentContext };
            delete noBeneficiary.beneficiary;
            expect(() => computePaymentContextDigest(noBeneficiary)).toThrow(/Missing or invalid required payment context field: "beneficiary"/);

            // Missing amount
            const noAmount = { ...basePaymentContext };
            delete noAmount.amount;
            expect(() => computePaymentContextDigest(noAmount)).toThrow(/Missing or invalid required payment context field: "amount"/);

            // Missing currency
            const noCurrency = { ...basePaymentContext };
            delete noCurrency.currency;
            expect(() => computePaymentContextDigest(noCurrency)).toThrow(/Missing or invalid required payment context field: "currency"/);

            // Missing provider
            const noProvider = { ...basePaymentContext };
            delete noProvider.provider;
            expect(() => computePaymentContextDigest(noProvider)).toThrow(/Missing or invalid required payment context field: "provider"/);

            // Missing environment
            const noEnv = { ...basePaymentContext };
            delete noEnv.environment;
            expect(() => computePaymentContextDigest(noEnv)).toThrow(/Missing or invalid required payment context field: "environment"/);

            // Missing version
            const noVersion = { ...basePaymentContext };
            delete noVersion.version;
            expect(() => computePaymentContextDigest(noVersion)).toThrow(/Missing or invalid required payment context field: "version"/);

            // Missing approvalId
            const noApproval = { ...basePaymentContext };
            delete noApproval.approvalId;
            expect(() => computePaymentContextDigest(noApproval)).toThrow(/Missing or invalid required payment context field: "approvalId"/);

            // Missing instructionId
            const noInstruction = { ...basePaymentContext };
            delete noInstruction.instructionId;
            expect(() => computePaymentContextDigest(noInstruction)).toThrow(/Missing or invalid required payment context field: "instructionId"/);

            // Missing action
            const noAction = { ...basePaymentContext };
            delete noAction.action;
            expect(() => computePaymentContextDigest(noAction)).toThrow(/Missing or invalid required payment context field: "action"/);

            // Missing checkerOperatorId
            const noChecker = { ...basePaymentContext };
            delete noChecker.checkerOperatorId;
            expect(() => computePaymentContextDigest(noChecker)).toThrow(/Missing or invalid required payment context field: "checkerOperatorId"/);

            // Malformed currency
            expect(() => computePaymentContextDigest({ ...basePaymentContext, currency: 'MONOPOLY_BUCKS' })).toThrow(/unsupported asset/);

            // Rejection of JavaScript Number inputs (Finding 4)
            expect(() => computePaymentContextDigest({ ...basePaymentContext, amount: 50000 })).toThrow(
                /JavaScript Number inputs are rejected to prevent IEEE 754 precision loss; provide an exact decimal string/
            );
            expect(() => computePaymentContextDigest({ ...basePaymentContext, amount: 100.5 })).toThrow(
                /JavaScript Number inputs are rejected to prevent IEEE 754 precision loss; provide an exact decimal string/
            );

            // Negative amount
            expect(() => computePaymentContextDigest({ ...basePaymentContext, amount: '-500.00' })).toThrow(/must be positive/);

            // Zero amount
            expect(() => computePaymentContextDigest({ ...basePaymentContext, amount: '0.00' })).toThrow(/must be positive/);

            // Scientific notation rejection
            expect(() => computePaymentContextDigest({ ...basePaymentContext, amount: '1e5' })).toThrow(/Invalid financial numeric value/);

            // Over-precision (3 decimal places for USD which requires scale 2)
            expect(() => computePaymentContextDigest({ ...basePaymentContext, amount: '500.125' })).toThrow(/exceeds maximum precision of 2 decimal places/);

            // Action substitution rejection (only APPROVE and VOID are allowed)
            expect(() => computePaymentContextDigest({ ...basePaymentContext, action: 'EXECUTE' })).toThrow(
                /action must be one of: APPROVE, VOID/
            );
            expect(() => computePaymentContextDigest({ ...basePaymentContext, action: 'CANCEL' })).toThrow(
                /action must be one of: APPROVE, VOID/
            );
            expect(() => computePaymentContextDigest({ ...basePaymentContext, action: 'REJECT' })).toThrow(
                /action must be one of: APPROVE, VOID/
            );
        });

        test('computePaymentContextDigest normalizes financial amounts with exact currency precision without float loss', () => {
            // USD integer normalizes to scale 2
            const d1 = computePaymentContextDigest({ ...basePaymentContext, amount: '50000' });
            const d2 = computePaymentContextDigest({ ...basePaymentContext, amount: '50000.00' });
            expect(d1).toBe(d2);

            // XLM scale 7 exact normalization
            const xlmContext1 = { ...basePaymentContext, currency: 'XLM', amount: '100.5' };
            const xlmContext2 = { ...basePaymentContext, currency: 'XLM', amount: '100.5000000' };
            expect(computePaymentContextDigest(xlmContext1)).toBe(computePaymentContextDigest(xlmContext2));

            // BTC scale 8 exact normalization
            const btcContext1 = { ...basePaymentContext, currency: 'BTC', amount: '1.25' };
            const btcContext2 = { ...basePaymentContext, currency: 'BTC', amount: '1.25000000' };
            expect(computePaymentContextDigest(btcContext1)).toBe(computePaymentContextDigest(btcContext2));

            // ETH scale 18 exact precision representation
            const ethContext = { ...basePaymentContext, currency: 'ETH', amount: '1.000000000000000001' };
            const ethDigest = computePaymentContextDigest(ethContext);
            expect(ethDigest).toMatch(/^[a-f0-9]{64}$/);
        });
    });

    // =========================================================================
    // 8. WEBAUTHN COUNTER SEMANTICS PER @simplewebauthn/server (AI-2B.2)
    // =========================================================================
    describe('8. WebAuthn Counter Semantics per @simplewebauthn/server', () => {
        let webauthn;
        let testKeyPair;
        let testCredId;
        const testOpId = '00000000-0000-4000-8000-000000000001';

        beforeAll(() => {
            testKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
            testCredId = 'cred_counter_test';
        });

        beforeEach(async () => {
            webauthn = new WebAuthnService({ rpId: 'localhost' });
            const regChallenge = await webauthn.generateChallenge({
                operatorId: testOpId,
                ceremonyType: 'registration',
            });
            await webauthn.registerCredential({
                operatorId: testOpId,
                credentialId: testCredId,
                publicKeyPem: testKeyPair.publicKey.export({ type: 'spki', format: 'pem' }),
                challenge: regChallenge.challenge,
            });
        });

        test('initial credential registration sets counter to 0', () => {
            const stored = webauthn.inMemoryCredentials.get(testCredId);
            expect(stored.counter).toBe(0);
        });

        test('platform authenticators reporting counter 0 on consecutive assertions are ACCEPTED', async () => {
            // First assertion with counter 0
            const ch1 = await webauthn.generateChallenge({ operatorId: testOpId });
            const assertion1 = webauthn.createSyntheticAssertion({
                credentialId: testCredId,
                privateKey: testKeyPair.privateKey,
                challenge: ch1.challenge,
                counter: 0,
                userVerified: true,
            });
            const res1 = await webauthn.verifyAuthenticationAssertion({
                operatorId: testOpId,
                credentialId: testCredId,
                assertionResponse: assertion1,
                requireUserVerification: true,
            });
            expect(res1.verified).toBe(true);
            expect(res1.counter).toBe(0);

            // Second assertion with counter 0 (e.g. Apple Touch ID / Windows Hello)
            const ch2 = await webauthn.generateChallenge({ operatorId: testOpId });
            const assertion2 = webauthn.createSyntheticAssertion({
                credentialId: testCredId,
                privateKey: testKeyPair.privateKey,
                challenge: ch2.challenge,
                counter: 0,
                userVerified: true,
            });
            const res2 = await webauthn.verifyAuthenticationAssertion({
                operatorId: testOpId,
                credentialId: testCredId,
                assertionResponse: assertion2,
                requireUserVerification: true,
            });
            expect(res2.verified).toBe(true);
            expect(res2.counter).toBe(0);
        });

        test('monotonically increasing counter (1 -> 2 -> 3) is ACCEPTED and updates stored counter', async () => {
            for (let c = 1; c <= 3; c++) {
                const ch = await webauthn.generateChallenge({ operatorId: testOpId });
                const assertion = webauthn.createSyntheticAssertion({
                    credentialId: testCredId,
                    privateKey: testKeyPair.privateKey,
                    challenge: ch.challenge,
                    counter: c,
                    userVerified: true,
                });
                const res = await webauthn.verifyAuthenticationAssertion({
                    operatorId: testOpId,
                    credentialId: testCredId,
                    assertionResponse: assertion,
                    requireUserVerification: true,
                });
                expect(res.verified).toBe(true);
                expect(res.counter).toBe(c);
            }
        });

        test('counter regression or replay after nonzero counter is REJECTED with COUNTER_REGRESSION', async () => {
            // Advance counter to 5
            const ch1 = await webauthn.generateChallenge({ operatorId: testOpId });
            const assertion1 = webauthn.createSyntheticAssertion({
                credentialId: testCredId,
                privateKey: testKeyPair.privateKey,
                challenge: ch1.challenge,
                counter: 5,
                userVerified: true,
            });
            await webauthn.verifyAuthenticationAssertion({
                operatorId: testOpId,
                credentialId: testCredId,
                assertionResponse: assertion1,
                requireUserVerification: true,
            });

            // Replay with counter 5 -> must fail
            const ch2 = await webauthn.generateChallenge({ operatorId: testOpId });
            const replayAssertion = webauthn.createSyntheticAssertion({
                credentialId: testCredId,
                privateKey: testKeyPair.privateKey,
                challenge: ch2.challenge,
                counter: 5,
                userVerified: true,
            });
            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId: testOpId,
                    credentialId: testCredId,
                    assertionResponse: replayAssertion,
                    requireUserVerification: true,
                })
            ).rejects.toThrow(/WebAuthn authenticator counter regression/);

            // Regressive assertion with counter 4 -> must fail
            const ch3 = await webauthn.generateChallenge({ operatorId: testOpId });
            const regressiveAssertion = webauthn.createSyntheticAssertion({
                credentialId: testCredId,
                privateKey: testKeyPair.privateKey,
                challenge: ch3.challenge,
                counter: 4,
                userVerified: true,
            });
            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId: testOpId,
                    credentialId: testCredId,
                    assertionResponse: regressiveAssertion,
                    requireUserVerification: true,
                })
            ).rejects.toThrow(/WebAuthn authenticator counter regression/);
        });

        test('mandatory User Verification (UV) rejects assertions where UV bit is false', async () => {
            const ch = await webauthn.generateChallenge({ operatorId: testOpId });
            const assertionWithoutUv = webauthn.createSyntheticAssertion({
                credentialId: testCredId,
                privateKey: testKeyPair.privateKey,
                challenge: ch.challenge,
                counter: 1,
                userVerified: false, // UV = false
            });

            await expect(
                webauthn.verifyAuthenticationAssertion({
                    operatorId: testOpId,
                    credentialId: testCredId,
                    assertionResponse: assertionWithoutUv,
                    requireUserVerification: true,
                })
            ).rejects.toThrow(/User verification \(UV\) flag required/);
        });
    });

    // =========================================================================
    // 9. DUAL CONTROL FOR SENSITIVE PRIVILEGED ROLE ASSIGNMENTS (AI-2B.2)
    // =========================================================================
    describe('9. Dual Control for Sensitive Privileged Role Assignments', () => {
        let rbac;
        const adminRequester = '00000000-0000-4000-8000-000000000005'; // SYSTEM_ADMIN
        const adminApprover = '00000000-0000-4000-8000-000000000099';  // Secondary SYSTEM_ADMIN
        const targetOperator = '00000000-0000-4000-8000-000000000010';

        beforeEach(() => {
            rbac = new RbacService();
            // Seed secondary admin
            rbac.inMemoryAssignments.set(adminApprover, new Set([ROLES.SYSTEM_ADMIN]));
        });

        test('direct assignment of sensitive role by an operator fails with DUAL_CONTROL_REQUIRED', async () => {
            for (const sensitiveRole of SENSITIVE_ROLES) {
                await expect(
                    rbac.assignRoleToOperator({
                        operatorId: targetOperator,
                        roleKey: sensitiveRole,
                        assignedBy: adminRequester,
                    })
                ).rejects.toThrow(/Dual control required: Assigning sensitive role/);
            }
        });

        test('direct revocation of sensitive role by an operator fails with DUAL_CONTROL_REQUIRED', async () => {
            // Seed target operator with sensitive role via system
            rbac.inMemoryAssignments.set(targetOperator, new Set([ROLES.TREASURY_ANALYST]));

            await expect(
                rbac.revokeRoleFromOperator({
                    operatorId: targetOperator,
                    roleKey: ROLES.TREASURY_ANALYST,
                    revokedBy: adminRequester,
                })
            ).rejects.toThrow(/Dual control required: Revoking sensitive role/);
        });

        test('direct assignment of non-sensitive role (OPS_OPERATOR, AUDITOR) succeeds without dual control', async () => {
            const res = await rbac.assignRoleToOperator({
                operatorId: targetOperator,
                roleKey: ROLES.OPS_OPERATOR,
                assignedBy: adminRequester,
            });
            expect(res.afterRoles).toContain(ROLES.OPS_OPERATOR);
        });

        test('requestRoleChange rejects self-elevation requests', async () => {
            await expect(
                rbac.requestRoleChange({
                    requestingOperatorId: adminRequester,
                    targetOperatorId: adminRequester, // Self
                    roleKey: ROLES.TREASURY_ANALYST,
                    action: 'ASSIGN',
                    reason: 'Self-elevation attempt',
                })
            ).rejects.toThrow(/Self-elevation prohibited: operators cannot submit role change requests for themselves/);
        });

        test('requestRoleChange records pending request and logs audit event', async () => {
            const req = await rbac.requestRoleChange({
                requestingOperatorId: adminRequester,
                targetOperatorId: targetOperator,
                roleKey: ROLES.TREASURY_ANALYST,
                action: 'ASSIGN',
                reason: 'Promoted to treasury team',
            });

            expect(req.requestId).toBeDefined();
            expect(req.status).toBe('PENDING');

            const audit = rbac.inMemoryAuditLogs.find((l) => l.eventType === 'ROLE_CHANGE_REQUESTED');
            expect(audit).toBeDefined();
            expect(audit.metadata.roleKey).toBe(ROLES.TREASURY_ANALYST);
        });

        test('approveRoleChange enforces Four-Eyes: requester cannot approve their own request', async () => {
            const req = await rbac.requestRoleChange({
                requestingOperatorId: adminRequester,
                targetOperatorId: targetOperator,
                roleKey: ROLES.TREASURY_ANALYST,
                action: 'ASSIGN',
                reason: 'Promoted to treasury team',
            });

            await expect(
                rbac.approveRoleChange({
                    requestId: req.requestId,
                    approvingOperatorId: adminRequester, // Same operator attempting self-approval!
                })
            ).rejects.toThrow(/Dual control violation: An operator cannot approve their own role change request/);
        });

        test('approveRoleChange enforces self-elevation prohibition: target cannot approve own elevation', async () => {
            // Target also has admin rights
            rbac.inMemoryAssignments.set(targetOperator, new Set([ROLES.SYSTEM_ADMIN]));

            const req = await rbac.requestRoleChange({
                requestingOperatorId: adminRequester,
                targetOperatorId: targetOperator,
                roleKey: ROLES.TREASURY_ANALYST,
                action: 'ASSIGN',
                reason: 'Elevation request',
            });

            await expect(
                rbac.approveRoleChange({
                    requestId: req.requestId,
                    approvingOperatorId: targetOperator, // Target attempting approval!
                })
            ).rejects.toThrow(/Self-elevation prohibited: An operator cannot approve their own role change/);
        });

        test('independent approver approves role change, applying sensitive role and updating status', async () => {
            const req = await rbac.requestRoleChange({
                requestingOperatorId: adminRequester,
                targetOperatorId: targetOperator,
                roleKey: ROLES.TREASURY_ANALYST,
                action: 'ASSIGN',
                reason: 'Dual control promotion',
            });

            const approved = await rbac.approveRoleChange({
                requestId: req.requestId,
                approvingOperatorId: adminApprover, // Independent admin
            });

            expect(approved.status).toBe('APPROVED');
            expect(approved.approvingOperatorId).toBe(adminApprover);

            const targetRoles = await rbac.getOperatorRoles(targetOperator);
            expect(targetRoles).toContain(ROLES.TREASURY_ANALYST);

            const audit = rbac.inMemoryAuditLogs.find((l) => l.eventType === 'ROLE_CHANGE_APPROVED');
            expect(audit).toBeDefined();
        });

        test('independent approver rejects role change, leaving operator roles unchanged', async () => {
            const req = await rbac.requestRoleChange({
                requestingOperatorId: adminRequester,
                targetOperatorId: targetOperator,
                roleKey: ROLES.TREASURY_ANALYST,
                action: 'ASSIGN',
                reason: 'Dual control promotion',
            });

            const rejected = await rbac.rejectRoleChange({
                requestId: req.requestId,
                approvingOperatorId: adminApprover,
                reason: 'Insufficient background check',
            });

            expect(rejected.status).toBe('REJECTED');
            expect(rejected.rejectionReason).toBe('Insufficient background check');

            const targetRoles = await rbac.getOperatorRoles(targetOperator);
            expect(targetRoles).not.toContain(ROLES.TREASURY_ANALYST);

            const audit = rbac.inMemoryAuditLogs.find((l) => l.eventType === 'ROLE_CHANGE_REJECTED');
            expect(audit).toBeDefined();
        });
    });

    // =========================================================================
    // 10. PAYMENT IMMUTABILITY & VERSIONED AMENDMENT (AI-2B.2)
    // =========================================================================
    describe('10. Payment Immutability & Versioned Amendment', () => {
        let rbac;
        let makerChecker;
        const makerId = '00000000-0000-4000-8000-000000000002'; // OPS_OPERATOR
        const checkerId = '00000000-0000-4000-8000-000000000001'; // TREASURY_ANALYST
        const instructionId = 'inst_amend_test_001';

        beforeEach(async () => {
            rbac = new RbacService();
            const webauthn = new WebAuthnService({ rpId: 'localhost', origin: 'http://localhost:3000' });
            makerChecker = new MakerCheckerService({
                rbacService: rbac,
                webauthnService: webauthn,
                stepUpThreshold: 100000,
                allowTestMockFallback: true,
            });
            await makerChecker.requestPaymentApproval({
                instructionId,
                makerOperatorId: makerId,
                amount: 50000,
                currency: 'USD',
                notes: 'Initial v1 payment',
            });
        });

        test('amendPaymentInstruction invalidates pending approval, increments version, and resets state', async () => {
            const initialApproval = await makerChecker.getApprovalDetails({ instructionId });
            expect(initialApproval.status).toBe(APPROVAL_STATUS.PENDING_APPROVAL);

            const amended = await makerChecker.amendPaymentInstruction({
                instructionId,
                makerOperatorId: makerId,
                amendments: {
                    amount: 60000,
                    currency: 'USD',
                    recipient: 'vendor_corrected_acct',
                },
            });

            expect(amended.version).toBe(2);
            expect(amended.approval_status).toBe('CANCELLED');

            const updatedApproval = await makerChecker.getApprovalDetails({ instructionId });
            expect(updatedApproval.status).toBe(APPROVAL_STATUS.CANCELLED);
            expect(updatedApproval.canApprove).toBe(false);

            const audit = rbac.inMemoryAuditLogs.find((l) => l.eventType === 'PAYMENT_AMENDED');
            expect(audit).toBeDefined();
            expect(audit.metadata.instructionId).toBe(instructionId);
        });

        test('amendPaymentInstruction rejects amendments from non-maker operators', async () => {
            await expect(
                makerChecker.amendPaymentInstruction({
                    instructionId,
                    makerOperatorId: checkerId, // Non-maker
                    amendments: { amount: 60000 },
                })
            ).rejects.toThrow();
        });

        test('once amended, previously cancelled approval cannot be approved by checker', async () => {
            await makerChecker.amendPaymentInstruction({
                instructionId,
                makerOperatorId: makerId,
                amendments: { amount: 60000 },
            });

            await expect(
                makerChecker.approvePayment({
                    instructionId,
                    checkerOperatorId: checkerId,
                    requireStepUp: false,
                })
            ).rejects.toThrow(/Cannot approve instruction in status "CANCELLED"/);
        });

        test('re-submitting amended instruction creates fresh approval at version 2 requiring fresh checker review', async () => {
            await makerChecker.amendPaymentInstruction({
                instructionId,
                makerOperatorId: makerId,
                amendments: { amount: 60000 },
            });

            const freshApproval = await makerChecker.requestPaymentApproval({
                instructionId,
                makerOperatorId: makerId,
                amount: 60000,
                currency: 'USD',
                notes: 'Re-submitted after amendment v2',
            });

            expect(freshApproval.status).toBe(APPROVAL_STATUS.PENDING_APPROVAL);

            // Independent checker can now approve v2
            const approved = await makerChecker.approvePayment({
                instructionId,
                checkerOperatorId: checkerId,
                requireStepUp: false,
            });

            expect(approved.status).toBe(APPROVAL_STATUS.APPROVED);
        });

        test('IMMUTABILITY OF APPROVED INSTRUCTION: Cannot amend an already APPROVED instruction', async () => {
            // First approve v1
            await makerChecker.approvePayment({
                instructionId,
                checkerOperatorId: checkerId,
                requireStepUp: false,
            });

            const current = await makerChecker.getApprovalDetails({ instructionId });
            expect(current.status).toBe(APPROVAL_STATUS.APPROVED);

            // Attempting to amend approved instruction must be strictly rejected
            await expect(
                makerChecker.amendPaymentInstruction({
                    instructionId,
                    makerOperatorId: makerId,
                    amendments: { amount: 999999, currency: 'USD' },
                })
            ).rejects.toThrow(/Approved payment instructions are strictly immutable/);

            // Verify status and terms remained completely unchanged
            const postAttempt = await makerChecker.getApprovalDetails({ instructionId });
            expect(postAttempt.status).toBe(APPROVAL_STATUS.APPROVED);
            expect(Number(postAttempt.amount)).toBe(50000);
        });

        test('VOID WORKFLOW DUAL CONTROL: Independent requester and approver required, self-approval rejected', async () => {
            // 1. Approve instruction first
            await makerChecker.approvePayment({
                instructionId,
                checkerOperatorId: checkerId,
                requireStepUp: false,
            });

            // 2. Single-operator void attempt fails dual control
            await expect(
                makerChecker.voidPaymentInstruction({
                    instructionId,
                    operatorId: checkerId,
                    reason: 'Unauthorized single-operator void',
                })
            ).rejects.toThrow(/Dual control violation: Independent requester and approver identities are required/);

            // 3. Unauthorized role (Compliance Officer) cannot request void
            const complianceId = '00000000-0000-4000-8000-000000000004';
            await expect(
                makerChecker.requestPaymentVoid({
                    instructionId,
                    requesterOperatorId: complianceId,
                    reason: 'Compliance officer attempting unauthorized void request',
                })
            ).rejects.toThrow(/Access denied: operator lacks required permission "payment:void_request"/);

            // 4. Authorized operator (OPS_OPERATOR) requests void
            const voidReq = await makerChecker.requestPaymentVoid({
                instructionId,
                requesterOperatorId: makerId,
                reason: 'Vendor duplicate billing discovered post-approval',
            });
            expect(voidReq.status).toBe('PENDING');
            expect(voidReq.voidRequestId).toBeDefined();

            // 5. Non-approver role (Ops Operator) cannot approve void
            await expect(
                makerChecker.approvePaymentVoid({
                    instructionId,
                    voidRequestId: voidReq.voidRequestId,
                    approverOperatorId: makerId,
                })
            ).rejects.toThrow(/Access denied: operator lacks required permission "payment:void_approve"/);

            // 6. Dual Control: A Treasury Analyst (possessing payment:void_approve) cannot approve their OWN void request
            const secondInstId = 'inst_treasury_dual_test';
            await makerChecker.requestPaymentApproval({
                instructionId: secondInstId,
                makerOperatorId: makerId,
                amount: '10000.00',
                currency: 'USD',
            });
            await makerChecker.approvePayment({
                instructionId: secondInstId,
                checkerOperatorId: checkerId,
                requireStepUp: false,
            });
            const tVoidReq = await makerChecker.requestPaymentVoid({
                instructionId: secondInstId,
                requesterOperatorId: checkerId,
                reason: 'Treasury discovered duplicate batch',
            });
            await expect(
                makerChecker.approvePaymentVoid({
                    instructionId: secondInstId,
                    voidRequestId: tVoidReq.voidRequestId,
                    approverOperatorId: checkerId,
                    requireStepUp: false,
                })
            ).rejects.toThrow(/Dual control violation: Requester cannot approve their own void request/);

            // 7. Generate void challenge bound to action: 'VOID'
            expect(ALLOWED_PAYMENT_CONTEXT_ACTIONS).toEqual(['APPROVE', 'VOID']);
            const challenge = await makerChecker.generateVoidApprovalChallenge({
                instructionId,
                voidRequestId: voidReq.voidRequestId,
                approverOperatorId: checkerId,
            });
            expect(challenge.paymentContext.action).toBe('VOID');
            expect(challenge.challenge).toBeDefined();

            // 8. Independent Treasury Analyst approves void
            const voidResult = await makerChecker.approvePaymentVoid({
                instructionId,
                voidRequestId: voidReq.voidRequestId,
                approverOperatorId: checkerId,
                requireStepUp: false,
            });

            expect(voidResult.state).toBe('VOIDED');
            expect(voidResult.approval_status).toBe('VOIDED');
            expect(voidResult.contextDigest).toMatch(/^[a-f0-9]{64}$/);

            const details = await makerChecker.getApprovalDetails({ instructionId });
            expect(details.status).toBe(APPROVAL_STATUS.VOIDED);
            expect(details.rejectionReason).toBe('Vendor duplicate billing discovered post-approval');
            // Material terms preserved
            expect(Number(details.amount)).toBe(50000);
            expect(details.currency).toBe('USD');

            // Audit log recorded with requester, approver, and contextDigest
            const audit = rbac.inMemoryAuditLogs.find((l) => l.eventType === 'PAYMENT_VOID_APPROVED');
            expect(audit).toBeDefined();
            expect(audit.metadata.instructionId).toBe(instructionId);
            expect(audit.metadata.requesterOperatorId).toBe(makerId);
            expect(audit.metadata.approverOperatorId).toBe(checkerId);
            expect(audit.metadata.contextDigest).toBe(voidResult.contextDigest);

            // 9. Voided instruction cannot be re-approved or amended (terminal state)
            await expect(
                makerChecker.approvePayment({
                    instructionId,
                    checkerOperatorId: checkerId,
                    requireStepUp: false,
                })
            ).rejects.toThrow();

            await expect(
                makerChecker.amendPaymentInstruction({
                    instructionId,
                    makerOperatorId: makerId,
                    amendments: { amount: 70000 },
                })
            ).rejects.toThrow();

            // 10. Already voided instruction cannot be re-voided
            await expect(
                makerChecker.requestPaymentVoid({
                    instructionId,
                    requesterOperatorId: makerId,
                    reason: 'Second void attempt',
                })
            ).rejects.toThrow(/Instruction is already VOIDED/);
        });
    });

    // =========================================================================
    // 11. STRICT SANDBOX ENVIRONMENT ENFORCEMENT (AI-2B.2 & AI-2B.3)
    // =========================================================================
    describe('11. Strict Sandbox Environment Enforcement', () => {
        const validTestnetEnv = {
            STRIPE_TEST_SECRET_KEY: 'sk_test_1234567890abcdef',
            RAZORPAY_KEY_ID: 'rzp_test_1234567890abcdef',
            RAZORPAY_KEY_SECRET: 'test_rzp_secret_key_12345',
            VAULT_MASTER_SECRET: 'super_secret_master_key_16_bytes',
            STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
            STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
        };

        test('validateEnvironment passes with correct sandbox/testnet credentials', () => {
            const res = validateEnvironment(validTestnetEnv);
            expect(res.valid).toBe(true);
        });

        test('validateEnvironment fails closed on live Stripe key (sk_live_*)', () => {
            expect(() => {
                validateEnvironment({
                    ...validTestnetEnv,
                    STRIPE_TEST_SECRET_KEY: 'sk_live_production_key_detected',
                });
            }).toThrow(/Production Stripe key \(sk_live_\*.*\) detected! Project Fusion strictly prohibits live card credentials/);
        });

        test('validateEnvironment fails closed on live Razorpay key (rzp_live_*)', () => {
            expect(() => {
                validateEnvironment({
                    ...validTestnetEnv,
                    RAZORPAY_KEY_ID: 'rzp_live_production_payout_key',
                });
            }).toThrow(/Production Razorpay key \(rzp_live_\*\) detected! Project Fusion strictly prohibits live payout credentials/);
        });

        test('validateEnvironment fails closed on non-testnet Stellar Horizon URL', () => {
            expect(() => {
                validateEnvironment({
                    ...validTestnetEnv,
                    STELLAR_HORIZON_URL: 'https://horizon.stellar.org', // Public Mainnet
                });
            }).toThrow(/Prohibited Stellar Horizon URL: Only official Testnet/);
        });

        test('validateEnvironment fails closed on non-testnet Stellar Network Passphrase', () => {
            expect(() => {
                validateEnvironment({
                    ...validTestnetEnv,
                    STELLAR_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015', // Mainnet passphrase
                });
            }).toThrow(/Prohibited Stellar Network Passphrase: Only Testnet passphrase is permitted/);
        });

        test('assertPermittedProvider accepts allowlisted providers and rejects unknown providers', () => {
            expect(assertPermittedProvider('STRIPE_TEST')).toBe('STRIPE_TEST');
            expect(assertPermittedProvider('RAZORPAYX_TEST')).toBe('RAZORPAYX_TEST');
            expect(assertPermittedProvider('STELLAR_TESTNET')).toBe('STELLAR_TESTNET');
            expect(assertPermittedProvider('core_stellar')).toBe('core_stellar');

            expect(() => assertPermittedProvider('UNKNOWN_ROGUE_PROVIDER')).toThrow(/Unrecognized or unauthorized provider identifier/);
            expect(() => assertPermittedProvider('')).toThrow(/Provider identifier must be an explicit non-empty string/);
            expect(() => assertPermittedProvider(null)).toThrow(/Provider identifier must be an explicit non-empty string/);
        });

        test('assertPermittedEndpoint validates permitted sandbox endpoints and rejects mainnet URLs', () => {
            expect(assertPermittedEndpoint('https://api.stripe.com/v1/payment_intents')).toBe('https://api.stripe.com/v1/payment_intents');
            expect(assertPermittedEndpoint('https://api.razorpay.com/v1/payouts')).toBe('https://api.razorpay.com/v1/payouts');
            expect(assertPermittedEndpoint('https://horizon-testnet.stellar.org')).toBe('https://horizon-testnet.stellar.org');
            expect(assertPermittedEndpoint('https://friendbot.stellar.org')).toBe('https://friendbot.stellar.org');

            // Rejects mainnet
            expect(() => assertPermittedEndpoint('https://horizon.stellar.org')).toThrow(/Prohibited mainnet\/production endpoint rejected/);
            expect(() => assertPermittedEndpoint('https://mainnet.infura.io/v3/secret')).toThrow(/Prohibited mainnet\/production endpoint rejected/);
            expect(() => assertPermittedEndpoint('https://api.untrusted-hft-gateway.com')).toThrow(/Unrecognized endpoint URL/);
        });

        test('assertPermittedNetwork requires explicit classification and rejects unknown or mainnet networks', () => {
            expect(assertPermittedNetwork('stellar_testnet')).toBe('stellar_testnet');
            expect(assertPermittedNetwork('simulated_btc_testnet')).toBe('simulated_btc_testnet');
            expect(assertPermittedNetwork('simulated_eth_sepolia')).toBe('simulated_eth_sepolia');

            // Missing network must NOT default silently to sandbox (must fail closed)
            expect(() => assertPermittedNetwork('')).toThrow(/Missing network classification/);
            expect(() => assertPermittedNetwork(null)).toThrow(/Missing network classification/);
            expect(() => assertPermittedNetwork(undefined)).toThrow(/Missing network classification/);

            // Rejects mainnet networks
            expect(() => assertPermittedNetwork('ethereum_mainnet')).toThrow(/Prohibited or unrecognized blockchain network/);
            expect(() => assertPermittedNetwork('bitcoin_mainnet')).toThrow(/Prohibited or unrecognized blockchain network/);
        });

        test('validateSimulationAdapter ensures BTC and ETH simulation cannot resolve external RPC endpoints', () => {
            // Valid zero-network simulation
            expect(validateSimulationAdapter({ asset: 'BTC', network: 'simulated_btc_testnet' })).toBe(true);
            expect(validateSimulationAdapter({ asset: 'ETH', network: 'simulated_eth_sepolia' })).toBe(true);

            // Rejects any attempt to specify external RPC for simulated assets
            expect(() => validateSimulationAdapter({
                asset: 'ETH',
                rpcUrl: 'https://mainnet.infura.io/v3/12345',
            })).toThrow(/Simulation adapter for ETH cannot resolve or connect to external RPC endpoints/);

            expect(() => validateSimulationAdapter({
                asset: 'BTC',
                rpcUrl: 'https://blockstream.info/api',
            })).toThrow(/Simulation adapter for BTC cannot resolve or connect to external RPC endpoints/);
        });

        test('validateEnvironment fails closed on simulation RPC or live network environment configuration', () => {
            expect(() => {
                validateEnvironment({
                    ...validTestnetEnv,
                    ETH_RPC_URL: 'https://sepolia.infura.io/v3/dummy',
                });
            }).toThrow(/ETH_RPC_URL configured in environment. ETH is strictly simulated with zero RPC network resolution/);

            expect(() => {
                validateEnvironment({
                    ...validTestnetEnv,
                    NETWORK_ENVIRONMENT: 'production',
                });
            }).toThrow(/Production network environment \(production\) detected/);
        });

        test('validateProviderCredentialMode enforces strict test-mode credentials and rejects live keys', () => {
            // Valid Stripe test credentials (sk_test_ and rk_test_)
            expect(validateProviderCredentialMode({
                provider: 'core_stripe',
                credential: 'sk_test_51MockStripeKey123',
                environment: 'sandbox',
                endpoint: 'https://api.stripe.com',
            }).mode).toBe('SANDBOX_VERIFIED');

            expect(validateProviderCredentialMode({
                provider: 'STRIPE_TEST',
                credential: 'rk_test_51RestrictedKey123',
                environment: 'sandbox',
                endpoint: 'https://api.stripe.com',
            }).mode).toBe('SANDBOX_VERIFIED');

            // Rejects live Stripe credentials (sk_live_ and rk_live_)
            expect(() => validateProviderCredentialMode({
                provider: 'core_stripe',
                credential: 'sk_live_production_key_detected',
                environment: 'sandbox',
            })).toThrow(/Live-mode Stripe credential.*Live credentials are strictly prohibited/);

            expect(() => validateProviderCredentialMode({
                provider: 'STRIPE_TEST',
                credential: 'rk_live_restricted_production',
                environment: 'sandbox',
            })).toThrow(/Live-mode Stripe credential.*Live credentials are strictly prohibited/);

            // Rejects non-test Stripe prefixes
            expect(() => validateProviderCredentialMode({
                provider: 'core_stripe',
                credential: 'invalid_prefix_stripe_key',
                environment: 'sandbox',
            })).toThrow(/must start with test prefix/);

            // Valid RazorpayX test credentials
            expect(validateProviderCredentialMode({
                provider: 'core_razorpay',
                keyId: 'rzp_test_123456789',
                keySecret: 'secret_12345',
                environment: 'sandbox',
                endpoint: 'https://api.razorpay.com',
            }).mode).toBe('SANDBOX_VERIFIED');

            // Rejects live Razorpay credentials (rzp_live_)
            expect(() => validateProviderCredentialMode({
                provider: 'core_razorpay',
                keyId: 'rzp_live_production_payout',
                keySecret: 'secret_12345',
                environment: 'sandbox',
            })).toThrow(/Live-mode Razorpay key identifier.*Live credentials are strictly prohibited/);

            // Rejects non-test Razorpay key prefixes
            expect(() => validateProviderCredentialMode({
                provider: 'RAZORPAYX_TEST',
                keyId: 'rzp_custom_invalid',
                environment: 'sandbox',
            })).toThrow(/must start with test prefix/);

            // Generic provider identifier cannot bypass credential validation
            expect(() => validateProviderCredentialMode({
                provider: 'core_stripe',
                credential: '', // Missing
                environment: 'sandbox',
            })).toThrow(/Missing mandatory Stripe credential/);

            expect(() => validateProviderCredentialMode({
                provider: 'core_razorpay',
                keyId: '', // Missing
                environment: 'sandbox',
            })).toThrow(/Missing mandatory Razorpay Key ID/);
        });

        test('assertPermittedEnvironment rejects missing, unknown, and production classifications', () => {
            expect(assertPermittedEnvironment('sandbox')).toBe('sandbox');
            expect(assertPermittedEnvironment('testnet')).toBe('testnet');
            expect(assertPermittedEnvironment('development')).toBe('development');
            expect(assertPermittedEnvironment('test')).toBe('test');

            // Missing / empty classifications fail closed
            expect(() => assertPermittedEnvironment('')).toThrow(/Missing environment classification/);
            expect(() => assertPermittedEnvironment(null)).toThrow(/Missing environment classification/);
            expect(() => assertPermittedEnvironment(undefined)).toThrow(/Missing environment classification/);

            // Production classifications rejected
            expect(() => assertPermittedEnvironment('production')).toThrow(/Prohibited production environment 'production' rejected/);
            expect(() => assertPermittedEnvironment('live')).toThrow(/Prohibited production environment 'live' rejected/);
            expect(() => assertPermittedEnvironment('mainnet')).toThrow(/Prohibited production environment 'mainnet' rejected/);

            // Unknown classifications rejected
            expect(() => assertPermittedEnvironment('staging_external')).toThrow(/Unrecognized environment classification/);
        });

        test('assertPermittedEndpoint rejects insecure HTTP endpoints and unallowlisted hosts', () => {
            // Rejects insecure HTTP protocol
            expect(() => assertPermittedEndpoint('http://api.stripe.com')).toThrow(/Insecure or invalid endpoint protocol/);
            expect(() => assertPermittedEndpoint('http://api.razorpay.com')).toThrow(/Insecure or invalid endpoint protocol/);

            // Rejects unallowlisted hosts
            expect(() => assertPermittedEndpoint('https://api.untrusted-payment-rail.com')).toThrow(/Unrecognized endpoint URL/);
        });
    });

    // =========================================================================
    // 12. OPERATIONAL FAIL-CLOSED & DATABASE UNAVAILABILITY (Finding 1)
    // =========================================================================
    describe('12. Operational Fail-Closed & Database Unavailability (Finding 1)', () => {
        let rbac;
        let webauthn;
        let prodMakerChecker;

        beforeEach(() => {
            rbac = new RbacService();
            webauthn = new WebAuthnService({ rpId: 'localhost', origin: 'http://localhost:3000' });
            // Production instance: allowTestMockFallback defaults to false
            prodMakerChecker = new MakerCheckerService({
                rbacService: rbac,
                webauthnService: webauthn,
                stepUpThreshold: 100000,
            });
        });

        test('PostgreSQL unavailable during void request fails closed with 503 DATABASE_UNAVAILABLE', async () => {
            await expect(
                prodMakerChecker.requestPaymentVoid({
                    instructionId: 'inst_failclosed_01',
                    requesterOperatorId: '00000000-0000-4000-8000-000000000002',
                    reason: 'Testing database unavailability fail-closed',
                    pool: null,
                })
            ).rejects.toMatchObject({
                statusCode: 503,
                code: 'DATABASE_UNAVAILABLE',
            });
        });

        test('PostgreSQL unavailable during challenge creation fails closed with 503 DATABASE_UNAVAILABLE', async () => {
            await expect(
                prodMakerChecker.generateVoidApprovalChallenge({
                    instructionId: 'inst_failclosed_02',
                    voidRequestId: '00000000-0000-4000-8000-000000000099',
                    approverOperatorId: '00000000-0000-4000-8000-000000000001',
                    pool: null,
                })
            ).rejects.toMatchObject({
                statusCode: 503,
                code: 'DATABASE_UNAVAILABLE',
            });
        });

        test('PostgreSQL unavailable during void approval fails closed with 503 DATABASE_UNAVAILABLE', async () => {
            await expect(
                prodMakerChecker.approvePaymentVoid({
                    instructionId: 'inst_failclosed_03',
                    voidRequestId: '00000000-0000-4000-8000-000000000099',
                    approverOperatorId: '00000000-0000-4000-8000-000000000001',
                    pool: null,
                })
            ).rejects.toMatchObject({
                statusCode: 503,
                code: 'DATABASE_UNAVAILABLE',
            });
        });

        test('PostgreSQL connection error (e.g. ECONNREFUSED) fails closed with 503 DATABASE_UNAVAILABLE', async () => {
            const brokenPool = {
                connect: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432')),
                query: jest.fn().mockResolvedValue({ rows: [{ permission_key: 'payment:void_request' }] }),
            };

            await expect(
                prodMakerChecker.requestPaymentVoid({
                    instructionId: 'inst_failclosed_04',
                    requesterOperatorId: '00000000-0000-4000-8000-000000000002',
                    reason: 'Testing DB connection drop',
                    pool: brokenPool,
                })
            ).rejects.toMatchObject({
                statusCode: 503,
                code: 'DATABASE_UNAVAILABLE',
            });
        });

        test('Database transaction rollback on query error ensures no approval state returned', async () => {
            const mockClient = {
                query: jest.fn()
                    .mockResolvedValueOnce({ rows: [] }) // BEGIN
                    .mockResolvedValueOnce({ rows: [{ instruction_id: 'inst_tx_01', state: 'APPROVED', currency: 'USD', amount: '500.00' }] }) // SELECT instructions FOR UPDATE
                    .mockResolvedValueOnce({ rows: [{ void_request_id: 'vr_01', requester_operator_id: '00000000-0000-4000-8000-000000000002', reason: 'Fraudulent transaction' }] }) // SELECT void request
                    .mockRejectedValueOnce(new Error('Deadlock detected / DB constraint failure')), // Failure
                release: jest.fn(),
            };
            const mockPool = {
                connect: jest.fn().mockResolvedValue(mockClient),
                query: jest.fn().mockResolvedValue({ rows: [{ permission_key: 'payment:void_approve' }] }),
            };

            await expect(
                prodMakerChecker.approvePaymentVoid({
                    instructionId: 'inst_tx_01',
                    voidRequestId: 'vr_01',
                    approverOperatorId: '00000000-0000-4000-8000-000000000001',
                    requireStepUp: false,
                    pool: mockPool,
                })
            ).rejects.toThrow('Deadlock detected / DB constraint failure');

            expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
            expect(mockClient.release).toHaveBeenCalled();
        });

        test('Application restart simulation: state persisted in DB allows new instance to recover pending request', async () => {
            const persistedVoidReq = {
                void_request_id: 'vr_restart_test',
                instruction_id: 'inst_restart_test',
                requester_operator_id: '00000000-0000-4000-8000-000000000002',
                status: 'PENDING',
                reason: 'Discovered anomaly before reboot',
            };
            const persistedInst = {
                instruction_id: 'inst_restart_test',
                state: 'APPROVED',
                currency: 'USD',
                amount: '1000.00',
                recipient: 'vendor_corp_acct',
                destination_account: 'acc_us_bank_999',
            };

            const mockDb = {
                query: jest.fn((sql) => {
                    if (sql.includes('SELECT * FROM identity.payment_void_requests')) {
                        return Promise.resolve({ rows: [persistedVoidReq] });
                    }
                    if (sql.includes('SELECT * FROM instructions')) {
                        return Promise.resolve({ rows: [persistedInst] });
                    }
                    return Promise.resolve({ rows: [] });
                }),
                release: jest.fn(),
            };
            const mockPool = {
                connect: jest.fn().mockResolvedValue(mockDb),
                query: jest.fn().mockResolvedValue({ rows: [{ permission_key: 'payment:void_approve' }] }),
            };

            // Instance A requested void and shut down.
            // Instance B starts up and queries the request from DB:
            const instanceB = new MakerCheckerService({ rbacService: rbac, webauthnService: webauthn });
            const challenge = await instanceB.generateVoidApprovalChallenge({
                instructionId: 'inst_restart_test',
                voidRequestId: 'vr_restart_test',
                approverOperatorId: '00000000-0000-4000-8000-000000000001',
                pool: mockPool,
            });

            expect(challenge.challenge).toBeDefined();
            expect(challenge.voidRequestId).toBe('vr_restart_test');
            expect(challenge.paymentContext.action).toBe('VOID');
        });

        test('Two application instances concurrency: serialized via database transaction and row locking', async () => {
            const mockClient1 = {
                query: jest.fn((sql) => {
                    if (sql.includes('instructions') && sql.includes('FOR UPDATE')) {
                        return Promise.resolve({ rows: [{ instruction_id: 'inst_conc', state: 'APPROVED', currency: 'USD', amount: '100.00', recipient: 'vendor_corp_acct', destination_account: 'acc_us_bank_999' }] });
                    }
                    if (sql.includes('payment_void_requests')) {
                        return Promise.resolve({ rows: [{ void_request_id: 'vr_conc', requester_operator_id: '00000000-0000-4000-8000-000000000002', challenge_id: '00000000-0000-4000-8000-000000000077' }] });
                    }
                    if (sql.includes('identity.fn_approve_payment_void')) {
                        return Promise.resolve({ rows: [{ result: { status: 'APPROVED' } }] });
                    }
                    return Promise.resolve({ rows: [] });
                }),
                release: jest.fn(),
            };

            const mockPool1 = {
                connect: jest.fn().mockResolvedValue(mockClient1),
                query: jest.fn().mockResolvedValue({ rows: [{ permission_key: 'payment:void_approve' }] }),
            };

            const instance1 = new MakerCheckerService({ rbacService: rbac, webauthnService: webauthn });
            const result1 = await instance1.approvePaymentVoid({
                instructionId: 'inst_conc',
                voidRequestId: 'vr_conc',
                approverOperatorId: '00000000-0000-4000-8000-000000000001',
                requireStepUp: false,
                pool: mockPool1,
            });

            expect(result1.state).toBe('VOIDED');
            expect(mockClient1.query).toHaveBeenCalledWith('COMMIT');
        });
    });
});
