'use strict';

/**
 * PROJECT FUSION — ISOLATED WEBAUTHN VERIFIER SECRET BOUNDARY (AI-2B.6)
 * ======================================================================
 * Manages dedicated database credentials for the isolated WebAuthn
 * verification principal (fusion_webauthn_verifier).
 *
 * ARCHITECTURAL NOTICE:
 * This credential boundary is strictly isolated from the general application
 * connection pool (fusion_app_runtime). The general API process and runtime
 * cannot access or use this credential for financial queries or approvals.
 */

const VERIFIER_DB_SECRETS = Object.freeze({
    user: process.env.WEBAUTHN_VERIFIER_DB_USER || 'fusion_webauthn_verifier',
    password: process.env.WEBAUTHN_VERIFIER_DB_PASSWORD || 'fusion_webauthn_verifier_secret_test',
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'postgres',
});

/**
 * Provides isolated database configuration for the WebAuthn verifier service.
 * @returns {object} Database configuration object for pg.Pool
 */
function getVerifierDbConfig() {
    return {
        user: VERIFIER_DB_SECRETS.user,
        password: VERIFIER_DB_SECRETS.password,
        host: VERIFIER_DB_SECRETS.host,
        port: VERIFIER_DB_SECRETS.port,
        database: VERIFIER_DB_SECRETS.database,
        connectionTimeoutMillis: 5000,
        max: 5,
    };
}

module.exports = {
    getVerifierDbConfig,
};
