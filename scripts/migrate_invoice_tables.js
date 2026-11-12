'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * INVOICE TABLES MIGRATION
 * Project Fusion — GIFT City IFSC Invoice Processor DB Schema
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Creates two NEW tables only — zero changes to existing tables.
 * Safe to run multiple times (idempotent via IF NOT EXISTS).
 *
 * New Tables:
 *  - invoices           : Normalised invoice store with ISO 20022 enrichment
 *  - invoice_saga_steps : Audit trail of invoice payment milestone steps
 *
 * Run with: node scripts/migrate_invoice_tables.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Client } = require('pg');

const dbConfig = {
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'fusion_db',
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432'),
};

const MIGRATIONS = [
    {
        name: 'CREATE invoices TABLE',
        sql: `
        CREATE TABLE IF NOT EXISTS invoices (
            invoice_id          VARCHAR(100)    PRIMARY KEY,
            saga_id             VARCHAR(100),
            invoice_date        DATE,
            due_date            DATE,
            total_amount        DECIMAL(20, 4),
            currency            VARCHAR(10),
            seller_name         VARCHAR(255),
            seller_gst_pan      VARCHAR(100),
            buyer_name          VARCHAR(255),
            payment_terms_days  INTEGER         DEFAULT 90,
            -- Full ISO 20022 enriched object: pacs.008 envelope, remittance info, FEMA flags
            iso_enriched        JSONB           DEFAULT '{}',
            -- Full saga config: steps, instructions, escrow flags
            saga_config         JSONB           DEFAULT '{}',
            raw_conditions      TEXT,
            -- Invoice state machine: PARSED → PENDING_APPROVAL → IN_PROGRESS → SETTLED | FAILED
            state               VARCHAR(50)     DEFAULT 'PARSED',
            -- Source: 'csv', 'pdf', 'object'
            source_type         VARCHAR(20)     DEFAULT 'object',
            created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
        );`,
    },
    {
        name: 'CREATE INDEX ON invoices(saga_id)',
        sql: `CREATE INDEX IF NOT EXISTS idx_invoices_saga_id ON invoices (saga_id);`,
    },
    {
        name: 'CREATE INDEX ON invoices(state)',
        sql: `CREATE INDEX IF NOT EXISTS idx_invoices_state ON invoices (state);`,
    },
    {
        name: 'CREATE invoice_saga_steps TABLE',
        sql: `
        CREATE TABLE IF NOT EXISTS invoice_saga_steps (
            id              SERIAL          PRIMARY KEY,
            invoice_id      VARCHAR(100)    REFERENCES invoices(invoice_id) ON DELETE CASCADE,
            step_id         VARCHAR(100)    NOT NULL,
            amount_pct      DECIMAL(5, 2),
            condition       VARCHAR(255),
            rail            VARCHAR(50),
            -- Step state: PENDING → IN_PROGRESS → COMPLETED | FAILED | ROLLED_BACK
            status          VARCHAR(50)     DEFAULT 'PENDING',
            -- GIFT IFSC PSR 2024: flags conditional holds requiring IBU escrow activity
            escrow_flagged  BOOLEAN         DEFAULT FALSE,
            created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
            completed_at    TIMESTAMPTZ,
            UNIQUE(invoice_id, step_id)
        );`,
    },
    {
        name: 'CREATE INDEX ON invoice_saga_steps(invoice_id)',
        sql: `CREATE INDEX IF NOT EXISTS idx_invoice_saga_steps_invoice_id ON invoice_saga_steps (invoice_id);`,
    },
    {
        name: 'CREATE INDEX ON invoice_saga_steps(status)',
        sql: `CREATE INDEX IF NOT EXISTS idx_invoice_saga_steps_status ON invoice_saga_steps (status);`,
    },
];

async function runMigrations() {
    const client = new Client(dbConfig);

    console.log('\n[MIGRATE] Connecting to database...');
    await client.connect();
    console.log(`[MIGRATE] ✅ Connected to ${dbConfig.database} at ${dbConfig.host}:${dbConfig.port}`);

    console.log('\n[MIGRATE] Running invoice table migrations (additive only — no existing tables altered)...\n');

    let successCount = 0;
    let failCount = 0;

    for (const migration of MIGRATIONS) {
        try {
            await client.query(migration.sql);
            console.log(`[MIGRATE] ✅ ${migration.name}`);
            successCount++;
        } catch (err) {
            console.error(`[MIGRATE] ❌ FAILED: ${migration.name}`);
            console.error(`           Error: ${err.message}`);
            failCount++;
        }
    }

    console.log(`\n[MIGRATE] Migration complete: ${successCount} succeeded, ${failCount} failed`);

    if (failCount === 0) {
        console.log('\n[MIGRATE] ✅ All invoice tables created successfully.');
        console.log('[MIGRATE] Tables created:');
        console.log('  → invoices            (normalised invoice store)');
        console.log('  → invoice_saga_steps  (milestone step audit trail)');
        console.log('\n[MIGRATE] Next steps:');
        console.log('  1. Start server: node server.js');
        console.log('  2. POST /api/invoice/process with an invoice object');
        console.log('  3. POST /api/instruction/approve to trigger settlement\n');
    } else {
        console.error(`\n[MIGRATE] ⚠️  ${failCount} migration(s) failed. Review errors above.\n`);
        process.exit(1);
    }

    await client.end();
    process.exit(0);
}

runMigrations().catch(err => {
    console.error('[MIGRATE] Fatal error:', err.message);
    process.exit(1);
});
