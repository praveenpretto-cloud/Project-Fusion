'use strict';

/**
 * PROJECT FUSION — ENTERPRISE ROLE-BASED ACCESS CONTROL (AI-2B)
 * ==============================================================
 * Centralizes role and permission resolution, assignment lifecycle,
 * and security governance.
 *
 * 5 Standard Roles:
 * - OPS_OPERATOR: Daily operational payment initiation & monitoring
 * - TREASURY_ANALYST: High-value treasury operations & liquidity monitoring
 * - COMPLIANCE_OFFICER: Four-Eyes Maker-Checker approval and regulatory review
 * - SYSTEM_ADMIN: Operator identity, role assignments, system config
 * - AUDITOR: Strictly read-only audit, compliance, and ledger review
 *
 * Strict Security Boundaries:
 * - AI Operations Intelligence has ZERO initiate or approve permissions.
 * - Separation of duties: Makers cannot possess approval authority for their own actions.
 * - Every role change and permission check denial is recorded in immutable audit logs.
 */

const crypto = require('crypto');
const logger = require('../../logger');

const ROLES = Object.freeze({
    OPS_OPERATOR: 'OPS_OPERATOR',
    TREASURY_ANALYST: 'TREASURY_ANALYST',
    COMPLIANCE_OFFICER: 'COMPLIANCE_OFFICER',
    SYSTEM_ADMIN: 'SYSTEM_ADMIN',
    AUDITOR: 'AUDITOR',
});

const SENSITIVE_ROLES = Object.freeze([
    ROLES.SYSTEM_ADMIN,
    ROLES.TREASURY_ANALYST,
    ROLES.COMPLIANCE_OFFICER,
]);

const PERMISSIONS = Object.freeze({
    PAYMENT_INITIATE: 'payment:initiate',
    PAYMENT_APPROVE: 'payment:approve',
    PAYMENT_REJECT: 'payment:reject',
    PAYMENT_READ: 'payment:read',
    PAYMENT_READ_SENSITIVE: 'payment:read:sensitive',
    PAYMENT_VOID_REQUEST: 'payment:void_request',
    PAYMENT_VOID_APPROVE: 'payment:void_approve',
    TREASURY_READ: 'treasury:read',
    TREASURY_MANAGE: 'treasury:manage',
    COMPLIANCE_READ: 'compliance:read',
    COMPLIANCE_WRITE: 'compliance:write',
    COMPLIANCE_HOLD: 'compliance:hold',
    COMPLIANCE_RELEASE: 'compliance:release',
    ADMIN_MANAGE_ROLES: 'admin:manage_roles',
    ADMIN_MANAGE_OPERATORS: 'admin:manage_operators',
    AUDIT_READ: 'audit:read',
    SYSTEM_CONFIG: 'system:config',
    EVIDENCE_READ: 'evidence:read',
});

const DEFAULT_ROLE_PERMISSIONS = Object.freeze({
    [ROLES.OPS_OPERATOR]: Object.freeze([
        PERMISSIONS.PAYMENT_INITIATE,
        PERMISSIONS.PAYMENT_READ,
        PERMISSIONS.EVIDENCE_READ,
        PERMISSIONS.PAYMENT_VOID_REQUEST,
    ]),
    [ROLES.TREASURY_ANALYST]: Object.freeze([
        PERMISSIONS.PAYMENT_APPROVE,
        PERMISSIONS.PAYMENT_REJECT,
        PERMISSIONS.PAYMENT_READ,
        PERMISSIONS.PAYMENT_READ_SENSITIVE,
        PERMISSIONS.TREASURY_READ,
        PERMISSIONS.TREASURY_MANAGE,
        PERMISSIONS.PAYMENT_VOID_REQUEST,
        PERMISSIONS.PAYMENT_VOID_APPROVE,
    ]),
    [ROLES.COMPLIANCE_OFFICER]: Object.freeze([
        PERMISSIONS.COMPLIANCE_READ,
        PERMISSIONS.COMPLIANCE_WRITE,
        PERMISSIONS.COMPLIANCE_HOLD,
        PERMISSIONS.COMPLIANCE_RELEASE,
        PERMISSIONS.PAYMENT_READ,
        PERMISSIONS.PAYMENT_READ_SENSITIVE,
        PERMISSIONS.EVIDENCE_READ,
    ]),
    [ROLES.SYSTEM_ADMIN]: Object.freeze([
        PERMISSIONS.ADMIN_MANAGE_ROLES,
        PERMISSIONS.ADMIN_MANAGE_OPERATORS,
        PERMISSIONS.SYSTEM_CONFIG,
        PERMISSIONS.AUDIT_READ,
    ]),
    [ROLES.AUDITOR]: Object.freeze([
        PERMISSIONS.AUDIT_READ,
        PERMISSIONS.EVIDENCE_READ,
        PERMISSIONS.COMPLIANCE_READ,
        PERMISSIONS.TREASURY_READ,
    ]),
});

