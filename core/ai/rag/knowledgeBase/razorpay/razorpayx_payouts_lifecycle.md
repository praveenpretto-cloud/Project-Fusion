---
source_id: DOC-RAZORPAY-001
title: RazorpayX Payout Lifecycle & Modes Specification
publisher: Razorpay Software Private Limited
provider: RAZORPAY
source_url: https://razorpay.com/docs/api/x/payouts/
document_version: 2026-v2
last_verified_at: 2026-11-10
licensing: Technical Documentation Summary - Permitted Fair Use Attribution
---

# RazorpayX Payout Lifecycle & Modes Specification

## Payout State Machine

RazorpayX payouts transfer funds from a business virtual account to vendor bank accounts. The lifecycle stages are:

- `queued`: Payout received during non-banking clearing hours or queued pending balance replenishment.
- `pending`: Payout queued for approval in multi-tiered corporate authorization workflows.
- `processing`: Payout submitted to the underlying partner bank (e.g. Yes Bank, RBL, ICICI) for clearing.
- `processed`: The banking rail confirmed funds delivery to beneficiary bank account. This is the terminal success state.
- `reversed`: Payout initially reported processed or processing was rejected downstream by the beneficiary bank (e.g. invalid IFSC, beneficiary account frozen). Funds are credited back to business balance.
- `rejected`: Payout blocked prior to bank dispatch due to compliance check, invalid account format, or insufficient balance.

## Settlement Clearing Rails

RazorpayX routes payouts across distinct national clearing modes:

- `IMPS`: Immediate Payment Service. Real-time 24x7 clearing for amounts up to INR 5,00,000.
- `NEFT`: National Electronic Funds Transfer. Batch clearing operating 24x7 in half-hourly intervals.
- `RTGS`: Real Time Gross Settlement. Real-time settlement for large-value payments (minimum INR 2,00,000).
- `UPI`: Unified Payments Interface. Real-time 24x7 instant mobile clearing using Virtual Payment Addresses (VPA).
- `card`: Payouts direct to Visa, Mastercard, or RuPay debit/credit card numbers.
