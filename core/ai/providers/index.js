'use strict';

const { BaseModelProvider, PROVIDER_STATUSES } = require('./baseProvider');
const { OllamaProvider, validateAndNormalizeLocalHost } = require('./ollamaProvider');
const { MockModelProvider } = require('./mockModelProvider');

/**
 * Factory to create model providers.
 * 
 * @param {'ollama'|'mock'} [type='ollama']
 * @param {object} [options]
 * @returns {BaseModelProvider}
 */
function createModelProvider(type = 'ollama', options = {}) {
    if (type === 'mock') {
        return new MockModelProvider(options);
    }
    if (type === 'ollama') {
        return new OllamaProvider(options);
    }
    throw new Error(`Unsupported model provider type: '${type}'. Only 'ollama' and 'mock' are supported.`);
}

module.exports = {
    BaseModelProvider,
    PROVIDER_STATUSES,
    OllamaProvider,
    MockModelProvider,
    validateAndNormalizeLocalHost,
    createModelProvider,
};

