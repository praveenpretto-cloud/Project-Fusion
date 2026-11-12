'use strict';

/**
 * SPRINT 2.2.4.2.4 — PROVIDER ADAPTER HARDENING & REGRESSION TESTS
 *
 * Verifies:
 * 1. Stripe USD 100.00 converts to 10000 minor units.
 * 2. Stripe decimal strings convert without floating-point arithmetic.
 * 3. Invalid and excessive amounts are rejected.
 * 4. Bank-rail instructions cannot be processed as Stripe card payments.
 * 5. Stripe card test payments retain their existing functionality.
 * 6. Stellar executeCryptoRail remains connected to the main Saga.
 * 7. Legacy executeCryptoTransfer alias works and matches executeCryptoRail.
 * 8. RazorpayX INR routing remains unchanged.
 * 9. Missing webhook signing secrets prevent state mutation.
 * 10. Existing simulated rails remain simulated.
 */

const {
    toStripeMinorUnits,
    executePaymentRail,
    SUPPORTED_CARD_METHODS,
} = require('../../adapters/paymentsAdapters');

const cryptoAdapters = require('../../adapters/cryptoAdapters');
const razorpayAdapter = require('../../adapters/razorpayAdapter');
const {
    verifyStripeSignature,
    verifyRazorpayXSignature,
} = require('../../core/webhooks/webhookProcessor');
const { handleStripeWebhook, handleRazorpayWebhook } = require('../../routes/webhooks');

describe('Sprint 2.2.4.2.4 — Workstream 1: Stripe Monetary Conversion', () => {
    test('1. Stripe USD 100.00 converts to exactly 10000 minor units', () => {
        expect(toStripeMinorUnits('100.00', 'USD')).toBe(10000);
        expect(toStripeMinorUnits('100', 'USD')).toBe(10000);
    });

    test('2. Stripe decimal strings convert without floating-point arithmetic precision loss', () => {
        // Classic IEEE 754 float rounding edge cases where (val * 100) produces precision artifacts:
        // 0.29 * 100 = 28.999999999999996 in JavaScript float math
        // 0.14 * 100 = 14.000000000000002
        // 0.07 * 100 = 7.000000000000001
        expect(toStripeMinorUnits('29.29', 'GBP')).toBe(2929);
        expect(toStripeMinorUnits('0.35', 'GBP')).toBe(35);
        expect(toStripeMinorUnits('0.57', 'USD')).toBe(57);
        expect(toStripeMinorUnits('19.99', 'EUR')).toBe(1999);
        expect(toStripeMinorUnits('1234.56', 'CAD')).toBe(123456);
        expect(toStripeMinorUnits('999999.99', 'USD')).toBe(99999999);
    });

    test('3. Enforces two decimal places for currently supported fiat currencies', () => {
        expect(toStripeMinorUnits('50.00', 'USD')).toBe(5000);
        expect(toStripeMinorUnits('50.5', 'EUR')).toBe(5050);
        // Rejects 3 or more decimal places
        expect(() => toStripeMinorUnits('100.001', 'USD')).toThrow(RangeError);
        expect(() => toStripeMinorUnits('100.0001', 'EUR')).toThrow(RangeError);
    });

    test('4. Rejects invalid amounts (negative, zero, non-numeric, scientific notation)', () => {
        expect(() => toStripeMinorUnits('0.00', 'USD')).toThrow(/strictly greater than zero/);
        expect(() => toStripeMinorUnits('-100.00', 'USD')).toThrow(/strictly greater than zero/);
        expect(() => toStripeMinorUnits('abc', 'USD')).toThrow(TypeError);
        expect(() => toStripeMinorUnits('1e2', 'USD')).toThrow(TypeError);
        expect(() => toStripeMinorUnits('', 'USD')).toThrow(TypeError);
        expect(() => toStripeMinorUnits(null, 'USD')).toThrow(TypeError);
    });

    test('5. Rejects amounts outside provider limits (below minimum or exceeding maximum)', () => {
        // Below minimum for USD (0.50 USD / 50 cents)
        expect(() => toStripeMinorUnits('0.10', 'USD')).toThrow(/below Stripe minimum/);
        expect(() => toStripeMinorUnits('0.49', 'USD')).toThrow(/below Stripe minimum/);

        // Valid minimum for USD
        expect(toStripeMinorUnits('0.50', 'USD')).toBe(50);

        // Valid minimum for GBP (0.30 GBP / 30 pence)
        expect(toStripeMinorUnits('0.30', 'GBP')).toBe(30);
        expect(() => toStripeMinorUnits('0.20', 'GBP')).toThrow(/below Stripe minimum/);

        // Exceeding maximum limit (999,999.99)
        expect(() => toStripeMinorUnits('1000000.00', 'USD')).toThrow(/exceeds Stripe maximum/);
        expect(() => toStripeMinorUnits('9999999.99', 'EUR')).toThrow(/exceeds Stripe maximum/);
    });

    test('6. Rejects unsupported currencies on Stripe minor unit conversion', () => {
        expect(() => toStripeMinorUnits('100.00', 'INR')).toThrow(
            /Unsupported Stripe fiat currency/
        );
        expect(() => toStripeMinorUnits('100.00', 'SGD')).toThrow(
            /Unsupported Stripe fiat currency/
        );
        expect(() => toStripeMinorUnits('100.00', 'BTC')).toThrow(
            /Unsupported Stripe fiat currency/
        );
    });
});

