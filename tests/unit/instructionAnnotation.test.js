'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * RELIABILITY R2B: TRANSACTION ANNOTATION PERSISTENCE TEST SUITE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Verifies institutional-grade transaction annotation persistence:
 * 1. Valid metadata creation (persists category, notes, GST, invoice link, version 1 -> 2).
 * 2. Metadata update (modifies fields, increments version 2 -> 3, preserves untouched fields).
 * 3. Reload persistence (GET /api/instruction/:id/metadata returns persisted metadata).
 * 4. Invalid metadata rejection (unapproved keys, invalid enums, invalid UUIDs rejected with 400).
 * 5. Oversized notes rejection (>1000 characters rejected with 400).
 * 6. Unauthenticated request rejection (missing session cookie returns 401).
 * 7. Unauthorised operator rejection (deactivated operator returns 403, SYSTEM_ADMIN returns 403).
 * 8. Cross-business instruction access rejection (mismatched business returns 403).
 * 9. Attempted payment-state modification rejection (supplying amount, state, recipient returns 400).
 * 10. Concurrent metadata updates (mismatched expectedVersion returns 409 Conflict with currentMetadata).
 * 11. Existing instruction functionality preserved (amount, state, hashes unaltered).
 */

const express = require('express');
const { parseCookies } = require('../../core/identity/authMiddleware');
const instructionRouter = require('../../routes/instructionRouter');
const {
    validateAnnotationPayload,
    authenticateOperator,
    recordAnnotationAudit,
    inMemoryAuditLog,
    APPROVED_METADATA_FIELDS,
    FORBIDDEN_PAYMENT_FIELDS,
    APPROVED_CATEGORIES,
    APPROVED_GST_STATUSES,
    PRIMARY_AUTHORIZED_BUSINESS_ID,
} = require('../../routes/instructionRouter');
const { SessionManager, SESSION_COOKIE_NAME } = require('../../core/identity/sessionManager');

const VALID_INSTRUCTION_ID = '961d220c-53cf-464d-a3ce-4026517e5038';
const VALID_INVOICE_ID = '11111111-1111-4000-8000-111111111111';
const VALID_OPERATOR_ID = '00000000-0000-4000-8000-000000000002'; // OPS_OPERATOR
const DEACTIVATED_OPERATOR_ID = '00000000-0000-4000-8000-000000000099';
const SYSTEM_ADMIN_OPERATOR_ID = '00000000-4000-8000-0000-000000000005';

function createMockInstructionStore(initialInstructions = {}) {
    const store = new Map();
    const auditLogs = [];

    // Default seed instruction
    store.set(VALID_INSTRUCTION_ID, {
        instruction_id: VALID_INSTRUCTION_ID,
        amount: '50000.00',
        currency: 'INR',
        sender_hash: '0xabc123',
        recipient_hash: '0xdef456',
        purpose: 'VENDOR_PAYMENT',
        state: 'SETTLED',
        approval_status: 'NONE',
        metadata: {},
        ledger_hashes: ['0x111', '0x222'],
        created_at: new Date('2026-03-01T10:00:00Z'),
        updated_at: new Date('2026-03-01T10:00:00Z'),
        ...initialInstructions[VALID_INSTRUCTION_ID],
    });

    const mockPool = {
        query: jest.fn().mockImplementation(async (sql, params) => {
            const s = String(sql);

            // 1. SELECT from instructions
            if (s.includes('FROM instructions WHERE instruction_id')) {
                const id = params[0];
                const row = store.get(id);
                return { rows: row ? [{ ...row }] : [] };
            }

            // 2. UPDATE instructions SET metadata
            if (s.includes('UPDATE instructions SET metadata')) {
                const metaStr = params[0];
                const id = params[1];
                const row = store.get(id);
                if (!row) return { rowCount: 0 };
                row.metadata = typeof metaStr === 'string' ? JSON.parse(metaStr) : metaStr;
                row.updated_at = new Date();
                store.set(id, row);
                return { rowCount: 1 };
            }

            // 3. INSERT INTO identity.auth_audit_log
            if (s.includes('INSERT INTO identity.auth_audit_log')) {
                const rawMeta = params[4];
                const auditRecord = {
                    audit_id: `audit-${auditLogs.length + 1}`,
                    event_type: params[0],
                    operator_id: params[1],
                    ip_address: params[2],
                    user_agent: params[3],
                    metadata: typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta,
                    created_at: new Date(),
                };
                auditLogs.push(auditRecord);
                return { rowCount: 1 };
            }

            return { rows: [], rowCount: 0 };
        }),
    };

    return { store, auditLogs, mockPool };
}

