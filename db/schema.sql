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
  fx_rate DECIMAL(20, 6), -- Guaranteed exchange rate from AMM
  quote_id VARCHAR(100), -- Lock-in ID from Liquidity Provider
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

-- RBI Compliance: KYC & User Management
CREATE TABLE IF NOT EXISTS users (
  user_id VARCHAR(50) PRIMARY KEY,
  kyc_status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, VERIFIED, REJECTED
  kyc_verified_at TIMESTAMP,
  reference_id VARCHAR(100), -- ID from KYC provider
  created_at TIMESTAMP DEFAULT NOW()
);

-- RBI Compliance: OTP & AFA
CREATE TABLE IF NOT EXISTS otps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(50) NOT NULL REFERENCES users(user_id),
  otp_code VARCHAR(10) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);


-- Sample test data
INSERT INTO users (user_id, kyc_status, kyc_verified_at) VALUES ('Alice_Corp', 'VERIFIED', NOW()) ON CONFLICT DO NOTHING;
INSERT INTO users (user_id, kyc_status, kyc_verified_at) VALUES ('Bob_Supply', 'VERIFIED', NOW()) ON CONFLICT DO NOTHING;
INSERT INTO users (user_id, kyc_status, kyc_verified_at) VALUES ('Alice_Wallet', 'VERIFIED', NOW()) ON CONFLICT DO NOTHING;
INSERT INTO users (user_id, kyc_status, kyc_verified_at) VALUES ('Bob_ColdStorage', 'VERIFIED', NOW()) ON CONFLICT DO NOTHING;
INSERT INTO users (user_id, kyc_status) VALUES ('Charlie_NewUser', 'PENDING') ON CONFLICT DO NOTHING;

INSERT INTO balances (account_id, currency, balance) VALUES ('Alice_Corp', 'SGD', 10000.00) ON CONFLICT DO NOTHING;
INSERT INTO balances (account_id, currency, balance) VALUES ('Bob_Supply', 'SGD', 5000.00) ON CONFLICT DO NOTHING;
INSERT INTO balances (account_id, currency, balance) VALUES ('Alice_Wallet', 'BTC', 1.00) ON CONFLICT DO NOTHING;
INSERT INTO balances (account_id, currency, balance) VALUES ('Bob_ColdStorage', 'BTC', 0.00) ON CONFLICT DO NOTHING;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_ledger_instruction_id ON ledger_journal(instruction_id);
CREATE INDEX IF NOT EXISTS idx_instructions_state ON instructions(state);
