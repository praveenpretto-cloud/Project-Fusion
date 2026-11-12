-- =============================================================================
-- Migration: 008_saga_schema_alignment.sql
-- Purpose: Schema alignment for Saga execution, transaction references, and ledger ordering
-- =============================================================================

-- 1. Instructions: execution_attempts tracking
ALTER TABLE instructions ADD COLUMN IF NOT EXISTS execution_attempts INTEGER DEFAULT 0;
UPDATE instructions SET execution_attempts = 0 WHERE execution_attempts IS NULL;
ALTER TABLE instructions ALTER COLUMN execution_attempts SET NOT NULL;
ALTER TABLE instructions ALTER COLUMN execution_attempts SET DEFAULT 0;

ALTER TABLE instructions DROP CONSTRAINT IF EXISTS chk_instructions_execution_attempts;
ALTER TABLE instructions ADD CONSTRAINT chk_instructions_execution_attempts CHECK (execution_attempts >= 0);

-- 2. Instructions: utr / provider settlement reference
ALTER TABLE instructions ADD COLUMN IF NOT EXISTS utr VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_instructions_utr ON instructions(utr) WHERE utr IS NOT NULL;

-- 3. Instructions: required approvals
ALTER TABLE instructions ADD COLUMN IF NOT EXISTS required_approvals INTEGER DEFAULT 1;

-- 4. Ledger Journal: Monotonic sequence_id for hash chain ordering
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ledger_journal' AND column_name = 'sequence_id'
    ) THEN
        ALTER TABLE ledger_journal ADD COLUMN sequence_id BIGSERIAL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ledger_journal_sequence_id ON ledger_journal(sequence_id);

-- 5. Business Bank Accounts: Overdraft limit for liquidity check
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'business_bank_accounts'
    ) THEN
        ALTER TABLE business_bank_accounts ADD COLUMN IF NOT EXISTS od_limit NUMERIC(15, 2) DEFAULT 2000000.00;
    END IF;
END $$;

-- 6. Sanctions List for Guardian AML screening
CREATE TABLE IF NOT EXISTS sanctions_list (
    address_or_id VARCHAR(255) PRIMARY KEY,
    entity_name   VARCHAR(255) NOT NULL,
    reason        TEXT,
    risk_level    VARCHAR(50) DEFAULT 'HIGH',
    created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sanctions_address ON sanctions_list(address_or_id);

