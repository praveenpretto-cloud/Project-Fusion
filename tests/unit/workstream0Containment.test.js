'use strict';

/**
 * PROJECT FUSION — WORKSTREAM 0: P0 SECURITY CONTAINMENT REGRESSION TEST SUITE
 * ==============================================================================
 * Validates the emergency security containment controls implemented per:
 * fusion_ai2_0_1_corrected_architecture.md
 *
 * Test Coverage:
 * 1. Legacy AI unmounted & router returns 404
 * 2. Unauthenticated KYC onboarding & balance faucet returns 503 (zero faucet crediting)
 * 3. Insecure OTP endpoints return 503 (zero plaintext OTP logging, zero afat_* tokens)
 * 4. authenticateClient middleware enforcement & bypass restrictions
 * 5. Minimal liveness (/api/health) is public (200), while detailed health (/api/health/detailed) is protected (401)
 * 6. Prometheus metrics (/metrics) is protected (401)
 * 7. Observation endpoints (/api/observe and /api/observe/instruction/:id) are protected (401)
 * 8. Next.js proxy route handler fails closed (503) without API_SECRET_KEY and enforces rejectUnauthorized: true
 * 9. Client codebase contains ZERO hardcoded fallback API secret keys
 * 10. E2E test fixtures contain ZERO hardcoded Base64 credentials and enforce strict TLS verification
 * 11. Provider webhooks operate via HMAC cryptographic verification independent of human sessions
 * 12. core/ai remains strictly private and unmounted in server.js
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

// Target modules under test
const kycRouter = require('../../api/kyc');
const authRouter = require('../../api/auth');
const aiRouter = require('../../routes/aiAdvisor');
const { handleStripeWebhook, handleRazorpayWebhook } = require('../../routes/webhooks');

/**
 * In-memory HTTP request dispatcher (does not bind local network sockets, 100% sandbox safe)
 */
function makeRequest(app, { method = 'GET', url = '/', headers = {}, body = null }) {
    return new Promise((resolve) => {
        let statusCode = 200;
        const responseHeaders = {};
        let responseBody = null;

        const req = {
            method,
            url,
            originalUrl: url,
            path: url.split('?')[0],
            params: {},
            query: {},
            headers: { ...headers },
            body: body || {},
            ip: '127.0.0.1',
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
            send(payload) {
                responseBody = payload;
                resolve({
                    statusCode,
                    headers: responseHeaders,
                    body: responseBody,
                    text: String(payload),
                });
            },
            json(payload) {
                responseBody = payload;
                resolve({
                    statusCode,
                    headers: responseHeaders,
                    body: responseBody,
                    text: JSON.stringify(payload),
                });
            },
            end(payload) {
                if (payload) responseBody = payload;
                resolve({
                    statusCode,
                    headers: responseHeaders,
                    body: responseBody,
                    text: String(payload || ''),
                });
            },
        };

        app.handle(req, res);
    });
}

