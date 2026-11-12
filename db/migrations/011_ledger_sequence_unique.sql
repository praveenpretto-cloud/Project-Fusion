-- =============================================================================
-- Migration: 011_ledger_sequence_unique.sql
-- Purpose: Enforce strict NOT NULL and UNIQUE database constraints on 
--          ledger_journal.sequence_id to guarantee deterministic monotonicity.
-- =============================================================================

DO $$
BEGIN
    -- 1. Ensure sequence_id is NOT NULL
    ALTER TABLE ledger_journal ALTER COLUMN sequence_id SET NOT NULL;

    -- 2. Enforce UNIQUE constraint on sequence_id
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE table_name = 'ledger_journal' 
          AND constraint_name = 'uq_ledger_journal_sequence_id'
    ) THEN
        ALTER TABLE ledger_journal 
            ADD CONSTRAINT uq_ledger_journal_sequence_id UNIQUE (sequence_id);
        RAISE NOTICE 'Added UNIQUE constraint uq_ledger_journal_sequence_id to ledger_journal.';
    END IF;
END $$;
