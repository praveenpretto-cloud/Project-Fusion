---
source_id: DOC-STRIPE-003
title: Stripe Refunds Lifecycle & Webhook Event Semantics
publisher: Stripe, Inc.
provider: STRIPE
source_url: https://docs.stripe.com/refunds
document_version: 2026-Q1
last_verified_at: 2026-11-10
licensing: Technical Documentation Summary - Permitted Fair Use Attribution
---

# Stripe Refunds Lifecycle & Webhook Event Semantics

## Refund Lifecycle and Statuses
Refunds return funds to the customer account from a settled charge. Refunds transition through the following states:

- `pending`: The refund request is queued for processing at the banking network (common for ACH and SEPA direct debit refunds, taking up to 5-10 business days).
- `succeeded`: The refund authorization completed. Funds have been credited to the customer issuer and debited from the merchant balance.
- `failed`: The refund could not be delivered to the customer bank (e.g. closed bank account, expired prepaid card). Operations must verify bank account details out-of-band.
- `canceled`: The refund was canceled by the merchant before execution.

## Inbound Webhook Event Semantics
Stripe notifies merchant backends asynchronously via signed HTTP POST webhooks. Key events include:

- `payment_intent.succeeded`: The payment was captured and funds are confirmed settled.
- `payment_intent.payment_failed`: The payment attempt failed. Inspect `last_payment_error` for root cause decline code.
- `charge.refunded`: A full or partial refund completed successfully on a charge.
- `charge.refund.updated`: A refund status transitioned (e.g. from `pending` to `succeeded` or `failed`).

## Webhook Signature Verification and Duplicate Delivery
- Webhooks transmit the `Stripe-Signature` header containing a timestamp (`t=...`) and HMAC-SHA256 signature (`v1=...`).
- Verification computes HMAC-SHA256 over `${timestamp}.${raw_body}` using `STRIPE_WEBHOOK_SECRET` and performs constant-time comparison to prevent timing attacks.
- At-least-once delivery: Stripe guarantees delivery by retrying dropped webhooks up to 72 hours.
- Applications must record processed event IDs (`evt_...`) in a unique database column (`ON CONFLICT DO NOTHING`) to ensure strict idempotency across duplicate deliveries.