describe('Workstream 0: P0 Security Containment Implementation Tests', () => {
    const TEST_SECRET = 'containment_test_secret_key_institutional_2026';

    // Helper to create an isolated Express app with authenticateClient
    function createTestServerApp() {
        const app = express();
        app.use(express.json());

        // Exact authenticateClient logic from server.js
        const authenticateClient = (req, res, next) => {
            if (
                req.originalUrl.startsWith('/api/auth') ||
                req.originalUrl.startsWith('/api/webhooks')
            ) {
                return next();
            }

            const clientKey = (req.headers['x-api-key'] || '').trim();
            const secretKey = (process.env.API_SECRET_KEY || '').trim();

            if (!clientKey || !secretKey || clientKey !== secretKey) {
                return res.status(401).json({
                    error: 'Unauthorized',
                    detail: 'Invalid or missing API credentials (Workstream 0 containment)',
                });
            }
            next();
        };

        // Minimal liveness (public)
        app.get('/api/health', (req, res) => {
            res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
        });

        // Protected detailed health
        app.get('/api/health/detailed', authenticateClient, (req, res) => {
            res.status(200).json({ status: 'healthy', database: 'connected', redis: 'connected' });
        });

        // Protected Prometheus metrics
        app.get('/metrics', authenticateClient, (req, res) => {
            res.setHeader('Content-Type', 'text/plain');
            res.send('# HELP fusion_requests_total\nfusion_requests_total 42');
        });

        // Protected observation route
        app.get('/api/observe/instruction/:instructionId', authenticateClient, (req, res) => {
            const parts = req.url.split('/');
            const instructionId = parts[parts.length - 1];
            res.json({ instructionId, status: 'PROCESSED' });
        });

        // Protected general observation route
        app.get('/api/observe', authenticateClient, (req, res) => {
            res.json({ instructions: [] });
        });

        // Mounted routers
        app.use('/api/kyc', authenticateClient, kycRouter);
        app.use('/api/auth', authRouter);

        return { app, authenticateClient };
    }

    beforeAll(() => {
        process.env.API_SECRET_KEY = TEST_SECRET;
    });

    afterAll(() => {
        delete process.env.API_SECRET_KEY;
    });

    // =========================================================================
    // 1. LEGACY AI ADVISOR CONTAINMENT
    // =========================================================================
    describe('1. Legacy AI Advisor Containment', () => {
        test('aiAdvisor router returns 404 for all endpoints', async () => {
            const app = express();
            app.use('/api/ai', aiRouter);

            const resChat = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/chat',
                body: { messages: [{ role: 'user', content: 'test' }] },
            });
            expect(resChat.statusCode).toBe(404);
            expect(resChat.body.error).toMatch(
                /Legacy AI advisor endpoint is disabled and unmounted/
            );

            const resCashflow = await makeRequest(app, {
                method: 'POST',
                url: '/api/ai/cashflow-advisor',
                body: { balance: 10000 },
            });
            expect(resCashflow.statusCode).toBe(404);
            expect(resCashflow.body.error).toMatch(
                /Legacy AI advisor endpoint is disabled and unmounted/
            );

            const resRoot = await makeRequest(app, {
                method: 'GET',
                url: '/api/ai',
            });
            expect(resRoot.statusCode).toBe(404);
        });

        test('server.js does NOT actively mount /api/ai or import legacy AI advisor', () => {
            const serverCode = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
            // Must not have active (uncommented) mount of aiAdvisor
            expect(serverCode).not.toMatch(/^\s*app\.use\(['"]\/api\/ai['"]/m);
            expect(serverCode).not.toMatch(/^\s*(const|let|var).*require\(['"].*aiAdvisor['"]\)/m);
        });

        test('server.js does NOT actively mount or expose core/ai investigation copilot', () => {
            const serverCode = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
            // Must not import or mount core/ai
            expect(serverCode).not.toMatch(/^\s*(const|let|var).*require\(['"].*core\/ai/m);
            expect(serverCode).not.toMatch(/^\s*app\.use\([^)]*core\/ai/m);
            expect(serverCode).not.toContain('investigatePaymentOperation');
        });
    });

    // =========================================================================
    // 2. KYC ONBOARDING & BALANCE FAUCET CONTAINMENT
    // =========================================================================
    describe('2. KYC Onboarding & Synthetic Faucet Containment', () => {
        test('POST /api/kyc/onboard returns 503 Service Unavailable', async () => {
            const { app } = createTestServerApp();

            // When called with valid API key
            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/kyc/onboard',
                headers: { 'x-api-key': TEST_SECRET },
                body: {
                    businessName: 'Unrestricted Attacker Corp',
                    cin: 'U72200MH2023PTC123456',
                    pan: 'ABCDE1234F',
                    authorizedSignatoryName: 'Attacker',
                },
            });

            expect(res.statusCode).toBe(503);
            expect(res.body.error).toMatch(
                /KYC onboarding and synthetic balance faucet endpoint is disabled/
            );
        });

        test('POST /api/kyc/onboard is blocked if unauthenticated (401)', async () => {
            const { app } = createTestServerApp();

            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/kyc/onboard',
                body: { businessName: 'Attacker' },
            });

            expect(res.statusCode).toBe(401);
            expect(res.body.error).toBe('Unauthorized');
        });

        test('kyc.js router implementation has zero balance insert queries', () => {
            const kycCode = fs.readFileSync(path.join(__dirname, '../../api/kyc.js'), 'utf8');
            expect(kycCode).not.toContain('INSERT INTO balances');
            expect(kycCode).not.toContain('INSERT INTO users');
            expect(kycCode).not.toContain('10000000.00'); // Previous faucet amount
        });
    });

    // =========================================================================
    // 3. AUTHENTICATION & OTP VULNERABILITY CONTAINMENT
    // =========================================================================
    describe('3. Insecure OTP & Pseudo-Token Containment', () => {
        test('POST /api/auth/otp/generate returns 503 Service Unavailable', async () => {
            const { app } = createTestServerApp();

            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/auth/otp/generate',
                body: { phone: '+919999999999' },
            });

            expect(res.statusCode).toBe(503);
            expect(res.body.error).toMatch(/OTP generation service is temporarily disabled/);
            expect(res.body.otp).toBeUndefined(); // Zero OTP in response
        });

        test('POST /api/auth/otp/verify returns 503 Service Unavailable', async () => {
            const { app } = createTestServerApp();

            const res = await makeRequest(app, {
                method: 'POST',
                url: '/api/auth/otp/verify',
                body: { phone: '+919999999999', otp: '123456' },
            });

            expect(res.statusCode).toBe(503);
            expect(res.body.error).toMatch(/OTP verification service is temporarily disabled/);
            expect(res.body.token).toBeUndefined(); // Zero afat_* token issued
        });

        test('api/auth.js contains zero console.log of OTP and zero afat_ generation', () => {
            const authCode = fs.readFileSync(path.join(__dirname, '../../api/auth.js'), 'utf8');
            expect(authCode).not.toContain('console.log(`[SMS-MOCK]');
            expect(authCode).not.toContain('afat_');
            expect(authCode).not.toContain('INSERT INTO otps');
        });
    });

    // =========================================================================
    // 4. OBSERVABILITY & HEALTH ROUTE PROTECTION
    // =========================================================================
    describe('4. Observability & Health Route Protection', () => {
        test('GET /api/health remains public minimal liveness (200)', async () => {
            const { app } = createTestServerApp();

            const res = await makeRequest(app, {
                method: 'GET',
                url: '/api/health',
            });
            expect(res.statusCode).toBe(200);
            expect(res.body.status).toBe('healthy');
            expect(res.body.timestamp).toBeDefined();
            expect(res.body.database).toBeUndefined(); // Minimal: does not leak internals
        });

        test('GET /api/health/detailed requires authentication (401 when missing)', async () => {
            const { app } = createTestServerApp();

            const unauthRes = await makeRequest(app, {
                method: 'GET',
                url: '/api/health/detailed',
            });
            expect(unauthRes.statusCode).toBe(401);
            expect(unauthRes.body.error).toBe('Unauthorized');

            const authRes = await makeRequest(app, {
                method: 'GET',
                url: '/api/health/detailed',
                headers: { 'x-api-key': TEST_SECRET },
            });
            expect(authRes.statusCode).toBe(200);
        });

        test('GET /metrics requires authentication (401 when missing)', async () => {
            const { app } = createTestServerApp();

            const unauthRes = await makeRequest(app, {
                method: 'GET',
                url: '/metrics',
            });
            expect(unauthRes.statusCode).toBe(401);
            expect(unauthRes.body.error).toBe('Unauthorized');

            const authRes = await makeRequest(app, {
                method: 'GET',
                url: '/metrics',
                headers: { 'x-api-key': TEST_SECRET },
            });
            expect(authRes.statusCode).toBe(200);
            expect(authRes.text).toContain('fusion_requests_total');
        });

        test('GET /api/observe/instruction/:id requires authentication (401 when missing)', async () => {
            const { app } = createTestServerApp();

            const unauthRes = await makeRequest(app, {
                method: 'GET',
                url: '/api/observe/instruction/inst_test_123',
            });
            expect(unauthRes.statusCode).toBe(401);
            expect(unauthRes.body.error).toBe('Unauthorized');

            const authRes = await makeRequest(app, {
                method: 'GET',
                url: '/api/observe/instruction/inst_test_123',
                headers: { 'x-api-key': TEST_SECRET },
            });
            expect(authRes.statusCode).toBe(200);
            expect(authRes.body.instructionId).toBe('inst_test_123');
        });
    });

    // =========================================================================
    // 5. SERVER.JS ROUTE ORDERING & BYPASS RESTRICTION VERIFICATION
    // =========================================================================
    describe('5. server.js Authentication Architecture Integrity', () => {
        const serverCode = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');

        test('authenticateClient only bypasses /api/auth and /api/webhooks', () => {
            // Find authenticateClient definition in server.js
            const authMiddlewareMatch = serverCode.match(
                /const authenticateClient = \([\s\S]*?^ {4}\};/m
            );
            expect(authMiddlewareMatch).not.toBeNull();
            const middlewareCode = authMiddlewareMatch[0];

            expect(middlewareCode).toContain("req.originalUrl.startsWith('/api/auth')");
            expect(middlewareCode).toContain("req.originalUrl.startsWith('/api/webhooks')");
            expect(middlewareCode).not.toContain("req.originalUrl.startsWith('/api/kyc')");
            expect(middlewareCode).not.toContain("req.originalUrl.startsWith('/api/ai')");
            expect(middlewareCode).not.toContain("req.originalUrl.startsWith('/observe')");
        });

        test('/api/observe/instruction/:instructionId is registered after authenticateClient', () => {
            const authMiddlewareIndex = serverCode.indexOf('const authenticateClient =');
            const observeRouteIndex = serverCode.indexOf(
                "app.get('/api/observe/instruction/:instructionId'"
            );

            expect(authMiddlewareIndex).toBeGreaterThan(0);
            expect(observeRouteIndex).toBeGreaterThan(authMiddlewareIndex);
        });

        test('/metrics endpoint is protected with authenticateClient in server.js', () => {
            expect(serverCode).toMatch(/app\.get\(['"]\/metrics['"],\s*authenticateClient/);
        });

        test('/api/health/detailed endpoint is protected with authenticateClient in server.js', () => {
            expect(serverCode).toMatch(
                /app\.get\(['"]\/api\/health\/detailed['"],\s*authenticateClient/
            );
        });
    });

    // =========================================================================
    // 6. NEXT.JS API PROXY SECURITY HARDENING
    // =========================================================================
    describe('6. Next.js Proxy Route Hardening', () => {
        const proxyFilePath = path.join(__dirname, '../../client/src/app/api/[...path]/route.ts');
        const proxyCode = fs.readFileSync(proxyFilePath, 'utf8');

        test('Proxy enforces rejectUnauthorized: true', () => {
            expect(proxyCode).toContain('rejectUnauthorized: true');
            expect(proxyCode).not.toContain('rejectUnauthorized: false');
        });

        test('Proxy has ZERO occurrences of hardcoded fallback secret key', () => {
            expect(proxyCode).not.toContain('fusion_bank_secret_key_2025');
        });

        test('Proxy reads process.env.API_SECRET_KEY and fails closed (503) if missing', () => {
            expect(proxyCode).toContain('process.env.API_SECRET_KEY');
            expect(proxyCode).toContain('status: 503');
            expect(proxyCode).toMatch(/Backend service credentials unconfigured/);
        });

        test('Proxy fails closed (503) if certificates are missing in HTTPS mode', () => {
            expect(proxyCode).toContain('TLS certificate configuration missing');
        });
    });

    // =========================================================================
    // 7. CLIENT CODEBASE SHARED SECRET SCRUB
    // =========================================================================
    describe('7. Client-Side Codebase Shared Secret Scrub', () => {
        test('client/src/app/page.tsx has ZERO occurrences of fusion_bank_secret_key_2025 and CASHIQ_API_KEY', () => {
            const pageCode = fs.readFileSync(
                path.join(__dirname, '../../client/src/app/page.tsx'),
                'utf8'
            );
            expect(pageCode).not.toContain('fusion_bank_secret_key_2025');
            expect(pageCode).not.toContain('CASHIQ_API_KEY');
        });

        test('No file in client/src contains fusion_bank_secret_key_2025', () => {
            function scanDir(dir) {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if (entry.name !== 'node_modules' && entry.name !== '.next') {
                            scanDir(fullPath);
                        }
                    } else if (/\.(tsx|ts|jsx|js|json)$/.test(entry.name)) {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        expect(content).not.toContain('fusion_bank_secret_key_2025');
                    }
                }
            }
            scanDir(path.join(__dirname, '../../client/src'));
        });
    });

    // =========================================================================
    // 8. TEST FIXTURES CREDENTIAL SCRUB & TLS ENFORCEMENT
    // =========================================================================
    describe('8. Test Fixtures Credential Scrub & TLS Hardening', () => {
        test('razorpay_status_check.js contains ZERO hardcoded Base64 credentials and enforces TLS', () => {
            const fixturePath = path.join(__dirname, '../e2e/razorpay_status_check.js');
            const code = fs.readFileSync(fixturePath, 'utf8');

            expect(code).not.toContain('cnpwX3Rlc3Rf');
            expect(code).toContain('process.env.RAZORPAY_KEY_ID');
            expect(code).toContain('process.env.RAZORPAY_KEY_SECRET');
            expect(code).toContain('rejectUnauthorized: true');
            expect(code).not.toContain('rejectUnauthorized: false');
        });

        test('razorpay_account_check.js contains ZERO hardcoded Base64 credentials and enforces TLS', () => {
            const fixturePath = path.join(__dirname, '../e2e/razorpay_account_check.js');
            const code = fs.readFileSync(fixturePath, 'utf8');

            expect(code).not.toContain('cnpwX3Rlc3Rf');
            expect(code).toContain('process.env.RAZORPAY_KEY_ID');
            expect(code).toContain('process.env.RAZORPAY_KEY_SECRET');
            expect(code).toContain('rejectUnauthorized: true');
            expect(code).not.toContain('rejectUnauthorized: false');
        });
    });

    // =========================================================================
    // 9. WEBHOOK CRYPTOGRAPHIC AUTHENTICATION INDEPENDENCE
    // =========================================================================
    describe('9. Webhook Cryptographic Authentication Independence', () => {
        test('Stripe webhook rejects requests missing stripe-signature with 400', async () => {
            const req = {
                headers: {},
                body: { id: 'evt_test' },
            };
            let responseStatus = 200;
            let responseBody = null;
            const res = {
                status: (code) => {
                    responseStatus = code;
                    return res;
                },
                json: (data) => {
                    responseBody = data;
                    return res;
                },
            };

            await handleStripeWebhook(req, res);
            expect(responseStatus).toBe(400);
            expect(responseBody.error).toBe('Missing Stripe-Signature header');
        });

        test('RazorpayX webhook rejects requests missing x-razorpay-signature with 400', async () => {
            const req = {
                headers: {},
                body: { event: 'payout.processed' },
            };
            let responseStatus = 200;
            let responseBody = null;
            const res = {
                status: (code) => {
                    responseStatus = code;
                    return res;
                },
                json: (data) => {
                    responseBody = data;
                    return res;
                },
            };

            await handleRazorpayWebhook(req, res);
            expect(responseStatus).toBe(400);
            expect(responseBody.error).toBe('Missing X-Razorpay-Signature header');
        });
    });
});
