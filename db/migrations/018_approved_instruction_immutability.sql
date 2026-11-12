-- =============================================================================
-- Migration: 018_approved_instruction_immutability.sql
-- Purpose: AI-2B.3 Financial Approval Integrity & Dual-Control Hardening
-- 1. Hardens payment immutability trigger:
--    - Once APPROVED, material terms (amount, currency, recipient, destination_account,
--      provider, environment) are strictly IMMUTABLE.
--    - Direct SQL updates or version-increment hacks on APPROVED instructions are rejected.
--    - An APPROVED instruction cannot be reverted to INITIATED or PENDING_APPROVAL.
--    - If an approved instruction cannot proceed, it can only be transitioned to VOIDED
--      (without altering payment terms) and a new instruction must be initiated.
--    - PENDING_APPROVAL retains controlled amendment workflow (requires version + 1,
--      state = INITIATED, approval_status = CANCELLED).
-- 2. Privileged Role-Change Dual-Control Check Constraints:
--    - Enforces target_operator_id <> approving_operator_id at database level
--      (target operator cannot approve their own role grant or revocation).
-- 3. Approval status check constraint update to include 'VOIDED'.
-- =============================================================================

-- 1. Dual Control Check Constraint for Target Operator
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_dual_control_target_distinct'
    ) THEN
        ALTER TABLE identity.role_change_requests
        ADD CONSTRAINT chk_dual_control_target_distinct
        CHECK (approving_operator_id IS NULL OR target_operator_id <> approving_operator_id);
    END IF;
END $$;

-- 2. Update payment_approvals status check constraint to include 'VOIDED'
ALTER TABLE identity.payment_approvals DROP CONSTRAINT IF EXISTS chk_approval_status;
ALTER TABLE identity.payment_approvals ADD CONSTRAINT chk_approval_status
    CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'VOIDED'));

-- 3. Hardened Payment Immutability & Lifecycle Trigger on instructions
CREATE OR REPLACE FUNCTION identity.trg_enforce_instruction_material_freeze()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Rule A: APPROVED instruction immutability
        IF OLD.state = 'APPROVED' OR OLD.approval_status = 'APPROVED' THEN
            -- An approved instruction cannot be returned to INITIATED or PENDING_APPROVAL
            IF NEW.state IN ('INITIATED', 'PENDING_APPROVAL') OR NEW.approval_status IN ('INITIATED', 'PENDING_APPROVAL') THEN
                RAISE EXCEPTION 'Approved payment instruction cannot be returned to % or % (instruction terms are frozen post-approval)', NEW.state, NEW.approval_status;
            END IF;

            -- Material payment fields are strictly immutable post-approval (even with version increments)
            IF (NEW.amount IS DISTINCT FROM OLD.amount) OR
               (NEW.currency IS DISTINCT FROM OLD.currency) OR
               (NEW.recipient IS DISTINCT FROM OLD.recipient) OR
               (NEW.destination_account IS DISTINCT FROM OLD.destination_account) OR
               (NEW.provider IS DISTINCT FROM OLD.provider) OR
               (NEW.environment IS DISTINCT FROM OLD.environment) THEN
                RAISE EXCEPTION 'Approved payment instructions are strictly immutable. Material payment terms (amount, currency, recipient, destination_account, provider, environment) cannot be altered after approval. To void an approved instruction, transition to VOIDED without changing payment terms.';
            END IF;

        -- Rule B: PENDING_APPROVAL instruction controlled amendment
        ELSIF OLD.state = 'PENDING_APPROVAL' OR OLD.approval_status = 'PENDING_APPROVAL' THEN
            -- Check if any material field changed
            IF (NEW.amount IS DISTINCT FROM OLD.amount) OR
               (NEW.currency IS DISTINCT FROM OLD.currency) OR
               (NEW.recipient IS DISTINCT FROM OLD.recipient) OR
               (NEW.destination_account IS DISTINCT FROM OLD.destination_account) OR
               (NEW.provider IS DISTINCT FROM OLD.provider) OR
               (NEW.environment IS DISTINCT FROM OLD.environment) THEN

                -- Controlled amendment requires version increment, cancellation of pending approval, and state reset to INITIATED
                IF NOT (NEW.version = OLD.version + 1 AND NEW.approval_status = 'CANCELLED' AND NEW.state = 'INITIATED') THEN
                    RAISE EXCEPTION 'Material payment fields (amount, currency, recipient, destination_account, provider, environment) cannot be altered while in PENDING_APPROVAL or APPROVED without version increment and approval cancellation (requires version + 1, approval_status = CANCELLED, and state = INITIATED)';
                END IF;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_instructions_material_freeze ON instructions;
CREATE TRIGGER trg_instructions_material_freeze
BEFORE UPDATE ON instructions
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_instruction_material_freeze();

-- 4. Payment Approval Lifecycle: Allow explicit transition from APPROVED or PENDING_APPROVAL to VOIDED
CREATE OR REPLACE FUNCTION identity.trg_enforce_approval_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Prevent changing maker_operator_id
        IF NEW.maker_operator_id IS DISTINCT FROM OLD.maker_operator_id THEN
            RAISE EXCEPTION 'Maker identity is immutable once submitted';
        END IF;
        -- Prevent changing instruction_id
        IF NEW.instruction_id IS DISTINCT FROM OLD.instruction_id THEN
            RAISE EXCEPTION 'Approval instruction link is immutable';
        END IF;
        -- Allow explicit voiding from APPROVED or PENDING_APPROVAL
        IF OLD.status IN ('APPROVED', 'PENDING_APPROVAL') AND NEW.status = 'VOIDED' THEN
            RETURN NEW;
        END IF;
        -- Prevent modifying terminal status
        IF OLD.status IN ('APPROVED', 'REJECTED', 'CANCELLED', 'VOIDED') AND NEW.status IS DISTINCT FROM OLD.status THEN
            RAISE EXCEPTION 'Cannot modify approval in terminal state %', OLD.status;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
