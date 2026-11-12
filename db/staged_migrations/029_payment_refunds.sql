-- ==============================================================================
-- Migration 029: Normalized Payment Refunds Persistence & Refund State Machine
-- Phase: MR2.2 Staged Migration
--
-- STRICT OPERATIONAL BOUNDARIES & MANDATORY DESIGN CONSTRAINTS:
--   1. Historical ledger sequences, SHA-256 hashes, timestamps, and prev_hash
--      values are strictly immutable and PRESERVED WITHOUT MUTATION.
--   2. Enforces unique constraint on (provider, provider_refund_id).
--   3. Foreign key links each refund to public.instructions(instruction_id).
--   4. Updates identity.trg_enforce_instruction_material_freeze() to permit
--      SETTLED -> PARTIALLY_REFUNDED -> REFUNDED transitions.
--   5. STAGED ONLY: Do NOT apply directly to active database during MR2.2.
-- ==============================================================================

-- ==============================================================================
-- PHASE 1: PRECONDITION CHECKS & PREREQUISITE ASSERTIONS (FAIL-CLOSED)
-- ==============================================================================
DO $$
BEGIN
    IF to_regclass('public.instructions') IS NULL THEN
        RAISE EXCEPTION 'PRECONDITION FAILED: public.instructions does not exist.';
    END IF;
    IF to_regclass('public.ledger_journal') IS NULL THEN
        RAISE EXCEPTION 'PRECONDITION FAILED: public.ledger_journal does not exist.';
    END IF;
END $$;

-- ==============================================================================
-- PHASE 2: NORMALIZED PAYMENT REFUNDS TABLE
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.payment_refunds (
    refund_record_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(50) NOT NULL, -- 'STRIPE', 'RAZORPAYX'
    provider_refund_id VARCHAR(255) NOT NULL,
    instruction_id UUID NOT NULL REFERENCES public.instructions(instruction_id),
    external_intent_id VARCHAR(255),
    charge_id VARCHAR(255),
    amount_minor BIGINT NOT NULL,
    currency VARCHAR(10) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    event_id VARCHAR(255),
    ledger_entry_id UUID REFERENCES public.ledger_journal(entry_id),
    metadata JSONB DEFAULT '{}'::jsonb,
    CONSTRAINT uq_payment_refunds_provider_refund UNIQUE (provider, provider_refund_id),
    CONSTRAINT chk_payment_refunds_amount_minor CHECK (amount_minor > 0),
    CONSTRAINT chk_payment_refunds_currency CHECK (currency ~ '^[A-Z]{3,4}$'),
    CONSTRAINT chk_payment_refunds_status CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'REQUIRES_ACTION'))
);

CREATE INDEX IF NOT EXISTS idx_payment_refunds_instruction ON public.payment_refunds(instruction_id);
CREATE INDEX IF NOT EXISTS idx_payment_refunds_provider_refund ON public.payment_refunds(provider, provider_refund_id);

