-- ==============================================================================
-- PROJECT FUSION — PHASE AI-2B.1: AUTHORIZATION GOVERNANCE CORRECTIONS SCHEMA
-- ==============================================================================
-- Migration: 016_rbac_governance_corrections.sql
-- Purpose:
--   1. Corrects the approved enterprise role-permission matrix:
--      - OPS_OPERATOR: payment:initiate, payment:read, evidence:read
--      - TREASURY_ANALYST (Checker): payment:approve, payment:reject, payment:read, payment:read:sensitive, treasury:read, treasury:manage
--      - COMPLIANCE_OFFICER: compliance:read, compliance:write, compliance:hold, compliance:release, payment:read, payment:read:sensitive, evidence:read
--      - SYSTEM_ADMIN: admin:manage_roles, admin:manage_operators, system:config, audit:read (zero financial visibility)
--      - AUDITOR: audit:read, evidence:read, compliance:read, treasury:read (strictly read-only)
--   2. Adds compliance hold columns to payment_approvals and instructions.
--   3. Enforces database-level Maker Immutability triggers.
--   4. Enforces database-level Audit Log Append-Only trigger.
-- ==============================================================================

-- 1. Add compliance hold tracking columns
ALTER TABLE identity.payment_approvals ADD COLUMN IF NOT EXISTS compliance_held BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE identity.payment_approvals ADD COLUMN IF NOT EXISTS compliance_held_by UUID REFERENCES identity.operators(operator_id);
ALTER TABLE identity.payment_approvals ADD COLUMN IF NOT EXISTS compliance_held_at TIMESTAMPTZ;
ALTER TABLE identity.payment_approvals ADD COLUMN IF NOT EXISTS compliance_hold_reason TEXT;
ALTER TABLE identity.payment_approvals ADD COLUMN IF NOT EXISTS compliance_released_by UUID REFERENCES identity.operators(operator_id);
ALTER TABLE identity.payment_approvals ADD COLUMN IF NOT EXISTS compliance_released_at TIMESTAMPTZ;
ALTER TABLE identity.payment_approvals ADD COLUMN IF NOT EXISTS compliance_release_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_payment_approvals_hold ON identity.payment_approvals(compliance_held) WHERE compliance_held = TRUE;

ALTER TABLE instructions ADD COLUMN IF NOT EXISTS compliance_held BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE instructions ADD COLUMN IF NOT EXISTS compliance_held_by UUID REFERENCES identity.operators(operator_id);
ALTER TABLE instructions ADD COLUMN IF NOT EXISTS compliance_held_at TIMESTAMPTZ;

-- 2. Maker Immutability Trigger on payment_approvals
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

-- 3. Maker Immutability Trigger on instructions
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

-- 4. Append-Only Trigger on identity.auth_audit_log
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

-- 5. Seed Permissions
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

-- 6. Correct Role-Permission Bindings
DELETE FROM identity.role_permissions;

WITH role_perm_mapping (r_key, p_key) AS (
    VALUES
        -- OPS_OPERATOR
        ('OPS_OPERATOR', 'payment:initiate'),
        ('OPS_OPERATOR', 'payment:read'),
        ('OPS_OPERATOR', 'evidence:read'),

        -- TREASURY_ANALYST (Checker)
        ('TREASURY_ANALYST', 'payment:approve'),
        ('TREASURY_ANALYST', 'payment:reject'),
        ('TREASURY_ANALYST', 'payment:read'),
        ('TREASURY_ANALYST', 'payment:read:sensitive'),
        ('TREASURY_ANALYST', 'treasury:read'),
        ('TREASURY_ANALYST', 'treasury:manage'),

        -- COMPLIANCE_OFFICER
        ('COMPLIANCE_OFFICER', 'compliance:read'),
        ('COMPLIANCE_OFFICER', 'compliance:write'),
        ('COMPLIANCE_OFFICER', 'compliance:hold'),
        ('COMPLIANCE_OFFICER', 'compliance:release'),
        ('COMPLIANCE_OFFICER', 'payment:read'),
        ('COMPLIANCE_OFFICER', 'payment:read:sensitive'),
        ('COMPLIANCE_OFFICER', 'evidence:read'),

        -- SYSTEM_ADMIN
        ('SYSTEM_ADMIN', 'admin:manage_roles'),
        ('SYSTEM_ADMIN', 'admin:manage_operators'),
        ('SYSTEM_ADMIN', 'audit:read'),
        ('SYSTEM_ADMIN', 'system:config'),

        -- AUDITOR
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

