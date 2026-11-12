-- =============================================================================
-- Migration: 010_ledger_timestamptz.sql
-- Purpose: Convert ledger_journal.timestamp from TIMESTAMP WITHOUT TIME ZONE to TIMESTAMPTZ.
-- Audit Verification: Historical timestamps in ledger_journal were generated using 
-- Date.prototype.toISOString() in writeLedger and therefore represent UTC instant values.
-- Converting via USING (timestamp AT TIME ZONE 'UTC') preserves exact UTC epoch representation
-- without mutating any stored cryptographic hashes.
-- =============================================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'ledger_journal' 
          AND column_name = 'timestamp' 
          AND data_type = 'timestamp without time zone'
    ) THEN
        ALTER TABLE ledger_journal 
            ALTER COLUMN timestamp TYPE TIMESTAMPTZ 
            USING (timestamp AT TIME ZONE 'UTC');
        RAISE NOTICE 'ledger_journal.timestamp successfully converted to TIMESTAMPTZ.';
    END IF;
END $$;
