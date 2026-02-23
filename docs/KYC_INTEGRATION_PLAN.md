# KYC (Know Your Customer) Integration Plan
**Project Fusion | Version 1.0 | February 2026**

---

## 1. Purpose
This document describes Project Fusion's plan for integrating Customer Identity Verification (KYC) and Anti-Money Laundering (AML) checks, as required by the **IFSCA Regulatory Sandbox** and **RBI KYC Master Direction, 2016 (updated 2023)**.

---

## 2. Current State (Prototype)
The current prototype simulates user identity via alphanumeric `sender` and `recipient` identifiers. This is sufficient for the **Proof-of-Concept** stage and is not used in live financial transactions.

---

## 3. Production KYC Architecture

### Phase 1: Onboarding KYC (Before First Transaction)
Every user must complete identity verification before being allowed to initiate a transaction.

```
User → Fusion Onboarding API
         ↓
    KYC Provider (DigiLocker / CKYC)
         ↓
    Verified → Assign user a `verified_hash` (SHA-256 of PAN/Aadhaar)
         ↓
    Store verification status in DB (not raw PII)
```

### Phase 2: Transaction-Time AML Check
Every transaction passes through the existing `policyEngine.js`, which will be extended to call an AML screening API.

---

## 4. KYC Partner Options

| Provider | Method | Regulatory Basis | Integration Effort |
| :--- | :--- | :--- | :--- |
| **DigiLocker** (Government) | Aadhaar-based eKYC | RBI circular, UIDAI approved | Medium (OAuth2 + REST) |
| **CKYC Registry (CDSL)** | Central KYC via PAN | SEBI/RBI compliant | Medium (SOAP API) |
| **Setu (Pine Labs)** | Ready-made KYC API | Uses DigiLocker/CKYC underneath | Low (REST API, 3-5 days) |
| **Signzy** | Video KYC + Document OCR | RBI Video KYC guidelines | Low (REST API) |

**Recommended for IFSCA Sandbox**: **Setu** or **Signzy** — both are RBI-licensed, have sandbox environments, and integrate in <1 week.

---

## 5. Data Handling for KYC

Following the RBI KYC Master Direction, raw PII (Aadhaar, PAN, Passport) will **never be stored** in the Project Fusion database. Only the following are retained:

| Stored | Not Stored |
| :--- | :--- |
| `kyc_status`: VERIFIED / PENDING / REJECTED | Full Aadhaar number |
| `kyc_verified_at`: Timestamp | PAN card image |
| `kyc_reference_id`: UUID from provider | Passport scan |
| `verified_hash`: SHA-256 of PAN (for deduplication) | Date of Birth |

---

## 6. AML Controls (Already Implemented)

The following AML controls are **already live** in the codebase:

| Control | Location | Description |
| :--- | :--- | :--- |
| Transaction Threshold Check | `policyEngine.js` (Rule 2) | Auto-rejects transactions > $100,000 |
| PBM Voucher Restriction | `policyEngine.js` (Rule 1) | Enforces purpose-bound money rules |
| Idempotency Guard | `server.js` | Prevents replay attacks and double-spending |
| Cryptographic Audit Trail | `server.js` (hash_chain) | Immutable evidence for AML investigations |

---

## 7. Implementation Timeline (Post-Sandbox Approval)

| Week | Milestone |
| :--- | :--- |
| Week 1 | Integrate **Setu KYC API** into onboarding flow |
| Week 2 | Connect `policyEngine.js` to external AML screening (e.g., Dow Jones / ComplyAdvantage) |
| Week 3 | User acceptance testing with sandbox users |
| Week 4 | Submit compliance evidence to IFSCA for live approval |

---

## 8. Regulatory Commitment
Project Fusion commits that **no real user funds will be processed until KYC verification is complete** for every user in the system. The sandbox phase will use only test identities and simulated transactions.