class RbacService {
    constructor() {
        // In-memory fallback for local test execution without live DB
        this.inMemoryAssignments = new Map([
            ['00000000-0000-4000-8000-000000000001', new Set([ROLES.TREASURY_ANALYST])],
            ['00000000-0000-4000-8000-000000000002', new Set([ROLES.OPS_OPERATOR])],
            ['00000000-0000-4000-8000-000000000003', new Set([ROLES.AUDITOR])],
            ['00000000-0000-4000-8000-000000000004', new Set([ROLES.COMPLIANCE_OFFICER])],
            ['00000000-0000-4000-8000-000000000005', new Set([ROLES.SYSTEM_ADMIN])],
        ]);
        this.inMemoryAuditLogs = [];
        this.inMemoryRoleChangeRequests = new Map();
    }

    /**
     * Retrieves active roles assigned to an operator.
     * @param {string} operatorId - Operator UUID
     * @param {object} [options]
     * @param {object} [options.pool] - PostgreSQL Pool
     * @returns {Promise<string[]>} List of role keys
     */
    async getOperatorRoles(operatorId, { pool = null } = {}) {
        if (!operatorId) return [];

        if (pool) {
            const query = `
                SELECT r.role_key
                FROM identity.operator_role_assignments ora
                JOIN identity.roles r ON ora.role_id = r.role_id
                WHERE ora.operator_id = $1 AND ora.is_active = TRUE
            `;
            const res = await pool.query(query, [operatorId]);
            return res.rows.map((row) => row.role_key);
        }

        const rolesSet = this.inMemoryAssignments.get(operatorId);
        return rolesSet ? Array.from(rolesSet) : [];
    }

    /**
     * Resolves all effective permissions for an operator across all active assigned roles.
     * @param {string} operatorId - Operator UUID
     * @param {object} [options]
     * @param {object} [options.pool] - PostgreSQL Pool
     * @returns {Promise<Set<string>>} Set of permission keys
     */
    async getOperatorPermissions(operatorId, { pool = null } = {}) {
        if (!operatorId) return new Set();

        if (pool) {
            const query = `
                SELECT DISTINCT p.permission_key
                FROM identity.operator_role_assignments ora
                JOIN identity.roles r ON ora.role_id = r.role_id
                JOIN identity.role_permissions rp ON r.role_id = rp.role_id
                JOIN identity.permissions p ON rp.permission_id = p.permission_id
                WHERE ora.operator_id = $1 AND ora.is_active = TRUE
            `;
            const res = await pool.query(query, [operatorId]);
            return new Set(res.rows.map((row) => row.permission_key));
        }

        const roles = await this.getOperatorRoles(operatorId);
        const perms = new Set();
        for (const role of roles) {
            const rolePerms = DEFAULT_ROLE_PERMISSIONS[role] || [];
            for (const p of rolePerms) {
                perms.add(p);
            }
        }
        return perms;
    }

    /**
     * Checks whether an operator possesses a required permission.
     * @param {string} operatorId - Operator UUID
     * @param {string} permissionKey - e.g. 'payment:initiate'
     * @param {object} [options]
     * @param {object} [options.pool] - PostgreSQL Pool
     * @returns {Promise<boolean>}
     */
    async hasPermission(operatorId, permissionKey, { pool = null } = {}) {
        if (!operatorId || !permissionKey) return false;
        const permissions = await this.getOperatorPermissions(operatorId, { pool });
        return permissions.has(permissionKey);
    }