function buildTestApp({ sessionManager, mockPool }) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.cookies = req.cookies || parseCookies(req.headers?.cookie);
        next();
    });
    app.locals.sessionManager = sessionManager;
    app.locals.pool = mockPool;
    app.use('/api', instructionRouter);
    return app;
}

/**
 * Sandboxed in-memory HTTP dispatcher for Express routes
 */
function makeRequest(app, { method = 'GET', url = '/', headers = {}, body = null, cookies = {} }) {
    return new Promise((resolve) => {
        let statusCode = 200;
        const responseHeaders = {};
        let responseBody = null;

        const cookieHeader = Object.entries(cookies)
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
            .join('; ');

        const finalHeaders = {
            ...headers,
            ...(cookieHeader ? { cookie: cookieHeader } : {}),
            'content-type': 'application/json',
        };

        const req = {
            method: method.toUpperCase(),
            url,
            originalUrl: url,
            path: url.split('?')[0],
            params: {},
            query: {},
            headers: finalHeaders,
            cookies: { ...cookies },
            body: body || {},
            ip: '127.0.0.1',
            hostname: 'localhost',
            app,
        };

        // Match route parameters for Express router
        const match = url.match(
            /^\/api\/instructions?\/([a-zA-Z0-9-]+)(\/metadata|\/dev-session)?/
        );
        if (match) {
            req.params = { id: match[1] };
        }

        const res = {
            statusCode: 200,
            status(code) {
                statusCode = code;
                this.statusCode = code;
                return this;
            },
            setHeader(name, value) {
                responseHeaders[name.toLowerCase()] = value;
                return this;
            },
            getHeader(name) {
                return responseHeaders[name.toLowerCase()];
            },
            cookie(name, value, opts) {
                responseHeaders['set-cookie'] = responseHeaders['set-cookie'] || [];
                if (!Array.isArray(responseHeaders['set-cookie'])) {
                    responseHeaders['set-cookie'] = [responseHeaders['set-cookie']];
                }
                responseHeaders['set-cookie'].push(`${name}=${value}`);
                return this;
            },
            json(data) {
                responseBody = data;
                resolve({
                    statusCode,
                    headers: responseHeaders,
                    body: responseBody,
                });
            },
            send(data) {
                responseBody = data;
                resolve({
                    statusCode,
                    headers: responseHeaders,
                    body: responseBody,
                });
            },
        };

        app.handle(req, res, () => {
            resolve({
                statusCode: 404,
                headers: responseHeaders,
                body: { error: 'Not Found' },
            });
        });
    });
}

