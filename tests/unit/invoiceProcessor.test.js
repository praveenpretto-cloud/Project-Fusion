'use strict';

/**
 * Unit tests for InvoiceProcessor module.
 * Tests all 4 primary methods with edge cases.
 *
 * Run: npm test -- tests/unit/invoiceProcessor.test.js
 */

const InvoiceProcessor = require('../../core/invoice/InvoiceProcessor');
const { validateStructuredAddress } = require('../../core/invoice/isoEnricher');
const { parseRawConditions } = require('../../core/invoice/conditionsEngine');

// ─── SHARED TEST FIXTURES ──────────────────────────────────────────────────────

const VALID_SELLER = {
    name: 'Coimbatore Textiles Pvt Ltd',
    gstPan: '33AABCC1234D1Z5',
    structuredAddress: {
        streetName: 'Avinashi Road',
        buildingNumber: '45-A',
        townName: 'Coimbatore',
        countrySubDivision: 'Tamil Nadu',
        postCode: '641014',
        country: 'IN',
    },
};

const VALID_BUYER = {
    name: 'GlobalThread Inc',
    structuredAddress: {
        streetName: 'Harbor Blvd',
        buildingNumber: '1400',
        townName: 'Fullerton',
        countrySubDivision: 'California',
        postCode: '92831',
        country: 'US',
    },
};

const VALID_INVOICE_OBJECT = {
    invoiceId: 'INV-TEST-0001',
    invoiceDate: '2025-04-15',
    dueDate: '2025-07-14',
    totalAmount: 85000.0,
    currency: 'USD',
    seller: VALID_SELLER,
    buyer: VALID_BUYER,
    lineItems: [
        { description: 'Cotton Yarn 40s', quantity: 100, unitPrice: 850.0, lineTotal: 85000.0 },
    ],
    paymentTermsDays: 90,
    rawConditions: '50% on shipment proof and 50% on buyer acceptance',
    extractedConditions: [],
};

