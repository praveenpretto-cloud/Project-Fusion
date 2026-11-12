-- =============================================================================
-- Project Fusion — Migration 020: Void Lifecycle Enforcement & Financial Table Protection
-- Phase: AI-2B.4 Security & Governance Closure
--
-- Objectives:
-- 1. Complete Void-Request Lifecycle in PostgreSQL:
--    - Enforce PENDING -> APPROVED and PENDING -> REJECTED.
--    - Both APPROVED and REJECTED are strictly terminal.
--    - Require all necessary approval evidence: approver_operator_id, decided_at,
--      context_digest (exact 64-char SHA256), and challenge_id.
--    - Prevent challenge replay/reuse via UNIQUE constraint on challenge_id.
--    - Atomic stored procedure identity.fn_approve_payment_void() for secure transition.
-- 2. Financial Record Protection Against Deletion and Truncation:
--    - Statement-level BEFORE TRUNCATE triggers on instructions, payment_approvals,
--      payment_void_requests, routing_ledger, role_change_requests, webauthn_challenges.
--    - Row-level BEFORE DELETE triggers preventing deletion of approved, voided,
--      settled, and audit financial records.
-- 3. Least-Privilege Role Hardening for fusion_app_runtime:
--    - Revoke DELETE and TRUNCATE from fusion_app_runtime and PUBLIC across all financial tables.
--    - Revoke UPDATE on append-only routing_ledger and auth_audit_log.
-- =============================================================================

-- ------------------------------------------------------------------------------
-- 1. ENHANCE identity.payment_void_requests SCHEMA
-- ------------------------------------------------------------------------------

-- Add challenge_id column to identity.payment_void_requests if not exists
ALTER TABLE identity.payment_void_requests 
ADD COLUMN IF NOT EXISTS challenge_id UUID REFERENCES identity.webauthn_challenges(challenge_id);

