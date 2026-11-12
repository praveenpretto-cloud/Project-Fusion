-- ==============================================================================
-- PROJECT FUSION — PHASE AI-2C.2: MULTI-TENANT ARCHITECTURE FOUNDATION
-- ==============================================================================
-- Migration: 026_tenant_registry_memberships_provider_configs.sql
-- Reference: fusion_ai2c_1_1_corrected_multi_tenant_architecture.md (v2.1.3)
--
-- Objectives:
--   1. Run strict bidirectional precondition validation:
--      - Fail closed if identity.tenants or identity.tenant_memberships contains rows.
--      - Assert exactly 5 operators exist in identity.operators.
--      - Assert every operator has is_active IS TRUE (reject NULL / FALSE).
--      - Assert no NULL is_active in identity.operator_role_assignments.
--      - Assert no operator has duplicate active role assignments.
--      - Compare expected 1:1 mappings bidirectionally against actual active assignments.
--   2. Transactionally transfer SYSTEM_ADMIN to identity.platform_operator_role_assignments:
--      - Insert platform assignment for SYSTEM_ADMIN.
--      - Verify exactly one valid active platform assignment.
--      - Remove active assignment from identity.operator_role_assignments.
--      - Preserve inactive historical records for all operators.
--      - Confirm SYSTEM_ADMIN has no tenant membership.
--   3. Create identity.tenants and seed canonical demo tenant (00000000-0000-0000-0000-000000000001).
--   4. Create identity.tenant_memberships and map the 4 financial operators to demo tenant.
--   5. Create identity.tenant_provider_configs with valid provider/environment combinations.
--   6. Create identity.tenant_ledger_heads for tenant-scoped ledger serialization.
--   7. Add nullable active_tenant_id to identity.operator_sessions.
--   8. Add nullable tenant_id context to identity.auth_audit_log.
--   9. Implement platform role allowlist trigger and role-catalog protection triggers.
--  10. Enforce least-privilege grants for fusion_app_runtime, fusion_workflow_definer, fusion_auditor.
--
-- Strict Operating Boundary:
--   - Single operational demo tenant only.
--   - No production/live credentials, mainnet rails, or live banking.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. PRECONDITIONS & INTEGRITY VALIDATION (FAIL-CLOSED)
-- ------------------------------------------------------------------------------
DO $$
DECLARE
    v_existing_tenants INTEGER;
    v_existing_memberships INTEGER;
    v_total_operators INTEGER;
    v_inactive_or_null_ops INTEGER;
    v_null_assignment_status_count INTEGER;
    v_duplicate_assignments INTEGER;
    v_discrepancy_count INTEGER;
    v_discrepancy_details TEXT;
    v_sysadmin_op_id UUID := '00000000-0000-4000-8000-000000000005';
    v_sysadmin_role_id UUID;
    v_verified_count INTEGER;
