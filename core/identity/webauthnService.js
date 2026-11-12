'use strict';

/**
 * PROJECT FUSION — ENTERPRISE WEBAUTHN / FIDO2 SERVICE (AI-2B.1)
 * ===============================================================
 * Production W3C WebAuthn Level 3 implementation using @simplewebauthn/server:
 * - High-entropy single-use challenges with atomic consumption
 * - Cryptographic signature verification over authenticatorData || SHA256(clientDataJSON)
 * - Supported algorithms: ES256 (ECDSA P-256 / SHA-256) and RS256 (RSA / SHA-256)
 * - Mandatory User Verification (UV = true) for high-risk treasury actions
 * - Counter verification for authenticator clone detection
 * - Origin and RP ID matching
 * - In-memory and PostgreSQL backing stores
 * - Synthetic test authenticator generator for offline testing
 */

const crypto = require('crypto');
const {
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    generateRegistrationOptions,
} = require('@simplewebauthn/server');
const { encodeCBOR } = require('@levischuck/tiny-cbor');
const { toCanonicalDecimal, ASSET_PRECISION } = require('../orchestrator/financialDecimal');

const ALLOWED_PAYMENT_CONTEXT_ACTIONS = Object.freeze(['APPROVE', 'VOID']);
const logger = require('../../logger');

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const DEFAULT_RP_NAME = 'Project Fusion Treasury';
const DEFAULT_ORIGIN = process.env.WEBAUTHN_ORIGIN || 'http://localhost:3000';

function base64UrlEncode(buffer) {
    return Buffer.from(buffer)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function base64UrlDecode(str) {
    if (!str || typeof str !== 'string') return Buffer.alloc(0);
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) {
        base64 += '=';
    }
    return Buffer.from(base64, 'base64');
}

/**
 * Converts a public key (PEM SPKI, JWK, or existing COSE buffer) into a COSE Uint8Array
 * required by @simplewebauthn/server.
 */
function pemToCose(pemOrCose) {
    if (Buffer.isBuffer(pemOrCose) || pemOrCose instanceof Uint8Array) {
        return new Uint8Array(pemOrCose);
    }
    if (typeof pemOrCose === 'string') {
        if (
            !pemOrCose.includes('BEGIN PUBLIC KEY') &&
            !pemOrCose.includes('BEGIN RSA PUBLIC KEY')
        ) {
            return new Uint8Array(base64UrlDecode(pemOrCose));
        }
        const pub = crypto.createPublicKey(pemOrCose);
        const jwk = pub.export({ format: 'jwk' });
        if (jwk.kty === 'EC' && jwk.crv === 'P-256') {
            const x = new Uint8Array(base64UrlDecode(jwk.x));
            const y = new Uint8Array(base64UrlDecode(jwk.y));
            const coseMap = new Map([
                [1, 2], // kty: EC2
                [3, -7], // alg: ES256
                [-1, 1], // crv: P-256
                [-2, x], // x coord (32 bytes)
                [-3, y], // y coord (32 bytes)
            ]);
            return new Uint8Array(encodeCBOR(coseMap));
        } else if (jwk.kty === 'RSA') {
            const n = new Uint8Array(base64UrlDecode(jwk.n));
            const e = new Uint8Array(base64UrlDecode(jwk.e));
            const coseMap = new Map([
                [1, 3], // kty: RSA
                [3, -257], // alg: RS256
                [-1, n], // n
                [-2, e], // e
            ]);
            return new Uint8Array(encodeCBOR(coseMap));
        }
        throw new Error(`Unsupported public key type for COSE conversion: ${jwk.kty}`);
    }
    throw new Error('Invalid public key format');
}

/**
 * Computes a deterministic canonical SHA-256 hex digest of payment approval context.
 * Binds approvalId, instructionId, version, amount, currency, beneficiary,
 * destination_account, provider, environment, action, and checkerOperatorId.
 *
 * Requirements (AI-2B.3):
 * - Use exact decimal strings, never JavaScript floating-point formatting.
 * - Apply currency-specific decimal precision.
 * - Reject missing or malformed required context fields.
 * - Do not substitute defaults for missing payment details.
 *
 * @param {object} context - Payment approval details
 * @returns {string} SHA-256 hex digest
 */
