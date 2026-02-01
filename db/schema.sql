-- Project Fusion Prototype Database Schema
-- Run with: psql -d fusion_db -f db/schema.sql

CREATE TABLE IF NOT EXISTS instructions (
  instruction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amount DECIMAL(20, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL,
  sender VARCHAR(50) NOT NULL,
  recipient VARCHAR(50) NOT NULL,
  purpose VARCHAR(50) NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'INITIATED',
  external_intent_id VARCHAR(255), -- Stores Stripe payment_intent_id or external transaction ID
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS balances (
  account_id VARCHAR(50) NOT NULL,
  currency VARCHAR(10) NOT NULL,
  balance DECIMAL(20, 2) DEFAULT 0 CHECK (balance >= 0),
  PRIMARY KEY (account_id, currency)
);

CREATE TABLE IF NOT EXISTS ledger_journal (
  entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction_id UUID NOT NULL,
  account_id VARCHAR(50) NOT NULL,
  direction VARCHAR(10) CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount DECIMAL(20, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL,
  timestamp TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key_id VARCHAR(255) PRIMARY KEY,
  response_json JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Sample test data
INSERT INTO balances (account_id, currency, balance) VALUES ('Alice_Corp', 'SGD', 10000.00) ON CONFLICT DO NOTHING;
INSERT INTO balances (account_id, currency, balance) VALUES ('Bob_Supply', 'SGD', 5000.00) ON CONFLICT DO NOTHING;
INSERT INTO balances (account_id, currency, balance) VALUES ('Alice_Wallet', 'BTC', 1.00) ON CONFLICT DO NOTHING;
INSERT INTO balances (account_id, currency, balance) VALUES ('Bob_ColdStorage', 'BTC', 0.00) ON CONFLICT DO NOTHING;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_ledger_instruction_id ON ledger_journal(instruction_id);
CREATE INDEX IF NOT EXISTS idx_instructions_state ON instructions(state);