    /**
     * Asserts an operator has permission, throwing 403 if absent.
     */
    async assertPermission(operatorId, permissionKey, { pool = null } = {}) {
        const allowed = await this.hasPermission(operatorId, permissionKey, { pool });
        if (!allowed) {
            const roles = await this.getOperatorRoles(operatorId, { pool });
            await this.logSecurityEvent({
                eventType: 'PERMISSION_DENIED',
                operatorId,
                metadata: {
                    attemptedPermission: permissionKey,
                    operatorRoles: roles,
                },
                pool,
            });
            const err = new Error(`Access denied: operator lacks required permission "${permissionKey}"`);
            err.statusCode = 403;
            err.code = 'PERMISSION_DENIED';
            throw err;
        }
        return true;
    }

    /**
     * Assigns a role to an operator.
     * Requires assignedBy operator to have 'admin:manage_roles' permission.
     * Enforces self-elevation protection: operators cannot assign roles to themselves.
     * Enforces Dual Control: Sensitive roles (SYSTEM_ADMIN, TREASURY_ANALYST, COMPLIANCE_OFFICER)
     * cannot be assigned unilaterally without an approved role change request.
     */
    async assignRoleToOperator({ operatorId, roleKey, assignedBy = null, bypassDualControl = false, pool = null } = {}) {
        if (!operatorId || !roleKey) {
            throw new Error('operatorId and roleKey are required for role assignment');
        }

        // Defend against self-elevation
        if (assignedBy && assignedBy === operatorId) {
            const err = new Error('Self-elevation prohibited: operators cannot grant roles to themselves');
            err.statusCode = 403;
            err.code = 'SELF_ELEVATION_PROHIBITED';
            throw err;
        }

        if (!ROLES[roleKey]) {
            const err = new Error(`Invalid role: "${roleKey}". Allowed roles: ${Object.keys(ROLES).join(', ')}`);
            err.statusCode = 400;
            throw err;
        }

        // Dual control enforcement for sensitive roles
        if (assignedBy && SENSITIVE_ROLES.includes(roleKey) && !bypassDualControl) {
            const err = new Error(`Dual control required: Assigning sensitive role "${roleKey}" requires an approved role change request.`);
            err.statusCode = 403;
            err.code = 'DUAL_CONTROL_REQUIRED';
            throw err;
        }

        if (assignedBy) {
            await this.assertPermission(assignedBy, PERMISSIONS.ADMIN_MANAGE_ROLES, { pool });
        }

        const beforeRoles = await this.getOperatorRoles(operatorId, { pool });

        if (pool) {
            // Lookup role_id
            const roleRes = await pool.query('SELECT role_id FROM identity.roles WHERE role_key = $1', [roleKey]);
            if (roleRes.rows.length === 0) {
                throw new Error(`Role "${roleKey}" not found in database`);
            }
            const roleId = roleRes.rows[0].role_id;

            await pool.query(
                `INSERT INTO identity.operator_role_assignments (operator_id, role_id, is_active, assigned_by, assigned_at, revoked_at, revoked_by)
                 VALUES ($1, $2, TRUE, $3, NOW(), NULL, NULL)
                 ON CONFLICT (operator_id, role_id)
                 DO UPDATE SET is_active = TRUE, assigned_by = EXCLUDED.assigned_by, assigned_at = NOW(), revoked_at = NULL, revoked_by = NULL`,
                [operatorId, roleId, assignedBy]
            );
        } else {
            let userRoles = this.inMemoryAssignments.get(operatorId);
            if (!userRoles) {
                userRoles = new Set();
                this.inMemoryAssignments.set(operatorId, userRoles);
            }
            userRoles.add(roleKey);
        }

        const afterRoles = await this.getOperatorRoles(operatorId, { pool });

        await this.logSecurityEvent({
            eventType: 'ROLE_ASSIGNED',
            operatorId,
            metadata: {
                roleKey,
                assignedBy,
                beforeRoles,
                afterRoles,
            },
            pool,
        });

        logger.info(`[RBAC] Assigned role "${roleKey}" to operator ${operatorId} by ${assignedBy || 'system'}`);
        return { success: true, operatorId, roleKey, beforeRoles, afterRoles };
    }