describe('Project Fusion — Reliability R2B: Transaction Annotation Persistence', () => {
    let sessionManager;
    let storeFixture;
    let app;
    let validSessionToken;

    beforeEach(async () => {
        sessionManager = new SessionManager();
        sessionManager.inMemorySessions.clear();
        sessionManager.inMemoryOperators.clear();

        // Seed active test operator
        sessionManager.setInMemoryOperator(VALID_OPERATOR_ID, {
            operatorId: VALID_OPERATOR_ID,
            email: 'dev-ops@fusion.internal',
            fullName: 'Dev Operations Engineer',
            role: 'OPS_OPERATOR',
            isActive: true,
        });

        // Seed deactivated test operator
        sessionManager.setInMemoryOperator(DEACTIVATED_OPERATOR_ID, {
            operatorId: DEACTIVATED_OPERATOR_ID,
            email: 'inactive-operator@fusion.internal',
            fullName: 'Deactivated Operator',
            role: 'OPS_OPERATOR',
            isActive: false,
        });

        // Seed platform SYSTEM_ADMIN
        sessionManager.setInMemoryOperator(SYSTEM_ADMIN_OPERATOR_ID, {
            operatorId: SYSTEM_ADMIN_OPERATOR_ID,
            email: 'sysadmin@fusion.internal',
            fullName: 'System Administrator',
            role: 'SYSTEM_ADMIN',
            isActive: true,
        });

        // Create valid active session
        const session = await sessionManager.createSession({
            operatorId: VALID_OPERATOR_ID,
            ipAddress: '127.0.0.1',
        });
        validSessionToken = session.rawToken;

        storeFixture = createMockInstructionStore();
        app = buildTestApp({ sessionManager, mockPool: storeFixture.mockPool });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 1: VALID METADATA CREATION
    // ─────────────────────────────────────────────────────────────────────────
    test('Scenario 1: Valid metadata creation persists annotations and advances version to 2', async () => {
        const res = await makeRequest(app, {
            method: 'PATCH',
            url: `/api/instruction/${VALID_INSTRUCTION_ID}/metadata`,
            cookies: { [SESSION_COOKIE_NAME]: validSessionToken },
            body: {
                category: 'VENDOR_PAYMENT',
                notes: 'Verified against vendor invoice INV-2026-889.',
                gstApplicable: 'yes',
                linkedInvoiceId: VALID_INVOICE_ID,
                expectedVersion: 1,
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.instruction_id).toBe(VALID_INSTRUCTION_ID);

        const metadata = res.body.metadata;
        expect(metadata.version).toBe(2);
        expect(metadata.category).toBe('VENDOR_PAYMENT');
        expect(metadata.notes).toBe('Verified against vendor invoice INV-2026-889.');
        expect(metadata.gstApplicable).toBe('yes');
        expect(metadata.linkedInvoiceId).toBe(VALID_INVOICE_ID);
        expect(metadata.annotated_by).toBe(VALID_OPERATOR_ID);
        expect(metadata.annotated_by_email).toBe('dev-ops@fusion.internal');
        expect(metadata.annotated_at).toBeDefined();

        // Verify underlying database mock received UPDATE
        const dbRow = storeFixture.store.get(VALID_INSTRUCTION_ID);
        expect(dbRow.metadata.version).toBe(2);
        expect(dbRow.metadata.notes).toBe('Verified against vendor invoice INV-2026-889.');

        // Verify audit log record
        expect(storeFixture.auditLogs.length).toBe(1);
        const audit = storeFixture.auditLogs[0];
        expect(audit.event_type).toBe('INSTRUCTION_METADATA_ANNOTATED');
        expect(audit.operator_id).toBe(VALID_OPERATOR_ID);
        expect(audit.metadata.instruction_id).toBe(VALID_INSTRUCTION_ID);
        expect(audit.metadata.changed_fields).toEqual(
            expect.arrayContaining(['category', 'notes', 'gstApplicable', 'linkedInvoiceId'])
        );
        expect(audit.metadata.status).toBe('SUCCESS');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 2: METADATA UPDATE & VERSION INCREMENT
    // ─────────────────────────────────────────────────────────────────────────
    test('Scenario 2: Metadata update modifies fields, increments version 2 -> 3, and preserves untouched fields', async () => {
        // Pre-populate instruction with version 2 metadata
        const existingRow = storeFixture.store.get(VALID_INSTRUCTION_ID);
        existingRow.metadata = {
            category: 'VENDOR_PAYMENT',
            notes: 'Original note',
            gstApplicable: 'yes',
            linkedInvoiceId: VALID_INVOICE_ID,
            version: 2,
            business_id: PRIMARY_AUTHORIZED_BUSINESS_ID,
        };

        const res = await makeRequest(app, {
            method: 'PATCH',
            url: `/api/instruction/${VALID_INSTRUCTION_ID}/metadata`,
            cookies: { [SESSION_COOKIE_NAME]: validSessionToken },
            body: {
                notes: 'Updated note with additional CA review remarks.',
                gstApplicable: 'exempt',
                expectedVersion: 2,
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        const meta = res.body.metadata;
        expect(meta.version).toBe(3);
        expect(meta.notes).toBe('Updated note with additional CA review remarks.');
        expect(meta.gstApplicable).toBe('exempt');
        // Untouched fields must be preserved
        expect(meta.category).toBe('VENDOR_PAYMENT');
        expect(meta.linkedInvoiceId).toBe(VALID_INVOICE_ID);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 3: RELOAD PERSISTENCE (GET)
    // ─────────────────────────────────────────────────────────────────────────
    test('Scenario 3: Reload persistence (GET /api/instruction/:id/metadata) returns persisted metadata', async () => {
        // Seed persisted metadata in DB
        const existingRow = storeFixture.store.get(VALID_INSTRUCTION_ID);
        existingRow.metadata = {
            category: 'SALARY',
            notes: 'Batch March 2026 payroll.',
            gstApplicable: 'exempt',
            version: 4,
            annotated_by: VALID_OPERATOR_ID,
            annotated_at: '2026-03-01T12:00:00Z',
        };

        const res = await makeRequest(app, {
            method: 'GET',
            url: `/api/instruction/${VALID_INSTRUCTION_ID}/metadata`,
        });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.instruction_id).toBe(VALID_INSTRUCTION_ID);
        expect(res.body.metadata.version).toBe(4);
        expect(res.body.metadata.category).toBe('SALARY');
        expect(res.body.metadata.notes).toBe('Batch March 2026 payroll.');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 4: INVALID METADATA REJECTION (400)
    // ─────────────────────────────────────────────────────────────────────────
    test('Scenario 4: Invalid metadata rejection (unapproved keys, invalid enums, invalid UUIDs rejected with 400)', async () => {
        // Unapproved field
        const resUnapproved = await makeRequest(app, {
            method: 'PATCH',
            url: `/api/instruction/${VALID_INSTRUCTION_ID}/metadata`,
            cookies: { [SESSION_COOKIE_NAME]: validSessionToken },
            body: { unauthorizedKey: 'malicious' },
        });
        expect(resUnapproved.statusCode).toBe(400);
        expect(resUnapproved.body.error).toBe('BAD_REQUEST');
        expect(resUnapproved.body.detail).toContain(
            'Unrecognized metadata field "unauthorizedKey"'
        );

        // Invalid category
        const resBadCategory = await makeRequest(app, {
            method: 'PATCH',
            url: `/api/instruction/${VALID_INSTRUCTION_ID}/metadata`,
            cookies: { [SESSION_COOKIE_NAME]: validSessionToken },
            body: { category: 'NON_EXISTENT_CATEGORY' },
        });
        expect(resBadCategory.statusCode).toBe(400);
        expect(resBadCategory.body.error).toBe('BAD_REQUEST');
        expect(resBadCategory.body.detail).toContain('Invalid category');

        // Invalid GST status
        const resBadGst = await makeRequest(app, {
            method: 'PATCH',
            url: `/api/instruction/${VALID_INSTRUCTION_ID}/metadata`,
            cookies: { [SESSION_COOKIE_NAME]: validSessionToken },
            body: { gstApplicable: 'invalid_status' },
        });
        expect(resBadGst.statusCode).toBe(400);
        expect(resBadGst.body.error).toBe('BAD_REQUEST');
        expect(resBadGst.body.detail).toContain('Invalid gstApplicable');

        // Invalid invoice UUID
        const resBadInvoice = await makeRequest(app, {
            method: 'PATCH',
            url: `/api/instruction/${VALID_INSTRUCTION_ID}/metadata`,
            cookies: { [SESSION_COOKIE_NAME]: validSessionToken },
            body: { linkedInvoiceId: 'not-a-valid-uuid' },
        });
        expect(resBadInvoice.statusCode).toBe(400);
        expect(resBadInvoice.body.error).toBe('BAD_REQUEST');
        expect(resBadInvoice.body.detail).toContain('Invalid linkedInvoiceId format');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 5: OVERSIZED NOTES REJECTION (> 1000 CHARS)
    // ─────────────────────────────────────────────────────────────────────────
    test('Scenario 5: Oversized notes rejection (>1000 characters rejected with 400, 1000 accepted)', async () => {
        // 1001 characters: rejected
        const oversizedNotes = 'A'.repeat(1001);
        const resOversized = await makeRequest(app, {
            method: 'PATCH',
            url: `/api/instruction/${VALID_INSTRUCTION_ID}/metadata`,
            cookies: { [SESSION_COOKIE_NAME]: validSessionToken },
            body: { notes: oversizedNotes },
        });
        expect(resOversized.statusCode).toBe(400);
        expect(resOversized.body.error).toBe('BAD_REQUEST');
        expect(resOversized.body.detail).toContain(
            'Notes exceed maximum permitted length of 1000 characters'
        );

        // 1000 characters exactly: accepted
        const validMaxNotes = 'B'.repeat(1000);
        const resValid = await makeRequest(app, {
            method: 'PATCH',
            url: `/api/instruction/${VALID_INSTRUCTION_ID}/metadata`,
            cookies: { [SESSION_COOKIE_NAME]: validSessionToken },
            body: { notes: validMaxNotes },
        });
        expect(resValid.statusCode).toBe(200);
        expect(resValid.body.metadata.notes.length).toBe(1000);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 6: UNAUTHENTICATED REQUEST REJECTION (401)
    // ─────────────────────────────────────────────────────────────────────────
    test('Scenario 6: Unauthenticated request rejection (missing session cookie returns 401)', async () => {
        // Missing cookie entirely
        const resNoCookie = await makeRequest(app, {
            method: 'PATCH',
            url: `/api/instruction/${VALID_INSTRUCTION_ID}/metadata`,
            body: { notes: 'Unauthenticated edit' },
        });
        expect(resNoCookie.statusCode).toBe(401);
        expect(resNoCookie.body.error).toBe('UNAUTHORIZED');
        expect(resNoCookie.body.detail).toContain('Valid operator session is required');

        // Forged / invalid cookie
        const resBadCookie = await makeRequest(app, {
            method: 'PATCH',
            url: `/api/instruction/${VALID_INSTRUCTION_ID}/metadata`,
            cookies: { [SESSION_COOKIE_NAME]: 'forged_opaque_token_value_here' },
            body: { notes: 'Forged token edit' },
        });
        expect(resBadCookie.statusCode).toBe(401);
        expect(resBadCookie.body.error).toBe('UNAUTHORIZED');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 7: UNAUTHORISED OPERATOR REJECTION (403)
    // ─────────────────────────────────────────────────────────────────────────
    test('Scenario 7: Unauthorised operator rejection (deactivated operator returns 403, SYSTEM_ADMIN returns 403)', async () => {
        // Deactivated operator session
        const inactiveSession = await sessionManager.createSession({
            operatorId: DEACTIVATED_OPERATOR_ID,
            ipAddress: '127.0.0.1',
        });
        const resInactive = await makeRequest(app, {
            method: 'PATCH',
            url: `/api/instruction/${VALID_INSTRUCTION_ID}/metadata`,
            cookies: { [SESSION_COOKIE_NAME]: inactiveSession.rawToken },
            body: { notes: 'Deactivated operator attempt' },
        });
        expect(resInactive.statusCode).toBe(403);
        expect(resInactive.body.error).toBe('FORBIDDEN');
        expect(resInactive.body.detail).toContain('Operator account is deactivated');

        // Platform SYSTEM_ADMIN session (prohibited from financial record annotations)
        const sysadminSession = await sessionManager.createSession({
            operatorId: SYSTEM_ADMIN_OPERATOR_ID,
            ipAddress: '127.0.0.1',
        });
        const resSysAdmin = await makeRequest(app, {
            method: 'PATCH',
            url: `/api/instruction/${VALID_INSTRUCTION_ID}/metadata`,
            cookies: { [SESSION_COOKIE_NAME]: sysadminSession.rawToken },
            body: { notes: 'SysAdmin financial edit' },
        });
        expect(resSysAdmin.statusCode).toBe(403);
        expect(resSysAdmin.body.error).toBe('FORBIDDEN');
        expect(resSysAdmin.body.detail).toContain('Platform administrators are not authorized');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 8: CROSS-BUSINESS ACCESS REJECTION (403)
    // ─────────────────────────────────────────────────────────────────────────
    test('Scenario 8: Cross-business instruction access rejection (mismatched business returns 403)', async () => {
        const res = await makeRequest(app, {
            method: 'PATCH',
            url: `/api/instruction/${VALID_INSTRUCTION_ID}/metadata`,
            cookies: { [SESSION_COOKIE_NAME]: validSessionToken },
            body: {
                businessId: 'bbbbbbbb-bbbb-4000-8000-000000000001',
                notes: 'Cross-business manipulation attempt',
            },
        });

        expect(res.statusCode).toBe(403);
        expect(res.body.error).toBe('FORBIDDEN');
        expect(res.body.detail).toContain('Cross-business access prohibited');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 9: ATTEMPTED PAYMENT-STATE MODIFICATION REJECTION (400)
    // ─────────────────────────────────────────────────────────────────────────
    test('Scenario 9: Attempted payment-state modification rejection (supplying amount, state, recipient returns 400)', async () => {
        const testFields = [
            'amount',
            'state',
            'currency',
            'recipient',
            'sender',
            'approval_status',
            'utr',
        ];

        for (const field of testFields) {
            const res = await makeRequest(app, {
                method: 'PATCH',
                url: `/api/instruction/${VALID_INSTRUCTION_ID}/metadata`,
                cookies: { [SESSION_COOKIE_NAME]: validSessionToken },
                body: { [field]: 'unauthorized_mutation' },
            });

            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe('BAD_REQUEST');
            expect(res.body.detail).toContain(
                `Field "${field}" cannot be altered via annotation endpoint`
            );
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 10: CONCURRENT METADATA UPDATES (409 CONFLICT)
    // ─────────────────────────────────────────────────────────────────────────
    test('Scenario 10: Concurrent metadata updates (mismatched expectedVersion returns 409 Conflict with current metadata)', async () => {
        // Pre-populate instruction with version 3 metadata
        const existingRow = storeFixture.store.get(VALID_INSTRUCTION_ID);
        existingRow.metadata = {
            category: 'OPEX',
            notes: 'Updated by Operator Alice',
            gstApplicable: 'yes',
            version: 3,
            business_id: PRIMARY_AUTHORIZED_BUSINESS_ID,
        };

        // Operator Bob submits an update expecting version 2
        const res = await makeRequest(app, {
            method: 'PATCH',
            url: `/api/instruction/${VALID_INSTRUCTION_ID}/metadata`,
            cookies: { [SESSION_COOKIE_NAME]: validSessionToken },
            body: {
                notes: 'Stale update by Operator Bob',
                expectedVersion: 2,
            },
        });

        expect(res.statusCode).toBe(409);
        expect(res.body.error).toBe('CONFLICT');
        expect(res.body.code).toBe('CONCURRENT_MODIFICATION_CONFLICT');
        expect(res.body.detail).toContain('Record was modified concurrently by another operator');
        expect(res.body.currentMetadata.version).toBe(3);
        expect(res.body.currentMetadata.notes).toBe('Updated by Operator Alice');
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 11: EXISTING INSTRUCTION FUNCTIONALITY PRESERVED
    // ─────────────────────────────────────────────────────────────────────────
    test('Scenario 11: Existing instruction functionality preserved (amount, state, hashes unaltered)', async () => {
        const originalRow = storeFixture.store.get(VALID_INSTRUCTION_ID);
        const originalAmount = originalRow.amount;
        const originalState = originalRow.state;
        const originalSenderHash = originalRow.sender_hash;
        const originalRecipientHash = originalRow.recipient_hash;
        const originalLedgerHashes = [...originalRow.ledger_hashes];

        const res = await makeRequest(app, {
            method: 'PATCH',
            url: `/api/instruction/${VALID_INSTRUCTION_ID}/metadata`,
            cookies: { [SESSION_COOKIE_NAME]: validSessionToken },
            body: {
                category: 'TAX_PAYMENT',
                notes: 'Advance tax Q4 payment remarks.',
                gstApplicable: 'exempt',
            },
        });

        expect(res.statusCode).toBe(200);

        const updatedRow = storeFixture.store.get(VALID_INSTRUCTION_ID);
        expect(updatedRow.amount).toBe(originalAmount);
        expect(updatedRow.state).toBe(originalState);
        expect(updatedRow.sender_hash).toBe(originalSenderHash);
        expect(updatedRow.recipient_hash).toBe(originalRecipientHash);
        expect(updatedRow.ledger_hashes).toEqual(originalLedgerHashes);
        expect(updatedRow.metadata.category).toBe('TAX_PAYMENT');
        expect(updatedRow.metadata.notes).toBe('Advance tax Q4 payment remarks.');
    });
});
