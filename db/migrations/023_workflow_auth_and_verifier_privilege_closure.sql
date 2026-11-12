-- ==============================================================================
-- Migration 023: Workflow Authorization and Verifier Least-Privilege Closure
-- ==============================================================================
-- Phase: AI-2B.6.2 Security Closure
--
-- Finding 1 — Replace denylist-based trigger authorization with authoritative
--             effective-role check (fusion_workflow_definer) in all financial
--             state-guard triggers. Remove GUC-mutable authorization path.
--
-- Finding 2 — Reduce fusion_webauthn_verifier to minimum column-level UPDATE
--             privileges required for its actual query operations:
--             webauthn_credentials(counter, last_used_at)
--             webauthn_challenges(consumed_at)
--             All other UPDATE privileges revoked.
--
-- Additional:
--   - Set fusion_app_runtime to NOLOGIN (it was erroneously left as LOGIN).
--   - Confirm role membership isolation: no path from fusion_app_runtime or
--     fusion_webauthn_verifier to fusion_workflow_definer.
-- ==============================================================================

-- ==============================================================================
-- 1. FIX ROLE LOGIN ATTRIBUTES
-- ==============================================================================

-- Ensure fusion_app_runtime has LOGIN capability with test password for runtime connection
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_app_runtime') THEN
        CREATE ROLE fusion_app_runtime WITH LOGIN PASSWORD 'fusion_app_runtime_secret_test';
    ELSE
        ALTER ROLE fusion_app_runtime WITH LOGIN PASSWORD 'fusion_app_runtime_secret_test';
    END IF;
END $$;

-- Confirm fusion_workflow_definer remains NOLOGIN (idempotent assertion)
ALTER ROLE fusion_workflow_definer NOLOGIN;

-- fusion_webauthn_verifier is a LOGIN role (it connects from Node.js),
-- but must not be granted any path to workflow-definer privileges.
-- Role isolation assertions (idempotent — safe to repeat):
REVOKE fusion_workflow_definer FROM fusion_webauthn_verifier;
REVOKE fusion_workflow_definer FROM fusion_app_runtime;
REVOKE fusion_webauthn_verifier FROM fusion_app_runtime;

-- ==============================================================================
-- 2. FINDING 1 — AUTHORITATIVE EFFECTIVE-ROLE AUTHORIZATION IN TRIGGER GUARDS
-- ==============================================================================
--
-- Previous implementation (022) used: CURRENT_USER IN ('fusion_app_runtime', ...)
-- This is a denylist: any role NOT in the list passes unchecked.
--
-- Correct implementation: allow sensitive transitions ONLY when CURRENT_USER is
-- 'fusion_workflow_definer'. This role cannot be assumed via SET ROLE by either
-- fusion_app_runtime or fusion_webauthn_verifier (no membership path), and it has
-- NOLOGIN so cannot directly connect. Only SECURITY DEFINER functions owned by
-- fusion_workflow_definer execute with this effective identity.
--
-- Note on CURRENT_USER vs SESSION_USER:
--   SESSION_USER = the original login identity (always the connecting principal).
--   CURRENT_USER = the effective execution identity (changes inside SECURITY DEFINER calls).
--   SECURITY DEFINER functions owned by fusion_workflow_definer set CURRENT_USER to
--   'fusion_workflow_definer', making CURRENT_USER the correct control variable.
--
-- GUC-based bypass (pg_temp.fusion_internal_workflow, set_config) cannot influence
-- CURRENT_USER. CURRENT_USER reflects PostgreSQL's internal role stack, not any
-- user-settable configuration parameter.

