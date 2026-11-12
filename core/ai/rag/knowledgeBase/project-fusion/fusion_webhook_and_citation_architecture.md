---
source_id: DOC-FUSION-003
title: Project Fusion Ingestion, Evidence Grounding & Citation Architecture
publisher: Project Fusion Architecture
provider: PROJECT_FUSION
source_url: https://project-fusion.internal/architecture/evidence-citations
document_version: 3.2.0
last_verified_at: 2026-11-10
licensing: Project Fusion Internal Engineering Manual - Proprietary Architecture
---

# Project Fusion Ingestion, Evidence Grounding & Citation Architecture

## Webhook Ingestion & Deduplication Architecture

Project Fusion receives external webhook notifications from payment providers via raw express body streaming:

- Raw Body Invariance: Signature verification uses the raw unparsed request buffer to verify HMAC signatures against `STRIPE_WEBHOOK_SECRET` or `RAZORPAY_WEBHOOK_SECRET`.
- Deduping Invariant: Processed events are recorded in `processed_webhook_events` with unique event ID constraint. Duplicate webhook deliveries trigger `ON CONFLICT DO NOTHING` and are dropped silently without incrementing numerical delivery counters.
- Reconciling Webhooks vs Instructions: An absent webhook event in `processed_webhook_events` indicates the event was either dropped, delayed in transit, or not received; it does not indicate provider-wide outage without corroborating external telemetry.

## Evidence Grounding and Multi-Class Citation Model

Project Fusion AI operations intelligence operates under strict dual-evidence grounding:

- Operational Evidence: Retrievable records from the synthetic fixture or database (e.g. `getTransactionTimeline`, `getProviderFailureDetails`, `getSagaExecutionEvidence`, `getSettlementAndWebhookEvidence`, `verifyLedgerIntegrity`, `getReconciliationEvidence`, `explainIsoValidationErrors`). Cited as tool names in `confirmed_findings`.
- Documentation Evidence: Knowledge-base chunks retrieved via `search_payment_knowledge`. Cited as chunk identifiers (e.g. `docs:stripe:payment-intents:chunk-001`, `docs:stellar:stellar_error_codes:chunk-002`).
- Citation Rules:
    - Zero Fabricated Citations: Every cited document chunk must have been actually returned in the current investigation's `search_payment_knowledge` observation.
    - Cross-Provider Attribution Prohibition: Citations attributing one provider's rules (e.g. Stripe card decline logic) to an incompatible provider (e.g. Stellar SCP consensus) fail validation.
    - Negative Evidence Isolation: Unavailable operational records must be routed to `missing_information` rather than cited in `confirmed_findings`.