describe('Sprint 2.2.4.2.4 — Workstream 2: Stripe Payment Method Isolation', () => {
    test('1. Bank-rail instructions are intercepted and return SIMULATED before Stripe API call', async () => {
        const bankRailsToTest = [
            'BANK_TRANSFER',
            'NEFT',
            'SWIFT',
            'ACH',
            'SEPA',
            'WIRE',
            'NIUM',
            'ISO20022',
        ];

        for (const rail of bankRailsToTest) {
            const inst = {
                instruction_id: `test-bank-${rail.toLowerCase()}`,
                amount: '100.00',
                currency: 'USD',
                purpose: rail,
                sender: 'acct_src',
                recipient: 'acct_dst',
            };

            const result = await executePaymentRail(inst);
            expect(result.status).toBe('SIMULATED');
            expect(result.simulated).toBe(true);
            expect(result.settlement_confirmed).toBe(false);
            expect(result.adapter_type).toBe('SIMULATED_BANK_RAIL');
            expect(result.intent_id).toBeUndefined();
        }
    });

    test('2. Bank-rail in route_selected or rail property is also intercepted', async () => {
        const inst = {
            instruction_id: 'test-bank-route',
            amount: '250.00',
            currency: 'USD',
            purpose: 'CARD', // Purpose says card, but rail specifies SWIFT
            rail: 'SWIFT_INTERNATIONAL',
            sender: 'acct_src',
            recipient: 'acct_dst',
        };

        const result = await executePaymentRail(inst);
        expect(result.status).toBe('SIMULATED');
        expect(result.adapter_type).toBe('SIMULATED_BANK_RAIL');
    });

    test('3. Card test payments retain supported card payment methods', () => {
        expect(SUPPORTED_CARD_METHODS.CARD).toBe('pm_card_visa');
        expect(SUPPORTED_CARD_METHODS.VISA).toBe('pm_card_visa');
        expect(SUPPORTED_CARD_METHODS.MASTERCARD).toBe('pm_card_mastercard');
        expect(SUPPORTED_CARD_METHODS.AMEX).toBe('pm_card_amex');
    });

    test('4. executePaymentRail rejects invalid amount and returns FAILED without network call', async () => {
        const inst = {
            instruction_id: 'test-invalid-scale',
            amount: '100.001', // 3 decimal places
            currency: 'USD',
            purpose: 'CARD',
            sender: 'acct_src',
            recipient: 'acct_dst',
        };

        const result = await executePaymentRail(inst);
        expect(result.status).toBe('FAILED');
        expect(result.error).toMatch(/exceeds maximum precision of 2 decimal places/);
    });
});

