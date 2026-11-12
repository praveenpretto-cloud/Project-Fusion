-- =============================================================================
-- CashIQ × Nexus — Core Schema Extension
-- Migration: 001_cashiq_core.sql
-- Run with: psql -d fusion_db -f db/migrations/001_cashiq_core.sql
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- CA PROFILES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ca_profiles (
    ca_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name               VARCHAR(255) NOT NULL,
    membership_number  VARCHAR(50),
    email              VARCHAR(255) UNIQUE NOT NULL,
    phone              VARCHAR(20),
    firm_name          VARCHAR(255),
    city               VARCHAR(100),
    created_at         TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- BUSINESSES (SME profiles)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS businesses (
    business_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name               VARCHAR(255) NOT NULL,
    gstin              VARCHAR(20) UNIQUE,
    incorporation_type VARCHAR(50),   -- PVT_LTD, PARTNERSHIP, PROPRIETORSHIP, LLP
    industry           VARCHAR(100),
    city               VARCHAR(100),
    ca_id              UUID REFERENCES ca_profiles(ca_id),
    onboarded_at       TIMESTAMP DEFAULT NOW(),
    updated_at         TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- AA CONSENTS (stub — full integration after FIU registration)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS aa_consents (
    consent_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      UUID NOT NULL REFERENCES businesses(business_id),
    aa_handle        VARCHAR(255),        -- AA provider handle (Setu/Finvu — deferred)
    fip_ids          JSONB DEFAULT '[]',  -- List of FIP institution IDs consented
    consent_status   VARCHAR(30) DEFAULT 'STUB',  -- STUB, ACTIVE, EXPIRED, REVOKED
    consent_expiry   TIMESTAMP,
    raw_artefact     JSONB DEFAULT '{}',  -- Full consent JSON from AA (empty until live)
    created_at       TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- BUSINESS BANK ACCOUNTS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_bank_accounts (
    account_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           UUID NOT NULL REFERENCES businesses(business_id),
    bank_name             VARCHAR(100) NOT NULL,
    account_number_masked VARCHAR(20),
    account_type          VARCHAR(20) DEFAULT 'CURRENT',  -- CURRENT, SAVINGS, OD, CC
    data_source           VARCHAR(30) NOT NULL DEFAULT 'MANUAL',  -- AA_CONSENT, MANUAL
    aa_consent_id         UUID REFERENCES aa_consents(consent_id),
    is_active             BOOLEAN DEFAULT TRUE,
    last_synced_at        TIMESTAMP,
    od_limit              NUMERIC(15, 2) DEFAULT 2000000.00,
    created_at            TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- BANK TRANSACTIONS (normalised time-series)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_transactions (
    txn_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id           UUID NOT NULL REFERENCES business_bank_accounts(account_id),
    business_id          UUID NOT NULL REFERENCES businesses(business_id),
    txn_date             DATE NOT NULL,
    value_date           DATE,
    amount               DECIMAL(20, 2) NOT NULL,
    direction            VARCHAR(10) NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
    narration            TEXT,
    category             VARCHAR(50) DEFAULT 'UNKNOWN',
    -- SALARY | GST_PAYMENT | VENDOR_PAYMENT | CUSTOMER_RECEIPT
    -- EMI_REPAYMENT | TAX_PAYMENT | TRANSFER_INTERNAL | UNKNOWN
    category_confidence  VARCHAR(10) DEFAULT 'LOW',  -- HIGH | MEDIUM | LOW
    balance_after        DECIMAL(20, 2),
    data_source          VARCHAR(30) DEFAULT 'MANUAL',
    raw_json             JSONB DEFAULT '{}',
    imported_at          TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_txns_business_date
    ON bank_transactions(business_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_txns_account
    ON bank_transactions(account_id, txn_date DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- OBLIGATIONS (upcoming payments / dues)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS obligations (
    obligation_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      UUID NOT NULL REFERENCES businesses(business_id),
    obligation_type  VARCHAR(50) NOT NULL,
    -- GST_FILING | GST_PAYMENT | EMI | INVOICE_DUE | SALARY | TDS | ADVANCE_TAX | VENDOR_PAYMENT
    description      TEXT,
    due_date         DATE NOT NULL,
    amount           DECIMAL(20, 2),
    currency         VARCHAR(10) DEFAULT 'INR',
    status           VARCHAR(20) DEFAULT 'UPCOMING',  -- UPCOMING | PAID | OVERDUE
    source           VARCHAR(30),   -- ZOHO | MANUAL | GSTN_STUB
    source_ref       VARCHAR(255),  -- Zoho invoice ID or external ref
    created_at       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_obligations_business_due
    ON obligations(business_id, due_date);

-- ─────────────────────────────────────────────────────────────────────────────
-- ALERT RULES (per-business configurable thresholds)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_rules (
    rule_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      UUID NOT NULL REFERENCES businesses(business_id),
    rule_type        VARCHAR(50) NOT NULL,
    -- LOW_BALANCE | LARGE_DEBIT | OVERDUE_INVOICE | UPCOMING_GST | UPCOMING_EMI
    threshold_value  DECIMAL(20, 2),   -- e.g. balance < 50000
    threshold_days   INTEGER,          -- e.g. due within 3 days
    is_active        BOOLEAN DEFAULT TRUE,
    created_at       TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- ALERT EVENTS (CashSentinel triggered log)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_events (
    event_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    UUID NOT NULL REFERENCES businesses(business_id),
    rule_id        UUID REFERENCES alert_rules(rule_id),
    severity       VARCHAR(10) NOT NULL CHECK (severity IN ('HIGH', 'MEDIUM', 'LOW')),
    title          VARCHAR(255) NOT NULL,
    message        TEXT NOT NULL,
    is_read        BOOLEAN DEFAULT FALSE,
    triggered_at   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_events_business
    ON alert_events(business_id, triggered_at DESC);


-- =============================================================================
-- SEED DATA — Two sample SMEs for immediate dashboard testing
-- =============================================================================

-- CA Profile
INSERT INTO ca_profiles (ca_id, name, membership_number, email, firm_name, city)
VALUES (
    '11111111-1111-1111-1111-111111111111',
    'Priya Ramaswamy',
    'FCA-049231',
    'priya.rca@example.com',
    'Ramaswamy & Associates',
    'Coimbatore'
) ON CONFLICT (email) DO NOTHING;

-- Business 1: Manufacturing SME
INSERT INTO businesses (business_id, name, gstin, incorporation_type, industry, city, ca_id)
VALUES (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'Coimbatore Textile Mills Pvt Ltd',
    '33AABCC1234D1Z5',
    'PVT_LTD',
    'Textile Manufacturing',
    'Coimbatore',
    '11111111-1111-1111-1111-111111111111'
) ON CONFLICT (gstin) DO NOTHING;

-- Business 2: IT Services SME
INSERT INTO businesses (business_id, name, gstin, incorporation_type, industry, city, ca_id)
VALUES (
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'TechVista Solutions LLP',
    '33AATV9876E1Z2',
    'LLP',
    'IT Services',
    'Chennai',
    '11111111-1111-1111-1111-111111111111'
) ON CONFLICT (gstin) DO NOTHING;

-- Bank accounts for Business 1
INSERT INTO business_bank_accounts (account_id, business_id, bank_name, account_number_masked, account_type, data_source, last_synced_at)
VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'HDFC Bank', 'XXXX-XXXX-4521', 'CURRENT', 'MANUAL', NOW()),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaac', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ICICI Bank', 'XXXX-XXXX-8873', 'OD', 'MANUAL', NOW())
ON CONFLICT DO NOTHING;

-- Bank accounts for Business 2
INSERT INTO business_bank_accounts (account_id, business_id, bank_name, account_number_masked, account_type, data_source, last_synced_at)
VALUES
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'SBI', 'XXXX-XXXX-2210', 'CURRENT', 'MANUAL', NOW()),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbd', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Axis Bank', 'XXXX-XXXX-6641', 'SAVINGS', 'MANUAL', NOW())
ON CONFLICT DO NOTHING;

-- Sample transactions for Business 1 (last 45 days)
INSERT INTO bank_transactions (account_id, business_id, txn_date, amount, direction, narration, category, category_confidence, balance_after) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 44, 850000.00, 'CREDIT', 'NEFT-PAYMENT FROM RELIANCE IND LTD', 'CUSTOMER_RECEIPT', 'HIGH', 1250000.00),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 40, 285000.00, 'DEBIT', 'SALARY DISBURSEMENT OCT 2026', 'SALARY', 'HIGH', 965000.00),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 38, 142000.00, 'DEBIT', 'VENDOR PAYMENT DHARMA FABRICS', 'VENDOR_PAYMENT', 'HIGH', 823000.00),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 35, 68000.00, 'DEBIT', 'GST PAYMENT CGST Q3', 'GST_PAYMENT', 'HIGH', 755000.00),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 30, 620000.00, 'CREDIT', 'RTGS FROM TATA TEXTILES PVT LTD', 'CUSTOMER_RECEIPT', 'HIGH', 1375000.00),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 28, 185000.00, 'DEBIT', 'RAW MATERIAL VENDOR PAYMENT', 'VENDOR_PAYMENT', 'HIGH', 1190000.00),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 25, 95000.00, 'DEBIT', 'EMI HDFC TERM LOAN OCT 2026', 'EMI_REPAYMENT', 'HIGH', 1095000.00),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 22, 320000.00, 'CREDIT', 'PAYMENT FROM ARVIND MILLS', 'CUSTOMER_RECEIPT', 'HIGH', 1415000.00),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 20, 285000.00, 'DEBIT', 'SALARY DISBURSEMENT NOV 2026', 'SALARY', 'HIGH', 1130000.00),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 18, 78000.00, 'DEBIT', 'TDS PAYMENT Q2 NSDL', 'TDS', 'HIGH', 1052000.00),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 15, 480000.00, 'CREDIT', 'NEFT FROM KUMAR EXPORT HOUSE', 'CUSTOMER_RECEIPT', 'HIGH', 1532000.00),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 12, 210000.00, 'DEBIT', 'SUPPLIER PAYMENT KRISHNA YARNS', 'VENDOR_PAYMENT', 'HIGH', 1322000.00),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 10, 95000.00, 'DEBIT', 'EMI ICICI MACHINE LOAN', 'EMI_REPAYMENT', 'HIGH', 1227000.00),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 8,  250000.00, 'CREDIT', 'PAYMENT RECEIVED FROM BOMBAY DYEING', 'CUSTOMER_RECEIPT', 'HIGH', 1477000.00),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 5,  72000.00, 'DEBIT', 'GSTIN 33AABCC1234D1Z5 GST PAYMENT', 'GST_PAYMENT', 'HIGH', 1405000.00),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 3,  165000.00, 'DEBIT', 'VENDOR MAHESH LOOM SUPPLIES', 'VENDOR_PAYMENT', 'MEDIUM', 1240000.00),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 1,  380000.00, 'CREDIT', 'RTGS PAYMENT FROM EXPORT CLIENT A', 'CUSTOMER_RECEIPT', 'HIGH', 1620000.00),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaac', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 15, 500000.00, 'CREDIT', 'OD DRAWDOWN ICICI BANK', 'TRANSFER_INTERNAL', 'HIGH', 500000.00),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaac', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', CURRENT_DATE - 10, 200000.00, 'DEBIT', 'PARTIAL OD REPAYMENT', 'EMI_REPAYMENT', 'MEDIUM', 300000.00);

