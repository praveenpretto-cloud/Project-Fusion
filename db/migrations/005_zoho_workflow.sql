-- ═══════════════════════════════════════════════════════════════════
-- MIGRATION 005: Zoho Workflow Pipeline
-- Adds: zoho_invoice_id + source columns, compliance_documents table,
--       reconciliation_log table
-- Run: psql -d fusion_db -f db/migrations/005_zoho_workflow.sql
-- ═══════════════════════════════════════════════════════════════════

-- 1. Add Zoho tracking columns to instructions table
ALTER TABLE instructions
    ADD COLUMN IF NOT EXISTS zoho_invoice_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'api';

CREATE INDEX IF NOT EXISTS idx_instructions_zoho_invoice_id
    ON instructions(zoho_invoice_id)
    WHERE zoho_invoice_id IS NOT NULL;

-- 2. Compliance Documents Vault
CREATE TABLE IF NOT EXISTS compliance_documents (
    doc_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instruction_id  VARCHAR(255) REFERENCES instructions(instruction_id) ON DELETE CASCADE,
    zoho_invoice_id VARCHAR(100),
    doc_type        VARCHAR(30) NOT NULL
                    CHECK (doc_type IN ('FIRC', 'eBRC', 'FEMA_DECL', 'TDS_CERT')),
    doc_payload     JSONB NOT NULL,
    generated_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compliance_docs_instruction
    ON compliance_documents(instruction_id);

CREATE INDEX IF NOT EXISTS idx_compliance_docs_zoho
    ON compliance_documents(zoho_invoice_id)
    WHERE zoho_invoice_id IS NOT NULL;

-- 3. Reconciliation Log
CREATE TABLE IF NOT EXISTS reconciliation_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instruction_id  VARCHAR(255) REFERENCES instructions(instruction_id) ON DELETE CASCADE,
    zoho_invoice_id VARCHAR(100),
    zoho_payment_id VARCHAR(100),
    reconciled_at   TIMESTAMP,
    status          VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'RECONCILED', 'FAILED', 'SKIPPED')),
    error_message   TEXT,
    created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_instruction
    ON reconciliation_log(instruction_id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_status
    ON reconciliation_log(status)
    WHERE status IN ('PENDING', 'FAILED');
