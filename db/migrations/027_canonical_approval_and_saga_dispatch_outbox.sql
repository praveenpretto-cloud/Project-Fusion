-- ==============================================================================
-- Migration 027: Canonical Approval & Saga Dispatch Outbox (ADR-002)
-- ==============================================================================
-- Phase: ADR-002 Canonical Payment Approval and Saga Execution
--
-- Objective:
--   1. Establish an append-only, durable Saga dispatch outbox table in identity schema.
--   2. Ensure atomic coupling between Maker-Checker approval and Saga execution release.
--   3. Provide persistent idempotency, retry tracking, and recovery for background dispatchers.
--   4. Zero impact on existing working migrations or table checksums.
-- ==============================================================================

CREATE SCHEMA IF NOT EXISTS identity;

-- ==============================================================================
-- 1. SAGA DISPATCH OUTBOX TABLE
-- ==============================================================================

CREATE TABLE IF NOT EXISTS identity.saga_dispatch_outbox (
    dispatch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instruction_id UUID NOT NULL,
    approval_id UUID,
    idempotency_key VARCHAR(128) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (
        status IN ('PENDING', 'PROCESSING', 'DISPATCHED', 'COMPLETED', 'FAILED', 'MANUAL_CHECK')
    ),
    policy_decision JSONB,
    operator_id UUID,
    scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    dispatched_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    CONSTRAINT uq_outbox_instruction_dispatch UNIQUE (instruction_id, idempotency_key)
);

-- Index for high-throughput dispatcher polling
CREATE INDEX IF NOT EXISTS idx_saga_dispatch_outbox_pending
ON identity.saga_dispatch_outbox (status, scheduled_for)
WHERE status IN ('PENDING', 'PROCESSING');

CREATE INDEX IF NOT EXISTS idx_saga_dispatch_outbox_instruction
ON identity.saga_dispatch_outbox (instruction_id);

-- Also expose public view for runtime fallback
CREATE OR REPLACE VIEW public.saga_dispatch_outbox AS 
SELECT * FROM identity.saga_dispatch_outbox;

-- Role grants if security roles exist
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE ON identity.saga_dispatch_outbox TO fusion_app_runtime;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_workflow_definer') THEN
        GRANT ALL ON identity.saga_dispatch_outbox TO fusion_workflow_definer;
    END IF;
END $$;

