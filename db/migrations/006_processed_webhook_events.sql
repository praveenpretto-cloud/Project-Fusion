-- Migration: 006_processed_webhook_events.sql
-- Purpose: Provider-scoped webhook event deduplication and replay protection

CREATE TABLE IF NOT EXISTS processed_webhook_events (
    event_id VARCHAR(255) NOT NULL,
    provider VARCHAR(50) NOT NULL, -- 'STRIPE', 'RAZORPAYX'
    event_type VARCHAR(100) NOT NULL,
    instruction_id VARCHAR(255),
    external_intent_id VARCHAR(255),
    payload_hash VARCHAR(64),
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_instruction ON processed_webhook_events(instruction_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_intent ON processed_webhook_events(external_intent_id);

