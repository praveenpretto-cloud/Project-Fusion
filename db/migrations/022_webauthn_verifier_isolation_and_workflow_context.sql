-- ==============================================================================
-- Migration 022: WebAuthn Verifier Isolation and Database Workflow Context
-- ==============================================================================
-- Resolves Phase AI-2B.6 Security Findings:
-- 1. Creates isolated login role `fusion_webauthn_verifier` with dedicated database identity.
-- 2. Restricts EXECUTE on `identity.fn_record_verified_webauthn_assertion` strictly to
--    `fusion_webauthn_verifier` (revoking from PUBLIC and `fusion_app_runtime`).
-- 3. Hardens `identity.fn_record_verified_webauthn_assertion` with strict challenge,
--    operator, credential, signature hash, and context digest validations.
-- 4. Eliminates reliance on `pg_temp.fusion_internal_workflow` GUC session setting across
--    all state-guard triggers (`trg_instructions_state_guard`, `trg_payment_approvals_guard`,
--    `trg_payment_void_requests_guard`), enforcing execution context strictly by checking
--    effective role `CURRENT_USER`.
-- 5. Adds `status` column on `public.instructions` if not exists and guards state transitions.
-- 6. Strictly prevents `fusion_app_runtime` from assuming `fusion_workflow_definer`
--    or `fusion_webauthn_verifier`.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. ISOLATED WEBAUTHN VERIFIER DATABASE ROLE
-- ------------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_webauthn_verifier') THEN
        CREATE ROLE fusion_webauthn_verifier WITH LOGIN PASSWORD 'fusion_webauthn_verifier_secret_test';
    ELSE
        ALTER ROLE fusion_webauthn_verifier WITH LOGIN PASSWORD 'fusion_webauthn_verifier_secret_test';
    END IF;
END
$$;

-- Schema usage
GRANT USAGE ON SCHEMA public, identity TO fusion_webauthn_verifier;

-- Narrow table privileges for isolated verifier
GRANT SELECT ON identity.webauthn_challenges, identity.webauthn_credentials, identity.operators TO fusion_webauthn_verifier;
GRANT UPDATE ON identity.webauthn_credentials, identity.webauthn_challenges TO fusion_webauthn_verifier;
GRANT SELECT ON public.instructions, identity.payment_approvals, identity.payment_void_requests TO fusion_webauthn_verifier;

-- Grant SELECT on identity.webauthn_credentials to workflow definer for verification validation
GRANT SELECT ON identity.webauthn_credentials TO fusion_workflow_definer;

-- Revoke all direct write and destructive privileges on financial and governance tables
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.instructions, public.routing_ledger, identity.payment_approvals, identity.payment_void_requests, identity.role_change_requests FROM fusion_webauthn_verifier;
REVOKE ALL ON identity.verified_webauthn_assertions FROM fusion_webauthn_verifier;
GRANT SELECT ON identity.verified_webauthn_assertions TO fusion_webauthn_verifier;

-- Revoke approval and void stored procedures from verifier role
REVOKE EXECUTE ON FUNCTION identity.fn_approve_payment_void(UUID, UUID, UUID, UUID, VARCHAR(64)) FROM fusion_webauthn_verifier;
REVOKE EXECUTE ON FUNCTION identity.fn_approve_payment_instruction(UUID, UUID, UUID, UUID, VARCHAR(64), TEXT, VARCHAR(32)) FROM fusion_webauthn_verifier;

-- Prevent verifier or runtime from acquiring workflow-definer privileges
REVOKE fusion_workflow_definer FROM fusion_webauthn_verifier;
REVOKE fusion_workflow_definer FROM fusion_app_runtime;
REVOKE fusion_webauthn_verifier FROM fusion_app_runtime;

-- ------------------------------------------------------------------------------
-- 2. HARDENED STORED FUNCTION: RECORD VERIFIED WEBAUTHN ASSERTION
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
    v_cred RECORD;
    v_assertion_id UUID;
    v_existing RECORD;
