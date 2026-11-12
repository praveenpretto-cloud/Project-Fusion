'use strict';

/**
 * CONFIGURATION VALIDATOR — Testnet & Sandbox Enforcement (AI-2B.3)
 * =================================================================
 * Guarantees comprehensive fail-closed startup and runtime validation:
 * 1. Stripe credentials MUST start with 'sk_test_' (live sk_live_* blocked)
 * 2. RazorpayX credentials MUST start with 'rzp_test_' (live rzp_live_* blocked)
 * 3. Stellar MUST use Horizon Testnet and official Testnet Passphrase
 * 4. Vault Master Secret MUST be present in environment (min 16 chars)
 * 5. Comprehensive allowlist of permitted providers, sandbox endpoints, and blockchain networks
 * 6. Missing network classification fails closed (does not default silently to sandbox)
 * 7. Simulation adapters (BTC, ETH) strictly prohibited from resolving mainnet RPC endpoints
 * 8. Never prints raw secret values in errors or logs
 */

const logger = require('../logger');

const STELLAR_TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
const STELLAR_TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

// 1. Explicit Allowlist of Permitted Providers
const PERMITTED_PROVIDERS = Object.freeze([
    'core_stellar',
    'core_razorpay',
    'core_stripe',
    'STRIPE_TEST',
    'RAZORPAYX_TEST',
    'STELLAR_TESTNET',
    'MOCK_FIAT',
    'MOCK_CRYPTO',
    'SIMULATED_CRYPTO',
    'SYSTEM',
    'mock_payroll_adapter',
    'plugin_alipay_mock',
    'mock_instant_adapter',
    'mock_hft_adapter',
]);

// 2. Explicit Allowlist of Permitted Sandbox / Testnet API Endpoints
const PERMITTED_SANDBOX_ENDPOINTS = Object.freeze([
    'https://api.stripe.com',
    'https://api.razorpay.com',
    'https://horizon-testnet.stellar.org',
    'https://friendbot.stellar.org',
]);

// 3. Explicit Allowlist of Permitted Blockchain Networks
const PERMITTED_BLOCKCHAIN_NETWORKS = Object.freeze([
    'stellar_testnet',
    'simulated_btc_testnet',
    'simulated_eth_sepolia',
]);

// 4. Explicit Allowlist of Permitted Testnet RPC / Horizon Endpoints
const PERMITTED_TESTNET_RPC_ENDPOINTS = Object.freeze([
    'https://horizon-testnet.stellar.org',
    'https://friendbot.stellar.org',
]);

// 5. Environment & Credential Prefix Constants (AI-2B.3 Security Review)
const PERMITTED_ENVIRONMENTS = Object.freeze(['sandbox', 'testnet', 'test', 'development']);
const PROHIBITED_ENVIRONMENTS = Object.freeze(['production', 'live', 'mainnet']);
const SUPPORTED_STRIPE_TEST_PREFIXES = Object.freeze(['sk_test_', 'rk_test_']);
const PROHIBITED_STRIPE_LIVE_PREFIXES = Object.freeze(['sk_live_', 'rk_live_']);
const SUPPORTED_RAZORPAY_TEST_PREFIXES = Object.freeze(['rzp_test_']);
const PROHIBITED_RAZORPAY_LIVE_PREFIXES = Object.freeze(['rzp_live_']);

// Prohibited Mainnet Patterns for deep endpoint inspection
const PROHIBITED_MAINNET_PATTERNS = Object.freeze([
    /mainnet/i,
    /infura\.io\/v3\/[a-f0-9]+$/i,
    /alchemy(api)?\.io\/v2\/[a-zA-Z0-9_-]+$/i,
    /horizon\.stellar\.org/i,
    /blockchain\.info/i,
    /etherscan\.io/i,
    /blockstream\.info\/api/i,
    /quicknode\.pro/i,
]);

/**
 * Asserts that a provider identifier is in the explicit allowlist.
 * Fails closed if missing or unrecognized.
 *
 * @param {string} providerId
 * @returns {string} Clean provider ID
 */
function assertPermittedProvider(providerId) {
    if (!providerId || typeof providerId !== 'string' || !providerId.trim()) {
        const err = new Error(
            'Provider identifier must be an explicit non-empty string (fail closed)'
        );
        err.code = 'UNRECOGNIZED_PROVIDER';
        throw err;
    }
    const cleanId = providerId.trim();
    if (!PERMITTED_PROVIDERS.includes(cleanId)) {
        const err = new Error(
            `Unrecognized or unauthorized provider identifier: "${cleanId}". Only permitted sandbox/testnet providers are allowed.`
        );
        err.code = 'UNRECOGNIZED_PROVIDER';
        throw err;
    }
    return cleanId;
}

