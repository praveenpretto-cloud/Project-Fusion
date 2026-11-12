---
source_id: DOC-FUSION-001
title: Project Fusion Payment State Machine & Saga Orchestration Model
publisher: Project Fusion Architecture
provider: PROJECT_FUSION
source_url: https://project-fusion.internal/architecture/saga-orchestration
document_version: 3.2.0
last_verified_at: 2026-11-10
licensing: Project Fusion Internal Engineering Manual - Proprietary Architecture
---

# Project Fusion Payment State Machine & Saga Orchestration Model

## Internal Canonical Payment State Machine
Payment instructions in Project Fusion transition through authoritative, constrained state machine phases:

- `SUBMITTED`: Payment instruction ingested, validated against input schema, and recorded in PostgreSQL `instructions` table.
- `PENDING_APPROVAL`: Instruction requires dual-key authorization (e.g. amounts exceeding CFO approval threshold).
- `APPROVED`: Compliance, sanctions screening, and WebAuthn multi-party authorization confirmed. Instruction queued for execution.
- `PENDING_EXECUTION`: Instruction locked in execution outbox and dispatched to the designated provider adapter rail.
- `SETTLED`: Canonical terminal success. External provider gateway confirmed clearing and internal double-entry ledger postings were committed.
- `MANUAL_CHECK`: Ambiguous gateway outcome encountered (e.g. HTTP 504 Gateway Timeout or unverified network state). Automated retries and settlements are strictly halted pending operational bank portal verification.
- `FAILED`: Terminal rejection by provider gateway, validation rejection, or exhausted retries.
- `VOIDED`: Instruction canceled prior to execution dispatch under governance controls.

## Saga Orchestration and Compensations
The Saga orchestrator executes multi-step distributed payment workflows with backward compensating transactions:

- Step 1: Pre-Execution Balance Reservation (Internal Ledger hold).
- Step 2: Provider Gateway Dispatch (Asynchronous network call via Stripe, Razorpay, or Stellar adapter).
- Step 3: Confirmation and Clearing Verification.
- Step 4: Final Settlement Posting and Zoho Invoice Reconciliation.
- Compensating Actions on Failure: If step 2 fails with a confirmed rejection, the orchestrator triggers Step 1 Compensation (`REVERSE_BALANCE_RESERVATION`), releasing ledger holds and marking instruction `FAILED`.
- Incomplete History for Generic Instructions: In Project Fusion, generic payment instructions without invoice attachments do not persist intermediate Saga step history in PostgreSQL; full step history is persisted exclusively for associated invoice payment flows.

