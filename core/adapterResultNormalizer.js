'use strict';

const logger = require('../logger');

/**
 * Recognized financial and simulation statuses across all Project Fusion adapters.
 */
const KNOWN_STATUSES = Object.freeze([
    'SUCCESS',
    'FAILED',
    'SIMULATED',
    'PENDING',
    'PENDING_SETTLEMENT',
    'PROCESSING',
    'UNKNOWN',
    'REFUNDED',
    'REVERSED',
    'SIMULATED_REVERSED',
    'MOCK_REVERSED',
]);

// Bank rail policy identifiers (module-private immutable list)
const NORMALIZER_BANK_RAILS = Object.freeze([
    'SWIFT',
    'ISO20022',
    'ISO 20022',
    'ISO_20022',
    'NEFT',
    'RTGS',
    'IMPS',
    'ACH',
    'FEDWIRE',
    'FED_WIRE',
    'FED WIRE',
    'CHAPS',
    'SEPA',
    'FASTER_PAYMENTS',
    'FASTER PAYMENTS',
    'FASTERPAYMENTS',
    'WIRE',
    'NIUM',
    'NIUM_SWIFT',
    'NIUM SWIFT',
    'NIUMSWIFT',
    'BANK_TRANSFER',
    'BANK TRANSFER',
    'BANKTRANSFER',
]);

// Module-private WeakMap tracking genuine server-owned adapter modules
const SERVER_OWNED_INSTANCES = new WeakMap();

try {
    const cryptoAdapters = require('../adapters/cryptoAdapters');
    const razorpayAdapter = require('../adapters/razorpayAdapter');
    const paymentsAdapters = require('../adapters/paymentsAdapters');
    SERVER_OWNED_INSTANCES.set(cryptoAdapters, { id: 'core_stellar', asset: 'XLM', mode: 'TESTNET', provider: 'STELLAR_TESTNET' });
    SERVER_OWNED_INSTANCES.set(razorpayAdapter, { id: 'core_razorpay', asset: 'INR', mode: 'SANDBOX', provider: 'RAZORPAYX_SANDBOX' });
    SERVER_OWNED_INSTANCES.set(paymentsAdapters, { id: 'core_stripe', assets: ['USD', 'EUR', 'GBP', 'CAD'], mode: 'TEST_MODE', provider: 'STRIPE_TESTNET' });
} catch {
    // Graceful fallback during isolated bootstrapping
}

/**
 * Checks whether a value represents a meaningful, non-empty error indicator.
 */
function hasMeaningfulError(val) {
    if (val === null || val === undefined) return false;
    if (typeof val === 'string') return val.trim().length > 0;
    if (val instanceof Error) return Boolean(val.message && val.message.trim().length > 0);
    if (Array.isArray(val)) return val.length > 0;
    if (typeof val === 'object') {
        if (typeof val.message === 'string' && val.message.trim().length > 0) return true;
        if (typeof val.code === 'string' && val.code.trim().length > 0) return true;
        return Object.keys(val).length > 0;
    }
    return Boolean(val);
}

/**
 * Checks whether an errors property represents a meaningful, non-empty failure.
 * Explicitly recognizes that an empty array [] is NOT an error.
 */
function hasMeaningfulErrors(val) {
    if (val === null || val === undefined) return false;
    if (Array.isArray(val)) return val.length > 0; // Empty array [] is NOT an error
    if (typeof val === 'string') return val.trim().length > 0;
    if (val instanceof Error) return Boolean(val.message && val.message.trim().length > 0);
    if (typeof val === 'object') {
        return Object.keys(val).length > 0;
    }
    return Boolean(val);
}

/**
 * Identifies whether an adapter is a mock or simulation adapter using trusted metadata.
 * Does NOT rely on transaction payload alone.
 */
function isMockAdapter(adp) {
    if (!adp || typeof adp !== 'object') return false;
    if (adp.is_mock === true) return true;
    if (adp.id === 'plugin_alipay_mock') return true;
    if (typeof adp.id === 'string' && (adp.id.startsWith('adapter_mock_') || adp.id.startsWith('mock_plugin_') || adp.id.startsWith('simulated_'))) return true;
    if (adp.simulated === true) return true;
    return false;
}

