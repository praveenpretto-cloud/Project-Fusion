---
source_id: DOC-ISO20022-002
title: ISO 20022 camt.053 Statement Reporting & Common Schema Errors
publisher: ISO 20022 Registration Authority / SWIFT
provider: ISO20022
source_url: https://www.iso20022.org/iso-20022-message-definitions
document_version: Release-2026-Nov
last_verified_at: 2026-11-10
licensing: Technical Documentation Summary - Permitted Fair Use Attribution
---

# ISO 20022 camt.053 Statement Reporting & Common Schema Errors

## camt.053 Bank-to-Customer Statement
The `camt.053.001.08` XML message definition provides end-of-day or periodic account balance statements for accounting reconciliation:

- `Stmt` (Statement): Root statement element containing electronic bank statement identifier (`Id`) and account sequence numbers.
- `Acct` (Account): Financial institution account identifier (IBAN or proprietary account number) and currency.
- `Bal` (Balance): Opening balance (`OPBD`), closing balance (`CLBD`), and interim available balances (`ITAV`). Includes credit/debit indicator (`CdtDbtInd`) and valuation date.
- `Ntry` (Entry): Line-item journal postings detailing transaction amount, booking date, value date, credit/debit indicator, and proprietary bank transaction codes (`BkTxCd`).

## Common XML Schema Validation Errors
When parsing or validating ISO 20022 XML messages, automated validators enforce strict XSD compliance:

- `XSD_SCHEMA_VALIDATION_FAILED`: Root document violates XML schema definition.
- `MANDATORY_FIELD_MISSING`: Required elements (e.g. `MsgId`, `CreDtTm`, `EndToEndId`, `IntrBkSttlmAmt`) omitted.
- `INVALID_DECIMAL_FORMAT`: Monetary amount elements must conform to XML `xs:decimal` with exact two decimal places (or currency-specific fractional digits). Comma separators or currency symbols inside amount fields trigger syntax rejections.
- `BIC_FORMAT_INVALID`: Financial institution identifier does not match 8 or 11 character ISO 9362 standard (`^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$`).
- `IBAN_CHECKSUM_FAILED`: International Bank Account Number failed MOD-97 check digit verification.

