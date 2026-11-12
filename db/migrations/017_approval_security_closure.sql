-- ==============================================================================
-- PROJECT FUSION — PHASE AI-2B.2: FINAL APPROVAL SECURITY CLOSURE SCHEMA
-- ==============================================================================
-- Migration: 017_approval_security_closure.sql
-- Purpose:
--   1. WebAuthn Payment Context Binding:
--      - Adds context_digest, context_data, and instruction_id to identity.webauthn_challenges.
--      - Adds version, environment, destination_account to instructions.
--      - Adds instruction_version and context_digest to identity.payment_approvals.
--   2. Strengthened Payment Immutability:
--      - Database trigger freezing material payment details on instructions while in
--        PENDING_APPROVAL or APPROVED unless version is incremented and approval cancelled.
--   3. Audit Log Immutability Hardening:
--      - Statement-level BEFORE TRUNCATE trigger on identity.auth_audit_log.
--      - Dedicated non-login audit table owner role (fusion_audit_owner).
--      - Least-privilege roles (fusion_app_runtime, fusion_auditor) with revoked
--        UPDATE, DELETE, TRUNCATE.
--   4. Dual Control for Privileged Role Assignments:
--      - Creates identity.role_change_requests for sensitive roles (SYSTEM_ADMIN,
--        TREASURY_ANALYST, COMPLIANCE_OFFICER) with check constraint enforcing
--        requesting_operator_id <> approving_operator_id.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. WEBAUTHN PAYMENT CONTEXT BINDING COLUMNS
-- ------------------------------------------------------------------------------

-- Instructions table columns for version, environment, and destination account
ALTER TABLE instructions ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE instructions ADD COLUMN IF NOT EXISTS environment VARCHAR(32) NOT NULL DEFAULT 'sandbox';
ALTER TABLE instructions ADD COLUMN IF NOT EXISTS destination_account VARCHAR(255);

