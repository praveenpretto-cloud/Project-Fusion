'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');
const { processInstructionSagaAtomic } = require('../../core/orchestrator/sagaCore');
const { writeLedger, verifyLedgerIntegrity } = require('../../core/orchestrator/ledgerUtils');

const TEST_DB_CONFIG = {
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: 'fusion_test_isolated_db',
    password: process.env.DB_PASSWORD,
};

describe('Sprint 2.2.4 — PostgreSQL Real Database Integration & Schema Alignment', () => {
    let pool;

    beforeAll(async () => {
        pool = new Pool(TEST_DB_CONFIG);
        // Verify database connection and identity
        const res = await pool.query('SELECT current_database(), current_user, version()');
        expect(res.rows[0].current_database).toBe('fusion_test_isolated_db');
    });

    afterAll(async () => {
        if (pool) {
            await pool.end();
        }
    });

    beforeEach(async () => {
        // Clean dynamic test tables between runs
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query("SET session_replication_role = 'replica'");
            await client.query('DELETE FROM compliance_documents');
            await client.query('DELETE FROM reconciliation_log');
            await client.query('DELETE FROM routing_ledger');
            await client.query('DELETE FROM ledger_journal');
            await client.query('DELETE FROM invoice_saga_steps');
            await client.query('DELETE FROM invoices');
            await client.query('DELETE FROM instructions');
            await client.query("SET session_replication_role = 'origin'");
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 4: Schema & Engine Operations
    // ─────────────────────────────────────────────────────────────────────────

    test('1. Instruction creation, lookup, and schema defaults', async () => {
        const id = crypto.randomUUID();
        const insertRes = await pool.query(
            `INSERT INTO instructions (
                instruction_id, amount, currency, sender, recipient, purpose, state
            ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [id, 1000.5, 'USD', 'ACC_SENDER', 'ACC_RECIPIENT', 'INVOICE_PAYMENT', 'INITIATED']
        );

        expect(insertRes.rows.length).toBe(1);
        const row = insertRes.rows[0];
        expect(row.instruction_id).toBe(id);
        expect(Number(row.amount)).toBe(1000.5);
        expect(row.execution_attempts).toBe(0); // Safe default asserted
        expect(row.state).toBe('INITIATED');
        expect(row.utr).toBeNull();
        expect(row.zoho_invoice_id).toBeNull();

        const lookup = await pool.query('SELECT * FROM instructions WHERE instruction_id = $1', [
            id,
        ]);
        expect(lookup.rows.length).toBe(1);
        expect(lookup.rows[0].instruction_id).toBe(id);
    });

    test('2. Saga execution-attempt increment and check constraint', async () => {
        const id = crypto.randomUUID();
        await pool.query(
            `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, 250.0, 'USD', 'ACC_SENDER', 'ACC_RECIPIENT', 'SETTLEMENT']
        );

        // Execute exact sagaCore.js:129 increment query
        await pool.query(
            'UPDATE instructions SET execution_attempts = execution_attempts + 1, updated_at = NOW() WHERE instruction_id = $1',
            [id]
        );
        let check = await pool.query(
            'SELECT execution_attempts FROM instructions WHERE instruction_id = $1',
            [id]
        );
        expect(check.rows[0].execution_attempts).toBe(1);

        await pool.query(
            'UPDATE instructions SET execution_attempts = execution_attempts + 1, updated_at = NOW() WHERE instruction_id = $1',
            [id]
        );
        check = await pool.query(
            'SELECT execution_attempts FROM instructions WHERE instruction_id = $1',
            [id]
        );
        expect(check.rows[0].execution_attempts).toBe(2);

        // Check constraint enforces execution_attempts cannot be negative
        await expect(
            pool.query(
                'UPDATE instructions SET execution_attempts = -1 WHERE instruction_id = $1',
                [id]
            )
        ).rejects.toThrow(/chk_instructions_execution_attempts|check/i);
    });

    test('3. SUCCESS state update with intent_id and utr reference', async () => {
        const id = crypto.randomUUID();
        await pool.query(
            `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state)
             VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_EXECUTION')`,
            [id, 500.0, 'INR', 'ACC_SENDER', 'ACC_RECIPIENT', 'VENDOR_PAYOUT']
        );

        // Execute exact sagaCore.js:272 query
        const intentId = 'pout_test_live_sandbox_9988';
        const utr = 'UTR-HDFC-00998877';
        await pool.query(
            "UPDATE instructions SET state = 'SETTLED', external_intent_id = $1, utr = $2, updated_at = NOW() WHERE instruction_id = $3",
            [intentId, utr, id]
        );

        const check = await pool.query(
            'SELECT state, external_intent_id, utr FROM instructions WHERE instruction_id = $1',
            [id]
        );
        expect(check.rows[0].state).toBe('SETTLED');
        expect(check.rows[0].external_intent_id).toBe(intentId);
        expect(check.rows[0].utr).toBe(utr);
    });

    test('4. PENDING_SETTLEMENT state update with provider reference', async () => {
        const id = crypto.randomUUID();
        await pool.query(
            `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state)
             VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_EXECUTION')`,
            [id, 750.0, 'USD', 'ACC_SENDER', 'ACC_RECIPIENT', 'CARD_PAYMENT']
        );

        // Execute exact sagaCore.js:313 query
        const intentId = 'pi_test_async_processing_123';
        const utr = null;
        await pool.query(
            "UPDATE instructions SET state = 'PENDING_SETTLEMENT', external_intent_id = $1, utr = $2, updated_at = NOW() WHERE instruction_id = $3",
            [intentId, utr, id]
        );

        const check = await pool.query(
            'SELECT state, external_intent_id, utr FROM instructions WHERE instruction_id = $1',
            [id]
        );
        expect(check.rows[0].state).toBe('PENDING_SETTLEMENT');
        expect(check.rows[0].external_intent_id).toBe(intentId);
        expect(check.rows[0].utr).toBeNull();
    });

    test('5. SIMULATED state update parameter mapping and message storage', async () => {
        const id = crypto.randomUUID();
        await pool.query(
            `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state)
             VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_EXECUTION')`,
            [id, 10.0, 'BTC', 'ACC_SENDER', 'ACC_RECIPIENT', 'CRYPTO_TRANSFER']
        );

        // Execute exact sagaCore.js:308 query
        const simIntent = 'sim_btc_1700000000';
        const simNote = 'Simulated BTC transfer. Zero blockchain operations executed.';
        await pool.query(
            "UPDATE instructions SET state = 'SIMULATED', external_intent_id = $1, error_message = $2, updated_at = NOW() WHERE instruction_id = $3",
            [simIntent, simNote, id]
        );

        const check = await pool.query(
            'SELECT state, external_intent_id, error_message FROM instructions WHERE instruction_id = $1',
            [id]
        );
        expect(check.rows[0].state).toBe('SIMULATED');
        expect(check.rows[0].external_intent_id).toBe(simIntent);
        expect(check.rows[0].error_message).toBe(simNote);
    });

    test('6. MANUAL_CHECK state update parameter mapping and ambiguity audit', async () => {
        const id = crypto.randomUUID();
        await pool.query(
            `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state)
             VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_EXECUTION')`,
            [id, 200.0, 'USD', 'ACC_SENDER', 'ACC_RECIPIENT', 'CARD_PAYMENT']
        );

        // Execute exact sagaCore.js:319 query
        const ambigIntent = 'pi_test_ambig_504';
        const reconciliationReason =
            'Untrusted execution: Injected adapter is untrusted by default';
        await pool.query(
            "UPDATE instructions SET state = 'MANUAL_CHECK', external_intent_id = $1, error_message = $2, updated_at = NOW() WHERE instruction_id = $3",
            [ambigIntent, reconciliationReason, id]
        );

        const check = await pool.query(
            'SELECT state, external_intent_id, error_message FROM instructions WHERE instruction_id = $1',
            [id]
        );
        expect(check.rows[0].state).toBe('MANUAL_CHECK');
        expect(check.rows[0].external_intent_id).toBe(ambigIntent);
        expect(check.rows[0].error_message).toBe(reconciliationReason);
    });

    test('7. Invoices table state update on settlement', async () => {
        const invoiceId = 'INV-REAL-POSTGRES-001';
        await pool.query(
            `INSERT INTO invoices (invoice_id, total_amount, currency, seller_name, buyer_name, state)
             VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS')`,
            [invoiceId, 5000.0, 'USD', 'Global Logistics Ltd', 'Fusion Buyer Corp']
        );

        // Execute exact sagaCore.js:277 query
        await pool.query(
            `UPDATE invoices SET state = 'SETTLED', updated_at = NOW() WHERE invoice_id = $1 OR invoice_id = $2`,
            [invoiceId, `ZOHO-${invoiceId}`]
        );

        const check = await pool.query('SELECT state FROM invoices WHERE invoice_id = $1', [
            invoiceId,
        ]);
        expect(check.rows[0].state).toBe('SETTLED');
    });

    test('8. Double-entry ledger insertion with sequence_id and hash chain integrity', async () => {
        const id = crypto.randomUUID();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Write ledger for instruction 1
            await writeLedger(client, id, 'ACC_ALICE', 'ACC_BOB', 1000.0, 'USD', 20.0);
            await verifyLedgerIntegrity(client, id, 'USD', 20.0);
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        const entries = await pool.query(
            'SELECT entry_id, instruction_id, account_id, direction, amount, currency, hash, prev_hash, sequence_id FROM ledger_journal WHERE instruction_id = $1 ORDER BY sequence_id ASC',
            [id]
        );

        expect(entries.rows.length).toBe(2);
        const [debit, credit] = entries.rows;

        // Debit Gross = 1000 + 20 = 1020
        expect(debit.direction).toBe('DEBIT');
        expect(debit.account_id).toBe('ACC_ALICE');
        expect(Number(debit.amount)).toBe(1020.0);
        expect(debit.prev_hash).toBe('GENESIS_HASH');
        expect(debit.hash).toMatch(/^[a-f0-9]{64}$/);
        expect(Number(debit.sequence_id)).toBeGreaterThan(0);

        // Credit Net = 1000
        expect(credit.direction).toBe('CREDIT');
        expect(credit.account_id).toBe('ACC_BOB');
        expect(Number(credit.amount)).toBe(1000.0);
        expect(credit.prev_hash).toBe(debit.hash); // Hash chain link!
        expect(credit.hash).toMatch(/^[a-f0-9]{64}$/);
        expect(Number(credit.sequence_id)).toBeGreaterThan(Number(debit.sequence_id));

        // Test second ledger write ensures hash chaining across instructions
        const id2 = crypto.randomUUID();
        const client2 = await pool.connect();
        try {
            await client2.query('BEGIN');
            await writeLedger(client2, id2, 'ACC_BOB', 'ACC_CHARLIE', 500.0, 'USD', 0.0);
            await verifyLedgerIntegrity(client2, id2, 'USD', 0.0);
            await client2.query('COMMIT');
        } finally {
            client2.release();
        }

        const entries2 = await pool.query(
            'SELECT sequence_id, prev_hash FROM ledger_journal WHERE instruction_id = $1 ORDER BY sequence_id ASC LIMIT 1',
            [id2]
        );
        expect(entries2.rows[0].prev_hash).toBe(credit.hash); // Chained to previous instruction!
    });

    test('9. Transaction rollback after a failed database operation', async () => {
        const id = crypto.randomUUID();
        await pool.query(
            `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state)
             VALUES ($1, $2, $3, $4, $5, $6, 'INITIATED')`,
            [id, 100.0, 'USD', 'ACC_SENDER', 'ACC_RECIPIENT', 'TEST_ROLLBACK']
        );

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                "UPDATE instructions SET state = 'SETTLED', updated_at = NOW() WHERE instruction_id = $1",
                [id]
            );
            // Simulate error: violate check constraint on ledger_journal direction
            await client.query(
                `INSERT INTO ledger_journal (instruction_id, account_id, direction, amount, currency)
                 VALUES ($1, $2, 'INVALID_DIR', $3, $4)`,
                [id, 'ACC_SENDER', 100.0, 'USD']
            );
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }

        // Verify state was rolled back completely
        const check = await pool.query('SELECT state FROM instructions WHERE instruction_id = $1', [
            id,
        ]);
        expect(check.rows[0].state).toBe('INITIATED');

        const ledgerCount = await pool.query(
            'SELECT COUNT(*) FROM ledger_journal WHERE instruction_id = $1',
            [id]
        );
        expect(Number(ledgerCount.rows[0].count)).toBe(0);
    });

    test('10. UUID syntax and foreign-key constraint enforcement', async () => {
        // A. Invalid UUID syntax rejected by engine
        await expect(
            pool.query(
                "INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose) VALUES ('not-a-valid-uuid', 10, 'USD', 'A', 'B', 'P')"
            )
        ).rejects.toThrow(/invalid input syntax for type uuid/i);

        // B. Valid UUID succeeds
        const validId = crypto.randomUUID();
        await pool.query(
            `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose)
             VALUES ($1, 100, 'USD', 'A', 'B', 'P')`,
            [validId]
        );

        // C. Foreign key on compliance_documents enforces instruction_id exists
        const nonExistentId = crypto.randomUUID();
        await expect(
            pool.query(
                `INSERT INTO compliance_documents (instruction_id, doc_type, doc_payload)
                 VALUES ($1, 'FIRC', '{}')`,
                [nonExistentId]
            )
        ).rejects.toThrow(/violates foreign key constraint/i);

        // D. Foreign key with valid instruction_id succeeds
        const docRes = await pool.query(
            `INSERT INTO compliance_documents (instruction_id, doc_type, doc_payload)
             VALUES ($1, 'FIRC', '{"verified": true}') RETURNING doc_id`,
            [validId]
        );
        expect(docRes.rows.length).toBe(1);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 5: Financial Integrity & State Invariants
    // ─────────────────────────────────────────────────────────────────────────

    test('11. SIMULATED execution does not write double-entry ledger entries in PostgreSQL', async () => {
        const id = crypto.randomUUID();
        await pool.query(
            `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state)
             VALUES ($1, $2, $3, $4, $5, $6, 'INITIATED')`,
            [id, 0.5, 'BTC', 'ACC_SENDER', 'ACC_RECIPIENT', 'BTC_SUPPLIER_PAYMENT']
        );

        const result = await processInstructionSagaAtomic(id, pool);
        expect(result.current_state).toBe('SIMULATED');

        const dbCheck = await pool.query(
            'SELECT state, external_intent_id, error_message FROM instructions WHERE instruction_id = $1',
            [id]
        );
        expect(dbCheck.rows[0].state).toBe('SIMULATED');
        expect(dbCheck.rows[0].external_intent_id).toMatch(/^sim_btc_/);

        const ledgerCheck = await pool.query(
            'SELECT COUNT(*) FROM ledger_journal WHERE instruction_id = $1',
            [id]
        );
        expect(Number(ledgerCheck.rows[0].count)).toBe(0);
    });

    test('12. UNKNOWN / untrusted execution transitions to MANUAL_CHECK without ledger writes in PostgreSQL', async () => {
        const id = crypto.randomUUID();
        await pool.query(
            `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state)
             VALUES ($1, $2, $3, $4, $5, $6, 'INITIATED')`,
            [id, 500, 'USD', 'ACC_SENDER', 'ACC_RECIPIENT', 'SWIFT_INTERNATIONAL_TRANSFER']
        );

        // SWIFT claim is untrusted for Stripe test card; clamped to UNKNOWN -> MANUAL_CHECK
        const mockUntrustedOverride = {
            id: 'core_stripe',
            execute: async () => ({ status: 'SUCCESS', intent_id: 'pi_spoofed_swift' }),
            // No server trust token
        };

        const result = await processInstructionSagaAtomic(id, pool, {
            adapterOverride: mockUntrustedOverride,
        });

        expect(result.current_state).toBe('MANUAL_CHECK');

        const dbCheck = await pool.query(
            'SELECT state, error_message FROM instructions WHERE instruction_id = $1',
            [id]
        );
        expect(dbCheck.rows[0].state).toBe('MANUAL_CHECK');
        expect(dbCheck.rows[0].error_message).toContain('Untrusted execution');

        const ledgerCheck = await pool.query(
            'SELECT COUNT(*) FROM ledger_journal WHERE instruction_id = $1',
            [id]
        );
        expect(Number(ledgerCheck.rows[0].count)).toBe(0);
    });

    test('13. Jest module-mocked genuine adapter writes verified ledger entries and updates state to SETTLED in PostgreSQL', async () => {
        const id = crypto.randomUUID();
        await pool.query(
            `INSERT INTO instructions (instruction_id, amount, currency, sender, recipient, purpose, state)
             VALUES ($1, $2, $3, $4, $5, $6, 'INITIATED')`,
            [id, 100, 'USD', 'ACC_SENDER', 'ACC_RECIPIENT', 'CARD_PAYMENT']
        );

        // SPRINT 2.2.4.2.9: Substitute provider dependency via Jest module mocking in isolated module environment
        let isolatedSaga;
        jest.isolateModules(() => {
            jest.doMock('../../adapters/paymentsAdapters', () =>
                Object.freeze({
                    ...jest.requireActual('../../adapters/paymentsAdapters'),
                    executePaymentRail: jest.fn().mockResolvedValue({
                        status: 'SUCCESS',
                        intent_id: 'pi_test_verified_123',
                        utr: 'UTR-STRIPE-12345',
                    }),
                })
            );
            isolatedSaga = require('../../core/orchestrator/sagaCore');
        });

        // Execute via standard Saga interface without runtime adapter injection
        const result = await isolatedSaga.processInstructionSagaAtomic(id, pool);

        expect(result.current_state).toBe('SETTLED');

        const dbCheck = await pool.query(
            'SELECT state, external_intent_id, utr FROM instructions WHERE instruction_id = $1',
            [id]
        );
        expect(dbCheck.rows[0].state).toBe('SETTLED');
        expect(dbCheck.rows[0].external_intent_id).toBe('pi_test_verified_123');
        expect(dbCheck.rows[0].utr).toBe('UTR-STRIPE-12345');

        // Verify ledger journal entries exist and are balanced
        const ledgerEntries = await pool.query(
            'SELECT * FROM ledger_journal WHERE instruction_id = $1',
            [id]
        );
        expect(ledgerEntries.rows.length).toBe(2);
    });
});
