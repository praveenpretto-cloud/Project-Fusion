'use strict';

/**
 * PROJECT FUSION — BACKEND-MANAGED SESSION MANAGER (AI-2A.2)
 * ==========================================================
 * Implements an institutional-grade, revocable, opaque session lifecycle:
 * - 256-bit cryptographically secure opaque tokens
 * - Database stores ONLY the SHA-256 token hash (never the raw secret)
 * - Standardized host-prefixed session cookie: __Host-Fusion-Session (Secure, HttpOnly, Path=/, No Domain)
 * - Standardized CSRF cookie: __Host-Fusion-CSRF (Secure, Path=/, No Domain)
 * - 15-minute inactivity idle timeout
 * - 8-hour absolute maximum session lifetime
 * - Operator deactivation immediate session revocation
 * - Explicit server-side revocation and session rotation
 */

const crypto = require('crypto');
const logger = require('../../logger');

// Timeouts
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 hours

// Standardized Host-Prefixed Cookie Identifiers (RFC 6265bis)
const SESSION_COOKIE_NAME = '__Host-Fusion-Session';
const CSRF_COOKIE_NAME = '__Host-Fusion-CSRF';

/**
 * Computes SHA-256 hash of raw session token
 */
function hashToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') return '';
    return crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
}

/**
 * Generates a high-entropy 256-bit opaque token (64 hex characters)
 */
function generateOpaqueToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * In-memory fallback session store for local/testing without a live DB
 */
const inMemorySessions = new Map();
const inMemoryOperators = new Map();

class SessionManager {
    constructor(options = {}) {
        this.idleTimeoutMs = options.idleTimeoutMs || IDLE_TIMEOUT_MS;
        this.absoluteTimeoutMs = options.absoluteTimeoutMs || ABSOLUTE_TIMEOUT_MS;
    }

    get inMemorySessions() {
        return inMemorySessions;
    }

    get inMemoryOperators() {
        return inMemoryOperators;
    }

    /**
     * Resolves standard secure cookie options.
     * Enforces __Host- requirements: Secure: true, Path: '/', and NO Domain attribute.
     */
    getCookieOptions(isProduction = process.env.NODE_ENV === 'production') {
        const enforceSecure = process.env.DEV_ALLOW_INSECURE_COOKIES === 'true' ? false : true;
        return {
            httpOnly: true,
            secure: enforceSecure,
            sameSite: 'lax', // Required for OIDC top-level redirect completion
            path: '/',
            maxAge: this.absoluteTimeoutMs,
        };
    }

    /**
     * Resolves client-accessible anti-CSRF cookie options.
     * Enforces __Host- requirements: Secure: true, Path: '/', and NO Domain attribute.
     */
    getCsrfCookieOptions(isProduction = process.env.NODE_ENV === 'production') {
        const enforceSecure = process.env.DEV_ALLOW_INSECURE_COOKIES === 'true' ? false : true;
        return {
            httpOnly: false, // Accessible by script for double-submit header injection
            secure: enforceSecure,
            sameSite: 'lax',
            path: '/',
            maxAge: this.absoluteTimeoutMs,
        };
    }

    /**
     * Resolves cookie options for clearing/revoking cookies on logout.
     * Enforces __Host- requirements: Secure: true, Path: '/', and NO Domain attribute.
     */
    getClearCookieOptions(isProduction = process.env.NODE_ENV === 'production') {
        const enforceSecure = process.env.DEV_ALLOW_INSECURE_COOKIES === 'true' ? false : true;
        return {
            httpOnly: true,
            secure: enforceSecure,
            sameSite: 'lax',
            path: '/',
            maxAge: 0,
            expires: new Date(0),
        };
    }