-- Sample transactions for Business 2
INSERT INTO bank_transactions (account_id, business_id, txn_date, amount, direction, narration, category, category_confidence, balance_after) VALUES
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', CURRENT_DATE - 42, 430000.00, 'CREDIT', 'NEFT FROM INFOSYS BPO INV 2201', 'CUSTOMER_RECEIPT', 'HIGH', 830000.00),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', CURRENT_DATE - 38, 145000.00, 'DEBIT', 'SALARY PAYMENT STAFF NOV 2026', 'SALARY', 'HIGH', 685000.00),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', CURRENT_DATE - 35, 52000.00, 'DEBIT', 'AWS INDIA OPC PVT LTD CLOUD INFRA', 'VENDOR_PAYMENT', 'MEDIUM', 633000.00),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', CURRENT_DATE - 30, 38000.00, 'DEBIT', 'GST PAYMENT 33AATV9876E1Z2', 'GST_PAYMENT', 'HIGH', 595000.00),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', CURRENT_DATE - 25, 280000.00, 'CREDIT', 'INV-2202 PAYMENT TCS INNOVATION', 'CUSTOMER_RECEIPT', 'HIGH', 875000.00),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', CURRENT_DATE - 20, 145000.00, 'DEBIT', 'SALARY DEC 2026', 'SALARY', 'HIGH', 730000.00),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', CURRENT_DATE - 15, 22500.00, 'DEBIT', 'TDS Q3 INCOME TAX DEPT', 'TDS', 'HIGH', 707500.00),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', CURRENT_DATE - 10, 320000.00, 'CREDIT', 'WIPRO PAYMENT INV-2203', 'CUSTOMER_RECEIPT', 'HIGH', 1027500.00),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', CURRENT_DATE - 7,  145000.00, 'DEBIT', 'SALARY ADVANCE DEC 2026', 'SALARY', 'HIGH', 882500.00),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', CURRENT_DATE - 4,  48000.00, 'DEBIT', 'GSTIN PAYMENT SGST IGST', 'GST_PAYMENT', 'HIGH', 834500.00),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', CURRENT_DATE - 2,  185000.00, 'CREDIT', 'HCL TECH PAYMENT INV-2204', 'CUSTOMER_RECEIPT', 'HIGH', 1019500.00);

