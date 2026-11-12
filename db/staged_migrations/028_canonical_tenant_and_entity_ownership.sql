-- ==============================================================================
-- Migration 028: Canonical Tenant and Entity Ownership, Quarantine, and RLS
-- Phase: Step 4C.2 Repaired Authoring (ADR-001 Baseline Implementation)
--
-- STRICT OPERATIONAL BOUNDARIES & MANDATORY DESIGN CONSTRAINTS:
--   1. Historical ledger sequences 1-78, SHA-256 hashes, timestamps, and prev_hash
--      values are strictly immutable and PRESERVED WITHOUT MUTATION.
--   2. No silent balancing, tax withholding, or fee adjustment entries are posted.
--   3. Debtor entity mapping (debtor_entity_id) is deferred to Migration 029.
--   4. RLS is enforced via a dual-layer permissive base + restrictive tenant isolation
--      model with both USING and WITH CHECK semantics across all 24 altered tables.
--   5. Platform treasury accounts (is_treasury = TRUE) are strictly invisible to tenant
--      runtime queries under fusion_app_runtime.
--   6. Direct table SELECT on public.ledger_journal is revoked from fusion_app_runtime;
--      SELECT is granted to fusion_workflow_definer; all tenant ledger reads execute via
--      identity.fn_get_tenant_ledger() and the identity.tenant_ledger_view facade.
--   7. Tenant 99 (00000000-0000-0000-0000-000000000099) is locked as an inactive
--      quarantine fixture (is_active = FALSE, tenant_type = 'QUARANTINE_FIXTURE').
--   8. Record-level quarantine (identity.quarantined_records) isolates unverified
--      records with auditable state machine transitions.
--   9. Post-027 catalog baseline assumes 54 relations across public and identity.
--  10. GUC spoofing notice: SET LOCAL app.current_tenant_id provides defense-in-depth
--      within trusted application boundaries; arbitrary SQL execution under a shared
--      runtime role requires independent server-side middleware validation.
-- ==============================================================================

-- ==============================================================================
-- PHASE 1: PRECONDITION CHECKS & PREREQUISITE ASSERTIONS (FAIL-CLOSED)
-- ==============================================================================
DO $$
DECLARE
    v_m026_applied BOOLEAN;
    v_m027_applied BOOLEAN;
    v_tenants_exist BOOLEAN;
    v_demo_tenant_exists BOOLEAN;
BEGIN
    -- Assert schema_migrations table exists
    IF to_regclass('public.schema_migrations') IS NULL THEN
        RAISE EXCEPTION 'PRECONDITION FAILED: public.schema_migrations does not exist.';
    END IF;

    -- Assert Migration 026 is applied
    SELECT EXISTS (
        SELECT 1 FROM public.schema_migrations 
        WHERE migration_name LIKE '026_%' AND status = 'APPLIED'
    ) INTO v_m026_applied;
    
    IF NOT v_m026_applied THEN
        RAISE EXCEPTION 'PRECONDITION FAILED: Migration 026 must be applied prior to Migration 028.';
    END IF;

    -- Assert Migration 027 is applied
    SELECT EXISTS (
        SELECT 1 FROM public.schema_migrations 
        WHERE migration_name LIKE '027_%' AND status = 'APPLIED'
    ) INTO v_m027_applied;
    
    IF NOT v_m027_applied THEN
        RAISE EXCEPTION 'PRECONDITION FAILED: Migration 027 must be applied prior to Migration 028.';
    END IF;

    -- Assert identity.tenants exists
    IF to_regclass('identity.tenants') IS NULL THEN
        RAISE EXCEPTION 'PRECONDITION FAILED: identity.tenants table does not exist.';
    END IF;

    -- Assert canonical demo tenant exists from Migration 026
    SELECT EXISTS (
        SELECT 1 FROM identity.tenants 
        WHERE tenant_id = '00000000-0000-0000-0000-000000000001'
    ) INTO v_demo_tenant_exists;

    IF NOT v_demo_tenant_exists THEN
        RAISE EXCEPTION 'PRECONDITION FAILED: Canonical Tenant 1 (00000000-0000-0000-0000-000000000001) not found.';
    END IF;

    RAISE NOTICE '[MIGRATION 028] Phase 1 Precondition assertions PASSED.';
END $$;

-- ==============================================================================
-- PHASE 2: CANONICAL TENANT REGISTRY SEEDING & ROLES VERIFICATION
-- ==============================================================================

-- 2.1 Verify fusion_workflow_definer role exists (NOLOGIN, NOSUPERUSER, NOBYPASSRLS)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_workflow_definer') THEN
        CREATE ROLE fusion_workflow_definer NOLOGIN NOSUPERUSER NOBYPASSRLS;
    ELSE
        ALTER ROLE fusion_workflow_definer NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fusion_app_runtime') THEN
        CREATE ROLE fusion_app_runtime WITH LOGIN NOSUPERUSER NOBYPASSRLS;
    ELSE
        ALTER ROLE fusion_app_runtime NOSUPERUSER NOBYPASSRLS;
    END IF;
END $$;

-- 2.2 Seed Canonical Tenants 2, 3, and 99 into identity.tenants
ALTER TABLE identity.tenants ADD COLUMN IF NOT EXISTS tenant_type VARCHAR(64) DEFAULT 'COMMERCIAL';
ALTER TABLE identity.tenants ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

INSERT INTO identity.tenants (tenant_id, name, slug, status, legal_hold, retention_policy, tenant_type, is_active, created_at, updated_at)
VALUES
    -- Tenant 2: Commercial Customer (TechVista Solutions LLP)
    ('00000000-0000-0000-0000-000000000002', 'TechVista Solutions LLP', 'techvista', 'ACTIVE', FALSE, 'FINANCIAL_STANDARD', 'COMMERCIAL', TRUE, NOW(), NOW()),
    -- Tenant 3: Prototype Demo / Alice Technologies Environment
    ('00000000-0000-0000-0000-000000000003', 'Alice Technologies Demo Corp', 'alice-corp', 'ACTIVE', FALSE, 'DEMO_EPHEMERAL', 'DEMO', TRUE, NOW(), NOW()),
    -- Tenant 99: Development & Test Harness Quarantine Boundary (STRICTLY INACTIVE)
    ('00000000-0000-0000-0000-000000000099', 'Test Harness Quarantine Boundary', 'test-quarantine', 'SUSPENDED', FALSE, 'QUARANTINE_ISOLATED', 'QUARANTINE_FIXTURE', FALSE, NOW(), NOW())
ON CONFLICT (tenant_id) DO UPDATE
SET name = EXCLUDED.name,
    slug = EXCLUDED.slug,
    status = EXCLUDED.status,
    tenant_type = EXCLUDED.tenant_type,
    is_active = EXCLUDED.is_active,
    updated_at = NOW();

-- ==============================================================================
-- PHASE 3: RECORD-LEVEL QUARANTINE INFRASTRUCTURE
-- ==============================================================================

CREATE TABLE IF NOT EXISTS identity.quarantined_records (
    quarantine_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_schema             VARCHAR(64) NOT NULL DEFAULT 'public',
    source_table              VARCHAR(64) NOT NULL,
    source_record_id          VARCHAR(128) NOT NULL,
    source_identifier         VARCHAR(128),
    assigned_tenant_id        UUID REFERENCES identity.tenants(tenant_id),
    quarantine_class          VARCHAR(64) NOT NULL CHECK (
        quarantine_class IN (
            'UNRESOLVED_COUNTERPARTY',
            'STALE_SAGA_ATTEMPT',
            'TEST_HARNESS_FIXTURE',
            'SYNTHETIC_VERIFICATION',
            'ORPHAN_LEDGER_TRANSACTION'
        )
    ),
    quarantine_reason         TEXT NOT NULL,
    status                    VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK (
        status IN ('ACTIVE', 'UNDER_REVIEW', 'RESOLVED_RELEASED', 'PERMANENTLY_SUPPRESSED')
    ),
    is_blocked_from_execution BOOLEAN NOT NULL DEFAULT TRUE,
    is_blocked_from_reporting BOOLEAN NOT NULL DEFAULT TRUE,
    is_blocked_from_api       BOOLEAN NOT NULL DEFAULT TRUE,
    quarantined_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    requested_by              UUID REFERENCES identity.operators(operator_id),
    requested_at              TIMESTAMPTZ,
    request_notes             TEXT,
    reviewed_by               UUID REFERENCES identity.operators(operator_id),
    reviewed_at               TIMESTAMPTZ,
    resolution_notes          TEXT,
    CONSTRAINT uq_quarantine_source_record UNIQUE (source_schema, source_table, source_record_id),
    CONSTRAINT chk_quarantine_maker_checker_distinct CHECK (
        requested_by IS NULL OR reviewed_by IS NULL OR requested_by <> reviewed_by
    ),
    CONSTRAINT chk_quarantine_resolved_audit CHECK (
        (status <> 'RESOLVED_RELEASED') OR 
        (requested_by IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND resolution_notes IS NOT NULL)
    )
);