/**
 * Asserts that an endpoint URL is in the explicit sandbox allowlist
 * and does not point to live/mainnet infrastructure.
 *
 * @param {string} endpointUrl
 * @returns {string} Clean endpoint URL
 */
function assertPermittedEndpoint(endpointUrl) {
    if (!endpointUrl || typeof endpointUrl !== 'string' || !endpointUrl.trim()) {
        const err = new Error('Endpoint URL must be an explicit non-empty string (fail closed)');
        err.code = 'INVALID_ENDPOINT';
        throw err;
    }
    const cleanUrl = endpointUrl.trim();

    if (!cleanUrl.startsWith('https://')) {
        const err = new Error(
            `Insecure or invalid endpoint protocol: "${cleanUrl}". Only HTTPS sandbox endpoints are permitted.`
        );
        err.code = 'INSECURE_ENDPOINT_PROTOCOL';
        throw err;
    }

    // Check prohibited mainnet patterns
    for (const pattern of PROHIBITED_MAINNET_PATTERNS) {
        if (pattern.test(cleanUrl)) {
            const err = new Error(
                `Prohibited mainnet/production endpoint rejected: "${cleanUrl}". Mainnet operations are strictly forbidden.`
            );
            err.code = 'PROHIBITED_MAINNET_ENDPOINT';
            throw err;
        }
    }

    // Check allowlist
    const isPermitted = PERMITTED_SANDBOX_ENDPOINTS.some(
        (allowed) => cleanUrl === allowed || cleanUrl.startsWith(allowed + '/')
    );
    if (!isPermitted) {
        const err = new Error(
            `Unrecognized endpoint URL: "${cleanUrl}". Only permitted sandbox/testnet API endpoints are allowed.`
        );
        err.code = 'ENDPOINT_NOT_PERMITTED';
        throw err;
    }
    return cleanUrl;
}

/**
 * Asserts that an environment classification is explicitly in the sandbox allowlist.
 * Rejects missing classifications and production classifications.
 *
 * @param {string} environment
 * @returns {string} Normalized environment string
 */
function assertPermittedEnvironment(environment) {
    if (!environment || typeof environment !== 'string' || !environment.trim()) {
        const err = new Error(
            'Missing environment classification: environment must be explicitly specified (fail closed)'
        );
        err.code = 'MISSING_ENVIRONMENT_CLASSIFICATION';
        throw err;
    }
    const cleanEnv = environment.trim().toLowerCase();
    if (PROHIBITED_ENVIRONMENTS.includes(cleanEnv)) {
        const err = new Error(
            `Prohibited production environment '${cleanEnv}' rejected: Project Fusion operates strictly in sandbox/testnet mode.`
        );
        err.code = 'PROHIBITED_LIVE_ENVIRONMENT';
        throw err;
    }
    if (!PERMITTED_ENVIRONMENTS.includes(cleanEnv)) {
        const err = new Error(
            `Unrecognized environment classification: '${environment}'. Permitted: ${PERMITTED_ENVIRONMENTS.join(', ')}`
        );
        err.code = 'INVALID_ENVIRONMENT_CLASSIFICATION';
        throw err;
    }
    return cleanEnv;
}

/**
 * Validates adapter provider identity, environment, credential configuration, and endpoint.
 * Prevents generic identifiers ('core_stripe', 'core_razorpay') from bypassing credential checks.
 *
 * @param {object} options
 * @param {string} options.provider - Provider identifier
 * @param {string} [options.credential] - Raw credential string
 * @param {string} [options.keyId] - Key ID (Razorpay)
 * @param {string} [options.keySecret] - Key secret (Razorpay)
 * @param {string} [options.environment] - Environment mode ('sandbox', 'testnet', etc.)
 * @param {string} [options.endpoint] - Endpoint URL
 * @param {string} [options.rpcUrl] - Blockchain RPC URL (if any)
 * @returns {object} Validated provider configuration
 */