/**
 * Narrowly scoped server-owned trust resolver binding together:
 * - Exact provider identifier
 * - Supported currency / asset
 * - Actual execution mode
 * - Route classification
 *
 * Rules:
 * 1. Mock adapters (is_mock, adapter_mock_*, plugin_alipay_mock, simulated) are NEVER trusted for financial SUCCESS.
 * 2. Adapter-supplied properties like 'is_verified_sandbox' or 'is_sandbox' are completely ignored (preventing self-assertion).
 * 3. Injected adapters (options.isInjectedOverride: true) are untrusted by default, unless carrying the unforgeable SERVER_TRUST_SYMBOL.
 * 4. Stellar Testnet trust is strictly eligible ONLY for native XLM on Stellar Testnet.
 * 5. RazorpayX sandbox trust is strictly eligible ONLY for domestic INR on RazorpayX sandbox.
 * 6. Stripe test mode trust is strictly eligible ONLY for supported fiat (USD, EUR, GBP, CAD) via Stripe card/payment intents,
 *    and explicitly rejects claims of bank-rail / SWIFT / ISO 20022 / Nium execution.
 * 7. Any other provider, asset, or route is untrusted by default.
 */
function resolveServerTrust(adapter, inst, options = {}) {
    if (!adapter || typeof adapter !== 'object') {
        return { isTrusted: false, reason: 'Missing adapter metadata' };
    }

    // 1. Mock adapters are unconditionally untrusted for real financial settlement
    if (isMockAdapter(adapter)) {
        return { isTrusted: false, isMock: true, reason: 'Adapter is a designated simulation mock' };
    }

    const currency = (inst && inst.currency) ? String(inst.currency).toUpperCase() : null;
    const purpose = (inst && inst.purpose) ? String(inst.purpose).toUpperCase() : '';
    const route = (inst && (inst.route_selected || inst._requestedAdapter || inst.rail))
        ? String(inst.route_selected || inst._requestedAdapter || inst.rail).toUpperCase()
        : '';
    const paymentMethod = (inst && inst.payment_method) ? String(inst.payment_method).toUpperCase() : '';

    // Check if this execution is an injected override
    const isInjectedOverride = Boolean(options.isInjectedOverride);

    if (isInjectedOverride) {
        // SPRINT 2.2.4.2.8: Injected adapter overrides are unconditionally untrusted and disallowed
        return {
            isTrusted: false,
            reason: 'Injected adapter overrides are untrusted and disallowed in execution architecture',
        };
    }

    const providerId = adapter.id;

    // SPRINT 2.2.4.2.9: Verify execution integrity against server-owned provider implementations
    const { verifyProviderIntegrity } = require('./orchestrator/providerDispatcher');
    const integrityCheck = verifyProviderIntegrity(adapter);
    if (!integrityCheck.isIntact) {
        if (
            [
                'core_stellar',
                'core_razorpay',
                'core_stripe',
                'sandbox_stellar',
                'sandbox_razorpay',
                'sandbox_stripe',
            ].includes(providerId)
        ) {
            return {
                isTrusted: false,
                reason: `Execution integrity check failed: ${integrityCheck.reason}`,
            };
        }
    }

    // Policy Rule 1: Stellar Testnet — ONLY native XLM is trusted
    if (providerId === 'core_stellar' || providerId === 'sandbox_stellar' || providerId === 'legacy_crypto') {
        if (currency === 'XLM') {
            return { isTrusted: true, provider: 'STELLAR_TESTNET', asset: 'XLM' };
        }
        return {
            isTrusted: false,
            reason: `Stellar Testnet adapter is not authorized for asset '${currency}'. Only native XLM is verified on Stellar Testnet.`,
        };
    }

    // Policy Rule 2: RazorpayX Sandbox — ONLY domestic INR is trusted
    if (providerId === 'core_razorpay' || providerId === 'sandbox_razorpay') {
        if (currency === 'INR') {
            return { isTrusted: true, provider: 'RAZORPAYX_SANDBOX', asset: 'INR' };
        }
        return {
            isTrusted: false,
            reason: `RazorpayX adapter is not authorized for currency '${currency}'. Only domestic INR is verified on RazorpayX.`,
        };
    }

    // Policy Rule 3: Stripe Test Mode — ONLY supported fiat currencies, NOT bank rails / SWIFT / ISO20022 / Nium
    if (providerId === 'core_stripe' || providerId === 'sandbox_stripe' || providerId === 'legacy_fiat') {
        const isSupportedFiat = ['USD', 'EUR', 'GBP', 'CAD'].includes(currency);
        const candidates = [purpose, route, paymentMethod].filter(Boolean);
        const isBankRailClaim = candidates.some((str) => {
            const rawUpper = str.toUpperCase();
            const underscore = rawUpper.replace(/[\s-]+/g, '_');
            const compact = rawUpper.replace(/[^A-Z0-9]/g, '');

            return NORMALIZER_BANK_RAILS.some((r) => {
                const rUnderscore = r.replace(/[\s-]+/g, '_');
                const rCompact = r.replace(/[^A-Z0-9]/g, '');
                return (
                    rawUpper.includes(r) ||
                    underscore.includes(rUnderscore) ||
                    compact.includes(rCompact)
                );
            });
        });

        if (!isSupportedFiat) {
            return {
                isTrusted: false,
                reason: `Stripe test mode is not authorized for currency '${currency}'. Supported currencies are USD, EUR, GBP, CAD.`,
            };
        }

        if (isBankRailClaim) {
            return {
                isTrusted: false,
                reason: `Stripe test-card simulation cannot authorize bank-rail / SWIFT / ISO 20022 / Nium execution.`,
            };
        }

        return { isTrusted: true, provider: 'STRIPE_TESTNET', asset: currency };
    }

    // All other providers/rails are untrusted by default
    return {
        isTrusted: false,
        reason: `Provider '${providerId}' has no verified testnet or sandbox authorization for asset '${currency}'.`,
    };
}

