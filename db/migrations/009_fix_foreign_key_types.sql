-- =============================================================================
-- Migration: 009_fix_foreign_key_types.sql
-- Purpose: Forward-only migration to safely validate and upgrade foreign-key 
--          columns (transaction_id, instruction_id) to UUID across routing_ledger,
--          compliance_documents, and reconciliation_log.
-- =============================================================================

DO $$
DECLARE
    invalid_count INTEGER;
    orphan_count  INTEGER;
    col_type      TEXT;
BEGIN
    -- ─────────────────────────────────────────────────────────────────────────
    -- 1. Table: routing_ledger (column: transaction_id)
    -- ─────────────────────────────────────────────────────────────────────────
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'routing_ledger') THEN
        SELECT data_type INTO col_type 
        FROM information_schema.columns 
        WHERE table_name = 'routing_ledger' AND column_name = 'transaction_id';

        IF col_type <> 'uuid' THEN
            -- Check for invalid non-UUID formats
            SELECT COUNT(*) INTO invalid_count 
            FROM routing_ledger 
            WHERE transaction_id IS NOT NULL 
              AND transaction_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

            IF invalid_count > 0 THEN
                RAISE EXCEPTION 'MIGRATION_ABORT: routing_ledger contains % non-UUID transaction_id values. Aborting to prevent data corruption.', invalid_count;
            END IF;

            -- Check for orphaned references
            SELECT COUNT(*) INTO orphan_count 
            FROM routing_ledger r
            WHERE r.transaction_id IS NOT NULL 
              AND NOT EXISTS (
                  SELECT 1 FROM instructions i 
                  WHERE i.instruction_id::text = r.transaction_id::text
              );

            IF orphan_count > 0 THEN
                RAISE EXCEPTION 'MIGRATION_ABORT: routing_ledger contains % orphaned foreign-key references. Aborting to protect referential integrity.', orphan_count;
            END IF;

            -- Safe conversion
            ALTER TABLE routing_ledger DROP CONSTRAINT IF EXISTS routing_ledger_transaction_id_fkey;
            ALTER TABLE routing_ledger ALTER COLUMN transaction_id TYPE UUID USING transaction_id::uuid;
            ALTER TABLE routing_ledger ADD CONSTRAINT routing_ledger_transaction_id_fkey 
                FOREIGN KEY (transaction_id) REFERENCES instructions(instruction_id);
            CREATE INDEX IF NOT EXISTS idx_routing_ledger_transaction_id ON routing_ledger(transaction_id);
            RAISE NOTICE 'routing_ledger.transaction_id successfully converted to UUID with foreign key constraint.';
        ELSE
            -- Ensure foreign key constraint is present if already UUID
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.table_constraints 
                WHERE constraint_name = 'routing_ledger_transaction_id_fkey'
            ) THEN
                ALTER TABLE routing_ledger ADD CONSTRAINT routing_ledger_transaction_id_fkey 
                    FOREIGN KEY (transaction_id) REFERENCES instructions(instruction_id);
            END IF;
            CREATE INDEX IF NOT EXISTS idx_routing_ledger_transaction_id ON routing_ledger(transaction_id);
        END IF;
    END IF;

    -- ─────────────────────────────────────────────────────────────────────────
    -- 2. Table: compliance_documents (column: instruction_id)
    -- ─────────────────────────────────────────────────────────────────────────
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'compliance_documents') THEN
        SELECT data_type INTO col_type 
        FROM information_schema.columns 
        WHERE table_name = 'compliance_documents' AND column_name = 'instruction_id';

        IF col_type <> 'uuid' THEN
            -- Check for invalid non-UUID formats
            SELECT COUNT(*) INTO invalid_count 
            FROM compliance_documents 
            WHERE instruction_id IS NOT NULL 
              AND instruction_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

            IF invalid_count > 0 THEN
                RAISE EXCEPTION 'MIGRATION_ABORT: compliance_documents contains % non-UUID instruction_id values. Aborting to prevent data corruption.', invalid_count;
            END IF;

            -- Check for orphaned references
            SELECT COUNT(*) INTO orphan_count 
            FROM compliance_documents c
            WHERE c.instruction_id IS NOT NULL 
              AND NOT EXISTS (
                  SELECT 1 FROM instructions i 
                  WHERE i.instruction_id::text = c.instruction_id::text
              );

            IF orphan_count > 0 THEN
                RAISE EXCEPTION 'MIGRATION_ABORT: compliance_documents contains % orphaned foreign-key references. Aborting to protect referential integrity.', orphan_count;
            END IF;

            -- Safe conversion
            ALTER TABLE compliance_documents DROP CONSTRAINT IF EXISTS compliance_documents_instruction_id_fkey;
            ALTER TABLE compliance_documents ALTER COLUMN instruction_id TYPE UUID USING instruction_id::uuid;
            ALTER TABLE compliance_documents ADD CONSTRAINT compliance_documents_instruction_id_fkey 
                FOREIGN KEY (instruction_id) REFERENCES instructions(instruction_id) ON DELETE CASCADE;
            CREATE INDEX IF NOT EXISTS idx_compliance_docs_instruction ON compliance_documents(instruction_id);
            RAISE NOTICE 'compliance_documents.instruction_id successfully converted to UUID with foreign key constraint.';
        ELSE
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.table_constraints 
                WHERE constraint_name = 'compliance_documents_instruction_id_fkey'
            ) THEN
                ALTER TABLE compliance_documents ADD CONSTRAINT compliance_documents_instruction_id_fkey 
                    FOREIGN KEY (instruction_id) REFERENCES instructions(instruction_id) ON DELETE CASCADE;
            END IF;
            CREATE INDEX IF NOT EXISTS idx_compliance_docs_instruction ON compliance_documents(instruction_id);
        END IF;
    END IF;

    -- ─────────────────────────────────────────────────────────────────────────
    -- 3. Table: reconciliation_log (column: instruction_id)
    -- ─────────────────────────────────────────────────────────────────────────
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'reconciliation_log') THEN
        SELECT data_type INTO col_type 
        FROM information_schema.columns 
        WHERE table_name = 'reconciliation_log' AND column_name = 'instruction_id';

        IF col_type <> 'uuid' THEN
            -- Check for invalid non-UUID formats
            SELECT COUNT(*) INTO invalid_count 
            FROM reconciliation_log 
            WHERE instruction_id IS NOT NULL 
              AND instruction_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

            IF invalid_count > 0 THEN
                RAISE EXCEPTION 'MIGRATION_ABORT: reconciliation_log contains % non-UUID instruction_id values. Aborting to prevent data corruption.', invalid_count;
            END IF;

            -- Check for orphaned references
            SELECT COUNT(*) INTO orphan_count 
            FROM reconciliation_log r
            WHERE r.instruction_id IS NOT NULL 
              AND NOT EXISTS (
                  SELECT 1 FROM instructions i 
                  WHERE i.instruction_id::text = r.instruction_id::text
              );

            IF orphan_count > 0 THEN
                RAISE EXCEPTION 'MIGRATION_ABORT: reconciliation_log contains % orphaned foreign-key references. Aborting to protect referential integrity.', orphan_count;
            END IF;

            -- Safe conversion
            ALTER TABLE reconciliation_log DROP CONSTRAINT IF EXISTS reconciliation_log_instruction_id_fkey;
            ALTER TABLE reconciliation_log ALTER COLUMN instruction_id TYPE UUID USING instruction_id::uuid;
            ALTER TABLE reconciliation_log ADD CONSTRAINT reconciliation_log_instruction_id_fkey 
                FOREIGN KEY (instruction_id) REFERENCES instructions(instruction_id) ON DELETE CASCADE;
            CREATE INDEX IF NOT EXISTS idx_reconciliation_instruction ON reconciliation_log(instruction_id);
            RAISE NOTICE 'reconciliation_log.instruction_id successfully converted to UUID with foreign key constraint.';
        ELSE
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.table_constraints 
                WHERE constraint_name = 'reconciliation_log_instruction_id_fkey'
            ) THEN
                ALTER TABLE reconciliation_log ADD CONSTRAINT reconciliation_log_instruction_id_fkey 
                    FOREIGN KEY (instruction_id) REFERENCES instructions(instruction_id) ON DELETE CASCADE;
            END IF;
            CREATE INDEX IF NOT EXISTS idx_reconciliation_instruction ON reconciliation_log(instruction_id);
        END IF;
    END IF;
END $$;