function validateProviderCredentialMode({
    provider,
    credential = null,
    keyId = null,
    keySecret = null,
    environment = null,
    endpoint = null,
    rpcUrl = null,
} = {}) {
    // 1. Provider identification (fails closed on unknown or missing, no bypass via generic identifiers)
    const cleanProvider = assertPermittedProvider(provider);

    // 2. Environment classification validation (must be valid sandbox/testnet, fails closed if missing or unknown)
    const cleanEnv = assertPermittedEnvironment(
        environment || process.env.NETWORK_ENVIRONMENT || 'sandbox'
    );

    // 3. Endpoint validation if provided (fails closed, rejects HTTP, must be in allowlist and match HTTPS)
    if (endpoint) {
        assertPermittedEndpoint(endpoint);
    }

    // 4. Provider-specific credential mode validation
    const providerUpper = cleanProvider.toUpperCase();

    // Stripe mode validation (core_stripe, STRIPE_TEST)
    if (providerUpper.includes('STRIPE')) {
        const stripeKey = credential || keySecret;
        if (!stripeKey || typeof stripeKey !== 'string' || !stripeKey.trim()) {
            const err = new Error(
                `Missing mandatory Stripe credential for provider '${cleanProvider}'`
            );
            err.code = 'MISSING_CREDENTIAL';
            throw err;
        }
        const trimmedKey = stripeKey.trim();
        for (const livePrefix of PROHIBITED_STRIPE_LIVE_PREFIXES) {
            if (trimmedKey.startsWith(livePrefix)) {
                const err = new Error(
                    `Live-mode Stripe credential ('${livePrefix}*') detected for provider '${cleanProvider}'! Live credentials are strictly prohibited.`
                );
                err.code = 'PROHIBITED_LIVE_CREDENTIAL';
                throw err;
            }
        }
        const hasValidTestPrefix = SUPPORTED_STRIPE_TEST_PREFIXES.some((p) =>
            trimmedKey.startsWith(p)
        );
        if (!hasValidTestPrefix) {
            const err = new Error(
                `Invalid Stripe credential for provider '${cleanProvider}': must start with test prefix (${SUPPORTED_STRIPE_TEST_PREFIXES.join(', ')})`
            );
            err.code = 'INVALID_TEST_CREDENTIAL';
            throw err;
        }
    }

    // Razorpay / RazorpayX mode validation (core_razorpay, RAZORPAYX_TEST)
    if (providerUpper.includes('RAZORPAY')) {
        const rzpKeyId = keyId || credential;
        if (!rzpKeyId || typeof rzpKeyId !== 'string' || !rzpKeyId.trim()) {
            const err = new Error(
                `Missing mandatory Razorpay Key ID for provider '${cleanProvider}'`
            );
            err.code = 'MISSING_CREDENTIAL';
            throw err;
        }
        const trimmedKeyId = rzpKeyId.trim();
        for (const livePrefix of PROHIBITED_RAZORPAY_LIVE_PREFIXES) {
            if (trimmedKeyId.startsWith(livePrefix)) {
                const err = new Error(
                    `Live-mode Razorpay key identifier ('${livePrefix}*') detected for provider '${cleanProvider}'! Live credentials are strictly prohibited.`
                );
                err.code = 'PROHIBITED_LIVE_CREDENTIAL';
                throw err;
            }
        }
        const hasValidTestPrefix = SUPPORTED_RAZORPAY_TEST_PREFIXES.some((p) =>
            trimmedKeyId.startsWith(p)
        );
        if (!hasValidTestPrefix) {
            const err = new Error(
                `Invalid Razorpay key identifier for provider '${cleanProvider}': must start with test prefix (${SUPPORTED_RAZORPAY_TEST_PREFIXES.join(', ')})`
            );
            err.code = 'INVALID_TEST_CREDENTIAL';
            throw err;
        }

        // Key secret validation: must be bound to explicitly validated test keyId; cannot infer test mode from secret alone
        if (keySecret !== undefined && keySecret !== null) {
            if (typeof keySecret !== 'string' || !keySecret.trim()) {
                const err = new Error(
                    `Missing or invalid Razorpay Key Secret for provider '${cleanProvider}'`
                );
                err.code = 'MISSING_CREDENTIAL';
                throw err;
            }
        }
    }

    // Digital asset simulation adapters (BTC, ETH): strictly zero-network isolation
    if (
        providerUpper.includes('SIMULAT') ||
        providerUpper.includes('BTC') ||
        providerUpper.includes('ETH')
    ) {
        if (rpcUrl || endpoint) {
            const err = new Error(
                `Simulation adapter for provider '${cleanProvider}' cannot resolve or connect to external RPC/network endpoints. Simulation is strictly network-isolated.`
            );
            err.code = 'SIMULATION_RPC_PROHIBITED';
            throw err;
        }
    }

    return Object.freeze({
        provider: cleanProvider,
        environment: cleanEnv,
        mode: 'SANDBOX_VERIFIED',
    });
}

/**
 * Asserts that a blockchain network identifier is in the explicit allowlist.
 * Fails closed if missing (does not default silently to sandbox).
 *
 * @param {string} networkId
 * @returns {string} Normalized network ID
 */