// ──────────────────────────────────────────────────────────────────────────────
describe('InvoiceProcessor', () => {
    let processor;

    beforeEach(() => {
        processor = new InvoiceProcessor();
    });

    // ── parseInvoice: Object Input ─────────────────────────────────────────────
    describe('parseInvoice() — Object Input', () => {
        test('should parse a fully structured object correctly', async () => {
            const result = await processor.parseInvoice(VALID_INVOICE_OBJECT);
            expect(result).toBeDefined();
            expect(result.invoiceId).toBe('INV-TEST-0001');
            expect(result.totalAmount).toBe(85000.0);
            expect(result.currency).toBe('USD');
            expect(result.seller.name).toBe('Coimbatore Textiles Pvt Ltd');
            expect(result.buyer.name).toBe('GlobalThread Inc');
        });

        test('should auto-generate invoiceId when missing', async () => {
            const input = { ...VALID_INVOICE_OBJECT, invoiceId: undefined };
            const result = await processor.parseInvoice(input);
            expect(result.invoiceId).toMatch(/^INV-[A-F0-9]{12}$/);
        });

        test('should normalise DD/MM/YYYY dates to ISO format', async () => {
            const input = {
                ...VALID_INVOICE_OBJECT,
                invoiceDate: '15/04/2025',
                dueDate: '14/07/2025',
            };
            const result = await processor.parseInvoice(input);
            expect(result.invoiceDate).toBe('2025-04-15');
            expect(result.dueDate).toBe('2025-07-14');
        });

        test('should auto-calculate dueDate from invoiceDate + paymentTermsDays if dueDate missing', async () => {
            const input = { ...VALID_INVOICE_OBJECT, dueDate: undefined, paymentTermsDays: 60 };
            const result = await processor.parseInvoice(input);
            // 2025-04-15 + 60 days = 2025-06-14
            expect(result.dueDate).toBe('2025-06-14');
        });

        test('should normalise currency to uppercase', async () => {
            const input = { ...VALID_INVOICE_OBJECT, currency: 'usd' };
            const result = await processor.parseInvoice(input);
            expect(result.currency).toBe('USD');
        });

        test('should handle flexible CSV column aliases (seller_name, buyer_name, etc.)', async () => {
            const flatInput = {
                invoice_id: 'INV-FLAT-001',
                invoice_date: '2025-04-20',
                total_amount: '50000',
                currency: 'USD',
                seller_name: 'Test Seller',
                seller_street: 'MG Road',
                seller_city: 'Bangalore',
                seller_state: 'Karnataka',
                seller_pincode: '560001',
                seller_country: 'IN',
                buyer_name: 'Test Buyer',
                buyer_street: 'Main St',
                buyer_city: 'New York',
                buyer_state: 'New York',
                buyer_pincode: '10001',
                buyer_country: 'US',
                payment_terms_days: '90',
            };
            const result = await processor.parseInvoice(flatInput);
            expect(result.invoiceId).toBe('INV-FLAT-001');
            expect(result.totalAmount).toBe(50000);
            expect(result.seller.name).toBe('Test Seller');
            expect(result.buyer.structuredAddress.country).toBe('US');
        });
    });

    // ── parseInvoice: CSV String Input ─────────────────────────────────────────
    describe('parseInvoice() — CSV String Input', () => {
        test('should parse a CSV string with headers', async () => {
            const csv = `invoice_id,total_amount,currency,seller_name,buyer_name,payment_terms_days
INV-CSV-001,75000,USD,CSV Seller Corp,CSV Buyer Ltd,90`;
            const result = await processor.parseInvoice(csv);
            expect(result.invoiceId).toBe('INV-CSV-001');
            expect(result.totalAmount).toBe(75000);
            expect(result.seller.name).toBe('CSV Seller Corp');
        });

        test('should handle multi-row CSV and return array', async () => {
            const csv = `invoice_id,total_amount,currency,seller_name,buyer_name,payment_terms_days
INV-CSV-001,75000,USD,Seller A,Buyer A,90
INV-CSV-002,50000,EUR,Seller B,Buyer B,60`;
            const result = await processor.parseInvoice(csv);
            expect(Array.isArray(result)).toBe(true);
            expect(result).toHaveLength(2);
            expect(result[0].invoiceId).toBe('INV-CSV-001');
            expect(result[1].invoiceId).toBe('INV-CSV-002');
        });

        test('should handle Indian amount format with commas (1,00,000)', async () => {
            const csv = `invoice_id,total_amount,currency,seller_name,buyer_name\nINV-IN-001,"1,00,000",USD,Seller,Buyer`;
            const result = await processor.parseInvoice(csv);
            expect(result.totalAmount).toBe(100000);
        });
    });

    // ── parseInvoice: Array Input ──────────────────────────────────────────────
    describe('parseInvoice() — Array Input', () => {
        test('should process an array of 500 objects without blocking', async () => {
            const rows = Array.from({ length: 500 }, (_, i) => ({
                invoice_id: `INV-BULK-${String(i + 1).padStart(4, '0')}`,
                total_amount: (1000 + i).toString(),
                currency: 'USD',
                seller_name: `Seller ${i}`,
                buyer_name: `Buyer ${i}`,
                seller_street: 'MG Road',
                seller_city: 'Bangalore',
                seller_state: 'Karnataka',
                seller_pincode: '560001',
                seller_country: 'IN',
                buyer_street: 'Main St',
                buyer_city: 'New York',
                buyer_state: 'New York',
                buyer_pincode: '10001',
                buyer_country: 'US',
                payment_terms_days: '90',
            }));

            const result = await processor.parseInvoice(rows);
            expect(Array.isArray(result)).toBe(true);
            expect(result).toHaveLength(500);
            expect(result[0].invoiceId).toBe('INV-BULK-0001');
            expect(result[499].invoiceId).toBe('INV-BULK-0500');
        }, 10000); // 10s timeout for bulk
    });

    // ── enrichToISO ────────────────────────────────────────────────────────────
    describe('enrichToISO()', () => {
        test('should enrich a valid invoice with ISO 20022 blocks', async () => {
            const invoice = await processor.parseInvoice(VALID_INVOICE_OBJECT);
            const result = processor.enrichToISO(invoice);
            expect(result.success).toBe(true);
            expect(result.enriched).toBeDefined();
            expect(result.enriched.iso20022).toBeDefined();
            expect(result.enriched.iso20022.messageType).toBe('pacs.008.001.10');
            expect(
                result.enriched.iso20022.remittanceInfo.RmtInf.Strd.RfrdDocInf.Tp.CdOrPrtry.Cd
            ).toBe('CINV');
        });

        test('should fail enrichment for missing seller street name', async () => {
            const badInvoice = {
                ...VALID_INVOICE_OBJECT,
                seller: {
                    ...VALID_SELLER,
                    structuredAddress: { ...VALID_SELLER.structuredAddress, streetName: '' },
                },
            };
            const invoice = await processor.parseInvoice(badInvoice);
            const result = processor.enrichToISO(invoice);
            expect(result.success).toBe(false);
            expect(result.validationErrors.length).toBeGreaterThan(0);
            expect(result.validationErrors[0]).toContain('seller.structuredAddress.streetName');
        });

        test('should fail enrichment for invalid country code', async () => {
            const badInvoice = {
                ...VALID_INVOICE_OBJECT,
                seller: {
                    ...VALID_SELLER,
                    structuredAddress: { ...VALID_SELLER.structuredAddress, country: 'India' }, // should be 'IN'
                },
            };
            const invoice = await processor.parseInvoice(badInvoice);
            const result = processor.enrichToISO(invoice);
            expect(result.success).toBe(false);
            expect(result.validationErrors.some((e) => e.includes('ISO 3166-1 alpha-2'))).toBe(
                true
            );
        });

        test('should set FEMA IBU reporting flag for amounts > $25,000', async () => {
            const invoice = await processor.parseInvoice(VALID_INVOICE_OBJECT); // $85k
            const result = processor.enrichToISO(invoice);
            expect(result.success).toBe(true);
            expect(result.enriched.iso20022.femaReporting.required).toBe(true);
            expect(result.enriched.iso20022.femaReporting.section).toBe('FEMA_SEC_10_IBU');
        });

        test('should NOT set FEMA IBU flag for amounts <= $25,000', async () => {
            const invoice = await processor.parseInvoice({
                ...VALID_INVOICE_OBJECT,
                totalAmount: 10000,
            });
            const result = processor.enrichToISO(invoice);
            expect(result.success).toBe(true);
            expect(result.enriched.iso20022.femaReporting.required).toBe(false);
        });

        test('should fail enrichment when buyer structuredAddress is missing', async () => {
            const badInvoice = {
                ...VALID_INVOICE_OBJECT,
                buyer: {
                    name: 'Missing Address Corp',
                },
            };
            const invoice = await processor.parseInvoice(badInvoice);
            const result = processor.enrichToISO(invoice);
            expect(result.success).toBe(false);
            expect(result.enriched).toBeNull();
            expect(
                result.validationErrors.some((e) =>
                    e.includes('buyer.structuredAddress.streetName')
                )
            ).toBe(true);
        });

        test('should fail enrichment when Indian postCode is not 6 digits', async () => {
            const badInvoice = {
                ...VALID_INVOICE_OBJECT,
                seller: {
                    ...VALID_SELLER,
                    structuredAddress: { ...VALID_SELLER.structuredAddress, postCode: '64101' },
                },
            };
            const invoice = await processor.parseInvoice(badInvoice);
            const result = processor.enrichToISO(invoice);
            expect(result.success).toBe(false);
            expect(result.enriched).toBeNull();
            expect(result.validationErrors.some((e) => e.includes('6 digits'))).toBe(true);
        });

        test('should succeed and normalise state codes and country for fully valid addresses', async () => {
            const validInvoice = {
                ...VALID_INVOICE_OBJECT,
                seller: {
                    ...VALID_SELLER,
                    structuredAddress: {
                        ...VALID_SELLER.structuredAddress,
                        countrySubDivision: 'Tamil Nadu',
                        country: 'IN',
                    },
                },
            };
            const invoice = await processor.parseInvoice(validInvoice);
            const result = processor.enrichToISO(invoice);
            expect(result.success).toBe(true);
            expect(result.enriched).toBeDefined();
            expect(result.enriched.seller.structuredAddress.countrySubDivision).toBe('TN');
            expect(result.enriched.seller.structuredAddress.country).toBe('IN');
            expect(result.validationErrors).toHaveLength(0);
        });
    });

    // ── createProgrammableConditions ───────────────────────────────────────────
    describe('createProgrammableConditions()', () => {
        test('should parse "50% on shipment, 50% on acceptance" correctly', async () => {
            const invoice = await processor.parseInvoice(VALID_INVOICE_OBJECT);
            const result = processor.createProgrammableConditions(invoice);
            expect(result.extractedConditions.length).toBeGreaterThan(0);
            const shipment = result.extractedConditions.find(
                (c) => c.milestone === 'shipment_proof'
            );
            const acceptance = result.extractedConditions.find(
                (c) => c.milestone === 'buyer_acceptance'
            );
            expect(shipment).toBeDefined();
            expect(acceptance).toBeDefined();
            // Total must be 100%
            const total = result.extractedConditions.reduce((s, c) => s + c.percentage, 0);
            expect(Math.abs(total - 100)).toBeLessThan(0.01);
        });

        test('should use default exporter rules when no conditions are given', async () => {
            const invoice = await processor.parseInvoice({
                ...VALID_INVOICE_OBJECT,
                rawConditions: '',
            });
            const result = processor.createProgrammableConditions(invoice);
            expect(result.useDefaultRules).toBe(true);
            expect(result.extractedConditions.length).toBeGreaterThan(0);
        });

        test('should handle "Net 60" payment terms', async () => {
            const invoice = await processor.parseInvoice({
                ...VALID_INVOICE_OBJECT,
                rawConditions: 'Net 60 days',
                paymentTermsDays: 60,
            });
            const result = processor.createProgrammableConditions(invoice);
            const dueDateStep = result.extractedConditions.find(
                (c) => c.triggerType === 'due_date'
            );
            expect(dueDateStep).toBeDefined();
            expect(dueDateStep.timeoutDays).toBe(60);
        });

        test('should handle "Net 90" payment terms', async () => {
            const invoice = await processor.parseInvoice({
                ...VALID_INVOICE_OBJECT,
                rawConditions: 'Net 90 days',
                paymentTermsDays: 90,
            });
            const result = processor.createProgrammableConditions(invoice);
            expect(result.extractedConditions[0].timeoutDays).toBe(90);
        });

        test('saga steps must match 1:1 with extractedConditions', async () => {
            const invoice = await processor.parseInvoice(VALID_INVOICE_OBJECT);
            const result = processor.createProgrammableConditions(invoice);
            expect(result.sagaSteps.length).toBe(result.extractedConditions.length);
        });

        test('should flag escrow_required on non-immediate milestone steps', async () => {
            const invoice = await processor.parseInvoice(VALID_INVOICE_OBJECT);
            const result = processor.createProgrammableConditions(invoice);
            const escrowSteps = result.sagaSteps.filter((s) => s.escrow_required);
            expect(escrowSteps.length).toBeGreaterThan(0);
        });

        test('each saga step should have a compensatingAction defined', async () => {
            const invoice = await processor.parseInvoice(VALID_INVOICE_OBJECT);
            const result = processor.createProgrammableConditions(invoice);
            for (const step of result.sagaSteps) {
                expect(step.compensatingAction).toBeDefined();
                expect(step.compensatingAction).toContain('refund_hold');
            }
        });
    });

    // ── createSagaConfig ────────────────────────────────────────────────────────
    describe('createSagaConfig()', () => {
        test('should produce a valid saga config with correct structure', async () => {
            const invoice = await processor.parseInvoice(VALID_INVOICE_OBJECT);
            const sagaConfig = processor.createSagaConfig(invoice);
            expect(sagaConfig).toBeDefined();
            expect(sagaConfig.sagaId).toMatch(/^SAGA-INV-[A-F0-9]{16}$/);
            expect(sagaConfig.invoiceId).toBe('INV-TEST-0001');
            expect(sagaConfig.steps).toBeDefined();
            expect(sagaConfig.instructions).toBeDefined();
        });

        test('should produce the same sagaId for the same invoiceId (idempotency)', async () => {
            const invoice1 = await processor.parseInvoice({ ...VALID_INVOICE_OBJECT });
            const invoice2 = await processor.parseInvoice({ ...VALID_INVOICE_OBJECT });
            const config1 = processor.createSagaConfig(invoice1);
            const config2 = processor.createSagaConfig(invoice2);
            expect(config1.sagaId).toBe(config2.sagaId);
        });

        test('instructions should be in PENDING_APPROVAL state', async () => {
            const invoice = await processor.parseInvoice(VALID_INVOICE_OBJECT);
            const sagaConfig = processor.createSagaConfig(invoice);
            for (const inst of sagaConfig.instructions) {
                expect(inst.state).toBe('PENDING_APPROVAL');
            }
        });

        test('instruction amounts should sum to totalAmount', async () => {
            const invoice = await processor.parseInvoice(VALID_INVOICE_OBJECT);
            const sagaConfig = processor.createSagaConfig(invoice);
            const total = sagaConfig.instructions.reduce((s, i) => s + parseFloat(i.amount), 0);
            expect(Math.abs(total - VALID_INVOICE_OBJECT.totalAmount)).toBeLessThan(0.01);
        });

        test('should include regulatory flags', async () => {
            const invoice = await processor.parseInvoice(VALID_INVOICE_OBJECT);
            const sagaConfig = processor.createSagaConfig(invoice);
            expect(sagaConfig.regulatory).toBeDefined();
            expect(sagaConfig.regulatory.giftIFSCPSR2024).toBe(true);
            expect(sagaConfig.regulatory.purposeCode).toBe('IVPT');
        });

        test('each instruction should have invoice metadata', async () => {
            const invoice = await processor.parseInvoice(VALID_INVOICE_OBJECT);
            const sagaConfig = processor.createSagaConfig(invoice);
            for (const inst of sagaConfig.instructions) {
                expect(inst._invoiceMeta).toBeDefined();
                expect(inst._invoiceMeta.invoiceId).toBe('INV-TEST-0001');
                expect(inst._invoiceMeta.compensatingAction).toBeDefined();
            }
        });
    });

    // ── processInvoice: Full Pipeline ──────────────────────────────────────────
    describe('processInvoice() — Full Pipeline', () => {
        test('should run the full pipeline on a valid invoice object', async () => {
            const result = await processor.processInvoice(VALID_INVOICE_OBJECT);
            expect(result.success).toBe(true);
            expect(result.invoice).toBeDefined();
            expect(result.isoResult.success).toBe(true);
            expect(result.conditionsResult).toBeDefined();
            expect(result.sagaConfig).toBeDefined();
            expect(result.errors).toHaveLength(0);
        });

        test('should process CSV with 500 rows without timeout', async () => {
            const rows = Array.from({ length: 500 }, (_, i) => ({
                invoice_id: `INV-BIG-${i + 1}`,
                total_amount: '10000',
                currency: 'USD',
                seller_name: `Seller ${i}`,
                buyer_name: `Buyer ${i}`,
                seller_street: 'Test Street',
                seller_city: 'Chennai',
                seller_state: 'Tamil Nadu',
                seller_pincode: '600001',
                seller_country: 'IN',
                buyer_street: 'Main Ave',
                buyer_city: 'Los Angeles',
                buyer_state: 'California',
                buyer_pincode: '90001',
                buyer_country: 'US',
                payment_terms_days: '90',
            }));

            const result = await processor.processInvoice(rows);
            expect(result.isBulk).toBe(true);
            expect(result.total).toBe(500);
        }, 30000); // 30s timeout for 500 items

        test('should return ISO errors but still produce sagaConfig when address is incomplete', async () => {
            const badInput = {
                ...VALID_INVOICE_OBJECT,
                seller: {
                    ...VALID_SELLER,
                    structuredAddress: { ...VALID_SELLER.structuredAddress, streetName: '' },
                },
            };
            const result = await processor.processInvoice(badInput);
            // Should still produce sagaConfig despite ISO errors
            expect(result.sagaConfig).toBeDefined();
            expect(result.isoResult.success).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        });
    });

    // ── Edge Cases ─────────────────────────────────────────────────────────────
    describe('Edge Cases', () => {
        test('should throw for empty input', async () => {
            await expect(processor.parseInvoice(null)).rejects.toThrow('input is required');
        });

        test('should throw for unsupported input type (number)', async () => {
            await expect(processor.parseInvoice(42)).rejects.toThrow('unsupported input type');
        });

        test('should handle invoice with no line items gracefully', async () => {
            const invoice = await processor.parseInvoice({
                ...VALID_INVOICE_OBJECT,
                lineItems: undefined,
            });
            expect(invoice.lineItems).toEqual([]);
        });

        test('should handle zero amount invoice (warn, not throw)', async () => {
            const invoice = await processor.parseInvoice({
                ...VALID_INVOICE_OBJECT,
                totalAmount: 0,
            });
            expect(invoice.totalAmount).toBe(0);
            // Should still create saga config
            const sagaConfig = processor.createSagaConfig(invoice);
            expect(sagaConfig).toBeDefined();
        });
    });
});