-- Obligations for Business 1
INSERT INTO obligations (business_id, obligation_type, description, due_date, amount, currency, status, source) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'GST_PAYMENT',   'GSTR-3B Monthly Payment', CURRENT_DATE + 17, 72000.00,  'INR', 'UPCOMING', 'GSTN_STUB'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'EMI',           'HDFC Term Loan EMI',       CURRENT_DATE + 5,  95000.00,  'INR', 'UPCOMING', 'MANUAL'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'EMI',           'ICICI Machinery Loan EMI', CURRENT_DATE + 20, 95000.00,  'INR', 'UPCOMING', 'MANUAL'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'SALARY',        'Staff Salary December',    CURRENT_DATE + 28, 285000.00, 'INR', 'UPCOMING', 'MANUAL'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INVOICE_DUE',   'Dharma Fabrics INV-112',   CURRENT_DATE + 3,  142000.00, 'INR', 'UPCOMING', 'ZOHO'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'INVOICE_DUE',   'Overdue — Krishna Yarns',  CURRENT_DATE - 8,  210000.00, 'INR', 'OVERDUE',  'ZOHO'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'TDS',           'TDS Q3 Advance Tax',       CURRENT_DATE + 12, 78000.00,  'INR', 'UPCOMING', 'MANUAL'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'GST_FILING',    'GSTR-1 Filing Deadline',   CURRENT_DATE + 8,  0.00,      'INR', 'UPCOMING', 'GSTN_STUB');

