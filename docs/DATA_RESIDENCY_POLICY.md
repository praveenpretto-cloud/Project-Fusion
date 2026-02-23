# Data Residency & Localisation Policy
**Project Fusion | Version 1.0 | February 2026**

---

## 1. Purpose
This document defines Project Fusion's policy on data storage, processing, and residency to comply with the **International Financial Services Centres Authority (IFSCA)** guidelines and the **Reserve Bank of India (RBI)** Payment System Data Storage Policy (October 2018).

---

## 2. Scope
This policy applies to all data processed by the Project Fusion platform, including:
- Payment instruction data
- Ledger records
- User identity references
- Transaction audit logs

---

## 3. Data Classification

| Data Type | Description | Residency Requirement |
| :--- | :--- | :--- |
| **Payment System Data** | Full transaction details, sender/recipient identifiers | **India Only** |
| **Audit Logs** | Cryptographic hash chain, state transitions | **India Only** |
| **Encryption Keys** | Master seed, API keys | **India Only (HSM/KMS)** |
| **Aggregated Analytics** | Non-PII performance metrics (Prometheus) | India or Global |

---

## 4. Data Localisation Commitment

Project Fusion commits to the following for all production deployments:

1. **Primary Database**: PostgreSQL hosted exclusively on **AWS Mumbai (ap-south-1)** or **Azure India Central** region.
2. **Key Management**: Encryption keys and secrets stored in **AWS KMS (Mumbai region)** or equivalent India-resident Hardware Security Module (HSM).
3. **Audit Logs**: All ledger hash chain records stored on India-resident infrastructure.
4. **Cross-Border Data Transfers**: Only aggregated, non-PII analytical data may be processed outside India for monitoring purposes.
5. **No Offshore Storage**: No full-cycle payment data will be stored on servers outside the Republic of India.

---

## 5. Regulatory References

- **RBI Payment System Data Storage Policy** (April 6, 2018 Circular)
- **IFSCA (Banking) Regulations, 2020** — Section on Technology and Data Management
- **PDPB (Personal Data Protection Bill)** — Sensitive Financial Data handling provisions

---

## 6. Compliance Controls in Code

The following technical controls enforce this policy at the application layer:

| Control | Implementation | File |
| :--- | :--- | :--- |
| PII Redaction in Logs | `REDACT_LOGS=true` environment flag | `logger.js` |
| Data Hashing | Sender/Recipient stored as SHA-256 hashes | `server.js` (writeLedger) |
| Key Isolation | No plaintext keys in logs or API responses | `vaultProvider.js` |
| Audit Trail | Immutable cryptographic hash chain | `server.js` (hash_chain column) |

---

## 7. Review & Certification
This policy will be reviewed annually or upon any major infrastructure change.

**Policy Owner**: Founder / CTO, Project Fusion
**Effective Date**: Upon production deployment