-- ==============================================================================
-- PHASE 3: UPDATE MATERIAL FREEZE TRIGGER FOR REFUND LIFECYCLE
-- ==============================================================================
CREATE OR REPLACE FUNCTION identity.trg_enforce_instruction_material_freeze()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- RULE 0: VOIDED is strictly terminal. Prohibit any transition or mutation out of VOIDED.
        IF OLD.state = 'VOIDED' OR OLD.approval_status = 'VOIDED' THEN
            RAISE EXCEPTION 'Instruction % is in terminal state VOIDED and cannot be modified or transitioned to any other state (attempted state: %, approval_status: %)', OLD.instruction_id, NEW.state, NEW.approval_status;
        END IF;

        -- RULE 1: Terminal operational states (REJECTED, REFUNDED)
        IF OLD.state = 'REJECTED' AND NEW.state IS DISTINCT FROM OLD.state THEN
            RAISE EXCEPTION 'Instruction % is in terminal state REJECTED and cannot be modified or transitioned', OLD.instruction_id;
        END IF;
        IF OLD.state = 'REFUNDED' AND NEW.state IS DISTINCT FROM OLD.state THEN
            RAISE EXCEPTION 'Instruction % is in terminal state REFUNDED and cannot be modified or transitioned', OLD.instruction_id;
        END IF;

        -- RULE 1B: SETTLED can transition to PARTIALLY_REFUNDED, REFUNDED, or MANUAL_CHECK (investigation)
        IF OLD.state = 'SETTLED' AND NEW.state IS DISTINCT FROM OLD.state THEN
            IF NOT (NEW.state IN ('PARTIALLY_REFUNDED', 'REFUNDED', 'MANUAL_CHECK')) THEN
                RAISE EXCEPTION 'Instruction % is in SETTLED state and can only transition to PARTIALLY_REFUNDED, REFUNDED or MANUAL_CHECK (attempted: %)', OLD.instruction_id, NEW.state;
            END IF;
        END IF;

        -- RULE 1C: PARTIALLY_REFUNDED can transition to REFUNDED or MANUAL_CHECK
        IF OLD.state = 'PARTIALLY_REFUNDED' AND NEW.state IS DISTINCT FROM OLD.state THEN
            IF NOT (NEW.state IN ('PARTIALLY_REFUNDED', 'REFUNDED', 'MANUAL_CHECK')) THEN
                RAISE EXCEPTION 'Instruction % is in PARTIALLY_REFUNDED state and can only transition to REFUNDED or MANUAL_CHECK (attempted: %)', OLD.instruction_id, NEW.state;
            END IF;
        END IF;

        -- RULE 2: State transition allowlist validation
        IF OLD.state IS DISTINCT FROM NEW.state THEN
            IF OLD.state = 'INITIATED' AND NOT (NEW.state IN ('INITIATED', 'PENDING_APPROVAL', 'LOCKED', 'FAILED', 'CANCELLED', 'VOIDED')) THEN
                RAISE EXCEPTION 'Illegal state transition from INITIATED to % for instruction %', NEW.state, OLD.instruction_id;
            ELSIF OLD.state = 'PENDING_APPROVAL' AND NOT (NEW.state IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'INITIATED', 'CANCELLED', 'VOIDED')) THEN
                RAISE EXCEPTION 'Illegal state transition from PENDING_APPROVAL to % for instruction %', NEW.state, OLD.instruction_id;
            ELSIF OLD.state = 'APPROVED' AND NOT (NEW.state IN ('APPROVED', 'LOCKED', 'PENDING_EXECUTION', 'EXECUTED', 'SETTLED', 'SIMULATED', 'FAILED', 'MANUAL_CHECK', 'VOIDED')) THEN
                RAISE EXCEPTION 'Illegal state transition from APPROVED to % for instruction %', NEW.state, OLD.instruction_id;
            ELSIF OLD.state = 'LOCKED' AND NOT (NEW.state IN ('LOCKED', 'PENDING_EXECUTION', 'FAILED', 'MANUAL_CHECK')) THEN
                RAISE EXCEPTION 'Illegal state transition from LOCKED to % for instruction %', NEW.state, OLD.instruction_id;
            ELSIF OLD.state = 'PENDING_EXECUTION' AND NOT (NEW.state IN ('PENDING_EXECUTION', 'EXECUTED', 'SETTLED', 'PENDING_SETTLEMENT', 'SIMULATED', 'FAILED', 'MANUAL_CHECK')) THEN
                RAISE EXCEPTION 'Illegal state transition from PENDING_EXECUTION to % for instruction %', NEW.state, OLD.instruction_id;
            ELSIF OLD.state = 'EXECUTED' AND NOT (NEW.state IN ('EXECUTED', 'SETTLED', 'PENDING_SETTLEMENT', 'FAILED', 'MANUAL_CHECK')) THEN
                RAISE EXCEPTION 'Illegal state transition from EXECUTED to % for instruction %', NEW.state, OLD.instruction_id;
            ELSIF OLD.state = 'PENDING_SETTLEMENT' AND NOT (NEW.state IN ('PENDING_SETTLEMENT', 'SETTLED', 'FAILED', 'MANUAL_CHECK')) THEN
                RAISE EXCEPTION 'Illegal state transition from PENDING_SETTLEMENT to % for instruction %', NEW.state, OLD.instruction_id;
            ELSIF OLD.state = 'SETTLED' AND NOT (NEW.state IN ('SETTLED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'MANUAL_CHECK')) THEN
                RAISE EXCEPTION 'Illegal state transition from SETTLED to % for instruction %', NEW.state, OLD.instruction_id;
            ELSIF OLD.state = 'PARTIALLY_REFUNDED' AND NOT (NEW.state IN ('PARTIALLY_REFUNDED', 'REFUNDED', 'MANUAL_CHECK')) THEN
                RAISE EXCEPTION 'Illegal state transition from PARTIALLY_REFUNDED to % for instruction %', NEW.state, OLD.instruction_id;
            ELSIF OLD.state = 'MANUAL_CHECK' AND NOT (NEW.state IN ('MANUAL_CHECK', 'SETTLED', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED')) THEN
                RAISE EXCEPTION 'Illegal state transition from MANUAL_CHECK to % for instruction %', NEW.state, OLD.instruction_id;
            END IF;
        END IF;

        -- RULE 3: APPROVED / EXECUTED / SETTLED instruction material term immutability
        IF OLD.state IN ('APPROVED', 'EXECUTED', 'SETTLED', 'PARTIALLY_REFUNDED', 'REFUNDED') OR OLD.approval_status = 'APPROVED' THEN
            -- Material payment fields are strictly immutable post-approval
            IF (NEW.amount IS DISTINCT FROM OLD.amount) OR
               (NEW.currency IS DISTINCT FROM OLD.currency) OR
               (NEW.recipient IS DISTINCT FROM OLD.recipient) OR
               (NEW.destination_account IS DISTINCT FROM OLD.destination_account) THEN
                RAISE EXCEPTION 'Material payment terms (amount, currency, recipient, destination_account) are strictly immutable after approval and settlement.';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

