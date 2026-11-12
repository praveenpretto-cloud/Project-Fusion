---
source_id: DOC-STRIPE-001
title: Stripe PaymentIntent Lifecycle & Idempotency Specification
publisher: Stripe, Inc.
provider: STRIPE
source_url: https://docs.stripe.com/payments/payment-intents/lifecycle
document_version: 2026-Q1
last_verified_at: 2026-11-10
licensing: Technical Documentation Summary - Permitted Fair Use Attribution
---

# Stripe PaymentIntent Lifecycle & Idempotency Specification

## PaymentIntent State Machine

The PaymentIntent object represents a payment lifecycle from creation to settlement. It transitions through the following definitive states:

- `requires_payment_method`: The PaymentIntent has been initialized and is awaiting customer payment credentials.
- `requires_confirmation`: Payment credentials have been attached and the intent must be confirmed by the merchant application.
- `requires_action`: Customer interaction is mandatory (e.g. 3D Secure 2 authentication, SMS OTP challenge, or bank redirect).
- `processing`: Asynchronous payment authorization is underway at the clearing network or acquiring processor.
- `requires_capture`: The payment has been authorized and funds are placed on hold. The merchant must execute a capture call before the authorization window expires (typically 7 days).
- `succeeded`: The payment authorization and capture have completed successfully. Funds are guaranteed for merchant payout.
- `canceled`: The PaymentIntent was explicitly voided prior to capture or failed terminal verification.

## Idempotency and Retries

Stripe enforces strict request-level idempotency to prevent duplicate charges:

- The `Idempotency-Key` HTTP header accepts an alphanumeric string up to 255 characters.
- Stripe caches the initial response associated with each idempotency key for 24 hours.
- Repeated requests transmitting the identical idempotency key and identical request payload return the exact cached response without re-executing charges.
- If a request is received with an identical idempotency key but differing parameters, Stripe rejects the request with HTTP 400 `idempotency_error`.
- For transient network drops (HTTP 502/503/504), clients must safely retry with the identical idempotency key using exponential backoff with jitter.
