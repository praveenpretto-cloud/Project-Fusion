-- =============================================================================
-- Migration: 019_void_governance_and_terminal_states.sql
-- Purpose: AI-2B.3 Final Security Review Corrections
-- 1. Dedicated Void-Request and Void-Approval Permissions:
--    - payment:void_request
--    - payment:void_approve
--    - Bound to OPS_OPERATOR (request) and TREASURY_ANALYST (request + approve)
-- 2. Dual-Control Void Requests Table:
--    - identity.payment_void_requests
--    - Database-level check constraint: requester_operator_id <> approver_operator_id
--    - Trigger enforcement preventing requester from approving own void
-- 3. VOIDED is Strictly Terminal:
--    - Hardens identity.trg_enforce_instruction_material_freeze() so that once
--      an instruction is VOIDED, NO updates of any kind are permitted.
--    - Prohibits transitions to APPROVED, INITIATED, PENDING_APPROVAL, EXECUTED,
--      SETTLED, LOCKED, FAILED, or any other state.
--    - Prohibits altering material terms on VOIDED instructions.
--    - Enforces strict state transition allowlist across all lifecycle states.
-- 4. Terminal Protection for Approval Records & Approval Creation Guard:
--    - Hardens identity.trg_enforce_approval_immutability() so that VOIDED
--      approvals cannot be modified.
--    - BEFORE INSERT on payment_approvals blocks creating an approval for a
--      VOIDED instruction (preventing reuse of voided instructions).
-- =============================================================================

-- 1. Seed Dedicated Void Permissions
INSERT INTO identity.permissions (permission_key, description) VALUES
    ('payment:void_request', 'Request voiding an approved payment instruction prior to execution'),
    ('payment:void_approve', 'Approve voiding an approved payment instruction with WebAuthn step-up')
ON CONFLICT (permission_key) DO UPDATE SET description = EXCLUDED.description;

-- Bind Dedicated Permissions to Roles
WITH new_role_perm_mapping (r_key, p_key) AS (
    VALUES
        ('OPS_OPERATOR', 'payment:void_request'),
        ('TREASURY_ANALYST', 'payment:void_request'),
        ('TREASURY_ANALYST', 'payment:void_approve')
)
INSERT INTO identity.role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM new_role_perm_mapping rpm
JOIN identity.roles r ON r.role_key = rpm.r_key
JOIN identity.permissions p ON p.permission_key = rpm.p_key
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 2. Dedicated Table for Payment Void Requests (Dual Control)
CREATE TABLE IF NOT EXISTS identity.payment_void_requests (
    void_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instruction_id UUID NOT NULL REFERENCES instructions(instruction_id),
    requester_operator_id UUID NOT NULL REFERENCES identity.operators(operator_id),
    approver_operator_id UUID REFERENCES identity.operators(operator_id),
    reason TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    instruction_version INTEGER NOT NULL,
    context_digest VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at TIMESTAMPTZ,
    CONSTRAINT chk_dual_control_void_distinct CHECK (approver_operator_id IS NULL OR requester_operator_id <> approver_operator_id)
);

CREATE INDEX IF NOT EXISTS idx_void_requests_instruction ON identity.payment_void_requests(instruction_id);
CREATE INDEX IF NOT EXISTS idx_void_requests_status ON identity.payment_void_requests(status);

-- Dual-control enforcement trigger on void requests
CREATE OR REPLACE FUNCTION identity.trg_enforce_void_request_dual_control()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Prevent mutating immutable fields
        IF NEW.requester_operator_id IS DISTINCT FROM OLD.requester_operator_id THEN
            RAISE EXCEPTION 'Requester identity on void request is immutable';
        END IF;
        IF NEW.instruction_id IS DISTINCT FROM OLD.instruction_id THEN
            RAISE EXCEPTION 'Instruction reference on void request is immutable';
        END IF;
        -- Enforce dual control: requester cannot approve their own void request
        IF NEW.approver_operator_id IS NOT NULL AND NEW.approver_operator_id = NEW.requester_operator_id THEN
            RAISE EXCEPTION 'Dual control violation: Requester % cannot approve their own void request', NEW.requester_operator_id;
        END IF;
        -- Cannot modify decided void request
        IF OLD.status IN ('APPROVED', 'REJECTED') AND NEW.status IS DISTINCT FROM OLD.status THEN
            RAISE EXCEPTION 'Cannot modify void request in terminal state %', OLD.status;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_void_request_dual_control ON identity.payment_void_requests;
CREATE TRIGGER trg_void_request_dual_control
BEFORE UPDATE ON identity.payment_void_requests
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_void_request_dual_control();

