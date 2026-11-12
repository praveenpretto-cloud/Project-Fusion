'use strict';

/**
 * Base Model Provider Interface
 * 
 * Defines standard outcome statuses and the contract required for all AI model providers.
 * Providers must be strictly process-isolated with zero database and payment-system dependencies.
 */

const PROVIDER_STATUSES = Object.freeze({
    SUCCESS: 'SUCCESS',
    AI_UNAVAILABLE: 'AI_UNAVAILABLE',
    MODEL_TIMEOUT: 'MODEL_TIMEOUT',
    MODEL_OUTPUT_INVALID: 'MODEL_OUTPUT_INVALID',
    MODEL_RESPONSE_EMPTY: 'MODEL_RESPONSE_EMPTY',
    MODEL_PROVIDER_ERROR: 'MODEL_PROVIDER_ERROR'
});

class BaseModelProvider {
    /**
     * @param {string} providerName 
     */
    constructor(providerName = 'base') {
        this.providerName = providerName;
    }

    /**
     * Generate structured completion from prompt context.
     * 
     * @param {object} params
     * @param {string} params.model - Model identifier
     * @param {string} params.systemInstruction - Trusted system instruction
     * @param {object|string} params.evidenceContext - Sanitized evidence dataset
     * @param {string} params.investigationQuestion - Operator question
     * @param {object} [params.generationConfig] - Generation options (temp, tokens, etc.)
     * @param {number} [params.timeoutMs=15000] - Request timeout in milliseconds
     * @returns {Promise<ProviderResult>}
     */
    async generate({
        model,
        systemInstruction,
        evidenceContext,
        investigationQuestion,
        generationConfig = {},
        timeoutMs = 15000
    }) {
        throw new Error('BaseModelProvider.generate() must be implemented by subclass');
    }

    /**
     * Multi-turn chat completion with tool calling support.
     * 
     * @param {object} params
     * @param {string} [params.model] - Model identifier
     * @param {Array<object>} params.messages - Multi-turn conversation messages
     * @param {Array<object>} [params.tools] - Approved tool calling definitions
     * @param {string|object} [params.format] - Optional format constraint (e.g. 'json')
     * @param {object} [params.generationConfig] - Options
     * @param {number} [params.timeoutMs=30000] - Request timeout
     * @returns {Promise<object>}
     */
    async chat({
        model,
        messages,
        tools = [],
        format = undefined,
        generationConfig = {},
        timeoutMs = 30000
    }) {
        throw new Error('BaseModelProvider.chat() must be implemented by subclass');
    }

    /**
     * Healthcheck to verify provider availability.
     * @returns {Promise<{ available: boolean, status: string, latencyMs: number }>}
     */
    async ping() {
        throw new Error('BaseModelProvider.ping() must be implemented by subclass');
    }

    /**
     * Helper to return boolean availability.
     * @returns {Promise<boolean>}
     */
    async isAvailable() {
        try {
            const res = await this.ping();
            return Boolean(res && res.available);
        } catch {
            return false;
        }
    }
}

module.exports = {
    BaseModelProvider,
    PROVIDER_STATUSES,
};
