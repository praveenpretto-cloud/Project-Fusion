-- Migration: Add hash chain columns to ledger_journal
-- Purpose: Enable blockchain-like tamper evidence

ALTER TABLE ledger_journal 
ADD COLUMN IF NOT EXISTS hash VARCHAR(64),
ADD COLUMN IF NOT EXISTS prev_hash VARCHAR(64);

-- Create index for faster chain verification
CREATE INDEX IF NOT EXISTS idx_ledger_prev_hash ON ledger_journal(prev_hash);
