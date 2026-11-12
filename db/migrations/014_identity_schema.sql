-- ==============================================================================
-- PROJECT FUSION — PHASE AI-2A: IDENTITY & OPERATOR SESSION MANAGEMENT SCHEMA
-- ==============================================================================
-- Migration: 014_identity_schema.sql
-- Purpose:
--   Creates dedicated 'identity' schema for enterprise OIDC federation,
--   operator principal management, server-side revocable session storage,
--   short-lived PKCE authentication transactions, and immutable audit logging.
--
-- Strict Phase AI-2A Scope Boundary:
--   - Identity and session management ONLY.
--   - Zero tenant_id columns or tenant memberships (deferred to Phase AI-2B/2C).
--   - Zero financial table modifications or RLS policies (deferred to Phase AI-2D).
-- ==============================================================================

CREATE SCHEMA IF NOT EXISTS identity;

-- Enable UUID extension if not already present
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------------------------
-- 1. OPERATORS
-- ------------------------------------------------------------------------------
-- Represents human operators (treasury managers, compliance officers, developers).
-- Note: Email is NOT used as the primary identity key; internal UUID is immutable.
CREATE TABLE IF NOT EXISTS identity.operators (
    operator_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    full_name VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------------------------
-- 2. OPERATOR IDENTITIES (Federated Identity Mapping)
-- ------------------------------------------------------------------------------
-- Maps an operator to an external enterprise IdP subject.
-- Immutable identity key is strictly (issuer, subject).
CREATE TABLE IF NOT EXISTS identity.operator_identities (
    identity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id UUID NOT NULL REFERENCES identity.operators(operator_id) ON DELETE CASCADE,
    issuer VARCHAR(255) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    idp_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_operator_identities_iss_sub UNIQUE (issuer, subject)
);

CREATE INDEX IF NOT EXISTS idx_operator_identities_iss_sub 
    ON identity.operator_identities (issuer, subject);

CREATE INDEX IF NOT EXISTS idx_operator_identities_operator 
    ON identity.operator_identities (operator_id);

-- ------------------------------------------------------------------------------
-- 3. OPERATOR SESSIONS
-- ------------------------------------------------------------------------------
-- Stores backend-managed session records.
-- CRITICAL SECURITY: Never stores raw session tokens. Only 256-bit SHA-256 token_hash.
CREATE TABLE IF NOT EXISTS identity.operator_sessions (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    csrf_token_hash VARCHAR(64),
    operator_id UUID NOT NULL REFERENCES identity.operators(operator_id) ON DELETE CASCADE,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    idle_expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '15 minutes',
    revoked_at TIMESTAMPTZ,
    revocation_reason VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_operator_sessions_token_hash 
    ON identity.operator_sessions (token_hash) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_operator_sessions_operator 
    ON identity.operator_sessions (operator_id);

CREATE INDEX IF NOT EXISTS idx_operator_sessions_expires 
    ON identity.operator_sessions (expires_at);

-- ------------------------------------------------------------------------------
-- 4. AUTHENTICATION TRANSACTIONS (PKCE & OIDC State Handshake)
-- ------------------------------------------------------------------------------
-- Short-lived state records ensuring single-use, replay-resistant OIDC authorization.
-- CRITICAL SECURITY: code_verifier is encrypted with AES-256-GCM before persistence.
CREATE TABLE IF NOT EXISTS identity.authentication_transactions (
    transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    state VARCHAR(64) NOT NULL UNIQUE,
    nonce VARCHAR(64) NOT NULL,
    encrypted_code_verifier TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_auth_transactions_state 
    ON identity.authentication_transactions (state) WHERE used_at IS NULL;

-- ------------------------------------------------------------------------------
-- 5. AUTHENTICATION AUDIT LOG
-- ------------------------------------------------------------------------------
-- Immutable append-only audit trail for authentication, session, and security events.
CREATE TABLE IF NOT EXISTS identity.auth_audit_log (
    audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(64) NOT NULL,
    operator_id UUID REFERENCES identity.operators(operator_id) ON DELETE SET NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_operator 
    ON identity.auth_audit_log (operator_id, created_at);

CREATE INDEX IF NOT EXISTS idx_auth_audit_created 
    ON identity.auth_audit_log (created_at);

