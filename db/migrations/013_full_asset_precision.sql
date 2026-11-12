-- =============================================================================
-- Migration: 013_full_asset_precision.sql
-- Purpose: Elevate financial amounts to NUMERIC(56,18) across instructions,
--          balances, ledger_journal, and invoices to support 18-decimal assets (ETH)
--          and exact institutional precision for all digital/fiat currencies.
--          Explicitly preserves dependent view without relying on broad CASCADE.
-- =============================================================================

DO $$
BEGIN
    -- 1. Elevate ledger_journal amount to NUMERIC(56, 18)
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'ledger_journal' AND column_name = 'amount'
    ) THEN
        ALTER TABLE ledger_journal ALTER COLUMN amount TYPE NUMERIC(56, 18);
    END IF;

    -- 2. Elevate instructions amount, tax_withheld, and net_amount to NUMERIC(56, 18)
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'instructions'
    ) THEN
        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'instructions' AND column_name = 'amount'
        ) THEN
            ALTER TABLE instructions ALTER COLUMN amount TYPE NUMERIC(56, 18);
        END IF;

        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'instructions' AND column_name = 'tax_withheld'
        ) THEN
            ALTER TABLE instructions ALTER COLUMN tax_withheld TYPE NUMERIC(56, 18);
        END IF;

        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'instructions' AND column_name = 'net_amount'
        ) THEN
            ALTER TABLE instructions ALTER COLUMN net_amount TYPE NUMERIC(56, 18);
        END IF;
    END IF;

    -- 3. Elevate balances balance to NUMERIC(56, 18)
    -- Explicitly drop dependent view fusion_virtual_balances (WITHOUT CASCADE) to avoid silent drops of other objects
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'balances' AND column_name = 'balance'
    ) THEN
        DROP VIEW IF EXISTS fusion_virtual_balances;

        ALTER TABLE balances ALTER COLUMN balance TYPE NUMERIC(56, 18);

        -- Explicitly recreate fusion_virtual_balances view
        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'balances' AND column_name = 'is_treasury'
        ) THEN
            EXECUTE 'CREATE OR REPLACE VIEW fusion_virtual_balances AS
                     SELECT account_id, currency, balance AS virtual_balance, is_treasury, updated_at
                     FROM balances WHERE provider = ''FUSION_VIRTUAL''';
        ELSE
            EXECUTE 'CREATE OR REPLACE VIEW fusion_virtual_balances AS
                     SELECT account_id, currency, balance AS virtual_balance, updated_at
                     FROM balances WHERE provider = ''FUSION_VIRTUAL''';
        END IF;
    END IF;

    -- 4. Elevate invoices total_amount to NUMERIC(56, 18) if invoices table exists
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'invoices' AND column_name = 'total_amount'
    ) THEN
        ALTER TABLE invoices ALTER COLUMN total_amount TYPE NUMERIC(56, 18);
    END IF;
END $$;