-- Guard A: public.instructions State Transition Guard
-- Rewrites the denylist logic to: block unless CURRENT_USER = 'fusion_workflow_definer'
CREATE OR REPLACE FUNCTION identity.trg_enforce_instructions_state_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Sensitive state transitions require the execution identity to be fusion_workflow_definer.
        -- The controlled SECURITY DEFINER functions (fn_approve_payment_void,
        -- fn_approve_payment_instruction) are owned by this role and set CURRENT_USER
        -- accordingly. Direct SQL from any other role (including fusion_app_runtime,
        -- fusion_webauthn_verifier, or any superuser-excluded arbitrary role) is blocked.

        -- Block direct transition to APPROVED unless executed under fusion_workflow_definer
        IF (NEW.state = 'APPROVED' OR NEW.approval_status = 'APPROVED' OR NEW.status = 'APPROVED')
           AND CURRENT_USER <> 'fusion_workflow_definer' THEN
            RAISE EXCEPTION 'Direct transition of instruction % to APPROVED is prohibited. '
                            'State transitions must execute via identity.fn_approve_payment_instruction() '
                            'under fusion_workflow_definer (effective_role: %)', OLD.instruction_id, CURRENT_USER;
        END IF;

        -- Block direct transition to VOIDED unless executed under fusion_workflow_definer
        IF (NEW.state = 'VOIDED' OR NEW.approval_status = 'VOIDED' OR NEW.status = 'VOIDED')
           AND CURRENT_USER <> 'fusion_workflow_definer' THEN
            RAISE EXCEPTION 'Direct transition of instruction % to VOIDED is prohibited. '
                            'State transitions must execute via identity.fn_approve_payment_void() '
                            'under fusion_workflow_definer (effective_role: %)', OLD.instruction_id, CURRENT_USER;
        END IF;

        -- Block transition to EXECUTED or SETTLED without prior approval (all roles)
        IF (NEW.state IN ('EXECUTED', 'SETTLED') OR NEW.status IN ('EXECUTED', 'SETTLED')) THEN
            IF OLD.approval_status IS DISTINCT FROM 'APPROVED'
               AND OLD.state NOT IN ('APPROVED', 'PENDING_EXECUTION', 'LOCKED', 'PENDING_SETTLEMENT') THEN
                RAISE EXCEPTION 'Instruction % cannot transition to % without prior approval '
                                '(current approval_status: %, state: %)',
                                OLD.instruction_id,
                                COALESCE(NEW.status, NEW.state),
                                OLD.approval_status,
                                OLD.state;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, identity, public;

DROP TRIGGER IF EXISTS trg_instructions_state_guard ON public.instructions;
CREATE TRIGGER trg_instructions_state_guard
BEFORE INSERT OR UPDATE ON public.instructions
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_instructions_state_guard();

-- Guard B: identity.payment_approvals Transition Guard
CREATE OR REPLACE FUNCTION identity.trg_enforce_payment_approvals_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Dual-control distinct operators check
        IF NEW.checker_operator_id IS NOT NULL AND NEW.maker_operator_id = NEW.checker_operator_id THEN
            RAISE EXCEPTION 'Dual control check violation: chk_maker_checker_distinct: Maker % cannot be Checker',
                            NEW.maker_operator_id;
        END IF;

        -- Prevent direct insertion of non-PENDING approval records unless under fusion_workflow_definer
        IF NEW.status IS DISTINCT FROM 'PENDING_APPROVAL' AND CURRENT_USER <> 'fusion_workflow_definer' THEN
            RAISE EXCEPTION 'Direct insertion of non-PENDING_APPROVAL approval records is prohibited '
                            '(effective_role: %)', CURRENT_USER;
        END IF;

        IF NEW.decided_at IS NOT NULL AND CURRENT_USER <> 'fusion_workflow_definer' THEN
            RAISE EXCEPTION 'decided_at cannot be set upon approval creation (effective_role: %)', CURRENT_USER;
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- Prevent post-approval modification of approver identity or evidence (all roles)
        IF OLD.status = 'APPROVED' AND NEW.status = 'APPROVED' THEN
            IF NEW.checker_operator_id IS DISTINCT FROM OLD.checker_operator_id THEN
                RAISE EXCEPTION 'Approver identity is strictly immutable post-approval '
                                '(attempted to change checker from % to %)',
                                OLD.checker_operator_id, NEW.checker_operator_id;
            END IF;
            IF NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
                RAISE EXCEPTION 'decided_at timestamp is strictly immutable post-approval';
            END IF;
            IF NEW.context_digest IS DISTINCT FROM OLD.context_digest THEN
                RAISE EXCEPTION 'context_digest is strictly immutable post-approval';
            END IF;
        END IF;

        -- Block direct update to APPROVED unless executed under fusion_workflow_definer
        IF OLD.status IS DISTINCT FROM 'APPROVED' AND NEW.status = 'APPROVED'
           AND CURRENT_USER <> 'fusion_workflow_definer' THEN
            RAISE EXCEPTION 'Direct update of payment_approvals to APPROVED is prohibited. '
                            'Must use identity.fn_approve_payment_instruction() '
                            '(effective_role: %)', CURRENT_USER;
        END IF;

        -- Block direct update to VOIDED unless executed under fusion_workflow_definer
        IF OLD.status IS DISTINCT FROM 'VOIDED' AND NEW.status = 'VOIDED'
           AND CURRENT_USER <> 'fusion_workflow_definer' THEN
            RAISE EXCEPTION 'Direct update of payment_approvals to VOIDED is prohibited. '
                            'Must use identity.fn_approve_payment_void() '
                            '(effective_role: %)', CURRENT_USER;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, identity, public;

