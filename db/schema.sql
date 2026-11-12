-- Project Fusion Prototype Database Schema
-- Run with: psql -d fusion_db -f db/schema.sql

CREATE TABLE IF NOT EXISTS instructions (
  instruction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amount NUMERIC(56, 18) NOT NULL,
  currency VARCHAR(10) NOT NULL,
  sender VARCHAR(50) NOT NULL,
  recipient VARCHAR(50) NOT NULL,
  purpose VARCHAR(50) NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'INITIATED',
  provider VARCHAR(50), -- Aggregator execution provider (e.g. FUSION_MASTER)
  external_intent_id VARCHAR(255), -- Stores Stripe payment_intent_id or external transaction ID
  utr VARCHAR(255), -- Unique Transaction Reference / provider clearing reference
  execution_attempts INTEGER NOT NULL DEFAULT 0 CHECK (execution_attempts >= 0),
  required_approvals INTEGER DEFAULT 1,
  fx_rate DECIMAL(20, 6), -- Guaranteed exchange rate from AMM
  quote_id VARCHAR(100), -- Lock-in ID from Liquidity Provider
  tax_withheld NUMERIC(56, 18) DEFAULT 0.000000000000000000, -- Compliance/TDS withheld
  net_amount NUMERIC(56, 18) DEFAULT 0.000000000000000000, -- Net payout amount after tax
  error_message TEXT, -- SAGA failure rationale
  zoho_invoice_id VARCHAR(100),
  source VARCHAR(50) DEFAULT 'api',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS balances (
  account_id VARCHAR(50) NOT NULL,
  provider VARCHAR(50) NOT NULL DEFAULT 'SYSTEM',
  currency VARCHAR(10) NOT NULL,
  balance NUMERIC(56, 18) DEFAULT 0 CHECK (balance >= 0),
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (account_id, provider, currency)
);

CREATE TABLE IF NOT EXISTS ledger_journal (
  entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction_id UUID NOT NULL,
  account_id VARCHAR(50) NOT NULL,
  direction VARCHAR(10) CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount NUMERIC(56, 18) NOT NULL,
  currency VARCHAR(10) NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  hash VARCHAR(64),
  prev_hash VARCHAR(64),
  sequence_id BIGSERIAL UNIQUE
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

-- Guardian AML: Sanctions Screening List
CREATE TABLE IF NOT EXISTS sanctions_list (
  address_or_id VARCHAR(255) PRIMARY KEY,
  entity_name VARCHAR(255) NOT NULL,
  reason TEXT,
  risk_level VARCHAR(50) DEFAULT 'HIGH',
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

-- Smart-Routing Switchboard Ledger
CREATE TABLE IF NOT EXISTS routing_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES instructions(instruction_id),
  invoice_id VARCHAR(255),
  exporter_user_id VARCHAR(50) REFERENCES users(user_id),
  route_selected VARCHAR(50) NOT NULL CHECK (route_selected IN ('BRIDGE_STABLECOIN', 'NIUM_SWIFT', 'STRIPE_TESTNET', 'RAZORPAY_TESTNET', 'STELLAR_TESTNET', 'ADAPTER_STRIPE', 'ADAPTER_RAZORPAY', 'ADAPTER_CRYPTO_CUSTODIAN', 'ADAPTER_FCSS', 'ADAPTER_BRIDGE', 'ADAPTER_PAYNOW', 'ADAPTER_PBM_CONTRACT', 'FIAT', 'CRYPTO')),
  routing_reason VARCHAR(255),
  principal_amount_usd DECIMAL(20, 2),
  partner_api_cost_usd DECIMAL(20, 2),
  fusion_fee_charged_usd DECIMAL(20, 2),
  net_margin_usd DECIMAL(20, 2),
  status VARCHAR(50) NOT NULL DEFAULT 'INITIATED' CHECK (status IN ('INITIATED', 'IN_TRANSIT', 'SETTLED', 'FAILED')),
  initiation_timestamp TIMESTAMP DEFAULT NOW(),
  settlement_timestamp TIMESTAMP,
  total_transit_time_minutes INTEGER,
  failure_reason VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_routing_ledger_transaction_id ON routing_ledger(transaction_id);

-- Zoho Compliance Documents Vault
CREATE TABLE IF NOT EXISTS compliance_documents (
    doc_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instruction_id  UUID REFERENCES instructions(instruction_id) ON DELETE CASCADE,
    zoho_invoice_id VARCHAR(100),
    doc_type        VARCHAR(30) NOT NULL
                    CHECK (doc_type IN ('FIRC', 'eBRC', 'FEMA_DECL', 'TDS_CERT')),
    doc_payload     JSONB NOT NULL,
    generated_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compliance_docs_instruction
    ON compliance_documents(instruction_id);

CREATE INDEX IF NOT EXISTS idx_compliance_docs_zoho
    ON compliance_documents(zoho_invoice_id)
    WHERE zoho_invoice_id IS NOT NULL;

-- Zoho Reconciliation Log
CREATE TABLE IF NOT EXISTS reconciliation_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instruction_id  UUID REFERENCES instructions(instruction_id) ON DELETE CASCADE,
    zoho_invoice_id VARCHAR(100),
    zoho_payment_id VARCHAR(100),
    reconciled_at   TIMESTAMP,
    status          VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'RECONCILED', 'FAILED', 'SKIPPED')),
    error_message   TEXT,
    created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_instruction
    ON reconciliation_log(instruction_id);

