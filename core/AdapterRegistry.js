const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { normalizeResult, normalizeError } = require('./adapterResultNormalizer');

class AdapterRegistry {
    constructor() {
        this.plugins = [];
    }

    /**
     * Loads built-in core adapters.
     */
    registerCoreAdapters(adapters) {
        adapters.forEach((adapter) => {
            if (this.validatePlugin(adapter)) {
                this.plugins.push(adapter);
                logger.info(`[REGISTRY] Registered core adapter: ${adapter.name} (${adapter.id})`);
            }
        });
    }

    /**
     * Dynamically loads plugins from a specified directory.
     */
    loadPluginsFromDirectory(dirPath) {
        if (!fs.existsSync(dirPath)) {
            logger.warn(`[REGISTRY] Plugin directory not found: ${dirPath}`);
            return;
        }

        const files = fs.readdirSync(dirPath).filter((file) => file.endsWith('.js'));
        for (const file of files) {
            try {
                const plugin = require(path.join(dirPath, file));
                if (this.validatePlugin(plugin)) {
                    this.plugins.push(plugin);
                    logger.info(`[REGISTRY] Loaded external plugin: ${plugin.name} (${plugin.id})`);
                } else {
                    logger.warn(`[REGISTRY] Skipped invalid plugin: ${file}`);
                }
            } catch (err) {
                logger.error(`[REGISTRY] Failed to load plugin ${file}: ${err.message}`);
            }
        }
    }

    /**
     * Validates that an object conforms to the Adapter SDK contract.
     */
    validatePlugin(plugin) {
        return (
            typeof plugin.id === 'string' &&
            typeof plugin.name === 'string' &&
            typeof plugin.supports === 'function' &&
            typeof plugin.execute === 'function' &&
            typeof plugin.rollback === 'function'
        );
    }

    /**
     * Finds the first adapter that supports the given instruction.
     */
    findAdapterForInstruction(instruction) {
        return this.plugins.find((plugin) => plugin.supports(instruction));
    }

    /**
     * Executes a batch of instructions while strictly preserving original input ordering.
     *
     * Concurrency & Routing Strategy:
     * - Fiat instructions are dispatched in parallel via Promise.allSettled.
     * - Crypto instructions (XLM, BTC, ETH, USDC) are serialized sequentially to prevent
     *   sequence number collisions (tx_bad_seq) and liquidity races.
     * - Results are deterministically mapped to their exact input index (results[i] corresponds to instructions[i]).
     * - Every result is normalized to include instruction_id, input_index, status, and error details if failed.
     * - Individual adapter rejections are caught and normalized without crashing or leaving undefined array positions.
     *
     * @param {Array<object>} instructions - Array of payment instructions
     * @returns {Promise<Array<object>>} - Normalized results strictly preserving input array indices
     */
    async executeBatchConcurrently(instructions) {
        if (!Array.isArray(instructions) || instructions.length === 0) {
            return [];
        }

        const total = instructions.length;
        const results = new Array(total);

        // Classify instructions by rail while tracking original input indices
        const fiatItems = [];
        const cryptoItems = [];

        for (let idx = 0; idx < total; idx++) {
            const inst = instructions[idx];
            const isCrypto = inst && ['XLM', 'BTC', 'ETH', 'USDC'].includes(inst.currency);
            if (isCrypto) {
                cryptoItems.push({ inst, idx });
            } else {
                fiatItems.push({ inst, idx });
            }
        }

        logger.info(
            `[REGISTRY] Internal Batch Routing: ${cryptoItems.length} Crypto (SERIALIZED), ${fiatItems.length} Fiat (PARALLEL) across ${total} total instructions`
        );

        // 1. Parallel Execution for Fiat (High Throughput)
        const fiatPromises = fiatItems.map(async ({ inst, idx }) => {
            try {
                const adapter = this.findAdapterForInstruction(inst);
                if (!adapter) {
                    return {
                        idx,
                        result: normalizeError(
                            `No fiat adapter found for instruction (${inst?.currency || 'unknown currency'})`,
                            inst,
                            idx,
                            'No fiat adapter found'
                        ),
                    };
                }
                const res = await adapter.execute(inst, { logger });
                return { idx, result: normalizeResult(res, inst, idx, adapter) };
            } catch (err) {
                logger.error(
                    `[REGISTRY-FIAT] Exception executing instruction ${inst?.instruction_id || idx}: ${err.message}`
                );
                return {
                    idx,
                    result: normalizeError(err, inst, idx, 'Fiat adapter execution failed'),
                };
            }
        });

        // 2. Serial Execution for Crypto (Sequential Integrity)
        for (const { inst, idx } of cryptoItems) {
            try {
                const adapter = this.findAdapterForInstruction(inst);
                if (!adapter) {
                    results[idx] = normalizeError(
                        `No crypto adapter found for instruction (${inst?.currency || 'unknown currency'})`,
                        inst,
                        idx,
                        'No crypto adapter found'
                    );
                    continue;
                }

                logger.info(
                    `[REGISTRY-SERIAL] Processing ${inst?.instruction_id || idx} on ${inst?.currency || 'CRYPTO'} rail (Index ${idx})...`
                );
                const res = await adapter.execute(inst, { logger });
                results[idx] = normalizeResult(res, inst, idx, adapter);

                // Delay between sequential crypto transactions to allow ledger sequence sync
                await new Promise((r) => setTimeout(r, 100));
            } catch (err) {
                logger.error(
                    `[REGISTRY-CRYPTO] Exception executing instruction ${inst?.instruction_id || idx}: ${err.message}`
                );
                results[idx] = normalizeError(err, inst, idx, 'Crypto adapter execution failed');
            }
        }

        // Await all parallel fiat executions and assign to their exact original positions
        const settledFiat = await Promise.allSettled(fiatPromises);
        for (const settled of settledFiat) {
            if (settled.status === 'fulfilled') {
                const { idx, result } = settled.value;
                results[idx] = result;
            } else {
                const reason = settled.reason;
                logger.error(
                    `[REGISTRY-FIAT] Uncaught promise rejection: ${reason?.message || reason}`
                );
            }
        }

        // Verify all array positions are populated (preventing any sparse / undefined slots)
        for (let i = 0; i < total; i++) {
            if (!results[i]) {
                const inst = instructions[i];
                results[i] = normalizeError(
                    'Execution failed to resolve for instruction slot',
                    inst,
                    i,
                    'Unhandled batch execution error'
                );
            }
        }

        return results;
    }

    /**
     * Alias for executeBatchConcurrently guaranteeing order preservation.
     */
    async executeBatchPreservingOrder(instructions) {
        return this.executeBatchConcurrently(instructions);
    }
}

// Export as a singleton with class reference attached for isolated testing
const adapterRegistry = new AdapterRegistry();
adapterRegistry.AdapterRegistry = AdapterRegistry;
module.exports = adapterRegistry;
