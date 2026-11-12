'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * PROJECT FUSION — RELIABILITY R3B: DEFECT REPAIRS & VERIFICATION TEST SUITE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Verifies the three targeted defect repairs identified in Milestone R3A:
 * 1. Task 1 (D1): CA Workspace Export Audit SQL Repair (api/cashiq.js)
 * 2. Task 2 (D2): Zoho Reconciliations Primary Key Column Alias (api/zoho.js)
 * 3. Task 3 (D3): Multi-Business AI Session Authorization & Refusal (routes/aiAdvisor.js)
 */

const express = require('express');
const cashiqRouter = require('../../api/cashiq');
const zohoRouter = require('../../api/zoho');
const cashiqAiRouter = require('../../routes/cashiqAiRouter');
const { PRIMARY_AUTHORIZED_BUSINESS_ID } = require('../../routes/aiAdvisor');

/**
 * Pure in-memory HTTP request dispatcher (sandbox-safe, zero network sockets)
 */
function makeRequest(app, { method = 'GET', url = '/', headers = {}, body = null }) {
    return new Promise((resolve) => {
        let statusCode = 200;
        const responseHeaders = {};
        let responseBody = null;

        const req = {
            method: method.toUpperCase(),
            url,
            originalUrl: url,
            path: url.split('?')[0],
            params: {},
            query: {},
            headers: { 'content-type': 'application/json', ...headers },
            body: body || {},
            ip: '127.0.0.1',
            hostname: 'localhost',
            app,
        };

        const res = {
            statusCode: 200,
            status(code) {
                statusCode = code;
                this.statusCode = code;
                return this;
            },
            setHeader(k, v) {
                responseHeaders[k.toLowerCase()] = v;
            },
            json(payload) {
                responseBody = payload;
                resolve({
                    status: statusCode,
                    statusCode,
                    headers: responseHeaders,
                    body: responseBody,
                });
            },
            send(payload) {
                responseBody = payload;
                resolve({
                    status: statusCode,
                    statusCode,
                    headers: responseHeaders,
                    text: payload,
                    body: responseBody,
                });
            },
        };

        app.handle(req, res);
    });
}

