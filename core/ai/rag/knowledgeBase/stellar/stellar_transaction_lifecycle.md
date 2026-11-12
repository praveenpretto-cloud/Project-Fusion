---
source_id: DOC-STELLAR-001
title: Stellar Horizon Transaction Lifecycle & Sequence Numbers
publisher: Stellar Development Foundation
provider: STELLAR
source_url: https://developers.stellar.org/docs/fundamentals-and-concepts/stellar-data-structures/operations-and-transactions
document_version: Horizon-API-v2
last_verified_at: 2026-11-10
licensing: Technical Documentation Summary - Permitted Fair Use Attribution
---

# Stellar Horizon Transaction Lifecycle & Sequence Numbers

## Transaction Construction and Submission
Stellar transactions bundle one or more atomic operations (e.g. `Payment`, `ChangeTrust`, `CreateAccount`) signed by cryptographic source accounts:

- Source Account Sequence Number: Every transaction consumes an incremental sequence number strictly 1 greater than the current account sequence recorded on the ledger.
- Time Bounds: Optional UNIX timestamp range (`min_time`, `max_time`) defining valid ledger inclusion window.
- Base Reserve & Fees: Accounts must maintain minimum XLM reserve ($0.5 \text{ XLM} \times (2 + \text{subentries})$). Transactions incur network base fees (minimum 100 stroops per operation).
- Consensus Submission: Submitted via Horizon REST endpoint `POST /transactions` to stellar-core nodes executing Stellar Consensus Protocol (SCP). Ledger close occurs every ~5 seconds.

## Sequence Number Handling and Concurrency
A primary operational challenge on Stellar is sequence number synchronization:

- Sequence gaps: If sequence $N+2$ is submitted before $N+1$, the network rejects the transaction with `tx_bad_seq`.
- Concurrent transactions: Multiple workers attempting to submit from the same source account concurrently encounter sequence conflicts.
- Mitigation pattern: Use dedicated ephemeral sequence channels (channel accounts) or serialized queueing per source public key.
- Sequence recovery: On sequence error, the client must query the Horizon account endpoint (`GET /accounts/{id}`) to fetch the authoritative ledger sequence number.