-- Enforce challenge uniqueness to prevent replay/reuse across void requests
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'uq_void_request_challenge' 
          AND conrelid = 'identity.payment_void_requests'::regclass
    ) THEN
        ALTER TABLE identity.payment_void_requests
        ADD CONSTRAINT uq_void_request_challenge UNIQUE (challenge_id);
    END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 2. COMPLETE VOID-REQUEST LIFECYCLE TRIGGER
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION identity.trg_enforce_void_request_lifecycle()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Rule 1: Immutable identity and origin fields
        IF NEW.void_request_id IS DISTINCT FROM OLD.void_request_id THEN
            RAISE EXCEPTION 'void_request_id is strictly immutable';
        END IF;
        IF NEW.instruction_id IS DISTINCT FROM OLD.instruction_id THEN
            RAISE EXCEPTION 'instruction_id on void request is strictly immutable';
        END IF;
        IF NEW.requester_operator_id IS DISTINCT FROM OLD.requester_operator_id THEN
            RAISE EXCEPTION 'requester_operator_id on void request is strictly immutable';
        END IF;
        IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'created_at timestamp on void request is strictly immutable';
        END IF;

        -- Rule 2: Terminal State Protection
        -- Once APPROVED or REJECTED, the record is strictly immutable
        IF OLD.status = 'APPROVED' THEN
            RAISE EXCEPTION 'Terminal state violation: payment void request % is APPROVED and strictly immutable (cannot be re-approved, rejected, or modified)', OLD.void_request_id;
        END IF;
        IF OLD.status = 'REJECTED' THEN
            RAISE EXCEPTION 'Terminal state violation: payment void request % is REJECTED and strictly immutable (cannot be approved or modified)', OLD.void_request_id;
        END IF;

        -- Rule 3: Valid Lifecycle State Transitions from PENDING
        IF OLD.status = 'PENDING' THEN
            IF NEW.status NOT IN ('PENDING', 'APPROVED', 'REJECTED') THEN
                RAISE EXCEPTION 'Illegal lifecycle transition: PENDING void request cannot transition to %', NEW.status;
            END IF;

            -- If remaining in PENDING, only challenge_id / context_digest can be updated (e.g. challenge generation)
            IF NEW.status = 'PENDING' THEN
                IF NEW.approver_operator_id IS NOT NULL THEN
                    RAISE EXCEPTION 'approver_operator_id cannot be set while void request is PENDING';
                END IF;
                IF NEW.decided_at IS NOT NULL THEN
                    RAISE EXCEPTION 'decided_at cannot be set while void request is PENDING';
                END IF;
                IF NEW.reason IS DISTINCT FROM OLD.reason THEN
                    RAISE EXCEPTION 'Void request reason is immutable upon creation';
                END IF;
            END IF;

            -- Sub-rule 3A: Evidence requirements for APPROVED transition
            IF NEW.status = 'APPROVED' THEN
                IF NEW.approver_operator_id IS NULL THEN
                    RAISE EXCEPTION 'Approval evidence missing: approver_operator_id is required';
                END IF;
                -- Dual Control: requester cannot approve their own request
                IF NEW.approver_operator_id = OLD.requester_operator_id THEN
                    RAISE EXCEPTION 'Dual control violation: Requester % cannot approve their own void request', OLD.requester_operator_id;
                END IF;
                IF NEW.decided_at IS NULL THEN
                    RAISE EXCEPTION 'Approval evidence missing: decided_at timestamp is required';
                END IF;
                IF NEW.context_digest IS NULL OR length(NEW.context_digest) <> 64 THEN
                    RAISE EXCEPTION 'Approval evidence missing: valid 64-character context_digest is required';
                END IF;
                IF NEW.challenge_id IS NULL THEN
                    RAISE EXCEPTION 'Approval evidence missing: verified WebAuthn challenge_id is required';
                END IF;
                IF NEW.reason IS DISTINCT FROM OLD.reason THEN
                    RAISE EXCEPTION 'Void request reason is immutable upon creation';
                END IF;
            END IF;

            -- Sub-rule 3B: Evidence requirements for REJECTED transition
            IF NEW.status = 'REJECTED' THEN
                IF NEW.approver_operator_id IS NULL THEN
                    RAISE EXCEPTION 'Rejection evidence missing: approver_operator_id is required';
                END IF;
                IF NEW.decided_at IS NULL THEN
                    RAISE EXCEPTION 'Rejection evidence missing: decided_at timestamp is required';
                END IF;
                IF NEW.reason IS DISTINCT FROM OLD.reason THEN
                    RAISE EXCEPTION 'Void request reason is immutable upon creation';
                END IF;
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Replace existing dual-control trigger with comprehensive lifecycle trigger
DROP TRIGGER IF EXISTS trg_void_request_dual_control ON identity.payment_void_requests;
DROP TRIGGER IF EXISTS trg_void_request_lifecycle ON identity.payment_void_requests;

CREATE TRIGGER trg_void_request_lifecycle
BEFORE UPDATE ON identity.payment_void_requests
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_void_request_lifecycle();

-- ------------------------------------------------------------------------------
-- 3. ATOMIC RESTRICTED STORED PROCEDURE FOR VOID APPROVAL
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION identity.fn_approve_payment_void(
    p_void_request_id UUID,
    p_instruction_id UUID,
    p_approver_operator_id UUID,
    p_challenge_id UUID,
    p_context_digest VARCHAR(64)
) RETURNS JSONB AS $$
DECLARE
    v_void_req RECORD;
    v_inst RECORD;
    v_challenge RECORD;
