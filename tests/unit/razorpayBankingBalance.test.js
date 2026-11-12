'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════
 * RAZORPAYX BANKING BALANCE ADAPTER TESTS
 * tests/unit/razorpayBankingBalance.test.js
 *
 * Verifies the official GET /v1/banking_balances endpoint implementation:
 * - Exact account matching without blind indexing
 * - Zero floating-point money handling (integer paise and canonical decimals)
 * - Pagination across collections with fail-closed incomplete pagination
 * - Robust error handling (401, 403, 404, timeouts, malformed responses)
 * - Freshness evaluation against project TTL policy
 * - Strict test-mode credential enforcement (rejecting rzp_live_)
 * - Complete mock isolation (zero external network calls)
 * ═══════════════════════════════════════════════════════════════════
 */

const razorpayAdapter = require('../../adapters/razorpayAdapter');
const vaultProvider = require('../../vaultProvider');

describe('RazorpayX Banking Balance Adapter (GET /v1/banking_balances)', () => {
    const originalEnv = { ...process.env };
    let fetchSpy;
    let getAdapterCredentialSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...originalEnv };
        process.env.RAZORPAYX_ACCOUNT_NUMBER = '2323230040153680';
        delete process.env.RAZORPAY_BALANCE_FRESHNESS_TTL_SECONDS;

        getAdapterCredentialSpy = jest.spyOn(vaultProvider, 'getAdapterCredential').mockImplementation((key) => {
            if (key === 'RAZORPAY_KEY_ID') return 'rzp_test_mockKeyId1234';
            if (key === 'RAZORPAY_KEY_SECRET') return 'mockSecret5678';
            return null;
        });

        // Default mock fetch
        fetchSpy = jest.spyOn(global, 'fetch');
    });

    afterEach(() => {
        process.env = { ...originalEnv };
        if (fetchSpy) fetchSpy.mockRestore();
        if (getAdapterCredentialSpy) getAdapterCredentialSpy.mockRestore();
    });

    // ─────────────────────────────────────────────────────────────
    // 1. Successful retrieval of the configured account
    // ─────────────────────────────────────────────────────────────
    test('1. Successful retrieval of the configured account with exact decimal representation', async () => {
        const nowSec = Math.floor(Date.now() / 1000);
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                entity: 'collection',
                count: 1,
                items: [
                    {
                        entity: 'banking_balance',
                        currency: 'INR',
                        account_number: '2323230040153680',
                        account_type: 'razorpayx_lite',
                        amount: 500000,
                        available_amount: 450000,
                        refreshed_at: nowSec,
                    },
                ],
            }),
        });

        const res = await razorpayAdapter.getRazorpayBalance();

        expect(res).toEqual({
            status: 'AVAILABLE',
            account_type: 'razorpayx_lite',
            currency: 'INR',
            amount_paise: '500000',
            available_amount_paise: '450000',
            amount: '5000.00',
            available_amount: '4500.00',
            refreshed_at: nowSec,
            freshness: 'UNKNOWN',
        });
        expect(typeof res.amount).toBe('string');
        expect(typeof res.available_amount).toBe('string');
        expect(typeof res.amount_paise).toBe('string');
    });

    // ─────────────────────────────────────────────────────────────
    // 2. Multiple accounts where matching account is not the first item
    // ─────────────────────────────────────────────────────────────
    test('2. Multiple accounts where matching account is not the first item', async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                entity: 'collection',
                count: 3,
                items: [
                    {
                        entity: 'banking_balance',
                        currency: 'INR',
                        account_number: '1111111111111111',
                        account_type: 'current_account',
                        amount: 9999999,
                        available_amount: 9999999,
                        refreshed_at: 1700000000,
                    },
                    {
                        entity: 'banking_balance',
                        currency: 'INR',
                        account_number: '2323230040153680', // Matching item at index 1
                        account_type: 'razorpayx_lite',
                        amount: 12345,
                        available_amount: 10000,
                        refreshed_at: 1700000100,
                    },
                    {
                        entity: 'banking_balance',
                        currency: 'INR',
                        account_number: '9999999999999999',
                        account_type: 'fixed_deposit',
                        amount: 5555555,
                        available_amount: 0,
                        refreshed_at: 1700000200,
                    },
                ],
            }),
        });

        const res = await razorpayAdapter.getRazorpayBalance();

        expect(res.status).toBe('AVAILABLE');
        expect(res.account_type).toBe('razorpayx_lite');
        expect(res.amount_paise).toBe('12345');
        expect(res.available_amount_paise).toBe('10000');
        expect(res.amount).toBe('123.45');
        expect(res.available_amount).toBe('100.00');
        expect(res.refreshed_at).toBe(1700000100);
    });

    // ─────────────────────────────────────────────────────────────
    // 3. Account not found after complete pagination
    // ─────────────────────────────────────────────────────────────
    test('3. Account not found after complete pagination returns ACCOUNT_NOT_FOUND', async () => {
        // Page 1: 100 items (none match)
        const page1Items = Array.from({ length: 100 }, (_, i) => ({
            entity: 'banking_balance',
            currency: 'INR',
            account_number: `OTHER_ACC_${i}`,
            account_type: 'current_account',
            amount: 1000,
            available_amount: 1000,
            refreshed_at: 1700000000,
        }));

        // Page 2: 25 items (none match, end of collection)
        const page2Items = Array.from({ length: 25 }, (_, i) => ({
            entity: 'banking_balance',
            currency: 'INR',
            account_number: `OTHER_PAGE2_${i}`,
            account_type: 'current_account',
            amount: 1000,
            available_amount: 1000,
            refreshed_at: 1700000000,
        }));

        fetchSpy
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ entity: 'collection', count: 100, items: page1Items }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ entity: 'collection', count: 25, items: page2Items }),
            });

        const res = await razorpayAdapter.getRazorpayBalance();

        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy).toHaveBeenNthCalledWith(1, expect.stringContaining('skip=0'), expect.anything());
        expect(fetchSpy).toHaveBeenNthCalledWith(2, expect.stringContaining('skip=100'), expect.anything());
        expect(res).toEqual({
            status: 'ACCOUNT_NOT_FOUND',
            account_type: null,
            currency: 'INR',
            amount_paise: null,
            available_amount_paise: null,
            amount: null,
            available_amount: null,
            refreshed_at: null,
            freshness: 'UNKNOWN',
        });
    });

    // ─────────────────────────────────────────────────────────────
    // 4. Missing account configuration
    // ─────────────────────────────────────────────────────────────
    test('4. Missing RAZORPAYX_ACCOUNT_NUMBER configuration throws explicit error', async () => {
        delete process.env.RAZORPAYX_ACCOUNT_NUMBER;

        await expect(razorpayAdapter.getRazorpayBalance()).rejects.toThrow(
            'Cannot retrieve balance: Missing RAZORPAYX_ACCOUNT_NUMBER configuration'
        );
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    // ─────────────────────────────────────────────────────────────
    // 5. HTTP 401 authentication failure
    // ─────────────────────────────────────────────────────────────
    test('5. HTTP 401 authentication failure throws descriptive error', async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            text: async () => JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR', description: 'Invalid API Key' } }),
        });

        await expect(razorpayAdapter.getRazorpayBalance()).rejects.toThrow(
            'RazorpayX authentication failed: Invalid or expired API credentials (HTTP 401)'
        );
    });

    // ─────────────────────────────────────────────────────────────
    // 6. HTTP 403 permission failure
    // ─────────────────────────────────────────────────────────────
    test('6. HTTP 403 permission failure throws descriptive error', async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            text: async () => JSON.stringify({ error: { code: 'FORBIDDEN', description: 'Access denied' } }),
        });

        await expect(razorpayAdapter.getRazorpayBalance()).rejects.toThrow(
            'RazorpayX permission denied: Banking balance feature or account access not provisioned (HTTP 403)'
        );
    });

    // ─────────────────────────────────────────────────────────────
    // 7. HTTP 404 endpoint failure
    // ─────────────────────────────────────────────────────────────
    test('7. HTTP 404 endpoint failure throws descriptive error', async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            text: async () => JSON.stringify({ message: 'no Route matched with those values' }),
        });

        await expect(razorpayAdapter.getRazorpayBalance()).rejects.toThrow(
            'RazorpayX endpoint unavailable: Banking balance route not found (HTTP 404)'
        );
    });

    // ─────────────────────────────────────────────────────────────
    // 8. Malformed JSON and malformed collection response
    // ─────────────────────────────────────────────────────────────
    test('8a. Malformed JSON throws explicit error', async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => '<html><body>Gateway 502 Bad Gateway</body></html>',
        });

        await expect(razorpayAdapter.getRazorpayBalance()).rejects.toThrow(
            'RazorpayX API returned malformed JSON response'
        );
    });

    test('8b. Malformed collection entity throws explicit error', async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ entity: 'error', items: null }),
        });

        await expect(razorpayAdapter.getRazorpayBalance()).rejects.toThrow(
            "RazorpayX API returned malformed collection response: expected entity 'collection' with items array"
        );
    });

    // ─────────────────────────────────────────────────────────────
    // 9. Missing or invalid amount fields
    // ─────────────────────────────────────────────────────────────
    test('9a. Missing amount field throws TypeError', async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                entity: 'collection',
                count: 1,
                items: [
                    {
                        account_number: '2323230040153680',
                        currency: 'INR',
                        available_amount: 1000,
                        // amount is missing
                    },
                ],
            }),
        });

        await expect(razorpayAdapter.getRazorpayBalance()).rejects.toThrow(
            "Missing balance field: 'amount'"
        );
    });

    test('9b. Missing available_amount field throws TypeError', async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                entity: 'collection',
                count: 1,
                items: [
                    {
                        account_number: '2323230040153680',
                        currency: 'INR',
                        amount: 1000,
                        // available_amount is missing
                    },
                ],
            }),
        });

        await expect(razorpayAdapter.getRazorpayBalance()).rejects.toThrow(
            "Missing balance field: 'available_amount'"
        );
    });

    // ─────────────────────────────────────────────────────────────
    // 10. Unsafe monetary values
    // ─────────────────────────────────────────────────────────────
    test('10a. Floating point amount value throws TypeError', async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                entity: 'collection',
                count: 1,
                items: [
                    {
                        account_number: '2323230040153680',
                        currency: 'INR',
                        amount: 1234.56, // Invalid: must be integer paise
                        available_amount: 1000,
                    },
                ],
            }),
        });

        await expect(razorpayAdapter.getRazorpayBalance()).rejects.toThrow(
            "Unsafe numeric value for 'amount': '1234.56'"
        );
    });

    test('10b. Negative balance value throws RangeError', async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                entity: 'collection',
                count: 1,
                items: [
                    {
                        account_number: '2323230040153680',
                        currency: 'INR',
                        amount: -500,
                        available_amount: 0,
                    },
                ],
            }),
        });

        await expect(razorpayAdapter.getRazorpayBalance()).rejects.toThrow(
            "Negative balance value for 'amount': '-500'"
        );
    });

    test('10c. Unsafe integer exceeding MAX_SAFE_INTEGER throws TypeError', async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                entity: 'collection',
                count: 1,
                items: [
                    {
                        account_number: '2323230040153680',
                        currency: 'INR',
                        amount: Number.MAX_SAFE_INTEGER + 100,
                        available_amount: 1000,
                    },
                ],
            }),
        });

        await expect(razorpayAdapter.getRazorpayBalance()).rejects.toThrow(
            "Unsafe numeric value for 'amount'"
        );
    });

    // ─────────────────────────────────────────────────────────────
    // 11. Missing refresh timestamp
    // ─────────────────────────────────────────────────────────────
    test('11. Missing or invalid refresh timestamp returns freshness as UNKNOWN', async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                entity: 'collection',
                count: 1,
                items: [
                    {
                        account_number: '2323230040153680',
                        currency: 'INR',
                        amount: 10000,
                        available_amount: 10000,
                        refreshed_at: null, // missing timestamp
                    },
                ],
            }),
        });

        const res = await razorpayAdapter.getRazorpayBalance();
        expect(res.status).toBe('AVAILABLE');
        expect(res.refreshed_at).toBeNull();
        expect(res.freshness).toBe('UNKNOWN');
    });

    // ─────────────────────────────────────────────────────────────
    // 12. Stale timestamp against configured policy
    // ─────────────────────────────────────────────────────────────
    test('12. Stale timestamp evaluated against RAZORPAY_BALANCE_FRESHNESS_TTL_SECONDS', async () => {
        process.env.RAZORPAY_BALANCE_FRESHNESS_TTL_SECONDS = '300'; // 5 minutes TTL
        const staleSec = Math.floor(Date.now() / 1000) - 1000; // 1000s ago

        fetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                entity: 'collection',
                count: 1,
                items: [
                    {
                        account_number: '2323230040153680',
                        currency: 'INR',
                        amount: 25000,
                        available_amount: 20000,
                        refreshed_at: staleSec,
                    },
                ],
            }),
        });

        const res = await razorpayAdapter.getRazorpayBalance();
        expect(res.freshness).toBe('STALE');
        expect(res.refreshed_at).toBe(staleSec);

        // Sub-test: fresh timestamp
        const freshSec = Math.floor(Date.now() / 1000) - 50; // 50s ago
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                entity: 'collection',
                count: 1,
                items: [
                    {
                        account_number: '2323230040153680',
                        currency: 'INR',
                        amount: 25000,
                        available_amount: 20000,
                        refreshed_at: freshSec,
                    },
                ],
            }),
        });

        const freshRes = await razorpayAdapter.getRazorpayBalance();
        expect(freshRes.freshness).toBe('FRESH');
    });

    // ─────────────────────────────────────────────────────────────
    // 13. Pagination where the account appears on a later page
    // ─────────────────────────────────────────────────────────────
    test('13a. Pagination successfully finds account on second page', async () => {
        const page1Items = Array.from({ length: 100 }, (_, i) => ({
            account_number: `OTHER_${i}`,
            currency: 'INR',
            amount: 100,
            available_amount: 100,
        }));
        const page2Items = [
            {
                account_number: '999999999999',
                currency: 'INR',
                amount: 100,
                available_amount: 100,
            },
            {
                account_number: '2323230040153680', // Target account on page 2
                currency: 'INR',
                account_type: 'razorpayx_lite',
                amount: 88888,
                available_amount: 77777,
                refreshed_at: 1710000000,
            },
        ];

        fetchSpy
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ entity: 'collection', count: 100, items: page1Items }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ entity: 'collection', count: 2, items: page2Items }),
            });

        const res = await razorpayAdapter.getRazorpayBalance();
        expect(res.status).toBe('AVAILABLE');
        expect(res.amount_paise).toBe('88888');
        expect(res.available_amount_paise).toBe('77777');
        expect(res.amount).toBe('888.88');
        expect(res.available_amount).toBe('777.77');
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    test('13b. Incomplete pagination throws explicit error rather than claiming ACCOUNT_NOT_FOUND', async () => {
        const page1Items = Array.from({ length: 100 }, (_, i) => ({
            account_number: `OTHER_${i}`,
            currency: 'INR',
            amount: 100,
            available_amount: 100,
        }));

        fetchSpy
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ entity: 'collection', count: 100, items: page1Items }),
            })
            .mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                text: async () => JSON.stringify({ error: { code: 'SERVER_ERROR', description: 'Internal failure' } }),
            });

        await expect(razorpayAdapter.getRazorpayBalance()).rejects.toThrow(
            /Incomplete pagination during RazorpayX balance fetch at skip=100/
        );
    });

    // ─────────────────────────────────────────────────────────────
    // 14. Timeout protection covering response-body reading
    // ─────────────────────────────────────────────────────────────
    test('14. Timeout abort error throws descriptive timeout exception', async () => {
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';

        fetchSpy.mockRejectedValueOnce(abortErr);

        await expect(razorpayAdapter.getRazorpayBalance()).rejects.toThrow(
            /RazorpayX balance request timed out/
        );
    });

    // ─────────────────────────────────────────────────────────────
    // 15. Verification that requests use GET only
    // ─────────────────────────────────────────────────────────────
    test('15. Verification that requests use HTTP GET exclusively with required parameters', async () => {
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                entity: 'collection',
                count: 1,
                items: [
                    {
                        account_number: '2323230040153680',
                        currency: 'INR',
                        amount: 10000,
                        available_amount: 10000,
                    },
                ],
            }),
        });

        await razorpayAdapter.getRazorpayBalance();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, options] = fetchSpy.mock.calls[0];
        expect(options.method).toBe('GET');
        expect(url).toBe('https://api.razorpay.com/v1/banking_balances?count=100&skip=0');
        expect(options.headers).toMatchObject({
            Authorization: expect.stringMatching(/^Basic /),
            'Content-Type': 'application/json',
        });
        expect(options.signal).toBeDefined();
    });

    // ─────────────────────────────────────────────────────────────
    // Additional security: Rejection of Live Mode credentials
    // ─────────────────────────────────────────────────────────────
    test('Security: Rejects rzp_live_ credentials immediately before any network call', async () => {
        getAdapterCredentialSpy.mockImplementation((key) => {
            if (key === 'RAZORPAY_KEY_ID') return 'rzp_live_forbiddenKey123';
            if (key === 'RAZORPAY_KEY_SECRET') return 'mockSecret';
            return null;
        });

        await expect(razorpayAdapter.getRazorpayBalance()).rejects.toThrow(
            "FATAL: Live mode credentials ('rzp_live_') are strictly prohibited in sandbox balance inquiry"
        );
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test('Security: Module exports remain frozen and immutable', () => {
        expect(Object.isFrozen(razorpayAdapter)).toBe(true);
        expect(() => {
            razorpayAdapter.getRazorpayBalance = () => {};
        }).toThrow();
    });
});

