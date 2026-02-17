# RFC-001: Orchestration & Saga Pattern

**Status**: Accepted
**Date**: 2026-02-09
**Author**: Project Fusion Team

## Context

Financial transactions across heterogeneous systems (e.g., Stripe, Stellar, Internal Ledger) require atomicity. Traditional Two-Phase Commit (2PC) is not feasible because external providers (Stripe) do not support `PREPARE/COMMIT` phases.

## Decision

We adopted the **Saga Pattern** with a **Listen-to-Yourself** approach for reconciliation.

### Architecture

1.  **Local State First**: Transactions start as `PENDING_EXECUTION` in the local Postgres DB.
2.  **External Execution**: The adapter attempts the external call (idempotently).
3.  **Completion**:
    - **Success**: State moves to `SETTLED`.
    - **Failure**: State moves to `FAILED`.
    - **Timeout/Crash**: The `ReconciliationWorker` picks up stale `PENDING` items.

## Alternatives Considered

- **2PC (XA Transactions)**: Rejected due to lack of support from REST APIs (Stripe).
- **Event Sourcing**: Rejected to keep the architecture simple for the MVP (Postgres is sufficient).

## Consequences

- **Positive**: Resilient to server crashes. "Ghost Money" is automatically recovered.
- **Negative**: Latency is slightly higher due to double-writing state.