function computePaymentContextDigest(context = {}) {
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
        throw new Error('Valid paymentContext object is required to compute digest');
    }

    // 1. approvalId: non-empty string
    if (
        !context.approvalId ||
        typeof context.approvalId !== 'string' ||
        !context.approvalId.trim()
    ) {
        throw new Error('Missing or invalid required payment context field: "approvalId"');
    }

    // 2. instructionId: non-empty string
    if (
        !context.instructionId ||
        typeof context.instructionId !== 'string' ||
        !context.instructionId.trim()
    ) {
        throw new Error('Missing or invalid required payment context field: "instructionId"');
    }

    // 3. version: positive integer >= 1
    const versionNum = Number(context.version);
    if (
        context.version === undefined ||
        context.version === null ||
        !Number.isInteger(versionNum) ||
        versionNum < 1
    ) {
        throw new Error(
            'Missing or invalid required payment context field: "version" (must be integer >= 1)'
        );
    }

    // 4. currency: non-empty string in ASSET_PRECISION
    if (!context.currency || typeof context.currency !== 'string' || !context.currency.trim()) {
        throw new Error('Missing or invalid required payment context field: "currency"');
    }
    const normCurrency = context.currency.toUpperCase().trim();
    if (!Object.prototype.hasOwnProperty.call(ASSET_PRECISION, normCurrency)) {
        throw new Error(
            `Missing or invalid required payment context field: "currency" (unsupported asset "${normCurrency}")`
        );
    }

    // 5. amount: exact decimal string, never JS float formatting, currency-specific precision
    if (
        context.amount === undefined ||
        context.amount === null ||
        (typeof context.amount === 'string' && !context.amount.trim())
    ) {
        throw new Error('Missing or invalid required payment context field: "amount"');
    }
    if (typeof context.amount === 'number') {
        throw new Error(
            'Missing or invalid required payment context field: "amount" (JavaScript Number inputs are rejected to prevent IEEE 754 precision loss; provide an exact decimal string)'
        );
    }
    if (typeof context.amount !== 'string') {
        throw new Error(
            'Missing or invalid required payment context field: "amount" (must be an exact decimal string)'
        );
    }
    let canonicalAmount;
    try {
        canonicalAmount = toCanonicalDecimal(context.amount, normCurrency);
    } catch (e) {
        throw new Error(
            `Missing or invalid required payment context field: "amount" (${e.message})`
        );
    }
    if (
        canonicalAmount.startsWith('-') ||
        canonicalAmount === '0' ||
        /^0+(\.0+)?$/.test(canonicalAmount)
    ) {
        throw new Error(
            'Missing or invalid required payment context field: "amount" (must be positive)'
        );
    }

    // 6. beneficiary: non-empty string
    const rawBeneficiary = context.beneficiary || context.recipient;
    if (!rawBeneficiary || typeof rawBeneficiary !== 'string' || !rawBeneficiary.trim()) {
        throw new Error('Missing or invalid required payment context field: "beneficiary"');
    }

    // 7. destination_account: non-empty string
    const rawDestAccount = context.destination_account || context.destinationAccount;
    if (!rawDestAccount || typeof rawDestAccount !== 'string' || !rawDestAccount.trim()) {
        throw new Error('Missing or invalid required payment context field: "destination_account"');
    }

    // 8. provider: non-empty string
    if (!context.provider || typeof context.provider !== 'string' || !context.provider.trim()) {
        throw new Error('Missing or invalid required payment context field: "provider"');
    }

    // 9. environment: non-empty string
    if (
        !context.environment ||
        typeof context.environment !== 'string' ||
        !context.environment.trim()
    ) {
        throw new Error('Missing or invalid required payment context field: "environment"');
    }

    // 10. action: explicitly allowed action ('APPROVE' or 'VOID')
    if (!context.action || typeof context.action !== 'string' || !context.action.trim()) {
        throw new Error('Missing or invalid required payment context field: "action"');
    }
    const normAction = String(context.action).toUpperCase().trim();
    if (!ALLOWED_PAYMENT_CONTEXT_ACTIONS.includes(normAction)) {
        throw new Error(
            `Missing or invalid required payment context field: "action" (action must be one of: ${ALLOWED_PAYMENT_CONTEXT_ACTIONS.join(', ')})`
        );
    }

    // 11. checkerOperatorId: non-empty string
    if (
        !context.checkerOperatorId ||
        typeof context.checkerOperatorId !== 'string' ||
        !context.checkerOperatorId.trim()
    ) {
        throw new Error('Missing or invalid required payment context field: "checkerOperatorId"');
    }

    const normalized = {
        action: normAction,
        amount: canonicalAmount,
        approvalId: String(context.approvalId).trim(),
        beneficiary: String(rawBeneficiary).trim(),
        checkerOperatorId: String(context.checkerOperatorId).trim(),
        currency: normCurrency,
        destination_account: String(rawDestAccount).trim(),
        environment: String(context.environment).toLowerCase().trim(),
        instructionId: String(context.instructionId).trim(),
        provider: String(context.provider).trim(),
        version: versionNum,
    };

    const canonicalStr = JSON.stringify(normalized, Object.keys(normalized).sort());
    return crypto.createHash('sha256').update(canonicalStr, 'utf8').digest('hex');
}

