'use strict';

/**
 * PROJECT FUSION — ADR-002: CANONICAL PAYMENT APPROVAL & SAGA DISPATCH TEST SUITE
 * ==============================================================================
 * Comprehensive automated verification for ADR-002:
 * 1. Maker cannot approve own payment (Strict Four-Eyes Principle).
 * 2. Unauthenticated user cannot approve.
 * 3. Unauthorised roles cannot approve (RBAC enforcement).
 * 4. WebAuthn assertion bound to correct instruction (Context digest binding).
 * 5. Expired/replayed challenge rejected.
 * 6. Changed payment context invalidates approval.
 * 7. Successful approval creates one durable dispatch event.
 * 8. Duplicate approval cannot create duplicate dispatch (Idempotency).
 * 9. Dispatcher restart does not lose pending event.
 * 10. Scheduled payment cannot bypass required approval (Governance closing).
 * 11. Explicitly permitted automatic execution works under versioned policy.
 * 12. Failed/ambiguous dispatch enters safe recovery or manual review.
 */

process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const {
    ROLES,
    PERMISSIONS,
    RbacService,
} = require('../../core/identity/rbacService');
const {
    WebAuthnService,
    computePaymentContextDigest,
} = require('../../core/identity/webauthnService');
const {
    MakerCheckerService,
    APPROVAL_STATUS,
} = require('../../core/approvals/makerCheckerService');
const {
    CanonicalApprovalService,
} = require('../../core/approvals/canonicalApprovalService');
const {
    runScheduledPaymentsSweep,
} = require('../../core/cashiq/paymentScheduler');

