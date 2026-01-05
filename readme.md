```markdown
# Project Fusion

**Orchestration Architecture for Multi-Rail Financial Settlement**

**Status:** Prototype | Architecture Validation | Phase 1

---

## Overview

Project Fusion is a control-plane orchestration architecture that coordinates settlement instruction lifecycle across multiple financial rails. The system enforces policy prior to execution, maintains deterministic state transitions, and preserves immutable audit trails through ledger-based recording.

Critically, Fusion does not move assets, does not provide custody, and does not replace settlement systems. It operates as a coordination layer above licensed banks, custodians, and brokers. Settlement responsibility and asset custody remain with external institutions.

The architecture addresses a structural problem: modern financial institutions maintain separate orchestration stacks per asset class, duplicating policy logic, extending settlement latency, and fragmenting audit trails across disconnected systems.

---

## Problem Statement

Current financial settlement infrastructure exhibits three core inefficiencies.

**Policy Fragmentation:** AML/KYC rules, sanctions screening, and business logic are written separately for payments, digital assets, and securities rails. Government disbursement programs (e.g., Purpose-Bound Money) require policy definition in three independent systems. Policy changes necessitate coordination across multiple teams and systems.

**Cross-Asset Latency:** Workflows involving multiple asset classes require sequential handoffs between rail operators, extending settlement time from minutes to hours. A cross-border payment with optional wealth investment requires manual coordination across SWIFT, custodians, and brokers.

**Audit Trail Fragmentation:** Compliance audit requires assembling evidence from multiple systems post-settlement. Real-time visibility into policy decisions, routing selections, and settlement outcomes is unavailable during transaction execution. Violations are detected in audit, not prevented before settlement.

---

## Architectural Objective

Fusion separates orchestration responsibility from settlement responsibility through an explicit control-plane layer.

**Orchestration** (Fusion responsibility): Parse instructions, evaluate policy against instruction data, route to appropriate settlement rail, maintain instruction state, record execution evidence.

**Settlement** (External system responsibility): Move assets, provide finality, update settlement records within their respective systems, maintain custody.

This separation ensures Fusion cannot fail in a way that leaves assets in inconsistent state—because Fusion does not move assets. Violations of policy are detected and blocked before settlement systems are invoked.

---

## High-Level Architecture

Fusion operates across three zones.

**Zone A (Control Plane):** API Gateway validates incoming instructions and enforces API-key authentication (prototype) or mTLS/OAuth (production). Orchestrator manages instruction state machine and lifecycle. Policy Engine evaluates AML/KYC/sanctions/velocity rules and enforces Purpose-Bound Money restrictions at the policy layer. Shadow Ledger maintains an immutable internal audit record of all instructions and policy decisions. Recon Worker verifies daily reconciliation of ledger invariants against external settlement systems.

**Zone B (Adapter Layer):** Settlement-specific adapters encapsulate external rail integration. ADAPTER_FIAT handles PayNow and SWIFT. ADAPTER_CRYPTO handles qualified custodians. ADAPTER_WEALTH handles brokers and securities. Each adapter translates Fusion intent into rail-specific protocol and handles rail-specific failure modes.

**Zone C (Governance):** Governance event log records settlement events for notarization and observability. Regulator Observer node provides read-only visibility into policy decisions and settlement status without access to transaction amounts, sender/recipient identities, or account numbers. Regulatory credentials are issued out-of-band to designated regulator nodes.

**Data Flow:** Client application submits instruction via HTTPS/JSON. API Gateway validates schema and enforces authentication. Orchestrator evaluates policy through Policy Engine. If policy approved, instruction transitions to LOCKED state and issues cryptographic permit. Orchestrator routes to appropriate adapter. Adapter executes settlement through external rail; external system updates its own settlement records. Shadow Ledger records DEBIT and CREDIT entries representing the intended instruction outcome. Ledger integrity invariant verified (SUM(DEBIT) = SUM(CREDIT)). Governance event log records settlement event. Instruction transitions to SETTLED state.

---

## Execution Model

**Policy-First Gate:** Policy evaluation occurs before any settlement attempt. Policy rejection results in FAILED state with no settlement system invocation. Violations are structurally prevented, not detected post-execution.

**Deterministic State Machine:** Instructions transition through explicit states: INITIATED → PENDING_COMPLIANCE → LOCKED → PENDING_EXECUTION → SETTLING → SETTLED or FAILED. SETTLED and FAILED are terminal states. Rejection at any point results in FAILED state. Each transition is logged with timestamp and decision reason. At no point is instruction state ambiguous or unobservable.

**Ledger Integrity:** Every settlement instruction produces exactly two ledger entries in Fusion's shadow ledger (DEBIT and CREDIT). These entries represent the intended instruction outcome and audit trail. Ledger invariant is verified after every write: SUM(DEBIT) = SUM(CREDIT). If invariant is violated, ledger transaction is rolled back and instruction marked FAILED. External settlement systems maintain their own authoritative records independent of Fusion's shadow ledger.

**Saga Compensation:** Multi-step settlements are handled via saga pattern with explicit compensation logic. If adapter execution fails, no ledger write is attempted. If ledger write fails after adapter execution, reversal is applied where the settlement rail supports it; otherwise, instruction is marked FAILED and reconciliation procedures are triggered. Timeouts trigger manual intervention gate requiring explicit administrator decision.

---

## Instruction Model

An instruction specifies intent, policy context, and routing information. Instruction contains: instruction_id (UUID), instruction_type (TRANSFER, DISBURSEMENT, SWAP, CONDITIONAL), asset_type (SGD, USD, BTC, SGD_Token), amount, sender_identifier, recipient_identifier, purpose (for policy evaluation), requested_rail (PAYNOW, SWIFT, CUSTODY, BROKER), and metadata (reference field, policy context).

Instruction does not contain account numbers or institution-specific secrets. These are resolved by settlement systems during execution.

---

## Regulatory Observability

Fusion exposes a read-only query API for regulatory observers (MAS). Regulatory credentials are issued out-of-band to designated regulator nodes. Regulators can observe: instruction_id, instruction_type, state, policy_permit_issued (yes/no), policy_rejection_reason (if applicable), adapter_selected, settlement_confirmed (yes/no), timestamp.

Regulators cannot observe: sender name or identifier, recipient name or identifier, instruction amount, account numbers, underlying settlement details. These remain in external settlement systems.

Observability enables regulatory verification that policy is applied consistently, that settlement proceeds only with policy permit, and that audit trail exists—without requiring access to transaction amounts or participant identities.

---

## Security Model

**Prototype (Current):** API Gateway enforces API-key–based authentication. Policy permits are HMAC-signed (software). Database credentials stored in environment variables. Ledger writes use standard PostgreSQL ACID guarantees. Saga coordination is database-backed.

**Production Requirements:** API endpoints require mutual TLS (mTLS) for server-to-server communication and OAuth 2.0 for client authentication. Policy permits are HSM-signed with hardware-backed keys. Database requires encrypted connections and encryption at rest. Ledger replication across multiple availability zones. All external adapter calls use mTLS with certificate pinning. Secrets managed via dedicated HSM or secrets vault. Instruction audit trail persisted to Byzantine-fault-tolerant governance ledger. Event streaming (Kafka or equivalent) for saga coordination. Hardware-based key management for all cryptographic operations.

**Current Limitations:** Single-instance deployment. No encryption at rest. No secrets vault integration. No HSM integration. Software-based signing unsuitable for production. Database-backed saga coordination. These are operational requirements, not architectural flaws.

---

## Technology Stack

**Backend:** Node.js 18+ runtime. TypeScript for type safety. Express.js framework. PostgreSQL 14+ for ledger and state store.

**Policy Engine:** Open Policy Agent (OPA) for rule definition and evaluation (Phase 2+). Currently policy rules embedded in application code.

**External Integration:** Adapter pattern for settlement rail abstraction. HTTP/REST for rail communication (prototype and sandbox). gRPC defined for production-phase deployment.

**Governance:** Governance event log for transaction notarization. Corda integration defined for production phase.

**Testing:** Jest for unit tests. Supertest for API integration tests. Custom test fixtures for saga scenario validation.

**Observability:** Console logging (prototype). ELK stack integration defined for later phases. Prometheus metrics for latency and error rates.

**Infrastructure (Production):** Docker for containerization. Kubernetes for orchestration. PostgreSQL with multi-AZ replication. Kafka (or equivalent event-streaming platform) for event streaming.

---

## Repository Structure

Root level contains README.md, LICENSE (MIT), package.json, tsconfig.json, .env.example.

**src/core/:** orchestrator.ts implements state machine and lifecycle. instruction.ts defines instruction model. states.ts enumerates valid transitions.

**src/policy/:** engine.ts evaluates policy rules. rules/aml.ts, sanctions.ts, velocity.ts, business.ts implement specific policy checks. permits.ts generates and signs policy permits.

**src/ledger/:** ledger.ts manages journal entries. entries.ts defines DEBIT/CREDIT entry structure. reconciliation.ts verifies ledger invariants. recovery.ts implements rollback logic.

**src/adapters/:** adapter.ts defines base adapter interface. fiat.ts, crypto.ts, wealth.ts implement settlement-specific logic. mocks/ contains simulated rail implementations for testing.

**src/api/:** routes/instructions.ts handles POST /api/instructions. routes/status.ts handles GET /api/status/:id. routes/query.ts handles GET /api/query/:id (regulator API). middleware/auth.ts, validation.ts, errorHandler.ts.

**src/config/:** database.ts initializes PostgreSQL connection. environment.ts loads configuration. constants.ts defines application constants.

**src/utils/:** logger.ts provides structured logging. errors.ts defines custom error types. crypto.ts handles HMAC and hashing.

**tests/:** unit/ contains orchestrator.test.ts, policy-engine.test.ts, ledger.test.ts. integration/ contains instruction-flow.test.ts, saga-compensation.test.ts, settlement.test.ts. fixtures/ contains mock-data.ts.

**docs/:** ARCHITECTURE.md provides detailed design. API.md documents endpoint specifications. DEPLOYMENT.md covers sandbox deployment. WHITEPAPER.pdf is authoritative technical specification.

---

## Scope and Boundaries

**In Scope:** Instruction parsing and schema validation. Policy rule evaluation. State machine management. Adapter routing logic. Instruction history recording. Policy decision audit trail.

**Out of Scope:** Asset custody. Settlement record updates. Liquidity provision. Settlement finality. External rail operations. Clearing and netting. Counterparty risk management.

**Explicitly Not Included:** Banking license. Payment system license. Real-time gross settlement (RTGS) functionality. Central bank connectivity. Cross-currency exchange. Collateral management.

---

## Installation and Setup

**Requirements:** Node.js 18+, PostgreSQL 14+, Git.

**Clone Repository:**
```
git clone https://github.com/praveenpretto-cloud/Project-Fusion.git
cd Project-Fusion
```

**Install Dependencies:**
```
npm install
```

**Configure Environment:**
```
cp .env.example .env
nano .env
```

**Set Required Variables:** NODE_ENV=development, PORT=3000, DB_HOST=localhost, DB_PORT=5432, DB_NAME=fusion_db, DB_USER=postgres, DB_PASSWORD=, API_KEY_SECRET=fusion_secure_bank_key_2025, OPA_ENDPOINT=http://localhost:8181 (Phase 2+), HSM_ENABLED=false.

**Initialize Database:**
```
createdb fusion_db
npm run migrate
```

**Start Development Server:**
```
npm run dev
```

Server listens on http://localhost:3000.

---

## API Reference

**POST /api/instructions** submits an instruction. Request headers must include X-API-Key for authentication. Request body contains instruction_id, instruction_type, asset_type, amount, sender_identifier, recipient_identifier, purpose, requested_rail, metadata. Response returns status, instruction_id, state (INITIATED), timestamp.

**GET /api/status/:instruction_id** retrieves instruction state. Request headers must include X-API-Key. Response returns instruction_id, state, initiated_at, locked_at (if applicable), settled_at (if applicable), policy_approved (boolean), policy_rejection_reason (if rejected), adapter_used, settlement_confirmed.

**GET /api/query/:instruction_id** (regulator API) retrieves observable instruction data. Request headers must include regulatory credentials issued out-of-band. Response returns instruction_id, instruction_type, state, policy_approved, adapter_selected, settlement_confirmed, timestamp. Sender/recipient identities and amounts are excluded.

**GET /health** returns liveness probe. Returns status (ok) and timestamp.

---

## Testing

**Unit Tests:**
```
npm test -- orchestrator.test.ts
npm test -- policy-engine.test.ts
npm test -- ledger.test.ts
```

**Integration Tests:**
```
npm run test:integration
```

**All Tests:**
```
npm test
```

**Coverage Report:**
```
npm test -- --coverage
```

---

## Deployment

**Local Development:** npm run dev starts single-instance server with mocked adapters and database-backed saga coordination.

**Docker:** docker build -t project-fusion:latest . builds image. docker run -p 3000:3000 -e DB_HOST=postgres -e NODE_ENV=development project-fusion:latest runs container locally.

**Sandbox Deployment:** Hardening requirements for regulated environment. Mutual TLS configuration for server-to-server connections. HSM integration for policy signing and permit verification. Governance event log setup for transaction notarization. Regulator observer node deployment for MAS visibility with out-of-band credential issuance. Daily reconciliation automation with automated alerting. Monitoring and alerting configuration for uptime and latency targets. PostgreSQL replication for ledger redundancy. See docs/DEPLOYMENT.md for detailed procedures.

**Production Deployment:** Multi-AZ database replication with automatic failover. HSM-backed key management for all cryptographic operations. Byzantine-fault-tolerant governance ledger for transaction notarization. All external adapter connections use mTLS with certificate pinning. Kubernetes deployment with horizontal pod autoscaling. OAuth 2.0 authentication for client connections. Event streaming (Kafka or equivalent) for saga coordination. Automated incident response and compensation workflows. Database encryption at rest and in transit. Secrets vault integration for credential management. Distributed tracing for request path visibility. High-availability load balancing with health checks. Automated backup and disaster recovery procedures.

---

## Phase Roadmap

This section describes architectural maturity phases. These phases represent the evolution of system capabilities and do not constitute deployment or availability commitments.

**Phase 1 (Prototype):** Core orchestration state machine. Policy gate implementation. Ledger integrity verification. Three settlement adapters (fiat, crypto, wealth). End-to-end instruction trace with audit logging. GitHub repository and documentation. Unit and integration test suite. Database-backed saga coordination.

**Phase 2 (Sandbox Readiness):** Mutual TLS configuration for server-to-server communication. HSM integration for policy signing. Open Policy Agent (OPA) deployment for externalized rule definition. Governance event log setup. Regulator observer node for read-only MAS visibility. Daily reconciliation automation with invariant verification. PostgreSQL replication setup. Monitoring and alerting infrastructure. Regulatory submission documentation.

**Phase 3 (Pilot Operation):** Live transaction processing with volume constraints. Multi-institutional settlement testing. Operation under regulatory oversight. Performance validation against defined targets. Incident response procedures validation. Settlement rail integration testing. Adapter failover and exception handling testing. Load testing and scalability validation.

**Phase 4 (Production):** Multi-AZ deployment with automatic failover. Full HSM and MPC threshold signing. Byzantine-fault-tolerant governance ledger. Horizontal scaling with auto-remediation. Database replication and backup automation. Secrets management and rotation. Encryption at rest and in transit. Distributed request tracing. Disaster recovery automation. Event streaming backbone (Kafka or equivalent).

---

## Contributing

Contributions are accepted. See docs/CONTRIBUTING.md for guidelines.

Development workflow: Fork repository, create feature branch, write tests, submit pull request. Code must pass type checking (TypeScript strict mode), linting (ESLint), and test suite (Jest, >80% coverage for core logic).

---

## License

MIT License. See LICENSE file.

---





