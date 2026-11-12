-- =============================================================================
-- Project Fusion — Migration 021: Database Privilege & Financial State Mutation Closure
-- Phase: AI-2B.5 Security & Privilege Closure
--
-- Objectives:
-- 1. Remove unrestricted financial-state mutation privileges from fusion_app_runtime:
--    - Prevent direct SQL setting of instructions to APPROVED, VOIDED, EXECUTED, or SETTLED.
--    - Prevent direct insertion or modification of approval records to false APPROVED state.
--    - Prevent direct modification of void requests to APPROVED without controlled approval procedure.
--    - Prevent post-approval modification of approver identity.
-- 2. Secure fn_approve_payment_void and introduce fn_approve_payment_instruction:
--    - Owned by dedicated non-login role fusion_workflow_definer.
--    - SECURITY DEFINER with fixed search_path = pg_catalog, identity, public.
--    - Fully schema-qualified object references.
--    - Revoke EXECUTE from PUBLIC; grant only to fusion_app_runtime.
-- 3. WebAuthn Trust Boundary Enforcement:
--    - Table identity.verified_webauthn_assertions records cryptographically verified assertions.
--    - fn_approve_payment_void & fn_approve_payment_instruction require and atomically consume
--      verified assertions, preventing unverified challenge injection.
-- 4. Audit & Destruction Protection:
--    - Explicitly protect verified assertions against TRUNCATE and DELETE.
--    - Maintain intentional retention policy on transient webauthn_challenges while blocking TRUNCATE.
-- =============================================================================

-- ------------------------------------------------------------------------------
-- 1. DEDICATED WORKFLOW DEFINER ROLE
-- ------------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fusion_workflow_definer') THEN
        CREATE ROLE fusion_workflow_definer NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fusion_app_runtime') THEN
        CREATE ROLE fusion_app_runtime NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fusion_auditor') THEN
        CREATE ROLE fusion_auditor NOLOGIN;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public, identity TO fusion_workflow_definer, fusion_app_runtime, fusion_auditor;

-- ------------------------------------------------------------------------------
-- 2. VERIFIED WEBAUTHN ASSERTIONS EVIDENCE TABLE
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity.verified_webauthn_assertions (
    assertion_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    challenge_id UUID NOT NULL REFERENCES identity.webauthn_challenges(challenge_id),
    operator_id UUID NOT NULL REFERENCES identity.operators(operator_id),
    credential_id VARCHAR(255) NOT NULL,
    context_digest VARCHAR(64) NOT NULL,
    signature_hash VARCHAR(64) NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    consumed_at TIMESTAMPTZ,
    consumed_by_action VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_verified_assertion_challenge UNIQUE (challenge_id)
);

CREATE INDEX IF NOT EXISTS idx_verified_assertions_lookup 
ON identity.verified_webauthn_assertions(challenge_id, operator_id) 
WHERE consumed_at IS NULL;

-- Truncate and Delete protection for verified assertions
DROP TRIGGER IF EXISTS trg_verified_assertions_no_truncate ON identity.verified_webauthn_assertions;
CREATE TRIGGER trg_verified_assertions_no_truncate
BEFORE TRUNCATE ON identity.verified_webauthn_assertions
FOR EACH STATEMENT EXECUTE FUNCTION identity.trg_block_truncate();

CREATE OR REPLACE FUNCTION identity.trg_block_verified_assertions_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Deletion of verified WebAuthn assertion records is strictly prohibited (assertion_id: %)', OLD.assertion_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_verified_assertions_protect_delete ON identity.verified_webauthn_assertions;
CREATE TRIGGER trg_verified_assertions_protect_delete
BEFORE DELETE ON identity.verified_webauthn_assertions
FOR EACH ROW EXECUTE FUNCTION identity.trg_block_verified_assertions_delete();

-- Privileges on verified assertions: restricted to workflow definer; application role cannot insert/update directly
REVOKE ALL ON identity.verified_webauthn_assertions FROM PUBLIC, fusion_app_runtime, fusion_auditor;
GRANT SELECT ON identity.verified_webauthn_assertions TO fusion_app_runtime, fusion_auditor;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.verified_webauthn_assertions TO fusion_workflow_definer;

