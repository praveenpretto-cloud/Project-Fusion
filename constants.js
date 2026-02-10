/**
 * APPLICATION CONSTANTS
 *
 * Centralized constants for state management and configuration.
 * This follows institutional best practices (no magic strings).
 */

const TRANSACTION_STATES = {
    INITIATED: 'INITIATED',
    LOCKED: 'LOCKED',
    PENDING_EXECUTION: 'PENDING_EXECUTION',
    SETTLED: 'SETTLED',
    FAILED: 'FAILED',
    MANUAL_CHECK: 'MANUAL_CHECK',
};

const ADAPTER_TYPES = {
    PAYMENTS: 'ADAPTER_PAYNOW',
    CRYPTO: 'ADAPTER_CRYPTO_CUSTODIAN',
    BROKERAGE: 'ADAPTER_BROKERAGE_SETTLEMENT',
};

const CURRENCIES = {
    FIAT: ['USD', 'SGD', 'EUR', 'GBP'],
    CRYPTO: ['XLM', 'BTC', 'ETH', 'USDC'],
    ALL: ['USD', 'SGD', 'EUR', 'GBP', 'XLM', 'BTC', 'ETH', 'USDC'],
};

const LIMITS = {
    MAX_TRANSACTION_AMOUNT: 1000000, // $1M per transaction
    MIN_TRANSACTION_AMOUNT: 0.01,
    MAX_DECIMAL_PLACES: 2,
    RECONCILER_STUCK_THRESHOLD_MS: 30000, // 30 seconds
    RATE_LIMIT_WINDOW_MS: 60000, // 1 minute
    RATE_LIMIT_MAX_REQUESTS: 40000,
};

module.exports = {
    TRANSACTION_STATES,
    ADAPTER_TYPES,
    CURRENCIES,
    LIMITS,
};