-- WebAuthn challenges context binding
ALTER TABLE identity.webauthn_challenges ADD COLUMN IF NOT EXISTS context_digest VARCHAR(64);
ALTER TABLE identity.webauthn_challenges ADD COLUMN IF NOT EXISTS context_data JSONB;
ALTER TABLE identity.webauthn_challenges ADD COLUMN IF NOT EXISTS instruction_id UUID REFERENCES instructions(instruction_id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_inst ON identity.webauthn_challenges(instruction_id);

-- Payment approvals version & context binding
ALTER TABLE identity.payment_approvals ADD COLUMN IF NOT EXISTS instruction_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE identity.payment_approvals ADD COLUMN IF NOT EXISTS context_digest VARCHAR(64);

-- ------------------------------------------------------------------------------
-- 2. STRENGTHENED PAYMENT IMMUTABILITY TRIGGER
-- ------------------------------------------------------------------------------
-- Freezes material payment fields (amount, currency, recipient, destination_account,
-- provider, environment) while in PENDING_APPROVAL or APPROVED.
-- Material amendment is ONLY allowed if version is strictly incremented and
-- approval status is reset/cancelled.
CREATE OR REPLACE FUNCTION identity.trg_enforce_instruction_material_freeze()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Check if instruction is currently under review or already approved
        IF OLD.state IN ('PENDING_APPROVAL', 'APPROVED') OR OLD.approval_status IN ('PENDING_APPROVAL', 'APPROVED') THEN
            -- Check if any material field changed
            IF (NEW.amount IS DISTINCT FROM OLD.amount) OR
               (NEW.currency IS DISTINCT FROM OLD.currency) OR
               (NEW.recipient IS DISTINCT FROM OLD.recipient) OR
               (NEW.destination_account IS DISTINCT FROM OLD.destination_account) OR
               (NEW.provider IS DISTINCT FROM OLD.provider) OR
               (NEW.environment IS DISTINCT FROM OLD.environment) THEN

                -- Material amendments require:
                -- 1. version is strictly incremented (NEW.version = OLD.version + 1)
                -- 2. approval status is reset/cancelled
                IF NOT (NEW.version = OLD.version + 1 AND (NEW.approval_status = 'CANCELLED' OR NEW.state IN ('CANCELLED', 'INITIATED'))) THEN
                    RAISE EXCEPTION 'Material payment fields (amount, currency, recipient, destination_account, provider, environment) cannot be altered while in PENDING_APPROVAL or APPROVED without version increment and approval cancellation';
                END IF;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_instructions_material_freeze ON instructions;
CREATE TRIGGER trg_instructions_material_freeze
BEFORE UPDATE ON instructions
FOR EACH ROW EXECUTE FUNCTION identity.trg_enforce_instruction_material_freeze();

-- ------------------------------------------------------------------------------
-- 3. AUDIT LOG IMMUTABILITY: STATEMENT-LEVEL TRUNCATE TRIGGER & ROLE PRIVILEGES
-- ------------------------------------------------------------------------------

-- Statement-level BEFORE TRUNCATE trigger preventing table truncation
CREATE OR REPLACE FUNCTION identity.trg_enforce_audit_log_no_truncate()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'identity.auth_audit_log cannot be truncated. Audit trail is strictly immutable.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_truncate ON identity.auth_audit_log;
CREATE TRIGGER trg_audit_log_truncate
BEFORE TRUNCATE ON identity.auth_audit_log
FOR EACH STATEMENT EXECUTE FUNCTION identity.trg_enforce_audit_log_no_truncate();

-- Dedicated least-privilege roles for audit governance
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fusion_audit_owner') THEN
        CREATE ROLE fusion_audit_owner NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fusion_app_runtime') THEN
        CREATE ROLE fusion_app_runtime NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fusion_auditor') THEN
        CREATE ROLE fusion_auditor NOLOGIN;
    END IF;
END
$$;

-- Transfer table ownership to non-login audit owner
ALTER TABLE identity.auth_audit_log OWNER TO fusion_audit_owner;

-- Revoke destructive permissions from public and application roles
REVOKE UPDATE, DELETE, TRUNCATE ON identity.auth_audit_log FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON identity.auth_audit_log FROM fusion_app_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON identity.auth_audit_log FROM fusion_auditor;

-- Least privilege: App runtime can only INSERT (append) and SELECT
GRANT INSERT, SELECT ON identity.auth_audit_log TO fusion_app_runtime;

-- Auditor role can strictly read (SELECT)
GRANT SELECT ON identity.auth_audit_log TO fusion_auditor;

-- ------------------------------------------------------------------------------
-- 4. DUAL CONTROL FOR PRIVILEGED ROLE ASSIGNMENTS
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identity.role_change_requests (
    request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requesting_operator_id UUID NOT NULL REFERENCES identity.operators(operator_id),
    target_operator_id UUID NOT NULL REFERENCES identity.operators(operator_id),
    role_key VARCHAR(64) NOT NULL REFERENCES identity.roles(role_key),
    action VARCHAR(16) NOT NULL CHECK (action IN ('ASSIGN', 'REVOKE')),
    reason TEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    approving_operator_id UUID REFERENCES identity.operators(operator_id),
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at TIMESTAMPTZ,
    -- FOUR-EYES DUAL CONTROL: Requesting operator CANNOT be the approving operator!
    CONSTRAINT chk_dual_control_distinct_operators CHECK (approving_operator_id IS NULL OR requesting_operator_id <> approving_operator_id)
);

CREATE INDEX IF NOT EXISTS idx_role_change_status ON identity.role_change_requests(status);
CREATE INDEX IF NOT EXISTS idx_role_change_target ON identity.role_change_requests(target_operator_id);
CREATE INDEX IF NOT EXISTS idx_role_change_requester ON identity.role_change_requests(requesting_operator_id);

