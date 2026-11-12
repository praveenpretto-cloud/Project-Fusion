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
    DIGITAL_ASSET: 'ADAPTER_DIGITAL_ASSET_CUSTODIAN',
};

const CURRENCIES = {
    FIAT: ['USD', 'SGD', 'EUR', 'GBP', 'INR'],
    DIGITAL_ASSET: ['XLM', 'BTC', 'ETH', 'USDC'],
    ALL: ['USD', 'SGD', 'EUR', 'GBP', 'INR', 'XLM', 'BTC', 'ETH', 'USDC'],
};

const ASSET_PRECISION = {
    // Verified sandbox / testnet rails
    XLM: 7,
    USD: 2,
    EUR: 2,
    GBP: 2,
    INR: 2,
    CAD: 2,
    SGD: 2,

    // Policy consistency for simulated digital assets (strictly no execution privileges)
    BTC: 8,
    ETH: 18,
    USDC: 6,
    CNY: 2,
};

const ASSET_MIN_AMOUNT = {
    ETH: '0.000000000000000001',
    BTC: '0.00000001',
    XLM: '0.0000001',
    USDC: '0.000001',
    USD: '0.01',
    EUR: '0.01',
    GBP: '0.01',
    INR: '0.01',
    CAD: '0.01',
    SGD: '0.01',
    CNY: '0.01',
};

const LIMITS = {
    MAX_TRANSACTION_AMOUNT: 1000000, // $1M per transaction
    MIN_TRANSACTION_AMOUNT: 0.01,
    MAX_DECIMAL_PLACES: 2,
    RECONCILER_STUCK_THRESHOLD_MS: 30000, // 30 seconds
    RATE_LIMIT_WINDOW_MS: 60000, // 1 minute
    RATE_LIMIT_MAX_REQUESTS: 60000, // 1000 TPS
};

module.exports = {
    TRANSACTION_STATES,
    ADAPTER_TYPES,
    CURRENCIES,
    ASSET_PRECISION,
    ASSET_MIN_AMOUNT,
    LIMITS,
};
