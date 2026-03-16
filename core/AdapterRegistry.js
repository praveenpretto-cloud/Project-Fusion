const fs = require('fs');
const path = require('path');
const logger = require('../logger');

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
}

// Export as a singleton
const adapterRegistry = new AdapterRegistry();
module.exports = adapterRegistry;
