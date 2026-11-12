# Invoice Processor — Examples & API Reference
## Project Fusion GIFT City IFSC ISO 20022

---

## 1. CSV Input Sample (POST /api/invoice/bulk)

Send as JSON array or CSV text body. See `docs/invoice_sample.csv` for full file.

**Single CSV Row (JSON object form):**
```json
{
  "invoice_id": "INV-2025-0001",
  "invoice_date": "15/04/2025",
  "due_date": "14/07/2025",
  "total_amount": "85000.00",
  "currency": "USD",
  "seller_name": "Coimbatore Textiles Pvt Ltd",
  "seller_gstin": "33AABCC1234D1Z5",
  "seller_street": "Avinashi Road",
  "seller_building": "45-A",
  "seller_city": "Coimbatore",
  "seller_state": "Tamil Nadu",
  "seller_pincode": "641014",
  "seller_country": "IN",
  "buyer_name": "GlobalThread Inc",
  "buyer_street": "Harbor Blvd",
  "buyer_building": "1400",
  "buyer_city": "Fullerton",
  "buyer_state": "California",
  "buyer_pincode": "92831",
  "buyer_country": "US",
  "payment_terms": "50% on shipment proof and 50% on buyer acceptance",
  "payment_terms_days": "90"
}
```

---

## 2. PDF Extraction — Sample Output (POST /api/invoice/upload-pdf)

```
Form upload: curl -X POST /api/invoice/upload-pdf \
  -H "x-api-key: YOUR_KEY" \
  -F "invoice=@sample_invoice.pdf"
```

**Extracted Invoice Object (from PDF rule-based engine):**
```json
{
  "invoiceId": "INV-2025-14-A",
  "invoiceDate": "2025-04-15",
  "dueDate": "2025-07-14",
  "totalAmount": 85000.00,
  "currency": "USD",
  "seller": {
    "name": "Coimbatore Textiles Pvt Ltd",
    "gstPan": "GSTIN:33AABCC1234D1Z5|PAN:AABCC1234D",
    "structuredAddress": {
      "streetName": "Avinashi Road",
      "buildingNumber": "45-A",
      "townName": "Coimbatore",
      "countrySubDivision": "Tamil Nadu",
      "postCode": "641014",
      "country": "IN"
    }
  },
  "buyer": {
    "name": "GlobalThread Inc",
    "structuredAddress": {
      "streetName": "Harbor Blvd",
      "buildingNumber": "1400",
      "townName": "Fullerton",
      "countrySubDivision": "California",
      "postCode": "92831",
      "country": "US"
    }
  },
  "lineItems": [
    { "description": "Cotton Yarn 40s", "quantity": 100, "unitPrice": 850, "lineTotal": 85000 }
  ],
  "paymentTermsDays": 90,
  "rawConditions": "50% on shipment proof, 50% on buyer acceptance",
  "_pdfMeta": { "pages": 2, "extractionConfidence": "HIGH" }
}
```

---

## 3. Full Processing Output (POST /api/invoice/process)

**Request (JSON body):** The invoice object above.

**Response (HTTP 202):**
```json
{
  "success": true,
  "message": "Invoice processed and instructions queued for approval",
  "invoiceId": "INV-2025-0001",
  "sagaId": "SAGA-INV-4A3B2C1D5E6F7A8B",
  "isoCompliant": true,
  "hasEscrow": true,
  "totalSteps": 2,
  "instructionIds": [
    "SAGA-INV-4A3B2C1D5E6F7A8B-STEP-01",
    "SAGA-INV-4A3B2C1D5E6F7A8B-STEP-02"
  ],
  "approvalRequired": true,
  "approvalNote": "Call POST /api/instruction/approve with the instructionIds to trigger settlement",
  "sagaConfig": {
    "sagaId": "SAGA-INV-4A3B2C1D5E6F7A8B",
    "invoiceId": "INV-2025-0001",
    "totalAmount": 85000,
    "currency": "USD",
    "steps": [
      {
        "stepId": "step_1_shipment_proof",
        "amountPct": 50,
        "amountAbsolute": 42500,
        "currency": "USD",
        "rail": "stripe_or_airwallex",
        "condition": "shipment_proof",
        "triggerType": "oracle",
        "timeoutDays": 30,
        "escrow_required": true,
        "escrow_note": "[PROTOTYPE] Escrow simulated via shadow-debit on balances table...",
        "compensatingAction": "refund_hold_step_1"
      },
      {
        "stepId": "step_2_buyer_acceptance",
        "amountPct": 50,
        "amountAbsolute": 42500,
        "currency": "USD",
        "rail": "stripe_or_airwallex",
        "condition": "buyer_acceptance",
        "triggerType": "api",
        "timeoutDays": 60,
        "escrow_required": true,
        "compensatingAction": "refund_hold_step_2"
      }
    ],
    "regulatory": {
      "isoMessageType": "pacs.008.001.10",
      "femaReporting": {
        "required": true,
        "section": "FEMA_SEC_10_IBU",
        "threshold": "$25,000"
      },
      "purposeCode": "IVPT",
      "giftIFSCPSR2024": true,
      "escrowNote": "[PROTOTYPE] Conditional holds shadow-debited on balances table. Production requires IBU escrow at GIFT City."
    },
    "iso20022": {
      "messageType": "pacs.008.001.10",
      "remittanceInfo": {
        "RmtInf": {
          "Strd": {
            "RfrdDocInf": {
              "Tp": { "CdOrPrtry": { "Cd": "CINV" } },
              "Nb": "INV-2025-0001"
            }
          }
        },
        "PurpCd": "IVPT"
      },
      "femaReporting": { "required": true, "section": "FEMA_SEC_10_IBU" }
    }
  }
}
```

---

## 4. Triggering Settlement After Approval

After receiving `instructionIds`, call the existing approval endpoint:

```bash
curl -X POST http://localhost:3000/api/instruction/approve \
  -H "x-api-key: YOUR_KEY" \
  -H "x-idempotency-key: APPROVE-INV-2025-0001" \
  -H "Content-Type: application/json" \
  -d '{
    "instructionIds": [
      "SAGA-INV-4A3B2C1D5E6F7A8B-STEP-01",
      "SAGA-INV-4A3B2C1D5E6F7A8B-STEP-02"
    ],
    "approved_by": "compliance_officer_001"
  }'
```

Response: Triggers `processInstructionSagaAtomic()` for each step.

---

## 5. Edge Cases Handled

| Scenario | Behaviour |
|---|---|
| Missing address fields | ISO enrichment fails with validation errors; sagaConfig still created |
| `rawConditions: ""` | Default exporter rules applied (80% hold → 10% shipment → 10% acceptance) |
| `paymentTermsDays: 60` | Net 60 due_date trigger generated |
| `paymentTermsDays: 90` | Net 90 due_date trigger generated |
| INR currency on escrow step | `⚠️ GIFT IFSC PSR 2024 prohibits INR e-wallets for conditional holds` logged |
| `totalAmount > $25,000` | `FEMA_SEC_10_IBU` reporting flag set in ISO enrichment |
| Duplicate `invoiceId` submitted | `ON CONFLICT DO NOTHING` in DB — saga config remains unchanged |
| Bulk CSV of 500+ rows | Chunked at 50 per batch with `setImmediate()` yield — non-blocking |
| PDF with LOW confidence | Returns data + `⚠️ Extraction confidence is not HIGH — please review` warning |
| Same `invoiceId` re-processed | Same `sagaId` returned (SHA-256 deterministic hash — idempotent) |
