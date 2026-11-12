-- ==============================================================================
-- Migration 024: Payment Execution Authorization and Settlement Evidence
-- ==============================================================================
-- Phase: AI-2B.6.3 Security Closure
--
-- Finding 1 — Protect EXECUTED and SETTLED transitions:
--   1. Direct SQL from fusion_app_runtime must not be sufficient to mark an
--      instruction EXECUTED or SETTLED.
--   2. Require controlled SECURITY DEFINER workflow functions owned by
--      fusion_workflow_definer:
--        - identity.fn_execute_payment_instruction(...)
--        - identity.fn_settle_payment_instruction(...)
--   3. Validate authorized dispatch records, provider identity (STRIPE_TEST,
--      RAZORPAYX_TEST, STELLAR_TESTNET, SIMULATED_BTC, SIMULATED_ETH),
--      environment allowlist, idempotency key, and synthetic provider result
--      during execution.
--   4. Validate settlement evidence and underlying execution reference during settlement.
--   5. Prevent duplicate execution and duplicate settlement.
--   6. Preserve atomic transactions, immutable history, and sandbox/testnet allowlists.
--
-- Finding 2 — Verifier Isolation & Privilege Enforcement:
--   - Prohibit fusion_app_runtime from assuming verifier or workflow roles.
--   - Maintain immutable audit trail in identity.auth_audit_log.
-- ==============================================================================

-- ==============================================================================
-- 1. PAYMENT DISPATCH RECORDS TABLE (Append-Only Authorized Execution Evidence)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS identity.payment_dispatch_records (
    dispatch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instruction_id UUID NOT NULL REFERENCES public.instructions(instruction_id),
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    provider VARCHAR(64) NOT NULL CHECK (
        provider IN (
            'STRIPE_TEST', 'RAZORPAYX_TEST', 'STELLAR_TESTNET',
            'SIMULATED_BTC', 'SIMULATED_ETH', 'SIMULATED_ALIPAY', 'SIMULATED_BANK_RAIL'
        )
    ),
    environment VARCHAR(32) NOT NULL CHECK (
        environment IN ('sandbox', 'testnet', 'test', 'local', 'development')
    ),
    operator_id UUID,
    provider_result JSONB NOT NULL,
    dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_dispatch_instruction_id UNIQUE (instruction_id)
);

-- ==============================================================================
-- 2. PAYMENT SETTLEMENT EVIDENCE TABLE (Append-Only Settlement Evidence)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS identity.payment_settlement_evidence (
    settlement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instruction_id UUID NOT NULL REFERENCES public.instructions(instruction_id),
    dispatch_id UUID NOT NULL REFERENCES identity.payment_dispatch_records(dispatch_id),
    provider_tx_reference VARCHAR(256) NOT NULL,
    provider VARCHAR(64) NOT NULL,
    evidence_payload JSONB NOT NULL,
    settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_settlement_instruction_id UNIQUE (instruction_id)
);

-- ==============================================================================
-- 3. STRICT APPEND-ONLY TRIGGERS FOR DISPATCH & SETTLEMENT EVIDENCE
-- ==============================================================================

CREATE OR REPLACE FUNCTION identity.trg_enforce_append_only_evidence()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Table % is strictly append-only: modifications and deletions are prohibited', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_dispatch_records_append_only ON identity.payment_dispatch_records;
CREATE TRIGGER trg_payment_dispatch_records_append_only
BEFORE UPDATE OR DELETE ON identity.payment_dispatch_records
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_append_only_evidence();

DROP TRIGGER IF EXISTS trg_payment_settlement_evidence_append_only ON identity.payment_settlement_evidence;
CREATE TRIGGER trg_payment_settlement_evidence_append_only
BEFORE UPDATE OR DELETE ON identity.payment_settlement_evidence
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_append_only_evidence();