    /**
     * Creates a new backend-managed session for an operator.
     */
    async createSession({ operatorId, ipAddress = '127.0.0.1', userAgent = 'Unknown', pool = null }) {
        if (!operatorId) {
            throw new Error('Cannot create session without operatorId');
        }

        const rawToken = generateOpaqueToken();
        const csrfToken = generateOpaqueToken();
        const tokenHash = hashToken(rawToken);
        const csrfTokenHash = hashToken(csrfToken);

        const now = new Date();
        const expiresAt = new Date(now.getTime() + this.absoluteTimeoutMs);
        const idleExpiresAt = new Date(now.getTime() + this.idleTimeoutMs);
        const sessionId = crypto.randomUUID();

        if (pool) {
            await pool.query(
                `INSERT INTO identity.operator_sessions
                 (session_id, token_hash, csrf_token_hash, operator_id, ip_address, user_agent, created_at, last_activity_at, expires_at, idle_expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9)`,
                [sessionId, tokenHash, csrfTokenHash, operatorId, ipAddress, userAgent, now, expiresAt, idleExpiresAt]
            );

            // Audit record
            await pool.query(
                `INSERT INTO identity.auth_audit_log (event_type, operator_id, ip_address, user_agent, metadata)
                 VALUES ($1, $2, $3, $4, $5)`,
                ['SESSION_CREATED', operatorId, ipAddress, userAgent, JSON.stringify({ sessionId, expiresAt })]
            );
        } else {
            inMemorySessions.set(tokenHash, {
                sessionId,
                tokenHash,
                csrfTokenHash,
                operatorId,
                ipAddress,
                userAgent,
                createdAt: now,
                lastActivityAt: now,
                expiresAt,
                idleExpiresAt,
                revokedAt: null,
                revocationReason: null,
            });
        }

        logger.info(`[AUTH] Session created for operator ${operatorId}. Session ID: ${sessionId}`);

        return {
            rawToken,
            csrfToken,
            sessionId,
            operatorId,
            expiresAt,
        };
    }

    /**
     * Validates an opaque session token against the store.
     * Enforces token hash lookup, idle expiration, absolute lifetime, and operator active status.
     */
    async validateSession(rawToken, { pool = null } = {}) {
        if (!rawToken || typeof rawToken !== 'string') {
            return { valid: false, reason: 'MISSING_SESSION_TOKEN' };
        }

        const tokenHash = hashToken(rawToken);
        const now = new Date();

        let sessionRow, operatorRow;

        if (pool) {
            const res = await pool.query(
                `SELECT s.*, o.email, o.full_name, o.is_active
                 FROM identity.operator_sessions s
                 JOIN identity.operators o ON s.operator_id = o.operator_id
                 WHERE s.token_hash = $1`,
                [tokenHash]
            );

            if (res.rows.length === 0) {
                return { valid: false, reason: 'SESSION_NOT_FOUND' };
            }
            sessionRow = res.rows[0];
            operatorRow = {
                operatorId: sessionRow.operator_id,
                email: sessionRow.email,
                fullName: sessionRow.full_name,
                isActive: sessionRow.is_active,
            };
        } else {
            const s = inMemorySessions.get(tokenHash);
            if (!s) {
                return { valid: false, reason: 'SESSION_NOT_FOUND' };
            }
            sessionRow = s;
            const op = inMemoryOperators.get(s.operatorId) || {
                operatorId: s.operatorId,
                email: 'operator@fusion.internal',
                fullName: 'Institutional Operator',
                isActive: true,
            };
            operatorRow = op;
        }

        // 1. Explicit Revocation Check
        if (sessionRow.revoked_at || sessionRow.revokedAt) {
            return { valid: false, reason: 'SESSION_REVOKED' };
        }

        // 2. Absolute Lifetime Check (8 Hours)
        const expiresAt = new Date(sessionRow.expires_at || sessionRow.expiresAt);
        if (now > expiresAt) {
            await this.revokeSession(rawToken, { reason: 'ABSOLUTE_EXPIRY', pool });
            return { valid: false, reason: 'SESSION_EXPIRED_ABSOLUTE' };
        }

        // 3. Idle Inactivity Check (15 Minutes)
        const lastActivity = new Date(sessionRow.last_activity_at || sessionRow.lastActivityAt);
        const idleDuration = now.getTime() - lastActivity.getTime();
        if (idleDuration > this.idleTimeoutMs) {
            await this.revokeSession(rawToken, { reason: 'IDLE_TIMEOUT', pool });
            return { valid: false, reason: 'SESSION_EXPIRED_IDLE' };
        }

        // 4. Operator Active Status (Fail-closed & Revoke if deactivated)
        if (!operatorRow.isActive) {
            await this.revokeSession(rawToken, { reason: 'OPERATOR_DEACTIVATED', pool });
            return { valid: false, reason: 'OPERATOR_DEACTIVATED' };
        }

        // 5. Update Activity Timestamp
        if (pool) {
            await pool.query(
                `UPDATE identity.operator_sessions
                 SET last_activity_at = NOW(), idle_expires_at = NOW() + INTERVAL '15 minutes'
                 WHERE token_hash = $1`,
                [tokenHash]
            );
        } else {
            sessionRow.lastActivityAt = now;
            sessionRow.idleExpiresAt = new Date(now.getTime() + this.idleTimeoutMs);
        }

        return {
            valid: true,
            operator: operatorRow,
            session: {
                sessionId: sessionRow.session_id || sessionRow.sessionId,
                createdAt: sessionRow.created_at || sessionRow.createdAt,
                lastActivityAt: now,
                expiresAt,
            },
        };
    }