-- 3. VOIDED is Strictly Terminal: Hardened Trigger on instructions
CREATE OR REPLACE FUNCTION identity.trg_enforce_instruction_material_freeze()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- RULE 0: VOIDED is strictly terminal. Prohibit any transition or mutation out of VOIDED.
        IF OLD.state = 'VOIDED' OR OLD.approval_status = 'VOIDED' THEN
            RAISE EXCEPTION 'Instruction % is in terminal state VOIDED and cannot be modified or transitioned to any other state (attempted state: %, approval_status: %)', OLD.instruction_id, NEW.state, NEW.approval_status;
        END IF;

        -- RULE 1: Terminal operational states (SETTLED, REJECTED) cannot transition out
        IF OLD.state = 'SETTLED' AND NEW.state IS DISTINCT FROM OLD.state THEN
            RAISE EXCEPTION 'Instruction % is in terminal state SETTLED and cannot be modified or transitioned', OLD.instruction_id;
        END IF;
        IF OLD.state = 'REJECTED' AND NEW.state IS DISTINCT FROM OLD.state THEN
            RAISE EXCEPTION 'Instruction % is in terminal state REJECTED and cannot be modified or transitioned', OLD.instruction_id;
        END IF;

        -- RULE 2: State transition allowlist validation
        IF OLD.state IS DISTINCT FROM NEW.state THEN
            IF OLD.state = 'INITIATED' AND NOT (NEW.state IN ('INITIATED', 'PENDING_APPROVAL', 'LOCKED', 'FAILED', 'CANCELLED', 'VOIDED')) THEN
                RAISE EXCEPTION 'Illegal state transition from INITIATED to % for instruction %', NEW.state, OLD.instruction_id;
            ELSIF OLD.state = 'PENDING_APPROVAL' AND NOT (NEW.state IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'INITIATED', 'CANCELLED', 'VOIDED')) THEN
                RAISE EXCEPTION 'Illegal state transition from PENDING_APPROVAL to % for instruction %', NEW.state, OLD.instruction_id;
            ELSIF OLD.state = 'APPROVED' AND NOT (NEW.state IN ('APPROVED', 'LOCKED', 'PENDING_EXECUTION', 'SETTLED', 'SIMULATED', 'FAILED', 'MANUAL_CHECK', 'VOIDED')) THEN
                RAISE EXCEPTION 'Illegal state transition from APPROVED to % for instruction %', NEW.state, OLD.instruction_id;
            ELSIF OLD.state = 'LOCKED' AND NOT (NEW.state IN ('LOCKED', 'PENDING_EXECUTION', 'FAILED', 'MANUAL_CHECK')) THEN
                RAISE EXCEPTION 'Illegal state transition from LOCKED to % for instruction %', NEW.state, OLD.instruction_id;
            ELSIF OLD.state = 'PENDING_EXECUTION' AND NOT (NEW.state IN ('PENDING_EXECUTION', 'SETTLED', 'PENDING_SETTLEMENT', 'SIMULATED', 'FAILED', 'MANUAL_CHECK')) THEN
                RAISE EXCEPTION 'Illegal state transition from PENDING_EXECUTION to % for instruction %', NEW.state, OLD.instruction_id;
            ELSIF OLD.state = 'PENDING_SETTLEMENT' AND NOT (NEW.state IN ('PENDING_SETTLEMENT', 'SETTLED', 'FAILED', 'MANUAL_CHECK')) THEN
                RAISE EXCEPTION 'Illegal state transition from PENDING_SETTLEMENT to % for instruction %', NEW.state, OLD.instruction_id;
            ELSIF OLD.state = 'MANUAL_CHECK' AND NOT (NEW.state IN ('MANUAL_CHECK', 'SETTLED', 'FAILED')) THEN
                RAISE EXCEPTION 'Illegal state transition from MANUAL_CHECK to % for instruction %', NEW.state, OLD.instruction_id;
            END IF;
        END IF;

        -- RULE 3: APPROVED instruction immutability
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

        -- RULE 4: PENDING_APPROVAL instruction controlled amendment
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

-- 4. Terminal Protection for Approval Records & Approval Creation Guard
CREATE OR REPLACE FUNCTION identity.trg_enforce_approval_immutability()
RETURNS TRIGGER AS $$
DECLARE
    v_inst_state VARCHAR(32);
    v_inst_approval_status VARCHAR(32);
BEGIN
    -- Check if parent instruction is VOIDED (prevent reusing a voided instruction for another approval)
    IF TG_OP = 'INSERT' THEN
        SELECT state, approval_status INTO v_inst_state, v_inst_approval_status
        FROM instructions WHERE instruction_id = NEW.instruction_id;
        IF v_inst_state = 'VOIDED' OR v_inst_approval_status = 'VOIDED' THEN
            RAISE EXCEPTION 'Cannot create approval for VOIDED instruction %', NEW.instruction_id;
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- Prevent changing maker_operator_id
        IF NEW.maker_operator_id IS DISTINCT FROM OLD.maker_operator_id THEN
            RAISE EXCEPTION 'Maker identity is immutable once submitted';
        END IF;
        -- Prevent changing instruction_id
        IF NEW.instruction_id IS DISTINCT FROM OLD.instruction_id THEN
            RAISE EXCEPTION 'Approval instruction link is immutable';
        END IF;
        -- Prevent modifying terminal status VOIDED
        IF OLD.status = 'VOIDED' THEN
            RAISE EXCEPTION 'Payment approval % is in terminal state VOIDED and cannot be modified', OLD.approval_id;
        END IF;
        -- Allow explicit voiding from APPROVED or PENDING_APPROVAL
        IF OLD.status IN ('APPROVED', 'PENDING_APPROVAL') AND NEW.status = 'VOIDED' THEN
            RETURN NEW;
        END IF;
        -- Prevent modifying other terminal statuses
        IF OLD.status IN ('APPROVED', 'REJECTED', 'CANCELLED', 'VOIDED') AND NEW.status IS DISTINCT FROM OLD.status THEN
            RAISE EXCEPTION 'Cannot modify approval in terminal state %', OLD.status;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_approvals_immutability ON identity.payment_approvals;
CREATE TRIGGER trg_payment_approvals_immutability
BEFORE INSERT OR UPDATE ON identity.payment_approvals
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_approval_immutability();