BEGIN
    -- 1. Lock instruction FOR UPDATE
    SELECT * INTO v_inst FROM public.instructions WHERE instruction_id = p_instruction_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Instruction % not found', p_instruction_id;
    END IF;

    IF v_inst.state IN ('EXECUTED', 'SETTLED') THEN
        RAISE EXCEPTION 'Cannot void instruction in executed/settled state %', v_inst.state;
    END IF;

    IF v_inst.state = 'VOIDED' THEN
        RAISE EXCEPTION 'Instruction % is already VOIDED', p_instruction_id;
    END IF;

    -- 2. Lock void request FOR UPDATE
    SELECT * INTO v_void_req FROM identity.payment_void_requests 
    WHERE void_request_id = p_void_request_id AND instruction_id = p_instruction_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Pending void request % for instruction % not found', p_void_request_id, p_instruction_id;
    END IF;

    IF v_void_req.status <> 'PENDING' THEN
        RAISE EXCEPTION 'Cannot approve void request in status %', v_void_req.status;
    END IF;

    -- 3. Enforce Dual Control
    IF v_void_req.requester_operator_id = p_approver_operator_id THEN
        RAISE EXCEPTION 'Dual control violation: Requester % cannot approve their own void request', p_approver_operator_id;
    END IF;

    -- 4. Verify WebAuthn challenge reference
    SELECT * INTO v_challenge FROM identity.webauthn_challenges 
    WHERE challenge_id = p_challenge_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'WebAuthn challenge % not found', p_challenge_id;
    END IF;

    IF v_challenge.operator_id <> p_approver_operator_id THEN
        RAISE EXCEPTION 'WebAuthn challenge operator mismatch: challenge belongs to %, not approver %', v_challenge.operator_id, p_approver_operator_id;
    END IF;

    IF v_challenge.instruction_id IS NOT NULL AND v_challenge.instruction_id <> p_instruction_id THEN
        RAISE EXCEPTION 'WebAuthn challenge instruction mismatch: challenge bound to %, not %', v_challenge.instruction_id, p_instruction_id;
    END IF;

    -- 5. Mark challenge consumed atomically
    UPDATE identity.webauthn_challenges
    SET consumed_at = NOW()
    WHERE challenge_id = p_challenge_id;

    -- 6. Atomically update void request to APPROVED
    UPDATE identity.payment_void_requests
    SET status = 'APPROVED',
        approver_operator_id = p_approver_operator_id,
        challenge_id = p_challenge_id,
        context_digest = p_context_digest,
        decided_at = NOW()
    WHERE void_request_id = p_void_request_id;

    -- 7. Update payment_approvals to VOIDED
    UPDATE identity.payment_approvals
    SET status = 'VOIDED',
        checker_operator_id = p_approver_operator_id,
        rejection_reason = v_void_req.reason,
        context_digest = p_context_digest,
        decided_at = NOW()
    WHERE instruction_id = p_instruction_id;

    -- 8. Update instruction to VOIDED
    UPDATE public.instructions
    SET state = 'VOIDED',
        approval_status = 'VOIDED'
    WHERE instruction_id = p_instruction_id;

    RETURN jsonb_build_object(
        'void_request_id', p_void_request_id,
        'instruction_id', p_instruction_id,
        'status', 'APPROVED',
        'approver_operator_id', p_approver_operator_id,
        'context_digest', p_context_digest,
        'challenge_id', p_challenge_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ------------------------------------------------------------------------------
-- 4. FINANCIAL RECORDS TRUNCATE AND DELETE PROTECTION TRIGGERS
-- ------------------------------------------------------------------------------

-- Generic Trigger Function: Block TRUNCATE
CREATE OR REPLACE FUNCTION identity.trg_block_truncate()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Security violation: TRUNCATE is strictly prohibited on % (financial/audit table)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- Apply TRUNCATE blocks
DROP TRIGGER IF EXISTS trg_instructions_no_truncate ON public.instructions;
CREATE TRIGGER trg_instructions_no_truncate
BEFORE TRUNCATE ON public.instructions
FOR EACH STATEMENT EXECUTE FUNCTION identity.trg_block_truncate();

DROP TRIGGER IF EXISTS trg_payment_approvals_no_truncate ON identity.payment_approvals;
CREATE TRIGGER trg_payment_approvals_no_truncate
BEFORE TRUNCATE ON identity.payment_approvals
FOR EACH STATEMENT EXECUTE FUNCTION identity.trg_block_truncate();

DROP TRIGGER IF EXISTS trg_payment_void_requests_no_truncate ON identity.payment_void_requests;
CREATE TRIGGER trg_payment_void_requests_no_truncate
BEFORE TRUNCATE ON identity.payment_void_requests
FOR EACH STATEMENT EXECUTE FUNCTION identity.trg_block_truncate();

DROP TRIGGER IF EXISTS trg_routing_ledger_no_truncate ON public.routing_ledger;
CREATE TRIGGER trg_routing_ledger_no_truncate
BEFORE TRUNCATE ON public.routing_ledger
FOR EACH STATEMENT EXECUTE FUNCTION identity.trg_block_truncate();

DROP TRIGGER IF EXISTS trg_role_change_requests_no_truncate ON identity.role_change_requests;
CREATE TRIGGER trg_role_change_requests_no_truncate
BEFORE TRUNCATE ON identity.role_change_requests
FOR EACH STATEMENT EXECUTE FUNCTION identity.trg_block_truncate();

DROP TRIGGER IF EXISTS trg_webauthn_challenges_no_truncate ON identity.webauthn_challenges;
CREATE TRIGGER trg_webauthn_challenges_no_truncate
BEFORE TRUNCATE ON identity.webauthn_challenges
FOR EACH STATEMENT EXECUTE FUNCTION identity.trg_block_truncate();

-- Row-level DELETE Protections

-- Instructions: Block deleting approved, voided, settled, executed, or rejected instructions
CREATE OR REPLACE FUNCTION identity.trg_protect_instruction_delete()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.state IN ('APPROVED', 'SETTLED', 'EXECUTED', 'VOIDED', 'REJECTED', 'CANCELLED') THEN
        RAISE EXCEPTION 'Deletion of financial history is strictly prohibited. Instruction % is in immutable state %', OLD.instruction_id, OLD.state;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_instructions_protect_delete ON public.instructions;
CREATE TRIGGER trg_instructions_protect_delete
BEFORE DELETE ON public.instructions
FOR EACH ROW EXECUTE FUNCTION identity.trg_protect_instruction_delete();

-- Payment Approvals: Unconditional block on DELETE
CREATE OR REPLACE FUNCTION identity.trg_block_payment_approvals_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Deletion of payment approval records is strictly prohibited (instruction: %, status: %)', OLD.instruction_id, OLD.status;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_approvals_protect_delete ON identity.payment_approvals;
CREATE TRIGGER trg_payment_approvals_protect_delete
BEFORE DELETE ON identity.payment_approvals
FOR EACH ROW EXECUTE FUNCTION identity.trg_block_payment_approvals_delete();

-- Payment Void Requests: Unconditional block on DELETE
CREATE OR REPLACE FUNCTION identity.trg_block_payment_void_requests_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Deletion of payment void requests is strictly prohibited (void_request_id: %, status: %)', OLD.void_request_id, OLD.status;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_void_requests_protect_delete ON identity.payment_void_requests;
CREATE TRIGGER trg_payment_void_requests_protect_delete
BEFORE DELETE ON identity.payment_void_requests
FOR EACH ROW EXECUTE FUNCTION identity.trg_block_payment_void_requests_delete();

-- Routing Ledger: Accounting ledger is strictly append-only (No UPDATE, No DELETE)
CREATE OR REPLACE FUNCTION identity.trg_block_routing_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Accounting ledger is strictly append-only. Mutation (% on entry %) is strictly prohibited.', TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_routing_ledger_immutable ON public.routing_ledger;
CREATE TRIGGER trg_routing_ledger_immutable
BEFORE UPDATE OR DELETE ON public.routing_ledger
FOR EACH ROW EXECUTE FUNCTION identity.trg_block_routing_ledger_mutation();

-- Role Change Requests: Unconditional block on DELETE
CREATE OR REPLACE FUNCTION identity.trg_block_role_change_requests_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Deletion of role change governance records is strictly prohibited (request_id: %)', OLD.request_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_role_change_requests_protect_delete ON identity.role_change_requests;
CREATE TRIGGER trg_role_change_requests_protect_delete
BEFORE DELETE ON identity.role_change_requests
FOR EACH ROW EXECUTE FUNCTION identity.trg_block_role_change_requests_delete();

-- ------------------------------------------------------------------------------
-- 5. LEAST-PRIVILEGE ROLE HARDENING FOR fusion_app_runtime
-- ------------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fusion_app_runtime') THEN
        CREATE ROLE fusion_app_runtime NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fusion_auditor') THEN
        CREATE ROLE fusion_auditor NOLOGIN;
    END IF;
END
$$;

-- Grant Schema Usage
GRANT USAGE ON SCHEMA public TO fusion_app_runtime, fusion_auditor;
GRANT USAGE ON SCHEMA identity TO fusion_app_runtime, fusion_auditor;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'fusion_audit_owner') THEN
        GRANT USAGE ON SCHEMA identity TO fusion_audit_owner;
        GRANT USAGE ON SCHEMA public TO fusion_audit_owner;
    END IF;
