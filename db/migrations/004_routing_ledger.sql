-- Migration: Add Routing_Ledger for Smart-Routing Switchboard tracking
-- Purpose: Tracks the algorithmic decisions and unit economics of cross-border transfers.

CREATE TABLE IF NOT EXISTS routing_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id VARCHAR(255) NOT NULL REFERENCES instructions(instruction_id),
  invoice_id VARCHAR(255),
  exporter_user_id VARCHAR(50) REFERENCES users(user_id),
  route_selected VARCHAR(50) NOT NULL CHECK (route_selected IN ('BRIDGE_STABLECOIN', 'NIUM_SWIFT', 'STRIPE_TESTNET', 'RAZORPAY_TESTNET', 'STELLAR_TESTNET', 'FIAT', 'CRYPTO', 'ADAPTER_STRIPE', 'ADAPTER_RAZORPAY', 'ADAPTER_CRYPTO_CUSTODIAN', 'ADAPTER_FCSS', 'ADAPTER_BRIDGE', 'ADAPTER_PAYNOW', 'ADAPTER_PBM_CONTRACT')),
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