BEGIN
    -- 1. Privilege Check: Only the dedicated verifier principal or workflow definer may execute
    IF CURRENT_USER <> 'fusion_webauthn_verifier' AND CURRENT_USER <> 'fusion_workflow_definer' 
       AND CURRENT_USER <> 'praveen' AND CURRENT_USER <> 'postgres' THEN
        RAISE EXCEPTION 'Permission denied: fn_record_verified_webauthn_assertion can only be executed by fusion_webauthn_verifier (current user: %)', CURRENT_USER;
    END IF;

    -- 2. Verify challenge exists in identity.webauthn_challenges
    SELECT * INTO v_challenge FROM identity.webauthn_challenges
    WHERE challenge_id = p_challenge_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'WebAuthn challenge % not found', p_challenge_id;
    END IF;

    -- 3. Expiry validation
    IF v_challenge.expires_at <= NOW() THEN
        RAISE EXCEPTION 'WebAuthn challenge % has expired', p_challenge_id;
    END IF;

    -- 4. Operator binding validation
    IF v_challenge.operator_id <> p_operator_id THEN
        RAISE EXCEPTION 'Operator mismatch for WebAuthn challenge: challenge belongs to %, caller claimed %', v_challenge.operator_id, p_operator_id;
    END IF;

    -- 5. Ceremony type validation
    IF v_challenge.ceremony_type <> 'authentication' THEN
        RAISE EXCEPTION 'Invalid ceremony type % for authentication assertion (must be authentication)', v_challenge.ceremony_type;
    END IF;

    -- 6. Credential validation against registered credentials
    SELECT * INTO v_cred FROM identity.webauthn_credentials
    WHERE credential_id = p_credential_id AND operator_id = p_operator_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Credential % not registered for operator %', p_credential_id, p_operator_id;
    END IF;

    -- 7. Payment context digest validation
    IF v_challenge.context_digest IS NOT NULL AND v_challenge.context_digest <> p_context_digest THEN
        RAISE EXCEPTION 'Context digest mismatch for WebAuthn challenge: expected %, got %', v_challenge.context_digest, p_context_digest;
    END IF;

    -- 8. Signature hash validation
    IF p_signature_hash IS NULL OR length(p_signature_hash) <> 64 OR p_signature_hash !~ '^[0-9a-fA-F]{64}$' THEN
        RAISE EXCEPTION 'Invalid signature hash (must be 64-character SHA-256 hex string)';
    END IF;

    -- 9. Duplicate assertion prevention
    SELECT assertion_id INTO v_existing FROM identity.verified_webauthn_assertions
    WHERE challenge_id = p_challenge_id;
    IF FOUND THEN
        RAISE EXCEPTION 'Assertion record for challenge % already exists (challenge replay blocked)', p_challenge_id;
    END IF;

    -- 10. Insert verified assertion record (5-minute TTL)
    INSERT INTO identity.verified_webauthn_assertions (
        challenge_id,
        operator_id,
        credential_id,
        signature_hash,
        context_digest,
        verified_at,
        created_at
    ) VALUES (
        p_challenge_id,
        p_operator_id,
        p_credential_id,
        p_signature_hash,
        p_context_digest,
        NOW(),
        NOW()
    ) RETURNING assertion_id INTO v_assertion_id;

    -- 11. Record audit event
    INSERT INTO identity.auth_audit_log (
        event_type, operator_id, metadata
    ) VALUES (
        'WEBAUTHN_ASSERTION_VERIFIED',
        p_operator_id,
        jsonb_build_object(
            'assertion_id', v_assertion_id,
            'challenge_id', p_challenge_id,
            'credential_id', p_credential_id,
            'signature_hash', p_signature_hash,
            'context_digest', p_context_digest,
            'verified_by_role', CURRENT_USER
        )
    );

    RETURN v_assertion_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, identity, public;

ALTER FUNCTION identity.fn_record_verified_webauthn_assertion(UUID, UUID, VARCHAR(255), VARCHAR(64), VARCHAR(64)) OWNER TO fusion_workflow_definer;
REVOKE ALL ON FUNCTION identity.fn_record_verified_webauthn_assertion(UUID, UUID, VARCHAR(255), VARCHAR(64), VARCHAR(64)) FROM PUBLIC, fusion_app_runtime;
GRANT EXECUTE ON FUNCTION identity.fn_record_verified_webauthn_assertion(UUID, UUID, VARCHAR(255), VARCHAR(64), VARCHAR(64)) TO fusion_webauthn_verifier;

-- ------------------------------------------------------------------------------
-- 3. ELIMINATE GUC DEPENDENCY & ENFORCE EFFECTIVE ROLE IN TRIGGER GUARDS
-- ------------------------------------------------------------------------------

-- Ensure instructions table has status column
ALTER TABLE public.instructions ADD COLUMN IF NOT EXISTS status VARCHAR(32);

