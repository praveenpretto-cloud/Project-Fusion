---
source_id: DOC-ISO20022-001
title: ISO 20022 pacs.008 Credit Transfer & SWIFT CBPR+ Postal Address Specifications
publisher: SWIFT / Payments Market Practice Group (PMPG)
provider: ISO20022
source_url: https://www.swift.com/standards/iso-20022/cbpr
document_version: Release-2026-CBPR+
last_verified_at: 2026-11-10
licensing: Authoritative Technical Summary - Permitted Fair Use Attribution
---

# ISO 20022 pacs.008 Credit Transfer & SWIFT CBPR+ Postal Address Specifications

## pacs.008 Customer Credit Transfer Message Architecture

The `pacs.008.001.08` XML message definition standardizes financial customer credit transfers across international and domestic clearing corridors:

- `GrpHdr` (Group Header): Contains message identifier (`MsgId`), creation timestamp (`CreDtTm`), number of transactions (`NbOfTxs`), and initiating settlement agent (`SttlmInf`).
- `CdtTrfTxInf` (Credit Transfer Transaction Information): Core settlement segment for each payment instruction.
    - `PmtId`: End-to-End Identification (`EndToEndId`) and Unique End-to-End Transaction Reference (`UETR`).
    - `IntrBkSttlmAmt`: Interbank settlement amount and ISO 4217 three-letter currency code.
    - `Dbtr` & `DbtrAgt`: Originator debtor entity identification and debtor agent BICFI.
    - `Cdtr` & `CdtrAgt`: Beneficiary creditor entity identification and creditor agent BICFI.

## SWIFT CBPR+ Postal Address Rules: Structured, Hybrid, and Market Infrastructure Mandates

Under ISO 20022 standards and SWIFT CBPR+ (Cross-Border Payments and Reporting Plus) guidelines, postal address handling distinguishes three distinct formats and rules:

1. **Universal Minimum Mandatory Requirements (Town Name & Country):**
    - In any structured or hybrid `PstlAdr` element, `Ctry` (Country Code, ISO 3166-1 alpha-2) and `TwnNm` (Town Name) are the universal mandatory geographic anchors.
    - Any message lacking `TwnNm` or `Ctry` violates CBPR+ baseline specifications.

2. **Hybrid Address Format:**
    - Permitted during the transition period to support gradual industry migration.
    - Mandates separate structured `Ctry` and `TwnNm` tags, while allowing remaining address components (street name, building number, postal code) to reside in up to two unstructured address lines (`AdrLine`, maximum 70 characters each).

3. **Fully Structured Address Format:**
    - Completely outlaws `AdrLine` unstructured lines.
    - Decomposes addresses into dedicated XML tags: `StrtNm` (Street Name), `BldgNb` (Building Number) or `BldgNm` (Building Name), `PstCd` (Postal Code), `TwnNm` (Town Name), `Ctry` (Country Code), `DstrctNm` (District Name), and `CtrySubDvsn` (Country Sub-Division / State).

4. **CBPR+ Baseline vs Domestic Clearing / Local Schema Mandates:**
    - Under general CBPR+ baseline, `StrtNm` is NOT universally mandatory in all addresses globally (e.g. post office box addresses, rural areas without street names).
    - However, specific domestic market infrastructures (e.g. US CHIPS, FedNow, UK CHAPS) and bilateral enterprise validation schemas (such as Project Fusion's internal validator `MANDATORY_STRUCTURED_ADDRESS_SYNTAX`) mandate `StrtNm` when clearing physical street addresses.
    - Operations teams must distinguish a local market-infrastructure or invoice validation schema rule from the general cross-border CBPR+ baseline.

5. **Syntactic Formatting vs Regulatory Non-Compliance:**
    - A schema validation failure (e.g. missing `streetName` or malformed address tags) represents a technical data formatting rejection under clearing house rules. It does not constitute evidence of AML, financial sanctions, or legal non-compliance.
