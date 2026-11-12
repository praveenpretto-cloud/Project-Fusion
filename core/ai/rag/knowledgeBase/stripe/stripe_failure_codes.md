---
source_id: DOC-STRIPE-002
title: Stripe Payment Failures and Decline Codes Reference
publisher: Stripe, Inc.
provider: STRIPE
source_url: https://docs.stripe.com/declines/codes
document_version: 2026-Q1
last_verified_at: 2026-11-10
licensing: Technical Documentation Summary - Permitted Fair Use Attribution
---

# Stripe Payment Failures and Decline Codes Reference

## Card Issuer Decline Codes
When a card payment fails, Stripe populates `last_payment_error.decline_code` with the raw acquiring bank response:

- `insufficient_funds`: The customer bank account or credit line lacks sufficient liquidity to complete the transaction. Operations recommendation: Ask the customer to select an alternative payment method or replenish funds.
- `card_declined`: The card issuer refused authorization without specifying a granular reason. Typically indicates fraud prevention threshold exceeded or generic account block.
- `expired_card`: The card expiration month or year is in the past. Requires customer updating credential expiry.
- `incorrect_cvc`: The three-digit or four-digit card security code does not match issuer records. Requires credential re-entry.
- `processing_error`: The card network or acquiring processor experienced a transient communication failure. Operations recommendation: Safe to retry after exponential backoff.
- `stolen_card` / `lost_card`: The card has been flagged as compromised by the cardholder. Merchant must block further authorization attempts.

## Gateway and API Error Classifications
Non-card gateway failures are reported in `error.type` and `error.code`:

- `balance_insufficient`: The merchant Stripe balance does not contain enough available liquidity in the settlement currency to execute a transfer or payout. Requires account balance replenishment before re-initiating.
- `card_error`: Errors related to customer payment credentials; these are safe to expose to the end user for remediation.
- `invalid_request_error`: Malformed request parameters (e.g. invalid currency, negative amount, missing mandatory fields). Never retry without parameter modification.
- `api_connection_error`: Network partition between the application and Stripe endpoints. Client must execute retry with the original `Idempotency-Key`.
- `rate_limit_error`: The application exceeded API throughput limits (HTTP 429). Implement client-side throttling.