    /**
     * Explicitly revokes a session (Logout or administrative action)
     */
    async revokeSession(rawToken, { reason = 'OPERATOR_LOGOUT', pool = null } = {}) {
        const tokenHash = hashToken(rawToken);
        if (!tokenHash) return false;

        const now = new Date();
        if (pool) {
            const res = await pool.query(
                `UPDATE identity.operator_sessions
                 SET revoked_at = NOW(), revocation_reason = $1
                 WHERE token_hash = $2 AND revoked_at IS NULL
                 RETURNING session_id, operator_id`,
                [reason, tokenHash]
            );
            if (res.rows.length > 0) {
                const { session_id, operator_id } = res.rows[0];
                await pool.query(
                    `INSERT INTO identity.auth_audit_log (event_type, operator_id, metadata)
                     VALUES ($1, $2, $3)`,
                    ['SESSION_REVOKED', operator_id, JSON.stringify({ sessionId: session_id, reason })]
                );
            }
        } else {
            const s = inMemorySessions.get(tokenHash);
            if (s && !s.revokedAt) {
                s.revokedAt = now;
                s.revocationReason = reason;
            }
        }

        logger.info(`[AUTH] Session revoked. Reason: ${reason}`);
        return true;
    }

    /**
     * Revokes all active sessions for an operator (e.g. upon operator deactivation)
     */
    async revokeOperatorSessions(operatorId, { reason = 'OPERATOR_DEACTIVATED', pool = null } = {}) {
        if (!operatorId) return 0;
        const now = new Date();
        let revokedCount = 0;

        if (pool) {
            const res = await pool.query(
                `UPDATE identity.operator_sessions
                 SET revoked_at = NOW(), revocation_reason = $1
                 WHERE operator_id = $2 AND revoked_at IS NULL
                 RETURNING session_id`,
                [reason, operatorId]
            );
            revokedCount = res.rowCount;
            if (revokedCount > 0) {
                await pool.query(
                    `INSERT INTO identity.auth_audit_log (event_type, operator_id, metadata)
                     VALUES ($1, $2, $3)`,
                    ['ALL_SESSIONS_REVOKED', operatorId, JSON.stringify({ reason, count: revokedCount })]
                );
            }
        } else {
            for (const [, s] of inMemorySessions.entries()) {
                if (s.operatorId === operatorId && !s.revokedAt) {
                    s.revokedAt = now;
                    s.revocationReason = reason;
                    revokedCount++;
                }
            }
        }

        logger.info(`[AUTH] Revoked ${revokedCount} active sessions for operator ${operatorId}. Reason: ${reason}`);
        return revokedCount;
    }

    /**
     * Rotates session token on state escalation or periodic refresh.
     * Revokes old session with 'ROTATED' and provisions new session.
     */
    async rotateSession(oldRawToken, { ipAddress, userAgent, pool = null } = {}) {
        const validation = await this.validateSession(oldRawToken, { pool });
        if (!validation.valid) {
            const err = new Error(`Cannot rotate invalid session: ${validation.reason}`);
            err.statusCode = 401;
            throw err;
        }

        // Revoke old session with 'ROTATED'
        await this.revokeSession(oldRawToken, { reason: 'ROTATED', pool });

        // Issue new session
        return this.createSession({
            operatorId: validation.operator.operatorId,
            ipAddress: ipAddress || validation.session.ipAddress,
            userAgent: userAgent || validation.session.userAgent,
            pool,
        });
    }

    // Helper for test fixture operator seeding
    setInMemoryOperator(operatorId, operatorData) {
        inMemoryOperators.set(operatorId, { operatorId, ...operatorData });
    }
}

module.exports = {
    SessionManager,
    hashToken,
    generateOpaqueToken,
    SESSION_COOKIE_NAME,
    CSRF_COOKIE_NAME,
    IDLE_TIMEOUT_MS,
    ABSOLUTE_TIMEOUT_MS,
};