class WebAuthnService {
    constructor(options = {}) {
        this.rpId = (options.rpId || DEFAULT_RP_ID).trim().toLowerCase();
        this.rpName = options.rpName || DEFAULT_RP_NAME;
        this.origin = (options.origin || DEFAULT_ORIGIN).trim();
        this.allowedOrigins = [
            this.origin,
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            'http://localhost:3001',
            'http://127.0.0.1:3001',
        ];

        // In-memory stores for unit testing / development without live DB
        this.inMemoryCredentials = new Map(); // credentialId -> { operatorId, publicKey, cosePublicKey, counter, aaguid, createdAt }
        this.inMemoryChallenges = new Map(); // challenge -> { challengeId, operatorId, ceremonyType, expiresAt, consumedAt }
    }

    /**
     * Generates a single-use WebAuthn challenge for an operator.
     * Optionally cryptographically binds the challenge to a payment context.
     * @param {string} operatorId - Operator UUID
     * @param {string} [ceremonyType='authentication'] - 'registration' | 'authentication'
     * @param {object} [paymentContext=null] - Optional payment details to bind
     * @param {object} [options]
     * @param {object} [options.pool] - PostgreSQL Pool
     * @returns {Promise<{ challenge: string, challengeId: string, rpId: string, expiresAt: Date, contextDigest?: string }>}
     */
    async generateChallenge({
        operatorId,
        ceremonyType = 'authentication',
        paymentContext = null,
        pool = null,
    } = {}) {
        if (!operatorId) {
            throw new Error('operatorId is required to generate a WebAuthn challenge');
        }

        const challengeBytes = crypto.randomBytes(32);
        const challenge = base64UrlEncode(challengeBytes);
        const challengeId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

        let contextDigest = null;
        let contextDataJson = null;
        let instructionId = null;

        if (paymentContext) {
            contextDigest = computePaymentContextDigest(paymentContext);
            contextDataJson = JSON.stringify(paymentContext);
            instructionId = paymentContext.instructionId || null;
        }

        if (pool) {
            await pool.query(
                `INSERT INTO identity.webauthn_challenges (
                    challenge_id, operator_id, challenge, ceremony_type, expires_at, context_digest, context_data, instruction_id
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    challengeId,
                    operatorId,
                    challenge,
                    ceremonyType,
                    expiresAt,
                    contextDigest,
                    contextDataJson,
                    instructionId,
                ]
            );
        } else {
            this.inMemoryChallenges.set(challenge, {
                challengeId,
                operatorId,
                challenge,
                ceremonyType,
                expiresAt,
                consumedAt: null,
                context_digest: contextDigest,
                contextDigest,
                context_data: paymentContext,
                contextData: paymentContext,
                instruction_id: instructionId,
                instructionId,
            });
        }

        return {
            challenge,
            challengeId,
            rpId: this.rpId,
            rpName: this.rpName,
            expiresAt,
            ...(contextDigest ? { contextDigest } : {}),
        };
    }

    /**
     * Atomically consumes a challenge, ensuring single-use and rejecting expired/consumed ones.
     */
    async _consumeChallenge(challengeStr, operatorId, expectedCeremony, pool = null) {
        const now = new Date();

        if (pool) {
            const res = await pool.query(
                `UPDATE identity.webauthn_challenges
                 SET consumed_at = NOW()
                 WHERE challenge = $1
                   AND operator_id = $2
                   AND ceremony_type = $3
                   AND consumed_at IS NULL
                   AND expires_at > NOW()
                 RETURNING *`,
                [challengeStr, operatorId, expectedCeremony]
            );

            if (res.rows.length === 0) {
                // Determine specific failure reason
                const checkRes = await pool.query(
                    `SELECT consumed_at, expires_at, operator_id, ceremony_type
                     FROM identity.webauthn_challenges WHERE challenge = $1`,
                    [challengeStr]
                );
                if (checkRes.rows.length > 0) {
                    const row = checkRes.rows[0];
                    if (row.consumed_at !== null) {
                        const err = new Error(
                            'WebAuthn challenge has already been consumed (replay blocked)'
                        );
                        err.statusCode = 400;
                        err.code = 'CHALLENGE_REPLAY';
                        throw err;
                    }
                    if (new Date(row.expires_at) <= now) {
                        const err = new Error('WebAuthn challenge has expired');
                        err.statusCode = 400;
                        err.code = 'CHALLENGE_EXPIRED';
                        throw err;
                    }
                    if (row.operator_id !== operatorId) {
                        const err = new Error('WebAuthn challenge operator mismatch');
                        err.statusCode = 400;
                        err.code = 'OPERATOR_MISMATCH';
                        throw err;
                    }
                    if (row.ceremony_type !== expectedCeremony) {
                        const err = new Error(
                            `WebAuthn ceremony mismatch: expected ${expectedCeremony}, got ${row.ceremony_type}`
                        );
                        err.statusCode = 400;
                        err.code = 'CEREMONY_MISMATCH';
                        throw err;
                    }
                }
                const err = new Error(
                    'WebAuthn challenge is invalid, expired, or already consumed'
                );
                err.statusCode = 400;
                err.code = 'INVALID_CHALLENGE';
                throw err;
            }
            return res.rows[0];
        } else {
            const record = this.inMemoryChallenges.get(challengeStr);
            if (!record) {
                const err = new Error('WebAuthn challenge not found');
                err.statusCode = 400;
                err.code = 'INVALID_CHALLENGE';
                throw err;
            }
            if (record.consumedAt !== null) {
                const err = new Error(
                    'WebAuthn challenge has already been consumed (replay blocked)'
                );
                err.statusCode = 400;
                err.code = 'CHALLENGE_REPLAY';
                throw err;
            }
            if (record.operatorId !== operatorId) {
                const err = new Error('WebAuthn challenge operator mismatch');
                err.statusCode = 400;
                err.code = 'OPERATOR_MISMATCH';
                throw err;
            }
            if (record.ceremonyType !== expectedCeremony) {
                const err = new Error(
                    `WebAuthn ceremony mismatch: expected ${expectedCeremony}, got ${record.ceremonyType}`
                );
                err.statusCode = 400;
                err.code = 'CEREMONY_MISMATCH';
                throw err;
            }
            if (now > record.expiresAt) {
                const err = new Error('WebAuthn challenge has expired');
                err.statusCode = 400;
                err.code = 'CHALLENGE_EXPIRED';
                throw err;
            }
            record.consumedAt = now;
            return record;
        }
    }

    /**
     * Registers a WebAuthn public key credential for an operator.
     */
    async registerCredential({
        operatorId,
        credentialId,
        publicKeyPem,
        challenge,
        clientDataJSON,
        pool = null,
    } = {}) {
        if (!operatorId || !credentialId || !publicKeyPem || !challenge) {
            throw new Error('Missing required fields for credential registration');
        }

        // Validate & consume registration challenge
        await this._consumeChallenge(challenge, operatorId, 'registration', pool);

        // Verify clientDataJSON if provided
        if (clientDataJSON) {
            const clientData = JSON.parse(
                Buffer.isBuffer(clientDataJSON)
                    ? clientDataJSON.toString('utf8')
                    : base64UrlDecode(clientDataJSON).toString('utf8')
            );
            if (clientData.type !== 'webauthn.create') {
                throw new Error(`Invalid clientData type for registration: "${clientData.type}"`);
            }
            if (clientData.challenge !== challenge) {
                throw new Error('Registration challenge mismatch in clientDataJSON');
            }
        }

        const coseBytes = pemToCose(publicKeyPem);
        const storedPublicKey =
            Buffer.isBuffer(publicKeyPem) ||
            typeof publicKeyPem !== 'string' ||
            !publicKeyPem.includes('BEGIN')
                ? Buffer.from(coseBytes).toString('base64url')
                : publicKeyPem;

        if (pool) {
            await pool.query(
                `INSERT INTO identity.webauthn_credentials (credential_id, operator_id, public_key, counter)
                 VALUES ($1, $2, $3, 0)
                 ON CONFLICT (credential_id)
                 DO UPDATE SET public_key = EXCLUDED.public_key, last_used_at = NOW()`,
                [credentialId, operatorId, storedPublicKey]
            );
        } else {
            this.inMemoryCredentials.set(credentialId, {
                credentialId,
                operatorId,
                publicKey: storedPublicKey,
                cosePublicKey: coseBytes,
                counter: 0,
                createdAt: new Date(),
            });
        }

        logger.info(
            `[WEBAUTHN] Registered new FIDO2 credential ${credentialId} for operator ${operatorId}`
        );
        return { success: true, credentialId, operatorId };
    }

    /**
     * Verifies an authentication assertion response against a stored credential using @simplewebauthn/server.
     */
    async verifyAuthenticationAssertion({
        operatorId,
        credentialId,
        assertionResponse,
        expectedPaymentContext = null,
        expectedOrigin = null,
        pool = null,
        requireUserVerification = true,
    } = {}) {
        if (!operatorId || !credentialId || !assertionResponse) {
            const err = new Error('operatorId, credentialId, and assertionResponse are required');
            err.statusCode = 400;
            throw err;
        }

        // Normalize response shape from either @simplewebauthn/browser or raw payload
        const inner = assertionResponse.response || assertionResponse;
        const clientDataJSON = inner.clientDataJSON;
        const authenticatorData = inner.authenticatorData;
        const signature = inner.signature;

        if (!clientDataJSON || !authenticatorData || !signature) {
            const err = new Error(
                'Malformed assertionResponse: clientDataJSON, authenticatorData, and signature are required'
            );
            err.statusCode = 400;
            throw err;
        }

        const clientDataStr =
            typeof clientDataJSON === 'string' ? clientDataJSON : base64UrlEncode(clientDataJSON);
        const authDataStr =
            typeof authenticatorData === 'string'
                ? authenticatorData
                : base64UrlEncode(authenticatorData);
        const sigStr = typeof signature === 'string' ? signature : base64UrlEncode(signature);

        // Parse clientDataJSON
        const clientDataBuf = base64UrlDecode(clientDataStr);
        let clientData;
        try {
            clientData = JSON.parse(clientDataBuf.toString('utf8'));
        } catch {
            const err = new Error('Malformed clientDataJSON');
            err.statusCode = 400;
            throw err;
        }

        // Origin check
        const originToCheck = expectedOrigin || this.origin;
        if (
            clientData.origin !== originToCheck &&
            !this.allowedOrigins.includes(clientData.origin)
        ) {
            const err = new Error(
                `Untrusted WebAuthn origin: "${clientData.origin}" (expected "${originToCheck}")`
            );
            err.statusCode = 400;
            err.code = 'INVALID_ORIGIN';
            throw err;
        }

        // Atomically consume challenge
        const consumedChallenge = await this._consumeChallenge(
            clientData.challenge,
            operatorId,
            'authentication',
            pool
        );

        // Validate payment context binding if challenge was context-bound
        const storedDigest = consumedChallenge.context_digest || consumedChallenge.contextDigest;
        if (storedDigest) {
            if (!expectedPaymentContext) {
                const err = new Error('Payment context is required to verify approval assertion');
                err.statusCode = 403;
                err.code = 'PAYMENT_CONTEXT_REQUIRED';
                throw err;
            }

            const expectedDigest = computePaymentContextDigest(expectedPaymentContext);
            if (expectedDigest !== storedDigest) {
                const err = new Error(
                    'WebAuthn payment context mismatch: approval details have been altered or mismatched'
                );
                err.statusCode = 403;
                err.code = 'PAYMENT_CONTEXT_MISMATCH';
                throw err;
            }

            if (
                expectedPaymentContext.checkerOperatorId &&
                expectedPaymentContext.checkerOperatorId !== operatorId
            ) {
                const err = new Error('WebAuthn checker operator mismatch with payment context');
                err.statusCode = 403;
                err.code = 'OPERATOR_MISMATCH';
                throw err;
            }
        }

        // Retrieve stored credential
        let storedCred;
        if (pool) {
            const res = await pool.query(
                `SELECT * FROM identity.webauthn_credentials WHERE credential_id = $1 AND operator_id = $2`,
                [credentialId, operatorId]
            );
            if (res.rows.length === 0) {
                const err = new Error(
                    `WebAuthn credential "${credentialId}" not found for operator`
                );
                err.statusCode = 404;
                throw err;
            }
            storedCred = res.rows[0];
        } else {
            storedCred = this.inMemoryCredentials.get(credentialId);
            if (!storedCred || storedCred.operatorId !== operatorId) {
                const err = new Error(
                    `WebAuthn credential "${credentialId}" not found for operator`
                );
                err.statusCode = 404;
                throw err;
            }
        }

        const cosePublicKey =
            storedCred.cosePublicKey || pemToCose(storedCred.public_key || storedCred.publicKey);
        const storedCounter = Number(storedCred.counter || 0);

        // Verify assertion with @simplewebauthn/server
        const swaResponse = {
            id: credentialId,
            rawId: credentialId,
            type: 'public-key',
            response: {
                clientDataJSON: clientDataStr,
                authenticatorData: authDataStr,
                signature: sigStr,
                userHandle: inner.userHandle || undefined,
            },
        };

        let verification;
        try {
            verification = await verifyAuthenticationResponse({
                response: swaResponse,
                expectedChallenge: clientData.challenge,
                expectedOrigin: this.allowedOrigins,
                expectedRPID: this.rpId,
                credential: {
                    id: credentialId,
                    publicKey: cosePublicKey,
                    counter: storedCounter,
                },
                requireUserVerification,
            });
        } catch (err) {
            const lowerMsg = (err.message || '').toLowerCase();
            if (lowerMsg.includes('counter') || lowerMsg.includes('lower than expected')) {
                const mappedErr = new Error(
                    'WebAuthn authenticator counter regression (possible cloned token)'
                );
                mappedErr.statusCode = 403;
                mappedErr.code = 'COUNTER_REGRESSION';
                throw mappedErr;
            }
            if (
                lowerMsg.includes('user verification') ||
                lowerMsg.includes('user could not be verified')
            ) {
                const mappedErr = new Error(
                    'User verification (UV) flag required but not satisfied in assertion'
                );
                mappedErr.statusCode = 403;
                mappedErr.code = 'USER_VERIFICATION_REQUIRED';
                throw mappedErr;
            }
            if (lowerMsg.includes('user not present') || lowerMsg.includes('user presence')) {
                const mappedErr = new Error('User presence (UP) flag not set in authenticatorData');
                mappedErr.statusCode = 400;
                mappedErr.code = 'USER_PRESENCE_REQUIRED';
                throw mappedErr;
            }
            if (lowerMsg.includes('rp id') || lowerMsg.includes('rpid')) {
                const mappedErr = new Error(
                    `rpIdHash mismatch: assertion not bound to rpId "${this.rpId}"`
                );
                mappedErr.statusCode = 400;
                mappedErr.code = 'RPID_MISMATCH';
                throw mappedErr;
            }
            if (lowerMsg.includes('origin')) {
                const mappedErr = new Error(
                    `Untrusted WebAuthn origin: "${clientData.origin}" (expected "${originToCheck}")`
                );
                mappedErr.statusCode = 400;
                mappedErr.code = 'INVALID_ORIGIN';
                throw mappedErr;
            }
            const mappedErr = new Error(`WebAuthn assertion verification failed: ${err.message}`);
            mappedErr.statusCode = 401;
            mappedErr.code = 'VERIFICATION_FAILED';
            throw mappedErr;
        }

        if (!verification.verified) {
            const err = new Error('WebAuthn cryptographic assertion signature verification failed');
            err.statusCode = 401;
            err.code = 'INVALID_SIGNATURE';
            throw err;
        }

        const newCounter = verification.authenticationInfo.newCounter;

        let signatureHash = null;
        if (sigStr) {
            signatureHash = crypto.createHash('sha256').update(sigStr).digest('hex');
        }

        // Update counter and record verified assertion evidence
        if (pool) {
            await pool.query(
                `UPDATE identity.webauthn_credentials
                 SET counter = $1, last_used_at = NOW()
                 WHERE credential_id = $2`,
                [newCounter, credentialId]
            );

            const challengeUuid = consumedChallenge.challenge_id || consumedChallenge.challengeId;
            if (challengeUuid && signatureHash) {
                const contextDigest =
                    storedDigest ||
                    (expectedPaymentContext
                        ? computePaymentContextDigest(expectedPaymentContext)
                        : '0'.repeat(64));
                try {
                    const { getVerifierDbConfig } = require('./verifierSecretBoundary');
                    const { Pool } = require('pg');
                    const verifierPool = new Pool(getVerifierDbConfig());
                    try {
                        await verifierPool.query(
                            `SELECT identity.fn_record_verified_webauthn_assertion($1, $2, $3, $4, $5)`,
                            [challengeUuid, operatorId, credentialId, signatureHash, contextDigest]
                        );
                    } finally {
                        await verifierPool.end();
                    }
                } catch (recErr) {
                    logger.warn(
                        `[WEBAUTHN] Verifier pool assertion recording failed, falling back to connection pool: ${recErr.message}`
                    );
                    await pool.query(
                        `SELECT identity.fn_record_verified_webauthn_assertion($1, $2, $3, $4, $5)`,
                        [challengeUuid, operatorId, credentialId, signatureHash, contextDigest]
                    );
                }
            }
        } else {
            storedCred.counter = newCounter;
            storedCred.lastUsedAt = new Date();
        }

        logger.info(
            `[WEBAUTHN] ✅ Successfully verified WebAuthn assertion for operator ${operatorId} (counter: ${newCounter})`
        );
        return {
            verified: true,
            operatorId,
            credentialId,
            counter: newCounter,
            userVerified: verification.authenticationInfo.userVerified,
            challengeId: consumedChallenge.challenge_id || consumedChallenge.challengeId,
            signatureHash,
        };
    }

    /**
     * Synthetic Test Authenticator: Generates valid WebAuthn assertion payload for offline tests.
     */
    createSyntheticAssertion({
        credentialId,
        privateKey,
        challenge,
        origin = this.origin,
        rpId = this.rpId,
        counter = 1,
        userPresent = true,
        userVerified = true,
    }) {
        const clientData = {
            type: 'webauthn.get',
            challenge,
            origin,
            crossOrigin: false,
        };
        const clientDataJSON = Buffer.from(JSON.stringify(clientData), 'utf8');
        const clientDataHash = crypto.createHash('sha256').update(clientDataJSON).digest();

        // 37-byte authenticator data
        const authData = Buffer.alloc(37);
        const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
        rpIdHash.copy(authData, 0);

        let flags = 0;
        if (userPresent) flags |= 0x01; // UP
        if (userVerified) flags |= 0x04; // UV
        authData[32] = flags;

        authData.writeUInt32BE(counter, 33);

        // Sign authData || clientDataHash
        const signedData = Buffer.concat([authData, clientDataHash]);
        const signer = crypto.createSign('SHA256');
        signer.update(signedData);
        const signature = signer.sign(privateKey);

        return {
            id: credentialId,
            rawId: credentialId,
            type: 'public-key',
            response: {
                clientDataJSON: base64UrlEncode(clientDataJSON),
                authenticatorData: base64UrlEncode(authData),
                signature: base64UrlEncode(signature),
            },
        };
    }
}

const defaultWebAuthnService = new WebAuthnService();

module.exports = {
    WebAuthnService,
    defaultWebAuthnService,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    generateRegistrationOptions,
    pemToCose,
    computePaymentContextDigest,
    ALLOWED_PAYMENT_CONTEXT_ACTIONS,
    base64UrlEncode,
    base64UrlDecode,
    CHALLENGE_TTL_MS,
    DEFAULT_RP_ID,
    DEFAULT_ORIGIN,
};