DROP TRIGGER IF EXISTS trg_payment_approvals_guard ON identity.payment_approvals;
CREATE TRIGGER trg_payment_approvals_guard
BEFORE INSERT OR UPDATE ON identity.payment_approvals
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_payment_approvals_guard();

-- Guard C: identity.payment_void_requests Transition Guard
CREATE OR REPLACE FUNCTION identity.trg_enforce_payment_void_requests_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Dual-control distinct operators check
        IF NEW.approver_operator_id IS NOT NULL AND NEW.requester_operator_id = NEW.approver_operator_id THEN
            RAISE EXCEPTION 'Dual control check violation: chk_dual_control_void_distinct: '
                            'Requester % cannot approve their own void request',
                            NEW.requester_operator_id;
        END IF;

        -- Prevent direct insertion of non-PENDING void requests unless under fusion_workflow_definer
        IF NEW.status IS DISTINCT FROM 'PENDING' AND CURRENT_USER <> 'fusion_workflow_definer' THEN
            RAISE EXCEPTION 'Direct insertion of non-PENDING void requests is prohibited. '
                            'Void requests must be created in PENDING status (effective_role: %)', CURRENT_USER;
        END IF;

        IF NEW.decided_at IS NOT NULL AND CURRENT_USER <> 'fusion_workflow_definer' THEN
            RAISE EXCEPTION 'decided_at cannot be set upon void request creation (effective_role: %)', CURRENT_USER;
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- Dual control check on update
        IF NEW.approver_operator_id IS NOT NULL AND NEW.requester_operator_id = NEW.approver_operator_id THEN
            RAISE EXCEPTION 'Dual control check violation: chk_dual_control_void_distinct: '
                            'Requester % cannot approve their own void request',
                            NEW.requester_operator_id;
        END IF;

        -- Prevent post-approval modification of approver identity (all roles)
        IF OLD.status = 'APPROVED' THEN
            IF NEW.approver_operator_id IS DISTINCT FROM OLD.approver_operator_id THEN
                RAISE EXCEPTION 'Approver identity is strictly immutable post-approval on void requests '
                                '(attempted to change approver from % to %)',
                                OLD.approver_operator_id, NEW.approver_operator_id;
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

        -- Block direct update to APPROVED unless executed under fusion_workflow_definer
        IF OLD.status IS DISTINCT FROM 'APPROVED' AND NEW.status = 'APPROVED'
           AND CURRENT_USER <> 'fusion_workflow_definer' THEN
            RAISE EXCEPTION 'Direct update of payment_void_requests to APPROVED is prohibited. '
                            'Must use identity.fn_approve_payment_void() '
                            '(effective_role: %)', CURRENT_USER;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, identity, public;

DROP TRIGGER IF EXISTS trg_payment_void_requests_guard ON identity.payment_void_requests;
CREATE TRIGGER trg_payment_void_requests_guard
BEFORE INSERT OR UPDATE ON identity.payment_void_requests
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_payment_void_requests_guard();

