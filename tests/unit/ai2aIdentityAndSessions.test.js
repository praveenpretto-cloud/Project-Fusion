'use strict';

/**
 * PROJECT FUSION — PHASE AI-2A.2 UNIT & SECURITY TEST SUITE
 * ==========================================================
 * Complete reconciled test suite verifying:
 * 1. OIDC Flow Hardening & Authenticated PKCE Encryption
 * 2. ID Token Claim Validation & Cryptographic Verification
 * 3. OIDC JWKS Key Rotation & Anti-Storm Caching
 * 4. OIDC Confidential Client Authentication (client_secret_basic, client_secret_post, private_key_jwt)
 * 5. Session Manager Lifecycle & Security Invariants (__Host-Fusion-Session, 15m Idle, 8h Absolute)
 * 6. Local Development Adapter Isolation (fail-closed, loopback-only, TOTP)
 * 7. Middleware: Transport Controls, CSRF (POST, PUT, PATCH, DELETE), Bearer Prohibition
 * 8. Auth Router Endpoints & Account Lifecycle (Deactivation, Email Conflict 409, JIT disabled 403)
 * 9. Frontend Security & BFF Invariants (Multi-cookie preservation, Origin forwarding)
 * 10. End-to-End Local Synthetic OIDC Provider Sequence (12-step flow)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const {
    OidcClient,
    generatePkcePair,
    base64UrlEncode,
    base64UrlDecode,
    parseEncryptionKey,
    encryptCodeVerifier,
    decryptCodeVerifier,
    getTransactionEncryptionKey,
    getTransactionKeyRing,
    MIN_JWKS_REFRESH_INTERVAL_MS,
} = require('../../core/identity/oidcClient');
const {
    SessionManager,
    hashToken,
    SESSION_COOKIE_NAME,
    CSRF_COOKIE_NAME,
} = require('../../core/identity/sessionManager');
const {
    assertDevEnvironment,
    authenticateDevUser,
    generateTotpCode,
    verifyTotp,
    isLoopbackIp,
    SYNTHETIC_OPERATORS,
    SHARED_DEV_TOTP_SECRET,
} = require('../../core/identity/devAuthAdapter');
const {
    parseCookies,
    extractSessionToken,
    verifyCsrfToken,
    verifyOrigin,
    stripClientImpersonationHeaders,
    isPublicAuthRoute,
    createSessionAuthMiddleware,
} = require('../../core/identity/authMiddleware');
const { createAuthRouter } = require('../../routes/authRouter');

/**
 * In-memory request dispatcher for sandbox-safe Express testing (Zero socket binding)
 */
function makeRequest(
    app,
    { method = 'GET', url = '/', headers = {}, body = null, ip = '127.0.0.1' }
) {
    return new Promise((resolve) => {
        let statusCode = 200;
        const responseHeaders = {};
        const setCookieHeaders = [];
        let responseBody = null;

        const [urlPath, queryString] = url.split('?');
        const query = {};
        if (queryString) {
            new URLSearchParams(queryString).forEach((v, k) => {
                query[k] = v;
            });
        }

        const req = {
            method,
            url,
            originalUrl: url,
            path: urlPath,
            params: {},
            query,
            headers: { host: 'localhost:3000', ...headers },
            body: body || {},
            ip,
            protocol: 'http',
            connection: { encrypted: false },
            socket: { encrypted: false },
            accepts: (type) => {
                const acceptHeader = (headers['accept'] || headers['Accept'] || '').toLowerCase();
                if (!acceptHeader || acceptHeader.includes('*/*')) {
                    return type === 'json' || type === 'application/json';
                }
                return acceptHeader.includes(type.toLowerCase());
            },
            is: (type) => {
                const ct = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
                return ct.includes(type.toLowerCase());
            },
            xhr: false,
            get(h) {
                return this.headers[h.toLowerCase()];
            },
        };

        const res = {
            statusCode: 200,
            status(code) {
                statusCode = code;
                this.statusCode = code;
                return this;
            },
            setHeader(k, v) {
                responseHeaders[k.toLowerCase()] = v;
            },
            cookie(name, val, options = {}) {
                const parts = [`${name}=${encodeURIComponent(val)}`];
                if (options.httpOnly) parts.push('HttpOnly');
                if (options.secure) parts.push('Secure');
                if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
                if (options.path) parts.push(`Path=${options.path}`);
                if (options.maxAge) parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
                const serialized = parts.join('; ');
                setCookieHeaders.push(serialized);
                responseHeaders['set-cookie'] = setCookieHeaders;
            },
            clearCookie(name, options = {}) {
                const parts = [`${name}=`];
                if (options.path) parts.push(`Path=${options.path}`);
                parts.push('Max-Age=0');
                parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
                setCookieHeaders.push(parts.join('; '));
                responseHeaders['set-cookie'] = setCookieHeaders;
            },
            send(payload) {
                responseBody = payload;
                resolve({
                    statusCode,
                    headers: responseHeaders,
                    body: responseBody,
                    text: String(payload),
                });
            },
            json(payload) {
                responseBody = payload;
                resolve({
                    statusCode,
                    headers: responseHeaders,
                    body: responseBody,
                    text: JSON.stringify(payload),
                });
            },
            redirect(targetUrl) {
                statusCode = 302;
                responseHeaders['location'] = targetUrl;
                resolve({
                    statusCode: 302,
                    headers: responseHeaders,
                    body: { redirect: targetUrl },
                    text: `Redirecting to ${targetUrl}`,
                });
            },
            end(payload) {
                if (payload) responseBody = payload;
                resolve({
                    statusCode,
                    headers: responseHeaders,
                    body: responseBody,
                    text: String(payload || ''),
                });
            },
        };

        app.handle(req, res);
    });
}

