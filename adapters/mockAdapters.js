'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ISOLATED MOCK ADAPTERS (For Load & Stress Testing Only)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ARCHITECTURAL RULE:
 * 1. Mock adapters MUST return status: 'SIMULATED'.
 * 2. Mock adapters MUST NEVER return status: 'SUCCESS'.
 * 3. SAGA Core and Ledger Engine will NEVER treat 'SIMULATED' as provider-confirmed
 *    settlement, preventing any simulated entries from leaking into real ledger records.
 */

const crypto = require('crypto');
const logger = require('../logger');

/**
 * Executes a simulated payment instruction.
 * Strictly returns status: 'SIMULATED'.
 *
 * @param {object} instruction
 * @returns {Promise<object>}
 */
async function executeMockRail(instruction) {
    const instructionId = instruction.instruction_id || instruction.instructionId || crypto.randomUUID();
    const mockHash = crypto.createHash('sha256').update(`mock_${instructionId}_${Date.now()}`).digest('hex');

    logger.info(`[MOCK-ADAPTER] 🧪 Simulating execution for instruction: ${instructionId}`);

    return {
        adapter_type: 'MOCK_ADAPTER',
        status: 'SIMULATED', // CRITICAL: Never 'SUCCESS'
        intent_id: `sim_${mockHash.slice(0, 16)}`,
        simulated: true,
        settlement_confirmed: false,
        timestamp: new Date().toISOString(),
        note: 'Isolated synthetic execution. Not a provider-confirmed transaction.',
    };
}

/**
 * Creates an AdapterRegistry-compliant Mock Plugin.
 *
 * @param {string} railId
 * @returns {object}
 */
function createMockPlugin(railId = 'MOCK_RAIL') {
    return {
        id: `adapter_mock_${railId.toLowerCase()}`,
        name: `Mock ${railId} Adapter`,
        supports: (inst) => inst.rail === railId || inst.use_mock === true,
        execute: async (inst) => executeMockRail(inst),
        rollback: async (intentId) => ({
            status: 'SIMULATED_REVERSED',
            intent_id: intentId,
            timestamp: new Date().toISOString(),
        }),
    };
}

module.exports = {
    executeMockRail,
    createMockPlugin,
};