-- ------------------------------------------------------------------------------
-- 3. STORED FUNCTION: RECORD VERIFIED WEBAUTHN ASSERTION
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION identity.fn_record_verified_webauthn_assertion(
    p_challenge_id UUID,
    p_operator_id UUID,
    p_credential_id VARCHAR(255),
    p_signature_hash VARCHAR(64),
    p_context_digest VARCHAR(64)
) RETURNS UUID AS $$
DECLARE
    v_challenge RECORD;
    v_assertion_id UUID;
BEGIN
    -- Verify challenge exists
    SELECT * INTO v_challenge FROM identity.webauthn_challenges
    WHERE challenge_id = p_challenge_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'WebAuthn challenge % not found', p_challenge_id;
    END IF;

    IF v_challenge.operator_id <> p_operator_id THEN
        RAISE EXCEPTION 'Operator mismatch for WebAuthn challenge: challenge belongs to %, caller claimed %', v_challenge.operator_id, p_operator_id;
    END IF;

    IF v_challenge.context_digest IS NOT NULL AND v_challenge.context_digest <> p_context_digest THEN
        RAISE EXCEPTION 'Context digest mismatch for WebAuthn challenge';
    END IF;

    IF length(p_signature_hash) <> 64 THEN
        RAISE EXCEPTION 'Invalid signature hash (must be 64-character SHA-256 hex string)';
    END IF;

    INSERT INTO identity.verified_webauthn_assertions (
        challenge_id, operator_id, credential_id, signature_hash, context_digest, verified_at
    ) VALUES (
        p_challenge_id, p_operator_id, p_credential_id, p_signature_hash, p_context_digest, NOW()
    ) RETURNING assertion_id INTO v_assertion_id;

    RETURN v_assertion_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, identity, public;

ALTER FUNCTION identity.fn_record_verified_webauthn_assertion(UUID, UUID, VARCHAR(255), VARCHAR(64), VARCHAR(64)) OWNER TO fusion_workflow_definer;
REVOKE ALL ON FUNCTION identity.fn_record_verified_webauthn_assertion(UUID, UUID, VARCHAR(255), VARCHAR(64), VARCHAR(64)) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.fn_record_verified_webauthn_assertion(UUID, UUID, VARCHAR(255), VARCHAR(64), VARCHAR(64)) TO fusion_app_runtime;