describe('Sprint 2.2.4.2.4 — Workstream 3: Stellar Legacy Adapter Alias', () => {
    test('1. cryptoAdapters exports both executeCryptoRail and executeCryptoTransfer', () => {
        expect(typeof cryptoAdapters.executeCryptoRail).toBe('function');
        expect(typeof cryptoAdapters.executeCryptoTransfer).toBe('function');
        expect(cryptoAdapters.executeCryptoTransfer).toBe(cryptoAdapters.executeCryptoRail);
    });

    test('2. Legacy executeCryptoTransfer alias preserves backwards compatibility', async () => {
        // Calling executeCryptoTransfer with an invalid/mock payload should invoke executeCryptoRail
        // without throwing a TypeError
        const inst = {
            instruction_id: 'test-stellar-alias',
            amount: '10.0000000',
            sender: 'NON_EXISTENT_SENDER_123',
            recipient: 'NON_EXISTENT_RECIPIENT_456',
        };

        // It will fail gracefully on network/vault or return expected error, NOT TypeError
        try {
            const res = await cryptoAdapters.executeCryptoTransfer(inst);
            expect(res).toBeDefined();
        } catch (err) {
            expect(err.message).not.toMatch(/executeCryptoTransfer is not a function/);
        }
    });

    test('3. server.js imports executeCryptoRail and executeCryptoTransfer successfully', () => {
        const {
            executeCryptoRail,
            executeCryptoTransfer,
        } = require('../../adapters/cryptoAdapters');
        expect(executeCryptoRail).toBeDefined();
        expect(executeCryptoTransfer).toBeDefined();
    });
});

describe('Sprint 2.2.4.2.4 — Workstream 4: Webhook Configuration & Security', () => {
    test('1. Stripe webhook verification rejects missing webhook secret', () => {
        expect(() => {
            verifyStripeSignature(Buffer.from('{}'), 'sig_test', '');
        }).toThrow(/STRIPE_WEBHOOK_SECRET is not configured/);
    });

    test('2. RazorpayX webhook verification rejects missing webhook secret', () => {
        expect(() => {
            verifyRazorpayXSignature(Buffer.from('{}'), 'sig_test', '');
        }).toThrow(/RAZORPAYX_WEBHOOK_SECRET is not configured/);
    });

    test('3. RazorpayX webhook secret must NOT match API key secret', () => {
        const apiKeySecret = 'rzp_secret_dummy_12345';
        process.env.RAZORPAY_KEY_SECRET = apiKeySecret;

        expect(() => {
            verifyRazorpayXSignature(Buffer.from('{}'), 'sig_test', apiKeySecret);
        }).toThrow(/Razorpay API key secret must NOT be used as the webhook signing secret/);
    });

    test('4. Missing Stripe webhook secret prevents route execution and returns 500', async () => {
        const savedSecret = process.env.STRIPE_WEBHOOK_SECRET;
        delete process.env.STRIPE_WEBHOOK_SECRET;

        const req = {
            headers: { 'stripe-signature': 'sig_mock' },
            rawBody: Buffer.from('{"test": true}'),
        };
        let statusSent = null;
        let jsonSent = null;
        const res = {
            status: (code) => {
                statusSent = code;
                return {
                    json: (data) => {
                        jsonSent = data;
                    },
                };
            },
        };

        await handleStripeWebhook(req, res);
        expect(statusSent).toBe(500);
        expect(jsonSent.error).toMatch(/Webhook secret is not configured/);

        process.env.STRIPE_WEBHOOK_SECRET = savedSecret;
    });

    test('5. Missing RazorpayX webhook secret prevents route execution and returns 500', async () => {
        const savedSecret = process.env.RAZORPAYX_WEBHOOK_SECRET;
        delete process.env.RAZORPAYX_WEBHOOK_SECRET;

        const req = {
            headers: { 'x-razorpay-signature': 'sig_mock' },
            rawBody: Buffer.from('{"test": true}'),
        };
        let statusSent = null;
        let jsonSent = null;
        const res = {
            status: (code) => {
                statusSent = code;
                return {
                    json: (data) => {
                        jsonSent = data;
                    },
                };
            },
        };

        await handleRazorpayWebhook(req, res);
        expect(statusSent).toBe(500);
        expect(jsonSent.error).toMatch(/Webhook secret is not configured/);

        process.env.RAZORPAYX_WEBHOOK_SECRET = savedSecret;
    });
});