BEGIN
    -- Assert that identity.tenants contains zero records before seeding demo tenant
    IF to_regclass('identity.tenants') IS NOT NULL THEN
        SELECT COUNT(*) INTO v_existing_tenants FROM identity.tenants;
        IF v_existing_tenants > 0 THEN
            RAISE EXCEPTION 'MIGRATION 026 PRECONDITION FAILED: identity.tenants already contains % records. Clean initial state required.', v_existing_tenants;
        END IF;
    END IF;

    -- Assert that identity.tenant_memberships contains zero records before seeding memberships
    IF to_regclass('identity.tenant_memberships') IS NOT NULL THEN
        SELECT COUNT(*) INTO v_existing_memberships FROM identity.tenant_memberships;
        IF v_existing_memberships > 0 THEN
            RAISE EXCEPTION 'MIGRATION 026 PRECONDITION FAILED: identity.tenant_memberships already contains % records. Clean initial state required.', v_existing_memberships;
        END IF;
    END IF;

    -- Assert exactly 5 operators exist in identity.operators
    SELECT COUNT(*) INTO v_total_operators FROM identity.operators;
    IF v_total_operators <> 5 THEN
        RAISE EXCEPTION 'MIGRATION 026 PRECONDITION FAILED: Expected exactly 5 operators in identity.operators, found %', v_total_operators;
    END IF;

    -- Assert every expected operator has is_active IS TRUE (detect NULL or FALSE)
    SELECT COUNT(*) INTO v_inactive_or_null_ops
    FROM identity.operators
    WHERE operator_id NOT IN (
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003',
        '00000000-0000-4000-8000-000000000004',
        '00000000-0000-4000-8000-000000000005'
    ) OR (is_active IS NOT TRUE);

    IF v_inactive_or_null_ops > 0 THEN
        RAISE EXCEPTION 'MIGRATION 026 PRECONDITION FAILED: Found % operator(s) that are either unmapped, inactive, or have NULL status.', v_inactive_or_null_ops;
    END IF;

    -- Assert no role assignment has a NULL status in identity.operator_role_assignments
    SELECT COUNT(*) INTO v_null_assignment_status_count
    FROM identity.operator_role_assignments
    WHERE is_active IS NULL;

    IF v_null_assignment_status_count > 0 THEN
        RAISE EXCEPTION 'MIGRATION 026 PRECONDITION FAILED: % role assignment(s) have NULL is_active status.', v_null_assignment_status_count;
    END IF;

    -- Assert no operator has multiple active role assignments
    SELECT COUNT(*) INTO v_duplicate_assignments
    FROM (
        SELECT operator_id
        FROM identity.operator_role_assignments
        WHERE is_active IS TRUE
        GROUP BY operator_id
        HAVING COUNT(*) > 1
    ) dup;

    IF v_duplicate_assignments > 0 THEN
        RAISE EXCEPTION 'MIGRATION 026 PRECONDITION FAILED: % operator(s) have multiple active role assignments.', v_duplicate_assignments;
    END IF;

    -- Bidirectional comparison against expected role mappings
    WITH expected_assignments(exp_op_id, exp_role_key) AS (
        VALUES
            ('00000000-0000-4000-8000-000000000001'::uuid, 'TREASURY_ANALYST'),
            ('00000000-0000-4000-8000-000000000002'::uuid, 'OPS_OPERATOR'),
            ('00000000-0000-4000-8000-000000000003'::uuid, 'AUDITOR'),
            ('00000000-0000-4000-8000-000000000004'::uuid, 'COMPLIANCE_OFFICER'),
            ('00000000-0000-4000-8000-000000000005'::uuid, 'SYSTEM_ADMIN')
    ),
    actual_active_assignments AS (
        SELECT ora.operator_id AS act_op_id, r.role_key AS act_role_key
        FROM identity.operator_role_assignments ora
        JOIN identity.roles r ON ora.role_id = r.role_id
        WHERE ora.is_active IS TRUE
    ),
    bidirectional_diff AS (
        SELECT exp_op_id AS operator_id, exp_role_key AS expected_role, act_role_key AS actual_role, 'MISSING_OR_MISMATCHED' AS diff_type
        FROM expected_assignments e
        LEFT JOIN actual_active_assignments a ON e.exp_op_id = a.act_op_id AND e.exp_role_key = a.act_role_key
        WHERE a.act_op_id IS NULL
        UNION ALL
        SELECT act_op_id AS operator_id, exp_role_key AS expected_role, act_role_key AS actual_role, 'UNEXPECTED_OR_EXTRA' AS diff_type
        FROM actual_active_assignments a
        LEFT JOIN expected_assignments e ON a.act_op_id = e.exp_op_id AND a.act_role_key = e.exp_role_key
        WHERE e.exp_op_id IS NULL
    )
    SELECT COUNT(*), string_agg(operator_id::text || ' (type: ' || diff_type || ', exp: ' || COALESCE(expected_role, 'NONE') || ', act: ' || COALESCE(actual_role, 'NONE') || ')', '; ')
    INTO v_discrepancy_count, v_discrepancy_details
    FROM bidirectional_diff;

    IF v_discrepancy_count > 0 THEN
        RAISE EXCEPTION 'MIGRATION 026 PRECONDITION FAILED: Bidirectional role assignment discrepancies detected (%): %', v_discrepancy_count, v_discrepancy_details;
    END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 2. PLATFORM OPERATOR ROLE ASSIGNMENTS & SYSTEM_ADMIN MIGRATION
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity.platform_operator_role_assignments (
    assignment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id UUID NOT NULL REFERENCES identity.operators(operator_id) ON DELETE RESTRICT,
    role_id UUID NOT NULL REFERENCES identity.roles(role_id) ON DELETE RESTRICT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assigned_by UUID REFERENCES identity.operators(operator_id) ON DELETE SET NULL,
    revoked_at TIMESTAMPTZ,
    revoked_by UUID REFERENCES identity.operators(operator_id) ON DELETE SET NULL,
    CONSTRAINT uq_platform_operator_role UNIQUE (operator_id, role_id)
);