// ── Isolated unit tests for sub-modules ────────────────────────────────────────
describe('validateStructuredAddress()', () => {
    test('should return no errors for a valid address', () => {
        const result = validateStructuredAddress(VALID_SELLER.structuredAddress, 'seller');
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    test('should return errors for missing fields', () => {
        const result = validateStructuredAddress({ country: 'IN', townName: 'Chennai' }, 'seller');
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    test('should catch invalid country code', () => {
        const addr = { ...VALID_SELLER.structuredAddress, country: 'INDIA' };
        const result = validateStructuredAddress(addr, 'seller');
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('ISO 3166-1 alpha-2'))).toBe(true);
    });

    test('should return error when address is not an object or null', () => {
        const resultNull = validateStructuredAddress(null, 'buyer');
        expect(resultNull.valid).toBe(false);
        expect(resultNull.errors[0]).toContain('buyer.address is missing or not an object');

        const resultString = validateStructuredAddress('123 Main St', 'buyer');
        expect(resultString.valid).toBe(false);
        expect(resultString.errors[0]).toContain('buyer.address is missing or not an object');
    });

    test('should return error when Indian postCode has non-digits or incorrect length', () => {
        const addrShort = { ...VALID_SELLER.structuredAddress, postCode: '6410' };
        expect(validateStructuredAddress(addrShort, 'seller').valid).toBe(false);

        const addrAlpha = { ...VALID_SELLER.structuredAddress, postCode: '64101A' };
        expect(validateStructuredAddress(addrAlpha, 'seller').valid).toBe(false);
    });
});

describe('parseRawConditions()', () => {
    test('"50% on shipment, 50% on acceptance" → 2 conditions', () => {
        const result = parseRawConditions('50% on shipment, 50% on acceptance', 90);
        expect(result.length).toBe(2);
        expect(result[0].milestone).toBe('shipment_proof');
        expect(result[1].milestone).toBe('buyer_acceptance');
    });

    test('"Net 60" → 1 due_date condition', () => {
        const result = parseRawConditions('Net 60 days', 60);
        expect(result.length).toBe(1);
        expect(result[0].triggerType).toBe('due_date');
        expect(result[0].timeoutDays).toBe(60);
    });

    test('empty string → empty array (default rules applied upstream)', () => {
        const result = parseRawConditions('', 90);
        expect(result).toEqual([]);
    });
});
