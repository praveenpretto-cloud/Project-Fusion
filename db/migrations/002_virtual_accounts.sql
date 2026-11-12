-- Migration 002: Virtual Account Model (White-Label Aggregator)
-- Purpose: Pivot from BYOK to Fusion-managed Virtual Accounts.
-- Users no longer connect their own gateway keys. Fusion manages
-- all rails via master credentials. Each user has a single
-- 'FUSION_VIRTUAL' balance entry in the balances table.
--
-- Run with: psql -d fusion_db -f db/migrations/002_virtual_accounts.sql

-- =====================================================
-- STEP 1: DROP BYOK CLIENT VAULT TABLE
-- Users no longer upload their own API keys.
-- Fusion master credentials (in .env) are used for all rails.
-- =====================================================
DROP TABLE IF EXISTS client_vaults CASCADE;

-- =====================================================
-- STEP 2: ADD is_treasury COLUMN (IF NOT EXISTS)
-- Some columns may have been added via server-side ALTER already.
-- =====================================================
ALTER TABLE balances ADD COLUMN IF NOT EXISTS is_treasury BOOLEAN DEFAULT FALSE;

-- =====================================================
-- STEP 3: SEED VIRTUAL ACCOUNTS FOR EXISTING DEMO USERS
-- Each user gets a FUSION_VIRTUAL balance row to represent
-- their internal Fusion balance. Seeded with a starting amount
-- so the demo runs immediately without needing a top-up first.
-- =====================================================
INSERT INTO balances (account_id, provider, currency, balance, is_treasury, updated_at)
VALUES
    ('Alice_Corp',       'FUSION_VIRTUAL', 'USD', 50000.00, FALSE, NOW()),
    ('Bob_Supply',       'FUSION_VIRTUAL', 'USD', 25000.00, FALSE, NOW()),
    ('Alice_Wallet',     'FUSION_VIRTUAL', 'USD', 10000.00, FALSE, NOW()),
    ('Bob_ColdStorage',  'FUSION_VIRTUAL', 'USD',  5000.00, FALSE, NOW()),
    -- Master treasury accounts (Fusion's own operating balances)
    ('FUSION_MASTER',    'FUSION_VIRTUAL', 'USD', 999999999.00, TRUE,  NOW()),
    ('FUSION_MASTER',    'FUSION_VIRTUAL', 'INR', 999999999.00, TRUE,  NOW()),
    ('FUSION_MASTER',    'FUSION_VIRTUAL', 'XLM', 999999999.00, TRUE,  NOW())
ON CONFLICT (account_id, provider, currency) DO NOTHING;

-- =====================================================
-- STEP 4: INDEX FOR FAST VIRTUAL BALANCE LOOKUPS
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_balances_virtual
    ON balances(account_id, provider, currency)
    WHERE provider = 'FUSION_VIRTUAL';

-- =====================================================
-- STEP 5: VIRTUAL ACCOUNT SUMMARY VIEW
-- Provides a convenient aggregated view of each user's
-- Fusion balance across all currencies.
-- =====================================================
CREATE OR REPLACE VIEW fusion_virtual_balances AS
SELECT
    account_id,
    currency,
    balance          AS virtual_balance,
    is_treasury,
    updated_at
FROM balances
WHERE provider = 'FUSION_VIRTUAL';
