# Project Fusion: Technical Masterclass & System Architecture

> **Document Status**: CONFIDENTIAL / INTERNAL TECHNICAL BRIEFING
> **Target Audience**: Senior Engineering Leadership / Principal Architects
> **Core Value**: Atomic Orchestration of Fiat, Crypto, and Capital Markets.

---

## 1. Executive Summary (The "Why")

**Project Fusion** is not a payment gateway; it is a **Multi-Asset Orchestration Engine**.

In traditional finance, moving money from "Bank A" (SWIFT) to "Wallet B" (Blockchain) or "Brokerage C" (FIX) is fragmented. If a step fails mid-flight, money goes missing ("Ghost Money").

**Fusion solves this with an Atomic State Machine.** It acts as a wrapper around legacy rails, enforcing a strict **Two-Phase Commit (2PC)** logic. It doesn't just "fire and forget" API calls; it manages the *entire lifecycle* of value, guaranteeing that every transaction either **Completely Succeeds** or **Cleanly Fails**—zero inconsistent states.

---

## 2. Technical Taxonomy (The "Stack")

### Core Infrastructure
*   **Runtime**: Node.js (v18+) with `cluster` module for multi-core parallelism.
*   **Database**: PostgreSQL 15 (ACID compliance, Row-Level Locking).
*   **Containerization**: Docker & Docker Compose (Microservices architecture).
*   **Proxy/Security**: Mutual TLS (mTLS) enforcement at the application layer.

### Critical Libraries
*   **Web Framework**: `express` (Minimalist, high-performance).
*   **DB Driver**: `pg` (Native PostgreSQL client with connection pooling).
*   **Observability**: `prom-client` (Prometheus metrics), `pino` (Structured logging).
*   **Cryptography**: Native `crypto` module + Hardware Security Module (HSM) simulation.
*   **Testing**: `jest` (Unit/Integration), `artillery` (Load/Stress testing).

---

## 3. Architecture Deep Dive (The "How")

The system is built on three pillars: **Saga Orchestration**, **Universal Adapters**, and **Double-Entry Accounting**.

### A. The Saga Orchestrator (`server.js`)
Instead of simple async/await calls, Fusion implements a **Finite State Machine (FSM)** for every transaction.
*   **Lifecycle**: `INITIATED` -> `LOCKED` -> `PENDING_EXECUTION` -> `SETTLED` (or `FAILED`).
*   **Resiliency**: If the server crashes during `PENDING_EXECUTION`, a background **Reconciler Worker** wakes up, scans the DB for "stale" states, checks with the external provider, and auto-heals the transaction.

### B. The Universal Adapter Pattern (`/adapters`)
Fusion is agnostic to the underlying rail. It uses a **Strategy Pattern** to normalize diverse protocols into a single interface.
*   **Fiat Rail**: `adapters/paymentAdapters.js` (currently implementing **Stripe**, extensible to SWIFT/SEPA).
*   **Crypto Rail**: `adapters/cryptoAdapters.js` (currently implementing **Stellar**, extensible to Ethereum/Solana).
*   **Investment Rail**: `adapters/brokerageAdapters.js` (simulates Equity/ETF executions).

### C. The Shadow Ledger (`ledger_journal` Table)
We do not trust external APIs blindly. We maintain an internal **Shadow Ledger**.
*   **Double-Entry**: Every transaction writes TWO rows: one `DEBIT` and one `CREDIT`.
*   **Atomic Write**: The Ledger write and the State update happen in the *same* database transaction (`BEGIN` ... `COMMIT`).
*   **Invariant Check**: `SUM(DEBIT) == SUM(CREDIT)` is verified programmatically before commit.

---

## 4. Key Systems & Modules (A-Z)

| System | Role | Implementation Detail |
| :--- | :--- | :--- |
| **API Gateway** | Entry Point | strict `idempotency-key` enforcement to prevent double-spending on retries. |
| **Identity Guard** | Security | Enforces **mTLS** (Client Certs) + API Key authentication. Middleware rejects non-mTLS traffic. |
| **Smart Router** | Optimization | Directs traffic based on asset type (e.g., `USD` -> Stripe, `pro_stock` -> Brokerage). |
| **Vault Provider** | Key Management | Simulates an **HSM**. Private keys never touch the app memory directly; they are accessed via reference ID. |
| **Policy Engine** | Compliance | Evaluates rules (e.g., "Max $1M/day") before locking funds. Can block suspicious flows. |
| **Reconciler** | Self-Healing | Cron-based worker scans for `PENDING` transactions > 30s and queries upstream providers to fix state. |
| **Observability** | Monitoring | Exposes `/metrics` for Prometheus (Transactions/sec, Latency, Error Rates). |
| **Audit Log** | Compliance | Immutable `audit_trail` table records every state change with a cryptographic hash. |

---

## 5. Security & Compliance (The "Trust")

### 🛡️ 1. No "Ghost Money"
*   **Problem**: App crashes after charging user but before updating DB.
*   **Solution**: The **Reconciler** matches `external_intent_id` (Stripe ID / Hash) with internal DB records.

### 🛡️ 2. Privacy by Design
*   **PII Redaction**: All logs traverse a sanitizer that hashes names/account numbers (`SHA-256`) before writing to disk.

### 🛡️ 3. Thread Safety
*   **Row-Level Locking**: Uses `SELECT ... FOR UPDATE` in Postgres to prevent race conditions during balance checks.

### 🛡️ 4. Zero Trust Network
*   **mTLS**: Even internal services must present a valid certificate to talk to the Core.

---

## 6. Project Stats & Capabilities

*   **Throughput**: Validated **800+ TPS** on local hardware (Scalable via `cluster` module across CPU cores).
*   **Latency**: P99 < 200ms for internal processing (excluding upstream API delays).
*   **Code Quality**: 
    *   **Linting**: ESLint + Prettier enforced.
    *   **Coverage**: Jest coverage reports generated.
    *   **CI/CD**: GitHub Actions workflows for automated testing on push.

---

## 7. How to Pitch This (Developer to Developer)

> *"Most payment apps are just thin wrappers around Stripe. Project Fusion is different. It's a **Banking Core**. It assumes networks will fail and creates a mathematical guarantee of correctness. It uses a Saga pattern to handle distributed transactions and a Double-Entry Shadow Ledger to ensure not a single cent is ever unaccounted for, even if the datacenter power gets pulled."*