describe('Project Fusion — R3B: Defect Repairs & Security Verification', () => {
    let app;
    let mockPool;

    beforeEach(() => {
        app = express();
        app.use(express.json());

        mockPool = {
            query: jest.fn(),
        };
        app.locals.pool = mockPool;

        app.use('/api/cashiq', cashiqRouter);
        app.use('/api/zoho', zohoRouter);
        app.use('/api/ai', cashiqAiRouter);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // TASK 1 (D1): CA WORKSPACE EXPORT AUDIT SQL
    // ─────────────────────────────────────────────────────────────────────────
    describe('Task 1 (D1): CA Workspace Export Audit SQL (/api/cashiq/:businessId/export-audit)', () => {
        const validBizId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

        test('Valid export returns HTTP 200, Content-Type text/csv, and joins bank_accounts with fallback currency', async () => {
            mockPool.query.mockResolvedValueOnce({
                rows: [
                    {
                        txn_id: 'txn-1111-2222',
                        bank_name: 'HDFC Bank',
                        account_number_masked: 'XXXX5678',
                        txn_date: new Date('2026-11-01T10:00:00Z'),
                        narration: 'Vendor Payment Tech Corp',
                        direction: 'DEBIT',
                        amount: '45000.00',
                        balance_after: '1575000.00',
                        currency: 'INR',
                        category: 'VENDOR_PAYOUT',
                    },
                ],
            });

            const res = await makeRequest(app, {
                method: 'GET',
                url: `/api/cashiq/${validBizId}/export-audit`,
            });

            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/text\/csv/);
            expect(res.headers['content-disposition']).toMatch(
                /attachment; filename=cashiq_audit_business_/
            );

            // Verify query enforces strict currency resolution hierarchy with explicit UNKNOWN fallback
            const sqlQuery = mockPool.query.mock.calls[0][0];
            expect(sqlQuery).toMatch(/FROM bank_transactions t/);
            expect(sqlQuery).toMatch(/LEFT JOIN business_bank_accounts a/);
            expect(sqlQuery).toMatch(/t\.raw_json->>'currency'/);
            expect(sqlQuery).toMatch(/t\.raw_json->>'currency_code'/);
            expect(sqlQuery).toMatch(/t\.raw_json->>'account_currency'/);
            expect(sqlQuery).toMatch(/t\.raw_json->>'domestic_contract'/);
            expect(sqlQuery).toMatch(/t\.raw_json->>'domestic_enforcement'/);
            expect(sqlQuery).toMatch(/'INR'/);
            expect(sqlQuery).toMatch(/'UNKNOWN'/);
            expect(sqlQuery).not.toMatch(/b\.gstin/);
            expect(sqlQuery).not.toMatch(/aa_consent_id/);
            expect(sqlQuery).not.toMatch(/t\.currency/);
            expect(sqlQuery).not.toMatch(/a\.raw_json/);
            expect(sqlQuery).not.toMatch(/bank_name\s+ILIKE/i);
            expect(sqlQuery).not.toMatch(/account_number_masked\s*~/);
            expect(mockPool.query.mock.calls[0][1]).toEqual([validBizId]);

            // Verify CSV content
            const lines = String(res.text || '')
                .trim()
                .split('\n');
            expect(lines[0]).toBe(
                'Transaction ID,Bank Name,Account Number,Date,Narration,Direction,Amount,Balance After,Currency,Category'
            );
            expect(lines[1]).toContain(
                'txn-1111-2222,HDFC Bank,XXXX5678,2026-11-01,"Vendor Payment Tech Corp",DEBIT,45000.00,1575000.00,INR,VENDOR_PAYOUT'
            );
        });

        test('Currency provenance 1: AA consent record with no currency metadata returns UNKNOWN', async () => {
            mockPool.query.mockResolvedValueOnce({
                rows: [
                    {
                        txn_id: 'txn-aa-unverified',
                        bank_name: 'HDFC Bank',
                        account_number_masked: 'XXXX1111',
                        txn_date: new Date('2026-11-05T10:00:00Z'),
                        narration: 'AA Feed Statement Import',
                        direction: 'CREDIT',
                        amount: '50000.00',
                        balance_after: '50000.00',
                        currency: 'UNKNOWN',
                        category: 'CUSTOMER_RECEIPT',
                    },
                ],
            });

            const res = await makeRequest(app, {
                method: 'GET',
                url: `/api/cashiq/${validBizId}/export-audit`,
            });

            expect(res.status).toBe(200);
            const lines = String(res.text || '')
                .trim()
                .split('\n');
            expect(lines[1]).toContain(
                'txn-aa-unverified,HDFC Bank,XXXX1111,2026-11-05,"AA Feed Statement Import",CREDIT,50000.00,50000.00,UNKNOWN,CUSTOMER_RECEIPT'
            );
        });

        test('Currency provenance 2: AA consent record representing a foreign-currency account returns explicit currency (USD)', async () => {
            mockPool.query.mockResolvedValueOnce({
                rows: [
                    {
                        txn_id: 'txn-aa-eefc-usd',
                        bank_name: 'ICICI Bank EEFC',
                        account_number_masked: 'XXXX2222',
                        txn_date: new Date('2026-11-05T10:00:00Z'),
                        narration: 'EEFC Inward Remittance',
                        direction: 'CREDIT',
                        amount: '12500.00',
                        balance_after: '37500.00',
                        currency: 'USD',
                        category: 'CUSTOMER_RECEIPT',
                    },
                ],
            });

            const res = await makeRequest(app, {
                method: 'GET',
                url: `/api/cashiq/${validBizId}/export-audit`,
            });

            expect(res.status).toBe(200);
            const lines = String(res.text || '')
                .trim()
                .split('\n');
            expect(lines[1]).toContain(
                'txn-aa-eefc-usd,ICICI Bank EEFC,XXXX2222,2026-11-05,"EEFC Inward Remittance",CREDIT,12500.00,37500.00,USD,CUSTOMER_RECEIPT'
            );
        });

        test('Currency provenance 3: Explicit USD transaction returns USD', async () => {
            mockPool.query.mockResolvedValueOnce({
                rows: [
                    {
                        txn_id: 'txn-explicit-usd',
                        bank_name: 'Citibank NA',
                        account_number_masked: 'XXXX8888',
                        txn_date: new Date('2026-11-06T10:00:00Z'),
                        narration: 'Export Proceeds Client NY',
                        direction: 'CREDIT',
                        amount: '50000.00',
                        balance_after: '150000.00',
                        currency: 'USD',
                        category: 'CUSTOMER_RECEIPT',
                    },
                ],
            });

            const res = await makeRequest(app, {
                method: 'GET',
                url: `/api/cashiq/${validBizId}/export-audit`,
            });

            expect(res.status).toBe(200);
            const lines = String(res.text || '')
                .trim()
                .split('\n');
            expect(lines[1]).toContain(
                'txn-explicit-usd,Citibank NA,XXXX8888,2026-11-06,"Export Proceeds Client NY",CREDIT,50000.00,150000.00,USD,CUSTOMER_RECEIPT'
            );
        });

        test('Currency provenance 4: Explicit EUR transaction returns EUR', async () => {
            mockPool.query.mockResolvedValueOnce({
                rows: [
                    {
                        txn_id: 'txn-explicit-eur',
                        bank_name: 'Deutsche Bank',
                        account_number_masked: 'XXXX9999',
                        txn_date: new Date('2026-11-07T10:00:00Z'),
                        narration: 'Consulting Fee Berlin',
                        direction: 'CREDIT',
                        amount: '35000.00',
                        balance_after: '185000.00',
                        currency: 'EUR',
                        category: 'CUSTOMER_RECEIPT',
                    },
                ],
            });

            const res = await makeRequest(app, {
                method: 'GET',
                url: `/api/cashiq/${validBizId}/export-audit`,
            });

            expect(res.status).toBe(200);
            const lines = String(res.text || '')
                .trim()
                .split('\n');
            expect(lines[1]).toContain(
                'txn-explicit-eur,Deutsche Bank,XXXX9999,2026-11-07,"Consulting Fee Berlin",CREDIT,35000.00,185000.00,EUR,CUSTOMER_RECEIPT'
            );
        });

        test('Currency provenance 5: Verified INR account-currency metadata returns INR', async () => {
            mockPool.query.mockResolvedValueOnce({
                rows: [
                    {
                        txn_id: 'txn-account-inr',
                        bank_name: 'Axis Bank Current',
                        account_number_masked: 'XXXX3333',
                        txn_date: new Date('2026-11-08T10:00:00Z'),
                        narration: 'Vendor Settlement',
                        direction: 'DEBIT',
                        amount: '62000.00',
                        balance_after: '438000.00',
                        currency: 'INR',
                        category: 'VENDOR_PAYOUT',
                    },
                ],
            });

            const res = await makeRequest(app, {
                method: 'GET',
                url: `/api/cashiq/${validBizId}/export-audit`,
            });

            expect(res.status).toBe(200);
            const lines = String(res.text || '')
                .trim()
                .split('\n');
            expect(lines[1]).toContain(
                'txn-account-inr,Axis Bank Current,XXXX3333,2026-11-08,"Vendor Settlement",DEBIT,62000.00,438000.00,INR,VENDOR_PAYOUT'
            );
        });

        test('Currency provenance 6: Domestic-only source with proven INR enforcement returns INR', async () => {
            mockPool.query.mockResolvedValueOnce({
                rows: [
                    {
                        txn_id: 'txn-domestic-enforced',
                        bank_name: 'State Bank of India',
                        account_number_masked: 'XXXX4444',
                        txn_date: new Date('2026-11-09T10:00:00Z'),
                        narration: 'Local GST Payout',
                        direction: 'DEBIT',
                        amount: '18000.00',
                        balance_after: '82000.00',
                        currency: 'INR',
                        category: 'GST_PAYMENT',
                    },
                ],
            });

            const res = await makeRequest(app, {
                method: 'GET',
                url: `/api/cashiq/${validBizId}/export-audit`,
            });

            expect(res.status).toBe(200);
            const sqlQuery = mockPool.query.mock.calls[0][0];
            expect(sqlQuery).toMatch(/domestic_contract/);
            const lines = String(res.text || '')
                .trim()
                .split('\n');
            expect(lines[1]).toContain(
                'txn-domestic-enforced,State Bank of India,XXXX4444,2026-11-09,"Local GST Payout",DEBIT,18000.00,82000.00,INR,GST_PAYMENT'
            );
        });

        test('Currency provenance 7: Missing currency and missing domestic provenance returns UNKNOWN', async () => {
            mockPool.query.mockResolvedValueOnce({
                rows: [
                    {
                        txn_id: 'txn-missing-provenance',
                        bank_name: 'Standard Chartered',
                        account_number_masked: 'XXXX5555',
                        txn_date: new Date('2026-11-09T10:00:00Z'),
                        narration: 'Ambiguous internal wire',
                        direction: 'DEBIT',
                        amount: '75000.00',
                        balance_after: '25000.00',
                        currency: 'UNKNOWN',
                        category: 'TRANSFER_INTERNAL',
                    },
                ],
            });

            const res = await makeRequest(app, {
                method: 'GET',
                url: `/api/cashiq/${validBizId}/export-audit`,
            });

            expect(res.status).toBe(200);
            const lines = String(res.text || '')
                .trim()
                .split('\n');
            expect(lines[1]).toContain(
                'txn-missing-provenance,Standard Chartered,XXXX5555,2026-11-09,"Ambiguous internal wire",DEBIT,75000.00,25000.00,UNKNOWN,TRANSFER_INTERNAL'
            );
        });

        test('Empty export returns HTTP 200 with valid CSV headers and 0 data rows', async () => {
            mockPool.query.mockResolvedValueOnce({ rows: [] });

            const res = await makeRequest(app, {
                method: 'GET',
                url: `/api/cashiq/${validBizId}/export-audit`,
            });

            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/text\/csv/);
            const lines = String(res.text || '')
                .trim()
                .split('\n');
            expect(lines.length).toBe(1);
            expect(lines[0]).toBe(
                'Transaction ID,Bank Name,Account Number,Date,Narration,Direction,Amount,Balance After,Currency,Category'
            );
        });

        test('Missing or non-UUID businessId returns HTTP 400', async () => {
            const res = await makeRequest(app, {
                method: 'GET',
                url: '/api/cashiq/not-a-valid-uuid/export-audit',
            });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toMatch(/Invalid business ID format/i);
            expect(mockPool.query).not.toHaveBeenCalled();
        });

        test('Database query failure returns HTTP 500 error response', async () => {
            mockPool.query.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

            const res = await makeRequest(app, {
                method: 'GET',
                url: `/api/cashiq/${validBizId}/export-audit`,
            });

            expect(res.status).toBe(500);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toMatch(/Failed to export audit log/i);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // TASK 2 (D2): ZOHO RECONCILIATIONS SQL
    // ─────────────────────────────────────────────────────────────────────────
    describe('Task 2 (D2): Zoho Reconciliations SQL (/api/zoho/reconciliations)', () => {
        test('Reconciliation records return HTTP 200 with recon_id aliased to id', async () => {
            mockPool.query.mockResolvedValueOnce({
                rows: [
                    {
                        id: 'recon-0001-aaaa',
                        recon_id: 'recon-0001-aaaa',
                        instruction_id: 'inst-0001-bbbb',
                        zoho_invoice_id: 'ZOHO-INV-101',
                        zoho_payment_id: 'ZOHO-PAY-501',
                        reconciled_at: new Date('2026-11-09T08:00:00Z'),
                        status: 'MATCHED',
                        amount: '25000.00',
                        currency: 'INR',
                        seller_name: 'Coimbatore Supplies',
                    },
                ],
            });

            const res = await makeRequest(app, {
                method: 'GET',
                url: '/api/zoho/reconciliations',
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.reconciliations).toBeDefined();
            expect(res.body.reconciliations.length).toBe(1);

            // Verify query aliases r.recon_id AS id
            const sqlQuery = mockPool.query.mock.calls[0][0];
            expect(sqlQuery).toMatch(/r\.recon_id\s+AS\s+id/i);
            expect(sqlQuery).not.toMatch(/SELECT\s+r\.id,/i);

            // Verify frontend consumer contracts
            const item = res.body.reconciliations[0];
            expect(item.id).toBe('recon-0001-aaaa');
            expect(item.recon_id).toBe('recon-0001-aaaa');
            expect(item.instruction_id).toBe('inst-0001-bbbb');
            expect(item.status).toBe('MATCHED');
            expect(item.seller_name).toBe('Coimbatore Supplies');
        });

        test('Empty reconciliation result returns HTTP 200 with empty array', async () => {
            mockPool.query.mockResolvedValueOnce({ rows: [] });

            const res = await makeRequest(app, {
                method: 'GET',
                url: '/api/zoho/reconciliations',
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.reconciliations).toEqual([]);
        });

        test('Database query failure returns HTTP 500 error response', async () => {
            mockPool.query.mockRejectedValueOnce(
                new Error('relation reconciliation_log does not exist')
            );

            const res = await makeRequest(app, {
                method: 'GET',
                url: '/api/zoho/reconciliations',
            });

            expect(res.status).toBe(500);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toMatch(/Failed to fetch reconciliations/i);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // TASK 3 (D3): MULTI-BUSINESS AI SESSION AUTHORIZATION
    // ─────────────────────────────────────────────────────────────────────────
    describe('Task 3 (D3): Multi-Business AI Session Authorization (/api/ai/chat & /cashflow-advisor)', () => {
        const secondaryBizId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

        test('Primary authorized business succeeds (HTTP 200) for legitimate advisory', async () => {
            mockPool.query.mockImplementation((sql) => {
                const s = String(sql);
                if (s.includes('FROM businesses')) {
                    return Promise.resolve({
                        rows: [
                            {
                                business_id: PRIMARY_AUTHORIZED_BUSINESS_ID,
                                name: 'Coimbatore Textile Mills Pvt Ltd',
                                gstin: '33AABCC1234D1Z5',
                                incorporation_type: 'PVT_LTD',
                                industry: 'Textile',
                                city: 'Coimbatore',
                            },
                        ],
                    });
                }
                if (s.includes('FROM business_bank_accounts')) {
                    return Promise.resolve({
                        rows: [
                            {
                                account_id: 'acc-1',
                                bank_name: 'HDFC Bank',
                                account_number_masked: 'XXXX1234',
                                current_balance: '1920000.00',
                                sanctioned_od_limit: '4000000.00',
                                is_primary: true,
                            },
                        ],
                    });
                }
                if (s.includes('FROM bank_transactions')) {
                    return Promise.resolve({
                        rows: [
                            { direction: 'CREDIT', amount: '1930000.00' },
                            { direction: 'DEBIT', amount: '1200000.00' },
                        ],
                    });
                }
                if (s.includes('FROM obligations')) {
                    return Promise.resolve({ rows: [] });
                }
                if (s.includes('FROM cash_alerts')) {
                    return Promise.resolve({ rows: [] });
                }
                return Promise.resolve({ rows: [] });
            });

            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/chat',
                body: {
                    businessId: PRIMARY_AUTHORIZED_BUSINESS_ID,
                    messages: [{ role: 'user', content: 'What is our current cash position?' }],
                },
            });

            expect(res.status).toBe(200);
            expect(res.body.status).toBe('AUTHORITATIVE_VERIFIED');
            expect(res.body.data_provenance.business_id).toBe(PRIMARY_AUTHORIZED_BUSINESS_ID);
        });

        test('Secondary business request is strictly refused with HTTP 403 Forbidden', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/chat',
                body: {
                    businessId: secondaryBizId,
                    messages: [{ role: 'user', content: 'What is our current cash position?' }],
                },
            });

            expect(res.status).toBe(403);
            expect(res.body.error).toBe('FORBIDDEN');
            expect(res.body.detail).toMatch(/Cross-business access prohibited/i);
        });

        test('Secondary business request to /cashflow-advisor is strictly refused with HTTP 403', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/cashflow-advisor',
                body: {
                    businessId: secondaryBizId,
                    horizonWeeks: 4,
                },
            });

            expect(res.status).toBe(403);
            expect(res.body.error).toBe('FORBIDDEN');
            expect(res.body.detail).toMatch(/Cross-business access prohibited/i);
        });

        test('Financial mutation requests on primary business are refused by policy gate', async () => {
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/chat',
                body: {
                    businessId: PRIMARY_AUTHORIZED_BUSINESS_ID,
                    messages: [{ role: 'user', content: 'Pay this invoice immediately' }],
                },
            });

            expect(res.status).toBe(200);
            expect(res.body.status).toBe('MUTATION_REFUSED');
            expect(res.body.reply).toMatch(/read-only CFO advisory copilot/i);
        });
    });
});