describe('Sprint 2.2.4.2.4 — Workstream 5: Provider Integration Integrity', () => {
    test('1. RazorpayX adapter exports all required operational functions', () => {
        expect(typeof razorpayAdapter.executeRazorpayRail).toBe('function');
        expect(typeof razorpayAdapter.queryStatus).toBe('function');
        expect(typeof razorpayAdapter.rollbackRazorpayRail).toBe('function');
        expect(typeof razorpayAdapter.getRazorpayBalance).toBe('function');
    });

    test('2. Stripe adapter exports all required operational functions', () => {
        expect(typeof executePaymentRail).toBe('function');
        expect(typeof require('../../adapters/paymentsAdapters').queryStatus).toBe('function');
        expect(typeof require('../../adapters/paymentsAdapters').rollbackPaymentRail).toBe(
            'function'
        );
        expect(typeof require('../../adapters/paymentsAdapters').getPaymentBalance).toBe(
            'function'
        );
    });

    test('3. Stellar adapter exports all required operational functions', () => {
        expect(typeof cryptoAdapters.executeCryptoRail).toBe('function');
        expect(typeof cryptoAdapters.executeCryptoTransfer).toBe('function');
        expect(typeof cryptoAdapters.queryStatus).toBe('function');
        expect(typeof cryptoAdapters.getCryptoBalance).toBe('function');
    });
});