-- ==============================================================================
-- 4. UPDATE MATERIAL FREEZE TRIGGER TO INCLUDE EXECUTED STATE
-- ==============================================================================

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
            ELSIF OLD.state = 'MANUAL_CHECK' AND NOT (NEW.state IN ('MANUAL_CHECK', 'SETTLED', 'FAILED')) THEN
                RAISE EXCEPTION 'Illegal state transition from MANUAL_CHECK to % for instruction %', NEW.state, OLD.instruction_id;
            END IF;
        END IF;

        -- RULE 3: APPROVED / EXECUTED instruction immutability
        IF OLD.state IN ('APPROVED', 'EXECUTED') OR OLD.approval_status = 'APPROVED' THEN
            -- An approved instruction cannot be returned to INITIATED or PENDING_APPROVAL
            IF NEW.state IN ('INITIATED', 'PENDING_APPROVAL') OR NEW.approval_status IN ('INITIATED', 'PENDING_APPROVAL') THEN
                RAISE EXCEPTION 'Approved payment instruction cannot be returned to % or % (instruction terms are frozen post-approval)', NEW.state, NEW.approval_status;
            END IF;

            -- Material payment fields are strictly immutable post-approval (even with version increments)
            IF (NEW.amount IS DISTINCT FROM OLD.amount) OR
               (NEW.currency IS DISTINCT FROM OLD.currency) OR
               (NEW.recipient IS DISTINCT FROM OLD.recipient) OR
               (NEW.destination_account IS DISTINCT FROM OLD.destination_account) THEN
                RAISE EXCEPTION 'Approved payment instructions are strictly immutable. Material payment terms (amount, currency, recipient, destination_account) cannot be altered after approval. To void an approved instruction, transition to VOIDED without changing payment terms.';
            END IF;

        -- RULE 4: PENDING_APPROVAL instruction controlled amendment
        ELSIF OLD.state = 'PENDING_APPROVAL' OR OLD.approval_status = 'PENDING_APPROVAL' THEN
            -- Check if any material field changed
            IF (NEW.amount IS DISTINCT FROM OLD.amount) OR
               (NEW.currency IS DISTINCT FROM OLD.currency) OR
               (NEW.recipient IS DISTINCT FROM OLD.recipient) OR
               (NEW.destination_account IS DISTINCT FROM OLD.destination_account) THEN

                -- Controlled amendment requires version increment, cancellation of pending approval, and state reset to INITIATED
                IF NOT (NEW.version = OLD.version + 1 AND NEW.approval_status = 'CANCELLED' AND NEW.state = 'INITIATED') THEN
                    RAISE EXCEPTION 'Material payment fields (amount, currency, recipient, destination_account) cannot be altered while in PENDING_APPROVAL or APPROVED without version increment and approval cancellation (requires version + 1, approval_status = CANCELLED, and state = INITIATED)';
                END IF;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ==============================================================================
-- 5. CONTROLLED SECURITY DEFINER EXECUTION FUNCTION
-- ==============================================================================

