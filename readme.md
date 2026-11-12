# Project Fusion: Multi-Rail Payment Infrastructure & AI Operations Copilot (Engineering Prototype)

[![Status](https://img.shields.io/badge/status-Engineering%20Prototype-orange)](#)
[![CI](https://img.shields.io/badge/CI-Configured%20(.github%2Fworkflows%2Fci.yml)-blue)](.github/workflows/ci.yml)

> **"Project Fusion is a fintech engineering prototype combining multi-rail payment infrastructure and Payment Operations components with a bounded, read-only AI investigation copilot."**

---

## 🚀 Overview & Positioning

`[INFERENCE / PRODUCT POSITIONING]`

**Project Fusion** is a fintech engineering prototype designed to demonstrate multi-rail payment orchestration components and automated failure diagnosis. It bridges:

1. **Payment-Provider Integrations**: Gateway adapter integrations for Stripe (card acquiring simulation / test APIs) and Razorpay (payouts simulation / test APIs).
2. **Cross-Border Clearing Models**: Cross-rail settlement architectures incorporating ISO 20022 message specifications (`pacs.008`) for documentation retrieval and synthetic scenario testing (not live bank clearing networks).
3. **Digital Asset Rails**: Distributed ledger integration (Stellar Horizon Testnet for XLM / USDC) with sequence serialization.
4. **AI Operations Copilot**: A bounded, read-only decision-support copilot that diagnoses synthetic transaction failures using native tool calling, hybrid RAG, and algorithmic DLP.

> [!IMPORTANT]
> **Prototype Classification Notice**: Project Fusion is an uncertified engineering prototype developed for systems architecture research and portfolio demonstration. It is **not** a licensed financial institution, payment aggregator, or commercial banking service. All payment provider connections run on testnets, sandboxes, or deterministic in-memory simulations.

---

## 🏗️ Architecture & Core Components

`[VERIFIED IMPLEMENTATION]`

### 1. Multi-Rail SAGA Orchestrator
- **State Machine**: Orchestrates multi-leg workflows through concrete lifecycle states (`INITIATED`, `PENDING_APPROVAL`, `APPROVED`, `LOCKED`, `PENDING_EXECUTION`, `SETTLED`, `PENDING_SETTLEMENT`, `SIMULATED`, `MANUAL_CHECK`, and `FAILED`) in [`core/orchestrator/sagaCore.js`](core/orchestrator/sagaCore.js). (Note: Maker-checker approval status `PENDING` is tracked separately in `instructions.approval_status`, distinct from the instruction state `PENDING_APPROVAL`).
- **Compensating Transactions & Manual Escalation**: Automatically executes forward offsetting business logic (such as requesting a gateway refund or releasing internal ledger reservations) if a downstream rail rejects execution. SAGA compensation executes forward offsetting logic; it cannot physically roll back cleared external banking rails, and halts in `MANUAL_CHECK` (referred to in operational documentation as manual review/reconciliation) if adapter outcomes are ambiguous (`UNKNOWN`) or liquidity checks fail, preventing unsafe duplicate payouts.
- **Per-Rail Circuit Breaker**: Fault isolation in [`core/circuitBreaker.js`](core/circuitBreaker.js) (Closed, Open, Half-Open) to mitigate cascading timeouts during provider outages.

### 2. Double-Entry Ledger Bookkeeping
- **Double-Entry Mathematical Invariant**: Enforces $\sum \text{Debits} = \sum \text{Credits}$ in application logic ([`core/orchestrator/ledgerUtils.js`](core/orchestrator/ledgerUtils.js)) via atomic two-legged transactions with advisory locks, verified by [`core/ai/evidence/verifyLedgerIntegrity.js`](core/ai/evidence/verifyLedgerIntegrity.js). The table schema is defined in [`db/schema.sql`](db/schema.sql) (`ledger_journal`).
- **Append-Only Tamper-Evident Hash Chain**: Sequential SHA-256 hash chaining links each entry to its predecessor (`hash = SHA256(prev_hash + instruction_id + account_id + direction + amount + timestamp)`). This provides tamper-*detection* during sequential audit verification from genesis; it does not prevent initial bad insertions by authorized writers, nor does it prevent full-chain recomputations by database superusers without external WORM or public blockchain anchoring.
- **Arbitrary Precision**: Uses string-based decimal math ([`core/orchestrator/financialDecimal.js`](core/orchestrator/financialDecimal.js)) backed by PostgreSQL `NUMERIC(56, 18)` to eliminate IEEE 754 floating-point rounding errors.

### 3. Bounded AI Operations Copilot
- **Bounded Iterative State Machine**: Enforces strict turn bounds: default 4 rounds (configurable 1–6), 6 tool calls, 30s model timeout, 90s overall deadline, and cycle interception ([`core/ai/orchestrator/agentLoop.js`](core/ai/orchestrator/agentLoop.js)).
- **Read-Only Least Privilege**: The tool registry exposes 8 diagnostic inspection tools plus 1 RAG documentation search tool (9 tools total in [`core/ai/tools/toolRegistry.js`](core/ai/tools/toolRegistry.js)) and physically excludes payment mutation functions (`refund`, `transfer`, `cancel`), ensuring the copilot operates strictly in an advisory capacity (human operators review diagnostic reports before taking action).
- **Algorithmic Data Loss Prevention (DLP)**: Pre-context sanitization verifies candidate card PAN digit strings via the Luhn checksum (validating digit format, not verifying an active or genuine card account), IBANs via ISO 7064 Mod 97-10, and masks schema-aware names before context enters model prompts ([`core/ai/security/dlpMasker.js`](core/ai/security/dlpMasker.js)). *Limitation: Algorithmic DLP operates deterministically on structured patterns and explicit schema fields; it does not guarantee identification of arbitrary unstructured personal names embedded within free-text notes without fine-tuned Named Entity Recognition (NER).*
- **Hybrid RAG Knowledge Engine**: Combines BM25 lexical tokenization with dense vectors (384D Mock / 768D `nomic-embed-text`) via Reciprocal Rank Fusion ($k=60$) over 13 payment specifications ([`core/ai/rag/`](core/ai/rag/)).
- **Deterministic Citation Verification**: Algorithmic gate ([`core/ai/validators/evidenceCitationValidator.js`](core/ai/validators/evidenceCitationValidator.js)) verifying that all formal tool and documentation citations in the report were observed during execution. *Limitation: The citation validator performs structural presence and existence verification (confirming that cited tool outputs and document chunks match runtime history); it does not evaluate the semantic accuracy, truthfulness, or soundness of the LLM's natural language reasoning via Natural Language Inference (NLI).*

---

## 📊 Empirical Verification & Test Evidence

`[VERIFIED IMPLEMENTATION]` & `[HISTORICAL TEST EVIDENCE]`

- **Unit Test Regression**: 36 test suites, **808 tests passing in-band** in Jest (~6.0s total run).
- **Integration Test Suite**: 30 tests passing in [`tests/integration/aiInvestigationWorkflow.test.js`](tests/integration/aiInvestigationWorkflow.test.js), including assertions that zero persistent database queries touch `fusion_db`.
- **DLP Test Suite**: 43 DLP tests passed in [`tests/unit/aiDlpMasker.test.js`](tests/unit/aiDlpMasker.test.js) across candidate card PAN checksums, ISO 7064 IBANs, GSTIN, PAN, and schema names.
- **25-Case Curated RAG Benchmark**: Evaluated across 25 total curated cases and 13 payment specifications (`fusion_ai_3_2_1_real_embeddings_and_rag_accuracy_report.md`):
  - **Positive Retrieval Metrics (22 positive domain queries)**: **0.985 Mean Precision@3**, **0.985 Mean Recall@5**, **0.955 Mean MRR** ($N=22$).
  - **Exact Error-Code Cases (6 cases, a subset of the 22 positive domain queries)**: **100.0% Rank-1 Precision (6/6)** on technical error codes (`tx_bad_seq`, `pacs.008`).
  - **Negative Controls (3 out-of-domain queries, completing the 25 total curated cases: 22 + 3 = 25)**: **100.0% Clean Abstention (3/3)** with zero spurious chunks returned.
- **Live Stream Demonstration**: ~21ms–23ms total duration under deterministic simulation (`MockModelProvider`).
- **Historical Real-Model Inference**: 37,946 ms total duration across 5 sequential model inference requests on Apple Silicon (`qwen2.5-coder:7b`, 9,906 input tokens, 753 output tokens, Trace `453bdb4c...`).
- **Synthetic Load Testing Harness**: Configured in an Artillery test harness ([`tests/load/load_test.yml`](tests/load/load_test.yml)) targeting an arrival-rate ramp up to 500 req/s against local mock endpoints. Source data from [`tests/load/load_test_report.json`](tests/load/load_test_report.json) records 34,650 total HTTP requests across an observed 160.25-second counter interval (`firstCounterAt: 1772259398956` to `lastCounterAt: 1772259559203`, encompassing client warm-up and metric flush; scenario phases configured for 135 seconds). The arithmetic mean HTTP request rate across that recorded 160.25s interval was 216.2 req/s ($34,650 / 160.247\text{s}$); Artillery's raw summary field outputs `rates.http.request_rate: 118`. Outcomes: 10,348 successful `/health` requests (HTTP 200) and 24,302 payment-initiation requests returning HTTP 400 (`errors.Failed capture or match: 24302`) due to synthetic authorization and payload validation constraints. *Critical distinction: HTTP 400 requests represent web-tier HTTP edge validation capacity under load and do NOT constitute successful payment-processing throughput.*

---

## ⚡ Quick Start (Local Prototype)

```bash
# 1. Install dependencies
npm install
cd client && npm install && cd ..

# 2. Start Express Backend (Local-Only Mode, Port 3000)
LOCAL_ONLY=true node server.js

# 3. Start Next.js Frontend (Bound to 127.0.0.1, Port 3001)
npm --prefix client run dev
```

Navigate to `http://127.0.0.1:3001` in your local web browser.

---

## 📜 Repository Status & Licensing

Project Fusion is an educational and systems engineering portfolio prototype. Note: A formal open-source license file (`LICENSE`) is not currently committed to the repository.
