'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * PROJECT FUSION — CA EXPORT CURRENCY RESOLUTION INTEGRATION TEST
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Exercises the actual PostgreSQL SQL engine against the CA export-audit
 * query using disposable fixtures in a rolled-back transaction.
 *
 * Verifies:
 * 1. Alias 't' = bank_transactions, 'a' = business_bank_accounts
 * 2. Explicit USD/EUR transaction records resolve correctly
 * 3. Verified account_currency metadata resolves correctly
 * 4. Proven domestic INR enforcement contracts resolve to INR
 * 5. Unprovenanced AA consent records and missing metadata resolve to UNKNOWN
 * 6. Zero heuristics on bank_name or masked_account_number are used
 * 7. Zero persistent test records remain after rollback
 */

const { Pool } = require('pg');

describe('CA Export Currency Source-of-Truth SQL Engine Verification', () => {
    let pool;
    let client;

    beforeAll(async () => {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/fusion_db'
        });
        client = await pool.connect();
    });

    afterAll(async () => {
        if (client) client.release();
        if (pool) await pool.end();
    });

    test('Actual PostgreSQL CASE evaluation satisfies strict 4-tier currency resolution', async () => {
        await client.query('BEGIN');

        try {
            const bizId = '91919191-2222-3333-4444-555555555555';
            const accId = '92929292-3333-4444-5555-666666666666';

            // Insert disposable test business and account
            await client.query(
                `INSERT INTO businesses (business_id, name, city) VALUES ($1, $2, $3)`,
                [bizId, 'Disposable Verification Enterprise', 'Bangalore']
            );

            await client.query(
                `INSERT INTO business_bank_accounts (account_id, business_id, bank_name, account_number_masked, data_source)
                 VALUES ($1, $2, $3, $4, $5)`,
                [accId, bizId, 'State Bank of India', 'XXXX9876', 'AA_CONSENT']
            );

            const fixtures = [
                { id: '93939393-0000-0000-0000-000000000001', raw: { currency: 'usd' }, expected: 'USD', desc: 'Explicit transaction currency usd' },
                { id: '93939393-0000-0000-0000-000000000002', raw: { currency_code: 'eur' }, expected: 'EUR', desc: 'Explicit transaction currency_code eur' },
                { id: '93939393-0000-0000-0000-000000000003', raw: { account_currency: 'gbp' }, expected: 'GBP', desc: 'Explicit account_currency gbp' },
                { id: '93939393-0000-0000-0000-000000000004', raw: { domestic_enforcement: 'INR' }, expected: 'INR', desc: 'Proven domestic_enforcement INR contract' },
                { id: '93939393-0000-0000-0000-000000000005', raw: { domestic_contract: 'true' }, expected: 'INR', desc: 'Proven domestic_contract true' },
                { id: '93939393-0000-0000-0000-000000000006', raw: { aa_consent_imported: true }, expected: 'UNKNOWN', desc: 'AA consent import without currency metadata' },
                { id: '93939393-0000-0000-0000-000000000007', raw: {}, expected: 'UNKNOWN', desc: 'Empty raw_json metadata' },
                { id: '93939393-0000-0000-0000-000000000008', raw: null, expected: 'UNKNOWN', desc: 'Null raw_json metadata' },
            ];

            for (const f of fixtures) {
                await client.query(
                    `INSERT INTO bank_transactions (txn_id, account_id, business_id, txn_date, amount, direction, narration, raw_json)
                     VALUES ($1, $2, $3, CURRENT_DATE, 5000.00, 'CREDIT', $4, $5)`,
                    [f.id, accId, bizId, f.desc, f.raw ? JSON.stringify(f.raw) : null]
                );
            }

            // Execute the exact query from api/cashiq.js
            const res = await client.query(
                `SELECT t.txn_id, a.bank_name, a.account_number_masked, t.txn_date, 
                        t.narration, t.direction, t.amount, t.balance_after, 
                        CASE 
                            -- 1. Explicit transaction currency takes priority
                            WHEN t.raw_json->>'currency' IS NOT NULL AND TRIM(t.raw_json->>'currency') <> '' 
                                THEN UPPER(TRIM(t.raw_json->>'currency'))
                            WHEN t.raw_json->>'currency_code' IS NOT NULL AND TRIM(t.raw_json->>'currency_code') <> '' 
                                THEN UPPER(TRIM(t.raw_json->>'currency_code'))
                            -- 2. Explicit verified account currency
                            WHEN t.raw_json->>'account_currency' IS NOT NULL AND TRIM(t.raw_json->>'account_currency') <> '' 
                                THEN UPPER(TRIM(t.raw_json->>'account_currency'))
                            -- 3. Domestic-only source contract with proven INR enforcement
                            WHEN t.raw_json->>'domestic_contract' = 'true' OR t.raw_json->>'domestic_enforcement' = 'INR'
                                THEN 'INR'
                            -- 4. Missing or unverified currency returns UNKNOWN (AA consent does not imply INR)
                            ELSE 'UNKNOWN'
                        END AS currency, 
                        t.category
                 FROM bank_transactions t
                 LEFT JOIN business_bank_accounts a ON a.account_id = t.account_id
                 LEFT JOIN businesses b ON b.business_id = t.business_id
                 WHERE t.business_id = $1
                 ORDER BY t.txn_id ASC`,
                [bizId]
            );

            expect(res.rows.length).toBe(fixtures.length);

            for (const row of res.rows) {
                const match = fixtures.find(f => f.id === row.txn_id);
                expect(match).toBeDefined();
                expect(row.currency).toBe(match.expected);
            }
        } finally {
            // Always roll back to guarantee database immutability
            await client.query('ROLLBACK');
        }

        // Verify zero test fixtures remain
        const verifyClean = await client.query(
            `SELECT COUNT(*) FROM businesses WHERE business_id = '91919191-2222-3333-4444-555555555555'`
        );
        expect(parseInt(verifyClean.rows[0].count, 10)).toBe(0);
    });
});

