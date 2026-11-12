-- ==============================================================================
-- PROJECT FUSION — PHASE AI-2B: RBAC, MAKER-CHECKER & APPROVAL SECURITY SCHEMA
-- ==============================================================================
-- Migration: 015_rbac_schema.sql
-- Purpose:
--   Creates enterprise RBAC permission tables, operator role assignments,
--   FIDO2/WebAuthn public key credentials and single-use challenges,
--   and Maker-Checker payment approval tables with database-level Four-Eyes
--   constraints and concurrency controls.
--
-- Strict Phase AI-2B Scope Boundary:
--   - Role-Based Access Control, Maker-Checker, WebAuthn ONLY.
--   - Zero tenant_id columns or tenant isolation tables (deferred to Phase AI-2C).
--   - Zero financial ledger RLS policies (deferred to Phase AI-2D).
-- ==============================================================================

CREATE SCHEMA IF NOT EXISTS identity;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------------------------
-- 1. ROLES
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity.roles (
    role_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_key VARCHAR(64) NOT NULL UNIQUE,
    role_name VARCHAR(128) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------------------------
-- 2. PERMISSIONS
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity.permissions (
    permission_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    permission_key VARCHAR(64) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------------------------
-- 3. ROLE PERMISSIONS (Many-to-Many)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity.role_permissions (
    role_id UUID NOT NULL REFERENCES identity.roles(role_id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES identity.permissions(permission_id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON identity.role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_perm ON identity.role_permissions(permission_id);

-- ------------------------------------------------------------------------------
-- 4. OPERATOR ROLE ASSIGNMENTS
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity.operator_role_assignments (
    assignment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id UUID NOT NULL REFERENCES identity.operators(operator_id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES identity.roles(role_id) ON DELETE CASCADE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    assigned_by UUID REFERENCES identity.operators(operator_id) ON DELETE SET NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    revoked_by UUID REFERENCES identity.operators(operator_id) ON DELETE SET NULL,
    CONSTRAINT uq_operator_role UNIQUE (operator_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_op_role_assignments_op ON identity.operator_role_assignments(operator_id) WHERE is_active = TRUE;

-- ------------------------------------------------------------------------------
-- 5. WEBAUTHN CREDENTIALS & CHALLENGES (FIDO2)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity.webauthn_credentials (
    credential_id VARCHAR(255) PRIMARY KEY, -- Base64URL-encoded credential ID
    operator_id UUID NOT NULL REFERENCES identity.operators(operator_id) ON DELETE CASCADE,
    public_key TEXT NOT NULL, -- PEM format public key
    counter BIGINT NOT NULL DEFAULT 0,
    transports TEXT[] DEFAULT '{}',
    aaguid VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webauthn_creds_op ON identity.webauthn_credentials(operator_id);

CREATE TABLE IF NOT EXISTS identity.webauthn_challenges (
    challenge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id UUID NOT NULL REFERENCES identity.operators(operator_id) ON DELETE CASCADE,
    challenge VARCHAR(128) NOT NULL UNIQUE,
    ceremony_type VARCHAR(32) NOT NULL, -- 'registration' | 'authentication'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_active ON identity.webauthn_challenges(challenge) WHERE consumed_at IS NULL;

-- ------------------------------------------------------------------------------
-- 6. MAKER-CHECKER PAYMENT APPROVALS
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity.payment_approvals (
    approval_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instruction_id UUID NOT NULL UNIQUE REFERENCES instructions(instruction_id) ON DELETE CASCADE,
    maker_operator_id UUID NOT NULL REFERENCES identity.operators(operator_id),
    checker_operator_id UUID REFERENCES identity.operators(operator_id),
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING_APPROVAL',
    amount NUMERIC(56, 18) NOT NULL,
    currency VARCHAR(10) NOT NULL,
    approval_notes TEXT,
    rejection_reason TEXT,
    compliance_held BOOLEAN NOT NULL DEFAULT FALSE,
    compliance_held_by UUID REFERENCES identity.operators(operator_id),
    compliance_held_at TIMESTAMPTZ,
    compliance_hold_reason TEXT,
    compliance_released_by UUID REFERENCES identity.operators(operator_id),
    compliance_released_at TIMESTAMPTZ,
    compliance_release_notes TEXT,
    step_up_method VARCHAR(32), -- 'webauthn'
    step_up_verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at TIMESTAMPTZ,
    -- CRITICAL FOUR-EYES PRINCIPLE: Maker cannot be Checker!
    CONSTRAINT chk_maker_checker_distinct CHECK (checker_operator_id IS NULL OR maker_operator_id <> checker_operator_id),
    -- Valid approval statuses
    CONSTRAINT chk_approval_status CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_payment_approvals_status ON identity.payment_approvals(status);
CREATE INDEX IF NOT EXISTS idx_payment_approvals_maker ON identity.payment_approvals(maker_operator_id);
CREATE INDEX IF NOT EXISTS idx_payment_approvals_checker ON identity.payment_approvals(checker_operator_id);
CREATE INDEX IF NOT EXISTS idx_payment_approvals_hold ON identity.payment_approvals(compliance_held) WHERE compliance_held = TRUE;

-- Alter instructions table to track approval state, operators, and compliance hold
ALTER TABLE instructions ADD COLUMN IF NOT EXISTS maker_operator_id UUID REFERENCES identity.operators(operator_id);
ALTER TABLE instructions ADD COLUMN IF NOT EXISTS checker_operator_id UUID REFERENCES identity.operators(operator_id);
ALTER TABLE instructions ADD COLUMN IF NOT EXISTS approval_status VARCHAR(32) DEFAULT 'NONE';
ALTER TABLE instructions ADD COLUMN IF NOT EXISTS compliance_held BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE instructions ADD COLUMN IF NOT EXISTS compliance_held_by UUID REFERENCES identity.operators(operator_id);
ALTER TABLE instructions ADD COLUMN IF NOT EXISTS compliance_held_at TIMESTAMPTZ;

-- ------------------------------------------------------------------------------
-- 6.1 DATABASE-LEVEL IMMUTABILITY & AUDIT TRIGGERS
-- ------------------------------------------------------------------------------

-- Maker Immutability Trigger on payment_approvals
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
        -- Prevent modifying terminal status
        IF OLD.status IN ('APPROVED', 'REJECTED', 'CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status THEN
            RAISE EXCEPTION 'Cannot modify approval in terminal state %', OLD.status;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_approvals_immutability ON identity.payment_approvals;
CREATE TRIGGER trg_payment_approvals_immutability
BEFORE UPDATE ON identity.payment_approvals
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_approval_immutability();

-- Maker Immutability Trigger on instructions
CREATE OR REPLACE FUNCTION identity.trg_enforce_instruction_maker_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.maker_operator_id IS NOT NULL AND NEW.maker_operator_id IS DISTINCT FROM OLD.maker_operator_id THEN
            RAISE EXCEPTION 'Instruction maker identity is immutable once assigned';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_instructions_maker_immutability ON instructions;
CREATE TRIGGER trg_instructions_maker_immutability
BEFORE UPDATE ON instructions
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_instruction_maker_immutability();

-- Append-Only Trigger on identity.auth_audit_log
CREATE OR REPLACE FUNCTION identity.trg_enforce_audit_log_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'identity.auth_audit_log is append-only. UPDATE and DELETE operations are strictly prohibited.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_append_only ON identity.auth_audit_log;
CREATE TRIGGER trg_audit_log_append_only
BEFORE UPDATE OR DELETE ON identity.auth_audit_log
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_audit_log_append_only();

-- ------------------------------------------------------------------------------
-- 7. SEED SYNTHETIC OPERATORS (FOR DEV/TEST)
-- ------------------------------------------------------------------------------
INSERT INTO identity.operators (operator_id, email, full_name, is_active)
VALUES
    ('00000000-0000-4000-8000-000000000001', 'dev-cfo@fusion.internal', 'Dev CFO Lead', TRUE),
    ('00000000-0000-4000-8000-000000000002', 'dev-ops@fusion.internal', 'Dev Operations Engineer', TRUE),
    ('00000000-0000-4000-8000-000000000003', 'dev-auditor@fusion.internal', 'Dev Compliance Auditor', TRUE),
    ('00000000-0000-4000-8000-000000000004', 'dev-compliance@fusion.internal', 'Dev Compliance Officer', TRUE),
    ('00000000-0000-4000-8000-000000000005', 'dev-admin@fusion.internal', 'Dev System Administrator', TRUE)
ON CONFLICT (operator_id) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 8. SEED STANDARD ROLES & PERMISSIONS
-- ------------------------------------------------------------------------------
-- Seed Permissions
INSERT INTO identity.permissions (permission_key, description) VALUES
    ('payment:initiate', 'Initiate payment instructions and treasury payouts'),
    ('payment:approve', 'Approve pending payment instructions (Checker role)'),
    ('payment:reject', 'Reject pending payment instructions (Checker role)'),
    ('payment:read', 'View payment instructions and status details'),
    ('payment:read:sensitive', 'View sensitive payment data (unmasked accounts, routing secrets)'),
    ('treasury:read', 'View treasury balances and liquidity positions'),
    ('treasury:manage', 'Manage liquidity pools and asset routing'),
    ('compliance:read', 'View KYC, AML, and sanctions screening data'),
    ('compliance:write', 'Update compliance status and sanctions flags'),
    ('compliance:hold', 'Place payment instruction on compliance hold, blocking approval'),
    ('compliance:release', 'Release compliance hold on payment instruction'),
    ('admin:manage_roles', 'Assign and revoke operator roles and permissions'),
    ('admin:manage_operators', 'Create and deactivate operator accounts'),
    ('audit:read', 'Access regulatory and immutable audit trails'),
    ('system:config', 'Manage system configuration and rail parameters'),
    ('evidence:read', 'View permitted operational and compliance evidence')
ON CONFLICT (permission_key) DO UPDATE SET description = EXCLUDED.description;

-- Seed 5 Standard Enterprise Roles
INSERT INTO identity.roles (role_key, role_name, description) VALUES
    ('OPS_OPERATOR', 'Operations Operator', 'Initiates and monitors standard operational payments'),
    ('TREASURY_ANALYST', 'Treasury Analyst', 'Four-Eyes Checker for high-value treasury operations and liquidity'),
    ('COMPLIANCE_OFFICER', 'Compliance Officer', 'Reviews sanctions/AML, enforces compliance holds and releases'),
    ('SYSTEM_ADMIN', 'System Administrator', 'Manages operators, role assignments, and system settings'),
    ('AUDITOR', 'Independent Auditor', 'Strictly read-only access to audit logs, ledger, and compliance data')
ON CONFLICT (role_key) DO UPDATE SET
    role_name = EXCLUDED.role_name,
    description = EXCLUDED.description;

-- Seed Role-Permission Bindings
WITH role_perm_mapping (r_key, p_key) AS (
    VALUES
        -- OPS_OPERATOR (Initiate, View, Evidence read) - CANNOT approve
        ('OPS_OPERATOR', 'payment:initiate'),
        ('OPS_OPERATOR', 'payment:read'),
        ('OPS_OPERATOR', 'evidence:read'),

        -- TREASURY_ANALYST (Checker: Approve, Reject, View, Sensitive read, Treasury read/manage) - CANNOT initiate
        ('TREASURY_ANALYST', 'payment:approve'),
        ('TREASURY_ANALYST', 'payment:reject'),
        ('TREASURY_ANALYST', 'payment:read'),
        ('TREASURY_ANALYST', 'payment:read:sensitive'),
        ('TREASURY_ANALYST', 'treasury:read'),
        ('TREASURY_ANALYST', 'treasury:manage'),

        -- COMPLIANCE_OFFICER (Compliance read/write/hold/release, Payment read, Sensitive read, Evidence read) - CANNOT approve payments
        ('COMPLIANCE_OFFICER', 'compliance:read'),
        ('COMPLIANCE_OFFICER', 'compliance:write'),
        ('COMPLIANCE_OFFICER', 'compliance:hold'),
        ('COMPLIANCE_OFFICER', 'compliance:release'),
        ('COMPLIANCE_OFFICER', 'payment:read'),
        ('COMPLIANCE_OFFICER', 'payment:read:sensitive'),
        ('COMPLIANCE_OFFICER', 'evidence:read'),

        -- SYSTEM_ADMIN (Role management, Operator management, Audit read, System config) - ZERO financial visibility
        ('SYSTEM_ADMIN', 'admin:manage_roles'),
        ('SYSTEM_ADMIN', 'admin:manage_operators'),
        ('SYSTEM_ADMIN', 'audit:read'),
        ('SYSTEM_ADMIN', 'system:config'),

        -- AUDITOR (Strictly Read-Only across audit, evidence, compliance, treasury) - ZERO mutating permissions
        ('AUDITOR', 'audit:read'),
        ('AUDITOR', 'evidence:read'),
        ('AUDITOR', 'compliance:read'),
        ('AUDITOR', 'treasury:read')
)
INSERT INTO identity.role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM role_perm_mapping rpm
JOIN identity.roles r ON r.role_key = rpm.r_key
JOIN identity.permissions p ON p.permission_key = rpm.p_key
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Seed synthetic operator role assignments (for dev/test environments)
INSERT INTO identity.operator_role_assignments (operator_id, role_id)
SELECT o.operator_id, r.role_id
FROM (
    VALUES
        ('00000000-0000-4000-8000-000000000001'::uuid, 'TREASURY_ANALYST'),
        ('00000000-0000-4000-8000-000000000002'::uuid, 'OPS_OPERATOR'),
        ('00000000-0000-4000-8000-000000000003'::uuid, 'AUDITOR'),
        ('00000000-0000-4000-8000-000000000004'::uuid, 'COMPLIANCE_OFFICER'),
        ('00000000-0000-4000-8000-000000000005'::uuid, 'SYSTEM_ADMIN')
) AS v(op_id, r_key)
JOIN identity.operators o ON o.operator_id = v.op_id
JOIN identity.roles r ON r.role_key = v.r_key
ON CONFLICT (operator_id, role_id) DO UPDATE SET is_active = TRUE;

