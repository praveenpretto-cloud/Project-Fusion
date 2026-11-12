---
source_id: DOC-STELLAR-002
title: Stellar Transaction and Operation Result Codes Reference
publisher: Stellar Development Foundation
provider: STELLAR
source_url: https://developers.stellar.org/docs/fundamentals-and-concepts/stellar-data-structures/result-codes
document_version: Horizon-API-v2
last_verified_at: 2026-11-10
licensing: Technical Documentation Summary - Permitted Fair Use Attribution
---

# Stellar Transaction and Operation Result Codes Reference

## Transaction Result Codes (`result_codes.transaction`)

When stellar-core evaluates a transaction, top-level validation result codes indicate transaction-level feasibility:

- `tx_success`: All operations succeeded and the transaction was committed to the ledger.
- `tx_failed`: One or more inner operations failed. Inspect `result_codes.operations` array for specific operation error.
- `tx_insufficient_balance`: The source account does not possess sufficient native XLM balance to satisfy the maximum fee bid.
- `tx_bad_seq`: The sequence number on the transaction does not match the source account's expected next sequence number on the ledger.
- `tx_insufficient_fee`: The transaction fee bid is below the network base fee rate during surge pricing.
- `tx_too_early` / `tx_too_late`: The current ledger close time falls outside the transaction's specified `time_bounds`.
- `tx_bad_auth`: Cryptographic signatures are invalid or do not meet required signing weight threshold.

## Operation Result Codes (`result_codes.operations`)

Inner operation result codes detail individual action outcomes:

- `op_underfunded`: The source account does not hold sufficient balance of the target asset to execute the payment while preserving reserve requirements.
- `op_no_destination`: Destination account does not exist on the ledger. Requires `CreateAccount` operation with minimum 1 XLM reserve rather than standard `Payment`.
- `op_no_trust`: Destination account does not hold an established trustline for non-native assets (e.g. USDC, EURC).
- `op_line_full`: The destination account balance would exceed the trustline limit established for the asset.
- `op_not_authorized`: The issuing anchor has enabled `AUTHORIZATION_REQUIRED` and has not authorized the destination trustline.

## Horizon HTTP Error Responses

- `400 Bad Request`: Transaction malformed or failed core consensus validation (`result_codes` populated in error payload).
- `504 Gateway Timeout`: Horizon did not receive ledger inclusion confirmation within wait timeout. The transaction may still clear on the subsequent ledger. Operations must query transaction hash before re-initiating.