    /**
     * Revokes a role from an operator.
     * Requires revokedBy operator to have 'admin:manage_roles' permission.
     * Enforces Dual Control: Sensitive roles cannot be revoked unilaterally without
     * an approved role change request.
     */
    async revokeRoleFromOperator({ operatorId, roleKey, revokedBy = null, bypassDualControl = false, pool = null } = {}) {
        if (!operatorId || !roleKey) {
            throw new Error('operatorId and roleKey are required for role revocation');
        }

        if (revokedBy && revokedBy === operatorId) {
            const err = new Error('Self-modification prohibited: operators cannot revoke roles from themselves');
            err.statusCode = 403;
            err.code = 'SELF_MODIFICATION_PROHIBITED';
            throw err;
        }

        // Dual control enforcement for sensitive roles
        if (revokedBy && SENSITIVE_ROLES.includes(roleKey) && !bypassDualControl) {
            const err = new Error(`Dual control required: Revoking sensitive role "${roleKey}" requires an approved role change request.`);
            err.statusCode = 403;
            err.code = 'DUAL_CONTROL_REQUIRED';
            throw err;
        }

        if (revokedBy) {
            await this.assertPermission(revokedBy, PERMISSIONS.ADMIN_MANAGE_ROLES, { pool });
        }

        const beforeRoles = await this.getOperatorRoles(operatorId, { pool });

        if (pool) {
            const roleRes = await pool.query('SELECT role_id FROM identity.roles WHERE role_key = $1', [roleKey]);
            if (roleRes.rows.length === 0) {
                throw new Error(`Role "${roleKey}" not found in database`);
            }
            const roleId = roleRes.rows[0].role_id;

            await pool.query(
                `UPDATE identity.operator_role_assignments
                 SET is_active = FALSE, revoked_at = NOW(), revoked_by = $1
                 WHERE operator_id = $2 AND role_id = $3`,
                [revokedBy, operatorId, roleId]
            );
        } else {
            const userRoles = this.inMemoryAssignments.get(operatorId);
            if (userRoles) {
                userRoles.delete(roleKey);
            }
        }

        const afterRoles = await this.getOperatorRoles(operatorId, { pool });

        await this.logSecurityEvent({
            eventType: 'ROLE_REVOKED',
            operatorId,
            metadata: {
                roleKey,
                revokedBy,
                beforeRoles,
                afterRoles,
            },
            pool,
        });

        logger.info(`[RBAC] Revoked role "${roleKey}" from operator ${operatorId} by ${revokedBy || 'system'}`);
        return { success: true, operatorId, roleKey, beforeRoles, afterRoles };
    }

    /**
     * Submits a role change request under Dual Control.
     * Enforces:
     * 1. Requesting operator has 'admin:manage_roles'
     * 2. Cannot request role change for oneself (requestingOperatorId !== targetOperatorId)
     * 3. Valid role and action ('ASSIGN' | 'REVOKE')
     */
    async requestRoleChange({
        requestingOperatorId,
        targetOperatorId,
        roleKey,
        action,
        reason,
        pool = null,
    } = {}) {
        if (!requestingOperatorId || !targetOperatorId || !roleKey || !action || !reason) {
            const err = new Error('requestingOperatorId, targetOperatorId, roleKey, action, and reason are required');
            err.statusCode = 400;
            throw err;
        }

        if (requestingOperatorId === targetOperatorId) {
            const err = new Error('Self-elevation prohibited: operators cannot submit role change requests for themselves');
            err.statusCode = 403;
            err.code = 'SELF_ELEVATION_PROHIBITED';
            throw err;
        }

        if (!ROLES[roleKey]) {
            const err = new Error(`Invalid role: "${roleKey}". Allowed roles: ${Object.keys(ROLES).join(', ')}`);
            err.statusCode = 400;
            throw err;
        }

        if (!['ASSIGN', 'REVOKE'].includes(action)) {
            const err = new Error(`Invalid action: "${action}". Allowed: ASSIGN, REVOKE`);
            err.statusCode = 400;
            throw err;
        }

        await this.assertPermission(requestingOperatorId, PERMISSIONS.ADMIN_MANAGE_ROLES, { pool });

        const requestId = crypto.randomUUID();
        let record;

        if (pool) {
            const res = await pool.query(
                `INSERT INTO identity.role_change_requests (
                    request_id, requesting_operator_id, target_operator_id, role_key, action, reason, status
                 ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
                 RETURNING *`,
                [requestId, requestingOperatorId, targetOperatorId, roleKey, action, reason]
            );
            record = res.rows[0];
        } else {
            record = {
                requestId,
                request_id: requestId,
                requestingOperatorId,
                requesting_operator_id: requestingOperatorId,
                targetOperatorId,
                target_operator_id: targetOperatorId,
                roleKey,
                role_key: roleKey,
                action,
                reason,
                status: 'PENDING',
                approvingOperatorId: null,
                approving_operator_id: null,
                rejectionReason: null,
                rejection_reason: null,
                createdAt: new Date(),
                decidedAt: null,
            };
            this.inMemoryRoleChangeRequests.set(requestId, record);
        }

        await this.logSecurityEvent({
            eventType: 'ROLE_CHANGE_REQUESTED',
            operatorId: requestingOperatorId,
            metadata: {
                requestId,
                targetOperatorId,
                roleKey,
                action,
                reason,
            },
            pool,
        });

        logger.info(`[RBAC] Role change requested: ${action} "${roleKey}" for ${targetOperatorId} by ${requestingOperatorId}`);
        return record;
    }