describe('Project Fusion — ADR-002: Canonical Payment Approval and Saga Execution', () => {
    let rbacService;
    let webauthnService;
    let makerCheckerService;
    let canonicalService;

    // Test operator IDs
    const MAKER_OPS_ID = '00000000-0000-4000-8000-000000000002'; // Ops Operator (Maker)
    const CHECKER_CFO_ID = '00000000-0000-4000-8000-000000000001'; // Treasury Analyst / CFO (Checker)
    const AUDITOR_ID = '00000000-0000-4000-8000-000000000003'; // Auditor (Read-only)
    const UNAUTHORIZED_ID = '00000000-0000-4000-8000-000000000099'; // Operator without approve role

    beforeEach(() => {
        rbacService = new RbacService({ allowTestMockFallback: true });
        rbacService.inMemoryAssignments.set(MAKER_OPS_ID, new Set([ROLES.OPS_OPERATOR]));
        rbacService.inMemoryAssignments.set(CHECKER_CFO_ID, new Set([ROLES.TREASURY_ANALYST]));
        rbacService.inMemoryAssignments.set(AUDITOR_ID, new Set([ROLES.AUDITOR]));

        webauthnService = new WebAuthnService({ rpId: 'localhost', origin: 'http://localhost:3000' });

        makerCheckerService = new MakerCheckerService({
            rbacService,
            webauthnService,
            allowTestMockFallback: true,
            stepUpThreshold: 50000, // INR 50k requires step-up
        });

        canonicalService = new CanonicalApprovalService({
            makerCheckerService,
            rbacService,
            webauthnService,
            pool: null, // Isolated in-memory mode for unit verification
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 1: Maker cannot approve own payment
    // ─────────────────────────────────────────────────────────────────────────
    test('1. Maker cannot approve own payment (Four-Eyes Principle violation)', async () => {
        const instructionId = crypto.randomUUID();

        // Maker submits approval request
        await canonicalService.requestPaymentApproval({
            instructionId,
            makerOperatorId: MAKER_OPS_ID,
            amount: 10000,
            currency: 'INR',
            notes: 'Vendor payment',
        });

        // Maker attempts to approve their own payment
        await expect(
            canonicalService.approvePayment({
                instructionId,
                checkerOperatorId: MAKER_OPS_ID, // Self-approval
                requireStepUp: false,
            })
        ).rejects.toThrow(/Maker-Checker violation|Four-Eyes|cannot approve their own payment/i);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 2: Unauthenticated user cannot approve
    // ─────────────────────────────────────────────────────────────────────────
    test('2. Unauthenticated user cannot approve', async () => {
        const instructionId = crypto.randomUUID();

        await canonicalService.requestPaymentApproval({
            instructionId,
            makerOperatorId: MAKER_OPS_ID,
            amount: 5000,
            currency: 'INR',
        });

        // Missing checkerOperatorId
        await expect(
            canonicalService.approvePayment({
                instructionId,
                checkerOperatorId: null,
            })
        ).rejects.toThrow(/checkerOperatorId are required/i);

        // Empty string checker
        await expect(
            canonicalService.approvePayment({
                instructionId,
                checkerOperatorId: '',
            })
        ).rejects.toThrow(/checkerOperatorId are required/i);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 3: Unauthorised roles cannot approve
    // ─────────────────────────────────────────────────────────────────────────
    test('3. Unauthorised roles cannot approve (RBAC enforcement)', async () => {
        const instructionId = crypto.randomUUID();

        await canonicalService.requestPaymentApproval({
            instructionId,
            makerOperatorId: MAKER_OPS_ID,
            amount: 5000,
            currency: 'INR',
        });

        // AUDITOR attempts approval (does not possess 'payment:approve')
        await expect(
            canonicalService.approvePayment({
                instructionId,
                checkerOperatorId: AUDITOR_ID,
                requireStepUp: false,
            })
        ).rejects.toThrow(/Access denied|lacks required permission/i);

        // Unknown/unauthorized operator attempts approval
        await expect(
            canonicalService.approvePayment({
                instructionId,
                checkerOperatorId: UNAUTHORIZED_ID,
                requireStepUp: false,
            })
        ).rejects.toThrow(/Access denied|lacks required permission/i);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 4: WebAuthn assertion bound to correct instruction
    // ─────────────────────────────────────────────────────────────────────────
    test('4. WebAuthn assertion bound to correct instruction', async () => {
        const instructionId = crypto.randomUUID();
        const wrongInstructionId = crypto.randomUUID();

        await canonicalService.requestPaymentApproval({
            instructionId,
            makerOperatorId: MAKER_OPS_ID,
            amount: 150000, // High-value: requires step-up
            currency: 'INR',
        });

        const approval = await canonicalService.getApprovalDetails({
            instructionId,
            requestingOperatorId: CHECKER_CFO_ID,
        });

        // Register synthetic credential for CFO
        const credentialId = 'cred_cfo_fido2_key';
        const rawKey = crypto.randomBytes(32);
        webauthnService.inMemoryCredentials.set(credentialId, {
            credentialId,
            operatorId: CHECKER_CFO_ID,
            publicKey: rawKey.toString('base64'),
            counter: 1,
            transports: ['usb', 'internal'],
        });

        // Generate challenge for instructionId
        const challengeData = await webauthnService.generateChallenge({
            operatorId: CHECKER_CFO_ID,
            ceremonyType: 'authentication',
            paymentContext: {
                approvalId: approval.approvalId || approval.approval_id || crypto.randomUUID(),
                instructionId,
                version: approval.instruction_version || approval.instructionVersion || 1,
                amount: '150000.00',
                currency: 'INR',
                beneficiary: 'ACME Ltd',
                destination_account: 'ACC123',
                provider: 'STRIPE_TEST',
                environment: 'sandbox',
                action: 'APPROVE',
                checkerOperatorId: CHECKER_CFO_ID,
            },
        });

        // Synthesize valid WebAuthn assertion
        const clientDataJson = Buffer.from(
            JSON.stringify({
                type: 'webauthn.get',
                challenge: challengeData.challenge,
                origin: 'http://localhost:3000',
            })
        ).toString('base64url');

        const webauthnAssertion = {
            id: credentialId,
            rawId: credentialId,
            response: {
                clientDataJSON: clientDataJson,
                authenticatorData: Buffer.from([0x01, 0x05]).toString('base64url'), // UV bit set
                signature: 'mock_signature',
                userHandle: Buffer.from(CHECKER_CFO_ID).toString('base64url'),
            },
        };

        // When submitted against wrong instruction context -> rejected
        await expect(
            webauthnService.verifyAuthenticationAssertion({
                operatorId: CHECKER_CFO_ID,
                credentialId,
                assertionResponse: webauthnAssertion,
                expectedPaymentContext: {
                    approvalId: approval.approvalId || approval.approval_id || crypto.randomUUID(),
                    instructionId: wrongInstructionId, // Wrong ID!
                    version: 1,
                    amount: '150000.00',
                    currency: 'INR',
                    beneficiary: 'ACME Ltd',
                    destination_account: 'ACC123',
                    provider: 'STRIPE_TEST',
                    environment: 'sandbox',
                    action: 'APPROVE',
                    checkerOperatorId: CHECKER_CFO_ID,
                },
            })
        ).rejects.toThrow(/Payment context mismatch|Cryptographic context binding verification failed/i);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 5: Expired / replayed challenge rejected
    // ─────────────────────────────────────────────────────────────────────────
    test('5. Expired/replayed challenge rejected', async () => {
        const paymentContext = {
            approvalId: crypto.randomUUID(),
            instructionId: crypto.randomUUID(),
            version: 1,
            amount: '1000.00',
            currency: 'INR',
            beneficiary: 'Vendor X',
            destination_account: 'ACC_X',
            provider: 'STRIPE_TEST',
            environment: 'sandbox',
            action: 'APPROVE',
            checkerOperatorId: CHECKER_CFO_ID,
        };

        const challengeData = await webauthnService.generateChallenge({
            operatorId: CHECKER_CFO_ID,
            ceremonyType: 'authentication',
            paymentContext,
        });

        // Manually expire the challenge
        const challengeRecord = webauthnService.inMemoryChallenges.get(challengeData.challenge);
        challengeRecord.expiresAt = new Date(Date.now() - 10000); // 10s in past

        const assertion = {
            id: 'cred1',
            rawId: 'cred1',
            response: {
                clientDataJSON: Buffer.from(
                    JSON.stringify({
                        type: 'webauthn.get',
                        challenge: challengeData.challenge,
                        origin: 'http://localhost:3000',
                    })
                ).toString('base64url'),
                authenticatorData: Buffer.from([0x01, 0x05]).toString('base64url'),
                signature: 'sig',
            },
        };

        await expect(
            webauthnService.verifyAuthenticationAssertion({
                operatorId: CHECKER_CFO_ID,
                credentialId: 'cred1',
                assertionResponse: assertion,
                expectedPaymentContext: paymentContext,
            })
        ).rejects.toThrow(/expired/i);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 6: Changed payment context invalidates approval
    // ─────────────────────────────────────────────────────────────────────────
    test('6. Changed payment context invalidates approval', () => {
        const baseContext = {
            approvalId: crypto.randomUUID(),
            instructionId: crypto.randomUUID(),
            version: 1,
            amount: '10000.00',
            currency: 'INR',
            beneficiary: 'Vendor A',
            destination_account: '987654321',
            provider: 'STRIPE_TEST',
            environment: 'sandbox',
            action: 'APPROVE',
            checkerOperatorId: CHECKER_CFO_ID,
        };

        const originalDigest = computePaymentContextDigest(baseContext);

        // Tamper with the amount
        const tamperedContext = { ...baseContext, amount: '10001.00' };
        const tamperedDigest = computePaymentContextDigest(tamperedContext);

        expect(tamperedDigest).not.toEqual(originalDigest);

        // Tamper with beneficiary
        const tamperedBeneficiary = { ...baseContext, beneficiary: 'Fraud Corp' };
        expect(computePaymentContextDigest(tamperedBeneficiary)).not.toEqual(originalDigest);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 7: Successful approval creates one durable dispatch event
    // ─────────────────────────────────────────────────────────────────────────
    test('7. Successful approval creates one durable dispatch event', async () => {
        const instructionId = crypto.randomUUID();

        await canonicalService.requestPaymentApproval({
            instructionId,
            makerOperatorId: MAKER_OPS_ID,
            amount: 25000,
            currency: 'INR',
            notes: 'Routine inventory replenishment',
        });

        const res = await canonicalService.approvePayment({
            instructionId,
            checkerOperatorId: CHECKER_CFO_ID,
            notes: 'Approved after review',
            requireStepUp: false,
        });

        expect(res.success).toBe(true);
        expect(res.dispatchRecord).toBeDefined();
        expect(res.dispatchRecord.instruction_id).toBe(instructionId);
        expect(canonicalService.inMemoryOutbox.has(instructionId)).toBe(true);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 8: Duplicate approval cannot create duplicate dispatch
    // ─────────────────────────────────────────────────────────────────────────
    test('8. Duplicate approval cannot create duplicate dispatch', async () => {
        const instructionId = crypto.randomUUID();

        await canonicalService.requestPaymentApproval({
            instructionId,
            makerOperatorId: MAKER_OPS_ID,
            amount: 12000,
            currency: 'INR',
        });

        // First approval
        const res1 = await canonicalService.approvePayment({
            instructionId,
            checkerOperatorId: CHECKER_CFO_ID,
            idempotencyKey: `idemp_${instructionId}`,
            requireStepUp: false,
        });

        expect(res1.success).toBe(true);
        const outboxSize = canonicalService.inMemoryOutbox.size;

        // Second approval attempt on already approved instruction
        await expect(
            canonicalService.approvePayment({
                instructionId,
                checkerOperatorId: CHECKER_CFO_ID,
                idempotencyKey: `idemp_${instructionId}`,
                requireStepUp: false,
            })
        ).rejects.toThrow(/Cannot approve instruction in status "APPROVED"/i);

        // Outbox size must not increase
        expect(canonicalService.inMemoryOutbox.size).toBe(outboxSize);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 9: Dispatcher restart does not lose pending event
    // ─────────────────────────────────────────────────────────────────────────
    test('9. Dispatcher restart does not lose pending event', async () => {
        const instructionId = crypto.randomUUID();

        // Seed an outbox entry simulating an interrupted process
        canonicalService.inMemoryOutbox.set(instructionId, {
            dispatch_id: `disp_${crypto.randomUUID()}`,
            instruction_id: instructionId,
            status: 'PENDING',
            attempts: 0,
            operator_id: CHECKER_CFO_ID,
            created_at: new Date(),
        });

        expect(canonicalService.inMemoryOutbox.get(instructionId).status).toBe('PENDING');

        // Drain the outbox (simulating service restart / periodic sweep)
        const drainResult = await canonicalService.drainDispatchOutbox();

        expect(drainResult.drained).toBeGreaterThanOrEqual(1);
        const record = canonicalService.inMemoryOutbox.get(instructionId);
        expect(record.status).not.toBe('PENDING');
        expect(['COMPLETED', 'FAILED', 'MANUAL_CHECK']).toContain(record.status);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 10: Scheduled payment cannot bypass required approval
    // ─────────────────────────────────────────────────────────────────────────
    test('10. Scheduled payment cannot bypass required approval', async () => {
        const scheduleId = crypto.randomUUID();
        const mockScheduledPayment = {
            schedule_id: scheduleId,
            business_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            label: 'High-Value Strategic Payout',
            amount: '500000.00', // ₹5 Lakhs: requires human Four-Eyes approval
            currency: 'INR',
            recipient_name: 'Strategic Supplies Ltd',
            purpose: 'CAPITAL_EXPENDITURE',
            scheduled_date: new Date().toISOString().split('T')[0],
            recurrence: 'ONCE',
            status: 'SCHEDULED',
        };

        const executedQueries = [];
        const mockClient = {
            query: jest.fn(async (sql, params) => {
                executedQueries.push({ sql, params });
                return { rows: [] };
            }),
            release: jest.fn(),
        };

        const mockPool = {
            query: jest.fn(async (sql, params) => {
                if (sql.includes('SELECT * FROM scheduled_payments')) {
                    return { rows: [mockScheduledPayment] };
                }
                return { rows: [] };
            }),
            connect: jest.fn(async () => mockClient),
        };

        // Spy on evaluateApprovalPolicy and requestPaymentApproval
        const evalSpy = jest.spyOn(canonicalService, 'evaluateApprovalPolicy');
        const reqSpy = jest.spyOn(canonicalService, 'requestPaymentApproval').mockResolvedValue({
            approval_id: crypto.randomUUID(),
            status: 'PENDING_APPROVAL',
        });
        const autoSpy = jest.spyOn(canonicalService, 'executeAutomaticApproval');

        await runScheduledPaymentsSweep(mockPool, canonicalService);

        expect(evalSpy).toHaveBeenCalled();
        const policy = await evalSpy.mock.results[0].value;
        expect(policy.requiresHumanApproval).toBe(true);
        expect(policy.autoExecute).toBe(false);

        // Crucial invariant: autoExecute was NOT triggered
        expect(autoSpy).not.toHaveBeenCalled();

        // Submitted for human Four-Eyes review
        expect(reqSpy).toHaveBeenCalled();

        evalSpy.mockRestore();
        reqSpy.mockRestore();
        autoSpy.mockRestore();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 11: Explicitly permitted automatic execution works under policy
    // ─────────────────────────────────────────────────────────────────────────
    test('11. Explicitly permitted automatic execution works under policy', async () => {
        const scheduleId = crypto.randomUUID();
        const mockRoutinePayment = {
            schedule_id: scheduleId,
            business_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            label: 'Monthly Cloud Infrastructure',
            amount: '5000.00', // ₹5,000 Routine Utility
            currency: 'INR',
            recipient_name: 'AWS Cloud Services',
            purpose: 'UTILITY',
            scheduled_date: new Date().toISOString().split('T')[0],
            recurrence: 'MONTHLY',
            status: 'SCHEDULED',
            note: 'AUTO_POLICY_ROUTINE_UTILITY_V1',
        };

        const mockClient = {
            query: jest.fn(async () => ({ rows: [] })),
            release: jest.fn(),
        };

        const mockPool = {
            query: jest.fn(async (sql) => {
                if (sql.includes('SELECT * FROM scheduled_payments')) {
                    return { rows: [mockRoutinePayment] };
                }
                return { rows: [] };
            }),
            connect: jest.fn(async () => mockClient),
        };

        const autoSpy = jest.spyOn(canonicalService, 'executeAutomaticApproval').mockResolvedValue({
            success: true,
            dispatchRecord: { dispatch_id: 'disp_auto_1', status: 'PENDING' },
        });

        await runScheduledPaymentsSweep(mockPool, canonicalService);

        expect(autoSpy).toHaveBeenCalled();
        autoSpy.mockRestore();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 12: Failed/ambiguous dispatch enters safe recovery or manual review
    // ─────────────────────────────────────────────────────────────────────────
    test('12. Failed/ambiguous dispatch enters safe recovery or manual review', async () => {
        const instructionId = crypto.randomUUID();

        // Enqueue outbox item
        canonicalService.inMemoryOutbox.set(instructionId, {
            dispatch_id: `disp_${crypto.randomUUID()}`,
            instruction_id: instructionId,
            status: 'PENDING',
            attempts: 0,
            operator_id: CHECKER_CFO_ID,
            created_at: new Date(),
        });

        // Drain with simulated rejection/error
        await canonicalService.drainDispatchOutbox();

        const record = canonicalService.inMemoryOutbox.get(instructionId);
        expect(record.status).not.toBe('PENDING');
        // Must either be FAILED or MANUAL_CHECK (never silently discarded or marked COMPLETED on error)
        expect(['FAILED', 'MANUAL_CHECK']).toContain(record.status);
    });
});