CREATE OR REPLACE FUNCTION identity.fn_execute_payment_instruction(
    p_instruction_id UUID,
    p_operator_id UUID,
    p_idempotency_key VARCHAR,
    p_provider VARCHAR,
    p_environment VARCHAR,
    p_provider_result JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, identity, public
AS $$
DECLARE
    v_inst RECORD;
    v_dispatch_id UUID;
    v_existing RECORD;
BEGIN
    -- 1. Input parameter validation
    IF p_instruction_id IS NULL THEN
        RAISE EXCEPTION 'p_instruction_id is required';
    END IF;
    IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
        RAISE EXCEPTION 'p_idempotency_key is required for payment execution dispatch';
    END IF;
    IF p_provider IS NULL OR p_provider NOT IN (
        'STRIPE_TEST', 'RAZORPAYX_TEST', 'STELLAR_TESTNET',
        'SIMULATED_BTC', 'SIMULATED_ETH', 'SIMULATED_ALIPAY', 'SIMULATED_BANK_RAIL'
    ) THEN
        RAISE EXCEPTION 'Provider % is not in permitted sandbox/testnet provider allowlist (STRIPE_TEST, RAZORPAYX_TEST, STELLAR_TESTNET, SIMULATED_BTC, SIMULATED_ETH)', p_provider;
    END IF;
    IF p_environment IS NULL OR p_environment NOT IN ('sandbox', 'testnet', 'test', 'local', 'development') THEN
        RAISE EXCEPTION 'Environment % is not in permitted sandbox/testnet environment allowlist', p_environment;
    END IF;
    IF p_provider_result IS NULL THEN
        RAISE EXCEPTION 'Synthetic provider execution result payload is required';
    END IF;

    -- 2. Lock instruction FOR UPDATE
    SELECT * INTO v_inst FROM public.instructions WHERE instruction_id = p_instruction_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Instruction % not found', p_instruction_id;
    END IF;

    -- Terminal VOIDED check
    IF v_inst.state = 'VOIDED' OR v_inst.approval_status = 'VOIDED' THEN
        RAISE EXCEPTION 'Instruction % is VOIDED and cannot be executed', p_instruction_id;
    END IF;

    -- Prior approval check
    IF v_inst.approval_status IS DISTINCT FROM 'APPROVED' AND v_inst.state NOT IN ('APPROVED', 'PENDING_EXECUTION') THEN
        RAISE EXCEPTION 'Instruction % must be APPROVED before execution (current state: %, approval_status: %)',
                        p_instruction_id, v_inst.state, v_inst.approval_status;
    END IF;

    -- Duplicate execution check
    IF v_inst.state IN ('EXECUTED', 'SETTLED') THEN
        RAISE EXCEPTION 'Instruction % has already been executed (state: %, duplicate execution blocked)',
                        p_instruction_id, v_inst.state;
    END IF;

    -- Existing dispatch check
    SELECT * INTO v_existing FROM identity.payment_dispatch_records
    WHERE instruction_id = p_instruction_id;
    IF FOUND THEN
        RAISE EXCEPTION 'Instruction % already has an authorized dispatch record % (duplicate execution blocked)',
                        p_instruction_id, v_existing.dispatch_id;
    END IF;

    -- Idempotency key uniqueness check
    SELECT * INTO v_existing FROM identity.payment_dispatch_records
    WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
        RAISE EXCEPTION 'Idempotency key % already used for dispatch % (duplicate execution blocked)',
                        p_idempotency_key, v_existing.dispatch_id;
    END IF;

    -- 3. Record authorized dispatch
    INSERT INTO identity.payment_dispatch_records (
        instruction_id,
        idempotency_key,
        provider,
        environment,
        operator_id,
        provider_result,
        dispatched_at
    ) VALUES (
        p_instruction_id,
        p_idempotency_key,
        p_provider,
        p_environment,
        p_operator_id,
        p_provider_result,
        NOW()
    ) RETURNING dispatch_id INTO v_dispatch_id;

    -- 4. Transition instruction state to EXECUTED
    UPDATE public.instructions
    SET state = 'EXECUTED',
        provider = p_provider,
        environment = p_environment,
        updated_at = NOW()
    WHERE instruction_id = p_instruction_id;

    -- 5. Audit log
    INSERT INTO identity.auth_audit_log (
        event_type, operator_id, metadata
    ) VALUES (
        'PAYMENT_EXECUTED',
        p_operator_id,
        jsonb_build_object(
            'instruction_id', p_instruction_id,
            'dispatch_id', v_dispatch_id,
            'provider', p_provider,
            'environment', p_environment,
            'idempotency_key', p_idempotency_key
        )
    );

    RETURN jsonb_build_object(
        'dispatch_id', v_dispatch_id,
        'instruction_id', p_instruction_id,
        'status', 'EXECUTED',
        'provider', p_provider,
        'environment', p_environment,
        'idempotency_key', p_idempotency_key
    );
END;
$$;

-- ==============================================================================
-- 6. CONTROLLED SECURITY DEFINER SETTLEMENT FUNCTION
-- ==============================================================================

CREATE OR REPLACE FUNCTION identity.fn_settle_payment_instruction(
    p_instruction_id UUID,
    p_dispatch_id UUID,
    p_provider_tx_reference VARCHAR,
    p_evidence_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, identity, public
AS $$
DECLARE
    v_inst RECORD;
    v_dispatch RECORD;
    v_settlement_id UUID;
    v_existing_settlement RECORD;
BEGIN
    -- 1. Input parameter validation
    IF p_instruction_id IS NULL THEN
        RAISE EXCEPTION 'p_instruction_id is required';
    END IF;
    IF p_dispatch_id IS NULL THEN
        RAISE EXCEPTION 'p_dispatch_id is required for settlement';
    END IF;
    IF p_provider_tx_reference IS NULL OR length(trim(p_provider_tx_reference)) = 0 THEN
        RAISE EXCEPTION 'p_provider_tx_reference is required for settlement';
    END IF;
    IF p_evidence_payload IS NULL THEN
        RAISE EXCEPTION 'Settlement evidence payload is required';
    END IF;

    -- 2. Lock instruction FOR UPDATE
    SELECT * INTO v_inst FROM public.instructions WHERE instruction_id = p_instruction_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Instruction % not found', p_instruction_id;
    END IF;

    -- Terminal VOIDED check
    IF v_inst.state = 'VOIDED' OR v_inst.approval_status = 'VOIDED' THEN
        RAISE EXCEPTION 'Instruction % is VOIDED and cannot be settled', p_instruction_id;
    END IF;

    -- Terminal SETTLED check (duplicate settlement blocked)
    IF v_inst.state = 'SETTLED' THEN
        RAISE EXCEPTION 'Instruction % is already SETTLED (duplicate settlement blocked)', p_instruction_id;
    END IF;

    -- Prior EXECUTED check
    IF v_inst.state <> 'EXECUTED' AND v_inst.state NOT IN ('PENDING_SETTLEMENT') THEN
        RAISE EXCEPTION 'Instruction % must be in EXECUTED state before settlement (current state: %)',
                        p_instruction_id, v_inst.state;
    END IF;

    -- 3. Validate underlying dispatch record
    SELECT * INTO v_dispatch FROM identity.payment_dispatch_records
    WHERE dispatch_id = p_dispatch_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No authorized dispatch record % found (settlement evidence rejected)', p_dispatch_id;
    END IF;

    IF v_dispatch.instruction_id <> p_instruction_id THEN
        RAISE EXCEPTION 'Dispatch record % belongs to instruction %, not instruction % (settlement rejected)',
                        p_dispatch_id, v_dispatch.instruction_id, p_instruction_id;
    END IF;

    -- Duplicate settlement evidence check
    SELECT * INTO v_existing_settlement FROM identity.payment_settlement_evidence
    WHERE instruction_id = p_instruction_id;
    IF FOUND THEN
        RAISE EXCEPTION 'Settlement evidence already exists for instruction % (duplicate settlement blocked)',
                        p_instruction_id;
    END IF;

    -- Provider transaction reference consistency / anti-substitution check
    IF v_dispatch.provider_result ? 'intent_id' AND v_dispatch.provider_result->>'intent_id' <> p_provider_tx_reference THEN
        IF NOT (v_dispatch.provider_result ? 'utr' AND v_dispatch.provider_result->>'utr' = p_provider_tx_reference) THEN
            RAISE EXCEPTION 'Provider transaction reference % does not match dispatch record intent_id % (substitution blocked)',
                            p_provider_tx_reference, v_dispatch.provider_result->>'intent_id';
        END IF;
    END IF;

    -- 4. Record settlement evidence
    INSERT INTO identity.payment_settlement_evidence (
        instruction_id,
        dispatch_id,
        provider_tx_reference,
        provider,
        evidence_payload,
        settled_at
    ) VALUES (
        p_instruction_id,
        p_dispatch_id,
        p_provider_tx_reference,
        v_dispatch.provider,
        p_evidence_payload,
        NOW()
    ) RETURNING settlement_id INTO v_settlement_id;

    -- 5. Transition instruction to SETTLED
    UPDATE public.instructions
    SET state = 'SETTLED',
        status = 'SETTLED',
        utr = COALESCE(utr, p_provider_tx_reference),
        external_intent_id = COALESCE(external_intent_id, p_provider_tx_reference),
        updated_at = NOW()
    WHERE instruction_id = p_instruction_id;

    -- 6. Audit log
    INSERT INTO identity.auth_audit_log (
        event_type, operator_id, metadata
    ) VALUES (
        'PAYMENT_SETTLED',
        v_dispatch.operator_id,
        jsonb_build_object(
            'instruction_id', p_instruction_id,
            'settlement_id', v_settlement_id,
            'dispatch_id', p_dispatch_id,
            'provider_tx_reference', p_provider_tx_reference,
            'provider', v_dispatch.provider
        )
    );

    RETURN jsonb_build_object(
        'settlement_id', v_settlement_id,
        'instruction_id', p_instruction_id,
        'status', 'SETTLED',
        'provider_tx_reference', p_provider_tx_reference,
        'provider', v_dispatch.provider
    );
END;
$$;

-- ==============================================================================
-- 7. UPDATE INSTRUCTIONS STATE GUARD TRIGGER
-- ==============================================================================

CREATE OR REPLACE FUNCTION identity.trg_enforce_instructions_state_guard()
RETURNS TRIGGER AS $$
DECLARE
    v_is_super BOOLEAN := FALSE;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- RULE 0: Terminal state protection: VOIDED cannot be modified or transitioned out
        IF OLD.state = 'VOIDED' OR OLD.approval_status = 'VOIDED' THEN
            RAISE EXCEPTION 'Instruction % is in terminal state VOIDED and cannot be modified or transitioned', OLD.instruction_id;
        END IF;

        -- Check if current execution role is a superuser (for database maintenance)
        SELECT rolsuper INTO v_is_super FROM pg_roles WHERE rolname = CURRENT_USER;

        -- Block direct transition to APPROVED unless executed under fusion_workflow_definer
        IF ((NEW.state = 'APPROVED' AND OLD.state IS DISTINCT FROM 'APPROVED')
            OR (NEW.approval_status = 'APPROVED' AND OLD.approval_status IS DISTINCT FROM 'APPROVED')
            OR (NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED'))
           AND CURRENT_USER <> 'fusion_workflow_definer' THEN
            RAISE EXCEPTION 'Direct transition of instruction % to APPROVED is prohibited. '
                            'State transitions must execute via identity.fn_approve_payment_instruction() '
                            'under fusion_workflow_definer (effective_role: %)', OLD.instruction_id, CURRENT_USER;
        END IF;

        -- Block direct transition to VOIDED unless executed under fusion_workflow_definer
        IF ((NEW.state = 'VOIDED' AND OLD.state IS DISTINCT FROM 'VOIDED')
            OR (NEW.approval_status = 'VOIDED' AND OLD.approval_status IS DISTINCT FROM 'VOIDED')
            OR (NEW.status = 'VOIDED' AND OLD.status IS DISTINCT FROM 'VOIDED'))
           AND CURRENT_USER <> 'fusion_workflow_definer' THEN
            RAISE EXCEPTION 'Direct transition of instruction % to VOIDED is prohibited. '
                            'State transitions must execute via identity.fn_approve_payment_void() '
                            'under fusion_workflow_definer (effective_role: %)', OLD.instruction_id, CURRENT_USER;
        END IF;

        -- Block direct transition to EXECUTED from fusion_app_runtime, fusion_webauthn_verifier,
        -- or any non-workflow non-superuser role
        IF (NEW.state = 'EXECUTED' OR NEW.status = 'EXECUTED') THEN
            IF CURRENT_USER = 'fusion_app_runtime'
               OR CURRENT_USER = 'fusion_webauthn_verifier'
               OR (CURRENT_USER <> 'fusion_workflow_definer' AND NOT COALESCE(v_is_super, FALSE)) THEN
                RAISE EXCEPTION 'Direct transition of instruction % to EXECUTED is prohibited. '
                                'State transitions must execute via identity.fn_execute_payment_instruction() '
                                'under fusion_workflow_definer (effective_role: %)', OLD.instruction_id, CURRENT_USER;
            END IF;
        END IF;

        -- Block direct transition to SETTLED from fusion_app_runtime, fusion_webauthn_verifier,
        -- or any non-workflow non-superuser role
        IF (NEW.state = 'SETTLED' OR NEW.status = 'SETTLED') THEN
            IF CURRENT_USER = 'fusion_app_runtime'
               OR CURRENT_USER = 'fusion_webauthn_verifier'
               OR (CURRENT_USER <> 'fusion_workflow_definer' AND NOT COALESCE(v_is_super, FALSE)) THEN
                RAISE EXCEPTION 'Direct transition of instruction % to SETTLED is prohibited. '
                                'State transitions must execute via identity.fn_settle_payment_instruction() '
                                'under fusion_workflow_definer (effective_role: %)', OLD.instruction_id, CURRENT_USER;
            END IF;
        END IF;

        -- Defense-in-depth: Block transition to EXECUTED or SETTLED without prior approval (all roles)
        IF (NEW.state IN ('EXECUTED', 'SETTLED') OR NEW.status IN ('EXECUTED', 'SETTLED')) THEN
            IF OLD.approval_status IS DISTINCT FROM 'APPROVED'
               AND OLD.state NOT IN ('APPROVED', 'PENDING_EXECUTION', 'LOCKED', 'PENDING_SETTLEMENT', 'EXECUTED') THEN
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

-- Drop previous trigger names and recreate as trg_00_instructions_state_guard so it runs before material_freeze
DROP TRIGGER IF EXISTS trg_instructions_state_guard ON public.instructions;
DROP TRIGGER IF EXISTS trg_00_instructions_state_guard ON public.instructions;
CREATE TRIGGER trg_00_instructions_state_guard
BEFORE INSERT OR UPDATE ON public.instructions
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_instructions_state_guard();

-- ==============================================================================
-- 8. OWNERSHIP AND PERMISSION GRANTS
-- ==============================================================================

-- Assign function ownership to fusion_workflow_definer
ALTER FUNCTION identity.fn_execute_payment_instruction(UUID, UUID, VARCHAR, VARCHAR, VARCHAR, JSONB) OWNER TO fusion_workflow_definer;
ALTER FUNCTION identity.fn_settle_payment_instruction(UUID, UUID, VARCHAR, JSONB) OWNER TO fusion_workflow_definer;

-- Revoke execute from public and verifier
REVOKE ALL ON FUNCTION identity.fn_execute_payment_instruction(UUID, UUID, VARCHAR, VARCHAR, VARCHAR, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.fn_execute_payment_instruction(UUID, UUID, VARCHAR, VARCHAR, VARCHAR, JSONB) FROM fusion_webauthn_verifier;

REVOKE ALL ON FUNCTION identity.fn_settle_payment_instruction(UUID, UUID, VARCHAR, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.fn_settle_payment_instruction(UUID, UUID, VARCHAR, JSONB) FROM fusion_webauthn_verifier;

-- Grant execute to application runtime
GRANT EXECUTE ON FUNCTION identity.fn_execute_payment_instruction(UUID, UUID, VARCHAR, VARCHAR, VARCHAR, JSONB) TO fusion_app_runtime;
GRANT EXECUTE ON FUNCTION identity.fn_settle_payment_instruction(UUID, UUID, VARCHAR, JSONB) TO fusion_app_runtime;

-- Assign table ownership to fusion_workflow_definer
ALTER TABLE identity.payment_dispatch_records OWNER TO fusion_workflow_definer;
ALTER TABLE identity.payment_settlement_evidence OWNER TO fusion_workflow_definer;

-- Full privileges to workflow definer
GRANT ALL ON identity.payment_dispatch_records TO fusion_workflow_definer;
GRANT ALL ON identity.payment_settlement_evidence TO fusion_workflow_definer;

-- Read-only access for app runtime
GRANT SELECT ON identity.payment_dispatch_records TO fusion_app_runtime;
GRANT SELECT ON identity.payment_settlement_evidence TO fusion_app_runtime;

-- Deny mutations from app runtime, verifier, and public
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON identity.payment_dispatch_records FROM fusion_app_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON identity.payment_dispatch_records FROM fusion_webauthn_verifier;
REVOKE ALL ON identity.payment_dispatch_records FROM PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON identity.payment_settlement_evidence FROM fusion_app_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON identity.payment_settlement_evidence FROM fusion_webauthn_verifier;
REVOKE ALL ON identity.payment_settlement_evidence FROM PUBLIC;
