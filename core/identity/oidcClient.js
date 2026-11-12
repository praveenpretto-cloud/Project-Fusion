'use strict';

/**
 * PROJECT FUSION — ENTERPRISE OIDC CLIENT ABSTRACTION (AI-2A.2)
 * =============================================================
 * Implements a provider-neutral OpenID Connect client supporting:
 * - Authorization Code Flow with PKCE (S256)
 * - High-entropy 256-bit key management & versioned authenticated AES-256-GCM encryption
 * - Confidential client authentication (client_secret_basic, client_secret_post, private_key_jwt)
 * - Atomic single-use state transaction consumption & replay defense
 * - Dynamic JWKS key resolution with anti-storm caching and controlled one-time refresh
 * - SSRF and untrusted redirect defenses
 * - Strict ID token cryptographic verification (RS256/ES256, issuer, aud, azp, exp, iat, nbf, nonce, sub)
 * - Zero token or secret logging
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const logger = require('../../logger');

// Allowed cryptographic algorithms for enterprise OIDC tokens
const ALLOWED_SIGNING_ALGORITHMS = ['RS256', 'ES256'];

// Default clock skew tolerance in seconds
const DEFAULT_CLOCK_SKEW_SECONDS = 60;

// Maximum transaction lifetime (5 minutes)
const TRANSACTION_TTL_MS = 5 * 60 * 1000;

// JWKS Caching and rate limiting against refresh storms
const DEFAULT_JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MIN_JWKS_REFRESH_INTERVAL_MS = 5 * 1000; // 5 seconds minimum between forced refreshes

// Authenticated Encryption constants for PKCE code_verifier
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV per NIST SP 800-38D
const AUTH_TAG_LENGTH = 16; // 128-bit authentication tag

/**
 * URL-encodes a string according to RFC 6749 Section 2.3.1 (application/x-www-form-urlencoded)
 * for use in HTTP Basic client credentials.
 * Spaces become '+', and characters outside the unreserved character set are %HH encoded.
 */
function rfc6749FormUrlEncode(str) {
    if (str === null || str === undefined) return '';
    return encodeURIComponent(String(str))
        .replace(/%20/g, '+')
        .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Validates and converts key material into an exact 256-bit (32-byte) Buffer.
 * Strictly rejects arbitrary human-readable passwords.
 */
function parseEncryptionKey(rawKey, keyName = 'Key') {
    if (!rawKey) {
        throw new Error(`${keyName} is required`);
    }
    if (Buffer.isBuffer(rawKey)) {
        if (rawKey.length !== 32) {
            throw new Error(
                `${keyName} must be exactly 32 bytes (256 bits). Got ${rawKey.length} bytes.`
            );
        }
        return rawKey;
    }
    if (typeof rawKey !== 'string') {
        throw new Error(
            `${keyName} must be a 64-char hex string, 44-char base64 string, or 32-byte Buffer.`
        );
    }
    const trimmed = rawKey.trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        return Buffer.from(trimmed, 'hex');
    }
    if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) {
        const buf = Buffer.from(trimmed, 'base64');
        if (buf.length === 32) return buf;
    }
    throw new Error(
        `${keyName} must be a high-entropy 256-bit (32-byte) key encoded in hex (64 chars) or base64 (44 chars). ` +
            'Arbitrary human-readable passwords are not permitted.'
    );
}

/**
 * Loads the active key ring supporting primary active key and rotated historical keys.
 */
function getTransactionKeyRing() {
    const primaryId = (process.env.OIDC_PRIMARY_KEY_ID || 'k1').trim();
    const primaryRaw = (
        process.env.OIDC_TRANSACTION_SECRET ||
        process.env.OIDC_ENCRYPTION_KEY ||
        ''
    ).trim();
    const keyRing = new Map();

    if (primaryRaw) {
        keyRing.set(primaryId, parseEncryptionKey(primaryRaw, `Primary key (${primaryId})`));
    } else {
        if (process.env.NODE_ENV === 'production') {
            throw new Error(
                'OIDC_TRANSACTION_SECRET is required in production for PKCE verifier encryption'
            );
        }
        // High-entropy 32-byte hex test key for dev/test environments
        keyRing.set(
            'k1',
            Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex')
        );
    }

    // Optional secondary keys from JSON environment configuration
    if (process.env.OIDC_SECONDARY_KEYS) {
        try {
            const parsed = JSON.parse(process.env.OIDC_SECONDARY_KEYS);
            for (const [kid, kVal] of Object.entries(parsed)) {
                keyRing.set(kid, parseEncryptionKey(kVal, `Rotated key (${kid})`));
            }
        } catch (e) {
            logger.warn(`Failed to parse OIDC_SECONDARY_KEYS: ${e.message}`);
        }
    }

    return { primaryId, keyRing };
}