-- ------------------------------------------------------------------------------
-- 4. SECURE ATOMIC STORED FUNCTION: APPROVE PAYMENT VOID
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
    v_assertion RECORD;
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
        RAISE EXCEPTION 'Cannot approve void request in status % (must be PENDING)', v_void_req.status;
    END IF;

    -- 3. Dual Control: requester cannot approve their own void request
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

    -- 5. Trustworthy WebAuthn Evidence Verification: Check verified assertion table
    SELECT * INTO v_assertion FROM identity.verified_webauthn_assertions
    WHERE challenge_id = p_challenge_id AND operator_id = p_approver_operator_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cryptographically verified WebAuthn assertion for challenge % not found. Unverified challenges cannot approve payment voids.', p_challenge_id;
    END IF;

    IF v_assertion.consumed_at IS NOT NULL THEN
        RAISE EXCEPTION 'Verified WebAuthn assertion for challenge % has already been consumed at % (replay blocked)', p_challenge_id, v_assertion.consumed_at;
    END IF;

    IF v_assertion.context_digest <> p_context_digest THEN
        RAISE EXCEPTION 'Verified WebAuthn assertion context digest mismatch: expected %, got %', p_context_digest, v_assertion.context_digest;
    END IF;

    IF NOW() > v_assertion.verified_at + INTERVAL '5 minutes' THEN
        RAISE EXCEPTION 'Verified WebAuthn assertion has expired';
    END IF;

    -- 6. Atomically mark assertion and challenge consumed
    UPDATE identity.verified_webauthn_assertions
    SET consumed_at = NOW(), consumed_by_action = 'VOID'
    WHERE assertion_id = v_assertion.assertion_id;

    UPDATE identity.webauthn_challenges
    SET consumed_at = NOW()
    WHERE challenge_id = p_challenge_id;

    -- 7. Atomically update void request to APPROVED
    UPDATE identity.payment_void_requests
    SET status = 'APPROVED',
        approver_operator_id = p_approver_operator_id,
        challenge_id = p_challenge_id,
        context_digest = p_context_digest,
        decided_at = NOW()
    WHERE void_request_id = p_void_request_id;

    -- 8. Update payment_approvals to VOIDED
    UPDATE identity.payment_approvals
    SET status = 'VOIDED',
        checker_operator_id = p_approver_operator_id,
        rejection_reason = v_void_req.reason,
        context_digest = p_context_digest,
        decided_at = NOW()
    WHERE instruction_id = p_instruction_id;

    -- 9. Update instruction to VOIDED
    UPDATE public.instructions
    SET state = 'VOIDED',
        approval_status = 'VOIDED',
        updated_at = NOW()
    WHERE instruction_id = p_instruction_id;

    -- 10. Audit event
    INSERT INTO identity.auth_audit_log (
        event_type, operator_id, metadata
    ) VALUES (
        'PAYMENT_VOID_APPROVED',
        p_approver_operator_id,
        jsonb_build_object(
            'instruction_id', p_instruction_id,
            'void_request_id', p_void_request_id,
            'requester_operator_id', v_void_req.requester_operator_id,
            'approver_operator_id', p_approver_operator_id,
            'reason', v_void_req.reason,
            'context_digest', p_context_digest,
            'challenge_id', p_challenge_id
        )
    );

    RETURN jsonb_build_object(
        'void_request_id', p_void_request_id,
        'instruction_id', p_instruction_id,
        'status', 'APPROVED',
        'approver_operator_id', p_approver_operator_id,
        'context_digest', p_context_digest,
        'challenge_id', p_challenge_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, identity, public;

ALTER FUNCTION identity.fn_approve_payment_void(UUID, UUID, UUID, UUID, VARCHAR(64)) OWNER TO fusion_workflow_definer;
REVOKE ALL ON FUNCTION identity.fn_approve_payment_void(UUID, UUID, UUID, UUID, VARCHAR(64)) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.fn_approve_payment_void(UUID, UUID, UUID, UUID, VARCHAR(64)) TO fusion_app_runtime;

-- ------------------------------------------------------------------------------
-- 5. SECURE ATOMIC STORED FUNCTION: APPROVE PAYMENT INSTRUCTION
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION identity.fn_approve_payment_instruction(
    p_approval_id UUID,
    p_instruction_id UUID,
    p_checker_operator_id UUID,
    p_challenge_id UUID,
    p_context_digest VARCHAR(64),
    p_notes TEXT,
    p_step_up_method VARCHAR(32)
) RETURNS JSONB AS $$
DECLARE
    v_inst RECORD;
    v_approval RECORD;
    v_assertion RECORD;
BEGIN
    -- 1. Lock instruction FOR UPDATE
    SELECT * INTO v_inst FROM public.instructions WHERE instruction_id = p_instruction_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Instruction % not found', p_instruction_id;
    END IF;

    IF v_inst.state = 'VOIDED' OR v_inst.approval_status = 'VOIDED' THEN
        RAISE EXCEPTION 'Instruction % is VOIDED and cannot be approved', p_instruction_id;
    END IF;

    IF v_inst.state IN ('EXECUTED', 'SETTLED') THEN
        RAISE EXCEPTION 'Instruction % is already executed/settled', p_instruction_id;
    END IF;

    -- 2. Lock approval record FOR UPDATE
    SELECT * INTO v_approval FROM identity.payment_approvals 
    WHERE approval_id = p_approval_id AND instruction_id = p_instruction_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment approval % for instruction % not found', p_approval_id, p_instruction_id;
    END IF;

    IF v_approval.status <> 'PENDING_APPROVAL' THEN
        RAISE EXCEPTION 'Payment approval % is in status % (must be PENDING_APPROVAL)', p_approval_id, v_approval.status;
    END IF;

    -- 3. Four-Eyes check: maker cannot approve
    IF v_approval.maker_operator_id = p_checker_operator_id THEN
        RAISE EXCEPTION 'Dual control violation: Maker % cannot approve their own payment instruction', p_checker_operator_id;
    END IF;

    -- 4. Check compliance hold
    IF v_approval.compliance_held IS TRUE THEN
        RAISE EXCEPTION 'Cannot approve payment instruction %: Active compliance hold by officer %', p_instruction_id, v_approval.compliance_held_by;
    END IF;

    -- 5. If WebAuthn step-up was used, verify and consume verified assertion
    IF p_step_up_method = 'webauthn' OR p_challenge_id IS NOT NULL THEN
        IF p_challenge_id IS NULL THEN
            RAISE EXCEPTION 'Verified WebAuthn challenge_id is required for step-up approval';
        END IF;

        SELECT * INTO v_assertion FROM identity.verified_webauthn_assertions
        WHERE challenge_id = p_challenge_id AND operator_id = p_checker_operator_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Cryptographically verified WebAuthn assertion for challenge % not found', p_challenge_id;
        END IF;

        IF v_assertion.consumed_at IS NOT NULL THEN
            RAISE EXCEPTION 'Verified WebAuthn assertion for challenge % has already been consumed (replay blocked)', p_challenge_id;
        END IF;

        IF v_assertion.context_digest <> p_context_digest THEN
            RAISE EXCEPTION 'Verified WebAuthn assertion context digest mismatch';
        END IF;

        IF NOW() > v_assertion.verified_at + INTERVAL '5 minutes' THEN
            RAISE EXCEPTION 'Verified WebAuthn assertion has expired';
        END IF;

        -- Mark assertion consumed
        UPDATE identity.verified_webauthn_assertions
        SET consumed_at = NOW(), consumed_by_action = 'APPROVE'
        WHERE assertion_id = v_assertion.assertion_id;

        -- Mark challenge consumed
        UPDATE identity.webauthn_challenges
        SET consumed_at = NOW()
        WHERE challenge_id = p_challenge_id;
    END IF;

    -- 6. Update payment_approvals
    UPDATE identity.payment_approvals
    SET status = 'APPROVED',
        checker_operator_id = p_checker_operator_id,
        decided_at = NOW(),
        approval_notes = p_notes,
        step_up_method = p_step_up_method,
        step_up_verified_at = CASE WHEN p_step_up_method = 'webauthn' THEN NOW() ELSE NULL END,
        context_digest = p_context_digest
    WHERE approval_id = p_approval_id;

    -- 7. Update instructions
    UPDATE public.instructions
    SET state = 'APPROVED',
        approval_status = 'APPROVED',
        checker_operator_id = p_checker_operator_id,
        updated_at = NOW()
    WHERE instruction_id = p_instruction_id;

    -- 8. Audit log
    INSERT INTO identity.auth_audit_log (
        event_type, operator_id, metadata
    ) VALUES (
        'PAYMENT_APPROVED',
        p_checker_operator_id,
        jsonb_build_object(
            'instruction_id', p_instruction_id,
            'approval_id', p_approval_id,
            'maker_operator_id', v_approval.maker_operator_id,
            'checker_operator_id', p_checker_operator_id,
            'step_up_method', p_step_up_method,
            'context_digest', p_context_digest,
            'challenge_id', p_challenge_id
        )
    );

    RETURN jsonb_build_object(
        'approval_id', p_approval_id,
        'instruction_id', p_instruction_id,
        'status', 'APPROVED',
        'checker_operator_id', p_checker_operator_id,
        'context_digest', p_context_digest
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, identity, public;

ALTER FUNCTION identity.fn_approve_payment_instruction(UUID, UUID, UUID, UUID, VARCHAR(64), TEXT, VARCHAR(32)) OWNER TO fusion_workflow_definer;
REVOKE ALL ON FUNCTION identity.fn_approve_payment_instruction(UUID, UUID, UUID, UUID, VARCHAR(64), TEXT, VARCHAR(32)) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.fn_approve_payment_instruction(UUID, UUID, UUID, UUID, VARCHAR(64), TEXT, VARCHAR(32)) TO fusion_app_runtime;

-- ------------------------------------------------------------------------------
-- 6. STATE TRANSITION & UNRESTRICTED MUTATION GUARDS (TRIGGERS)
-- ------------------------------------------------------------------------------

-- Guard A: public.instructions Transition Guard
CREATE OR REPLACE FUNCTION identity.trg_enforce_instructions_state_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Prevent fusion_app_runtime from directly transitioning to APPROVED
        IF (NEW.state = 'APPROVED' OR NEW.approval_status = 'APPROVED') AND CURRENT_USER = 'fusion_app_runtime' THEN
            RAISE EXCEPTION 'Direct transition of instruction % to APPROVED is prohibited for application runtime. Must use identity.fn_approve_payment_instruction().', OLD.instruction_id;
        END IF;

        -- Prevent fusion_app_runtime from directly transitioning to VOIDED
        IF (NEW.state = 'VOIDED' OR NEW.approval_status = 'VOIDED') AND CURRENT_USER = 'fusion_app_runtime' THEN
            RAISE EXCEPTION 'Direct transition of instruction % to VOIDED is prohibited for application runtime. Must use identity.fn_approve_payment_void().', OLD.instruction_id;
        END IF;

        -- Prevent direct transition to EXECUTED or SETTLED without prior approval
        IF NEW.state IN ('EXECUTED', 'SETTLED') THEN
            IF OLD.approval_status IS DISTINCT FROM 'APPROVED' AND OLD.state NOT IN ('APPROVED', 'PENDING_EXECUTION', 'LOCKED', 'PENDING_SETTLEMENT') THEN
                RAISE EXCEPTION 'Instruction % cannot transition to % without prior approval (current approval_status: %, state: %)', OLD.instruction_id, NEW.state, OLD.approval_status, OLD.state;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_instructions_state_guard ON public.instructions;
CREATE TRIGGER trg_instructions_state_guard
BEFORE UPDATE ON public.instructions
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_instructions_state_guard();

-- Guard B: identity.payment_approvals Transition Guard
CREATE OR REPLACE FUNCTION identity.trg_enforce_payment_approvals_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Enforce dual-control distinct operators check
        IF NEW.checker_operator_id IS NOT NULL AND NEW.maker_operator_id = NEW.checker_operator_id THEN
            RAISE EXCEPTION 'Dual control check violation: chk_maker_checker_distinct: Maker % cannot be Checker', NEW.maker_operator_id;
        END IF;

        -- Prevent direct insertion of approved/decided approval records
        IF NEW.status IS DISTINCT FROM 'PENDING_APPROVAL' THEN
            RAISE EXCEPTION 'Direct insertion of non-PENDING approval records is strictly prohibited. Approvals must be created in PENDING_APPROVAL status.';
        END IF;
        IF NEW.decided_at IS NOT NULL THEN
            RAISE EXCEPTION 'decided_at cannot be set upon approval creation.';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- Prevent post-approval modification of approver identity or evidence while in APPROVED state
        IF OLD.status = 'APPROVED' AND NEW.status = 'APPROVED' THEN
            IF NEW.checker_operator_id IS DISTINCT FROM OLD.checker_operator_id THEN
                RAISE EXCEPTION 'Approver identity is strictly immutable post-approval (attempted to change checker from % to %)', OLD.checker_operator_id, NEW.checker_operator_id;
            END IF;
            IF NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
                RAISE EXCEPTION 'decided_at timestamp is strictly immutable post-approval';
            END IF;
            IF NEW.context_digest IS DISTINCT FROM OLD.context_digest THEN
                RAISE EXCEPTION 'context_digest is strictly immutable post-approval';
            END IF;
        END IF;

        -- Prevent fusion_app_runtime from directly updating approval to APPROVED
        IF OLD.status IS DISTINCT FROM 'APPROVED' AND NEW.status = 'APPROVED' AND CURRENT_USER = 'fusion_app_runtime' THEN
            RAISE EXCEPTION 'Direct update of payment_approvals to APPROVED is prohibited for application runtime. Must use identity.fn_approve_payment_instruction().';
        END IF;

        -- Prevent fusion_app_runtime from directly updating approval to VOIDED
        IF OLD.status IS DISTINCT FROM 'VOIDED' AND NEW.status = 'VOIDED' AND CURRENT_USER = 'fusion_app_runtime' THEN
            RAISE EXCEPTION 'Direct update of payment_approvals to VOIDED is prohibited for application runtime. Must use identity.fn_approve_payment_void().';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_approvals_guard ON identity.payment_approvals;
CREATE TRIGGER trg_payment_approvals_guard
BEFORE INSERT OR UPDATE ON identity.payment_approvals
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_payment_approvals_guard();

-- Guard C: identity.payment_void_requests Transition Guard
CREATE OR REPLACE FUNCTION identity.trg_enforce_payment_void_requests_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Enforce dual-control distinct operators check
        IF NEW.approver_operator_id IS NOT NULL AND NEW.requester_operator_id = NEW.approver_operator_id THEN
            RAISE EXCEPTION 'Dual control check violation: chk_dual_control_void_distinct: Requester % cannot approve their own void request', NEW.requester_operator_id;
        END IF;

        -- Prevent direct insertion of approved/decided void requests
        IF NEW.status IS DISTINCT FROM 'PENDING' THEN
            RAISE EXCEPTION 'Direct insertion of non-PENDING void requests is strictly prohibited. Void requests must be created in PENDING status.';
        END IF;
        IF NEW.decided_at IS NOT NULL THEN
            RAISE EXCEPTION 'decided_at cannot be set upon void request creation.';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- Prevent post-approval modification of approver identity
        IF OLD.status = 'APPROVED' THEN
            IF NEW.approver_operator_id IS DISTINCT FROM OLD.approver_operator_id THEN
                RAISE EXCEPTION 'Approver identity is strictly immutable post-approval on void requests (attempted to change approver from % to %)', OLD.approver_operator_id, NEW.approver_operator_id;
            END IF;
            IF NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
                RAISE EXCEPTION 'decided_at timestamp is strictly immutable post-approval on void requests';
            END IF;
            IF NEW.context_digest IS DISTINCT FROM OLD.context_digest THEN
                RAISE EXCEPTION 'context_digest is strictly immutable post-approval on void requests';
            END IF;
            IF NEW.challenge_id IS DISTINCT FROM OLD.challenge_id THEN
                RAISE EXCEPTION 'challenge_id is strictly immutable post-approval on void requests';
            END IF;
        END IF;

        -- Prevent fusion_app_runtime from directly updating void request to APPROVED
        IF OLD.status IS DISTINCT FROM 'APPROVED' AND NEW.status = 'APPROVED' AND CURRENT_USER = 'fusion_app_runtime' THEN
            RAISE EXCEPTION 'Direct update of payment_void_requests to APPROVED is prohibited for application runtime. Must use identity.fn_approve_payment_void().';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_void_requests_guard ON identity.payment_void_requests;
CREATE TRIGGER trg_payment_void_requests_guard
BEFORE INSERT OR UPDATE ON identity.payment_void_requests
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_payment_void_requests_guard();

-- ------------------------------------------------------------------------------
-- 7. ROLE PERMISSION ASSIGNMENTS FOR fusion_workflow_definer
-- ------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON public.instructions TO fusion_workflow_definer;
GRANT SELECT, INSERT, UPDATE ON identity.payment_approvals TO fusion_workflow_definer;
GRANT SELECT, INSERT, UPDATE ON identity.payment_void_requests TO fusion_workflow_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.webauthn_challenges TO fusion_workflow_definer;
GRANT SELECT, INSERT ON identity.auth_audit_log TO fusion_workflow_definer;

-- Ensure execute grants on stored functions
GRANT EXECUTE ON FUNCTION identity.fn_approve_payment_void(UUID, UUID, UUID, UUID, VARCHAR(64)) TO fusion_app_runtime;
GRANT EXECUTE ON FUNCTION identity.fn_approve_payment_instruction(UUID, UUID, UUID, UUID, VARCHAR(64), TEXT, VARCHAR(32)) TO fusion_app_runtime;
GRANT EXECUTE ON FUNCTION identity.fn_record_verified_webauthn_assertion(UUID, UUID, VARCHAR(255), VARCHAR(64), VARCHAR(64)) TO fusion_app_runtime;
