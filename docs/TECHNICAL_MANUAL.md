# Project Fusion: Technical & Operational Manual

**Version**: 1.0 (Institutional Prototype)
**Date**: 2026-02-12
**Classification**: PROJECT FUSION INTERNAL

---

## 1. Executive Summary
Project Fusion is a **cloud-native Payment Orchestration Platform** tailored for high-volume, cross-border financial settlements. It bridges legacy banking protocols (SWIFT/ISO 20022) with modern rails (Stripe, Stellar Blockchain, Real-Time Payments).

This manual provides the technical specifications, API reference, and operational procedures required to deploy and maintain the system.

---

## 2. System Architecture

### 2.1 High-Level Design
The system follows a **Modular Monolith** architecture (for prototype efficiency) that is verifiable enabling a future microservices split.

*   **Core Engine**: Node.js/Express (Event Loop architecture for high concurrency).
*   **Data Store**: PostgreSQL (ACID compliance, Row-Level Locking).
*   **Ledger**: Double-Entry Accounting with Cryptographic Hash Chains (Tamper-Evident).
*   **Adapters**: Pluggable modules for external connectivity (Stripe, Stellar).

### 2.2 Data Flow (The Saga Pattern)
Every transaction follows this strictly enforcing lifecycle:
1.  **INITIATE**: Client submits instruction. Data is validated (Joi Schema).
2.  **LOCK**: Internal Ledger debits the Source Account (Pending State).
3.  **EXECUTE**: Adapter calls external bank/blockchain.
4.  **SETTLE**:
    *   *Success*: Ledger credits Destination Account (Final State).
    *   *Failure*: Ledger reverts Source Account (Compensating Transaction).

---

## 3. Security Specification (Zero Trust)

### 3.1 Network Security
*   **mTLS (Mutual TLS)**: All API clients must present a valid X.509 certificate.
*   **API Keys**: Secondary authentication layer (`x-api-key`) for application identity.

### 3.2 Data Security
*   **PII Redaction**: All logs automatically scrub sensitive fields (`sender`, `recipient`, `account_id`).
*   **Vault Simulation**: Private keys are never exposed to the application memory; they are accessed via `vaultProvider.js`.

---

## 4. API Reference

### 4.1 Initiate Transaction
`POST /api/instruction/initiate`

**Headers**:
*   `x-api-key`: [YOUR_KEY]
*   `x-idempotency-key`: [UNIQUE_UUID]

**Body**:
```json
{
  "amount": 100.50,
  "currency": "USD",
  "sender": "user_123",
  "recipient": "user_456",
  "purpose": "PAYMENT"
}
```

**Response (200 OK)**:
```json
{
  "instruction_id": "550e8400-e29b-41d4-a716-446655440000",
  "state": "INITIATED"
}
```

### 4.2 Regulatory Observability
`GET /api/observe?limit=50`
*   Returns a list of recent transactions with PII hashed (`sender_hash`).

---

## 5. Operational Guide

### 5.1 Deployment
```bash
# 1. Install Dependencies
npm install

# 2. Setup Database & Certs
npm run setup

# 3. Start Server
npm start
```

### 5.2 Monitoring
*   **Metrics**: Prometheus endpoint available at `/metrics`.
*   **Health**: Deep health check at `/health/detailed`.

### 5.3 Chaos Recovery
The system is designed to self-heal.
*   **Database Outage**: API returns `503`. Background reconciler pauses.
*   **Recovery**: On DB reconnection, Reconciler scans for `PENDING` transactions and re-syncs state.

---

## 6. Adapter Configuration

| Adapter | Key Env Var | Description |
| :--- | :--- | :--- |
| **Stripe** | `STRIPE_TEST_SECRET_KEY` | Handles fiat card processing (USD/EUR). |
| **Stellar** | *Managed internally* | Handles blockchain assets (XLM/USDC). |
| **Brokerage** | *None* | Simulated equities trading. |

---

**End of Technical Manual**
