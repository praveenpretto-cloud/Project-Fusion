'use strict';

const { Pool } = require('pg');

async function runExpandedTests(dbName) {
    const superPool = new Pool({
        user: 'postgres',
        host: 'localhost',
        database: dbName,
        port: 5432,
    });

    const runtimePool = new Pool({
        user: 'fusion_app_runtime',
        host: 'localhost',
        database: dbName,
        port: 5432,
    });

    const results = {
        passed: 0,
        failed: 0,
        tests: [],
    };

    function assert(name, condition, details = '') {
        if (condition) {
            results.passed++;
            results.tests.push({ name, status: 'PASS', details });
            console.log(`✅ PASS: ${name}`);
        } else {
            results.failed++;
            results.tests.push({ name, status: 'FAIL', details });
            console.error(`❌ FAIL: ${name} - ${details}`);
        }
    }

    try {
        console.log(`\n======================================================`);
        console.log(`STEP 4D.2 EXPANDED AUTOMATED VALIDATION SUITE`);
        console.log(`Database: ${dbName}`);
        console.log(`======================================================\n`);

        // SECTION 1: Migration status
        const migRes = await superPool.query(
            "SELECT migration_name, checksum, status FROM schema_migrations WHERE migration_name = '028_canonical_tenant_and_entity_ownership.sql'"
        );
        assert(
            'Migration 028 recorded as APPLIED with SHA-256 checksum',
            migRes.rows.length === 1 &&
                migRes.rows[0].status === 'APPLIED' &&
                migRes.rows[0].checksum,
            JSON.stringify(migRes.rows)
        );

        // SECTION 2: Canonical tenants present
        const tenantsRes = await superPool.query(
            'SELECT tenant_id, name, status, tenant_type, is_active FROM identity.tenants ORDER BY tenant_id'
        );
        assert(
            'Canonical Tenants present (at least 4: T1, T2, T3, T99)',
            tenantsRes.rows.length >= 4,
            `Found ${tenantsRes.rows.length} tenants`
        );

        // SECTION 3: Table-by-table Zero-NULL Audit across ALL 24 altered tables
        const all24AlteredTables = [
            'public.instructions',
            'public.ledger_journal',
            'public.invoices',
            'public.businesses',
            'public.business_bank_accounts',
            'public.bank_transactions',
            'public.obligations',
            'public.departments',
            'public.budgets',
            'public.alert_rules',
            'public.alert_events',
            'public.fx_exposures',
            'public.idempotency_keys',
            'public.invoice_saga_steps',
            'public.reconciliation_log',
            'public.routing_ledger',
            'public.compliance_documents',
            'public.aa_consents',
            'public.scheduled_payments',
            'public.vendor_contacts',
            'identity.payment_dispatch_records',
            'identity.payment_settlement_evidence',
            'identity.saga_dispatch_outbox',
        ];

        for (const tbl of all24AlteredTables) {
            const res = await superPool.query(
                `SELECT count(*) FROM ${tbl} WHERE tenant_id IS NULL`
            );
            assert(
                `Zero NULL tenant_id on ${tbl}`,
                parseInt(res.rows[0].count, 10) === 0,
                `Count: ${res.rows[0].count}`
            );
        }

        // Section 3.1: Balances table NULL check (Treasury IS NULL, non-treasury IS NOT NULL)
        const balTreasuryNull = await superPool.query(
            'SELECT count(*) FROM public.balances WHERE is_treasury = TRUE AND tenant_id IS NOT NULL'
        );
        assert(
            'Treasury balances have NULL tenant_id',
            parseInt(balTreasuryNull.rows[0].count, 10) === 0
        );
        const balNonTreasuryNull = await superPool.query(
            'SELECT count(*) FROM public.balances WHERE is_treasury IS NOT TRUE AND tenant_id IS NULL'
        );
        assert(
            'Non-treasury balances have non-NULL tenant_id',
            parseInt(balNonTreasuryNull.rows[0].count, 10) === 0
        );

        // SECTION 4: Exact Historical Ownership Counts
        const instCounts = await superPool.query(
            'SELECT tenant_id, count(*) FROM public.instructions GROUP BY tenant_id ORDER BY tenant_id'
        );
        const t1Inst = instCounts.rows.find(
            (r) => r.tenant_id === '00000000-0000-0000-0000-000000000001'
        );
        const t3Inst = instCounts.rows.find(
            (r) => r.tenant_id === '00000000-0000-0000-0000-000000000003'
        );
        const t99Inst = instCounts.rows.find(
            (r) => r.tenant_id === '00000000-0000-0000-0000-000000000099'
        );
        assert(
            'Instructions total exactly 82 rows',
            instCounts.rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0) === 82
        );
        assert(
            'Tenant 1 owns exactly 3 instructions',
            parseInt(t1Inst ? t1Inst.count : 0, 10) === 3
        );
        assert(
            'Tenant 3 owns exactly 33 instructions',
            parseInt(t3Inst ? t3Inst.count : 0, 10) === 33
        );
        assert(
            'Tenant 99 owns exactly 46 instructions',
            parseInt(t99Inst ? t99Inst.count : 0, 10) === 46
        );

        const balCounts = await superPool.query(
            'SELECT tenant_id, is_treasury, count(*) FROM public.balances GROUP BY tenant_id, is_treasury ORDER BY tenant_id, is_treasury'
        );
        assert(
            'Balances total exactly 45 rows',
            balCounts.rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0) === 45
        );

        // SECTION 5: Ledger Journal Ownership & Hash Chain
        const ledgerCounts = await superPool.query(
            'SELECT tenant_id, count(*) FROM public.ledger_journal GROUP BY tenant_id ORDER BY tenant_id'
        );
        const t1Ledger = ledgerCounts.rows.find(
            (r) => r.tenant_id === '00000000-0000-0000-0000-000000000001'
        );
        const t3Ledger = ledgerCounts.rows.find(
            (r) => r.tenant_id === '00000000-0000-0000-0000-000000000003'
        );
        const t99Ledger = ledgerCounts.rows.find(
            (r) => r.tenant_id === '00000000-0000-0000-0000-000000000099'
        );
        assert(
            'Ledger journal total exactly 78 rows',
            ledgerCounts.rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0) === 78
        );
        assert(
            'Tenant 1 owns exactly 4 ledger rows (sequences 71-74)',
            parseInt(t1Ledger ? t1Ledger.count : 0, 10) === 4
        );
        assert(
            'Tenant 3 owns exactly 26 ledger rows (sequences 1-2, 37-38, 49-70)',
            parseInt(t3Ledger ? t3Ledger.count : 0, 10) === 26
        );
        assert(
            'Tenant 99 owns exactly 48 ledger rows (sequences 3-36, 39-48, 75-78)',
            parseInt(t99Ledger ? t99Ledger.count : 0, 10) === 48
        );

        // Sequences 1-78 unbroken
        const seqRange = await superPool.query(
            'SELECT min(sequence_id) as min_s, max(sequence_id) as max_s, count(*) as cnt FROM public.ledger_journal'
        );
        assert(
            'Ledger sequences 1 to 78 unbroken',
            parseInt(seqRange.rows[0].min_s, 10) === 1 &&
                parseInt(seqRange.rows[0].max_s, 10) === 78 &&
                parseInt(seqRange.rows[0].cnt, 10) === 78
        );

        // Byte-for-byte SHA-256 hash match against persistent fusion_db
        const persistentPool = new Pool({
            user: 'postgres',
            host: 'localhost',
            database: 'fusion_db',
            port: 5432,
        });
        const pHashes = await persistentPool.query(
            'SELECT sequence_id, hash, prev_hash, timestamp, amount, direction FROM public.ledger_journal ORDER BY sequence_id'
        );
        const nHashes = await superPool.query(
            'SELECT sequence_id, hash, prev_hash, timestamp, amount, direction FROM public.ledger_journal ORDER BY sequence_id'
        );
        await persistentPool.end();

        let hashesMatch = true;
        for (let i = 0; i < 78; i++) {
            if (
                pHashes.rows[i].sequence_id !== nHashes.rows[i].sequence_id ||
                pHashes.rows[i].hash !== nHashes.rows[i].hash ||
                pHashes.rows[i].prev_hash !== nHashes.rows[i].prev_hash
            ) {
                hashesMatch = false;
                break;
            }
        }
        assert('All 78 ledger hashes match persistent fusion_db byte-for-byte', hashesMatch);

        // SECTION 6: Quarantine Registry Verification
        const qCounts = await superPool.query(
            'SELECT quarantine_class, source_table, count(*) FROM identity.quarantined_records GROUP BY quarantine_class, source_table ORDER BY quarantine_class, source_table'
        );
        const totalQuarantined = qCounts.rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0);
        assert(
            'Quarantine records total exactly 84',
            totalQuarantined === 84,
            `Found: ${totalQuarantined}`
        );

        const orphanLedger = qCounts.rows.find(
            (r) => r.quarantine_class === 'ORPHAN_LEDGER_TRANSACTION'
        );
        assert(
            'Quarantined orphan ledger records total exactly 10 rows',
            parseInt(orphanLedger ? orphanLedger.count : 0, 10) === 10
        );
        const staleSaga = qCounts.rows.find((r) => r.quarantine_class === 'STALE_SAGA_ATTEMPT');
        assert(
            'Quarantined stale saga instructions total exactly 21 rows',
            parseInt(staleSaga ? staleSaga.count : 0, 10) === 21
        );
        const testFixtures = qCounts.rows.find(
            (r) => r.quarantine_class === 'TEST_HARNESS_FIXTURE'
        );
        assert(
            'Quarantined test harness instructions total exactly 46 rows',
            parseInt(testFixtures ? testFixtures.count : 0, 10) === 46
        );
        const unresolvedCp = qCounts.rows.find(
            (r) => r.quarantine_class === 'UNRESOLVED_COUNTERPARTY'
        );
        assert(
            'Quarantined unresolved counterparty instructions total exactly 7 rows',
            parseInt(unresolvedCp ? unresolvedCp.count : 0, 10) === 7
        );

        // Quarantine registry direct access denied to fusion_app_runtime
        const client = await runtimePool.connect();
        try {
            let qRegistryDenied = false;
            try {
                await client.query('SELECT * FROM identity.quarantined_records LIMIT 1');
            } catch (err) {
                qRegistryDenied = err.code === '42501';
            }
            assert(
                'Direct SELECT on identity.quarantined_records is DENIED for fusion_app_runtime',
                qRegistryDenied
            );

            // Raw ledger direct access denied
            let rawLedgerDenied = false;
            try {
                await client.query('SELECT * FROM public.ledger_journal LIMIT 1');
            } catch (err) {
                rawLedgerDenied = err.code === '42501';
            }
            assert(
                'Direct SELECT on public.ledger_journal is DENIED for fusion_app_runtime',
                rawLedgerDenied
            );

            // SECTION 7: Quarantine Visibility Gap Closure Tests
            // 7.1 Tenant 3 Customer View: 28 quarantined instructions are HIDDEN; only 5 settled Zoho instructions are visible!
            await client.query(
                "SET app.current_tenant_id = '00000000-0000-0000-0000-000000000003'"
            );
            const t3VisibleInst = await client.query('SELECT count(*) FROM public.instructions');
            assert(
                'Tenant 3 ordinary customer query sees ONLY 5 unquarantined Zoho instructions (28 quarantined hidden)',
                parseInt(t3VisibleInst.rows[0].count, 10) === 5,
                `Got: ${t3VisibleInst.rows[0].count}`
            );

            // 7.2 Tenant 3 Customer Ledger View: 14 rows corresponding to 7 quarantined instructions are HIDDEN; only 12 legitimate rows visible!
            const t3VisibleLedger = await client.query(
                'SELECT count(*) FROM identity.tenant_ledger_view'
            );
            assert(
                'Tenant 3 tenant_ledger_view sees ONLY 12 unquarantined ledger rows (14 quarantined hidden)',
                parseInt(t3VisibleLedger.rows[0].count, 10) === 12,
                `Got: ${t3VisibleLedger.rows[0].count}`
            );

            // 7.3 Released Quarantine Visibility Test:
            // Release one quarantined instruction (f6088db6-0c99-417d-8153-2ce116c30936, sequences 37-38)
            const opIdRes = await superPool.query(
                'SELECT operator_id FROM identity.operators LIMIT 1'
            );
            const opId = opIdRes.rows[0].operator_id;
            await superPool.query(`
                UPDATE identity.quarantined_records
                SET status = 'RESOLVED_RELEASED',
                    reviewed_by = '${opId}',
                    reviewed_at = NOW(),
                    resolution_notes = 'Authorized KYC verification and release',
                    is_blocked_from_execution = FALSE,
                    is_blocked_from_reporting = FALSE,
                    is_blocked_from_api = FALSE
                WHERE source_table = 'instructions' AND source_record_id = 'f6088db6-0c99-417d-8153-2ce116c30936'
            `);

            // Verify visibility increases dynamically
            const t3AfterReleaseInst = await client.query(
                'SELECT count(*) FROM public.instructions'
            );
            assert(
                'Tenant 3 instruction count dynamically increases to 6 after authorized quarantine release',
                parseInt(t3AfterReleaseInst.rows[0].count, 10) === 6
            );
            const t3AfterReleaseLedger = await client.query(
                'SELECT count(*) FROM identity.tenant_ledger_view'
            );
            assert(
                'Tenant 3 ledger view dynamically increases to 14 rows (sequences 37-38 become visible)',
                parseInt(t3AfterReleaseLedger.rows[0].count, 10) === 14
            );

            // Restore quarantine state for fixture purity
            await superPool.query(`
                UPDATE identity.quarantined_records
                SET status = 'ACTIVE',
                    reviewed_by = NULL,
                    reviewed_at = NULL,
                    resolution_notes = NULL,
                    is_blocked_from_execution = TRUE,
                    is_blocked_from_reporting = TRUE,
                    is_blocked_from_api = TRUE
                WHERE source_table = 'instructions' AND source_record_id = 'f6088db6-0c99-417d-8153-2ce116c30936'
            `);

            // SECTION 8: Tenant 99 Inactive Quarantine Boundary Denial
            await client.query(
                "SET app.current_tenant_id = '00000000-0000-0000-0000-000000000099'"
            );
            const t99InstRes = await client.query('SELECT count(*) FROM public.instructions');
            assert(
                'Tenant 99 sees 0 instructions (inactive quarantine boundary fails closed)',
                parseInt(t99InstRes.rows[0].count, 10) === 0
            );
            const t99BalRes = await client.query('SELECT count(*) FROM public.balances');
            assert('Tenant 99 sees 0 balances', parseInt(t99BalRes.rows[0].count, 10) === 0);
            const t99LedgerRes = await client.query(
                'SELECT count(*) FROM identity.tenant_ledger_view'
            );
            assert(
                'Tenant 99 sees 0 ledger rows through tenant_ledger_view',
                parseInt(t99LedgerRes.rows[0].count, 10) === 0
            );

            // SECTION 9: Unset Tenant Context Fail-Closed
            await client.query('RESET app.current_tenant_id');
            const unsetInst = await client.query('SELECT count(*) FROM public.instructions');
            assert(
                'Unset tenant context returns 0 instructions',
                parseInt(unsetInst.rows[0].count, 10) === 0
            );
            const unsetBal = await client.query('SELECT count(*) FROM public.balances');
            assert(
                'Unset tenant context returns 0 balances',
                parseInt(unsetBal.rows[0].count, 10) === 0
            );
            const unsetLedger = await client.query(
                'SELECT count(*) FROM identity.tenant_ledger_view'
            );
            assert(
                'Unset tenant context returns 0 ledger rows',
                parseInt(unsetLedger.rows[0].count, 10) === 0
            );

            // SECTION 10: Treasury Isolation
            await client.query(
                "SET app.current_tenant_id = '00000000-0000-0000-0000-000000000001'"
            );
            const t1Treasury = await client.query(
                'SELECT count(*) FROM public.balances WHERE is_treasury = TRUE'
            );
            assert(
                'Tenant 1 sees 0 treasury balances',
                parseInt(t1Treasury.rows[0].count, 10) === 0
            );

            // SECTION 11: RLS Matrix Test Across ALL 25 Protected Tables
            const all25RLSTables = [
                'public.instructions',
                'public.balances',
                'public.businesses',
                'public.invoices',
                'public.bank_transactions',
                'public.obligations',
                'public.business_bank_accounts',
                'public.idempotency_keys',
                'identity.saga_dispatch_outbox',
                'identity.tenant_memberships',
                'identity.tenant_provider_configs',
                'public.invoice_saga_steps',
                'public.reconciliation_log',
                'public.routing_ledger',
                'public.compliance_documents',
                'public.departments',
                'public.budgets',
                'public.alert_rules',
                'public.alert_events',
                'public.fx_exposures',
                'public.aa_consents',
                'public.scheduled_payments',
                'public.vendor_contacts',
                'identity.payment_dispatch_records',
                'identity.payment_settlement_evidence',
            ];

            for (const table of all25RLSTables) {
                // Test 1: SELECT with Tenant 1 context
                await client.query(
                    "SET app.current_tenant_id = '00000000-0000-0000-0000-000000000001'"
                );
                const selRes = await client.query(`SELECT count(*) FROM ${table}`);
                assert(
                    `RLS SELECT succeeds on ${table} for Tenant 1`,
                    selRes !== undefined && selRes.rows.length === 1
                );

                // Test 2: Cross-tenant UPDATE affects 0 rows
                const updRes = await client.query(
                    `UPDATE ${table} SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id = '00000000-0000-0000-0000-000000000002'`
                );
                assert(`Cross-tenant UPDATE on ${table} affects 0 rows`, updRes.rowCount === 0);
            }
        } finally {
            client.release();
        }

        // SECTION 12: Multi-Tenant Customer Idempotency Uniqueness
        await superPool.query(
            "DELETE FROM public.idempotency_keys WHERE key_id = 'order_common_999'"
        );
        await superPool.query(`
            INSERT INTO public.idempotency_keys (tenant_id, key_id, response_json, created_at)
            VALUES ('00000000-0000-0000-0000-000000000001', 'order_common_999', '{"t":1}', NOW())
        `);
        let t2InsertSuccess = false;
        try {
            await superPool.query(`
                INSERT INTO public.idempotency_keys (tenant_id, key_id, response_json, created_at)
                VALUES ('00000000-0000-0000-0000-000000000002', 'order_common_999', '{"t":2}', NOW())
            `);
            t2InsertSuccess = true;
        } catch (err) {
            console.error('Idempotency collision error:', err.message);
        }
        assert(
            'Tenant 1 and Tenant 2 can concurrently use identical customer idempotency key',
            t2InsertSuccess
        );

        let dupRejected = false;
        try {
            await superPool.query(`
                INSERT INTO public.idempotency_keys (tenant_id, key_id, response_json, created_at)
                VALUES ('00000000-0000-0000-0000-000000000001', 'order_common_999', '{"dup":true}', NOW())
            `);
        } catch (err) {
            dupRejected = err.code === '23505';
        }
        assert(
            'Intra-tenant duplicate idempotency key rejected with unique_violation',
            dupRejected
        );
        await superPool.query(
            "DELETE FROM public.idempotency_keys WHERE key_id = 'order_common_999'"
        );

        console.log(`\n======================================================`);
        console.log(`EXPANDED TEST SUMMARY: ${results.passed} PASSED, ${results.failed} FAILED`);
        console.log(`======================================================\n`);

        return results;
    } finally {
        await superPool.end();
        await runtimePool.end();
    }
}

if (require.main === module) {
    const db = process.argv[2] || 'fusion_disposable_verify_step4d2';
    runExpandedTests(db)
        .then((res) => {
            process.exit(res.failed > 0 ? 1 : 0);
        })
        .catch((err) => {
            console.error('Fatal test error:', err);
            process.exit(1);
        });
}

module.exports = { runExpandedTests };
