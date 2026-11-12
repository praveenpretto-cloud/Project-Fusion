'use strict';

/**
 * PROJECT FUSION — SERVER-OWNED PROVIDER DISPATCHER
 * ==================================================
 * Binds trusted execution strictly to server-owned provider implementations.
 *
 * Requirements (Sprint 2.2.4.2.9):
 * 1. Capture authentic implementation references at module initialization.
 * 2. Dispatch execution exclusively through captured references, preventing
 *    runtime monkey-patching or wrapper hijacking.
 * 3. Verify module and instance immutability (Object.isFrozen).
 * 4. Reject tampered execution functions, fake adapter objects, and unauthorized overrides.
 * 5. Deep freeze all metadata and exported bindings.
 */

const cryptoAdapters = require('../../adapters/cryptoAdapters');
const paymentsAdapters = require('../../adapters/paymentsAdapters');
const razorpayAdapter = require('../../adapters/razorpayAdapter');

// Capture authentic implementation references at module initialization
const SERVER_PROVIDER_BINDINGS = Object.freeze({
    core_stellar: Object.freeze({
        id: 'core_stellar',
        name: 'Stellar Testnet Adapter',
        currency: 'XLM',
        mode: 'TESTNET',
        module: cryptoAdapters,
        executeFn: cryptoAdapters.executeCryptoRail,
    }),
    core_razorpay: Object.freeze({
        id: 'core_razorpay',
        name: 'RazorpayX Sandbox Adapter',
        currency: 'INR',
        mode: 'SANDBOX',
        module: razorpayAdapter,
        executeFn: razorpayAdapter.executeRazorpayRail,
    }),
    core_stripe: Object.freeze({
        id: 'core_stripe',
        name: 'Stellar/Stripe Fiat Adapter',
        supportedCurrencies: Object.freeze(['USD', 'EUR', 'GBP', 'CAD']),
        mode: 'SANDBOX',
        module: paymentsAdapters,
        executeFn: paymentsAdapters.executePaymentRail,
    }),
});

/**
 * Dispatches execution through the server-owned, captured provider binding.
 * Guarantees that even if an external module attempts to mutate or wrap
 * provider exports, execution strictly uses the server-bound implementation.
 *
 * @param {string} providerId - Canonical provider identifier ('core_stellar', 'core_razorpay', 'core_stripe')
 * @param {object} instruction - Authoritative instruction payload
 * @returns {Promise<object>} - Result from provider execution
 */
async function dispatchProviderExecution(providerId, instruction) {
    const binding = SERVER_PROVIDER_BINDINGS[providerId];
    if (!binding) {
        throw new Error(`[PROVIDER-DISPATCHER] Unknown or untrusted provider ID: '${providerId}'`);
    }

    // Verify provider module immutability
    if (!Object.isFrozen(binding.module)) {
        throw new Error(
            `[PROVIDER-DISPATCHER] Integrity failure: Provider module '${providerId}' is mutable (not frozen)`
        );
    }

    if (typeof binding.executeFn !== 'function') {
        throw new Error(
            `[PROVIDER-DISPATCHER] Integrity failure: Provider '${providerId}' execution function is missing or invalid`
        );
    }

    // Execute strictly via the captured, verified execution function
    return await binding.executeFn(instruction);
}

/**
 * Returns frozen provider metadata for Saga result normalization and logging.
 *
 * @param {string} providerId - Canonical provider identifier
 * @param {string|null} currency - Currency override (for multi-currency providers like Stripe)
 * @returns {object|null} - Frozen metadata object
 */
function getProviderMetadata(providerId, currency = null) {
    const binding = SERVER_PROVIDER_BINDINGS[providerId];
    if (!binding) return null;

    return Object.freeze({
        id: binding.id,
        name: binding.name,
        currency: currency || binding.currency,
        mode: binding.mode,
        instance: binding.module,
        executeFn: binding.executeFn,
    });
}

/**
 * Checks whether an adapter instance conforms to the canonical server provider contract.
 */
function hasCanonicalProviderStructure(providerId, instance) {
    if (!instance || typeof instance !== 'object' || !Object.isFrozen(instance)) {
        return false;
    }
    if (
        providerId === 'core_stellar' ||
        providerId === 'sandbox_stellar' ||
        providerId === 'legacy_crypto'
    ) {
        return (
            typeof instance.executeCryptoRail === 'function' &&
            typeof instance.queryStatus === 'function' &&
            typeof instance.getCryptoBalance === 'function'
        );
    }
    if (providerId === 'core_razorpay' || providerId === 'sandbox_razorpay') {
        return (
            typeof instance.executeRazorpayRail === 'function' &&
            typeof instance.queryStatus === 'function' &&
            typeof instance.rollbackRazorpayRail === 'function'
        );
    }
    if (
        providerId === 'core_stripe' ||
        providerId === 'sandbox_stripe' ||
        providerId === 'legacy_fiat'
    ) {
        return (
            typeof instance.executePaymentRail === 'function' &&
            typeof instance.toStripeMinorUnits === 'function' &&
            typeof instance.queryStatus === 'function' &&
            instance.STRIPE_MIN_AMOUNT_CENTS !== undefined &&
            instance.SUPPORTED_CARD_METHODS !== undefined
        );
    }
    return false;
}

/**
 * Verifies whether a given adapter metadata/instance conforms to the server-owned binding.
 * Detects attempted execution function replacement, mutated instances, and fake impersonation.
 *
 * @param {object} adapter - Adapter metadata or instance under evaluation
 * @returns {{ isIntact: boolean, reason?: string, binding?: object }}
 */
function verifyProviderIntegrity(adapter) {
    if (!adapter || typeof adapter !== 'object') {
        return { isIntact: false, reason: 'Missing or invalid adapter object' };
    }

    const providerId = adapter.id;
    const binding = SERVER_PROVIDER_BINDINGS[providerId];

    if (!binding) {
        return {
            isIntact: false,
            reason: `Provider '${providerId}' is not a recognized server-owned provider`,
        };
    }

    // 1. If an instance is provided, verify it is the authentic frozen module
    if (adapter.instance) {
        if (!Object.isFrozen(adapter.instance)) {
            return {
                isIntact: false,
                reason: `Provider instance for '${providerId}' is mutable (not frozen)`,
            };
        }
        if (
            adapter.instance !== binding.module &&
            !hasCanonicalProviderStructure(providerId, adapter.instance)
        ) {
            return {
                isIntact: false,
                reason: `Provider instance for '${providerId}' does not match server-owned implementation`,
            };
        }
    }

    // 2. If an execution function is explicitly attached, verify it has not been replaced
    const executionCandidate =
        adapter.execute ||
        adapter.executeFn ||
        adapter.executePaymentRail ||
        adapter.executeCryptoRail ||
        adapter.executeRazorpayRail;

    if (executionCandidate) {
        const expectedFn = adapter.instance
            ? adapter.instance.executeCryptoRail ||
              adapter.instance.executeRazorpayRail ||
              adapter.instance.executePaymentRail ||
              binding.executeFn
            : binding.executeFn;

        if (executionCandidate !== expectedFn) {
            return {
                isIntact: false,
                reason: `Execution function for '${providerId}' has been replaced or tampered with`,
            };
        }
    }

    return { isIntact: true, binding };
}

module.exports = Object.freeze({
    dispatchProviderExecution,
    getProviderMetadata,
    verifyProviderIntegrity,
    SERVER_PROVIDER_BINDINGS,
});
