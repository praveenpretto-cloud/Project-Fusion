# Adapter Interface Guide

To add a new rail (e.g., Solana, PayPal, FedNow) to Project Fusion, you must implement a standard **Adapter Pattern**. This ensures the Orchestrator remains agnostic to the underlying technology.

## 1. Adapter Contract

All adapters must export an `execute` function that returns a standard result object.

### Function Signature
```javascript
async function executeCustomRail(instruction, adapterConfig) {
    // ... logic ...
    return {
        adapter_type: 'ADAPTER_CUSTOM_NAME', // e.g. 'ADAPTER_SOLANA'
        status: 'SUCCESS' | 'FAILED' | 'PENDING',
        intent_id: 'external_transaction_hash', // Critical for reconciliation
        timestamp: 'ISO_8601_STRING',
        metadata: { ... } // Optional extra data
    };
}
```

## 2. Required Files
1.  **Implementation**: Create `adapters/customAdapter.js`.
2.  **Registration**: Import and add to `server.js` switch-case in `executeAdapter`.

## 3. Reconciliation Support
Your adapter must also export a `queryStatus(intentId)` function if possible.

```javascript
async function queryStatus(intentId) {
    // Call external API to check status
    return 'succeeded' | 'failed' | 'unknown';
}
```

## 4. Key Security Rules
- **Never handle private keys directly**. Use `vaultProvider.js`.
- **Use Idempotency Keys** when calling external APIs.
- **Log structured data** using the project logger, not `console.log`.