CREATE TABLE IF NOT EXISTS identity.platform_operator_role_history (
    history_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_assignment_id UUID,
    operator_id UUID NOT NULL REFERENCES identity.operators(operator_id) ON DELETE RESTRICT,
    role_id UUID NOT NULL REFERENCES identity.roles(role_id) ON DELETE RESTRICT,
    is_active BOOLEAN NOT NULL,
    assigned_at TIMESTAMPTZ,
    assigned_by UUID REFERENCES identity.operators(operator_id) ON DELETE SET NULL,
    revoked_at TIMESTAMPTZ,
    revoked_by UUID REFERENCES identity.operators(operator_id) ON DELETE SET NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archive_reason VARCHAR(128) NOT NULL DEFAULT 'MIGRATION_026_PLATFORM_TRANSFER'
);

-- Platform role allowlist trigger enforcing only SYSTEM_ADMIN
CREATE OR REPLACE FUNCTION identity.trg_enforce_platform_role_allowlist()
RETURNS TRIGGER AS $$
DECLARE
    v_role_key VARCHAR;
BEGIN
    SELECT role_key INTO v_role_key FROM identity.roles WHERE role_id = NEW.role_id;
    IF v_role_key IS DISTINCT FROM 'SYSTEM_ADMIN' THEN
        RAISE EXCEPTION 'Role % is not a permitted global platform role (only SYSTEM_ADMIN allowed in platform_operator_role_assignments)', COALESCE(v_role_key, 'NULL');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_check_platform_role_allowlist ON identity.platform_operator_role_assignments;
CREATE TRIGGER trg_check_platform_role_allowlist
BEFORE INSERT OR UPDATE ON identity.platform_operator_role_assignments
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_platform_role_allowlist();

-- Role catalog protection trigger:
-- Returns OLD for permitted DELETE operations; blocks deletion of SYSTEM_ADMIN.
-- Returns NEW for permitted UPDATE operations; blocks renaming or changing SYSTEM_ADMIN role_key.
CREATE OR REPLACE FUNCTION identity.trg_protect_system_roles()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.role_key = 'SYSTEM_ADMIN' THEN
            RAISE EXCEPTION 'Cannot delete protected platform role SYSTEM_ADMIN';
        END IF;
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD.role_key = 'SYSTEM_ADMIN' OR NEW.role_key = 'SYSTEM_ADMIN' THEN
            IF NEW.role_key IS DISTINCT FROM OLD.role_key THEN
                RAISE EXCEPTION 'Cannot modify or rename protected platform role key %', OLD.role_key;
            END IF;
        END IF;
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_system_roles_immutability ON identity.roles;
CREATE TRIGGER trg_protect_system_roles_immutability
BEFORE UPDATE OR DELETE ON identity.roles
FOR EACH ROW EXECUTE FUNCTION identity.trg_protect_system_roles();

-- Transactional transfer of SYSTEM_ADMIN role assignment
DO $$
DECLARE
    v_sysadmin_op_id UUID := '00000000-0000-4000-8000-000000000005';
    v_sysadmin_role_id UUID;
    v_verified_count INTEGER;
