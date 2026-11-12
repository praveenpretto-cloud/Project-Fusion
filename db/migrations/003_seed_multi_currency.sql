-- 003_seed_multi_currency.sql
-- SECURE SEEDING FOR MULTI-CURRENCY VIRTUAL ACCOUNTS

-- 1. Ensure Alice_Corp has INR and XLM balances
-- provider = 'FUSION_VIRTUAL' identifies internal ledger-managed funds
INSERT INTO balances (account_id, provider, currency, balance, is_treasury, updated_at)
VALUES 
    ('Alice_Corp', 'FUSION_VIRTUAL', 'INR', 500000.00, FALSE, NOW()),
    ('Alice_Corp', 'FUSION_VIRTUAL', 'XLM', 10000.00, FALSE, NOW())
ON CONFLICT (account_id, provider, currency) 
DO UPDATE SET balance = balances.balance + EXCLUDED.balance, updated_at = NOW();

-- 2. Audit Trail: Ensure the simulated external sources have matching offset balances
-- This maintains double-entry integrity for future audits.
INSERT INTO balances (account_id, provider, currency, balance, is_treasury, updated_at)
VALUES 
    ('FUSION_EXTERNAL_BANK', 'FUSION_VIRTUAL', 'INR', 10000000.00, TRUE, NOW()),
    ('FUSION_EXTERNAL_BANK', 'FUSION_VIRTUAL', 'XLM', 1000000.00, TRUE, NOW())
ON CONFLICT (account_id, provider, currency) DO NOTHING;

-- 3. Verification View Check (optional diagnostic)
-- SELECT * FROM balances WHERE account_id = 'Alice_Corp' AND provider = 'FUSION_VIRTUAL';
