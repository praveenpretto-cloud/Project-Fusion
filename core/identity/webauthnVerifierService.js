'use strict';

/**
 * PROJECT FUSION — ISOLATED WEBAUTHN VERIFIER SERVICE (AI-2B.6)
 * ==============================================================
 * Dedicated, isolated WebAuthn attestation/assertion verification service:
 * - Operates under dedicated database role: fusion_webauthn_verifier.
 * - Credentials isolated in verifierSecretBoundary, inaccessible to general API runtime.
 * - Independently verifies cryptographic assertions using @simplewebauthn/server.
 * - Reconstructs and validates payment context digests against authoritative DB state.
 * - Atomically executes identity.fn_record_verified_webauthn_assertion() upon
 *   cryptographic signature validation.
 * - Rejects synthetic or forged assertions, Boolean verified=true flags, expired/consumed
 *   challenges, and cross-operator re-use.
 */

const crypto = require('crypto');
const { Pool } = require('pg');
const { verifyAuthenticationResponse } = require('@simplewebauthn/server');
const { getVerifierDbConfig } = require('./verifierSecretBoundary');
const {
    base64UrlDecode,
    base64UrlEncode,
    pemToCose,
    computePaymentContextDigest,
} = require('./webauthnService');
const logger = require('../../logger');

const DEFAULT_RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
const DEFAULT_ORIGIN = process.env.WEBAUTHN_ORIGIN || 'http://localhost:3000';

class WebAuthnVerifierService {
    /**
     * @param {object} [options]
     * @param {object} [options.pool] - Dedicated database pool for verifier (defaults to isolated pool)
     * @param {string} [options.rpId]
     * @param {string} [options.origin]
     * @param {string[]} [options.allowedOrigins]
     */
    constructor(options = {}) {
        this.rpId = options.rpId || DEFAULT_RP_ID;
        this.origin = options.origin || DEFAULT_ORIGIN;
        this.allowedOrigins = options.allowedOrigins || [
            this.origin,
            'http://localhost:3000',
            'https://localhost:3000',
            'http://127.0.0.1:3000',
            'https://127.0.0.1:3000',
        ];

        this.verifierPool = options.pool || null;
        this._ownsPool = false;

        if (!this.verifierPool) {
            try {
                this.verifierPool = new Pool(getVerifierDbConfig());
                this._ownsPool = true;
            } catch (err) {
                logger.warn(
                    `[WEBAUTHN-VERIFIER] Could not initialize isolated verifier pool: ${err.message}`
                );
            }
        }
    }