/**
 * Helper: Retrieves the primary 256-bit key Buffer
 */
function getTransactionEncryptionKey() {
    const { primaryId, keyRing } = getTransactionKeyRing();
    return keyRing.get(primaryId);
}

/**
 * Encrypts PKCE code_verifier using AES-256-GCM authenticated encryption.
 * Outputs versioned payload: v1:<keyId>:<ivHex>:<tagHex>:<ciphertextHex>
 */
function encryptCodeVerifier(plainVerifier, { key = null, keyId = null } = {}) {
    if (!plainVerifier || typeof plainVerifier !== 'string') {
        throw new Error('Invalid code_verifier to encrypt');
    }

    let encKey = key;
    let kid = keyId;

    if (!encKey) {
        const ring = getTransactionKeyRing();
        kid = kid || ring.primaryId;
        encKey = ring.keyRing.get(kid);
        if (!encKey) {
            throw new Error(`Configured primary key ID "${kid}" not found in key ring`);
        }
    } else {
        encKey = parseEncryptionKey(encKey, 'Encryption key');
        kid = kid || 'k_custom';
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, encKey, iv, {
        authTagLength: AUTH_TAG_LENGTH,
    });
    const encrypted = Buffer.concat([cipher.update(plainVerifier, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return `v1:${kid}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts PKCE code_verifier using AES-256-GCM and verifies authentication tag.
 * Fails closed if the specific key version is unavailable or if ciphertext was tampered with.
 */
function decryptCodeVerifier(encryptedPayload, { keys = null } = {}) {
    if (!encryptedPayload || typeof encryptedPayload !== 'string') {
        throw new Error('Invalid encrypted code_verifier payload');
    }

    const parts = encryptedPayload.split(':');
    let version, keyId, ivHex, tagHex, encryptedHex;

    if (parts.length === 5) {
        [version, keyId, ivHex, tagHex, encryptedHex] = parts;
        if (version !== 'v1') {
            throw new Error(`Unsupported encrypted payload version: "${version}"`);
        }
    } else if (parts.length === 3) {
        // Legacy unversioned payload: iv:tag:ciphertext (for backward compatibility)
        keyId = 'legacy';
        [ivHex, tagHex, encryptedHex] = parts;
    } else {
        throw new Error(
            'Malformed encrypted code_verifier payload: must have v1:keyId:iv:tag:ciphertext'
        );
    }

    let decKey = null;

    if (keys instanceof Map) {
        decKey = keys.get(keyId);
    } else if (keys && typeof keys === 'object' && !Buffer.isBuffer(keys)) {
        decKey = keys[keyId] ? parseEncryptionKey(keys[keyId], `Key ${keyId}`) : null;
    } else if (Buffer.isBuffer(keys) || (typeof keys === 'string' && keys.length > 0)) {
        decKey = parseEncryptionKey(keys, 'Decryption key');
    } else {
        const ring = getTransactionKeyRing();
        decKey =
            ring.keyRing.get(keyId) ||
            (keyId === 'legacy' ? ring.keyRing.get(ring.primaryId) : null);
    }

    if (!decKey) {
        throw new Error(
            `Decryption failed: encryption key ID "${keyId}" is not available in configured key ring. Fail-closed.`
        );
    }

    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    try {
        const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, decKey, iv, {
            authTagLength: AUTH_TAG_LENGTH,
        });
        decipher.setAuthTag(tag);
        return decipher.update(encrypted, null, 'utf8') + decipher.final('utf8');
    } catch (err) {
        throw new Error(`Ciphertext decryption failed (possible tampering): ${err.message}`);
    }
}

/**
 * Helper: Base64URL encoding without padding
 */
function base64UrlEncode(buffer) {
    return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Helper: Base64URL decode to string or buffer
 */
function base64UrlDecode(str) {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
        base64 += '=';
    }
    return Buffer.from(base64, 'base64');
}

/**
 * Generates PKCE code_verifier and code_challenge (RFC 7636)
 */
function generatePkcePair() {
    const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
    const codeChallenge = base64UrlEncode(
        crypto.createHash('sha256').update(codeVerifier).digest()
    );
    return {
        codeVerifier,
        codeChallenge,
        codeChallengeMethod: 'S256',
    };
}

/**
 * Generates cryptographically secure random URL-safe token (state, nonce)
 */
function generateRandomString(byteLength = 32) {
    return base64UrlEncode(crypto.randomBytes(byteLength));
}

class OidcClient {
    /**
     * @param {object} config
     * @param {string} config.issuer - Expected OIDC Issuer URL
     * @param {string} config.clientId - Enterprise Client ID
     * @param {string} [config.clientSecret] - Enterprise Client Secret
     * @param {string} [config.clientAuthMethod='client_secret_basic'] - 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt'
     * @param {string|KeyObject} [config.privateKey] - Private key for private_key_jwt
     * @param {string} [config.privateKeyKid] - Key ID for private_key_jwt assertion
     * @param {string} [config.authorizationEndpoint] - Auth URL
     * @param {string} [config.tokenEndpoint] - Token exchange URL
     * @param {string} [config.jwksUri] - JWKS URL for key rotation
     * @param {string[]} [config.allowedRedirectUris] - Whitelisted redirect URIs
     * @param {object} [config.jwksPublicKeys] - Initial map of kid -> PEM or PublicKey
     * @param {Function} [config.jwksFetcher] - Optional custom JWKS fetcher (for offline testing)
     * @param {boolean} [config.allowJitProvisioning=false] - Whether unknown operators may be provisioned
     * @param {Function} [config.tokenExchanger] - Custom token exchange function for testing
     */
    constructor(config = {}) {
        this.issuer = (
            config.issuer ||
            process.env.OIDC_ISSUER ||
            'https://identity.fusion.internal'
        ).trim();
        this.clientId = (
            config.clientId ||
            process.env.OIDC_CLIENT_ID ||
            'fusion-core-client'
        ).trim();
        this.clientSecret = (config.clientSecret || process.env.OIDC_CLIENT_SECRET || '').trim();
        this.clientAuthMethod =
            config.clientAuthMethod || process.env.OIDC_CLIENT_AUTH_METHOD || 'client_secret_basic';
        this.privateKey = config.privateKey || process.env.OIDC_PRIVATE_KEY || null;
        this.privateKeyKid = config.privateKeyKid || process.env.OIDC_PRIVATE_KEY_KID || null;

        this.authorizationEndpoint = (
            config.authorizationEndpoint ||
            process.env.OIDC_AUTH_ENDPOINT ||
            `${this.issuer}/oauth2/v1/authorize`
        ).trim();
        this.tokenEndpoint = (
            config.tokenEndpoint ||
            process.env.OIDC_TOKEN_ENDPOINT ||
            `${this.issuer}/oauth2/v1/token`
        ).trim();
        this.jwksUri = (
            config.jwksUri ||
            process.env.OIDC_JWKS_URI ||
            `${this.issuer}/oauth2/v1/keys`
        ).trim();

        const configuredJwksHosts =
            config.allowedJwksHosts ||
            (process.env.OIDC_ALLOWED_JWKS_HOSTS
                ? process.env.OIDC_ALLOWED_JWKS_HOSTS.split(',')
                : []);
        this.allowedJwksHosts = configuredJwksHosts
            .map((h) => h.trim().toLowerCase())
            .filter(Boolean);

        const configuredUris =
            config.allowedRedirectUris ||
            config.redirectUris ||
            (process.env.OIDC_ALLOWED_REDIRECT_URIS
                ? process.env.OIDC_ALLOWED_REDIRECT_URIS.split(',')
                : []);
        this.allowedRedirectUris = configuredUris.map((u) => u.trim()).filter(Boolean);

        // Pre-configured public keys (kid -> PEM / KeyObject)
        this.jwksPublicKeys = { ...(config.jwksPublicKeys || {}) };

        // Dynamic JWKS Cache
        this.jwksCache = new Map();
        this.jwksLastFetchedAt = 0;
        this.jwksCacheTtlMs = config.jwksCacheTtlMs || DEFAULT_JWKS_CACHE_TTL_MS;
        this.jwksMinRefreshIntervalMs =
            config.jwksMinRefreshIntervalMs || MIN_JWKS_REFRESH_INTERVAL_MS;
        this.customJwksFetcher = config.jwksFetcher || null;

        // Provisioning policy
        this.allowJitProvisioning = config.allowJitProvisioning === true;

        // Custom token exchange adapter (for test fixtures / offline testing)
        this.tokenExchanger = config.tokenExchanger || null;

        // In-memory transaction store for testing
        this.inMemoryTransactions = new Map();
    }

    /**
     * Asserts that a redirect URI is strictly in the configured allowlist.
     */
    validateRedirectUri(redirectUri) {
        if (!redirectUri || typeof redirectUri !== 'string') {
            const err = new Error('Redirect URI is required');
            err.statusCode = 400;
            throw err;
        }

        const normalized = redirectUri.trim();
        if (this.allowedRedirectUris.length > 0 && !this.allowedRedirectUris.includes(normalized)) {
            const err = new Error(`Redirect URI is not allowed: ${normalized}`);
            err.statusCode = 400;
            throw err;
        }
        return normalized;
    }

    /**
     * Initiates the Authorization Code Flow + PKCE.
     */
    async initiateAuthorization({ redirectUri, pool = null }) {
        const validatedRedirectUri = this.validateRedirectUri(redirectUri);

        const state = generateRandomString(32);
        const nonce = generateRandomString(32);
        const pkce = generatePkcePair();
        const expiresAt = new Date(Date.now() + TRANSACTION_TTL_MS);

        // Encrypt code_verifier with AES-256-GCM before persistence
        const encryptedVerifier = encryptCodeVerifier(pkce.codeVerifier);

        if (pool) {
            await pool.query(
                `INSERT INTO identity.authentication_transactions 
                 (state, nonce, encrypted_code_verifier, redirect_uri, expires_at)
                 VALUES ($1, $2, $3, $4, $5)`,
                [state, nonce, encryptedVerifier, validatedRedirectUri, expiresAt]
            );
        } else {
            this.inMemoryTransactions.set(state, {
                state,
                nonce,
                encryptedCodeVerifier: encryptedVerifier,
                redirectUri: validatedRedirectUri,
                expiresAt,
                usedAt: null,
            });
        }

        const url = new URL(this.authorizationEndpoint);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', this.clientId);
        url.searchParams.set('redirect_uri', validatedRedirectUri);
        url.searchParams.set('scope', 'openid profile email');
        url.searchParams.set('state', state);
        url.searchParams.set('nonce', nonce);
        url.searchParams.set('code_challenge', pkce.codeChallenge);
        url.searchParams.set('code_challenge_method', pkce.codeChallengeMethod);

        logger.info(`[OIDC] Initiated authorization code flow. State: ${state.substring(0, 8)}...`);

        return {
            authorizationUrl: url.toString(),
            state,
        };
    }

    /**
     * Atomically consumes an authentication transaction and decrypts the code_verifier.
     */
    async consumeTransaction(state, { pool = null } = {}) {
        if (!state || typeof state !== 'string') {
            const err = new Error('Invalid or missing state parameter');
            err.statusCode = 400;
            throw err;
        }

        const now = new Date();

        if (pool) {
            const res = await pool.query(
                `UPDATE identity.authentication_transactions
                 SET used_at = NOW()
                 WHERE state = $1 AND used_at IS NULL AND expires_at > NOW()
                 RETURNING state, nonce, encrypted_code_verifier, redirect_uri`,
                [state]
            );

            if (res.rows.length === 0) {
                const err = new Error(
                    'Authentication transaction is invalid, expired, or already used (Replay blocked)'
                );
                err.statusCode = 400;
                throw err;
            }

            const row = res.rows[0];
            const plainVerifier = decryptCodeVerifier(row.encrypted_code_verifier);
            return {
                state: row.state,
                nonce: row.nonce,
                codeVerifier: plainVerifier,
                redirectUri: row.redirect_uri,
            };
        } else {
            const tx = this.inMemoryTransactions.get(state);
            if (!tx || tx.usedAt !== null || tx.expiresAt <= now) {
                const err = new Error(
                    'Authentication transaction is invalid, expired, or already used (Replay blocked)'
                );
                err.statusCode = 400;
                throw err;
            }
            tx.usedAt = now;
            const plainVerifier = decryptCodeVerifier(tx.encryptedCodeVerifier);
            return {
                state: tx.state,
                nonce: tx.nonce,
                codeVerifier: plainVerifier,
                redirectUri: tx.redirectUri,
            };
        }
    }

    /**
     * Helper: checks if a URL is local/loopback
     */
    _isTrustedLocal(url) {
        return (
            url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
        );
    }

    /**
     * Verifies if a JWKS endpoint hostname is permitted for the configured issuer.
     * Supports:
     * 1. Direct host matching (jwksHost === issuerHost)
     * 2. Explicit configured allowedJwksHosts list
     * 3. Well-known enterprise IdP mappings (e.g. Google Workspace accounts.google.com -> www.googleapis.com)
     */
    _isJwksHostAllowed(jwksHostname, issuerHostname) {
        if (!jwksHostname || !issuerHostname) return false;
        const jwksHost = jwksHostname.toLowerCase();
        const issuerHost = issuerHostname.toLowerCase();

        // 1. Direct issuer match
        if (jwksHost === issuerHost) return true;

        // 2. Explicitly configured allowed hosts
        if (this.allowedJwksHosts.includes(jwksHost)) return true;

        // 3. Known enterprise IdP mappings (e.g. Google Workspace OIDC)
        const KNOWN_IDP_JWKS_HOSTS = {
            'accounts.google.com': ['www.googleapis.com', 'accounts.google.com'],
        };
        if (
            KNOWN_IDP_JWKS_HOSTS[issuerHost] &&
            KNOWN_IDP_JWKS_HOSTS[issuerHost].includes(jwksHost)
        ) {
            return true;
        }

        return false;
    }

    /**
     * Stores JWKS keys in the cache, parsing JWK structures if necessary
     */
    _storeJwksKeys(keysArray) {
        if (!Array.isArray(keysArray)) return;
        for (const keyDef of keysArray) {
            if (keyDef.kid) {
                if (typeof keyDef === 'string') {
                    this.jwksCache.set(keyDef.kid, keyDef);
                } else if (keyDef.kty) {
                    try {
                        const keyObj = crypto.createPublicKey({ key: keyDef, format: 'jwk' });
                        this.jwksCache.set(keyDef.kid, keyObj);
                    } catch (e) {
                        logger.warn(`Failed to parse JWK key ${keyDef.kid}: ${e.message}`);
                    }
                } else if (keyDef.publicKey) {
                    this.jwksCache.set(keyDef.kid, keyDef.publicKey);
                }
            }
        }
    }

    /**
     * Resolves and caches JWKS signing keys from the trusted JWKS URI.
     * Enforces anti-storm rate limiting, trusted host allowlisting, and redirect rejection.
     */
    async fetchJwks({ force = false } = {}) {
        const now = Date.now();
        if (
            !force &&
            this.jwksCache.size > 0 &&
            now - this.jwksLastFetchedAt < this.jwksCacheTtlMs
        ) {
            return this.jwksCache;
        }

        // Anti-storm cooldown: prevent multiple fetches within MIN_JWKS_REFRESH_INTERVAL_MS
        if (force && now - this.jwksLastFetchedAt < this.jwksMinRefreshIntervalMs) {
            logger.warn('[OIDC JWKS] Refresh throttled: minimum refresh interval has not elapsed.');
            return this.jwksCache;
        }

        // Security check: JWKS host must match issuer host or be in the permitted JWKS hosts allowlist
        const jwksUrl = new URL(this.jwksUri);
        const issuerUrl = new URL(this.issuer);

        const isHostPermitted = this._isJwksHostAllowed(jwksUrl.hostname, issuerUrl.hostname);
        if (!isHostPermitted && !this._isTrustedLocal(jwksUrl)) {
            throw new Error(
                `Untrusted JWKS endpoint: host "${jwksUrl.hostname}" does not match issuer "${issuerUrl.hostname}" and is not in the permitted JWKS hosts allowlist. Malicious JWKS URL blocked.`
            );
        }
        if (jwksUrl.protocol !== 'https:' && !this._isTrustedLocal(jwksUrl)) {
            throw new Error(`Insecure JWKS endpoint: HTTPS is required (got ${jwksUrl.protocol})`);
        }

        if (typeof this.customJwksFetcher === 'function') {
            const keys = await this.customJwksFetcher();
            this._storeJwksKeys(keys);
            this.jwksLastFetchedAt = now;
            return this.jwksCache;
        }

        const data = await this._getUrl(jwksUrl);
        if (!data || !Array.isArray(data.keys)) {
            throw new Error('Malformed JWKS response: missing "keys" array');
        }

        this._storeJwksKeys(data.keys);
        this.jwksLastFetchedAt = now;
        return this.jwksCache;
    }

    /**
     * Executes HTTP GET without following redirects (SSRF defense)
     */
    _getUrl(targetUrl) {
        return new Promise((resolve, reject) => {
            const isHttps = targetUrl.protocol === 'https:';
            const transport = isHttps ? https : http;

            const options = {
                hostname: targetUrl.hostname,
                port: targetUrl.port || (isHttps ? 443 : 80),
                path: targetUrl.pathname + targetUrl.search,
                method: 'GET',
                headers: { Accept: 'application/json' },
                timeout: 5000,
            };

            const req = transport.request(options, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400) {
                    return reject(
                        new Error(
                            `Untrusted redirect encountered on JWKS endpoint: ${res.statusCode}`
                        )
                    );
                }
                let raw = '';
                res.on('data', (chunk) => {
                    raw += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        return reject(new Error(`JWKS request failed with HTTP ${res.statusCode}`));
                    }
                    try {
                        resolve(JSON.parse(raw));
                    } catch (e) {
                        reject(new Error(`Malformed JSON from JWKS endpoint: ${e.message}`));
                    }
                });
            });

            req.on('error', (err) =>
                reject(new Error(`Network error contacting JWKS endpoint: ${err.message}`))
            );
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('JWKS request timed out'));
            });
            req.end();
        });
    }

    /**
     * Generates a signed client assertion JWT for private_key_jwt client authentication (RFC 7523)
     */
    generateClientAssertion({ privateKey = this.privateKey, keyId = this.privateKeyKid } = {}) {
        if (!privateKey) {
            throw new Error('privateKey is required for private_key_jwt client authentication');
        }
        const nowSec = Math.floor(Date.now() / 1000);
        const header = {
            alg: 'RS256',
            typ: 'JWT',
            ...(keyId ? { kid: keyId } : {}),
        };
        const payload = {
            iss: this.clientId,
            sub: this.clientId,
            aud: this.tokenEndpoint,
            jti: crypto.randomUUID(),
            exp: nowSec + 300, // 5 minutes validity
            iat: nowSec,
        };

        const encodedHeader = base64UrlEncode(Buffer.from(JSON.stringify(header), 'utf8'));
        const encodedPayload = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
        const signatureInput = `${encodedHeader}.${encodedPayload}`;

        const signer = crypto.createSign('RSA-SHA256');
        signer.update(signatureInput);
        const signature = base64UrlEncode(signer.sign(privateKey));

        return `${signatureInput}.${signature}`;
    }

    /**
     * Server-side authorization code exchange at the IdP token_endpoint.
     * Authenticates confidential client using configured clientAuthMethod.
     */
    async exchangeCodeForTokens({ code, codeVerifier, redirectUri }) {
        if (!code || typeof code !== 'string') {
            const err = new Error('Authorization code is required for token exchange');
            err.statusCode = 400;
            throw err;
        }
        if (!codeVerifier || typeof codeVerifier !== 'string') {
            const err = new Error('PKCE code_verifier is required for token exchange');
            err.statusCode = 400;
            throw err;
        }

        // Custom test exchanger injection
        if (typeof this.tokenExchanger === 'function') {
            return this.tokenExchanger({
                code,
                codeVerifier,
                redirectUri,
                clientId: this.clientId,
                clientAuthMethod: this.clientAuthMethod,
            });
        }

        const endpointUrl = new URL(this.tokenEndpoint);
        if (endpointUrl.protocol !== 'https:' && !this._isTrustedLocal(endpointUrl)) {
            const err = new Error(
                `Insecure token_endpoint: must use HTTPS (got ${endpointUrl.protocol})`
            );
            err.statusCode = 500;
            throw err;
        }

        const bodyParams = new URLSearchParams();
        bodyParams.set('grant_type', 'authorization_code');
        bodyParams.set('code', code);
        bodyParams.set('redirect_uri', redirectUri);
        bodyParams.set('client_id', this.clientId);
        bodyParams.set('code_verifier', codeVerifier);

        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        };

        // Apply configured confidential client authentication method
        if (this.clientAuthMethod === 'client_secret_basic') {
            if (this.clientSecret) {
                const creds = `${rfc6749FormUrlEncode(this.clientId)}:${rfc6749FormUrlEncode(this.clientSecret)}`;
                headers['Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`;
            }
        } else if (this.clientAuthMethod === 'client_secret_post') {
            if (this.clientSecret) {
                bodyParams.set('client_secret', this.clientSecret);
            }
        } else if (this.clientAuthMethod === 'private_key_jwt') {
            const assertion = this.generateClientAssertion();
            bodyParams.set(
                'client_assertion_type',
                'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
            );
            bodyParams.set('client_assertion', assertion);
        }

        const responseData = await this._postUrlEncoded(
            endpointUrl,
            bodyParams.toString(),
            headers
        );

        if (!responseData || !responseData.id_token) {
            const err = new Error('Token exchange response missing id_token');
            err.statusCode = 502;
            throw err;
        }

        return responseData;
    }

    /**
     * Executes HTTP POST without following redirects (SSRF defense)
     */
    _postUrlEncoded(targetUrl, bodyString, headers) {
        return new Promise((resolve, reject) => {
            const isHttps = targetUrl.protocol === 'https:';
            const transport = isHttps ? https : http;

            const options = {
                hostname: targetUrl.hostname,
                port: targetUrl.port || (isHttps ? 443 : 80),
                path: targetUrl.pathname + targetUrl.search,
                method: 'POST',
                headers: {
                    ...headers,
                    'Content-Length': Buffer.byteLength(bodyString),
                },
                timeout: 10000,
            };

            const req = transport.request(options, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400) {
                    return reject(
                        new Error(
                            `Untrusted redirect encountered on token endpoint: ${res.statusCode}`
                        )
                    );
                }

                let raw = '';
                res.on('data', (chunk) => {
                    raw += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        return reject(
                            new Error(`Token exchange failed with HTTP status ${res.statusCode}`)
                        );
                    }
                    try {
                        const parsed = JSON.parse(raw);
                        resolve(parsed);
                    } catch (e) {
                        reject(new Error(`Malformed JSON from token endpoint: ${e.message}`));
                    }
                });
            });

            req.on('error', (err) =>
                reject(new Error(`Network error contacting token endpoint: ${err.message}`))
            );
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Token exchange request timed out'));
            });

            req.write(bodyString);
            req.end();
        });
    }

    /**
     * Parses and cryptographically validates an OIDC ID token.
     * Enforces RS256/ES256, issuer, aud, azp, exp, iat, nbf, nonce, sub.
     * Resolves signing keys via JWKS with one controlled refresh on unknown kid.
     */
    async validateIdToken(
        idTokenJwt,
        { expectedNonce, publicKey = null, clockSkewSec = DEFAULT_CLOCK_SKEW_SECONDS } = {}
    ) {
        if (!idTokenJwt || typeof idTokenJwt !== 'string') {
            const err = new Error('Missing ID token');
            err.statusCode = 400;
            throw err;
        }

        const parts = idTokenJwt.split('.');
        if (parts.length !== 3) {
            const err = new Error('Malformed JWT: must contain 3 segments');
            err.statusCode = 400;
            throw err;
        }

        const [rawHeader, rawPayload, rawSignature] = parts;

        let header, payload;
        try {
            header = JSON.parse(base64UrlDecode(rawHeader).toString('utf8'));
            payload = JSON.parse(base64UrlDecode(rawPayload).toString('utf8'));
        } catch {
            const err = new Error('Malformed JWT header or payload encoding');
            err.statusCode = 400;
            throw err;
        }

        // 1. Explicit Algorithm Whitelist
        if (!header.alg || !ALLOWED_SIGNING_ALGORITHMS.includes(header.alg)) {
            const err = new Error(
                `Untrusted signing algorithm: ${header.alg}. Allowed: ${ALLOWED_SIGNING_ALGORITHMS.join(', ')}`
            );
            err.statusCode = 400;
            throw err;
        }

        // 2. Strict Issuer Validation
        if (!payload.iss || payload.iss !== this.issuer) {
            const err = new Error(
                `Issuer mismatch: expected ${this.issuer}, received ${payload.iss}`
            );
            err.statusCode = 401;
            throw err;
        }

        // 3. Strict Audience Validation
        const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        if (!aud.includes(this.clientId)) {
            const err = new Error(
                `Audience mismatch: token audience ${JSON.stringify(payload.aud)} does not include ${this.clientId}`
            );
            err.statusCode = 401;
            throw err;
        }

        // 4. Authorized Party check (OIDC Core 3.1.3.7)
        if (aud.length > 1 && !payload.azp) {
            const err = new Error(
                'ID token with multiple audiences must include azp (authorized party) claim'
            );
            err.statusCode = 401;
            throw err;
        }
        if (payload.azp && payload.azp !== this.clientId) {
            const err = new Error(
                `Authorized party (azp) mismatch: expected ${this.clientId}, received ${payload.azp}`
            );
            err.statusCode = 401;
            throw err;
        }

        // 5. Expiration & Clock Skew Checks
        const nowSec = Math.floor(Date.now() / 1000);
        if (
            !payload.exp ||
            typeof payload.exp !== 'number' ||
            payload.exp < nowSec - clockSkewSec
        ) {
            const err = new Error('ID token has expired');
            err.statusCode = 401;
            throw err;
        }

        if (payload.iat && typeof payload.iat === 'number' && payload.iat > nowSec + clockSkewSec) {
            const err = new Error('ID token issued in the future (clock skew exceeded)');
            err.statusCode = 401;
            throw err;
        }

        // 6. Not Before (nbf) Check
        if (payload.nbf && typeof payload.nbf === 'number' && payload.nbf > nowSec + clockSkewSec) {
            const err = new Error('ID token not yet valid (nbf exceeded clock skew)');
            err.statusCode = 401;
            throw err;
        }

        // 7. Nonce Validation
        if (expectedNonce && payload.nonce !== expectedNonce) {
            const err = new Error('Nonce mismatch: token does not match authorization transaction');
            err.statusCode = 401;
            throw err;
        }

        // 8. Subject Identity Assertion
        if (!payload.sub || typeof payload.sub !== 'string' || payload.sub.trim() === '') {
            const err = new Error('ID token missing subject (sub) claim');
            err.statusCode = 401;
            throw err;
        }

        // 9. Key Resolution & JWKS Key Rotation
        let verificationKey = publicKey;
        if (!verificationKey && header.kid) {
            verificationKey = this.jwksPublicKeys[header.kid] || this.jwksCache.get(header.kid);
        }

        // If kid is unfamiliar, perform ONE controlled refresh from trusted JWKS endpoint
        if (
            !verificationKey &&
            header.kid &&
            (this.jwksUri || typeof this.customJwksFetcher === 'function')
        ) {
            try {
                await this.fetchJwks({ force: true });
                verificationKey = this.jwksPublicKeys[header.kid] || this.jwksCache.get(header.kid);
            } catch (jwksErr) {
                logger.warn(`[OIDC] JWKS refresh failed: ${jwksErr.message}`);
            }
        }

        if (!verificationKey) {
            verificationKey = this.jwksPublicKeys['default'];
        }

        if (!verificationKey) {
            const err = new Error(
                `No trusted public key found matching token key ID (kid: "${header.kid || 'none'}"). ` +
                    'Key unknown even after JWKS refresh.'
            );
            err.statusCode = 401;
            throw err;
        }

        const signedData = Buffer.from(`${rawHeader}.${rawPayload}`, 'utf8');
        const signatureBuffer = base64UrlDecode(rawSignature);

        const verifier =
            header.alg === 'ES256'
                ? crypto.createVerify('SHA256')
                : crypto.createVerify('RSA-SHA256');
        verifier.update(signedData);
        const isValid = verifier.verify(verificationKey, signatureBuffer);

        if (!isValid) {
            const err = new Error('Cryptographic signature verification failed for ID token');
            err.statusCode = 401;
            throw err;
        }

        return {
            issuer: payload.iss,
            subject: payload.sub,
            email: payload.email || null,
            name: payload.name || payload.preferred_username || payload.sub,
            claims: payload,
        };
    }

    /**
     * Purges expired and old consumed authentication transactions
     */
    async cleanupExpiredTransactions({ pool = null, maxAgeMs = 3600000 } = {}) {
        const now = new Date();
        const cutoff = new Date(Date.now() - maxAgeMs);

        if (pool) {
            const res = await pool.query(
                `DELETE FROM identity.authentication_transactions
                 WHERE expires_at < $1 OR (used_at IS NOT NULL AND used_at < $2)`,
                [now, cutoff]
            );
            return { deletedCount: res.rowCount };
        } else {
            let deleted = 0;
            for (const [state, tx] of this.inMemoryTransactions.entries()) {
                if (tx.expiresAt < now || (tx.usedAt && tx.usedAt < cutoff)) {
                    this.inMemoryTransactions.delete(state);
                    deleted++;
                }
            }
            return { deletedCount: deleted };
        }
    }
}

module.exports = {
    OidcClient,
    generatePkcePair,
    base64UrlEncode,
    base64UrlDecode,
    rfc6749FormUrlEncode,
    parseEncryptionKey,
    encryptCodeVerifier,
    decryptCodeVerifier,
    getTransactionEncryptionKey,
    getTransactionKeyRing,
    ALLOWED_SIGNING_ALGORITHMS,
    TRANSACTION_TTL_MS,
    DEFAULT_JWKS_CACHE_TTL_MS,
    MIN_JWKS_REFRESH_INTERVAL_MS,
};