/**
 * Helper function checking whether an adapter is a verified sandbox adapter.
 * Uses the server-controlled trust resolver.
 */
function isVerifiedSandboxAdapter(adp, inst = null, options = {}) {
    return resolveServerTrust(adp, inst, options).isTrusted;
}

/**
 * Pure shared normalizer for adapter execution results.
 * Used identically across AdapterRegistry (batch orchestration) and sagaCore (Saga execution).
 *
 * Enforces:
 * 1. Authoritative original instruction ID (conflicting adapter IDs preserved separately)
 * 2. Conservative status preservation (SUCCESS, FAILED, SIMULATED, PENDING, UNKNOWN)
 * 3. Never infer financial success from Promise resolution, boolean true, or unverified objects
 * 4. Contradiction resolution to UNKNOWN (e.g. SUCCESS + error flag, FAILED + success: true)
 * 5. Mock adapter clamping (mock returning SUCCESS clamped to SIMULATED)
 * 6. Server-controlled Saga trust boundary enforcement (untrusted/unverified execution clamped to UNKNOWN)
 *
 * @param {any} res - Raw return value from adapter.execute()
 * @param {object} inst - Authoritative instruction object
 * @param {number} idx - Array index (0 for single instruction)
 * @param {object|null} adapter - Adapter metadata or instance
 * @param {object} options - Normalization options ({ enforceSagaTrust: boolean, isInjectedOverride: boolean })
 * @returns {object} - Normalized result object
 */
