'use strict';

/**
 * PROJECT FUSION — APPROVALS & MAKER-CHECKER ROUTER (AI-2B)
 * ==========================================================
 * Exposes controlled endpoints for payment approval lifecycles:
 * - Submit instruction for dual authorization (payment:initiate)
 * - Inspect approval status and Four-Eyes eligibility (payment:read)
 * - Request WebAuthn step-up challenge (payment:approve)
 * - Approve instruction with WebAuthn assertion (payment:approve)
 * - Reject instruction (payment:reject)
 * - FIDO2 / WebAuthn credential registration
 */

const express = require('express');
const logger = require('../logger');
const { toCanonicalDecimal } = require('../core/orchestrator/financialDecimal');
const { SessionManager } = require('../core/identity/sessionManager');
const {
    createSessionAuthMiddleware,
    requirePermission,
} = require('../core/identity/authMiddleware');
const { defaultMakerCheckerService } = require('../core/approvals/makerCheckerService');
const { defaultCanonicalApprovalService } = require('../core/approvals/canonicalApprovalService');
const { defaultWebAuthnService } = require('../core/identity/webauthnService');
const { defaultRbacService, PERMISSIONS } = require('../core/identity/rbacService');

function createApprovalsRouter({
    makerCheckerService = defaultMakerCheckerService,
    canonicalApprovalService = defaultCanonicalApprovalService,
    webauthnService = defaultWebAuthnService,
    rbacService = defaultRbacService,
    sessionManager = new SessionManager(),
} = {}) {
    const router = express.Router();
    const authenticateSession = createSessionAuthMiddleware(sessionManager);

    // Apply session authentication to all approval endpoints
    router.use(authenticateSession);

    /**
     * POST /api/approvals/request
     * Submits a payment instruction for Maker-Checker review.
     */
    router.post(
        '/request',
        requirePermission(PERMISSIONS.PAYMENT_INITIATE, { rbacService }),
        async (req, res) => {
            try {
                const { instructionId, amount, currency, notes } = req.body || {};
                const pool = req.app?.locals?.pool || null;

                const record = await makerCheckerService.requestPaymentApproval({
                    instructionId,
                    makerOperatorId: req.operator.operatorId,
                    amount,
                    currency,
                    notes,
                    pool,
                });

                return res.status(201).json({
                    message: 'Instruction submitted for dual-authorization',
                    approval: record,
                });
            } catch (err) {
                logger.warn(`[APPROVALS ROUTE] Submit error: ${err.message}`);
                return res.status(err.statusCode || 500).json({
                    error: err.message,
                    code: err.code || 'APPROVAL_REQUEST_FAILED',
                });
            }
        }
    );

    /**
     * GET /api/approvals/:instructionId
     * Retrieves approval status, details, and Four-Eyes eligibility.
     */
    router.get(
        '/:instructionId',
        requirePermission(PERMISSIONS.PAYMENT_READ, { rbacService }),
        async (req, res) => {
            try {
                const { instructionId } = req.params;
                const pool = req.app?.locals?.pool || null;

                const details = await makerCheckerService.getApprovalDetails({
                    instructionId,
                    requestingOperatorId: req.operator.operatorId,
                    pool,
                });

                if (!details) {
                    return res.status(404).json({
                        error: `No approval request found for instruction "${instructionId}"`,
                    });
                }

                return res.json({ approval: details });
            } catch (err) {
                logger.warn(`[APPROVALS ROUTE] Get error: ${err.message}`);
                return res.status(err.statusCode || 500).json({ error: err.message });
            }
        }
    );

    /**
     * POST /api/approvals/:instructionId/challenge
     * Generates a single-use WebAuthn challenge cryptographically bound to the payment context.
     */
    router.post(
        '/:instructionId/challenge',
        requirePermission(PERMISSIONS.PAYMENT_APPROVE, { rbacService }),
        async (req, res) => {
            try {
                const { instructionId } = req.params;
                const pool = req.app?.locals?.pool || null;

                // Retrieve approval details to bind payment context
                const details = await makerCheckerService.getApprovalDetails({
                    instructionId,
                    requestingOperatorId: req.operator.operatorId,
                    pool,
                });

                if (!details) {
                    return res.status(404).json({
                        error: `No approval request found for instruction "${instructionId}"`,
                    });
                }

                const normCurrency = String(details.currency).toUpperCase().trim();
                const paymentContext = {
                    approvalId: details.approval_id || details.approvalId,
                    instructionId,
                    version:
                        details.instruction_version ||
                        details.instruction_current_version ||
                        details.version ||
                        1,
                    amount: toCanonicalDecimal(details.amount, normCurrency),
                    currency: normCurrency,
                    beneficiary: details.recipient || details.beneficiary || '',
                    destination_account:
                        details.destination_account || details.destinationAccount || '',
                    provider: details.provider || 'STRIPE_TEST',
                    environment: details.environment || 'sandbox',
                    action: 'APPROVE',
                    checkerOperatorId: req.operator.operatorId,
                };

                const challengeData = await webauthnService.generateChallenge({
                    operatorId: req.operator.operatorId,
                    ceremonyType: 'authentication',
                    paymentContext,
                    pool,
                });

                return res.json({
                    ...challengeData,
                    paymentContext: {
                        instructionId,
                        version: paymentContext.version,
                        amount: paymentContext.amount,
                        currency: paymentContext.currency,
                        beneficiary: paymentContext.beneficiary,
                        destination_account: paymentContext.destination_account,
                        environment: paymentContext.environment,
                    },
                });
            } catch (err) {
                logger.warn(`[APPROVALS ROUTE] Challenge error: ${err.message}`);
                return res.status(err.statusCode || 500).json({ error: err.message });
            }
        }
    );

    /**
     * POST /api/approvals/:instructionId/approve
     * Approves payment instruction with WebAuthn step-up assertion.
     * Enforces Maker != Checker invariant and authentic checker identity.
     */
    router.post(
        '/:instructionId/approve',
        requirePermission(PERMISSIONS.PAYMENT_APPROVE, { rbacService }),
        async (req, res) => {
            try {
                const { instructionId } = req.params;
                const {
                    webauthnAssertion,
                    credentialId,
                    notes,
                    requireStepUp,
                    checkerOperatorId: clientCheckerId,
                } = req.body || {};
                const pool = req.app?.locals?.pool || null;

                // Finding 4: checkerOperatorId must come strictly from authenticated server-side identity
                if (clientCheckerId && clientCheckerId !== req.operator.operatorId) {
                    return res.status(403).json({
                        error: 'Client-supplied checkerOperatorId does not match authenticated operator identity',
                        code: 'OPERATOR_MISMATCH',
                    });
                }

                const approved = await canonicalApprovalService.approvePayment({
                    instructionId,
                    checkerOperatorId: req.operator.operatorId,
                    webauthnAssertion,
                    credentialId,
                    notes,
                    requireStepUp: requireStepUp !== undefined ? requireStepUp : true,
                    pool,
                });

                return res.json({
                    message:
                        'Payment instruction approved successfully and queued for SAGA execution',
                    approval: approved.approval || approved,
                    dispatch: approved.dispatchRecord || null,
                });
            } catch (err) {
                logger.warn(`[APPROVALS ROUTE] Approval error: ${err.message}`);
                return res.status(err.statusCode || 500).json({
                    error: err.message,
                    code: err.code || 'APPROVAL_FAILED',
                });
            }
        }
    );

    /**
     * POST /api/approvals/:instructionId/reject
     * Rejects payment instruction with reason.
     */
    router.post(
        '/:instructionId/reject',
        requirePermission(PERMISSIONS.PAYMENT_REJECT, { rbacService }),
        async (req, res) => {
            try {
                const { instructionId } = req.params;
                const { rejectionReason } = req.body || {};
                const pool = req.app?.locals?.pool || null;

                const rejected = await makerCheckerService.rejectPayment({
                    instructionId,
                    checkerOperatorId: req.operator.operatorId,
                    rejectionReason,
                    pool,
                });

                return res.json({
                    message: 'Payment instruction rejected',
                    approval: rejected,
                });
            } catch (err) {
                logger.warn(`[APPROVALS ROUTE] Rejection error: ${err.message}`);
                return res.status(err.statusCode || 500).json({
                    error: err.message,
                    code: err.code || 'REJECTION_FAILED',
                });
            }
        }
    );

    /**
     * POST /api/approvals/:instructionId/void/request
     * Initiates a request to void an approved or pending instruction (Dual Control Step 1).
     * Enforces permission 'payment:void_request'.
     */
    router.post(
        '/:instructionId/void/request',
        requirePermission(PERMISSIONS.PAYMENT_VOID_REQUEST, { rbacService }),
        async (req, res) => {
            try {
                const { instructionId } = req.params;
                const { reason } = req.body || {};
                const pool = req.app?.locals?.pool || null;

                const voidReq = await makerCheckerService.requestPaymentVoid({
                    instructionId,
                    requesterOperatorId: req.operator.operatorId,
                    reason,
                    pool,
                });

                return res.status(201).json({
                    message: 'Payment void request created successfully',
                    voidRequest: voidReq,
                });
            } catch (err) {
                logger.warn(`[APPROVALS ROUTE] Void request error: ${err.message}`);
                return res.status(err.statusCode || 500).json({
                    error: err.message,
                    code: err.code || 'VOID_REQUEST_FAILED',
                });
            }
        }
    );

    /**
     * POST /api/approvals/:instructionId/void/challenge
     * Generates a single-use WebAuthn challenge cryptographically bound to void context (action: 'VOID').
     * Enforces permission 'payment:void_approve' and dual control (requester != approver).
     */
    router.post(
        '/:instructionId/void/challenge',
        requirePermission(PERMISSIONS.PAYMENT_VOID_APPROVE, { rbacService }),
        async (req, res) => {
            try {
                const { instructionId } = req.params;
                const { voidRequestId } = req.body || {};
                const pool = req.app?.locals?.pool || null;

                const challengeData = await makerCheckerService.generateVoidApprovalChallenge({
                    instructionId,
                    voidRequestId,
                    approverOperatorId: req.operator.operatorId,
                    pool,
                });

                return res.json(challengeData);
            } catch (err) {
                logger.warn(`[APPROVALS ROUTE] Void challenge error: ${err.message}`);
                return res.status(err.statusCode || 500).json({
                    error: err.message,
                    code: err.code || 'VOID_CHALLENGE_FAILED',
                });
            }
        }
    );

    /**
     * POST /api/approvals/:instructionId/void/approve
     * Approves voiding a payment instruction with WebAuthn step-up assertion (Dual Control Step 2).
     * Enforces permission 'payment:void_approve' and dual control (requester != approver).
     */
    router.post(
        '/:instructionId/void/approve',
        requirePermission(PERMISSIONS.PAYMENT_VOID_APPROVE, { rbacService }),
        async (req, res) => {
            try {
                const { instructionId } = req.params;
                const { voidRequestId, webauthnAssertion, credentialId, requireStepUp } =
                    req.body || {};
                const pool = req.app?.locals?.pool || null;

                const voided = await makerCheckerService.approvePaymentVoid({
                    instructionId,
                    voidRequestId,
                    approverOperatorId: req.operator.operatorId,
                    webauthnAssertion,
                    credentialId,
                    requireStepUp: requireStepUp !== undefined ? requireStepUp : true,
                    pool,
                });

                return res.json({
                    message: 'Payment instruction voided successfully under dual control',
                    result: voided,
                });
            } catch (err) {
                logger.warn(`[APPROVALS ROUTE] Void approve error: ${err.message}`);
                return res.status(err.statusCode || 500).json({
                    error: err.message,
                    code: err.code || 'VOID_APPROVE_FAILED',
                });
            }
        }
    );

    /**
     * POST /api/approvals/:instructionId/void
     * Convenience dual-control void endpoint requiring independent requester and approver identities.
     */
    router.post('/:instructionId/void', async (req, res) => {
        try {
            const { instructionId } = req.params;
            const {
                reason,
                requesterOperatorId,
                approverOperatorId,
                webauthnAssertion,
                credentialId,
                requireStepUp,
            } = req.body || {};
            const pool = req.app?.locals?.pool || null;

            // If caller supplies requesterOperatorId, approver is current operator (or vice-versa)
            const reqId = requesterOperatorId || req.operator.operatorId;
            const apprId = approverOperatorId || req.operator.operatorId;

            const voided = await makerCheckerService.voidPaymentInstruction({
                instructionId,
                requesterOperatorId: reqId,
                approverOperatorId: apprId,
                reason: reason || 'Voided by authorized operator',
                webauthnAssertion,
                credentialId,
                requireStepUp: requireStepUp !== undefined ? requireStepUp : false,
                pool,
            });

            return res.json({
                message: 'Payment instruction voided successfully',
                result: voided,
            });
        } catch (err) {
            logger.warn(`[APPROVALS ROUTE] Void error: ${err.message}`);
            return res.status(err.statusCode || 500).json({
                error: err.message,
                code: err.code || 'VOID_FAILED',
            });
        }
    });

    /**
     * POST /api/approvals/:instructionId/hold
     * Places a payment instruction on compliance hold (Compliance Officer action).
     * Enforces permission 'compliance:hold'.
     */
    router.post(
        '/:instructionId/hold',
        requirePermission(PERMISSIONS.COMPLIANCE_HOLD, { rbacService }),
        async (req, res) => {
            try {
                const { instructionId } = req.params;
                const { reason } = req.body || {};
                const pool = req.app?.locals?.pool || null;

                const held = await makerCheckerService.holdPayment({
                    instructionId,
                    officerOperatorId: req.operator.operatorId,
                    reason,
                    pool,
                });

                return res.json({
                    message: 'Payment instruction placed on compliance hold',
                    approval: held,
                });
            } catch (err) {
                logger.warn(`[APPROVALS ROUTE] Hold error: ${err.message}`);
                return res.status(err.statusCode || 500).json({
                    error: err.message,
                    code: err.code || 'HOLD_FAILED',
                });
            }
        }
    );

    /**
     * POST /api/approvals/:instructionId/release
     * Releases compliance hold on a payment instruction (Compliance Officer action).
     * Enforces permission 'compliance:release'.
     */
    router.post(
        '/:instructionId/release',
        requirePermission(PERMISSIONS.COMPLIANCE_RELEASE, { rbacService }),
        async (req, res) => {
            try {
                const { instructionId } = req.params;
                const { notes } = req.body || {};
                const pool = req.app?.locals?.pool || null;

                const released = await makerCheckerService.releaseHold({
                    instructionId,
                    officerOperatorId: req.operator.operatorId,
                    notes,
                    pool,
                });

                return res.json({
                    message: 'Compliance hold released successfully',
                    approval: released,
                });
            } catch (err) {
                logger.warn(`[APPROVALS ROUTE] Release error: ${err.message}`);
                return res.status(err.statusCode || 500).json({
                    error: err.message,
                    code: err.code || 'RELEASE_FAILED',
                });
            }
        }
    );

    /**
     * POST /api/approvals/webauthn/register-challenge
     * Generates a registration challenge for registering an authenticator.
     */
    router.post('/webauthn/register-challenge', async (req, res) => {
        try {
            const pool = req.app?.locals?.pool || null;
            const challengeData = await webauthnService.generateChallenge({
                operatorId: req.operator.operatorId,
                ceremonyType: 'registration',
                pool,
            });
            return res.json(challengeData);
        } catch (err) {
            logger.warn(`[WEBAUTHN ROUTE] Register challenge error: ${err.message}`);
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    /**
     * POST /api/approvals/webauthn/register
     * Registers a WebAuthn public key credential for the current operator.
     */
    router.post('/webauthn/register', async (req, res) => {
        try {
            const { credentialId, publicKeyPem, challenge, clientDataJSON } = req.body || {};
            const pool = req.app?.locals?.pool || null;

            const registered = await webauthnService.registerCredential({
                operatorId: req.operator.operatorId,
                credentialId,
                publicKeyPem,
                challenge,
                clientDataJSON,
                pool,
            });

            return res.status(201).json({
                message: 'WebAuthn credential registered successfully',
                credential: registered,
            });
        } catch (err) {
            logger.warn(`[WEBAUTHN ROUTE] Register error: ${err.message}`);
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    /**
     * POST /api/approvals/:instructionId/amend
     * Amends a payment instruction (Maker action).
     * Enforces permission 'payment:initiate'.
     * Increments instruction version and invalidates pending approval.
     */
    router.post(
        '/:instructionId/amend',
        requirePermission(PERMISSIONS.PAYMENT_INITIATE, { rbacService }),
        async (req, res) => {
            try {
                const { instructionId } = req.params;
                const amendments = req.body || {};
                const pool = req.app?.locals?.pool || null;

                const amended = await makerCheckerService.amendPaymentInstruction({
                    instructionId,
                    makerOperatorId: req.operator.operatorId,
                    amendments,
                    pool,
                });

                return res.json({
                    message:
                        'Payment instruction amended successfully; version incremented and approval invalidated',
                    instruction: amended,
                });
            } catch (err) {
                logger.warn(`[APPROVALS ROUTE] Amend error: ${err.message}`);
                return res.status(err.statusCode || 500).json({
                    error: err.message,
                    code: err.code || 'AMENDMENT_FAILED',
                });
            }
        }
    );

    // --------------------------------------------------------------------------
    // DUAL CONTROL ROLE MANAGEMENT ENDPOINTS
    // --------------------------------------------------------------------------

    /**
     * POST /api/approvals/roles/request
     * Submits a role change request under Dual Control.
     * Enforces 'admin:manage_roles'.
     */
    router.post(
        '/roles/request',
        requirePermission(PERMISSIONS.ADMIN_MANAGE_ROLES, { rbacService }),
        async (req, res) => {
            try {
                const { targetOperatorId, roleKey, action, reason } = req.body || {};
                const pool = req.app?.locals?.pool || null;

                const request = await rbacService.requestRoleChange({
                    requestingOperatorId: req.operator.operatorId,
                    targetOperatorId,
                    roleKey,
                    action,
                    reason,
                    pool,
                });

                return res.status(201).json({
                    message: 'Role change request submitted for independent Dual Control review',
                    request,
                });
            } catch (err) {
                logger.warn(`[ROLES DUAL CONTROL] Request error: ${err.message}`);
                return res.status(err.statusCode || 500).json({
                    error: err.message,
                    code: err.code || 'ROLE_REQUEST_FAILED',
                });
            }
        }
    );

    /**
     * POST /api/approvals/roles/:requestId/approve
     * Approves a role change request (Independent Checker action).
     * Enforces Four-Eyes: requester !== approver.
     */
    router.post(
        '/roles/:requestId/approve',
        requirePermission(PERMISSIONS.ADMIN_MANAGE_ROLES, { rbacService }),
        async (req, res) => {
            try {
                const { requestId } = req.params;
                const pool = req.app?.locals?.pool || null;

                const approved = await rbacService.approveRoleChange({
                    requestId,
                    approvingOperatorId: req.operator.operatorId,
                    pool,
                });

                return res.json({
                    message: 'Role change request approved and executed under Dual Control',
                    request: approved,
                });
            } catch (err) {
                logger.warn(`[ROLES DUAL CONTROL] Approve error: ${err.message}`);
                return res.status(err.statusCode || 500).json({
                    error: err.message,
                    code: err.code || 'ROLE_APPROVAL_FAILED',
                });
            }
        }
    );

    /**
     * POST /api/approvals/roles/:requestId/reject
     * Rejects a role change request.
     */
    router.post(
        '/roles/:requestId/reject',
        requirePermission(PERMISSIONS.ADMIN_MANAGE_ROLES, { rbacService }),
        async (req, res) => {
            try {
                const { requestId } = req.params;
                const { reason } = req.body || {};
                const pool = req.app?.locals?.pool || null;

                const rejected = await rbacService.rejectRoleChange({
                    requestId,
                    approvingOperatorId: req.operator.operatorId,
                    reason,
                    pool,
                });

                return res.json({
                    message: 'Role change request rejected',
                    request: rejected,
                });
            } catch (err) {
                logger.warn(`[ROLES DUAL CONTROL] Reject error: ${err.message}`);
                return res.status(err.statusCode || 500).json({
                    error: err.message,
                    code: err.code || 'ROLE_REJECTION_FAILED',
                });
            }
        }
    );

    /**
     * GET /api/approvals/roles/requests
     * Lists role change requests.
     */
    router.get(
        '/roles/requests',
        requirePermission(PERMISSIONS.ADMIN_MANAGE_ROLES, { rbacService }),
        async (req, res) => {
            try {
                const { status } = req.query;
                const pool = req.app?.locals?.pool || null;

                const requests = await rbacService.listRoleChangeRequests({
                    status,
                    pool,
                });

                return res.json({ requests });
            } catch (err) {
                logger.warn(`[ROLES DUAL CONTROL] List error: ${err.message}`);
                return res.status(err.statusCode || 500).json({ error: err.message });
            }
        }
    );

    return router;
}

module.exports = {
    createApprovalsRouter,
};