BEGIN
    SELECT role_id INTO v_sysadmin_role_id
    FROM identity.roles
    WHERE role_key = 'SYSTEM_ADMIN';

    IF v_sysadmin_role_id IS NULL THEN
        RAISE EXCEPTION 'MIGRATION 026 PRECONDITION FAILED: SYSTEM_ADMIN role not found in identity.roles.';
    END IF;

    -- 1. Archive any pre-existing inactive historical records for SYSTEM_ADMIN to platform history
    INSERT INTO identity.platform_operator_role_history (
        original_assignment_id, operator_id, role_id, is_active, assigned_at, assigned_by, revoked_at, revoked_by, archive_reason
    )
    SELECT assignment_id, operator_id, role_id, is_active, assigned_at, assigned_by, revoked_at, revoked_by, 'MIGRATION_026_HISTORICAL_INACTIVE_PRESERVATION'
    FROM identity.operator_role_assignments
    WHERE operator_id = v_sysadmin_op_id
      AND is_active IS NOT TRUE;

    DELETE FROM identity.operator_role_assignments
    WHERE operator_id = v_sysadmin_op_id
      AND is_active IS NOT TRUE;

    -- 2. Transactionally create the global platform assignment for SYSTEM_ADMIN
    -- (Do not use unconditional ON CONFLICT DO UPDATE SET is_active = TRUE)
    INSERT INTO identity.platform_operator_role_assignments (
        operator_id, role_id, is_active, assigned_at, assigned_by
    )
    SELECT ora.operator_id, ora.role_id, TRUE, ora.assigned_at, ora.assigned_by
    FROM identity.operator_role_assignments ora
    WHERE ora.operator_id = v_sysadmin_op_id
      AND ora.role_id = v_sysadmin_role_id
      AND ora.is_active IS TRUE;

    -- 3. Verify exactly one valid active assignment exists
    SELECT COUNT(*) INTO v_verified_count
    FROM identity.platform_operator_role_assignments
    WHERE operator_id = v_sysadmin_op_id
      AND role_id = v_sysadmin_role_id
      AND is_active IS TRUE;

    IF v_verified_count <> 1 THEN
        RAISE EXCEPTION 'MIGRATION 026 ROLLBACK: Verification failed: exactly 1 active platform assignment expected for SYSTEM_ADMIN, found %', v_verified_count;
    END IF;

    -- 4. Remove original active role assignment from identity.operator_role_assignments
    DELETE FROM identity.operator_role_assignments
    WHERE operator_id = v_sysadmin_op_id
      AND role_id = v_sysadmin_role_id
      AND is_active IS TRUE;
END $$;

-- ------------------------------------------------------------------------------
-- 3. TENANT REGISTRY & DEMO TENANT INITIALIZATION
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity.tenants (
    tenant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'OFFBOARDED')),
    legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
    retention_policy VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenants_status ON identity.tenants(status);
CREATE INDEX IF NOT EXISTS idx_tenants_slug ON identity.tenants(slug);

-- Seed canonical demo tenant
INSERT INTO identity.tenants (
    tenant_id, slug, name, status, legal_hold, retention_policy
) VALUES (
    '00000000-0000-0000-0000-000000000001',
    'fusion-default-fintech',
    'Fusion Default Fintech',
    'ACTIVE',
    FALSE,
    'DEMO_EPHEMERAL'
);