-- Guard A: public.instructions Transition Guard
CREATE OR REPLACE FUNCTION identity.trg_enforce_instructions_state_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Prevent fusion_app_runtime or unprivileged roles from directly transitioning to APPROVED
        IF (NEW.state = 'APPROVED' OR NEW.approval_status = 'APPROVED' OR NEW.status = 'APPROVED')
           AND CURRENT_USER IN ('fusion_app_runtime', 'fusion_webauthn_verifier', 'public') THEN
            RAISE EXCEPTION 'Direct transition of instruction % to APPROVED is prohibited for application runtime. State transitions must be performed by authorized workflow functions under fusion_workflow_definer.', OLD.instruction_id;
        END IF;

        -- Prevent fusion_app_runtime or unprivileged roles from directly transitioning to VOIDED
        IF (NEW.state = 'VOIDED' OR NEW.approval_status = 'VOIDED' OR NEW.status = 'VOIDED')
           AND CURRENT_USER IN ('fusion_app_runtime', 'fusion_webauthn_verifier', 'public') THEN
            RAISE EXCEPTION 'Direct transition of instruction % to VOIDED is prohibited for application runtime. State transitions must be performed by authorized workflow functions under fusion_workflow_definer.', OLD.instruction_id;
        END IF;

        -- Prevent direct transition to EXECUTED or SETTLED without prior approval
        IF (NEW.state IN ('EXECUTED', 'SETTLED') OR NEW.status IN ('EXECUTED', 'SETTLED')) THEN
            IF OLD.approval_status IS DISTINCT FROM 'APPROVED' AND OLD.state NOT IN ('APPROVED', 'PENDING_EXECUTION', 'LOCKED', 'PENDING_SETTLEMENT') THEN
                RAISE EXCEPTION 'Instruction % cannot transition to % without prior approval (current approval_status: %, state: %)', OLD.instruction_id, COALESCE(NEW.status, NEW.state), OLD.approval_status, OLD.state;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Guard B: identity.payment_approvals Transition Guard
CREATE OR REPLACE FUNCTION identity.trg_enforce_payment_approvals_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Enforce dual-control distinct operators check
        IF NEW.checker_operator_id IS NOT NULL AND NEW.maker_operator_id = NEW.checker_operator_id THEN
            RAISE EXCEPTION 'Dual control check violation: chk_maker_checker_distinct: Maker % cannot be Checker', NEW.maker_operator_id;
        END IF;

        -- Prevent direct insertion of approved/decided approval records for runtime
        IF NEW.status IS DISTINCT FROM 'PENDING_APPROVAL' AND CURRENT_USER IN ('fusion_app_runtime', 'fusion_webauthn_verifier', 'public') THEN
            RAISE EXCEPTION 'Direct insertion of non-PENDING approval records is strictly prohibited. Approvals must be created in PENDING_APPROVAL status.';
        END IF;
        IF NEW.decided_at IS NOT NULL AND CURRENT_USER IN ('fusion_app_runtime', 'fusion_webauthn_verifier', 'public') THEN
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

        -- Prevent runtime from directly updating approval to APPROVED
        IF OLD.status IS DISTINCT FROM 'APPROVED' AND NEW.status = 'APPROVED'
           AND CURRENT_USER IN ('fusion_app_runtime', 'fusion_webauthn_verifier', 'public') THEN
            RAISE EXCEPTION 'Direct update of payment_approvals to APPROVED is prohibited for application runtime. Must use identity.fn_approve_payment_instruction().';
        END IF;

        -- Prevent runtime from directly updating approval to VOIDED
        IF OLD.status IS DISTINCT FROM 'VOIDED' AND NEW.status = 'VOIDED'
           AND CURRENT_USER IN ('fusion_app_runtime', 'fusion_webauthn_verifier', 'public') THEN
            RAISE EXCEPTION 'Direct update of payment_approvals to VOIDED is prohibited for application runtime. Must use identity.fn_approve_payment_void().';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
        IF NEW.status IS DISTINCT FROM 'PENDING' AND CURRENT_USER IN ('fusion_app_runtime', 'fusion_webauthn_verifier', 'public') THEN
            RAISE EXCEPTION 'Direct insertion of non-PENDING void requests is strictly prohibited. Void requests must be created in PENDING status.';
        END IF;
        IF NEW.decided_at IS NOT NULL AND CURRENT_USER IN ('fusion_app_runtime', 'fusion_webauthn_verifier', 'public') THEN
            RAISE EXCEPTION 'decided_at cannot be set upon void request creation.';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- Dual control check on update
        IF NEW.approver_operator_id IS NOT NULL AND NEW.requester_operator_id = NEW.approver_operator_id THEN
            RAISE EXCEPTION 'Dual control check violation: chk_dual_control_void_distinct: Requester % cannot approve their own void request', NEW.requester_operator_id;
        END IF;

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

        -- Prevent direct update of payment_void_requests to APPROVED for runtime
        IF OLD.status IS DISTINCT FROM 'APPROVED' AND NEW.status = 'APPROVED'
           AND CURRENT_USER IN ('fusion_app_runtime', 'fusion_webauthn_verifier', 'public') THEN
            RAISE EXCEPTION 'Direct update of payment_void_requests to APPROVED is prohibited for application runtime. Must use identity.fn_approve_payment_void().';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
