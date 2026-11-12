-- =============================================================================
-- Migration: 007_invoice_pipeline.sql
-- Purpose: Authoritative migration for the invoice parsing and saga steps pipeline
-- =============================================================================

CREATE TABLE IF NOT EXISTS invoices (
    invoice_id          VARCHAR(100)    PRIMARY KEY,
    saga_id             VARCHAR(100),
    invoice_date        DATE,
    due_date            DATE,
    total_amount        DECIMAL(20, 4),
    currency            VARCHAR(10),
    seller_name         VARCHAR(255),
    seller_gst_pan      VARCHAR(100),
    buyer_name          VARCHAR(255),
    payment_terms_days  INTEGER         DEFAULT 90,
    -- Full ISO 20022 enriched object: pacs.008 envelope, remittance info, FEMA flags
    iso_enriched        JSONB           DEFAULT '{}',
    -- Full saga config: steps, instructions, escrow flags
    saga_config         JSONB           DEFAULT '{}',
    raw_conditions      TEXT,
    -- Invoice state machine: PARSED → PENDING_APPROVAL → IN_PROGRESS → SETTLED | FAILED
    state               VARCHAR(50)     DEFAULT 'PARSED',
    -- Source: 'csv', 'pdf', 'object'
    source_type         VARCHAR(20)     DEFAULT 'object',
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_saga_id ON invoices (saga_id);
CREATE INDEX IF NOT EXISTS idx_invoices_state ON invoices (state);

CREATE TABLE IF NOT EXISTS invoice_saga_steps (
    id              SERIAL          PRIMARY KEY,
    invoice_id      VARCHAR(100)    REFERENCES invoices(invoice_id) ON DELETE CASCADE,
    step_id         VARCHAR(100)    NOT NULL,
    amount_pct      DECIMAL(5, 2),
    condition       VARCHAR(255),
    rail            VARCHAR(50),
    -- Step state: PENDING → IN_PROGRESS → COMPLETED | FAILED | ROLLED_BACK
    status          VARCHAR(50)     DEFAULT 'PENDING',
    -- GIFT IFSC PSR 2024: flags conditional holds requiring IBU escrow activity
    escrow_flagged  BOOLEAN         DEFAULT FALSE,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    UNIQUE(invoice_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_invoice_saga_steps_invoice_id ON invoice_saga_steps (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_saga_steps_status ON invoice_saga_steps (status);