-- ------------------------------------------------------------------------------
-- 4. TENANT MEMBERSHIPS
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity.tenant_memberships (
    membership_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES identity.tenants(tenant_id) ON DELETE RESTRICT,
    operator_id UUID NOT NULL REFERENCES identity.operators(operator_id) ON DELETE RESTRICT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    CONSTRAINT uq_tenant_operator UNIQUE (tenant_id, operator_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant ON identity.tenant_memberships(tenant_id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_tenant_memberships_operator ON identity.tenant_memberships(operator_id) WHERE is_active = TRUE;

-- Map the 4 approved financial operators to demo tenant
INSERT INTO identity.tenant_memberships (tenant_id, operator_id, is_active)
VALUES
    ('00000000-0000-0000-0000-000000000001', '00000000-0000-4000-8000-000000000001', TRUE), -- Treasury Analyst
    ('00000000-0000-0000-0000-000000000001', '00000000-0000-4000-8000-000000000002', TRUE), -- Ops Operator
    ('00000000-0000-0000-0000-000000000001', '00000000-0000-4000-8000-000000000003', TRUE), -- Auditor
    ('00000000-0000-0000-0000-000000000001', '00000000-0000-4000-8000-000000000004', TRUE); -- Compliance Officer

-- Confirm SYSTEM_ADMIN has zero tenant membership records
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM identity.tenant_memberships
        WHERE operator_id = '00000000-0000-4000-8000-000000000005'
    ) THEN
        RAISE EXCEPTION 'MIGRATION 026 INVARIANT VIOLATION: SYSTEM_ADMIN has tenant membership records.';
    END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 5. TENANT PROVIDER CONFIGS
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity.tenant_provider_configs (
    config_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES identity.tenants(tenant_id) ON DELETE RESTRICT,
    provider VARCHAR(64) NOT NULL,
    config_alias VARCHAR(64) NOT NULL,
    environment VARCHAR(32) NOT NULL,
    account_reference VARCHAR(255) NOT NULL,
    vault_secret_path VARCHAR(255) NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_tenant_provider_config UNIQUE (tenant_id, config_id),
    CONSTRAINT uq_tenant_provider_alias UNIQUE (tenant_id, config_alias),
    CONSTRAINT chk_tenant_provider_env_valid_combination
    CHECK (
        (provider = 'STRIPE_TEST' AND environment IN ('sandbox', 'test')) OR
        (provider = 'RAZORPAYX_TEST' AND environment IN ('sandbox', 'test')) OR
        (provider = 'STELLAR_TESTNET' AND environment IN ('testnet', 'test')) OR
        (provider IN ('SIMULATED_BTC', 'SIMULATED_ETH', 'SIMULATED_ALIPAY', 'SIMULATED_BANK_RAIL') 
            AND environment IN ('local', 'development', 'sandbox', 'test'))
    )
);

CREATE INDEX IF NOT EXISTS idx_tenant_provider_configs_lookup
ON identity.tenant_provider_configs (provider, account_reference, environment)
WHERE is_enabled = TRUE;

-- ------------------------------------------------------------------------------
-- 6. TENANT LEDGER HEADS
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity.tenant_ledger_heads (
    tenant_id UUID PRIMARY KEY REFERENCES identity.tenants(tenant_id) ON DELETE RESTRICT,
    head_sequence_id BIGINT NOT NULL,
    head_hash VARCHAR(64) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------------------------
-- 7. SESSION & AUDIT TENANT CONTEXT
-- ------------------------------------------------------------------------------
ALTER TABLE identity.operator_sessions
    ADD COLUMN IF NOT EXISTS active_tenant_id UUID REFERENCES identity.tenants(tenant_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_operator_sessions_tenant
ON identity.operator_sessions(active_tenant_id);

ALTER TABLE identity.auth_audit_log
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_auth_audit_tenant
ON identity.auth_audit_log(tenant_id);

-- ------------------------------------------------------------------------------
-- 8. SECURITY & LEAST PRIVILEGE PERMISSIONS
-- ------------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_app_runtime') THEN
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON identity.roles FROM fusion_app_runtime;
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON identity.permissions FROM fusion_app_runtime;
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON identity.role_permissions FROM fusion_app_runtime;
        GRANT SELECT ON identity.roles TO fusion_app_runtime;
        GRANT SELECT ON identity.permissions TO fusion_app_runtime;
        GRANT SELECT ON identity.role_permissions TO fusion_app_runtime;

        GRANT SELECT, INSERT, UPDATE ON identity.tenants TO fusion_app_runtime;
        GRANT SELECT, INSERT, UPDATE ON identity.tenant_memberships TO fusion_app_runtime;
        GRANT SELECT, INSERT, UPDATE, DELETE ON identity.tenant_provider_configs TO fusion_app_runtime;
        GRANT SELECT, INSERT, UPDATE ON identity.tenant_ledger_heads TO fusion_app_runtime;
        GRANT SELECT ON identity.platform_operator_role_assignments TO fusion_app_runtime;
        GRANT SELECT ON identity.platform_operator_role_history TO fusion_app_runtime;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_workflow_definer') THEN
        GRANT SELECT ON identity.tenants TO fusion_workflow_definer;
        GRANT SELECT ON identity.tenant_memberships TO fusion_workflow_definer;
        GRANT SELECT ON identity.tenant_provider_configs TO fusion_workflow_definer;
        GRANT SELECT, UPDATE ON identity.tenant_ledger_heads TO fusion_workflow_definer;
        GRANT SELECT ON identity.platform_operator_role_assignments TO fusion_workflow_definer;
        GRANT SELECT ON identity.platform_operator_role_history TO fusion_workflow_definer;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_auditor') THEN
        GRANT SELECT ON identity.tenants TO fusion_auditor;
        GRANT SELECT ON identity.tenant_memberships TO fusion_auditor;
        GRANT SELECT ON identity.tenant_provider_configs TO fusion_auditor;
        GRANT SELECT ON identity.platform_operator_role_assignments TO fusion_auditor;
        GRANT SELECT ON identity.platform_operator_role_history TO fusion_auditor;
    END IF;
END $$;