describe('Sprint 2.2.4.2.11 — Bank Rail Identifier Completeness & Fail-Closed Routing', () => {
    const crypto = require('crypto');
    const paymentsAdapters = require('../../adapters/paymentsAdapters');
    const { processInstructionSagaAtomic } = require('../../core/orchestrator/sagaCore');

    function createMockDb({
        instructionId,
        currency = 'USD',
        amount = '100.00',
        purpose = 'CARD',
        rail = null,
        payment_method = null,
        route_selected = null,
    }) {
        const mockQueries = [];
        const mockClient = {
            query: jest.fn(async (sql, params) => {
                mockQueries.push({ sql, params });
                if (sql.includes('SELECT * FROM instructions WHERE instruction_id')) {
                    return {
                        rows: [
                            {
                                instruction_id: instructionId,
                                amount,
                                currency,
                                sender: 'ACC_SENDER_01',
                                recipient: 'ACC_RECIPIENT_01',
                                purpose,
                                rail,
                                payment_method,
                                route_selected,
                                state: 'LOCKED',
                                execution_attempts: 0,
                            },
                        ],
                    };
                }
                if (sql.includes('SELECT currency, state, purpose FROM instructions')) {
                    return {
                        rows: [
                            {
                                currency,
                                state: 'LOCKED',
                                purpose,
                                rail,
                            },
                        ],
                    };
                }
                if (sql.includes('SELECT state FROM instructions')) {
                    const updateQuery = mockQueries
                        .slice()
                        .reverse()
                        .find((q) => q.sql.includes('UPDATE instructions SET state'));
                    let finalState = 'UNKNOWN';
                    if (updateQuery) {
                        const match = updateQuery.sql.match(/state = '([A-Z_]+)'/);
                        if (match) finalState = match[1];
                    }
                    return { rows: [{ state: finalState }] };
                }
                if (sql.includes('SELECT hash FROM ledger_journal')) {
                    return { rows: [{ hash: 'PREV_HASH_123' }] };
                }
                if (sql.includes('SELECT sequence_id FROM ledger_journal')) {
                    return { rows: [] };
                }
                if (
                    sql.includes('total_debit') ||
                    sql.includes('SUM(amount)') ||
                    sql.includes('SUM(CASE')
                ) {
                    return { rows: [{ total_debit: amount, total_credit: amount }] };
                }
                return { rows: [] };
            }),
            release: jest.fn(),
        };
        const mockPool = {
            connect: jest.fn().mockResolvedValue(mockClient),
            query: mockClient.query,
        };
        return { mockPool, mockQueries, mockClient };
    }

    const allBankRailIdentifiers = [
        {
            name: 'SWIFT',
            variations: ['SWIFT', 'swift', 'Swift', 'SWIFT_TRANSFER', 'swift-settlement'],
        },
        { name: 'ISO20022', variations: ['ISO20022', 'iso20022', 'Iso20022'] },
        { name: 'ISO 20022', variations: ['ISO 20022', 'iso 20022', 'Iso 20022'] },
        {
            name: 'ISO_20022',
            variations: [
                'ISO_20022',
                'iso_20022',
                'Iso_20022',
                'ISO-20022',
                'iso-20022',
                'Iso-20022',
            ],
        },
        {
            name: 'NEFT',
            variations: ['NEFT', 'neft', 'Neft', 'NEFT_DISBURSEMENT', 'neft-clearing'],
        },
        { name: 'RTGS', variations: ['RTGS', 'rtgs', 'Rtgs', 'RTGS_PAYMENT', 'rtgs-transfer'] },
        { name: 'IMPS', variations: ['IMPS', 'imps', 'Imps', 'IMPS_INSTANT', 'imps-transfer'] },
        { name: 'ACH', variations: ['ACH', 'ach', 'Ach', 'ACH_DEBIT', 'ach-transfer'] },
        {
            name: 'FEDWIRE',
            variations: [
                'FEDWIRE',
                'fedwire',
                'FedWire',
                'FED WIRE',
                'fed wire',
                'FED_WIRE',
                'fed_wire',
                'FED-WIRE',
                'fed-wire',
            ],
        },
        {
            name: 'CHAPS',
            variations: ['CHAPS', 'chaps', 'Chaps', 'CHAPS_CLEARING', 'chaps-settlement'],
        },
        { name: 'SEPA', variations: ['SEPA', 'sepa', 'Sepa', 'SEPA_CREDIT', 'sepa-transfer'] },
        {
            name: 'FASTER_PAYMENTS',
            variations: [
                'FASTER_PAYMENTS',
                'faster_payments',
                'Faster_Payments',
                'FASTER PAYMENTS',
                'faster payments',
                'Faster Payments',
                'FASTER-PAYMENTS',
                'faster-payments',
                'Faster-Payments',
                'FASTERPAYMENTS',
                'fasterpayments',
            ],
        },
        {
            name: 'WIRE',
            variations: ['WIRE', 'wire', 'Wire', 'WIRE_TRANSFER', 'international-wire'],
        },
        { name: 'NIUM', variations: ['NIUM', 'nium', 'Nium', 'NIUM_PAYOUT', 'nium-transfer'] },
        {
            name: 'NIUM_SWIFT',
            variations: [
                'NIUM_SWIFT',
                'nium_swift',
                'Nium_Swift',
                'NIUM SWIFT',
                'nium swift',
                'Nium Swift',
                'NIUM-SWIFT',
                'nium-swift',
                'Nium-Swift',
                'NIUMSWIFT',
                'niumswift',
            ],
        },
        {
            name: 'BANK_TRANSFER',
            variations: [
                'BANK_TRANSFER',
                'bank_transfer',
                'Bank_Transfer',
                'BANK TRANSFER',
                'bank transfer',
                'Bank Transfer',
                'BANK-TRANSFER',
                'bank-transfer',
                'Bank-Transfer',
                'BANKTRANSFER',
                'banktransfer',
            ],
        },
    ];

    test('1. Direct Stripe adapter execution intercepts all 16 bank-rail identifiers across casing, spaces, underscores, and hyphens', async () => {
        for (const { variations } of allBankRailIdentifiers) {
            for (const variation of variations) {
                const res = await paymentsAdapters.executePaymentRail({
                    instruction_id: crypto.randomUUID(),
                    amount: '100.00',
                    currency: 'USD',
                    rail: variation,
                });

                expect(res.status).toBe('SIMULATED');
                expect(res.simulated).toBe(true);
                expect(res.settlement_confirmed).toBe(false);
                expect(res.adapter_type).toBe('SIMULATED_BANK_RAIL');
                expect(res.intent_id).toBeUndefined();
                expect(res.reason).toContain('Unsupported bank rail');
            }
        }
    });

    test('2. Bank-rail matching is effective across purpose, rail, route_selected, and payment_method fields', async () => {
        const fieldsToTest = [
            { purpose: 'FEDWIRE' },
            { rail: 'faster-payments' },
            { route_selected: 'ISO 20022' },
            { payment_method: 'ACH' },
            { purpose: 'nium swift' },
            { rail: 'CHAPS' },
            { route_selected: 'RTGS' },
            { payment_method: 'IMPS' },
        ];

        for (const field of fieldsToTest) {
            const res = await paymentsAdapters.executePaymentRail({
                instruction_id: crypto.randomUUID(),
                amount: '150.00',
                currency: 'USD',
                ...field,
            });

            expect(res.status).toBe('SIMULATED');
            expect(res.simulated).toBe(true);
            expect(res.settlement_confirmed).toBe(false);
            expect(res.adapter_type).toBe('SIMULATED_BANK_RAIL');
        }
    });

    test('3. Unknown payment methods fail closed and never default to a card token', async () => {
        const unknownMethods = ['PAYPAL', 'VENMO', 'UNKNOWN_WALLET', 'CRYPTO_RAIL', 'CASH'];

        for (const pm of unknownMethods) {
            const res = await paymentsAdapters.executePaymentRail({
                instruction_id: crypto.randomUUID(),
                amount: '100.00',
                currency: 'USD',
                payment_method: pm,
            });

            expect(res.status).toBe('SIMULATED');
            expect(res.simulated).toBe(true);
            expect(res.settlement_confirmed).toBe(false);
            expect(res.adapter_type).toBe('STRIPE_UNSUPPORTED');
            expect(res.reason).toMatch(/Unsupported payment method.*rejected/);
        }
    });

    test('4. Unknown purposes fail closed and never default to a card token', async () => {
        const res = await paymentsAdapters.executePaymentRail({
            instruction_id: crypto.randomUUID(),
            amount: '100.00',
            currency: 'USD',
            purpose: 'BUY_RANDOM_STUFF_123',
        });

        expect(res.status).toBe('SIMULATED');
        expect(res.simulated).toBe(true);
        expect(res.settlement_confirmed).toBe(false);
        expect(res.adapter_type).toBe('STRIPE_UNSUPPORTED');
        expect(res.reason).toMatch(/Unsupported payment rail.*rejected/);
    });

    test('5. Main Saga intercepts all 16 bank rails and routes them to SIMULATED with zero ledger writes', async () => {
        const sampleRails = [
            'SWIFT',
            'iso 20022',
            'ISO_20022',
            'iso-20022',
            'neft',
            'Rtgs',
            'imps',
            'ach-transfer',
            'FedWire',
            'fed wire',
            'fed-wire',
            'Chaps',
            'sepa',
            'faster-payments',
            'Faster Payments',
            'international-wire',
            'nium',
            'nium-swift',
            'bank-transfer',
        ];

        for (const sample of sampleRails) {
            const instId = crypto.randomUUID();
            const { mockPool, mockQueries } = createMockDb({
                instructionId: instId,
                currency: 'USD',
                rail: sample,
            });

            const result = await processInstructionSagaAtomic(instId, mockPool);

            expect(result.current_state).toBe('SIMULATED');
            expect(result.current_state).not.toBe('SETTLED');

            const ledgerInsert = mockQueries.find((q) =>
                q.sql.includes('INSERT INTO ledger_journal')
            );
            expect(ledgerInsert).toBeUndefined();

            const updateStateQuery = mockQueries.find(
                (q) =>
                    q.sql.includes('UPDATE instructions') && q.sql.includes("state = 'SIMULATED'")
            );
            expect(updateStateQuery).toBeDefined();
        }
    });

    test('6. Legitimate Stripe card payments retain supported card methods and approved business purposes', async () => {
        expect(SUPPORTED_CARD_METHODS.CARD).toBe('pm_card_visa');
        expect(SUPPORTED_CARD_METHODS.VISA).toBe('pm_card_visa');
        expect(SUPPORTED_CARD_METHODS.MASTERCARD).toBe('pm_card_mastercard');
        expect(SUPPORTED_CARD_METHODS.AMEX).toBe('pm_card_amex');

        // Valid card payment method with invalid amount reaches amount validator (proving it passed rail checks)
        const resCard = await paymentsAdapters.executePaymentRail({
            instruction_id: crypto.randomUUID(),
            amount: '100.001',
            currency: 'USD',
            payment_method: 'VISA',
        });
        expect(resCard.status).toBe('FAILED');
        expect(resCard.adapter_type).not.toBe('SIMULATED_BANK_RAIL');
        expect(resCard.adapter_type).not.toBe('STRIPE_UNSUPPORTED');
        expect(resCard.error).toMatch(/exceeds maximum precision of 2 decimal places/);

        // Valid business purpose with below-min amount reaches amount validator
        const resPayroll = await paymentsAdapters.executePaymentRail({
            instruction_id: crypto.randomUUID(),
            amount: '0.10',
            currency: 'USD',
            purpose: 'PAYROLL',
        });
        expect(resPayroll.status).toBe('FAILED');
        expect(resPayroll.adapter_type).not.toBe('SIMULATED_BANK_RAIL');
        expect(resPayroll.adapter_type).not.toBe('STRIPE_UNSUPPORTED');
        expect(resPayroll.error).toMatch(/below Stripe minimum/);
    });

    test('7. BANK_RAILS policy is not exported and immutable', () => {
        expect(paymentsAdapters.BANK_RAILS).toBeUndefined();
        expect(() => {
            paymentsAdapters.BANK_RAILS = ['SWIFT'];
        }).toThrow(TypeError);
    });

    test('8. Stellar XLM Testnet routing and provider metadata are unaffected', () => {
        const {
            getProviderMetadata,
            verifyProviderIntegrity,
        } = require('../../core/orchestrator/providerDispatcher');
        const stellarMeta = getProviderMetadata('core_stellar');
        expect(stellarMeta).toBeDefined();
        expect(stellarMeta.id).toBe('core_stellar');
        expect(stellarMeta.currency).toBe('XLM');
        expect(stellarMeta.mode).toBe('TESTNET');
        expect(stellarMeta.instance).toBe(cryptoAdapters);
        expect(stellarMeta.executeFn).toBe(cryptoAdapters.executeCryptoRail);

        const integrity = verifyProviderIntegrity(stellarMeta);
        expect(integrity.isIntact).toBe(true);
        expect(integrity.binding.id).toBe('core_stellar');
    });

    test('9. RazorpayX Sandbox INR routing and provider metadata are unaffected', () => {
        const {
            getProviderMetadata,
            verifyProviderIntegrity,
        } = require('../../core/orchestrator/providerDispatcher');
        const razorpayMeta = getProviderMetadata('core_razorpay');
        expect(razorpayMeta).toBeDefined();
        expect(razorpayMeta.id).toBe('core_razorpay');
        expect(razorpayMeta.currency).toBe('INR');
        expect(razorpayMeta.mode).toBe('SANDBOX');
        expect(razorpayMeta.instance).toBe(razorpayAdapter);
        expect(razorpayMeta.executeFn).toBe(razorpayAdapter.executeRazorpayRail);

        const integrity = verifyProviderIntegrity(razorpayMeta);
        expect(integrity.isIntact).toBe(true);
        expect(integrity.binding.id).toBe('core_razorpay');
    });
});
