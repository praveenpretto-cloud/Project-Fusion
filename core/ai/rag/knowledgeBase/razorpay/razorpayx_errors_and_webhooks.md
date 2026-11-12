---
source_id: DOC-RAZORPAY-002
title: RazorpayX Payout Error Classifications & Webhook Events
publisher: Razorpay Software Private Limited
provider: RAZORPAY
source_url: https://razorpay.com/docs/api/x/errors/
document_version: 2026-v2
last_verified_at: 2026-11-10
licensing: Technical Documentation Summary - Permitted Fair Use Attribution
---

# RazorpayX Payout Error Classifications & Webhook Events

## Common Payout Failure Codes

When a payout is rejected or reversed, RazorpayX returns standardized error payload objects:

- `BAD_REQUEST_ERROR`: Invalid parameters provided in payout creation payload.
    - `business_account_low_balance`: The business account has insufficient funds to execute the payout. Requires funding account before retry.
    - `invalid_fund_account_id`: The specified beneficiary fund account ID does not exist or is inactive.
    - `invalid_ifsc`: The beneficiary Indian Financial System Code format is invalid or references a non-operational branch.
- `GATEWAY_ERROR`: The banking gateway failed to acknowledge payment status within SLA. Payout moves to `processing` or `MANUAL_CHECK`. Never retry immediately without checking banking portal.
- `SERVER_ERROR`: Transient internal failure at Razorpay. Safe to retry with the original idempotency reference.

## Webhook Event Specifications

Asynchronous payout lifecycle updates are transmitted via HTTP webhooks with `X-Razorpay-Signature`:

- `payout.processed`: The payout cleared the banking network and funds reached the beneficiary.
- `payout.reversed`: A previously processing or cleared payout was returned by the receiving bank. A corresponding reversal transaction ID (`rev_...`) is generated and funds return to virtual account.
- `payout.failed`: Payout terminal failure at the clearing network before dispatch.
- `payout.updated`: Payout status changed (e.g. from `queued` to `processing`).
- Reversals vs Refunds: Payout reversals are automated returns initiated by the destination banking rail; merchant refunds represent customer-initiated return of customer payment collections.