    /**
     * Approves a pending role change request under Dual Control.
     * Enforces:
     * 1. Approving operator has 'admin:manage_roles'
     * 2. FOUR-EYES DUAL CONTROL: requestingOperatorId !== approvingOperatorId
     * 3. Cannot approve role change targeting oneself (targetOperatorId !== approvingOperatorId)
     * 4. Request must be in PENDING status
     * 5. Atomically executes the role change and marks request APPROVED
     */
    async approveRoleChange({ requestId, approvingOperatorId, pool = null } = {}) {
        if (!requestId || !approvingOperatorId) {
            const err = new Error('requestId and approvingOperatorId are required');
            err.statusCode = 400;
            throw err;
        }

        await this.assertPermission(approvingOperatorId, PERMISSIONS.ADMIN_MANAGE_ROLES, { pool });

        let updatedRecord;
        if (pool) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                const res = await client.query(
                    `SELECT * FROM identity.role_change_requests WHERE request_id = $1 FOR UPDATE`,
                    [requestId]
                );
                if (res.rows.length === 0) {
                    const err = new Error(`Role change request "${requestId}" not found`);
                    err.statusCode = 404;
                    throw err;
                }
                const request = res.rows[0];

                if (request.status !== 'PENDING') {
                    const err = new Error(`Cannot approve role change request in status "${request.status}"`);
                    err.statusCode = 409;
                    err.code = 'INVALID_REQUEST_STATE';
                    throw err;
                }

                // FOUR-EYES DUAL CONTROL: Requester cannot approve own request!
                if (request.requesting_operator_id === approvingOperatorId) {
                    const err = new Error('Dual control violation: An operator cannot approve their own role change request.');
                    err.statusCode = 403;
                    err.code = 'DUAL_CONTROL_VIOLATION';
                    throw err;
                }

                // Self-elevation check: Target cannot approve elevation for themselves!
                if (request.target_operator_id === approvingOperatorId) {
                    const err = new Error('Self-elevation prohibited: An operator cannot approve their own role change.');
                    err.statusCode = 403;
                    err.code = 'SELF_ELEVATION_PROHIBITED';
                    throw err;
                }

                // Apply role change
                if (request.action === 'ASSIGN') {
                    await this.assignRoleToOperator({
                        operatorId: request.target_operator_id,
                        roleKey: request.role_key,
                        assignedBy: approvingOperatorId,
                        bypassDualControl: true,
                        pool: client,
                    });
                } else if (request.action === 'REVOKE') {
                    await this.revokeRoleFromOperator({
                        operatorId: request.target_operator_id,
                        roleKey: request.role_key,
                        revokedBy: approvingOperatorId,
                        bypassDualControl: true,
                        pool: client,
                    });
                }

                const updateRes = await client.query(
                    `UPDATE identity.role_change_requests
                     SET status = 'APPROVED',
                         approving_operator_id = $1,
                         decided_at = NOW()
                     WHERE request_id = $2
                     RETURNING *`,
                    [approvingOperatorId, requestId]
                );
                updatedRecord = updateRes.rows[0];

                await this.logSecurityEvent({
                    eventType: 'ROLE_CHANGE_APPROVED',
                    operatorId: approvingOperatorId,
                    metadata: {
                        requestId,
                        requestingOperatorId: request.requesting_operator_id,
                        targetOperatorId: request.target_operator_id,
                        roleKey: request.role_key,
                        action: request.action,
                    },
                    pool: client,
                });

                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } else {
            const request = this.inMemoryRoleChangeRequests.get(requestId);
            if (!request) {
                const err = new Error(`Role change request "${requestId}" not found`);
                err.statusCode = 404;
                throw err;
            }

            if (request.status !== 'PENDING') {
                const err = new Error(`Cannot approve role change request in status "${request.status}"`);
                err.statusCode = 409;
                err.code = 'INVALID_REQUEST_STATE';
                throw err;
            }

            const requesterId = request.requesting_operator_id || request.requestingOperatorId;
            const targetId = request.target_operator_id || request.targetOperatorId;
            const roleKey = request.role_key || request.roleKey;

            if (requesterId === approvingOperatorId) {
                const err = new Error('Dual control violation: An operator cannot approve their own role change request.');
                err.statusCode = 403;
                err.code = 'DUAL_CONTROL_VIOLATION';
                throw err;
            }

            if (targetId === approvingOperatorId) {
                const err = new Error('Self-elevation prohibited: An operator cannot approve their own role change.');
                err.statusCode = 403;
                err.code = 'SELF_ELEVATION_PROHIBITED';
                throw err;
            }

            if (request.action === 'ASSIGN') {
                await this.assignRoleToOperator({
                    operatorId: targetId,
                    roleKey,
                    assignedBy: approvingOperatorId,
                    bypassDualControl: true,
                });
            } else if (request.action === 'REVOKE') {
                await this.revokeRoleFromOperator({
                    operatorId: targetId,
                    roleKey,
                    revokedBy: approvingOperatorId,
                    bypassDualControl: true,
                });
            }

            request.status = 'APPROVED';
            request.approvingOperatorId = approvingOperatorId;
            request.approving_operator_id = approvingOperatorId;
            request.decidedAt = new Date();
            updatedRecord = request;

            await this.logSecurityEvent({
                eventType: 'ROLE_CHANGE_APPROVED',
                operatorId: approvingOperatorId,
                metadata: {
                    requestId,
                    requestingOperatorId: requesterId,
                    targetOperatorId: targetId,
                    roleKey,
                    action: request.action,
                },
            });
        }