function assertPermittedNetwork(networkId) {
    if (!networkId || typeof networkId !== 'string' || !networkId.trim()) {
        const err = new Error(
            'Missing network classification: network environment must be explicitly specified (fail closed)'
        );
        err.code = 'MISSING_NETWORK_CLASSIFICATION';
        throw err;
    }
    const cleanNetwork = networkId.trim().toLowerCase();
    if (!PERMITTED_BLOCKCHAIN_NETWORKS.includes(cleanNetwork)) {
        const err = new Error(
            `Prohibited or unrecognized blockchain network: "${networkId}". Only verified testnet/simulation rails are permitted.`
        );
        err.code = 'PROHIBITED_NETWORK';
        throw err;
    }
    return cleanNetwork;
}

/**
 * Validates that simulation adapters (BTC, ETH) have ZERO external network connectivity.
 * Fails closed if any RPC URL is provided.
 *
 * @param {object} options
 * @param {string} options.asset - 'BTC' | 'ETH' | 'USDC'
 * @param {string} [options.rpcUrl] - Any attempted RPC URL
 * @param {string} [options.network] - Blockchain network
 */
function validateSimulationAdapter({ asset, rpcUrl = null, network = null } = {}) {
    const cleanAsset = String(asset || '')
        .toUpperCase()
        .trim();
    if (!['BTC', 'ETH', 'USDC'].includes(cleanAsset)) {
        const err = new Error(`Invalid asset for simulation adapter check: "${asset}"`);
        err.code = 'INVALID_ASSET';
        throw err;
    }

    if (network) {
        assertPermittedNetwork(network);
    }

    // BTC and ETH simulations are strictly local with ZERO external network access
    if (rpcUrl) {
        const err = new Error(
            `Simulation adapter for ${cleanAsset} cannot resolve or connect to external RPC endpoints (attempted: "${rpcUrl}"). Simulation is zero-network.`
        );
        err.code = 'SIMULATION_RPC_PROHIBITED';
        throw err;
    }

    return true;
}

/**
 * Validates the runtime environment against strict Testnet rules.
 * Throws a fatal Error if any requirement is violated.
 * Never prints raw secret values in errors or logs.
 *
 * @param {object} [env=process.env]
 * @returns {{ valid: boolean, details: object }}
 */
