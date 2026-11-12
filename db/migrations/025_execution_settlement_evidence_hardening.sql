-- ==============================================================================
-- Migration 025: Payment Execution and Settlement Evidence Hardening
-- ==============================================================================
-- Phase: AI-2B Final Execution Function Authorization Verification
--
-- Objective:
--   1. Operator Authorization Check: Ensure p_operator_id is an active operator
--      holding payment governance authority (payment:initiate, payment:approve,
--      or treasury:manage). Reject invented, inactive, or unauthorized operators
--      (e.g., auditors).
--   2. Provider Result Non-Fabrication: Validate that provider_result is not
--      empty or failed (status <> 'FAILED', 'UNKNOWN', 'ERROR', 'REJECTED')
--      and contains genuine provider references (intent_id, tx_hash, utr, or transfer_id).
--   3. Simulated vs Genuine Separation: Require explicit simulation flags when
--      executing against simulated providers (SIMULATED_BTC, SIMULATED_ETH, etc.).
--   4. Settlement Evidence Non-Fabrication: Validate that evidence_payload contains
--      verifiable confirmation indicators and is not marked failed.
--   5. Maintain SECURITY DEFINER ownership under fusion_workflow_definer and
--      preserve least-privilege grants to fusion_app_runtime.
-- ==============================================================================

-- ==============================================================================
-- 1. GRANTS TO FUSION_WORKFLOW_DEFINER FOR RBAC VALIDATION
-- ==============================================================================

GRANT SELECT ON identity.operators TO fusion_workflow_definer;
GRANT SELECT ON identity.roles TO fusion_workflow_definer;
GRANT SELECT ON identity.operator_role_assignments TO fusion_workflow_definer;
GRANT SELECT ON identity.permissions TO fusion_workflow_definer;
GRANT SELECT ON identity.role_permissions TO fusion_workflow_definer;

-- ==============================================================================
-- 2. HARDENED EXECUTION WORKFLOW FUNCTION
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
    v_status TEXT;
    v_ref TEXT;
BEGIN
    -- 1. Input parameter validation
    IF p_instruction_id IS NULL THEN
        RAISE EXCEPTION 'p_instruction_id is required';
    END IF;
    IF p_operator_id IS NULL THEN
        RAISE EXCEPTION 'p_operator_id is required for payment execution dispatch';
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
    IF p_provider_result IS NULL OR p_provider_result = '{}'::jsonb THEN
        RAISE EXCEPTION 'Synthetic provider execution result payload is required';
    END IF;

    -- 2. Lock instruction FOR UPDATE & Terminal State / Lifecycle Validation
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

    -- 3. Operator Authorization Validation
    -- Operator must be active and possess payment:initiate, payment:approve, or treasury:manage permission
    IF NOT EXISTS (
        SELECT 1 FROM identity.operators o
        JOIN identity.operator_role_assignments ora ON o.operator_id = ora.operator_id
        JOIN identity.roles r ON ora.role_id = r.role_id
        JOIN identity.role_permissions rp ON r.role_id = rp.role_id
        JOIN identity.permissions p ON rp.permission_id = p.permission_id
        WHERE o.operator_id = p_operator_id
          AND o.is_active = TRUE
          AND p.permission_key IN ('payment:initiate', 'payment:approve', 'treasury:manage')
    ) THEN
        RAISE EXCEPTION 'Operator % is not authorized for payment execution dispatch (must be an active operator with payment governance authority)', p_operator_id;
    END IF;

    -- 4. Provider Result Validation & Anti-Forgery Gating
    -- Failed dispatches cannot be recorded as successful execution
    v_status := p_provider_result->>'status';
    IF v_status IS NULL OR v_status IN ('FAILED', 'UNKNOWN', 'ERROR', 'REJECTED') THEN
        RAISE EXCEPTION 'Provider execution result indicates failure or unverified status: % (failed dispatches cannot be recorded as executed)',
                        COALESCE(v_status, 'NULL');
    END IF;

    -- Extract provider reference
    v_ref := COALESCE(
        p_provider_result->>'intent_id',
        p_provider_result->>'tx_hash',
        p_provider_result->>'utr',
        p_provider_result->>'transfer_id'
    );
    IF v_ref IS NULL OR length(trim(v_ref)) = 0 THEN
        RAISE EXCEPTION 'Provider execution result missing mandatory provider reference (intent_id, tx_hash, utr, or transfer_id required)';
    END IF;

    -- Instruction binding check
    IF p_provider_result ? 'instruction_id' AND (p_provider_result->>'instruction_id')::uuid <> p_instruction_id THEN
        RAISE EXCEPTION 'Provider result instruction_id % does not match target instruction %',
                        p_provider_result->>'instruction_id', p_instruction_id;
    END IF;

    -- Distinguish simulated vs real provider responses
    IF p_provider LIKE 'SIMULATED_%' THEN
        IF NOT (
            (p_provider_result ? 'simulated' AND (p_provider_result->>'simulated')::boolean = true)
            OR v_status = 'SIMULATED'
            OR v_ref LIKE 'sim_%'
        ) THEN
            RAISE EXCEPTION 'Simulated provider % requires explicit simulation markers in provider result', p_provider;
        END IF;
    END IF;

    -- 5. Record authorized dispatch
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

    -- 6. Transition instruction state to EXECUTED
    UPDATE public.instructions
    SET state = 'EXECUTED',
        provider = p_provider,
        environment = p_environment,
        updated_at = NOW()
    WHERE instruction_id = p_instruction_id;

    -- 7. Audit log
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
            'idempotency_key', p_idempotency_key,
            'provider_ref', v_ref
        )
    );

    RETURN jsonb_build_object(
        'dispatch_id', v_dispatch_id,
        'instruction_id', p_instruction_id,
        'status', 'EXECUTED',
        'provider', p_provider,
        'environment', p_environment,
        'idempotency_key', p_idempotency_key,
        'provider_ref', v_ref
    );