        logger.info(`[RBAC] ✅ Role change approved: ${updatedRecord.action} for ${updatedRecord.target_operator_id || updatedRecord.targetOperatorId} by ${approvingOperatorId}`);
        return updatedRecord;
    }

    /**
     * Rejects a pending role change request under Dual Control.
     */
    async rejectRoleChange({ requestId, approvingOperatorId, reason, pool = null } = {}) {
        if (!requestId || !approvingOperatorId || !reason) {
            const err = new Error('requestId, approvingOperatorId, and reason are required');
            err.statusCode = 400;
            throw err;
        }

        await this.assertPermission(approvingOperatorId, PERMISSIONS.ADMIN_MANAGE_ROLES, { pool });

        let updatedRecord;
        if (pool) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                const res = await client.query(
                    `SELECT * FROM identity.role_change_requests WHERE request_id = $1 FOR UPDATE`,
                    [requestId]
                );
                if (res.rows.length === 0) {
                    const err = new Error(`Role change request "${requestId}" not found`);
                    err.statusCode = 404;
                    throw err;
                }
                const request = res.rows[0];

                if (request.status !== 'PENDING') {
                    const err = new Error(`Cannot reject role change request in status "${request.status}"`);
                    err.statusCode = 409;
                    err.code = 'INVALID_REQUEST_STATE';
                    throw err;
                }

                if (request.requesting_operator_id === approvingOperatorId) {
                    const err = new Error('Dual control violation: An operator cannot review their own role change request.');
                    err.statusCode = 403;
                    err.code = 'DUAL_CONTROL_VIOLATION';
                    throw err;
                }

                const updateRes = await client.query(
                    `UPDATE identity.role_change_requests
                     SET status = 'REJECTED',
                         approving_operator_id = $1,
                         rejection_reason = $2,
                         decided_at = NOW()
                     WHERE request_id = $3
                     RETURNING *`,
                    [approvingOperatorId, reason, requestId]
                );
                updatedRecord = updateRes.rows[0];

                await this.logSecurityEvent({
                    eventType: 'ROLE_CHANGE_REJECTED',
                    operatorId: approvingOperatorId,
                    metadata: {
                        requestId,
                        requestingOperatorId: request.requesting_operator_id,
                        targetOperatorId: request.target_operator_id,
                        roleKey: request.role_key,
                        reason,
                    },
                    pool: client,
                });

                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        } else {
            const request = this.inMemoryRoleChangeRequests.get(requestId);
            if (!request) {
                const err = new Error(`Role change request "${requestId}" not found`);
                err.statusCode = 404;
                throw err;
            }

            if (request.status !== 'PENDING') {
                const err = new Error(`Cannot reject role change request in status "${request.status}"`);
                err.statusCode = 409;
                err.code = 'INVALID_REQUEST_STATE';
                throw err;
            }

            const requesterId = request.requesting_operator_id || request.requestingOperatorId;
            if (requesterId === approvingOperatorId) {
                const err = new Error('Dual control violation: An operator cannot review their own role change request.');
                err.statusCode = 403;
                err.code = 'DUAL_CONTROL_VIOLATION';
                throw err;
            }

            request.status = 'REJECTED';
            request.approvingOperatorId = approvingOperatorId;
            request.approving_operator_id = approvingOperatorId;
            request.rejectionReason = reason;
            request.rejection_reason = reason;
            request.decidedAt = new Date();
            updatedRecord = request;

            await this.logSecurityEvent({
                eventType: 'ROLE_CHANGE_REJECTED',
                operatorId: approvingOperatorId,
                metadata: {
                    requestId,
                    requestingOperatorId: requesterId,
                    targetOperatorId: request.target_operator_id || request.targetOperatorId,
                    roleKey: request.role_key || request.roleKey,
                    reason,
                },
            });
        }

        logger.info(`[RBAC] 🛑 Role change rejected for ${updatedRecord.target_operator_id || updatedRecord.targetOperatorId} by ${approvingOperatorId}`);
        return updatedRecord;
    }

    /**
     * Lists role change requests.
     */
    async listRoleChangeRequests({ status = null, pool = null } = {}) {
        if (pool) {
            let query = `
                SELECT rcr.*,
                       req.email as requester_email, req.full_name as requester_name,
                       tgt.email as target_email, tgt.full_name as target_name,
                       appr.email as approver_email, appr.full_name as approver_name
                FROM identity.role_change_requests rcr
                JOIN identity.operators req ON rcr.requesting_operator_id = req.operator_id
                JOIN identity.operators tgt ON rcr.target_operator_id = tgt.operator_id
                LEFT JOIN identity.operators appr ON rcr.approving_operator_id = appr.operator_id
            `;
            const params = [];
            if (status) {
                query += ' WHERE rcr.status = $1';
                params.push(status);
            }
            query += ' ORDER BY rcr.created_at DESC';
            const res = await pool.query(query, params);
            return res.rows;
        }

        const requests = Array.from(this.inMemoryRoleChangeRequests.values());
        if (status) {
            return requests.filter((r) => r.status === status);
        }
        return requests;
    }

    /**
     * Appends an immutable audit event for security and governance tracking.
     */
    async logSecurityEvent({ eventType, operatorId = null, metadata = {}, ipAddress = null, userAgent = null, pool = null } = {}) {
        const record = {
            eventType,
            operatorId,
            ipAddress,
            userAgent,
            metadata,
            createdAt: new Date().toISOString(),
        };

        if (pool) {
            try {
                await pool.query(
                    `INSERT INTO identity.auth_audit_log (event_type, operator_id, ip_address, user_agent, metadata)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [eventType, operatorId, ipAddress, userAgent, JSON.stringify(metadata)]
                );
            } catch (err) {
                logger.error(`[AUDIT] Failed to persist audit log: ${err.message}`);
            }
        } else {
            this.inMemoryAuditLogs.push(record);
        }
    }

    /**
     * Strict AI Boundary Assertion: Ensures AI callers have zero payment initiation or approval privileges.
     */
    assertAiBoundary(principal) {
        if (!principal) return true;
        const isAi = principal.isAi || principal.clientType === 'ai_agent' || principal.role === 'AI_COPILOT';
        if (isAi) {
            const err = new Error('AI operations intelligence is strictly read-only. Payment initiation and approval are prohibited.');
            err.statusCode = 403;
            err.code = 'AI_BOUNDARY_VIOLATION';
            throw err;
        }
        return true;
    }
}

const defaultRbacService = new RbacService();

module.exports = {
    ROLES,
    SENSITIVE_ROLES,
    PERMISSIONS,
    DEFAULT_ROLE_PERMISSIONS,
    RbacService,
    defaultRbacService,
};

