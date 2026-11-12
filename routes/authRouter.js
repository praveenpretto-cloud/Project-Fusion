'use strict';

/**
 * PROJECT FUSION — ENTERPRISE AUTHENTICATION ROUTER (AI-2A.1)
 * ============================================================
 * Implements production OIDC Authorization Code Flow with PKCE,
 * server-side code exchange, strict identity mapping, session lifecycle,
 * and guarded local development login.
 */

const express = require('express');
const crypto = require('crypto');
const logger = require('../logger');
const { OidcClient } = require('../core/identity/oidcClient');
const {
    SessionManager,
    SESSION_COOKIE_NAME,
    CSRF_COOKIE_NAME,
} = require('../core/identity/sessionManager');
const {
    authenticateDevUser,
    assertDevEnvironment,
    isLoopbackIp,
} = require('../core/identity/devAuthAdapter');
const { createSessionAuthMiddleware } = require('../core/identity/authMiddleware');

function createAuthRouter({
    oidcClient = new OidcClient(),
    sessionManager = new SessionManager(),
} = {}) {
    const r = express.Router();
    const authenticateSession = createSessionAuthMiddleware(sessionManager);

    // =========================================================================
    // 1. ENTERPRISE OIDC FEDERATION ENDPOINTS (PUBLIC PRE-SESSION)
    // =========================================================================

    // OIDC Initiation (Authorization Code Flow + PKCE S256)
    r.all('/oidc/login', async (req, res) => {
        try {
            const redirectUri =
                req.query.redirect_uri ||
                req.body?.redirect_uri ||
                `${req.protocol}://${req.get('host')}/api/auth/oidc/callback`;
            const pool = req.app?.locals?.pool;

            const { authorizationUrl, state } = await oidcClient.initiateAuthorization({
                redirectUri,
                pool,
            });

            if (req.accepts('html') && !req.xhr && !req.is('json')) {
                return res.redirect(authorizationUrl);
            }
            return res.json({ authorizationUrl, state });
        } catch (err) {
            logger.error(`[OIDC LOGIN ERROR] ${err.message}`);
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    // OIDC Callback Handshake (Enforces Code Exchange, Rejects direct ID token submission)
    r.all('/oidc/callback', async (req, res) => {
        try {
            // 1. Reject direct id_token submission (Must use Authorization Code Flow)
            if (req.query.id_token || req.body?.id_token) {
                logger.warn('[OIDC CALLBACK] Direct id_token submission rejected');
                return res.status(400).json({
                    error: 'Direct id_token submission is strictly prohibited. Authorization Code Flow with PKCE is required.',
                });
            }

            const state = req.query.state || req.body?.state;
            const code = req.query.code || req.body?.code;
            const pool = req.app?.locals?.pool;

            if (!state || !code) {
                return res
                    .status(400)
                    .json({ error: 'Missing code or state in authorization callback' });
            }

            // 2. Consume transaction atomically (Single-use, replay check, decrypts code_verifier)
            const transaction = await oidcClient.consumeTransaction(state, { pool });

            // 3. Server-side token exchange at IdP token_endpoint
            const tokenResponse = await oidcClient.exchangeCodeForTokens({
                code,
                codeVerifier: transaction.codeVerifier,
                redirectUri: transaction.redirectUri,
            });

            // 4. Validate ID token (issuer, aud, azp, exp, iat, nbf, nonce, sub, signature)
            const claims = await oidcClient.validateIdToken(tokenResponse.id_token, {
                expectedNonce: transaction.nonce,
            });

            // 5. Resolve or Provision Operator Principal by (issuer, subject)
            // Immutable identity key is strictly (iss, sub). Do NOT link accounts solely by email.
            let operatorId;
            let operatorProfile;

            if (pool) {
                const identityResult = await pool.query(
                    `SELECT o.operator_id, o.email, o.full_name, o.is_active
                     FROM identity.operator_identities oi
                     JOIN identity.operators o ON o.operator_id = oi.operator_id
                     WHERE oi.issuer = $1 AND oi.subject = $2`,
                    [claims.issuer, claims.subject]
                );

                if (identityResult.rows.length > 0) {
                    const op = identityResult.rows[0];
                    if (!op.is_active) {
                        logger.warn(
                            `[OIDC] Rejected login for deactivated operator ${op.operator_id}`
                        );
                        return res
                            .status(403)
                            .json({ error: 'Operator account has been deactivated' });
                    }
                    operatorId = op.operator_id;
                    operatorProfile = {
                        operatorId,
                        email: op.email,
                        fullName: op.full_name,
                    };

                    // Update mutable profile info if changed
                    if (claims.email && claims.email !== op.email) {
                        await pool.query(
                            `UPDATE identity.operators SET email = $1, full_name = COALESCE($2, full_name), updated_at = NOW() WHERE operator_id = $3`,
                            [claims.email, claims.name, operatorId]
                        );
                        operatorProfile.email = claims.email;
                    }
                    await pool.query(
                        `UPDATE identity.operator_identities SET last_login_at = NOW(), idp_metadata = $1 WHERE issuer = $2 AND subject = $3`,
                        [JSON.stringify(claims.claims || {}), claims.issuer, claims.subject]
                    );
                } else {
                    // Unknown (issuer, subject) principal
                    if (!oidcClient.allowJitProvisioning) {
                        logger.warn(
                            `[OIDC] Rejected unregistered federated identity: (${claims.issuer}, ${claims.subject}). JIT disabled.`
                        );
                        return res.status(403).json({
                            error: 'Federated identity is not registered with an operator account. Automatic account linking is prohibited.',
                        });
                    }

                    // Check if an existing operator has this email (Do not link automatically)
                    const existingEmailResult = await pool.query(
                        `SELECT operator_id FROM identity.operators WHERE email = $1`,
                        [claims.email]
                    );
                    if (existingEmailResult.rows.length > 0) {
                        logger.warn(
                            `[OIDC] Refused automatic linking of ${claims.email} to subject ${claims.subject}`
                        );
                        return res.status(409).json({
                            error: 'An operator account with this email already exists under a different identity. Automatic account linking is prohibited.',
                        });
                    }

                    // Provision new operator
                    const opResult = await pool.query(
                        `INSERT INTO identity.operators (email, full_name)
                         VALUES ($1, $2)
                         RETURNING operator_id, email, full_name`,
                        [
                            claims.email || `${claims.subject}@federated.internal`,
                            claims.name || 'Enterprise Operator',
                        ]
                    );
                    const newOp = opResult.rows[0];
                    operatorId = newOp.operator_id;
                    operatorProfile = {
                        operatorId,
                        email: newOp.email,
                        fullName: newOp.full_name,
                    };

                    await pool.query(
                        `INSERT INTO identity.operator_identities (operator_id, issuer, subject, idp_metadata)
                         VALUES ($1, $2, $3, $4)`,
                        [
                            operatorId,
                            claims.issuer,
                            claims.subject,
                            JSON.stringify(claims.claims || {}),
                        ]
                    );
                }
            } else {
                // In-memory fallback for offline test suites
                const identityKey = `${claims.issuer}:${claims.subject}`;
                const existingOp = sessionManager.inMemoryOperators.get(identityKey);

                if (existingOp) {
                    if (!existingOp.isActive) {
                        return res
                            .status(403)
                            .json({ error: 'Operator account has been deactivated' });
                    }
                    operatorId = existingOp.operatorId;
                    operatorProfile = {
                        operatorId,
                        email: existingOp.email,
                        fullName: existingOp.fullName,
                    };
                } else {
                    if (!oidcClient.allowJitProvisioning) {
                        return res.status(403).json({
                            error: 'Federated identity is not registered with an operator account. Automatic account linking is prohibited.',
                        });
                    }

                    operatorId = `op_oidc_${crypto.createHash('sha256').update(identityKey).digest('hex').substring(0, 16)}`;
                    operatorProfile = {
                        operatorId,
                        email: claims.email || `${claims.subject}@federated.internal`,
                        fullName: claims.name || 'Enterprise Operator',
                        isActive: true,
                    };
                    sessionManager.setInMemoryOperator(identityKey, operatorProfile);
                }
            }

            // 6. Provision Session (Never return raw token in JSON body)
            const session = await sessionManager.createSession({
                operatorId,
                ipAddress: req.ip || '127.0.0.1',
                userAgent: req.headers['user-agent'] || 'Unknown',
                pool,
            });

            // 7. Set Secure HttpOnly Cookies
            const cookieOpts = sessionManager.getCookieOptions();
            const csrfOpts = sessionManager.getCsrfCookieOptions();

            res.cookie(SESSION_COOKIE_NAME, session.rawToken, cookieOpts);
            res.cookie(CSRF_COOKIE_NAME, session.csrfToken, csrfOpts);

            logger.info(`[OIDC CALLBACK] ✅ Operator ${claims.subject} logged in successfully`);

            return res.json({
                success: true,
                operator: {
                    operatorId,
                    issuer: claims.issuer,
                    subject: claims.subject,
                    email: operatorProfile.email,
                    fullName: operatorProfile.fullName,
                },
                session: {
                    sessionId: session.sessionId,
                    expiresAt: session.expiresAt,
                },
                csrfToken: session.csrfToken,
            });
        } catch (err) {
            logger.error(`[OIDC CALLBACK ERROR] ${err.message}`);
            return res.status(err.statusCode || 401).json({ error: err.message });
        }
    });

    // =========================================================================
    // 2. ISOLATED LOCAL DEVELOPMENT LOGIN (DEV ADAPTER ONLY)
    // =========================================================================

    r.post('/dev/login', async (req, res) => {
        try {
            assertDevEnvironment({ ipAddress: req.ip });
            const { email, password, totpCode } = req.body || {};
            const pool = req.app?.locals?.pool;

            const result = await authenticateDevUser({
                email,
                password,
                totpCode,
                sessionManager,
                pool,
                ipAddress: req.ip,
                userAgent: req.headers['user-agent'],
            });

            const cookieOpts = sessionManager.getCookieOptions();
            const csrfOpts = sessionManager.getCsrfCookieOptions();

            res.cookie(SESSION_COOKIE_NAME, result.session.rawToken, cookieOpts);
            res.cookie(CSRF_COOKIE_NAME, result.session.csrfToken, csrfOpts);

            return res.json({
                success: true,
                operator: result.operator,
                session: {
                    sessionId: result.session.sessionId,
                    expiresAt: result.session.expiresAt,
                },
                csrfToken: result.session.csrfToken,
            });
        } catch (err) {
            return res.status(err.statusCode || 401).json({ error: err.message });
        }
    });

    // =========================================================================
    // 3. SESSION MANAGEMENT & LOGOUT (STRICTLY REQUIRE AUTHENTICATED SESSION)
    // =========================================================================

    r.get('/session', authenticateSession, (req, res) => {
        return res.json({
            authenticated: true,
            operator: req.operator,
            session: req.session,
        });
    });

    r.post('/logout', authenticateSession, async (req, res) => {
        try {
            const pool = req.app?.locals?.pool;
            await sessionManager.revokeSession(req.rawSessionToken, {
                reason: 'USER_LOGOUT',
                pool,
            });

            const clearOpts = sessionManager.getClearCookieOptions();
            res.clearCookie(SESSION_COOKIE_NAME, clearOpts);
            res.clearCookie(CSRF_COOKIE_NAME, clearOpts);

            return res.json({ success: true, message: 'Logged out successfully' });
        } catch (err) {
            return res.status(500).json({ error: 'Logout failed', detail: err.message });
        }
    });

    r.post('/session/rotate', authenticateSession, async (req, res) => {
        try {
            const pool = req.app?.locals?.pool;
            const newSession = await sessionManager.rotateSession(req.rawSessionToken, {
                ipAddress: req.ip,
                userAgent: req.headers['user-agent'],
                pool,
            });

            const cookieOpts = sessionManager.getCookieOptions();
            const csrfOpts = sessionManager.getCsrfCookieOptions();

            res.cookie(SESSION_COOKIE_NAME, newSession.rawToken, cookieOpts);
            res.cookie(CSRF_COOKIE_NAME, newSession.csrfToken, csrfOpts);

            return res.json({
                success: true,
                session: {
                    sessionId: newSession.sessionId,
                    expiresAt: newSession.expiresAt,
                },
                csrfToken: newSession.csrfToken,
            });
        } catch (err) {
            return res.status(err.statusCode || 500).json({ error: err.message });
        }
    });

    // =========================================================================
    // 4. DECOMMISSIONED LEGACY PROTOTYPE ENDPOINTS (FAIL CLOSED)
    // =========================================================================

    r.post('/otp/generate', (req, res) => {
        return res.status(503).json({
            error: 'OTP generation service is permanently disabled. Use Enterprise OIDC federation (Phase AI-2A).',
        });
    });

    r.post('/otp/verify', (req, res) => {
        return res.status(503).json({
            error: 'OTP verification service is permanently disabled. Use Enterprise OIDC federation (Phase AI-2A).',
        });
    });

    return r;
}

module.exports = {
    createAuthRouter,
    router: createAuthRouter(),
};