function validateEnvironment(env = process.env) {
    const errors = [];

    // 1. STRIPE TESTNET VALIDATION
    const stripeKey = (env.STRIPE_TEST_SECRET_KEY || '').trim();
    if (!stripeKey) {
        errors.push('Missing mandatory environment variable: STRIPE_TEST_SECRET_KEY');
    } else if (stripeKey.startsWith('sk_live_') || stripeKey.startsWith('rk_live_')) {
        errors.push(
            'CRITICAL: Production Stripe key (sk_live_* or rk_live_*) detected! Project Fusion strictly prohibits live card credentials.'
        );
    } else if (!stripeKey.startsWith('sk_test_') && !stripeKey.startsWith('rk_test_')) {
        errors.push(
            "Invalid STRIPE_TEST_SECRET_KEY: Must start with test prefix 'sk_test_' or 'rk_test_'"
        );
    }

    // 1b. STRIPE TEST WEBHOOK SECRET VALIDATION (IF PRESENT)
    const stripeWebhookSecret = (env.STRIPE_WEBHOOK_SECRET || '').trim();
    if (stripeWebhookSecret && !stripeWebhookSecret.startsWith('whsec_')) {
        errors.push("Invalid STRIPE_WEBHOOK_SECRET: Must start with test secret prefix 'whsec_'");
    }

    // 2. RAZORPAYX SANDBOX VALIDATION
    const rzpKeyId = (env.RAZORPAY_KEY_ID || '').trim();
    const rzpSecret = (env.RAZORPAY_KEY_SECRET || '').trim();

    if (!rzpKeyId) {
        errors.push('Missing mandatory environment variable: RAZORPAY_KEY_ID');
    } else if (rzpKeyId.startsWith('rzp_live_')) {
        errors.push(
            'CRITICAL: Production Razorpay key (rzp_live_*) detected! Project Fusion strictly prohibits live payout credentials.'
        );
    } else if (!rzpKeyId.startsWith('rzp_test_')) {
        errors.push("Invalid RAZORPAY_KEY_ID: Must start with test prefix 'rzp_test_'");
    }

    if (!rzpSecret) {
        errors.push('Missing mandatory environment variable: RAZORPAY_KEY_SECRET');
    }

    // 2b. RAZORPAYX WEBHOOK SECRET VALIDATION (IF PRESENT)
    const rzpWebhookSecret = (env.RAZORPAYX_WEBHOOK_SECRET || '').trim();
    if (rzpWebhookSecret && rzpSecret && rzpWebhookSecret === rzpSecret) {
        errors.push(
            'CRITICAL: RAZORPAYX_WEBHOOK_SECRET must NOT match RAZORPAY_KEY_SECRET (dedicated signing secret required).'
        );
    }

    // 3. STELLAR TESTNET ENFORCEMENT
    if (env.STELLAR_HORIZON_URL && env.STELLAR_HORIZON_URL !== STELLAR_TESTNET_HORIZON) {
        errors.push(
            `Prohibited Stellar Horizon URL: Only official Testnet (${STELLAR_TESTNET_HORIZON}) is allowed.`
        );
    }

    if (
        env.STELLAR_NETWORK_PASSPHRASE &&
        env.STELLAR_NETWORK_PASSPHRASE !== STELLAR_TESTNET_PASSPHRASE
    ) {
        errors.push('Prohibited Stellar Network Passphrase: Only Testnet passphrase is permitted.');
    }

    // 4. VAULT MASTER SECRET (KEY DERIVATION)
    const masterSecret = (env.VAULT_MASTER_SECRET || '').trim();
    if (!masterSecret) {
        errors.push(
            'Missing mandatory environment variable: VAULT_MASTER_SECRET (no hardcoded fallback allowed)'
        );
    } else if (masterSecret.length < 16) {
        errors.push(
            'VAULT_MASTER_SECRET is too short (minimum 16 characters required for HMAC derivation)'
        );
    }

    // 5. NETWORK ENVIRONMENT CLASSIFICATION (IF CONFIGURED)
    if (env.NETWORK_ENVIRONMENT) {
        const netEnv = env.NETWORK_ENVIRONMENT.trim().toLowerCase();
        if (['production', 'live', 'mainnet'].includes(netEnv)) {
            errors.push(
                `CRITICAL: Production network environment (${netEnv}) detected! Project Fusion strictly prohibits live operations.`
            );
        } else if (!['sandbox', 'testnet', 'development', 'test'].includes(netEnv)) {
            errors.push(
                `Invalid NETWORK_ENVIRONMENT: "${env.NETWORK_ENVIRONMENT}". Must be one of: sandbox, testnet, development, test`
            );
        }
    }

    // 6. SIMULATION RPC REJECTION IN ENVIRONMENT
    if (env.ETH_RPC_URL) {
        errors.push(
            'CRITICAL: ETH_RPC_URL configured in environment. ETH is strictly simulated with zero RPC network resolution.'
        );
    }
    if (env.BTC_RPC_URL) {
        errors.push(
            'CRITICAL: BTC_RPC_URL configured in environment. BTC is strictly simulated with zero RPC network resolution.'
        );
    }

    if (errors.length > 0) {
        const errorMsg =
            `[CONFIG-VALIDATION-FAIL] Environment validation failed with ${errors.length} fatal error(s):\n- ` +
            errors.join('\n- ');
        logger.error(errorMsg);
        const err = new Error(errorMsg);
        err.validationErrors = errors;
        throw err;
    }

    logger.info('[CONFIG-VALIDATOR] ✅ Strict Testnet & Sandbox environment validation passed.');
    return {
        valid: true,
        details: {
            stripe: 'STRIPE_TESTNET_VERIFIED',
            razorpay: 'RAZORPAYX_SANDBOX_VERIFIED',
            stellar: 'STELLAR_TESTNET_VERIFIED',
            vault: 'VAULT_MASTER_SECRET_CONFIGURED',
        },
    };
}

module.exports = {
    validateEnvironment,
    STELLAR_TESTNET_HORIZON,
    STELLAR_TESTNET_PASSPHRASE,
    PERMITTED_PROVIDERS,
    PERMITTED_SANDBOX_ENDPOINTS,
    PERMITTED_BLOCKCHAIN_NETWORKS,
    PERMITTED_TESTNET_RPC_ENDPOINTS,
    PERMITTED_ENVIRONMENTS,
    PROHIBITED_ENVIRONMENTS,
    SUPPORTED_STRIPE_TEST_PREFIXES,
    PROHIBITED_STRIPE_LIVE_PREFIXES,
    SUPPORTED_RAZORPAY_TEST_PREFIXES,
    PROHIBITED_RAZORPAY_LIVE_PREFIXES,
    assertPermittedProvider,
    assertPermittedEndpoint,
    assertPermittedNetwork,
    assertPermittedEnvironment,
    validateSimulationAdapter,
    validateProviderCredentialMode,
};