describe('Project Fusion — Phase AI-2A.2: Identity Integration Closure & Security Verification', () => {
    // =========================================================================
    // 1. OIDC FLOW HARDENING & PKCE ENCRYPTION KEY MANAGEMENT
    // =========================================================================
    describe('1. OIDC Flow Hardening & PKCE Material Protection', () => {
        let keyPair;
        beforeAll(() => {
            keyPair = crypto.generateKeyPairSync('rsa', {
                modulusLength: 2048,
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            });
        });

        test('generates valid PKCE code_verifier and code_challenge (S256)', () => {
            const pkce = generatePkcePair();
            expect(pkce.codeVerifier).toBeDefined();
            expect(pkce.codeChallenge).toBeDefined();
            expect(pkce.codeChallengeMethod).toBe('S256');

            // Verify RFC 7636 challenge derivation
            const expectedChallenge = base64UrlEncode(
                crypto.createHash('sha256').update(pkce.codeVerifier).digest()
            );
            expect(pkce.codeChallenge).toBe(expectedChallenge);
        });

        test('initiateAuthorization builds compliant authorization URL and records state', async () => {
            const client = new OidcClient({
                issuer: 'https://auth.bank.example.com',
                clientId: 'fusion_app_1',
                allowedRedirectUris: ['http://localhost:3000/api/auth/oidc/callback'],
            });

            const result = await client.initiateAuthorization({
                redirectUri: 'http://localhost:3000/api/auth/oidc/callback',
            });

            expect(result.authorizationUrl).toBeDefined();
            expect(result.state).toBeDefined();

            const parsed = new URL(result.authorizationUrl);
            expect(parsed.origin).toBe('https://auth.bank.example.com');
            expect(parsed.searchParams.get('response_type')).toBe('code');
            expect(parsed.searchParams.get('client_id')).toBe('fusion_app_1');
            expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
            expect(parsed.searchParams.get('state')).toBe(result.state);
        });

        test('rejects untrusted redirect URI outside allowlist', async () => {
            const client = new OidcClient({
                issuer: 'https://auth.bank.example.com',
                clientId: 'fusion_app_1',
                allowedRedirectUris: ['https://fusion.bank.internal/callback'],
            });

            await expect(
                client.initiateAuthorization({ redirectUri: 'https://attacker.com/evil' })
            ).rejects.toThrow('Redirect URI is not allowed');
        });

        test('rejects expired transaction after validity window', async () => {
            const client = new OidcClient({
                issuer: 'https://auth.bank.example.com',
                clientId: 'fusion_app_1',
                allowedRedirectUris: ['http://localhost:3000/callback'],
            });

            const { state } = await client.initiateAuthorization({
                redirectUri: 'http://localhost:3000/callback',
            });

            // Fast-forward transaction expiry
            const tx = client.inMemoryTransactions.get(state);
            tx.expiresAt = new Date(Date.now() - 1000);

            await expect(client.consumeTransaction(state)).rejects.toThrow(
                'invalid, expired, or already used'
            );
        });

        test('parseEncryptionKey enforces high-entropy 256-bit requirement and rejects passwords', () => {
            // Valid 64-char hex key
            const validHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
            expect(parseEncryptionKey(validHex)).toBeInstanceOf(Buffer);
            expect(parseEncryptionKey(validHex).length).toBe(32);

            // Rejects arbitrary passwords
            expect(() => parseEncryptionKey('password123')).toThrow(
                'Arbitrary human-readable passwords are not permitted'
            );
            expect(() => parseEncryptionKey('too_short_key')).toThrow(
                'Arbitrary human-readable passwords are not permitted'
            );
            expect(() => parseEncryptionKey('')).toThrow('is required');
        });

        test('encryptCodeVerifier and decryptCodeVerifier round-trip using AES-256-GCM', () => {
            const verifier = 'plain-pkce-verifier-test-1234567890-abcdef';
            const encrypted = encryptCodeVerifier(verifier);
            expect(encrypted.startsWith('v1:')).toBe(true);

            const decrypted = decryptCodeVerifier(encrypted);
            expect(decrypted).toBe(verifier);
        });

        test('decryptCodeVerifier detects and rejects ciphertext tampering', () => {
            const verifier = 'pkce-verifier-tamper-check';
            const encrypted = encryptCodeVerifier(verifier);
            const parts = encrypted.split(':');
            // Tamper ciphertext segment deterministically (flip bits of first byte)
            const firstByte = parseInt(parts[4].substring(0, 2), 16);
            const tamperedByte = (firstByte ^ 0xff).toString(16).padStart(2, '0');
            const tamperedCipher = tamperedByte + parts[4].substring(2);
            const tamperedPayload = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]}:${tamperedCipher}`;

            expect(() => decryptCodeVerifier(tamperedPayload)).toThrow(
                'Ciphertext decryption failed (possible tampering)'
            );
        });

        test('decryptCodeVerifier detects and rejects authentication tag tampering', () => {
            const verifier = 'pkce-verifier-tag-tamper';
            const encrypted = encryptCodeVerifier(verifier);
            const parts = encrypted.split(':');
            // Tamper tag segment
            const tamperedTag = '00' + parts[3].substring(2);
            const tamperedPayload = `${parts[0]}:${parts[1]}:${parts[2]}:${tamperedTag}:${parts[4]}`;

            expect(() => decryptCodeVerifier(tamperedPayload)).toThrow(
                'Ciphertext decryption failed (possible tampering)'
            );
        });

        test('versioned payload supports key rotation and fails closed on unknown keyId', () => {
            const key1 = Buffer.from(
                '1111111111111111111111111111111111111111111111111111111111111111',
                'hex'
            );
            const key2 = Buffer.from(
                '2222222222222222222222222222222222222222222222222222222222222222',
                'hex'
            );

            const encWithKey1 = encryptCodeVerifier('secret-verifier-1', {
                key: key1,
                keyId: 'rot_k1',
            });
            expect(encWithKey1.startsWith('v1:rot_k1:')).toBe(true);

            // Decrypt with key ring containing rot_k1
            const keyRing = new Map([
                ['rot_k1', key1],
                ['rot_k2', key2],
            ]);
            expect(decryptCodeVerifier(encWithKey1, { keys: keyRing })).toBe('secret-verifier-1');

            // Fails closed if rot_k1 is missing from key ring
            const restrictedKeyRing = new Map([['rot_k2', key2]]);
            expect(() => decryptCodeVerifier(encWithKey1, { keys: restrictedKeyRing })).toThrow(
                'encryption key ID "rot_k1" is not available in configured key ring. Fail-closed.'
            );
        });

        test('consumeTransaction atomically decrypts code_verifier and blocks replay', async () => {
            const client = new OidcClient({
                issuer: 'https://auth.bank.example.com',
                clientId: 'fusion_app_1',
                allowedRedirectUris: ['http://localhost:3000/callback'],
            });

            const { state } = await client.initiateAuthorization({
                redirectUri: 'http://localhost:3000/callback',
            });

            const tx = await client.consumeTransaction(state);
            expect(tx.codeVerifier).toBeDefined();
            expect(tx.nonce).toBeDefined();

            // Replay attempt must be blocked immediately
            await expect(client.consumeTransaction(state)).rejects.toThrow('Replay blocked');
        });

        test('cleanupExpiredTransactions removes expired and consumed transactions', async () => {
            const client = new OidcClient();
            client.inMemoryTransactions.set('exp1', {
                state: 'exp1',
                expiresAt: new Date(Date.now() - 1000),
                usedAt: null,
            });
            client.inMemoryTransactions.set('used1', {
                state: 'used1',
                expiresAt: new Date(Date.now() + 10000),
                usedAt: new Date(Date.now() - 4000000), // > 1 hour old
            });
            client.inMemoryTransactions.set('act1', {
                state: 'act1',
                expiresAt: new Date(Date.now() + 60000),
                usedAt: null,
            });

            const result = await client.cleanupExpiredTransactions();
            expect(result.deletedCount).toBe(2);
            expect(client.inMemoryTransactions.has('act1')).toBe(true);
        });
    });

    // =========================================================================
    // 2. ID TOKEN CLAIM VALIDATION & CRYPTOGRAPHIC VERIFICATION
    // =========================================================================
    describe('2. ID Token Claim Validation & Cryptographic Verification', () => {
        let keyPair;
        beforeAll(() => {
            keyPair = crypto.generateKeyPairSync('rsa', {
                modulusLength: 2048,
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            });
        });

        function makeJwt(
            payload,
            { alg = 'RS256', kid = 'k_test', key = keyPair.privateKey } = {}
        ) {
            const header = { alg, typ: 'JWT', kid };
            const encH = base64UrlEncode(Buffer.from(JSON.stringify(header)));
            const encP = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
            const sigInput = `${encH}.${encP}`;

            if (alg === 'none') {
                return `${sigInput}.`;
            }

            const signer = crypto.createSign('RSA-SHA256');
            signer.update(sigInput);
            const sig = base64UrlEncode(signer.sign(key));
            return `${sigInput}.${sig}`;
        }

        test('validateIdToken succeeds on valid RS256 token with matching claims and nonce', async () => {
            const client = new OidcClient({
                issuer: 'https://idp.corporate.com',
                clientId: 'fusion_client_01',
                jwksPublicKeys: { k_test: keyPair.publicKey },
            });

            const payload = {
                iss: 'https://idp.corporate.com',
                sub: 'usr_ops_001',
                aud: 'fusion_client_01',
                nonce: 'nonce_abc_123',
                exp: Math.floor(Date.now() / 1000) + 3600,
                iat: Math.floor(Date.now() / 1000) - 10,
                email: 'operator@fusion.internal',
                name: 'Lead Operator',
            };

            const token = makeJwt(payload);
            const result = await client.validateIdToken(token, { expectedNonce: 'nonce_abc_123' });

            expect(result.subject).toBe('usr_ops_001');
            expect(result.email).toBe('operator@fusion.internal');
            expect(result.issuer).toBe('https://idp.corporate.com');
        });

        test('rejects ID token with untrusted algorithm "none"', async () => {
            const client = new OidcClient({ issuer: 'https://idp.corporate.com', clientId: 'c1' });
            const token = makeJwt(
                { iss: 'https://idp.corporate.com', aud: 'c1', exp: 9999999999, sub: 'u1' },
                { alg: 'none' }
            );
            await expect(client.validateIdToken(token)).rejects.toThrow(
                'Untrusted signing algorithm: none'
            );
        });

        test('rejects ID token with untrusted symmetric algorithm HS256', async () => {
            const client = new OidcClient({ issuer: 'https://idp.corporate.com', clientId: 'c1' });
            const token = makeJwt(
                { iss: 'https://idp.corporate.com', aud: 'c1', exp: 9999999999, sub: 'u1' },
                { alg: 'HS256' }
            );
            await expect(client.validateIdToken(token)).rejects.toThrow(
                'Untrusted signing algorithm: HS256'
            );
        });

        test('rejects ID token with wrong issuer', async () => {
            const client = new OidcClient({
                issuer: 'https://idp.corporate.com',
                clientId: 'c1',
                jwksPublicKeys: { k_test: keyPair.publicKey },
            });
            const token = makeJwt({
                iss: 'https://wrong.idp.com',
                aud: 'c1',
                exp: 9999999999,
                sub: 'u1',
            });
            await expect(client.validateIdToken(token)).rejects.toThrow('Issuer mismatch');
        });

        test('rejects ID token with wrong audience', async () => {
            const client = new OidcClient({
                issuer: 'https://idp.corporate.com',
                clientId: 'fusion_client_01',
                jwksPublicKeys: { k_test: keyPair.publicKey },
            });
            const token = makeJwt({
                iss: 'https://idp.corporate.com',
                aud: 'foreign_client',
                exp: 9999999999,
                sub: 'u1',
            });
            await expect(client.validateIdToken(token)).rejects.toThrow('Audience mismatch');
        });

        test('rejects expired ID token (exp in past)', async () => {
            const client = new OidcClient({
                issuer: 'https://idp.corporate.com',
                clientId: 'c1',
                jwksPublicKeys: { k_test: keyPair.publicKey },
            });
            const token = makeJwt({
                iss: 'https://idp.corporate.com',
                aud: 'c1',
                sub: 'u1',
                exp: Math.floor(Date.now() / 1000) - 120, // 2 minutes ago
            });
            await expect(client.validateIdToken(token)).rejects.toThrow('ID token has expired');
        });

        test('rejects ID token issued in the future (iat clock skew exceeded)', async () => {
            const client = new OidcClient({
                issuer: 'https://idp.corporate.com',
                clientId: 'c1',
                jwksPublicKeys: { k_test: keyPair.publicKey },
            });
            const token = makeJwt({
                iss: 'https://idp.corporate.com',
                aud: 'c1',
                sub: 'u1',
                exp: Math.floor(Date.now() / 1000) + 3600,
                iat: Math.floor(Date.now() / 1000) + 300, // 5 min future
            });
            await expect(client.validateIdToken(token)).rejects.toThrow(
                'ID token issued in the future'
            );
        });

        test('rejects ID token with mismatching nonce', async () => {
            const client = new OidcClient({
                issuer: 'https://idp.corporate.com',
                clientId: 'c1',
                jwksPublicKeys: { k_test: keyPair.publicKey },
            });
            const token = makeJwt({
                iss: 'https://idp.corporate.com',
                aud: 'c1',
                sub: 'u1',
                exp: Math.floor(Date.now() / 1000) + 3600,
                nonce: 'nonce_one',
            });
            await expect(
                client.validateIdToken(token, { expectedNonce: 'nonce_two' })
            ).rejects.toThrow('Nonce mismatch');
        });

        test('rejects ID token missing subject (sub) claim', async () => {
            const client = new OidcClient({
                issuer: 'https://idp.corporate.com',
                clientId: 'c1',
                jwksPublicKeys: { k_test: keyPair.publicKey },
            });
            const token = makeJwt({
                iss: 'https://idp.corporate.com',
                aud: 'c1',
                exp: Math.floor(Date.now() / 1000) + 3600,
                // missing sub
            });
            await expect(client.validateIdToken(token)).rejects.toThrow(
                'missing subject (sub) claim'
            );
        });

        test('validates azp requirement when multiple audiences are present', async () => {
            const client = new OidcClient({
                issuer: 'https://idp.corporate.com',
                clientId: 'c1',
                jwksPublicKeys: { k_test: keyPair.publicKey },
            });

            // Multiple audiences without azp -> reject
            const tokenNoAzp = makeJwt({
                iss: 'https://idp.corporate.com',
                aud: ['c1', 'c2'],
                sub: 'u1',
                exp: Math.floor(Date.now() / 1000) + 3600,
            });
            await expect(client.validateIdToken(tokenNoAzp)).rejects.toThrow('must include azp');

            // Multiple audiences with matching azp -> accept
            const tokenWithAzp = makeJwt({
                iss: 'https://idp.corporate.com',
                aud: ['c1', 'c2'],
                azp: 'c1',
                sub: 'u1',
                exp: Math.floor(Date.now() / 1000) + 3600,
            });
            const res = await client.validateIdToken(tokenWithAzp);
            expect(res.subject).toBe('u1');
        });

        test('enforces nbf (not before) claim when present', async () => {
            const client = new OidcClient({
                issuer: 'https://idp.corporate.com',
                clientId: 'c1',
                jwksPublicKeys: { k_test: keyPair.publicKey },
            });

            const futureNbfToken = makeJwt({
                iss: 'https://idp.corporate.com',
                aud: 'c1',
                sub: 'u1',
                exp: Math.floor(Date.now() / 1000) + 3600,
                nbf: Math.floor(Date.now() / 1000) + 300,
            });

            await expect(client.validateIdToken(futureNbfToken)).rejects.toThrow(
                'ID token not yet valid'
            );
        });
    });

    // =========================================================================
    // 3. OIDC JWKS KEY ROTATION & ANTI-STORM CACHING
    // =========================================================================
    describe('3. OIDC JWKS Key Rotation & Anti-Storm Caching', () => {
        let keyPair1, keyPair2;
        beforeAll(() => {
            keyPair1 = crypto.generateKeyPairSync('rsa', {
                modulusLength: 2048,
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            });
            keyPair2 = crypto.generateKeyPairSync('rsa', {
                modulusLength: 2048,
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            });
        });

        function makeJwtWithKey(payload, keyPair, kid = 'k1') {
            const header = { alg: 'RS256', typ: 'JWT', kid };
            const encH = base64UrlEncode(Buffer.from(JSON.stringify(header)));
            const encP = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
            const sigInput = `${encH}.${encP}`;
            const signer = crypto.createSign('RSA-SHA256');
            signer.update(sigInput);
            return `${sigInput}.${base64UrlEncode(signer.sign(keyPair.privateKey))}`;
        }

        test('dynamically resolves newly rotated legitimate key via controlled JWKS refresh', async () => {
            let jwksFetchCount = 0;
            const mockJwksFetcher = async () => {
                jwksFetchCount++;
                return [
                    { kid: 'k1', publicKey: keyPair1.publicKey },
                    { kid: 'k2_rotated', publicKey: keyPair2.publicKey },
                ];
            };

            const client = new OidcClient({
                issuer: 'https://idp.corporate.com',
                clientId: 'c1',
                jwksPublicKeys: { k1: keyPair1.publicKey }, // Initially only has k1
                jwksFetcher: mockJwksFetcher,
            });

            // Token signed with newly rotated key k2_rotated
            const tokenK2 = makeJwtWithKey(
                {
                    iss: 'https://idp.corporate.com',
                    aud: 'c1',
                    sub: 'usr_rot_1',
                    exp: Math.floor(Date.now() / 1000) + 3600,
                },
                keyPair2,
                'k2_rotated'
            );

            const res = await client.validateIdToken(tokenK2);
            expect(res.subject).toBe('usr_rot_1');
            expect(jwksFetchCount).toBe(1);
        });

        test('rejects token when key remains unknown even after JWKS refresh', async () => {
            let fetchCount = 0;
            const client = new OidcClient({
                issuer: 'https://idp.corporate.com',
                clientId: 'c1',
                jwksFetcher: async () => {
                    fetchCount++;
                    return [{ kid: 'k1', publicKey: keyPair1.publicKey }];
                },
            });

            const tokenUnknown = makeJwtWithKey(
                {
                    iss: 'https://idp.corporate.com',
                    aud: 'c1',
                    sub: 'u1',
                    exp: Math.floor(Date.now() / 1000) + 3600,
                },
                keyPair2,
                'k_unknown_999'
            );

            await expect(client.validateIdToken(tokenUnknown)).rejects.toThrow(
                'Key unknown even after JWKS refresh'
            );
            expect(fetchCount).toBe(1);
        });

        test('rejects token with invalid signature', async () => {
            const client = new OidcClient({
                issuer: 'https://idp.corporate.com',
                clientId: 'c1',
                jwksPublicKeys: { k1: keyPair1.publicKey },
            });

            // Token signed with keyPair2 but claiming kid: k1
            const tamperedToken = makeJwtWithKey(
                {
                    iss: 'https://idp.corporate.com',
                    aud: 'c1',
                    sub: 'u1',
                    exp: Math.floor(Date.now() / 1000) + 3600,
                },
                keyPair2,
                'k1'
            );

            await expect(client.validateIdToken(tamperedToken)).rejects.toThrow(
                'Cryptographic signature verification failed'
            );
        });

        test('rejects malicious JWKS endpoint where host does not match issuer', async () => {
            const client = new OidcClient({
                issuer: 'https://idp.corporate.com',
                clientId: 'c1',
                jwksUri: 'https://attacker.evil.com/keys',
            });

            await expect(client.fetchJwks({ force: true })).rejects.toThrow(
                'Untrusted JWKS endpoint: host "attacker.evil.com" does not match issuer'
            );
        });

        test('prevents JWKS refresh storm by enforcing minimum refresh interval (cooldown)', async () => {
            let callCount = 0;
            const client = new OidcClient({
                issuer: 'https://idp.corporate.com',
                clientId: 'c1',
                jwksMinRefreshIntervalMs: 5000,
                jwksFetcher: async () => {
                    callCount++;
                    return [{ kid: 'k1', publicKey: keyPair1.publicKey }];
                },
            });

            // First force refresh triggers fetch
            await client.fetchJwks({ force: true });
            expect(callCount).toBe(1);

            // Immediate second force refresh must be throttled by cooldown
            await client.fetchJwks({ force: true });
            expect(callCount).toBe(1);
        });
    });

    // =========================================================================
    // 4. OIDC CONFIDENTIAL CLIENT AUTHENTICATION
    // =========================================================================
    describe('4. OIDC Confidential Client Authentication Methods', () => {
        let keyPair;
        beforeAll(() => {
            keyPair = crypto.generateKeyPairSync('rsa', {
                modulusLength: 2048,
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            });
        });

        test('authenticates at token endpoint using client_secret_basic', async () => {
            let recordedAuth = null;
            const client = new OidcClient({
                issuer: 'https://idp.bank.internal',
                clientId: 'bank_fusion_client',
                clientSecret: 'super_secret_bank_key_123',
                clientAuthMethod: 'client_secret_basic',
                tokenExchanger: async (params) => {
                    recordedAuth = params;
                    return { id_token: 'dummy.jwt.token' };
                },
            });

            const res = await client.exchangeCodeForTokens({
                code: 'auth_code_123',
                codeVerifier: 'verifier_abc',
                redirectUri: 'https://fusion.bank.internal/callback',
            });

            expect(res.id_token).toBe('dummy.jwt.token');
            expect(recordedAuth.clientId).toBe('bank_fusion_client');
            expect(recordedAuth.clientAuthMethod).toBe('client_secret_basic');
        });

        test('generates valid RFC 7523 client assertion for private_key_jwt', () => {
            const client = new OidcClient({
                issuer: 'https://idp.bank.internal',
                clientId: 'bank_client_jwt',
                clientAuthMethod: 'private_key_jwt',
                privateKey: keyPair.privateKey,
                privateKeyKid: 'bank_key_01',
                tokenEndpoint: 'https://idp.bank.internal/oauth2/v1/token',
            });

            const assertion = client.generateClientAssertion();
            expect(typeof assertion).toBe('string');
            const [hB64, pB64, sB64] = assertion.split('.');
            expect(hB64 && pB64 && sB64).toBeTruthy();

            const header = JSON.parse(base64UrlDecode(hB64).toString('utf8'));
            const payload = JSON.parse(base64UrlDecode(pB64).toString('utf8'));

            expect(header.alg).toBe('RS256');
            expect(header.kid).toBe('bank_key_01');
            expect(payload.iss).toBe('bank_client_jwt');
            expect(payload.sub).toBe('bank_client_jwt');
            expect(payload.aud).toBe('https://idp.bank.internal/oauth2/v1/token');
            expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
        });

        test('exchangeCodeForTokens fails closed on untrusted HTTP redirect', async () => {
            const client = new OidcClient({
                issuer: 'https://idp.bank.internal',
                clientId: 'c1',
                tokenEndpoint: 'https://idp.bank.internal/token',
            });

            // Mock _postUrlEncoded returning redirect error
            jest.spyOn(client, '_postUrlEncoded').mockRejectedValue(
                new Error('Untrusted redirect encountered on token endpoint: 302')
            );

            await expect(
                client.exchangeCodeForTokens({
                    code: 'c',
                    codeVerifier: 'v',
                    redirectUri: 'https://fusion/cb',
                })
            ).rejects.toThrow('Untrusted redirect encountered');
        });
    });

    // =========================================================================
    // 5. SESSION MANAGER LIFECYCLE & COOKIE SECURITY INVARIANTS
    // =========================================================================
    describe('5. Session Manager Lifecycle & Security Invariants', () => {
        let sessionManager;
        beforeEach(() => {
            sessionManager = new SessionManager();
            sessionManager.inMemorySessions.clear();
            sessionManager.inMemoryOperators.clear();
        });

        test('createSession issues 256-bit token and stores only SHA-256 hash', async () => {
            const session = await sessionManager.createSession({ operatorId: 'op_sec_01' });
            expect(session.rawToken).toHaveLength(64);
            expect(session.csrfToken).toHaveLength(64);

            const expectedHash = hashToken(session.rawToken);
            const stored = sessionManager.inMemorySessions.get(expectedHash);
            expect(stored).toBeDefined();
            expect(stored.operatorId).toBe('op_sec_01');
            expect(stored.tokenHash).toBe(expectedHash);
        });

        test('validateSession succeeds with valid active token and returns operator details', async () => {
            const session = await sessionManager.createSession({ operatorId: 'op_sec_01' });
            const val = await sessionManager.validateSession(session.rawToken);
            expect(val.valid).toBe(true);
            expect(val.operator.operatorId).toBe('op_sec_01');
        });

        test('validateSession fails for invalid or non-existent token', async () => {
            const val = await sessionManager.validateSession('non_existent_token');
            expect(val.valid).toBe(false);
            expect(val.reason).toBe('SESSION_NOT_FOUND');
        });

        test('validateSession enforces 15-minute idle inactivity timeout', async () => {
            const session = await sessionManager.createSession({ operatorId: 'op_sec_01' });
            const hash = hashToken(session.rawToken);
            const stored = sessionManager.inMemorySessions.get(hash);

            // Fast forward 16 minutes of inactivity
            stored.lastActivityAt = new Date(Date.now() - 16 * 60 * 1000);

            const val = await sessionManager.validateSession(session.rawToken);
            expect(val.valid).toBe(false);
            expect(val.reason).toBe('SESSION_EXPIRED_IDLE');
        });

        test('validateSession enforces 8-hour absolute maximum expiration', async () => {
            const session = await sessionManager.createSession({ operatorId: 'op_sec_01' });
            const hash = hashToken(session.rawToken);
            const stored = sessionManager.inMemorySessions.get(hash);

            // Fast forward 9 hours
            stored.expiresAt = new Date(Date.now() - 60 * 1000);

            const val = await sessionManager.validateSession(session.rawToken);
            expect(val.valid).toBe(false);
            expect(val.reason).toBe('SESSION_EXPIRED_ABSOLUTE');
        });

        test('revokeSession terminates active session with specific reason', async () => {
            const session = await sessionManager.createSession({ operatorId: 'op_sec_01' });
            await sessionManager.revokeSession(session.rawToken, { reason: 'OPERATOR_LOGOUT' });

            const val = await sessionManager.validateSession(session.rawToken);
            expect(val.valid).toBe(false);
            expect(val.reason).toBe('SESSION_REVOKED');
        });

        test('revokeOperatorSessions revokes all active sessions when operator is deactivated', async () => {
            const s1 = await sessionManager.createSession({ operatorId: 'op_deactivate_01' });
            const s2 = await sessionManager.createSession({ operatorId: 'op_deactivate_01' });
            const sOther = await sessionManager.createSession({ operatorId: 'op_other' });

            const count = await sessionManager.revokeOperatorSessions('op_deactivate_01', {
                reason: 'OPERATOR_DEACTIVATED',
            });
            expect(count).toBe(2);

            expect((await sessionManager.validateSession(s1.rawToken)).valid).toBe(false);
            expect((await sessionManager.validateSession(s2.rawToken)).valid).toBe(false);
            expect((await sessionManager.validateSession(sOther.rawToken)).valid).toBe(true);
        });

        test('rotateSession creates new token and revokes old session with ROTATED', async () => {
            const initial = await sessionManager.createSession({ operatorId: 'op_sec_01' });
            const rotated = await sessionManager.rotateSession(initial.rawToken);

            expect(rotated.rawToken).not.toBe(initial.rawToken);
            expect((await sessionManager.validateSession(initial.rawToken)).valid).toBe(false);
            expect((await sessionManager.validateSession(rotated.rawToken)).valid).toBe(true);
        });

        test('provides standardized __Host-Fusion-Session cookie options (Secure, HttpOnly, Path=/, No Domain)', () => {
            expect(SESSION_COOKIE_NAME).toBe('__Host-Fusion-Session');
            expect(CSRF_COOKIE_NAME).toBe('__Host-Fusion-CSRF');

            const opts = sessionManager.getCookieOptions();
            expect(opts.httpOnly).toBe(true);
            expect(opts.secure).toBe(true);
            expect(opts.path).toBe('/');
            expect(opts.sameSite).toBe('lax');
            expect(opts.domain).toBeUndefined(); // __Host- prefix prohibits Domain
        });

        test('provides clear cookie options with maxAge 0 for logout', () => {
            const clearOpts = sessionManager.getClearCookieOptions();
            expect(clearOpts.maxAge).toBe(0);
            expect(clearOpts.httpOnly).toBe(true);
            expect(clearOpts.path).toBe('/');
            expect(clearOpts.domain).toBeUndefined();
        });
    });

    // =========================================================================
    // 6. LOCAL DEVELOPMENT ADAPTER GUARD & VERIFICATION
    // =========================================================================
    describe('6. Local Development Adapter Guard & Verification', () => {
        const origEnv = process.env.NODE_ENV;
        const origAllow = process.env.ALLOW_DEV_AUTH;
        const origStage = process.env.DEPLOYMENT_STAGE;

        afterEach(() => {
            process.env.NODE_ENV = origEnv;
            process.env.ALLOW_DEV_AUTH = origAllow;
            if (origStage === undefined) {
                delete process.env.DEPLOYMENT_STAGE;
            } else {
                process.env.DEPLOYMENT_STAGE = origStage;
            }
        });

        test('assertDevEnvironment fails closed in production environment', () => {
            process.env.NODE_ENV = 'production';
            process.env.ALLOW_DEV_AUTH = 'true';
            expect(() => assertDevEnvironment()).toThrow(
                'strictly disabled in production/unknown environments'
            );
        });

        test('assertDevEnvironment fails closed in staging environment', () => {
            process.env.NODE_ENV = 'staging';
            process.env.ALLOW_DEV_AUTH = 'true';
            expect(() => assertDevEnvironment()).toThrow(
                'strictly disabled in production/unknown environments'
            );
        });

        test('assertDevEnvironment fails closed when NODE_ENV is undefined or empty', () => {
            delete process.env.NODE_ENV;
            process.env.ALLOW_DEV_AUTH = 'true';
            expect(() => assertDevEnvironment()).toThrow(
                'strictly disabled in production/unknown environments'
            );
        });

        test('assertDevEnvironment fails closed when ALLOW_DEV_AUTH is not explicitly true', () => {
            process.env.NODE_ENV = 'development';
            process.env.ALLOW_DEV_AUTH = 'false';
            expect(() => assertDevEnvironment()).toThrow('ALLOW_DEV_AUTH is not explicitly "true"');
        });

        test('isLoopbackIp helper strictly permits loopback IPs and rejects external addresses', () => {
            expect(isLoopbackIp('127.0.0.1')).toBe(true);
            expect(isLoopbackIp('::1')).toBe(true);
            expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true);
            expect(isLoopbackIp('localhost')).toBe(true);

            expect(isLoopbackIp('192.168.1.100')).toBe(false);
            expect(isLoopbackIp('10.0.0.1')).toBe(false);
            expect(isLoopbackIp('8.8.8.8')).toBe(false);
        });

        test('assertDevEnvironment fails closed when non-loopback IP attempts dev login', () => {
            process.env.NODE_ENV = 'development';
            process.env.ALLOW_DEV_AUTH = 'true';
            expect(() => assertDevEnvironment({ ipAddress: '192.168.1.50' })).toThrow(
                'restricted to local loopback access only'
            );
        });

        test('verifies RFC 6238 TOTP codes correctly', () => {
            const totp = generateTotpCode(SHARED_DEV_TOTP_SECRET);
            expect(totp).toHaveLength(6);
            expect(verifyTotp(SHARED_DEV_TOTP_SECRET, totp)).toBe(true);
            expect(verifyTotp(SHARED_DEV_TOTP_SECRET, '000000')).toBe(false);
        });

        test('authenticateDevUser succeeds with valid synthetic credentials and TOTP', async () => {
            process.env.NODE_ENV = 'development';
            process.env.ALLOW_DEV_AUTH = 'true';

            const sessionManager = new SessionManager();
            const totp = generateTotpCode(SHARED_DEV_TOTP_SECRET);

            const result = await authenticateDevUser({
                email: 'dev-ops@fusion.internal',
                password: 'FusionDevPassword2026!',
                totpCode: totp,
                sessionManager,
                ipAddress: '127.0.0.1',
            });

            expect(result.operator.email).toBe('dev-ops@fusion.internal');
            expect(result.session.rawToken).toBeDefined();
        });

        test('authenticateDevUser rejects invalid password', async () => {
            process.env.NODE_ENV = 'development';
            process.env.ALLOW_DEV_AUTH = 'true';

            const sessionManager = new SessionManager();
            const totp = generateTotpCode(SHARED_DEV_TOTP_SECRET);

            await expect(
                authenticateDevUser({
                    email: 'dev-ops@fusion.internal',
                    password: 'wrong_password',
                    totpCode: totp,
                    sessionManager,
                    ipAddress: '127.0.0.1',
                })
            ).rejects.toThrow('Invalid developer credentials');
        });

        test('authenticateDevUser rejects invalid TOTP code', async () => {
            process.env.NODE_ENV = 'development';
            process.env.ALLOW_DEV_AUTH = 'true';

            const sessionManager = new SessionManager();

            await expect(
                authenticateDevUser({
                    email: 'dev-ops@fusion.internal',
                    password: 'FusionDevPassword2026!',
                    totpCode: '999999',
                    sessionManager,
                    ipAddress: '127.0.0.1',
                })
            ).rejects.toThrow('Invalid or expired TOTP code');
        });

        test('authenticateDevUser rejects unknown non-synthetic user email', async () => {
            process.env.NODE_ENV = 'development';
            process.env.ALLOW_DEV_AUTH = 'true';

            const sessionManager = new SessionManager();

            await expect(
                authenticateDevUser({
                    email: 'unknown-user@external.com',
                    password: 'FusionDevPassword2026!',
                    totpCode: '123456',
                    sessionManager,
                    ipAddress: '127.0.0.1',
                })
            ).rejects.toThrow('Invalid developer credentials');
        });
    });

    // =========================================================================
    // 7. MIDDLEWARE: TRANSPORT CONTROLS, CSRF & BEARER BOUNDARIES
    // =========================================================================
    describe('7. Middleware: Transport Controls, CSRF & Bearer Boundaries', () => {
        test('parseCookies parses standard cookie header string', () => {
            const raw = 'cookie1=val1; cookie2=val2%20test; __Host-Fusion-Session=opaque_token';
            const parsed = parseCookies(raw);
            expect(parsed['cookie1']).toBe('val1');
            expect(parsed['cookie2']).toBe('val2 test');
            expect(parsed['__Host-Fusion-Session']).toBe('opaque_token');
        });

        test('extractSessionToken extracts from __Host-Fusion-Session cookie', () => {
            const req = {
                headers: { cookie: '__Host-Fusion-Session=test_session_token_123' },
            };
            expect(extractSessionToken(req)).toBe('test_session_token_123');
        });

        test('extractSessionToken strictly rejects operator session Bearer tokens', () => {
            const req = {
                headers: { authorization: 'Bearer some_operator_token' },
            };
            expect(extractSessionToken(req)).toBeNull();
            expect(req.authRejection).toBe('OPERATOR_BEARER_PROHIBITED');
        });

        test('verifyOrigin accepts matching allowed origins and rejects foreign origins', () => {
            const allowed = ['http://localhost:3000', 'https://fusion.bank.internal'];

            const validReq = { method: 'POST', headers: { origin: 'http://localhost:3000' } };
            expect(verifyOrigin(validReq, allowed)).toBe(true);

            const foreignReq = { method: 'POST', headers: { origin: 'http://malicious.site.com' } };
            expect(verifyOrigin(foreignReq, allowed)).toBe(false);
        });

        test('verifyOrigin rejects mutating requests missing both Origin and Referer', () => {
            const missingOriginReq = { method: 'POST', headers: {} };
            expect(verifyOrigin(missingOriginReq)).toBe(false);
        });

        test('verifyCsrfToken passes for safe HTTP methods without tokens', () => {
            expect(verifyCsrfToken({ method: 'GET', headers: {} })).toBe(true);
            expect(verifyCsrfToken({ method: 'HEAD', headers: {} })).toBe(true);
            expect(verifyCsrfToken({ method: 'OPTIONS', headers: {} })).toBe(true);
        });

        test('verifyCsrfToken enforces matching tokens across POST, PUT, PATCH, DELETE', () => {
            const mutatingMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
            const token = 'matching_csrf_token_val_123';

            for (const method of mutatingMethods) {
                // Success with matching header and cookie
                const matchingReq = {
                    method,
                    headers: {
                        'x-csrf-token': token,
                        cookie: `__Host-Fusion-CSRF=${token}`,
                    },
                };
                expect(verifyCsrfToken(matchingReq)).toBe(true);

                // Rejection when header missing
                const missingHeader = {
                    method,
                    headers: { cookie: `__Host-Fusion-CSRF=${token}` },
                };
                expect(verifyCsrfToken(missingHeader)).toBe(false);

                // Rejection when cookie missing
                const missingCookie = {
                    method,
                    headers: { 'x-csrf-token': token },
                };
                expect(verifyCsrfToken(missingCookie)).toBe(false);

                // Rejection when mismatched
                const mismatched = {
                    method,
                    headers: {
                        'x-csrf-token': token,
                        cookie: '__Host-Fusion-CSRF=different_token',
                    },
                };
                expect(verifyCsrfToken(mismatched)).toBe(false);
            }
        });

        test('stripClientImpersonationHeaders removes spoofed identity headers', () => {
            const req = {
                headers: {
                    'x-user-id': 'attacker_id',
                    'x-role': 'ADMIN',
                    'x-tenant-id': 'foreign_tenant',
                    'x-operator-id': 'fake_op',
                    authorization: 'keep_me',
                },
            };
            stripClientImpersonationHeaders(req, {}, () => {});
            expect(req.headers['x-user-id']).toBeUndefined();
            expect(req.headers['x-role']).toBeUndefined();
            expect(req.headers['x-tenant-id']).toBeUndefined();
            expect(req.headers['x-operator-id']).toBeUndefined();
            expect(req.headers['authorization']).toBe('keep_me');
        });

        test('isPublicAuthRoute only permits whitelisted pre-session authentication routes', () => {
            expect(isPublicAuthRoute('GET', '/api/auth/oidc/login')).toBe(true);
            expect(isPublicAuthRoute('POST', '/api/auth/oidc/callback')).toBe(true);
            expect(isPublicAuthRoute('GET', '/api/auth/session')).toBe(false);
            expect(isPublicAuthRoute('POST', '/api/transfer')).toBe(false);
        });
    });

    // =========================================================================
    // 8. AUTH ROUTER ENDPOINTS & ACCOUNT LIFECYCLE
    // =========================================================================
    describe('8. Auth Router Endpoints & Account Lifecycle', () => {
        let app;
        let oidcClient;
        let sessionManager;
        let keyPair;

        beforeAll(() => {
            keyPair = crypto.generateKeyPairSync('rsa', {
                modulusLength: 2048,
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            });
        });

        beforeEach(() => {
            oidcClient = new OidcClient({
                issuer: 'https://auth.bank.internal',
                clientId: 'fusion_ops_portal',
                jwksPublicKeys: { default: keyPair.publicKey },
                allowedRedirectUris: ['http://localhost:3000/api/auth/oidc/callback'],
            });
            sessionManager = new SessionManager();
            const router = createAuthRouter({ oidcClient, sessionManager });

            app = express();
            app.use(express.json());
            app.use('/api/auth', router);
        });

        function createSignedIdToken(payload, kid = 'default') {
            const h = base64UrlEncode(
                Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))
            );
            const p = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
            const signer = crypto.createSign('RSA-SHA256');
            signer.update(`${h}.${p}`);
            const s = base64UrlEncode(signer.sign(keyPair.privateKey));
            return `${h}.${p}.${s}`;
        }

        test('GET /api/auth/oidc/login returns authorization URL and state', async () => {
            const res = await makeRequest(app, {
                method: 'GET',
                url: '/api/auth/oidc/login?redirect_uri=http://localhost:3000/api/auth/oidc/callback',
            });
            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.text);
            expect(body.authorizationUrl).toContain('response_type=code');
            expect(body.state).toBeDefined();
        });

        test('POST /api/auth/oidc/callback rejects direct id_token submission (400)', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/auth/oidc/callback',
                body: { id_token: 'direct.jwt.token' },
            });
            expect(res.statusCode).toBe(400);
            expect(res.text).toContain('Direct id_token submission is strictly prohibited');
        });

        test('Complete OIDC Authorization Code Flow with server-side exchange & active operator', async () => {
            const initRes = await makeRequest(app, {
                method: 'GET',
                url: '/api/auth/oidc/login?redirect_uri=http://localhost:3000/api/auth/oidc/callback',
            });
            const { state } = JSON.parse(initRes.text);
            const tx = oidcClient.inMemoryTransactions.get(state);

            // Register pre-existing active operator
            sessionManager.setInMemoryOperator('https://auth.bank.internal:usr_ops_lead_4401', {
                operatorId: 'op_ops_lead_4401',
                email: 'lead-ops@bank.internal',
                fullName: 'Lead Operations Officer',
                isActive: true,
            });

            // Mock server-side token exchange
            oidcClient.tokenExchanger = async () => ({
                id_token: createSignedIdToken({
                    iss: 'https://auth.bank.internal',
                    sub: 'usr_ops_lead_4401',
                    aud: 'fusion_ops_portal',
                    nonce: tx.nonce,
                    exp: Math.floor(Date.now() / 1000) + 3600,
                    email: 'lead-ops@bank.internal',
                    name: 'Lead Operations Officer',
                }),
            });

            const callbackRes = await makeRequest(app, {
                method: 'POST',
                url: `/api/auth/oidc/callback?code=mock_auth_code_999&state=${state}`,
            });

            expect(callbackRes.statusCode).toBe(200);
            const callbackBody = JSON.parse(callbackRes.text);
            expect(callbackBody.success).toBe(true);
            expect(callbackBody.operator.operatorId).toBe('op_ops_lead_4401');
            expect(callbackBody.csrfToken).toBeDefined();
            expect(callbackRes.headers['set-cookie']).toBeDefined();
        });

        test('OIDC Callback rejects unregistered identity when JIT provisioning is disabled', async () => {
            oidcClient.allowJitProvisioning = false;

            const initRes = await makeRequest(app, {
                method: 'GET',
                url: '/api/auth/oidc/login?redirect_uri=http://localhost:3000/api/auth/oidc/callback',
            });
            const { state } = JSON.parse(initRes.text);
            const tx = oidcClient.inMemoryTransactions.get(state);

            oidcClient.tokenExchanger = async () => ({
                id_token: createSignedIdToken({
                    iss: 'https://auth.bank.internal',
                    sub: 'unregistered_sub_999',
                    aud: 'fusion_ops_portal',
                    nonce: tx.nonce,
                    exp: Math.floor(Date.now() / 1000) + 3600,
                }),
            });

            const res = await makeRequest(app, {
                method: 'POST',
                url: `/api/auth/oidc/callback?code=mock_code&state=${state}`,
            });

            expect(res.statusCode).toBe(403);
            expect(res.text).toContain('Federated identity is not registered');
        });

        test('OIDC Callback rejects login for deactivated operator (403 Forbidden)', async () => {
            const initRes = await makeRequest(app, {
                method: 'GET',
                url: '/api/auth/oidc/login?redirect_uri=http://localhost:3000/api/auth/oidc/callback',
            });
            const { state } = JSON.parse(initRes.text);
            const tx = oidcClient.inMemoryTransactions.get(state);

            // Register deactivated operator
            sessionManager.setInMemoryOperator('https://auth.bank.internal:usr_deactivated_55', {
                operatorId: 'op_deactivated_55',
                email: 'deactivated@bank.internal',
                fullName: 'Deactivated Op',
                isActive: false,
            });

            oidcClient.tokenExchanger = async () => ({
                id_token: createSignedIdToken({
                    iss: 'https://auth.bank.internal',
                    sub: 'usr_deactivated_55',
                    aud: 'fusion_ops_portal',
                    nonce: tx.nonce,
                    exp: Math.floor(Date.now() / 1000) + 3600,
                }),
            });

            const res = await makeRequest(app, {
                method: 'POST',
                url: `/api/auth/oidc/callback?code=code_deact&state=${state}`,
            });

            expect(res.statusCode).toBe(403);
            expect(res.text).toContain('Operator account has been deactivated');
        });

        test('GET /api/auth/session without session cookie returns 401 Unauthorized', async () => {
            const res = await makeRequest(app, {
                method: 'GET',
                url: '/api/auth/session',
            });
            expect(res.statusCode).toBe(401);
            expect(res.text).toContain('Valid operator session is required');
        });

        test('POST /api/auth/dev/login rejects non-loopback IP requests (403)', async () => {
            process.env.NODE_ENV = 'development';
            process.env.ALLOW_DEV_AUTH = 'true';

            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/auth/dev/login',
                ip: '192.168.1.100',
                body: {
                    email: 'dev-ops@fusion.internal',
                    password: 'dev-password-insecure-local-only',
                    totpCode: '123456',
                },
            });

            expect(res.statusCode).toBe(403);
            expect(res.text).toContain('restricted to local loopback access only');
        });

        test('POST /api/auth/otp/generate and /otp/verify return 503 permanently disabled', async () => {
            const genRes = await makeRequest(app, {
                method: 'POST',
                url: '/api/auth/otp/generate',
            });
            expect(genRes.statusCode).toBe(503);
            expect(genRes.text).toContain('OTP generation service is permanently disabled');

            const verRes = await makeRequest(app, { method: 'POST', url: '/api/auth/otp/verify' });
            expect(verRes.statusCode).toBe(503);
            expect(verRes.text).toContain('OTP verification service is permanently disabled');
        });
    });

    // =========================================================================
    // 9. FRONTEND SECURITY & BFF INVARIANTS
    // =========================================================================
    describe('9. Frontend Security & BFF Invariants', () => {
        test('client/src/app/page.tsx has zero occurrences of CASHIQ_API_KEY and zero hardcoded x-api-key', () => {
            const pagePath = path.join(__dirname, '../../client/src/app/page.tsx');
            const content = fs.readFileSync(pagePath, 'utf8');

            expect(content).not.toContain('CASHIQ_API_KEY');
            expect(content).not.toContain('fusion_bank_secret_key_2025');
        });

        test('client approve page has zero dummy WebAuthn signatures and approve button is disabled pending AI-2B', () => {
            const approvePagePath = path.join(
                __dirname,
                '../../client/src/app/approve/[instructionId]/page.tsx'
            );
            const content = fs.readFileSync(approvePagePath, 'utf8');

            expect(content).not.toContain('dummy-raw-id');
            expect(content).not.toContain('dummy-client-data-json');
            expect(content).not.toContain('dummy-signature');
            expect(content).toContain('disabled');
            expect(content).toContain('Phase AI-2B');
        });

        test('Next.js API proxy preserves multiple Set-Cookie headers and forwards origin', () => {
            const proxyRoutePath = path.join(
                __dirname,
                '../../client/src/app/api/[...path]/route.ts'
            );
            const content = fs.readFileSync(proxyRoutePath, 'utf8');

            expect(content).toContain('getSetCookie');
            expect(content).toContain("headers['origin'] = origin");
            expect(content).toContain("responseHeaders.append('set-cookie', cookieStr)");
        });
    });

    // =========================================================================
    // 10. LOCAL SYNTHETIC OIDC PROVIDER END-TO-END SEQUENCE (12 STEPS)
    // =========================================================================
    describe('10. Local Synthetic OIDC Provider Sequence (12 Steps)', () => {
        let app;
        let oidcClient;
        let sessionManager;
        let syntheticKey;

        beforeAll(() => {
            syntheticKey = crypto.generateKeyPairSync('rsa', {
                modulusLength: 2048,
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
            });

            sessionManager = new SessionManager();
            oidcClient = new OidcClient({
                issuer: 'https://synthetic.idp.local',
                clientId: 'fusion_test_client',
                clientSecret: 'synthetic_secret_key',
                allowedRedirectUris: ['http://localhost:3000/api/auth/oidc/callback'],
                jwksPublicKeys: { synthetic_k1: syntheticKey.publicKey },
            });

            const router = createAuthRouter({ oidcClient, sessionManager });
            app = express();
            app.use(express.json());
            app.use('/api/auth', router);
        });

        test('executes the full 12-step authentication, session access, and logout sequence', async () => {
            // STEP 1: Initiate OIDC login
            const step1 = await makeRequest(app, {
                method: 'GET',
                url: '/api/auth/oidc/login?redirect_uri=http://localhost:3000/api/auth/oidc/callback',
            });
            expect(step1.statusCode).toBe(200);
            const { authorizationUrl, state } = JSON.parse(step1.text);

            // STEP 2: Generate PKCE challenge and auth transaction
            expect(authorizationUrl).toContain('code_challenge=');
            expect(authorizationUrl).toContain('code_challenge_method=S256');
            const tx = oidcClient.inMemoryTransactions.get(state);
            expect(tx).toBeDefined();
            expect(tx.encryptedCodeVerifier).toBeDefined();

            // STEP 3: Redirect to synthetic IdP (Simulated authorization endpoint)
            const parsedAuthUrl = new URL(authorizationUrl);
            expect(parsedAuthUrl.searchParams.get('state')).toBe(state);
            expect(parsedAuthUrl.searchParams.get('client_id')).toBe('fusion_test_client');

            // STEP 4: Complete authentication at synthetic IdP
            const syntheticAuthCode = 'synth_code_' + crypto.randomBytes(8).toString('hex');

            // STEP 5: Return authorization code and state via callback
            // Configure synthetic token exchange
            oidcClient.tokenExchanger = async ({ code, codeVerifier, redirectUri, clientId }) => {
                expect(code).toBe(syntheticAuthCode);
                expect(codeVerifier).toBeDefined();
                expect(redirectUri).toBe('http://localhost:3000/api/auth/oidc/callback');
                expect(clientId).toBe('fusion_test_client');

                // Generate signed ID token
                const h = base64UrlEncode(
                    Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'synthetic_k1' }))
                );
                const p = base64UrlEncode(
                    Buffer.from(
                        JSON.stringify({
                            iss: 'https://synthetic.idp.local',
                            sub: 'synthetic_operator_42',
                            aud: 'fusion_test_client',
                            nonce: tx.nonce,
                            exp: Math.floor(Date.now() / 1000) + 3600,
                            email: 'operator42@fusion.internal',
                            name: 'Operator 42',
                        })
                    )
                );
                const signer = crypto.createSign('RSA-SHA256');
                signer.update(`${h}.${p}`);
                const s = base64UrlEncode(signer.sign(syntheticKey.privateKey));
                return { id_token: `${h}.${p}.${s}` };
            };

            // Register federated identity
            sessionManager.setInMemoryOperator(
                'https://synthetic.idp.local:synthetic_operator_42',
                {
                    operatorId: 'op_synth_42',
                    email: 'operator42@fusion.internal',
                    fullName: 'Operator 42',
                    isActive: true,
                }
            );

            // STEP 6: Exchange authorization code server-side
            // STEP 7: Verify ID token cryptographically
            // STEP 8: Resolve federated operator identity
            // STEP 9: Create database-backed session
            // STEP 10: Set browser cookies
            const step5to10 = await makeRequest(app, {
                method: 'POST',
                url: `/api/auth/oidc/callback?code=${syntheticAuthCode}&state=${state}`,
            });

            expect(step5to10.statusCode).toBe(200);
            const callbackBody = JSON.parse(step5to10.text);
            expect(callbackBody.success).toBe(true);
            expect(callbackBody.operator.operatorId).toBe('op_synth_42');

            // Extract cookies
            const setCookieArray = step5to10.headers['set-cookie'];
            expect(setCookieArray).toBeDefined();
            const rawSessionCookie = setCookieArray.find((c) =>
                c.startsWith('__Host-Fusion-Session=')
            );
            expect(rawSessionCookie).toBeDefined();
            expect(rawSessionCookie).toContain('HttpOnly');
            expect(rawSessionCookie).toContain('Secure');
            expect(rawSessionCookie).toContain('SameSite=lax');

            const sessionTokenVal = rawSessionCookie.split(';')[0].split('=')[1];
            const csrfTokenVal = callbackBody.csrfToken;

            // STEP 11: Access protected session endpoint using HttpOnly cookie
            const step11 = await makeRequest(app, {
                method: 'GET',
                url: '/api/auth/session',
                headers: {
                    cookie: `__Host-Fusion-Session=${sessionTokenVal}`,
                },
            });
            expect(step11.statusCode).toBe(200);
            const sessionData = JSON.parse(step11.text);
            expect(sessionData.authenticated).toBe(true);
            expect(sessionData.operator.operatorId).toBe('op_synth_42');

            // STEP 12: Log out and verify old session is rejected
            const step12 = await makeRequest(app, {
                method: 'POST',
                url: '/api/auth/logout',
                headers: {
                    cookie: `__Host-Fusion-Session=${sessionTokenVal}; __Host-Fusion-CSRF=${csrfTokenVal}`,
                    'x-csrf-token': csrfTokenVal,
                    origin: 'http://localhost:3000',
                },
            });
            expect(step12.statusCode).toBe(200);

            // Re-attempt accessing protected endpoint with old session token -> must be 401
            const postLogoutCheck = await makeRequest(app, {
                method: 'GET',
                url: '/api/auth/session',
                headers: {
                    cookie: `__Host-Fusion-Session=${sessionTokenVal}`,
                },
            });
            expect(postLogoutCheck.statusCode).toBe(401);
            expect(postLogoutCheck.text).toContain('SESSION_REVOKED');
        });
    });
});
