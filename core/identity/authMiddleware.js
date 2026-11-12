'use strict';

/**
 * PROJECT FUSION — ENTERPRISE AUTHENTICATION MIDDLEWARE (AI-2A.2)
 * ===============================================================
 * Enforces session verification, internal credential boundaries,
 * double-submit anti-CSRF protection, and origin validation.
 * 
 * Boundary Mandate:
 * - Operator sessions strictly require HttpOnly cookies (__Host-Fusion-Session).
 * - Operator sessions masquerading as Bearer tokens are explicitly rejected.
 * - Client-supplied x-fusion-client-type is never treated as trusted identity proof.
 */

const crypto = require('crypto');
const logger = require('../../logger');
const { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } = require('./sessionManager');
const { defaultRbacService } = require('./rbacService');

/**
 * Parses raw Cookie header string into key-value map
 */
function parseCookies(cookieHeader) {
    const list = {};
    if (!cookieHeader || typeof cookieHeader !== 'string') return list;

    cookieHeader.split(';').forEach((cookie) => {
        const parts = cookie.split('=');
        if (parts.length >= 2) {
            const name = parts[0].trim();
            const value = parts.slice(1).join('=').trim();
            list[name] = decodeURIComponent(value);
        }
    });
    return list;
}

/**
 * Extracts session token strictly from HttpOnly cookie (__Host-Fusion-Session).
 * Rejects Authorization: Bearer tokens for operator session authentication.
 */
function extractSessionToken(req) {
    // 1. Check HttpOnly cookies (Standard browser transport)
    const cookies = req.cookies || parseCookies(req.headers?.cookie);
    if (cookies[SESSION_COOKIE_NAME]) {
        return cookies[SESSION_COOKIE_NAME];
    }
    // Backward compatibility fallback for transition
    if (cookies['fusion_session']) {
        return cookies['fusion_session'];
    }

    // 2. Reject Authorization: Bearer operator session masquerading
    const authHeader = req.headers?.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
        req.authRejection = 'OPERATOR_BEARER_PROHIBITED';
        return null;
    }

    return null;
}

/**
 * Validates Origin / Referer for browser state-changing requests (CSRF mitigation).
 * Mutating requests without valid Origin or Referer are rejected.
 */
function verifyOrigin(req, allowedOrigins = null) {
    const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
    if (safeMethods.includes(req.method)) {
        return true;
    }

    const origins = allowedOrigins || (
        process.env.ALLOWED_ORIGINS
            ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim().toLowerCase())
            : ['http://localhost:3000', 'http://127.0.0.1:3000', 'https://localhost:3000', 'http://localhost:3001']
    );

    const origin = (req.headers['origin'] || '').trim().toLowerCase();
    if (origin) {
        return origins.includes(origin);
    }

    const referer = (req.headers['referer'] || '').trim();
    if (referer) {
        try {
            const parsed = new URL(referer);
            const refererOrigin = `${parsed.protocol}//${parsed.host}`.toLowerCase();
            return origins.includes(refererOrigin);
        } catch {
            return false;
        }
    }

    // Missing both Origin and Referer on mutating request -> reject
    return false;
}

/**
 * Extracts and verifies anti-CSRF token for state-mutating requests (POST, PUT, PATCH, DELETE).
 * Enforces double-submit cookie verification with timing-safe comparison.
 */
function verifyCsrfToken(req) {
    const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
    if (safeMethods.includes(req.method)) {
        return true;
    }

    // Header token provided by client
    const headerToken = (req.headers['x-csrf-token'] || req.headers['x-xsrf-token'] || '').trim();

    // Cookie token stored on browser
    const cookies = req.cookies || parseCookies(req.headers?.cookie);
    const cookieToken = (cookies[CSRF_COOKIE_NAME] || cookies['fusion_csrf'] || '').trim();

    if (!headerToken || !cookieToken) {
        return false;
    }

    if (headerToken.length !== cookieToken.length) {
        return false;
    }

    return crypto.timingSafeEqual(Buffer.from(headerToken, 'utf8'), Buffer.from(cookieToken, 'utf8'));
}

/**
 * Middleware factory for human operator session verification
 */
function createSessionAuthMiddleware(sessionManager, { enforceCsrf = true, pool = null } = {}) {
    return async function authenticateSession(req, res, next) {
        const rawToken = extractSessionToken(req);

        if (!rawToken) {
            if (req.authRejection === 'OPERATOR_BEARER_PROHIBITED') {
                return res.status(401).json({
                    error: 'Unauthorized',
                    detail: 'Operator sessions strictly require HttpOnly cookies. Bearer token operator authentication is prohibited.',
                });
            }
            return res.status(401).json({
                error: 'Unauthorized',
                detail: 'Valid operator session is required (missing session cookie)',
            });
        }

        // Validate Origin on mutating requests
        if (enforceCsrf && !verifyOrigin(req)) {
            logger.warn(`[AUTH] 403 Forbidden: Origin validation failed on ${req.method} ${req.path}`);
            return res.status(403).json({
                error: 'Forbidden',
                detail: 'Origin validation failed: untrusted or missing origin for state-mutating request',
            });
        }

        // Validate Anti-CSRF on mutating requests
        if (enforceCsrf && !verifyCsrfToken(req)) {
            logger.warn(`[AUTH] 403 Forbidden: CSRF token mismatch on ${req.method} ${req.path}`);
            return res.status(403).json({
                error: 'Forbidden',
                detail: 'CSRF token validation failed',
            });
        }

        const validation = await sessionManager.validateSession(rawToken, {
            pool: pool || req.app?.locals?.pool,
        });

        if (!validation.valid) {
            logger.warn(`[AUTH] 401 Session invalid: ${validation.reason} on ${req.method} ${req.path}`);
            return res.status(401).json({
                error: 'Unauthorized',
                detail: `Session is invalid or expired (${validation.reason})`,
            });
        }

        // Attach operator context to request
        req.operator = validation.operator;
        req.session = validation.session;
        req.rawSessionToken = rawToken;

        next();
    };
}