    /**
     * Independently validates a WebAuthn assertion response and records verified evidence in PostgreSQL.
     * Rejects attempts to pass a Boolean verified=true flag without valid cryptographic proofs.
     *
     * @param {object} params
     * @param {string} params.operatorId
     * @param {string} params.credentialId
     * @param {object} params.assertionResponse - Raw response from browser navigator.credentials.get()
     * @param {object} [params.expectedPaymentContext=null] - Canonical payment approval context
     * @param {boolean} [params.requireUserVerification=true]
     * @param {string} [params.expectedOrigin=null]
     * @param {object} [params.customClient=null] - Optional dedicated verifier client
     * @returns {Promise<{ verified: boolean, challengeId: string, assertionId: string, signatureHash: string, contextDigest: string }>}
     */
    async verifyAndRecordAssertion({
        operatorId,
        credentialId,
        assertionResponse,
        expectedPaymentContext = null,
        requireUserVerification = true,
        expectedOrigin = null,
        customClient = null,
    } = {}) {
        if (!operatorId || !credentialId || !assertionResponse) {
            const err = new Error(
                'operatorId, credentialId, and assertionResponse are required for verification'
            );
            err.statusCode = 400;
            err.code = 'INVALID_ARGUMENTS';
            throw err;
        }

        // Strictly reject Boolean verified=true shortcuts without cryptographic evidence
        if (
            typeof assertionResponse === 'boolean' ||
            (assertionResponse.verified === true &&
                !assertionResponse.response &&
                !assertionResponse.clientDataJSON)
        ) {
            const err = new Error(
                'Cryptographic assertionResponse is mandatory. Boolean verified flags are strictly rejected.'
            );
            err.statusCode = 403;
            err.code = 'FORGED_ASSERTION_FLAG';
            throw err;
        }

        const inner = assertionResponse.response || assertionResponse;
        const clientDataJSON = inner.clientDataJSON;
        const authenticatorData = inner.authenticatorData;
        const signature = inner.signature;

        if (!clientDataJSON || !authenticatorData || !signature) {
            const err = new Error(
                'Malformed assertionResponse: clientDataJSON, authenticatorData, and signature are required'
            );
            err.statusCode = 400;
            err.code = 'MALFORMED_ASSERTION';
            throw err;
        }

        const clientDataStr =
            typeof clientDataJSON === 'string' ? clientDataJSON : base64UrlEncode(clientDataJSON);
        const authDataStr =
            typeof authenticatorData === 'string'
                ? authenticatorData
                : base64UrlEncode(authenticatorData);
        const sigStr = typeof signature === 'string' ? signature : base64UrlEncode(signature);

        // Parse and validate clientDataJSON
        const clientDataBuf = base64UrlDecode(clientDataStr);
        let clientData;
        try {
            clientData = JSON.parse(clientDataBuf.toString('utf8'));
        } catch {
            const err = new Error('Malformed clientDataJSON buffer');
            err.statusCode = 400;
            err.code = 'INVALID_CLIENT_DATA';
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

        // Ceremony type check
        if (clientData.type !== 'webauthn.get') {
            const err = new Error(
                `Invalid clientData type for authentication: "${clientData.type}" (must be "webauthn.get")`
            );
            err.statusCode = 400;
            err.code = 'INVALID_CEREMONY';
            throw err;
        }

        const dbClient =
            customClient || (this.verifierPool ? await this.verifierPool.connect() : null);
        if (!dbClient) {
            const err = new Error('Verifier database pool is unavailable');
            err.statusCode = 503;
            err.code = 'DATABASE_UNAVAILABLE';
            throw err;
        }

        const shouldReleaseClient = !customClient;

        try {
            await dbClient.query('BEGIN');

            // 1. Fetch and validate challenge from database
            const chRes = await dbClient.query(
                `SELECT * FROM identity.webauthn_challenges
                 WHERE challenge = $1 FOR UPDATE`,
                [clientData.challenge]
            );

            if (chRes.rows.length === 0) {
                const err = new Error('WebAuthn challenge not found');
                err.statusCode = 400;
                err.code = 'INVALID_CHALLENGE';
                throw err;
            }

            const challengeRow = chRes.rows[0];

            if (challengeRow.consumed_at !== null) {
                const err = new Error(
                    'WebAuthn challenge has already been consumed (replay blocked)'
                );
                err.statusCode = 400;
                err.code = 'CHALLENGE_REPLAY';
                throw err;
            }

            if (new Date(challengeRow.expires_at) <= new Date()) {
                const err = new Error('WebAuthn challenge has expired');
                err.statusCode = 400;
                err.code = 'CHALLENGE_EXPIRED';
                throw err;
            }

            if (challengeRow.operator_id !== operatorId) {
                const err = new Error('WebAuthn challenge operator mismatch');
                err.statusCode = 400;
                err.code = 'OPERATOR_MISMATCH';
                throw err;
            }

            if (challengeRow.ceremony_type !== 'authentication') {
                const err = new Error(
                    `WebAuthn ceremony mismatch: expected authentication, got ${challengeRow.ceremony_type}`
                );
                err.statusCode = 400;
                err.code = 'CEREMONY_MISMATCH';
                throw err;
            }

            // 2. Authoritative Database Payment Context Validation
            let canonicalDigest = challengeRow.context_digest || '0'.repeat(64);
            if (expectedPaymentContext || challengeRow.context_digest) {
                if (!expectedPaymentContext) {
                    const err = new Error(
                        'Payment context is required to verify approval assertion'
                    );
                    err.statusCode = 403;
                    err.code = 'PAYMENT_CONTEXT_REQUIRED';
                    throw err;
                }

                // If instructionId is present, validate against authoritative instructions table
                if (expectedPaymentContext.instructionId) {
                    const instCheck = await dbClient.query(
                        `SELECT instruction_id, amount, currency, recipient, destination_account, provider, environment, version
                         FROM public.instructions WHERE instruction_id = $1`,
                        [expectedPaymentContext.instructionId]
                    );

                    if (instCheck.rows.length > 0) {
                        const authoritativeInst = instCheck.rows[0];
                        if (
                            expectedPaymentContext.version &&
                            authoritativeInst.version !== expectedPaymentContext.version
                        ) {
                            const err = new Error(
                                'Payment context version mismatch against authoritative database record'
                            );
                            err.statusCode = 409;
                            err.code = 'CONCURRENCY_CONFLICT';
                            throw err;
                        }
                    }
                }

                canonicalDigest = computePaymentContextDigest(expectedPaymentContext);

                if (
                    challengeRow.context_digest &&
                    challengeRow.context_digest !== canonicalDigest
                ) {
                    const err = new Error(
                        'WebAuthn payment context mismatch: approval details have been altered or mismatched'
                    );
                    err.statusCode = 403;
                    err.code = 'PAYMENT_CONTEXT_MISMATCH';
                    throw err;
                }
            }

            // 3. Fetch registered credential
            const credRes = await dbClient.query(
                `SELECT * FROM identity.webauthn_credentials
                 WHERE credential_id = $1 AND operator_id = $2 FOR UPDATE`,
                [credentialId, operatorId]
            );

            if (credRes.rows.length === 0) {
                const err = new Error(
                    `WebAuthn credential "${credentialId}" not registered for operator`
                );
                err.statusCode = 404;
                err.code = 'CREDENTIAL_NOT_FOUND';
                throw err;
            }

            const credRow = credRes.rows[0];
            const cosePublicKey = pemToCose(credRow.public_key || credRow.publicKey);
            const storedCounter = Number(credRow.counter || 0);

            // 4. Cryptographic Signature Verification via @simplewebauthn/server
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
            } catch (verifyErr) {
                const msg = (verifyErr.message || '').toLowerCase();
                if (msg.includes('counter') || msg.includes('lower than expected')) {
                    const err = new Error(
                        'WebAuthn authenticator counter regression (possible cloned token)'
                    );
                    err.statusCode = 403;
                    err.code = 'COUNTER_REGRESSION';
                    throw err;
                }
                if (
                    msg.includes('user verification') ||
                    msg.includes('user could not be verified')
                ) {
                    const err = new Error(
                        'User verification (UV) flag required but not satisfied in assertion'
                    );
                    err.statusCode = 403;
                    err.code = 'USER_VERIFICATION_REQUIRED';
                    throw err;
                }
                if (msg.includes('user not present') || msg.includes('user presence')) {
                    const err = new Error('User presence (UP) flag not set in authenticatorData');
                    err.statusCode = 400;
                    err.code = 'USER_PRESENCE_REQUIRED';
                    throw err;
                }
                if (msg.includes('rp id') || msg.includes('rpid')) {
                    const err = new Error(
                        `rpIdHash mismatch: assertion not bound to rpId "${this.rpId}"`
                    );
                    err.statusCode = 400;
                    err.code = 'RPID_MISMATCH';
                    throw err;
                }
                const err = new Error(
                    `WebAuthn assertion verification failed: ${verifyErr.message}`
                );
                err.statusCode = 401;
                err.code = 'VERIFICATION_FAILED';
                throw err;
            }

            if (!verification.verified) {
                const err = new Error(
                    'WebAuthn cryptographic assertion signature verification failed'
                );
                err.statusCode = 401;
                err.code = 'INVALID_SIGNATURE';
                throw err;
            }

            const newCounter = verification.authenticationInfo.newCounter;
            const signatureHash = crypto.createHash('sha256').update(sigStr).digest('hex');

            // 5. Update credential counter and challenge consumption
            await dbClient.query(
                `UPDATE identity.webauthn_credentials
                 SET counter = $1, last_used_at = NOW()
                 WHERE credential_id = $2`,
                [newCounter, credentialId]
            );

            await dbClient.query(
                `UPDATE identity.webauthn_challenges
                 SET consumed_at = NOW()
                 WHERE challenge_id = $1`,
                [challengeRow.challenge_id]
            );

            // 6. Record verified assertion evidence using isolated verifier role
            const recordRes = await dbClient.query(
                `SELECT identity.fn_record_verified_webauthn_assertion($1, $2, $3, $4, $5) AS assertion_id`,
                [
                    challengeRow.challenge_id,
                    operatorId,
                    credentialId,
                    signatureHash,
                    canonicalDigest,
                ]
            );

            const assertionId = recordRes.rows[0].assertion_id;

            await dbClient.query('COMMIT');

            logger.info(
                `[WEBAUTHN-VERIFIER] ✅ Successfully verified and recorded WebAuthn assertion ${assertionId} for operator ${operatorId}`
            );

            return {
                verified: true,
                challengeId: challengeRow.challenge_id,
                assertionId,
                signatureHash,
                contextDigest: canonicalDigest,
            };
        } catch (dbErr) {
            await dbClient.query('ROLLBACK');
            throw dbErr;
        } finally {
            if (shouldReleaseClient) {
                dbClient.release();
            }
        }
    }

    /**
     * Closes the verifier database pool cleanly upon service termination.
     */
    async close() {
        if (this._ownsPool && this.verifierPool) {
            await this.verifierPool.end();
            this.verifierPool = null;
        }
    }
}

module.exports = {
    WebAuthnVerifierService,
};