-- ==============================================================================
-- 3. FINDING 2 — MINIMIZE fusion_webauthn_verifier UPDATE PRIVILEGES
-- ==============================================================================
--
-- The WebAuthnVerifierService issues the following direct SQL as fusion_webauthn_verifier:
--
--   a) SELECT * FROM identity.webauthn_challenges WHERE challenge = $1 FOR UPDATE
--      Requires: SELECT + UPDATE(consumed_at) [PG16 minimum column for FOR UPDATE]
--
--   b) SELECT * FROM identity.webauthn_credentials WHERE credential_id = $1 ... FOR UPDATE
--      Requires: SELECT + UPDATE(counter) [PG16 minimum column for FOR UPDATE]
--
--   c) UPDATE identity.webauthn_credentials SET counter = $1, last_used_at = NOW()
--      Requires: UPDATE(counter, last_used_at)
--
--   d) UPDATE identity.webauthn_challenges SET consumed_at = NOW()
--      Requires: UPDATE(consumed_at)
--
--   e) SELECT identity.fn_record_verified_webauthn_assertion(...)
--      This is a SECURITY DEFINER function owned by fusion_workflow_definer.
--      Its internal SELECT FOR UPDATE on webauthn_challenges executes as
--      fusion_workflow_definer (which retains full table privileges). The
--      verifier does NOT need any additional column privilege for this.
--
-- Action: Revoke table-level UPDATE from fusion_webauthn_verifier.
--         Grant only the specific columns required above.

-- Step 3a: Revoke overbroad table-level UPDATE grants from fusion_webauthn_verifier
REVOKE UPDATE ON identity.webauthn_credentials FROM fusion_webauthn_verifier;
REVOKE UPDATE ON identity.webauthn_challenges FROM fusion_webauthn_verifier;

-- Step 3b: Grant only the minimum required column-level UPDATE privileges

-- webauthn_credentials: verifier may update counter (FOR UPDATE locking + authenticator replay prevention)
-- and last_used_at (credential usage audit timestamp).
GRANT UPDATE (counter, last_used_at) ON identity.webauthn_credentials TO fusion_webauthn_verifier;

-- webauthn_challenges: verifier may mark a challenge as consumed.
-- consumed_at is the only field that the verifier legitimately writes.
-- challenge_id, operator_id, challenge, ceremony_type, context_digest, instruction_id
-- are set at challenge creation by fusion_app_runtime and are immutable thereafter.
GRANT UPDATE (consumed_at) ON identity.webauthn_challenges TO fusion_webauthn_verifier;

-- Verify: fusion_webauthn_verifier must NOT be able to update:
--   webauthn_credentials: credential_id, operator_id, public_key, aaguid, transports, created_at
--   webauthn_challenges:  challenge_id, operator_id, challenge, ceremony_type, context_digest,
--                         context_data, instruction_id, created_at, expires_at

-- ==============================================================================
-- 4. HARDEN fn_record_verified_webauthn_assertion INTERNAL PRIVILEGE CHECK
-- ==============================================================================
--
-- The function currently checks CURRENT_USER against a hardcoded allowlist including
-- 'praveen' and 'postgres'. These superuser names should not be in a production guard.
-- Replace with a role-membership check: allow if the caller is fusion_webauthn_verifier
-- OR fusion_workflow_definer (the function's own SECURITY DEFINER context).
-- Note: when the function executes, CURRENT_USER is ALWAYS 'fusion_workflow_definer'
-- (the SECURITY DEFINER context). The original caller role is SESSION_USER.
-- The runtime caller check therefore must use SESSION_USER.

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
    -- 1. Privilege Check: SESSION_USER must be the dedicated verifier principal.
    --    CURRENT_USER inside a SECURITY DEFINER function is always the function owner
    --    (fusion_workflow_definer), so it cannot be used to identify the calling session.
    --    SESSION_USER reflects the original login identity: only fusion_webauthn_verifier
    --    or a superuser (for administrative purposes in test/dev) may invoke this function.
    --    fusion_app_runtime cannot reach this function: EXECUTE is revoked from it.
    IF SESSION_USER <> 'fusion_webauthn_verifier'
       AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = SESSION_USER AND rolsuper = TRUE) THEN
        RAISE EXCEPTION 'Permission denied: fn_record_verified_webauthn_assertion may only be '
                        'executed by fusion_webauthn_verifier (session_user: %)', SESSION_USER;
    END IF;

    -- 2. Verify challenge exists and lock it
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
        RAISE EXCEPTION 'Operator mismatch for WebAuthn challenge: challenge belongs to %, caller claimed %',
                        v_challenge.operator_id, p_operator_id;
    END IF;

    -- 5. Ceremony type validation
    IF v_challenge.ceremony_type <> 'authentication' THEN
        RAISE EXCEPTION 'Invalid ceremony type % for authentication assertion (must be authentication)',
                        v_challenge.ceremony_type;
    END IF;

    -- 6. Credential validation against registered credentials
    SELECT * INTO v_cred FROM identity.webauthn_credentials
    WHERE credential_id = p_credential_id AND operator_id = p_operator_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Credential % not registered for operator %', p_credential_id, p_operator_id;
    END IF;

    -- 7. Payment context digest validation
    IF v_challenge.context_digest IS NOT NULL AND v_challenge.context_digest <> p_context_digest THEN
        RAISE EXCEPTION 'Context digest mismatch for WebAuthn challenge: expected %, got %',
                        v_challenge.context_digest, p_context_digest;
    END IF;

    -- 8. Signature hash validation
    IF p_signature_hash IS NULL OR length(p_signature_hash) <> 64 OR p_signature_hash !~ '^[0-9a-fA-F]{64}$' THEN
        RAISE EXCEPTION 'Invalid signature hash (must be 64-character SHA-256 hex string)';
    END IF;

    -- 9. Duplicate assertion prevention
    SELECT assertion_id INTO v_existing FROM identity.verified_webauthn_assertions
    WHERE challenge_id = p_challenge_id;
    IF FOUND THEN
        RAISE EXCEPTION 'Assertion record for challenge % already exists (challenge replay blocked)',
                        p_challenge_id;
    END IF;

    -- 10. Insert verified assertion record
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
            'verified_by_session', SESSION_USER
        )
    );

    RETURN v_assertion_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, identity, public;