END;
$$;

-- ==============================================================================
-- 2. HARDENED SETTLEMENT WORKFLOW FUNCTION
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
    IF p_evidence_payload IS NULL OR p_evidence_payload = '{}'::jsonb THEN
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
        IF NOT (v_dispatch.provider_result ? 'utr' AND v_dispatch.provider_result->>'utr' = p_provider_tx_reference)
           AND NOT (v_dispatch.provider_result ? 'tx_hash' AND v_dispatch.provider_result->>'tx_hash' = p_provider_tx_reference) THEN
            RAISE EXCEPTION 'Provider transaction reference % does not match dispatch record provider reference (settlement substitution blocked)',
                            p_provider_tx_reference;
        END IF;
    END IF;

    -- 4. Validate settlement evidence content (cannot be empty or failed)
    IF p_evidence_payload ? 'status' AND p_evidence_payload->>'status' IN ('FAILED', 'ERROR', 'REJECTED') THEN
        RAISE EXCEPTION 'Settlement evidence indicates failed or rejected status: %', p_evidence_payload->>'status';
    END IF;

    IF NOT (
        (p_evidence_payload ? 'confirmed' AND (p_evidence_payload->>'confirmed')::boolean = true)
        OR (p_evidence_payload ? 'settlement_confirmed' AND (p_evidence_payload->>'settlement_confirmed')::boolean = true)
        OR (p_evidence_payload ? 'status' AND p_evidence_payload->>'status' IN ('SETTLED', 'SUCCESS', 'CONFIRMED'))
        OR p_evidence_payload ? 'rail'
        OR p_evidence_payload ? 'receipt_url'
        OR p_evidence_payload ? 'webhook_event_id'
    ) THEN
        RAISE EXCEPTION 'Settlement evidence payload lacks verifiable confirmation indicators (settlement rejected)';
    END IF;

    -- 5. Record settlement evidence
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
-- 3. SECURITY DEFINER OWNERSHIP & LEAST PRIVILEGE
-- ==============================================================================

ALTER FUNCTION identity.fn_execute_payment_instruction(UUID, UUID, VARCHAR, VARCHAR, VARCHAR, JSONB) OWNER TO fusion_workflow_definer;
ALTER FUNCTION identity.fn_settle_payment_instruction(UUID, UUID, VARCHAR, JSONB) OWNER TO fusion_workflow_definer;

REVOKE ALL ON FUNCTION identity.fn_execute_payment_instruction(UUID, UUID, VARCHAR, VARCHAR, VARCHAR, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.fn_execute_payment_instruction(UUID, UUID, VARCHAR, VARCHAR, VARCHAR, JSONB) FROM fusion_webauthn_verifier;

REVOKE ALL ON FUNCTION identity.fn_settle_payment_instruction(UUID, UUID, VARCHAR, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.fn_settle_payment_instruction(UUID, UUID, VARCHAR, JSONB) FROM fusion_webauthn_verifier;

GRANT EXECUTE ON FUNCTION identity.fn_execute_payment_instruction(UUID, UUID, VARCHAR, VARCHAR, VARCHAR, JSONB) TO fusion_app_runtime;
GRANT EXECUTE ON FUNCTION identity.fn_settle_payment_instruction(UUID, UUID, VARCHAR, JSONB) TO fusion_app_runtime;
