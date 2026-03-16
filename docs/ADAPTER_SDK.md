# Project Fusion: Adapter Plugin SDK

Project Fusion uses a dynamic **Adapter Plugin Architecture**. This allows enterprise clients and third-party developers to add new payment methods, blockchains, or banking APIs without modifying the core orchestrator engine.

## 1. Plugin Structure

A plugin is a standard Node.js module that exports a specific contract. All plugins must be placed in the `plugins/` directory (or registered dynamically).

### The Interface Contract

Your plugin file (e.g., `alipayAdapter.js`) must export an object containing the following properties and methods:

```javascript
module.exports = {
    // Unique identifier for the plugin
    id: 'plugin_alipay',

    // Human-readable name
    name: 'Alipay Global E-Commerce',

    // Predicate function: returns true if this plugin can handle the instruction
    supports: (instruction) => {
        // e.g., instruction.currency === 'CNY' && instruction.method === 'ALIPAY'
        return instruction.method === 'ALIPAY';
    },

    // Main execution phase of the Saga
    execute: async (instruction, context) => {
        const logger = context.logger;
        logger.info(`[ALIPAY] Executing payment for ${instruction.amount}`);

        // ... Call external API ...

        return {
            adapter_type: 'ALIPAY_SDK',
            status: 'SUCCESS', // 'SUCCESS' | 'FAILED' | 'PENDING'
            intent_id: 'external_gateway_id_123',
            timestamp: new Date().toISOString(),
        };
    },

    // Optional: Used by the Reconciler to check stuck transactions
    queryStatus: async (intentId, context) => {
        return 'SUCCESS';
    },
};
```

## 2. Using Plugins in Orchestration

The `AdapterRegistry` automatically loads all valid plugins on startup.

When a new transaction reaches the `EXECUTION` phase, the Orchestrator will query the `AdapterRegistry` to find the first plugin where `supports(instruction) === true`.

If found, it calls the plugin's `execute` method, passing the instruction payload and a context object (which contains secure utilities like the logger and vault provider).

## 3. Security Guidelines

1. **Never hardcode secrets** in the plugin. Read them from environment variables or the `vaultProvider`.
2. **Never swallow errors**. If an API call fails, throw an error or return `status: 'FAILED'` with an error message so the Saga can trigger a compensating rollback.
3. **Idempotency**: Always pass the `instruction.id` to the external vendor as an Idempotency Key to prevent double-spending on network retries.