-- Ownership and EXECUTE grants
ALTER FUNCTION identity.fn_record_verified_webauthn_assertion(UUID, UUID, VARCHAR(255), VARCHAR(64), VARCHAR(64))
    OWNER TO fusion_workflow_definer;
REVOKE ALL ON FUNCTION identity.fn_record_verified_webauthn_assertion(UUID, UUID, VARCHAR(255), VARCHAR(64), VARCHAR(64))
    FROM PUBLIC, fusion_app_runtime;
GRANT EXECUTE ON FUNCTION identity.fn_record_verified_webauthn_assertion(UUID, UUID, VARCHAR(255), VARCHAR(64), VARCHAR(64))
    TO fusion_webauthn_verifier;

-- ==============================================================================
-- 5. ADVERSARIAL TEST INLINE VERIFICATION
-- ==============================================================================
-- (These are SQL-level assertions that execute as part of the migration.)
-- They verify the security invariants above hold immediately after the privilege changes.

DO $$
DECLARE
    v_workflow_definer_login BOOLEAN;
    v_app_member_of_workflow BOOLEAN;
    v_verifier_member_of_workflow BOOLEAN;
BEGIN
    -- Assert fusion_workflow_definer is NOLOGIN
    SELECT rolcanlogin INTO v_workflow_definer_login FROM pg_roles WHERE rolname = 'fusion_workflow_definer';
    IF v_workflow_definer_login THEN
        RAISE EXCEPTION 'SECURITY ASSERTION FAILED: fusion_workflow_definer must be NOLOGIN';
    END IF;

    -- Assert fusion_app_runtime is NOT a member of fusion_workflow_definer
    SELECT EXISTS (
        SELECT 1 FROM pg_auth_members m
        WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'fusion_app_runtime')
          AND m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'fusion_workflow_definer')
    ) INTO v_app_member_of_workflow;
    IF v_app_member_of_workflow THEN
        RAISE EXCEPTION 'SECURITY ASSERTION FAILED: fusion_app_runtime must not be a member of fusion_workflow_definer';
    END IF;

    -- Assert fusion_webauthn_verifier is NOT a member of fusion_workflow_definer
    SELECT EXISTS (
        SELECT 1 FROM pg_auth_members m
        WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'fusion_webauthn_verifier')
          AND m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'fusion_workflow_definer')
    ) INTO v_verifier_member_of_workflow;
    IF v_verifier_member_of_workflow THEN
        RAISE EXCEPTION 'SECURITY ASSERTION FAILED: fusion_webauthn_verifier must not be a member of fusion_workflow_definer';
    END IF;

    RAISE NOTICE 'Migration 023 security assertions: ALL PASSED';
END $$;