function normalizeResult(res, inst, idx = 0, adapter = null, options = {}) {
    const authoritativeInstructionId = (inst && inst.instruction_id)
        ? inst.instruction_id
        : ((inst && inst.id) ? inst.id : `instruction_${idx}`);

    // 1. Null or undefined -> UNKNOWN
    if (res === null || res === undefined) {
        return {
            status: 'UNKNOWN',
            error: 'Adapter returned empty response',
            instruction_id: authoritativeInstructionId,
            input_index: idx,
        };
    }

    // 2. Boolean values: false -> FAILED, true -> UNKNOWN (never infer financial success)
    if (typeof res === 'boolean') {
        return {
            status: res ? 'UNKNOWN' : 'FAILED',
            ...(res ? { note: 'Boolean true does not establish financial settlement' } : { error: 'Adapter returned false' }),
            instruction_id: authoritativeInstructionId,
            input_index: idx,
        };
    }

    // 3. Primitive values (strings, numbers, etc.) -> UNKNOWN
    if (typeof res !== 'object') {
        return {
            status: 'UNKNOWN',
            result: res,
            instruction_id: authoritativeInstructionId,
            input_index: idx,
        };
    }

    // 4. Object return
    const resObj = { ...res };
    const rawStatus = resObj.status;

    // Preserve adapter-provided ID separately if conflicting with authoritative input ID
    const adapterProvidedId = resObj.instruction_id;
    const hasIdMismatch = Boolean(adapterProvidedId && adapterProvidedId !== authoritativeInstructionId);

    // Check for meaningful failure indicators
    const hasFailureSignal = resObj.success === false || hasMeaningfulError(resObj.error) || hasMeaningfulErrors(resObj.errors);
    const hasSuccessSignal = resObj.success === true;

    // Check if status is present and is a non-empty string
    if (typeof rawStatus === 'string' && rawStatus.trim() !== '') {
        const upperStatus = rawStatus.trim().toUpperCase();

        if (KNOWN_STATUSES.includes(upperStatus)) {
            // Check for contradictions:
            const isPositiveStatus = ['SUCCESS', 'PENDING', 'PENDING_SETTLEMENT', 'PROCESSING'].includes(upperStatus);
            const isContradictory = (isPositiveStatus && hasFailureSignal) || (upperStatus === 'FAILED' && hasSuccessSignal);

            if (isContradictory) {
                return {
                    ...resObj,
                    status: 'UNKNOWN',
                    contradiction_detected: true,
                    contradiction_reason: `Adapter returned status '${rawStatus}' with conflicting success/error flags`,
                    instruction_id: authoritativeInstructionId,
                    ...(hasIdMismatch ? { adapter_instruction_id: adapterProvidedId } : {}),
                    input_index: idx,
                    raw_status: rawStatus,
                };
            }

            let normalizedStatus = upperStatus;

            // Standardize in-flight aliases to PENDING while preserving raw status
            if (upperStatus === 'PROCESSING') {
                normalizedStatus = 'PENDING';
            }

            // Standardize legacy mock rollback aliases to SIMULATED_REVERSED
            if (upperStatus === 'MOCK_REVERSED') {
                normalizedStatus = 'SIMULATED_REVERSED';
            }

            // Enforce simulation isolation: Mock adapters can never report real payment SUCCESS
            if (isMockAdapter(adapter) && normalizedStatus === 'SUCCESS') {
                logger.warn(
                    `[NORMALIZER-SECURITY] Blocked mock adapter ${adapter?.id || 'unidentified_mock'} from reporting financial SUCCESS. Enforced SIMULATED.`
                );
                normalizedStatus = 'SIMULATED';
            }

            // Enforce Saga Trust Boundary: Server-controlled trust resolution
            if (options.enforceSagaTrust === true && normalizedStatus === 'SUCCESS') {
                const trustResolution = resolveServerTrust(adapter, inst, options);
                if (!trustResolution.isTrusted) {
                    logger.warn(
                        `[NORMALIZER-SECURITY] Blocked untrusted execution for ${authoritativeInstructionId} (${adapter?.id || 'unidentified'} / ${inst?.currency || 'unknown'}). Enforced UNKNOWN: ${trustResolution.reason}`
                    );
                    return {
                        ...resObj,
                        status: 'UNKNOWN',
                        untrusted_execution: true,
                        trust_resolution_reason: trustResolution.reason,
                        error: `Untrusted execution: ${trustResolution.reason}`,
                        instruction_id: authoritativeInstructionId,
                        ...(hasIdMismatch ? { adapter_instruction_id: adapterProvidedId } : {}),
                        input_index: idx,
                        raw_status: rawStatus,
                    };
                }
            }

            return {
                ...resObj,
                status: normalizedStatus,
                instruction_id: authoritativeInstructionId,
                ...(hasIdMismatch ? { adapter_instruction_id: adapterProvidedId } : {}),
                input_index: idx,
                ...(normalizedStatus !== rawStatus ? { raw_status: rawStatus } : {}),
            };
        } else {
            // Unrecognized status string -> UNKNOWN, preserving raw_status for audit
            return {
                ...resObj,
                status: 'UNKNOWN',
                raw_status: rawStatus,
                instruction_id: authoritativeInstructionId,
                ...(hasIdMismatch ? { adapter_instruction_id: adapterProvidedId } : {}),
                input_index: idx,
            };
        }
    }

    // 5. No explicit status string present on object
    // If failure indicators exist, classify as FAILED
    if (hasFailureSignal) {
        const errMsg = resObj.error instanceof Error
            ? resObj.error.message
            : (typeof resObj.error === 'string' ? resObj.error : (resObj.errors ? JSON.stringify(resObj.errors) : 'Adapter indicated execution failure'));
        return {
            ...resObj,
            status: 'FAILED',
            error: errMsg,
            instruction_id: authoritativeInstructionId,
            ...(hasIdMismatch ? { adapter_instruction_id: adapterProvidedId } : {}),
            input_index: idx,
        };
    }

    // 6. Object has success: true or unclassified properties -> UNKNOWN (never infer SUCCESS)
    return {
        ...resObj,
        status: 'UNKNOWN',
        instruction_id: authoritativeInstructionId,
        ...(hasIdMismatch ? { adapter_instruction_id: adapterProvidedId } : {}),
        input_index: idx,
        ...(resObj.success === true ? { note: 'success:true without explicit status is unverified' } : {}),
    };
}

/**
 * Normalizes caught errors into a standard FAILED result object.
 */
function normalizeError(err, inst, idx = 0, defaultMessage = 'Adapter execution failed') {
    const authoritativeInstructionId = (inst && inst.instruction_id)
        ? inst.instruction_id
        : ((inst && inst.id) ? inst.id : `instruction_${idx}`);
    const errorMessage = err?.message || (typeof err === 'string' ? err : defaultMessage);
    const errorObj = {
        status: 'FAILED',
        error: errorMessage,
        instruction_id: authoritativeInstructionId,
        input_index: idx,
    };
    if (err && typeof err === 'object') {
        if (err.code) errorObj.error_code = err.code;
        if (err.details) errorObj.error_details = err.details;
    }
    return errorObj;
}

module.exports = {
    normalizeResult,
    normalizeError,
    isMockAdapter,
    isVerifiedSandboxAdapter,
    resolveServerTrust,
    hasMeaningfulError,
    hasMeaningfulErrors,
    KNOWN_STATUSES,
};