END $$;

-- Revoke destructive capabilities from PUBLIC and application roles
REVOKE DELETE, TRUNCATE ON public.instructions FROM PUBLIC, fusion_app_runtime, fusion_auditor;
REVOKE DELETE, TRUNCATE ON identity.payment_approvals FROM PUBLIC, fusion_app_runtime, fusion_auditor;
REVOKE DELETE, TRUNCATE ON identity.payment_void_requests FROM PUBLIC, fusion_app_runtime, fusion_auditor;
REVOKE UPDATE, DELETE, TRUNCATE ON public.routing_ledger FROM PUBLIC, fusion_app_runtime, fusion_auditor;
REVOKE UPDATE, DELETE, TRUNCATE ON identity.auth_audit_log FROM PUBLIC, fusion_app_runtime, fusion_auditor;
REVOKE DELETE, TRUNCATE ON identity.role_change_requests FROM PUBLIC, fusion_app_runtime, fusion_auditor;
REVOKE TRUNCATE ON identity.webauthn_challenges FROM PUBLIC, fusion_app_runtime, fusion_auditor;

-- Grant strictly necessary operational privileges to fusion_app_runtime
GRANT SELECT, INSERT, UPDATE ON public.instructions TO fusion_app_runtime;
GRANT SELECT, INSERT, UPDATE ON identity.payment_approvals TO fusion_app_runtime;
GRANT SELECT, INSERT, UPDATE ON identity.payment_void_requests TO fusion_app_runtime;
GRANT SELECT, INSERT ON public.routing_ledger TO fusion_app_runtime;
GRANT SELECT, INSERT ON identity.auth_audit_log TO fusion_app_runtime;
GRANT SELECT, INSERT, UPDATE ON identity.role_change_requests TO fusion_app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.webauthn_challenges TO fusion_app_runtime;

-- Grant execute on secure stored function
GRANT EXECUTE ON FUNCTION identity.fn_approve_payment_void(UUID, UUID, UUID, UUID, VARCHAR(64)) TO fusion_app_runtime;

-- Auditor role is strictly read-only
GRANT SELECT ON public.instructions TO fusion_auditor;
GRANT SELECT ON identity.payment_approvals TO fusion_auditor;
GRANT SELECT ON identity.payment_void_requests TO fusion_auditor;
GRANT SELECT ON public.routing_ledger TO fusion_auditor;
GRANT SELECT ON identity.auth_audit_log TO fusion_auditor;
GRANT SELECT ON identity.role_change_requests TO fusion_auditor;
GRANT SELECT ON identity.webauthn_challenges TO fusion_auditor;
