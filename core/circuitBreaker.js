/**
 * Circuit Breaker Pattern for Adapter Health Management
 * =====================================================
 * States:
 *   CLOSED    - Normal operation. All requests flow through.
 *   OPEN      - Adapter is failing. Requests are immediately rejected.
 *   HALF_OPEN - Testing recovery. A single probe request is allowed.
 *
 * This prevents cascading failures when an external payment rail (Stripe, RazorpayX) is down.
 */

const logger = require('../logger');

const DEFAULTS = {
    FAILURE_THRESHOLD: 5, // Consecutive failures before tripping OPEN
    SUCCESS_THRESHOLD: 2, // Consecutive successes in HALF_OPEN before closing
    TIMEOUT_MS: 30_000, // How long to wait in OPEN before trying HALF_OPEN (30 seconds)
};

class CircuitBreaker {
    constructor(name, options = {}) {
        this.name = name;
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = null;
        this.failureThreshold = options.failureThreshold ?? DEFAULTS.FAILURE_THRESHOLD;
        this.successThreshold = options.successThreshold ?? DEFAULTS.SUCCESS_THRESHOLD;
        this.timeoutMs = options.timeoutMs ?? DEFAULTS.TIMEOUT_MS;
    }

    /** Call this when a request succeeds */
    onSuccess() {
        this.failureCount = 0;
        if (this.state === 'HALF_OPEN') {
            this.successCount++;
            if (this.successCount >= this.successThreshold) {
                this.state = 'CLOSED';
                this.successCount = 0;
                logger.info(
                    `[CIRCUIT_BREAKER] ✅ [${this.name}] Circuit CLOSED — Adapter recovered.`
                );
            }
        }
    }

    /** Call this when a request fails */
    onFailure() {
        this.failureCount++;
        this.lastFailureTime = Date.now();
        this.successCount = 0;

        if (this.state === 'HALF_OPEN' || this.failureCount >= this.failureThreshold) {
            this.state = 'OPEN';
            logger.error(
                `[CIRCUIT_BREAKER] ❌ [${this.name}] Circuit OPENED — Adapter is unhealthy. ` +
                    `Will retry in ${this.timeoutMs / 1000}s.`
            );
        }
    }

    /** Returns true if the request should be allowed through */
    allowRequest() {
        if (this.state === 'CLOSED') return true;

        if (this.state === 'OPEN') {
            const elapsed = Date.now() - this.lastFailureTime;
            if (elapsed >= this.timeoutMs) {
                this.state = 'HALF_OPEN';
                logger.warn(
                    `[CIRCUIT_BREAKER] 🔁 [${this.name}] Circuit HALF_OPEN — Probing recovery.`
                );
                return true; // Allow one probe request
            }
            return false; // Still open
        }

        // HALF_OPEN: Allow one request at a time
        return true;
    }

    getState() {
        return this.state;
    }
}

// Singleton registry of circuit breakers per adapter
const breakers = new Map();

/**
 * Get or create a circuit breaker for a named adapter
 * @param {string} adapterName - e.g. 'ADAPTER_STRIPE', 'ADAPTER_RAZORPAY'
 * @returns {CircuitBreaker}
 */
function getBreaker(adapterName) {
    if (!breakers.has(adapterName)) {
        breakers.set(adapterName, new CircuitBreaker(adapterName));
    }
    return breakers.get(adapterName);
}

/**
 * Get a snapshot of all circuit breaker states for the health dashboard
 * @returns {Object}
 */
function getAllBreakerStates() {
    const result = {};
    for (const [name, breaker] of breakers.entries()) {
        result[name] = {
            state: breaker.state,
            failureCount: breaker.failureCount,
            lastFailureTime: breaker.lastFailureTime,
        };
    }
    return result;
}

module.exports = { getBreaker, getAllBreakerStates };