/**
 * Middleware: Strictly rejects client-supplied user impersonation headers
 */
function stripClientImpersonationHeaders(req, res, next) {
    if (req.headers) {
        delete req.headers['x-user-id'];
        delete req.headers['x-role'];
        delete req.headers['x-tenant-id'];
        delete req.headers['x-operator-id'];
    }
    next();
}

/**
 * Explicit route whitelist helper for public authentication routes
 */
function isPublicAuthRoute(method, originalUrl) {
    const urlPath = originalUrl.split('?')[0];

    // Whitelisted OIDC endpoints
    if (urlPath === '/api/auth/oidc/login' && (method === 'GET' || method === 'POST')) return true;
    if (urlPath === '/api/auth/oidc/callback' && (method === 'GET' || method === 'POST')) return true;

    // Whitelisted Dev Login (Local test adapter ONLY)
    const nodeEnv = (process.env.NODE_ENV || '').trim().toLowerCase();
    if (
        urlPath === '/api/auth/dev/login' &&
        method === 'POST' &&
        (nodeEnv === 'development' || nodeEnv === 'test') &&
        process.env.ALLOW_DEV_AUTH === 'true'
    ) {
        return true;
    }

    return false;
}

/**
 * Middleware: Enforces that the authenticated operator possesses a specific RBAC permission.
 * Default-deny: If operator is missing, or permission is not held, request is rejected with 401 or 403.
 */
function requirePermission(permissionKey, { rbacService = defaultRbacService } = {}) {
    return async (req, res, next) => {
        if (!req.operator || !req.operator.operatorId) {
            logger.warn(`[RBAC] 401 Unauthorized: Permission check for "${permissionKey}" failed - missing authenticated operator`);
            return res.status(401).json({
                error: 'Unauthorized',
                detail: 'Authentication required before checking permissions',
            });
        }

        const operatorId = req.operator.operatorId;
        const pool = req.app?.locals?.pool || null;

        try {
            const permissions = await rbacService.getOperatorPermissions(operatorId, { pool });
            const roles = await rbacService.getOperatorRoles(operatorId, { pool });

            req.permissions = Array.from(permissions);
            req.roles = roles;

            if (!permissions.has(permissionKey)) {
                logger.warn(`[RBAC] 403 Forbidden: Operator ${operatorId} lacks permission "${permissionKey}" on ${req.method} ${req.path}`);
                await rbacService.logSecurityEvent({
                    eventType: 'PERMISSION_DENIED',
                    operatorId,
                    metadata: {
                        attemptedPermission: permissionKey,
                        operatorRoles: roles,
                        path: req.path,
                        method: req.method,
                    },
                    ipAddress: req.ip,
                    userAgent: req.headers ? req.headers['user-agent'] : null,
                    pool,
                });
                return res.status(403).json({
                    error: 'Forbidden',
                    detail: `Access denied: operator lacks required permission "${permissionKey}"`,
                });
            }

            next();
        } catch (err) {
            logger.error(`[RBAC] Error resolving permissions for operator ${operatorId}: ${err.message}`);
            return res.status(500).json({
                error: 'Internal Server Error',
                detail: 'Failed to evaluate operator authorization',
            });
        }
    };
}

/**
 * Middleware: Enforces that the authenticated operator possesses at least one of the specified roles.
 */
function requireAnyRole(allowedRoles = [], { rbacService = defaultRbacService } = {}) {
    const rolesList = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

    return async (req, res, next) => {
        if (!req.operator || !req.operator.operatorId) {
            return res.status(401).json({
                error: 'Unauthorized',
                detail: 'Authentication required before checking roles',
            });
        }

        const operatorId = req.operator.operatorId;
        const pool = req.app?.locals?.pool || null;

        try {
            const roles = await rbacService.getOperatorRoles(operatorId, { pool });
            req.roles = roles;

            const hasRole = roles.some((r) => rolesList.includes(r));
            if (!hasRole) {
                logger.warn(`[RBAC] 403 Forbidden: Operator ${operatorId} lacks required roles [${rolesList.join(', ')}] on ${req.method} ${req.path}`);
                await rbacService.logSecurityEvent({
                    eventType: 'ROLE_DENIED',
                    operatorId,
                    metadata: {
                        requiredRoles: rolesList,
                        operatorRoles: roles,
                        path: req.path,
                        method: req.method,
                    },
                    ipAddress: req.ip,
                    userAgent: req.headers ? req.headers['user-agent'] : null,
                    pool,
                });
                return res.status(403).json({
                    error: 'Forbidden',
                    detail: `Access denied: operator does not possess any of the required roles: [${rolesList.join(', ')}]`,
                });
            }

            next();
        } catch (err) {
            logger.error(`[RBAC] Error checking roles for operator ${operatorId}: ${err.message}`);
            return res.status(500).json({
                error: 'Internal Server Error',
                detail: 'Failed to evaluate operator roles',
            });
        }
    };
}

module.exports = {
    parseCookies,
    extractSessionToken,
    verifyCsrfToken,
    verifyOrigin,
    createSessionAuthMiddleware,
    stripClientImpersonationHeaders,
    isPublicAuthRoute,
    requirePermission,
    requireAnyRole,
};