-- Obligations for Business 2
INSERT INTO obligations (business_id, obligation_type, description, due_date, amount, currency, status, source) VALUES
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'GST_PAYMENT',   'GSTR-3B Monthly',          CURRENT_DATE + 17, 48000.00,  'INR', 'UPCOMING', 'GSTN_STUB'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'SALARY',        'Staff Salary December',    CURRENT_DATE + 28, 145000.00, 'INR', 'UPCOMING', 'MANUAL'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'VENDOR_PAYMENT','AWS Cloud Invoice Dec',    CURRENT_DATE + 6,  52000.00,  'INR', 'UPCOMING', 'ZOHO'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'TDS',           'TDS Q3 Filing',            CURRENT_DATE + 12, 22500.00,  'INR', 'UPCOMING', 'MANUAL'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'GST_FILING',    'GSTR-1 Filing Deadline',   CURRENT_DATE + 8,  0.00,      'INR', 'UPCOMING', 'GSTN_STUB');

-- Alert rules for Business 1
INSERT INTO alert_rules (business_id, rule_type, threshold_value, threshold_days, is_active) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'LOW_BALANCE',      500000.00, NULL, TRUE),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'LARGE_DEBIT',      NULL,      NULL, TRUE),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'UPCOMING_GST',     NULL,      3,    TRUE),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'UPCOMING_EMI',     NULL,      5,    TRUE),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'OVERDUE_INVOICE',  NULL,      NULL, TRUE);

-- Alert rules for Business 2
INSERT INTO alert_rules (business_id, rule_type, threshold_value, threshold_days, is_active) VALUES
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'LOW_BALANCE',      300000.00, NULL, TRUE),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'UPCOMING_GST',     NULL,      3,    TRUE),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'OVERDUE_INVOICE',  NULL,      NULL, TRUE);

-- Sample alert events (pre-seeded)
INSERT INTO alert_events (business_id, severity, title, message, is_read) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'HIGH',   'Overdue Invoice — Krishna Yarns',     'Invoice of ₹2,10,000 to Krishna Yarns is 8 days overdue. Follow up immediately.', FALSE),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'MEDIUM', 'EMI Due in 5 Days',                   'HDFC Term Loan EMI of ₹95,000 is due on ' || (CURRENT_DATE + 5)::TEXT || '. Ensure sufficient balance.', FALSE),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'MEDIUM', 'Invoice Payment Due in 3 Days',       'Dharma Fabrics invoice (₹1,42,000) is due in 3 days.', FALSE),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'LOW',    'GST Filing Deadline in 8 Days',       'GSTR-1 filing due in 8 days. Ensure all outward supply data is reconciled.', TRUE);