ALTER TABLE identity.quarantined_records
    ADD COLUMN IF NOT EXISTS requested_by UUID REFERENCES identity.operators(operator_id),
    ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS request_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_quarantined_lookup 
ON identity.quarantined_records(source_table, source_record_id) 
WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_quarantined_tenant 
ON identity.quarantined_records(assigned_tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_quarantined_status_lookup 
ON identity.quarantined_records(source_table, source_record_id, status);

-- Secure lookup function callable by runtime role (SECURITY DEFINER with pg_temp last)
-- Returns TRUE if a record is quarantined and blocked from execution, reporting, or API
CREATE OR REPLACE FUNCTION identity.fn_is_record_quarantined(
    p_source_table VARCHAR, 
    p_record_id VARCHAR
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, identity, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM identity.quarantined_records
        WHERE source_table = p_source_table
          AND source_record_id = p_record_id
          AND status IN ('ACTIVE', 'UNDER_REVIEW', 'PERMANENTLY_SUPPRESSED')
          AND (is_blocked_from_reporting IS TRUE OR is_blocked_from_api IS TRUE OR is_blocked_from_execution IS TRUE)
    );
$$;

ALTER FUNCTION identity.fn_is_record_quarantined(VARCHAR, VARCHAR) OWNER TO fusion_workflow_definer;
REVOKE ALL ON FUNCTION identity.fn_is_record_quarantined(VARCHAR, VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.fn_is_record_quarantined(VARCHAR, VARCHAR) TO fusion_app_runtime;

-- ------------------------------------------------------------------------------
-- QUARANTINE RELEASE GOVERNANCE: MAKER-CHECKER PROCEDURES (TASK 2)
-- ------------------------------------------------------------------------------

-- Procedure 1: Request Quarantine Release (Maker Action)
CREATE OR REPLACE FUNCTION identity.fn_request_quarantine_release(
    p_quarantine_id UUID,
    p_requester_operator_id UUID,
    p_request_notes TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, identity, public, pg_temp
AS $$
DECLARE
    v_rec RECORD;
    v_role VARCHAR(64);
BEGIN
    IF p_request_notes IS NULL OR TRIM(p_request_notes) = '' THEN
        RAISE EXCEPTION 'Request notes are mandatory for quarantine release request';
    END IF;

    -- 1. Validate requester operator is active and holds valid operational role
    SELECT r.role_key INTO v_role
    FROM identity.operators o
    LEFT JOIN identity.operator_role_assignments ora ON o.operator_id = ora.operator_id AND ora.is_active IS TRUE
    LEFT JOIN identity.platform_operator_role_assignments pora ON o.operator_id = pora.operator_id AND pora.is_active IS TRUE
    JOIN identity.roles r ON r.role_id = COALESCE(ora.role_id, pora.role_id)
    WHERE o.operator_id = p_requester_operator_id AND o.is_active IS TRUE;

    IF v_role IS NULL THEN
        RAISE EXCEPTION 'UNAUTHORIZED: Operator % is not active or has no active role', p_requester_operator_id;
    END IF;

    IF v_role NOT IN ('OPS_OPERATOR', 'COMPLIANCE_OFFICER', 'SYSTEM_ADMIN') THEN
        RAISE EXCEPTION 'FORBIDDEN: Role % cannot request quarantine release', v_role;
    END IF;

    -- 2. Lock and validate quarantine record
    SELECT * INTO v_rec FROM identity.quarantined_records
    WHERE quarantine_id = p_quarantine_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Quarantine record % not found', p_quarantine_id;
    END IF;

    IF v_rec.status NOT IN ('ACTIVE', 'UNDER_REVIEW') THEN
        RAISE EXCEPTION 'Quarantine record % cannot be requested for release in status %', p_quarantine_id, v_rec.status;
    END IF;

    -- 3. Update record to UNDER_REVIEW with maker audit
    UPDATE identity.quarantined_records
    SET status = 'UNDER_REVIEW',
        requested_by = p_requester_operator_id,
        requested_at = NOW(),
        request_notes = p_request_notes
    WHERE quarantine_id = p_quarantine_id;

    -- 4. Record audit log
    INSERT INTO identity.auth_audit_log (
        operator_id, event_type, metadata, created_at
    ) VALUES (
        p_requester_operator_id,
        'QUARANTINE_RELEASE_REQUESTED',
        jsonb_build_object(
            'quarantine_id', p_quarantine_id,
            'source_table', v_rec.source_table,
            'source_record_id', v_rec.source_record_id,
            'notes', p_request_notes
        ),
        NOW()
    );

    RETURN jsonb_build_object(
        'quarantine_id', p_quarantine_id,
        'status', 'UNDER_REVIEW',
        'requested_by', p_requester_operator_id,
        'requested_at', NOW()
    );
END;
$$;

-- Procedure 2: Approve Quarantine Release (Checker Action)
CREATE OR REPLACE FUNCTION identity.fn_approve_quarantine_release(
    p_quarantine_id UUID,
    p_approver_operator_id UUID,
    p_resolution_notes TEXT,
    p_release_execution BOOLEAN DEFAULT TRUE,
    p_release_reporting BOOLEAN DEFAULT TRUE,
    p_release_api BOOLEAN DEFAULT TRUE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, identity, public, pg_temp
AS $$
DECLARE
    v_rec RECORD;
    v_role VARCHAR(64);
BEGIN
    IF p_resolution_notes IS NULL OR TRIM(p_resolution_notes) = '' THEN
        RAISE EXCEPTION 'Resolution evidence notes are mandatory for quarantine release approval';
    END IF;

    -- 1. Validate approver operator is active and holds COMPLIANCE_OFFICER or SYSTEM_ADMIN role
    SELECT r.role_key INTO v_role
    FROM identity.operators o
    LEFT JOIN identity.operator_role_assignments ora ON o.operator_id = ora.operator_id AND ora.is_active IS TRUE
    LEFT JOIN identity.platform_operator_role_assignments pora ON o.operator_id = pora.operator_id AND pora.is_active IS TRUE
    JOIN identity.roles r ON r.role_id = COALESCE(ora.role_id, pora.role_id)
    WHERE o.operator_id = p_approver_operator_id AND o.is_active IS TRUE;

    IF v_role IS NULL THEN
        RAISE EXCEPTION 'UNAUTHORIZED: Operator % is not active or has no active role', p_approver_operator_id;
    END IF;

    IF v_role NOT IN ('COMPLIANCE_OFFICER', 'SYSTEM_ADMIN') THEN
        RAISE EXCEPTION 'FORBIDDEN: Role % cannot approve quarantine release (COMPLIANCE_OFFICER or SYSTEM_ADMIN required)', v_role;
    END IF;

    -- 2. Lock and validate quarantine record
    SELECT * INTO v_rec FROM identity.quarantined_records
    WHERE quarantine_id = p_quarantine_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Quarantine record % not found', p_quarantine_id;
    END IF;

    IF v_rec.status <> 'UNDER_REVIEW' THEN
        RAISE EXCEPTION 'Quarantine record % is in status % (must be UNDER_REVIEW to approve)', p_quarantine_id, v_rec.status;
    END IF;

    IF v_rec.requested_by IS NULL THEN
        RAISE EXCEPTION 'Quarantine record % has no recorded release requester', p_quarantine_id;
    END IF;

    -- 3. Four-Eyes check: Maker cannot be Checker!
    IF v_rec.requested_by = p_approver_operator_id THEN
        RAISE EXCEPTION 'Dual control check violation: Requester % cannot approve their own quarantine release', p_approver_operator_id;
    END IF;

    -- 4. Must release at least one block if releasing to RESOLVED_RELEASED
    IF p_release_execution IS NOT TRUE AND p_release_reporting IS NOT TRUE AND p_release_api IS NOT TRUE THEN
        RAISE EXCEPTION 'Cannot approve release without releasing at least one block (execution, reporting, or API)';
    END IF;

    -- 5. Update record to RESOLVED_RELEASED with checker audit and explicit block release
    UPDATE identity.quarantined_records
    SET status = 'RESOLVED_RELEASED',
        reviewed_by = p_approver_operator_id,
        reviewed_at = NOW(),
        resolution_notes = p_resolution_notes,
        is_blocked_from_execution = NOT p_release_execution,
        is_blocked_from_reporting = NOT p_release_reporting,
        is_blocked_from_api = NOT p_release_api
    WHERE quarantine_id = p_quarantine_id;

    -- 6. Record audit log
    INSERT INTO identity.auth_audit_log (
        operator_id, event_type, metadata, created_at
    ) VALUES (
        p_approver_operator_id,
        'QUARANTINE_RELEASE_APPROVED',
        jsonb_build_object(
            'quarantine_id', p_quarantine_id,
            'source_table', v_rec.source_table,
            'source_record_id', v_rec.source_record_id,
            'requested_by', v_rec.requested_by,
            'approver_id', p_approver_operator_id,
            'released_execution', p_release_execution,
            'released_reporting', p_release_reporting,
            'released_api', p_release_api,
            'notes', p_resolution_notes
        ),
        NOW()
    );

    RETURN jsonb_build_object(
        'quarantine_id', p_quarantine_id,
        'status', 'RESOLVED_RELEASED',
        'requested_by', v_rec.requested_by,
        'reviewed_by', p_approver_operator_id,
        'reviewed_at', NOW(),
        'released_execution', p_release_execution,
        'released_reporting', p_release_reporting,
        'released_api', p_release_api
    );
END;
$$;

-- Procedure 3: Reject Quarantine Release (Checker Action)
CREATE OR REPLACE FUNCTION identity.fn_reject_quarantine_release(
    p_quarantine_id UUID,
    p_reviewer_operator_id UUID,
    p_rejection_notes TEXT,
    p_permanently_suppress BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, identity, public, pg_temp
AS $$
DECLARE
    v_rec RECORD;
    v_role VARCHAR(64);
    v_new_status VARCHAR(32);
BEGIN
    IF p_rejection_notes IS NULL OR TRIM(p_rejection_notes) = '' THEN
        RAISE EXCEPTION 'Rejection notes are mandatory for quarantine rejection';
    END IF;

    SELECT r.role_key INTO v_role
    FROM identity.operators o
    LEFT JOIN identity.operator_role_assignments ora ON o.operator_id = ora.operator_id AND ora.is_active IS TRUE
    LEFT JOIN identity.platform_operator_role_assignments pora ON o.operator_id = pora.operator_id AND pora.is_active IS TRUE
    JOIN identity.roles r ON r.role_id = COALESCE(ora.role_id, pora.role_id)
    WHERE o.operator_id = p_reviewer_operator_id AND o.is_active IS TRUE;

    IF v_role IS NULL OR v_role NOT IN ('COMPLIANCE_OFFICER', 'SYSTEM_ADMIN') THEN
        RAISE EXCEPTION 'FORBIDDEN: Operator % cannot reject quarantine release (COMPLIANCE_OFFICER or SYSTEM_ADMIN required)', p_reviewer_operator_id;
    END IF;

    SELECT * INTO v_rec FROM identity.quarantined_records
    WHERE quarantine_id = p_quarantine_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Quarantine record % not found', p_quarantine_id;
    END IF;

    IF v_rec.requested_by = p_reviewer_operator_id THEN
        RAISE EXCEPTION 'Dual control check violation: Requester % cannot review their own quarantine request', p_reviewer_operator_id;
    END IF;

    v_new_status := CASE WHEN p_permanently_suppress IS TRUE THEN 'PERMANENTLY_SUPPRESSED' ELSE 'ACTIVE' END;

    UPDATE identity.quarantined_records
    SET status = v_new_status,
        reviewed_by = p_reviewer_operator_id,
        reviewed_at = NOW(),
        resolution_notes = 'REJECTED: ' || p_rejection_notes
    WHERE quarantine_id = p_quarantine_id;

    INSERT INTO identity.auth_audit_log (
        operator_id, event_type, metadata, created_at
    ) VALUES (
        p_reviewer_operator_id,
        'QUARANTINE_RELEASE_REJECTED',
        jsonb_build_object(
            'quarantine_id', p_quarantine_id,
            'source_table', v_rec.source_table,
            'source_record_id', v_rec.source_record_id,
            'requested_by', v_rec.requested_by,
            'reviewer_id', p_reviewer_operator_id,
            'new_status', v_new_status,
            'notes', p_rejection_notes
        ),
        NOW()
    );

    RETURN jsonb_build_object(
        'quarantine_id', p_quarantine_id,
        'status', v_new_status,
        'reviewed_by', p_reviewer_operator_id,
        'reviewed_at', NOW()
    );
END;
$$;

-- Trigger Guard: Prevent direct runtime update to RESOLVED_RELEASED and enforce dual control
CREATE OR REPLACE FUNCTION identity.trg_enforce_quarantined_records_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Prevent fusion_app_runtime from directly updating status to RESOLVED_RELEASED
        IF OLD.status IS DISTINCT FROM 'RESOLVED_RELEASED' AND NEW.status = 'RESOLVED_RELEASED' AND CURRENT_USER = 'fusion_app_runtime' THEN
            RAISE EXCEPTION 'Direct update of quarantined_records to RESOLVED_RELEASED is prohibited for application runtime. Must use identity.fn_approve_quarantine_release().';
        END IF;

        -- Enforce dual-control: Maker cannot be Checker
        IF NEW.requested_by IS NOT NULL AND NEW.reviewed_by IS NOT NULL AND NEW.requested_by = NEW.reviewed_by THEN
            RAISE EXCEPTION 'Dual control check violation: Requester % cannot approve their own quarantine release', NEW.requested_by;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_quarantined_records_guard ON identity.quarantined_records;
CREATE TRIGGER trg_quarantined_records_guard
BEFORE UPDATE ON identity.quarantined_records
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_quarantined_records_guard();

ALTER FUNCTION identity.fn_request_quarantine_release(UUID, UUID, TEXT) OWNER TO fusion_workflow_definer;
REVOKE ALL ON FUNCTION identity.fn_request_quarantine_release(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.fn_request_quarantine_release(UUID, UUID, TEXT) TO fusion_app_runtime;

ALTER FUNCTION identity.fn_approve_quarantine_release(UUID, UUID, TEXT, BOOLEAN, BOOLEAN, BOOLEAN) OWNER TO fusion_workflow_definer;
REVOKE ALL ON FUNCTION identity.fn_approve_quarantine_release(UUID, UUID, TEXT, BOOLEAN, BOOLEAN, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.fn_approve_quarantine_release(UUID, UUID, TEXT, BOOLEAN, BOOLEAN, BOOLEAN) TO fusion_app_runtime;

ALTER FUNCTION identity.fn_reject_quarantine_release(UUID, UUID, TEXT, BOOLEAN) OWNER TO fusion_workflow_definer;
REVOKE ALL ON FUNCTION identity.fn_reject_quarantine_release(UUID, UUID, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.fn_reject_quarantine_release(UUID, UUID, TEXT, BOOLEAN) TO fusion_app_runtime;

-- Lockdown quarantine registry table from customer runtime role
REVOKE ALL ON identity.quarantined_records FROM PUBLIC, fusion_app_runtime;
ALTER TABLE identity.quarantined_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.quarantined_records FORCE ROW LEVEL SECURITY;

-- Allow SECURITY DEFINER owner to inspect and manage quarantine status under forced RLS
GRANT SELECT, INSERT, UPDATE ON identity.quarantined_records TO fusion_workflow_definer;
GRANT SELECT ON identity.operators TO fusion_workflow_definer;
GRANT SELECT ON identity.roles TO fusion_workflow_definer;
GRANT SELECT ON identity.operator_role_assignments TO fusion_workflow_definer;
GRANT SELECT ON identity.platform_operator_role_assignments TO fusion_workflow_definer;
GRANT INSERT ON identity.auth_audit_log TO fusion_workflow_definer;

DROP POLICY IF EXISTS p_quarantine_workflow_definer ON identity.quarantined_records;
CREATE POLICY p_quarantine_workflow_definer ON identity.quarantined_records
    AS PERMISSIVE FOR SELECT TO fusion_workflow_definer
    USING (TRUE);

DROP POLICY IF EXISTS p_quarantine_workflow_definer_update ON identity.quarantined_records;
CREATE POLICY p_quarantine_workflow_definer_update ON identity.quarantined_records
    AS PERMISSIVE FOR UPDATE TO fusion_workflow_definer
    USING (TRUE)
    WITH CHECK (TRUE);

-- ==============================================================================
-- PHASE 4: SCHEMA EXTENSIONS — ADDING NULLABLE tenant_id COLUMNS (24 TABLES)
-- ==============================================================================

-- 4.1 Financial Resources & Transactions (8 tables)
ALTER TABLE public.instructions
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE public.balances
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE public.ledger_journal
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE public.invoices
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE public.invoice_saga_steps
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE public.reconciliation_log
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE public.routing_ledger
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE public.compliance_documents
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

-- 4.2 CashIQ Commercial Hierarchy & Operations (12 tables)
-- Pre-requisite DDL extracted from application schema & seeds for self-sufficient fresh migrations
CREATE TABLE IF NOT EXISTS public.departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID REFERENCES public.businesses(business_id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.budgets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id UUID REFERENCES public.departments(id) ON DELETE CASCADE,
    category VARCHAR(100) NOT NULL,
    monthly_limit NUMERIC(15, 2) NOT NULL,
    valid_from DATE NOT NULL,
    valid_to DATE,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.fx_exposures (
    exposure_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID REFERENCES public.businesses(business_id),
    vendor_name VARCHAR(255),
    currency VARCHAR(10) NOT NULL,
    foreign_amount NUMERIC(15, 2) NOT NULL,
    base_rate NUMERIC(10, 4) NOT NULL,
    current_rate NUMERIC(10, 4) NOT NULL,
    target_date DATE NOT NULL,
    status VARCHAR(50) DEFAULT 'OPEN',
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.scheduled_payments (
    schedule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    label VARCHAR(255),
    amount NUMERIC(20, 2) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    recipient_name VARCHAR(255) NOT NULL,
    purpose VARCHAR(100) NOT NULL DEFAULT 'VENDOR_PAYMENT',
    scheduled_date DATE NOT NULL,
    recurrence VARCHAR(20) DEFAULT 'ONCE',
    status VARCHAR(20) DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'PROCESSING', 'DONE', 'CANCELLED', 'FAILED')),
    note TEXT,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.vendor_contacts (
    contact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('VENDOR', 'CUSTOMER')),
    gstin VARCHAR(20),
    pan VARCHAR(15),
    email VARCHAR(255),
    phone VARCHAR(30),
    bank_name VARCHAR(100),
    ifsc VARCHAR(15),
    account_number VARCHAR(30),
    outstanding_balance NUMERIC(20, 2) DEFAULT 0,
    total_paid NUMERIC(20, 2) DEFAULT 0,
    last_txn_date DATE,
    payment_terms_days INTEGER DEFAULT 30,
    notes TEXT,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.businesses
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE public.business_bank_accounts
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE public.bank_transactions
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE public.obligations
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE public.departments
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE public.budgets
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE public.alert_rules
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE public.alert_events
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE public.fx_exposures
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE public.aa_consents
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE public.scheduled_payments
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE public.vendor_contacts
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

-- 4.3 Idempotency Keys (1 table)
ALTER TABLE public.idempotency_keys
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

-- 4.4 Identity Execution & Evidence Tables from Migrations 024-027 (3 tables)
ALTER TABLE identity.payment_dispatch_records
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE identity.payment_settlement_evidence
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

ALTER TABLE identity.saga_dispatch_outbox
    ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES identity.tenants(tenant_id);

-- Legacy table formal deprecation (if relation exists)
DO $$
BEGIN
    IF to_regclass('public.instruction_approvals') IS NOT NULL THEN
        COMMENT ON TABLE public.instruction_approvals IS 
            'DEPRECATED: Superseded by identity.payment_approvals. Retained for foreign key integrity only.';
    END IF;
END $$;

-- ==============================================================================
-- PHASE 5: DETERMINISTIC HISTORICAL DATA BACKFILLS
-- ==============================================================================

-- Surgically disable ONLY the state transition guard during historical metadata backfill
-- (Enables backfilling tenant_id on legacy settled, voided, and locked historical records
-- while retaining maker immutability, material freeze, delete, and truncate triggers permanently active)
ALTER TABLE public.instructions DISABLE TRIGGER trg_00_instructions_state_guard;

-- 5.1 Backfill CashIQ Businesses (2 rows)
UPDATE public.businesses
SET tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE business_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

UPDATE public.businesses
SET tenant_id = '00000000-0000-0000-0000-000000000002'
WHERE business_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

-- 5.2 Backfill Business-Linked Tables via Parent Foreign Keys
UPDATE public.business_bank_accounts bba
SET tenant_id = b.tenant_id
FROM public.businesses b
WHERE bba.business_id = b.business_id;

UPDATE public.bank_transactions bt
SET tenant_id = b.tenant_id
FROM public.businesses b
WHERE bt.business_id = b.business_id;

UPDATE public.obligations o
SET tenant_id = b.tenant_id
FROM public.businesses b
WHERE o.business_id = b.business_id;

UPDATE public.departments d
SET tenant_id = b.tenant_id
FROM public.businesses b
WHERE d.business_id = b.business_id;

UPDATE public.budgets bg
SET tenant_id = d.tenant_id
FROM public.departments d
WHERE bg.department_id = d.id;

UPDATE public.alert_rules ar
SET tenant_id = b.tenant_id
FROM public.businesses b
WHERE ar.business_id = b.business_id;

UPDATE public.alert_events ae
SET tenant_id = b.tenant_id
FROM public.businesses b
WHERE ae.business_id = b.business_id;

UPDATE public.fx_exposures fe
SET tenant_id = b.tenant_id
FROM public.businesses b
WHERE fe.business_id = b.business_id;

UPDATE public.aa_consents aac
SET tenant_id = b.tenant_id
FROM public.businesses b
WHERE aac.business_id = b.business_id;

UPDATE public.scheduled_payments sp
SET tenant_id = b.tenant_id
FROM public.businesses b
WHERE sp.business_id = b.business_id;

-- 5.3 Backfill Invoices (All 3 Zoho Invoices belong to Tenant 3)
UPDATE public.invoices
SET tenant_id = '00000000-0000-0000-0000-000000000003'
WHERE invoice_id IN ('ZOHO-3808830000000071020', 'ZOHO-3808830000000071035', 'ZOHO-3808830000000071082');

UPDATE public.invoice_saga_steps iss
SET tenant_id = inv.tenant_id
FROM public.invoices inv
WHERE iss.invoice_id = inv.invoice_id;

-- 5.4 Backfill Instructions (82 rows)
-- A. Commercial Coimbatore Mills (3 rows -> Tenant 1)
UPDATE public.instructions
SET tenant_id = '00000000-0000-0000-0000-000000000001'
WHERE sender = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

-- B. Alice_Corp Settled & Manual Instructions (12 rows -> Tenant 3)
UPDATE public.instructions
SET tenant_id = '00000000-0000-0000-0000-000000000003'
WHERE sender = 'Alice_Corp';

-- C. Stale Saga ABC Instructions (21 rows -> Tenant 3, Quarantined)
UPDATE public.instructions
SET tenant_id = '00000000-0000-0000-0000-000000000003'
WHERE sender = 'ABC' AND recipient = 'Fusion Seller';

-- D. Test Harness Fixtures (46 rows -> Tenant 99)
UPDATE public.instructions
SET tenant_id = '00000000-0000-0000-0000-000000000099'
WHERE sender IN ('user_123_test', 'GENERIC_USER_099', 'synth_org_sender_001', 'synth_org_sender_002')
   OR sender LIKE 'user_e2e_%';

-- 5.5 Backfill Instruction-Linked Tables
UPDATE public.reconciliation_log rl
SET tenant_id = i.tenant_id
FROM public.instructions i
WHERE rl.instruction_id = i.instruction_id;

UPDATE public.routing_ledger rlg
SET tenant_id = i.tenant_id
FROM public.instructions i
WHERE rlg.transaction_id = i.instruction_id;

UPDATE public.compliance_documents cd
SET tenant_id = i.tenant_id
FROM public.instructions i
WHERE cd.instruction_id = i.instruction_id;

UPDATE identity.payment_dispatch_records pdr
SET tenant_id = i.tenant_id
FROM public.instructions i
WHERE pdr.instruction_id = i.instruction_id;

UPDATE identity.payment_settlement_evidence pse
SET tenant_id = i.tenant_id
FROM public.instructions i
WHERE pse.instruction_id = i.instruction_id;

UPDATE identity.saga_dispatch_outbox sdo
SET tenant_id = i.tenant_id
FROM public.instructions i
WHERE sdo.instruction_id = i.instruction_id;

-- 5.6 Backfill Balances (45 rows)
-- Platform Accounts remain tenant_id = NULL
UPDATE public.balances
SET tenant_id = NULL
WHERE account_id IN ('FUSION_MASTER', 'FUSION_EXTERNAL_BANK');

-- Tenant 3 Demo Accounts (17 rows)
UPDATE public.balances
SET tenant_id = '00000000-0000-0000-0000-000000000003'
WHERE account_id IN ('Alice_Corp', 'Alice_Wallet', 'Bob_ColdStorage', 'Bob_Supply');

-- Tenant 99 Test Harness Accounts (23 rows)
UPDATE public.balances
SET tenant_id = '00000000-0000-0000-0000-000000000099'
WHERE account_id IN ('user_123_test', 'user_456_test', 'GENERIC_USER_099')
   OR account_id LIKE 'user_e2e_%';

-- 5.7 Backfill Ledger Journal (78 rows, 39 balanced pairs)
-- Sequences 1-2: Platform Bootstrap ($10,000 USD) -> Assigned to Tenant 3
UPDATE public.ledger_journal
SET tenant_id = '00000000-0000-0000-0000-000000000003'
WHERE sequence_id IN (1, 2);

-- Sequences 3-12: Concurrency Test Fixtures -> Tenant 99
UPDATE public.ledger_journal
SET tenant_id = '00000000-0000-0000-0000-000000000099'
WHERE sequence_id BETWEEN 3 AND 12;

-- Sequences 13-78: Backfill via matching instruction_id
UPDATE public.ledger_journal lj
SET tenant_id = i.tenant_id
FROM public.instructions i
WHERE lj.instruction_id = i.instruction_id
  AND lj.sequence_id >= 13;

-- Re-enable state transition guard immediately following historical metadata backfill
ALTER TABLE public.instructions ENABLE TRIGGER trg_00_instructions_state_guard;

-- ==============================================================================
-- PHASE 6: SEED RECORD-LEVEL QUARANTINE REGISTRY (EXACTLY 84 ROWS)
-- ==============================================================================

-- 6.1 Quarantine Unresolved Short-Name Recipient Instructions (7 rows)
INSERT INTO identity.quarantined_records (
    source_table, source_record_id, source_identifier, assigned_tenant_id,
    quarantine_class, quarantine_reason, status
)
SELECT 
    'instructions',
    instruction_id::text,
    recipient,
    tenant_id,
    'UNRESOLVED_COUNTERPARTY',
    'Unresolved prototype recipient identifier (' || recipient || ') from early manual test execution.',
    'ACTIVE'
FROM public.instructions
WHERE sender = 'Alice_Corp' AND recipient IN ('Alice', 'con', 'bob', 'hy', 'bala', 'kat')
ON CONFLICT (source_schema, source_table, source_record_id) DO NOTHING;

-- 6.2 Quarantine Stale Saga ABC Instructions (21 rows)
INSERT INTO identity.quarantined_records (
    source_table, source_record_id, source_identifier, assigned_tenant_id,
    quarantine_class, quarantine_reason, status
)
SELECT 
    'instructions',
    instruction_id::text,
    sender,
    tenant_id,
    'STALE_SAGA_ATTEMPT',
    'Stale initial saga step generated under customer name ABC before canonical execution.',
    'ACTIVE'
FROM public.instructions
WHERE sender = 'ABC' AND recipient = 'Fusion Seller'
ON CONFLICT (source_schema, source_table, source_record_id) DO NOTHING;

-- 6.3 Quarantine Concurrency Stress Test Ledger Rows (10 rows)
INSERT INTO identity.quarantined_records (
    source_table, source_record_id, source_identifier, assigned_tenant_id,
    quarantine_class, quarantine_reason, status
)
SELECT 
    'ledger_journal',
    sequence_id::text,
    account_id,
    tenant_id,
    'ORPHAN_LEDGER_TRANSACTION',
    'Direct ledger write from tests/concurrency_ledger.js without corresponding instruction record.',
    'ACTIVE'
FROM public.ledger_journal
WHERE sequence_id BETWEEN 3 AND 12
ON CONFLICT (source_schema, source_table, source_record_id) DO NOTHING;

-- 6.4 Quarantine Test Harness Instructions (46 rows)
INSERT INTO identity.quarantined_records (
    source_table, source_record_id, source_identifier, assigned_tenant_id,
    quarantine_class, quarantine_reason, status
)
SELECT 
    'instructions',
    instruction_id::text,
    sender,
    tenant_id,
    'TEST_HARNESS_FIXTURE',
    'Automated test fixture instruction isolated within Tenant 99 quarantine boundary.',
    'ACTIVE'
FROM public.instructions
WHERE tenant_id = '00000000-0000-0000-0000-000000000099'
ON CONFLICT (source_schema, source_table, source_record_id) DO NOTHING;

-- ==============================================================================
-- PHASE 7: IDEMPOTENCY CONSTRAINTS & PERFORMANCE INDEXES
-- ==============================================================================

-- 7.1 Idempotency Keys Tenant-Scoped Uniqueness Model
-- Drop legacy single-column primary key on key_id alone, which would prevent different
-- tenants from safely using identical client-supplied idempotency keys (e.g., 'tx_001').
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conrelid = 'public.idempotency_keys'::regclass 
          AND contype = 'p'
          AND array_length(conkey, 1) = 1
    ) THEN
        ALTER TABLE public.idempotency_keys DROP CONSTRAINT idempotency_keys_pkey;
    END IF;
END $$;

-- Assert zero unowned legacy idempotency keys exist (fail closed without inventing artificial ownership)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.idempotency_keys WHERE tenant_id IS NULL) THEN
        RAISE EXCEPTION 'PRECONDITION FAILED: Unassigned idempotency keys found without tenant ownership';
    END IF;
END $$;

-- Enforce NOT NULL on tenant_id
ALTER TABLE public.idempotency_keys ALTER COLUMN tenant_id SET NOT NULL;

-- Establish composite primary key on (tenant_id, key_id)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conrelid = 'public.idempotency_keys'::regclass AND contype = 'p'
    ) THEN
        ALTER TABLE public.idempotency_keys ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (tenant_id, key_id);
    END IF;
END $$;

-- 7.2 Performance Indexes on Tenant Columns
CREATE INDEX IF NOT EXISTS idx_instructions_tenant_id ON public.instructions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_balances_tenant_id ON public.balances(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ledger_journal_tenant_id ON public.ledger_journal(tenant_id);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_id ON public.invoices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_businesses_tenant_id ON public.businesses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_tenant_id ON public.bank_transactions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_obligations_tenant_id ON public.obligations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payment_dispatch_tenant_id ON identity.payment_dispatch_records(tenant_id);
CREATE INDEX IF NOT EXISTS idx_saga_outbox_tenant_id ON identity.saga_dispatch_outbox(tenant_id);

-- ==============================================================================
-- PHASE 8: CONTROLLED LEDGER ACCESS FUNCTION & SECURE VIEW FACADE
-- ==============================================================================

-- 8.1 Direct SELECT on public.ledger_journal is revoked from application runtime
REVOKE ALL ON public.ledger_journal FROM fusion_app_runtime;

-- 8.2 Crucial: Grant SELECT to fusion_workflow_definer so the SECURITY DEFINER function can read
GRANT SELECT ON public.ledger_journal TO fusion_workflow_definer;

-- 8.3 Create Authoritative Account Classification Function (pg_temp last)
CREATE OR REPLACE FUNCTION identity.fn_classify_ledger_account(p_account_id VARCHAR)
RETURNS VARCHAR
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT CASE 
        WHEN p_account_id IN ('FUSION_EXTERNAL_BANK', 'FUSION_MASTER') THEN 'PLATFORM_CLEARING'
        ELSE 'CLIENT_ACCOUNT'
    END;
$$;

ALTER FUNCTION identity.fn_classify_ledger_account(VARCHAR) OWNER TO fusion_workflow_definer;
REVOKE ALL ON FUNCTION identity.fn_classify_ledger_account(VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.fn_classify_ledger_account(VARCHAR) TO fusion_app_runtime;

-- 8.3.1 Secure Active Tenant Context Extraction Function (pg_temp last)
-- Fails closed (returns NULL) if tenant is inactive (e.g., Tenant 99 quarantine boundary) or unset
CREATE OR REPLACE FUNCTION identity.fn_current_active_tenant_id()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, identity, pg_temp
AS $$
    SELECT tenant_id 
    FROM identity.tenants 
    WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid
      AND is_active IS TRUE 
      AND status = 'ACTIVE';
$$;

ALTER FUNCTION identity.fn_current_active_tenant_id() OWNER TO fusion_workflow_definer;
REVOKE ALL ON FUNCTION identity.fn_current_active_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.fn_current_active_tenant_id() TO fusion_app_runtime;

-- 8.4 Table-Valued SECURITY DEFINER Ledger Reader Function (pg_temp last)
CREATE OR REPLACE FUNCTION identity.fn_get_tenant_ledger()
RETURNS TABLE (
    sequence_id            INTEGER,
    instruction_id         UUID,
    "timestamp"            TIMESTAMPTZ,
    direction              VARCHAR(10),
    amount                 NUMERIC(56, 18),
    currency               VARCHAR(10),
    account_name           VARCHAR(64),
    account_classification VARCHAR(32),
    tenant_id              UUID
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, identity, pg_temp
AS $$
DECLARE
    v_tenant_id UUID;
BEGIN
    -- Extract tenant context safely (fail-closed, denies inactive/quarantine tenants)
    v_tenant_id := identity.fn_current_active_tenant_id();
    
    IF v_tenant_id IS NULL THEN
        -- Fail closed: Return zero rows if no active tenant context is established
        RETURN;
    END IF;

    RETURN QUERY
    SELECT 
        lj.sequence_id,
        lj.instruction_id,
        lj.timestamp,
        lj.direction,
        lj.amount,
        lj.currency,
        CASE 
            WHEN lj.account_id IN ('FUSION_EXTERNAL_BANK', 'FUSION_MASTER') 
                THEN 'FUSION_SETTLEMENT_CLEARING'::VARCHAR(64)
            ELSE lj.account_id::VARCHAR(64)
        END AS account_name,
        CASE 
            WHEN lj.account_id IN ('FUSION_EXTERNAL_BANK', 'FUSION_MASTER') 
                THEN 'PLATFORM_CLEARING'::VARCHAR(32)
            ELSE 'CLIENT_ACCOUNT'::VARCHAR(32)
        END AS account_classification,
        lj.tenant_id
    FROM public.ledger_journal lj
    WHERE lj.tenant_id = v_tenant_id
      -- Quarantine Visibility Filter: suppress directly quarantined ledger entries
      AND NOT identity.fn_is_record_quarantined('ledger_journal', lj.sequence_id::text)
      -- Quarantine Visibility Filter: suppress ledger entries originating from quarantined instructions
      AND NOT (
          lj.instruction_id IS NOT NULL 
          AND identity.fn_is_record_quarantined('instructions', lj.instruction_id::text)
      )
    ORDER BY lj.sequence_id ASC;
END;
$$;

ALTER FUNCTION identity.fn_get_tenant_ledger() OWNER TO fusion_workflow_definer;
REVOKE ALL ON FUNCTION identity.fn_get_tenant_ledger() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.fn_get_tenant_ledger() TO fusion_app_runtime;

-- 8.5 Secure Ledger View Facade
CREATE OR REPLACE VIEW identity.tenant_ledger_view AS
SELECT * FROM identity.fn_get_tenant_ledger();

ALTER VIEW identity.tenant_ledger_view OWNER TO fusion_workflow_definer;
REVOKE ALL ON identity.tenant_ledger_view FROM PUBLIC;
GRANT SELECT ON identity.tenant_ledger_view TO fusion_app_runtime;

-- ==============================================================================
-- PHASE 9: COMPLETE ROW LEVEL SECURITY POLICIES (ALL 24 ALTERED TABLES)
-- ==============================================================================

-- 9.0 Grant Runtime DML Privileges to fusion_app_runtime on Governed Tables
GRANT SELECT, INSERT, UPDATE ON 
    public.instructions,
    public.balances,
    public.invoices,
    public.businesses,
    public.business_bank_accounts,
    public.bank_transactions,
    public.obligations,
    public.departments,
    public.budgets,
    public.alert_rules,
    public.alert_events,
    public.fx_exposures,
    public.idempotency_keys,
    public.invoice_saga_steps,
    public.reconciliation_log,
    public.routing_ledger,
    public.compliance_documents,
    public.aa_consents,
    public.scheduled_payments,
    public.vendor_contacts,
    identity.payment_dispatch_records,
    identity.payment_settlement_evidence,
    identity.saga_dispatch_outbox
TO fusion_app_runtime;

-- 9.1 public.instructions
ALTER TABLE public.instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instructions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_instructions_runtime ON public.instructions;
CREATE POLICY p_instructions_runtime ON public.instructions
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_instructions_isolation ON public.instructions;
CREATE POLICY r_instructions_isolation ON public.instructions
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (
        tenant_id IS NOT NULL 
        AND tenant_id = identity.fn_current_active_tenant_id()
        AND NOT identity.fn_is_record_quarantined('instructions', instruction_id::text)
    )
    WITH CHECK (
        tenant_id IS NOT NULL 
        AND tenant_id = identity.fn_current_active_tenant_id()
        AND NOT identity.fn_is_record_quarantined('instructions', instruction_id::text)
    );

-- 9.2 public.balances (Treasury strictly isolated)
ALTER TABLE public.balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.balances FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_balances_runtime ON public.balances;
CREATE POLICY p_balances_runtime ON public.balances
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_balances_isolation ON public.balances;
CREATE POLICY r_balances_isolation ON public.balances
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (
        is_treasury IS FALSE 
        AND tenant_id IS NOT NULL 
        AND tenant_id = identity.fn_current_active_tenant_id()
    )
    WITH CHECK (
        is_treasury IS FALSE 
        AND tenant_id IS NOT NULL 
        AND tenant_id = identity.fn_current_active_tenant_id()
    );

-- 9.3 public.businesses
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.businesses FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_businesses_runtime ON public.businesses;
CREATE POLICY p_businesses_runtime ON public.businesses
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_businesses_isolation ON public.businesses;
CREATE POLICY r_businesses_isolation ON public.businesses
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.4 public.invoices
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_invoices_runtime ON public.invoices;
CREATE POLICY p_invoices_runtime ON public.invoices
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_invoices_isolation ON public.invoices;
CREATE POLICY r_invoices_isolation ON public.invoices
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.5 public.bank_transactions
ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_transactions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_bank_txns_runtime ON public.bank_transactions;
CREATE POLICY p_bank_txns_runtime ON public.bank_transactions
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_bank_txns_isolation ON public.bank_transactions;
CREATE POLICY r_bank_txns_isolation ON public.bank_transactions
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.6 public.obligations
ALTER TABLE public.obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.obligations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_obligations_runtime ON public.obligations;
CREATE POLICY p_obligations_runtime ON public.obligations
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_obligations_isolation ON public.obligations;
CREATE POLICY r_obligations_isolation ON public.obligations
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.7 public.business_bank_accounts
ALTER TABLE public.business_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_bank_accounts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_bank_accounts_runtime ON public.business_bank_accounts;
CREATE POLICY p_bank_accounts_runtime ON public.business_bank_accounts
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_bank_accounts_isolation ON public.business_bank_accounts;
CREATE POLICY r_bank_accounts_isolation ON public.business_bank_accounts
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.8 public.idempotency_keys
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_idempotency_runtime ON public.idempotency_keys;
CREATE POLICY p_idempotency_runtime ON public.idempotency_keys
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_idempotency_isolation ON public.idempotency_keys;
CREATE POLICY r_idempotency_isolation ON public.idempotency_keys
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.9 identity.saga_dispatch_outbox
ALTER TABLE identity.saga_dispatch_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.saga_dispatch_outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_saga_outbox_runtime ON identity.saga_dispatch_outbox;
CREATE POLICY p_saga_outbox_runtime ON identity.saga_dispatch_outbox
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_saga_outbox_isolation ON identity.saga_dispatch_outbox;
CREATE POLICY r_saga_outbox_isolation ON identity.saga_dispatch_outbox
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.10 identity.tenant_memberships
ALTER TABLE identity.tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.tenant_memberships FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_tenant_memberships_runtime ON identity.tenant_memberships;
CREATE POLICY p_tenant_memberships_runtime ON identity.tenant_memberships
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_tenant_memberships_isolation ON identity.tenant_memberships;
CREATE POLICY r_tenant_memberships_isolation ON identity.tenant_memberships
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.11 identity.tenant_provider_configs
ALTER TABLE identity.tenant_provider_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.tenant_provider_configs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_tenant_configs_runtime ON identity.tenant_provider_configs;
CREATE POLICY p_tenant_configs_runtime ON identity.tenant_provider_configs
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_tenant_configs_isolation ON identity.tenant_provider_configs;
CREATE POLICY r_tenant_configs_isolation ON identity.tenant_provider_configs
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.12 public.invoice_saga_steps
ALTER TABLE public.invoice_saga_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_saga_steps FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_saga_steps_runtime ON public.invoice_saga_steps;
CREATE POLICY p_saga_steps_runtime ON public.invoice_saga_steps
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_saga_steps_isolation ON public.invoice_saga_steps;
CREATE POLICY r_saga_steps_isolation ON public.invoice_saga_steps
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.13 public.reconciliation_log
ALTER TABLE public.reconciliation_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_recon_log_runtime ON public.reconciliation_log;
CREATE POLICY p_recon_log_runtime ON public.reconciliation_log
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_recon_log_isolation ON public.reconciliation_log;
CREATE POLICY r_recon_log_isolation ON public.reconciliation_log
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.14 public.routing_ledger
ALTER TABLE public.routing_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routing_ledger FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_routing_ledger_runtime ON public.routing_ledger;
CREATE POLICY p_routing_ledger_runtime ON public.routing_ledger
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_routing_ledger_isolation ON public.routing_ledger;
CREATE POLICY r_routing_ledger_isolation ON public.routing_ledger
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.15 public.compliance_documents
ALTER TABLE public.compliance_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_documents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_compliance_docs_runtime ON public.compliance_documents;
CREATE POLICY p_compliance_docs_runtime ON public.compliance_documents
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_compliance_docs_isolation ON public.compliance_documents;
CREATE POLICY r_compliance_docs_isolation ON public.compliance_documents
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.16 public.departments
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.departments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_departments_runtime ON public.departments;
CREATE POLICY p_departments_runtime ON public.departments
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_departments_isolation ON public.departments;
CREATE POLICY r_departments_isolation ON public.departments
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.17 public.budgets
ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budgets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_budgets_runtime ON public.budgets;
CREATE POLICY p_budgets_runtime ON public.budgets
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_budgets_isolation ON public.budgets;
CREATE POLICY r_budgets_isolation ON public.budgets
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.18 public.alert_rules
ALTER TABLE public.alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_alert_rules_runtime ON public.alert_rules;
CREATE POLICY p_alert_rules_runtime ON public.alert_rules
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_alert_rules_isolation ON public.alert_rules;
CREATE POLICY r_alert_rules_isolation ON public.alert_rules
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.19 public.alert_events
ALTER TABLE public.alert_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_alert_events_runtime ON public.alert_events;
CREATE POLICY p_alert_events_runtime ON public.alert_events
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_alert_events_isolation ON public.alert_events;
CREATE POLICY r_alert_events_isolation ON public.alert_events
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.20 public.fx_exposures
ALTER TABLE public.fx_exposures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_exposures FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_fx_exposures_runtime ON public.fx_exposures;
CREATE POLICY p_fx_exposures_runtime ON public.fx_exposures
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_fx_exposures_isolation ON public.fx_exposures;
CREATE POLICY r_fx_exposures_isolation ON public.fx_exposures
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.21 public.aa_consents
ALTER TABLE public.aa_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aa_consents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_aa_consents_runtime ON public.aa_consents;
CREATE POLICY p_aa_consents_runtime ON public.aa_consents
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_aa_consents_isolation ON public.aa_consents;
CREATE POLICY r_aa_consents_isolation ON public.aa_consents
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.22 public.scheduled_payments
ALTER TABLE public.scheduled_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_payments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_sched_payments_runtime ON public.scheduled_payments;
CREATE POLICY p_sched_payments_runtime ON public.scheduled_payments
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_sched_payments_isolation ON public.scheduled_payments;
CREATE POLICY r_sched_payments_isolation ON public.scheduled_payments
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.23 public.vendor_contacts
ALTER TABLE public.vendor_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_contacts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_vendor_contacts_runtime ON public.vendor_contacts;
CREATE POLICY p_vendor_contacts_runtime ON public.vendor_contacts
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_vendor_contacts_isolation ON public.vendor_contacts;
CREATE POLICY r_vendor_contacts_isolation ON public.vendor_contacts
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.24 identity.payment_dispatch_records
ALTER TABLE identity.payment_dispatch_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.payment_dispatch_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_dispatch_records_runtime ON identity.payment_dispatch_records;
CREATE POLICY p_dispatch_records_runtime ON identity.payment_dispatch_records
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_dispatch_records_isolation ON identity.payment_dispatch_records;
CREATE POLICY r_dispatch_records_isolation ON identity.payment_dispatch_records
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- 9.25 identity.payment_settlement_evidence
ALTER TABLE identity.payment_settlement_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.payment_settlement_evidence FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p_settlement_evidence_runtime ON identity.payment_settlement_evidence;
CREATE POLICY p_settlement_evidence_runtime ON identity.payment_settlement_evidence
    AS PERMISSIVE FOR ALL TO fusion_app_runtime
    USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS r_settlement_evidence_isolation ON identity.payment_settlement_evidence;
CREATE POLICY r_settlement_evidence_isolation ON identity.payment_settlement_evidence
    AS RESTRICTIVE FOR ALL TO fusion_app_runtime
    USING (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id())
    WITH CHECK (tenant_id IS NOT NULL AND tenant_id = identity.fn_current_active_tenant_id());

-- ==============================================================================
-- PHASE 10: POST-MIGRATION INTEGRITY ASSERTIONS (FAIL-CLOSED)
-- ==============================================================================

DO $$
DECLARE
    v_unowned_instructions INTEGER;
    v_unowned_balances     INTEGER;
    v_unowned_invoices     INTEGER;
    v_unowned_businesses   INTEGER;
    v_unowned_ledger       INTEGER;
    v_unowned_departments  INTEGER;
    v_unowned_budgets      INTEGER;
    v_unowned_alert_rules  INTEGER;
    v_unowned_alert_events INTEGER;
    v_unowned_fx           INTEGER;
    v_unowned_bank_txns    INTEGER;
    v_unowned_obligations  INTEGER;
    v_unowned_bank_accts   INTEGER;
    v_total_quarantines    INTEGER;
    v_instruction_quarantines INTEGER;
    v_ledger_quarantines   INTEGER;
    v_duplicate_quarantines INTEGER;
    v_cross_tenant_checks  INTEGER;
    v_t99_active           BOOLEAN;
    v_treasury_unowned     INTEGER;
BEGIN
    -- 1. Assert zero unowned records across all core tables
    SELECT COUNT(*) INTO v_unowned_instructions FROM public.instructions WHERE tenant_id IS NULL;
    IF v_unowned_instructions > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: % instruction(s) have NULL tenant_id.', v_unowned_instructions;
    END IF;

    SELECT COUNT(*) INTO v_unowned_balances FROM public.balances WHERE tenant_id IS NULL AND is_treasury IS FALSE;
    IF v_unowned_balances > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: % non-treasury balance(s) have NULL tenant_id.', v_unowned_balances;
    END IF;

    SELECT COUNT(*) INTO v_unowned_invoices FROM public.invoices WHERE tenant_id IS NULL;
    IF v_unowned_invoices > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: % invoice(s) have NULL tenant_id.', v_unowned_invoices;
    END IF;

    SELECT COUNT(*) INTO v_unowned_businesses FROM public.businesses WHERE tenant_id IS NULL;
    IF v_unowned_businesses > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: % business(es) have NULL tenant_id.', v_unowned_businesses;
    END IF;

    SELECT COUNT(*) INTO v_unowned_ledger FROM public.ledger_journal WHERE tenant_id IS NULL;
    IF v_unowned_ledger > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: % ledger row(s) have NULL tenant_id.', v_unowned_ledger;
    END IF;

    SELECT COUNT(*) INTO v_unowned_departments FROM public.departments WHERE tenant_id IS NULL;
    IF v_unowned_departments > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: % department(s) have NULL tenant_id.', v_unowned_departments;
    END IF;

    SELECT COUNT(*) INTO v_unowned_budgets FROM public.budgets WHERE tenant_id IS NULL;
    IF v_unowned_budgets > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: % budget(s) have NULL tenant_id.', v_unowned_budgets;
    END IF;

    SELECT COUNT(*) INTO v_unowned_alert_rules FROM public.alert_rules WHERE tenant_id IS NULL;
    IF v_unowned_alert_rules > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: % alert rule(s) have NULL tenant_id.', v_unowned_alert_rules;
    END IF;

    SELECT COUNT(*) INTO v_unowned_alert_events FROM public.alert_events WHERE tenant_id IS NULL;
    IF v_unowned_alert_events > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: % alert event(s) have NULL tenant_id.', v_unowned_alert_events;
    END IF;

    SELECT COUNT(*) INTO v_unowned_fx FROM public.fx_exposures WHERE tenant_id IS NULL;
    IF v_unowned_fx > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: % fx exposure(s) have NULL tenant_id.', v_unowned_fx;
    END IF;

    SELECT COUNT(*) INTO v_unowned_bank_txns FROM public.bank_transactions WHERE tenant_id IS NULL;
    IF v_unowned_bank_txns > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: % bank transaction(s) have NULL tenant_id.', v_unowned_bank_txns;
    END IF;

    SELECT COUNT(*) INTO v_unowned_obligations FROM public.obligations WHERE tenant_id IS NULL;
    IF v_unowned_obligations > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: % obligation(s) have NULL tenant_id.', v_unowned_obligations;
    END IF;

    SELECT COUNT(*) INTO v_unowned_bank_accts FROM public.business_bank_accounts WHERE tenant_id IS NULL;
    IF v_unowned_bank_accts > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: % business bank account(s) have NULL tenant_id.', v_unowned_bank_accts;
    END IF;

    -- 2. Assert exact quarantine counts (74 instructions + 10 ledger = 84 total on historical baseline)
    IF EXISTS (SELECT 1 FROM public.instructions) THEN
        SELECT COUNT(*) INTO v_total_quarantines FROM identity.quarantined_records WHERE status = 'ACTIVE';
        IF v_total_quarantines <> 84 THEN
            RAISE EXCEPTION 'POSTCONDITION FAILED: Expected exactly 84 active quarantined records, found %.', v_total_quarantines;
        END IF;

        SELECT COUNT(*) INTO v_instruction_quarantines 
        FROM identity.quarantined_records 
        WHERE source_table = 'instructions' AND status = 'ACTIVE';
        IF v_instruction_quarantines <> 74 THEN
            RAISE EXCEPTION 'POSTCONDITION FAILED: Expected exactly 74 quarantined instruction records, found %.', v_instruction_quarantines;
        END IF;

        SELECT COUNT(*) INTO v_ledger_quarantines 
        FROM identity.quarantined_records 
        WHERE source_table = 'ledger_journal' AND status = 'ACTIVE';
        IF v_ledger_quarantines <> 10 THEN
            RAISE EXCEPTION 'POSTCONDITION FAILED: Expected exactly 10 quarantined ledger records, found %.', v_ledger_quarantines;
        END IF;
    END IF;

    -- Assert zero duplicate source records in quarantine
    SELECT COUNT(*) INTO v_duplicate_quarantines
    FROM (
        SELECT source_schema, source_table, source_record_id, COUNT(*)
        FROM identity.quarantined_records
        GROUP BY source_schema, source_table, source_record_id
        HAVING COUNT(*) > 1
    ) dup;
    IF v_duplicate_quarantines > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: Found % duplicate quarantine source records.', v_duplicate_quarantines;
    END IF;

    -- 3. Assert zero cross-tenant parent-child foreign key violations
    -- Bank transactions vs Business
    SELECT COUNT(*) INTO v_cross_tenant_checks
    FROM public.bank_transactions bt
    JOIN public.businesses b ON bt.business_id = b.business_id
    WHERE bt.tenant_id <> b.tenant_id;
    IF v_cross_tenant_checks > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: Found % cross-tenant bank transactions.', v_cross_tenant_checks;
    END IF;

    -- Obligations vs Business
    SELECT COUNT(*) INTO v_cross_tenant_checks
    FROM public.obligations o
    JOIN public.businesses b ON o.business_id = b.business_id
    WHERE o.tenant_id <> b.tenant_id;
    IF v_cross_tenant_checks > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: Found % cross-tenant obligations.', v_cross_tenant_checks;
    END IF;

    -- Departments vs Business
    SELECT COUNT(*) INTO v_cross_tenant_checks
    FROM public.departments d
    JOIN public.businesses b ON d.business_id = b.business_id
    WHERE d.tenant_id <> b.tenant_id;
    IF v_cross_tenant_checks > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: Found % cross-tenant departments.', v_cross_tenant_checks;
    END IF;

    -- Budgets vs Department
    SELECT COUNT(*) INTO v_cross_tenant_checks
    FROM public.budgets bg
    JOIN public.departments d ON bg.department_id = d.id
    WHERE bg.tenant_id <> d.tenant_id;
    IF v_cross_tenant_checks > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: Found % cross-tenant budgets.', v_cross_tenant_checks;
    END IF;

    -- Invoices vs Instructions
    SELECT COUNT(*) INTO v_cross_tenant_checks
    FROM public.instructions i
    JOIN public.invoices inv ON inv.invoice_id = 'ZOHO-' || i.zoho_invoice_id
    WHERE i.tenant_id <> inv.tenant_id;
    IF v_cross_tenant_checks > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: Found % cross-tenant zoho invoice instructions.', v_cross_tenant_checks;
    END IF;

    -- 4. Assert Tenant 99 remains inactive
    SELECT is_active INTO v_t99_active 
    FROM identity.tenants 
    WHERE tenant_id = '00000000-0000-0000-0000-000000000099';
    IF v_t99_active IS NOT FALSE THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: Tenant 99 must have is_active = FALSE.';
    END IF;

    -- 5. Assert platform treasury balances have tenant_id = NULL
    SELECT COUNT(*) INTO v_treasury_unowned
    FROM public.balances
    WHERE is_treasury = TRUE AND tenant_id IS NOT NULL;
    IF v_treasury_unowned > 0 THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED: Found % platform treasury balances with non-null tenant_id.', v_treasury_unowned;
    END IF;

    RAISE NOTICE '[MIGRATION 028] All post-migration integrity assertions PASSED.';
END $$;
