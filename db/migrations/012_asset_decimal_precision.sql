-- =============================================================================
-- Migration: 012_asset_decimal_precision.sql
-- Purpose: Elevate financial amounts to NUMERIC(38,7) to support 7-decimal assets (XLM)
--          and ensure lossless institutional precision across double-entry ledger.
-- =============================================================================

DO $$
BEGIN
    -- 1. Elevate ledger_journal amount to NUMERIC(38,7)
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'ledger_journal' AND column_name = 'amount'
    ) THEN
        ALTER TABLE ledger_journal ALTER COLUMN amount TYPE NUMERIC(38, 7);
    END IF;

    -- 2. Elevate instructions amount, tax_withheld, and net_amount to NUMERIC(38,7)
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'instructions'
    ) THEN
        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'instructions' AND column_name = 'amount'
        ) THEN
            ALTER TABLE instructions ALTER COLUMN amount TYPE NUMERIC(38, 7);
        END IF;

        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'instructions' AND column_name = 'tax_withheld'
        ) THEN
            ALTER TABLE instructions ALTER COLUMN tax_withheld TYPE NUMERIC(38, 7);
        END IF;

        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'instructions' AND column_name = 'net_amount'
        ) THEN
            ALTER TABLE instructions ALTER COLUMN net_amount TYPE NUMERIC(38, 7);
        END IF;
    END IF;

    -- 3. Elevate balances balance to NUMERIC(38,7)
    -- Drop dependent view first if present, then recreate after type alteration
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'balances' AND column_name = 'balance'
    ) THEN
        DROP VIEW IF EXISTS fusion_virtual_balances CASCADE;

        ALTER TABLE balances ALTER COLUMN balance TYPE NUMERIC(38, 7);

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
END $$;
