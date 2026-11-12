'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * INVOICE PROCESSOR — Project Fusion GIFT City IFSC
 * ISO 20022-Ready Programmable Invoice Engine
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Converts raw invoices (CSV bulk / PDF / plain object) into:
 *  1. A normalised InvoiceObject (structured, validated)
 *  2. An ISO 20022-enriched payment instruction (pacs.008)
 *  3. A programmable conditions array (escrow milestones)
 *  4. A Saga config ready for processInstructionSagaAtomic() or runExporterFxSaga()
 *
 * REGULATORY CONTEXT:
 *  - ISO 20022 CBPR+ Phase 2: Nov 2026 structured address mandate
 *  - IFSCA PSR 2024: Escrow via IBU/IBC for conditional holds
 *  - FEMA 1999 §8/§10: Export remittance > $25k needs IBU reporting
 *  - No INR e-wallets — only permitted foreign currencies for GIFT IFSC rails
 *
 * INTEGRATION PATTERN (Saga):
 *  InvoiceProcessor.createSagaConfig(invoice)
 *    → Produces instruction(s) in state PENDING_APPROVAL
 *    → Operator calls POST /api/instruction/approve to trigger settlement
 *    → sagaCore.processInstructionSagaAtomic() handles atomic execution
 *
 * PERFORMANCE:
 *  - Bulk CSV: streaming parse, no blocking, chunked at 50 per batch
 *  - PDF: async pdf2json parse, resolved as Promise
 *  - All methods are async-safe and idempotent via invoiceId
 *
 * IDEMPOTENCY:
 *  - invoiceId + sagaId pair used as dedup keys
 *  - Same invoiceId submitted twice returns the same sagaConfig (no duplicate execution)
 */

const crypto = require('crypto');
const { parse: csvParse } = require('csv-parse/sync');
const logger = require('../../logger');

// Sub-modules (isolated, no circular deps)
const { enrichToISO } = require('./isoEnricher');
const { createProgrammableConditions } = require('./conditionsEngine');
const { parsePdfInvoice } = require('./pdfParser');

// ─── CSV COLUMN MAPPINGS ───────────────────────────────────────────────────────
// Maps flexible CSV header names to canonical InvoiceObject field names.
// Handles common variations in Indian SME exports.
const CSV_COLUMN_MAP = {
    // Invoice identifiers
    invoice_id: 'invoiceId',
    invoice_no: 'invoiceId',
    invoice_number: 'invoiceId',
    inv_no: 'invoiceId',
    bill_no: 'invoiceId',
    // Dates
    invoice_date: 'invoiceDate',
    bill_date: 'invoiceDate',
    due_date: 'dueDate',
    payment_due_date: 'dueDate',
    maturity_date: 'dueDate',
    // Amounts
    total_amount: 'totalAmount',
    amount: 'totalAmount',
    invoice_amount: 'totalAmount',
    grand_total: 'totalAmount',
    net_payable: 'totalAmount',
    // Currency
    currency: 'currency',
    ccy: 'currency',
    // Seller
    seller_name: 'seller_name',
    seller: 'seller_name',
    exporter_name: 'seller_name',
    vendor_name: 'seller_name',
    seller_gstin: 'seller_gstin',
    seller_gst: 'seller_gstin',
    gstin: 'seller_gstin',
    gst_pan: 'seller_gstin',
    seller_street: 'seller_street',
    seller_building: 'seller_building',
    seller_city: 'seller_city',
    seller_town: 'seller_city',
    seller_state: 'seller_state',
    seller_pincode: 'seller_pincode',
    seller_postcode: 'seller_pincode',
    seller_country: 'seller_country',
    // Buyer
    buyer_name: 'buyer_name',
    buyer: 'buyer_name',
    importer_name: 'buyer_name',
    customer_name: 'buyer_name',
    buyer_street: 'buyer_street',
    buyer_building: 'buyer_building',
    buyer_city: 'buyer_city',
    buyer_town: 'buyer_city',
    buyer_state: 'buyer_state',
    buyer_pincode: 'buyer_pincode',
    buyer_postcode: 'buyer_pincode',
    buyer_country: 'buyer_country',
    // Payment terms
    payment_terms: 'rawConditions',
    payment_terms_days: 'paymentTermsDays',
    net_days: 'paymentTermsDays',
    terms_days: 'paymentTermsDays',
};

/**
 * InvoiceProcessor — Main class.
 *
 * Usage:
 *   const processor = new InvoiceProcessor();
 *   const invoice = await processor.parseInvoice(input);
 *   const enriched = processor.enrichToISO(invoice);
 *   const sagaConfig = processor.createSagaConfig(enriched.enriched);
 */
class InvoiceProcessor {
    constructor() {
        this.BULK_CHUNK_SIZE = 50; // Process in chunks of 50 for bulk uploads
    }

    // ══════════════════════════════════════════════════════════════════════════
    // METHOD 1: parseInvoice
    // Detects input type and dispatches to the correct parser.
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Parses an invoice from any supported input format.
     *
     * @param {Buffer|string|Object|Array} input
     *   - Buffer: treated as PDF binary data
     *   - string: treated as CSV text (may be single row or multi-row)
     *   - Object: treated as pre-structured invoice (maps fields to canonical shape)
     *   - Array: treated as bulk CSV JSON (same as /api/instruction/initiate format)
     *
     * @returns {Promise<Object|Array>}
     *   - Single invoice: returns one normalised InvoiceObject
     *   - Bulk: returns array of normalised InvoiceObjects
     */
    async parseInvoice(input) {
        if (!input) throw new Error('InvoiceProcessor.parseInvoice: input is required');

        // ── PDF Buffer ─────────────────────────────────────────────────────────
        if (Buffer.isBuffer(input)) {
            logger.info('[INVOICE_PROCESSOR] Input type: PDF Buffer');
            return await this._parsePdf(input);
        }

        // ── Plain Object (single pre-structured invoice) ───────────────────────
        if (typeof input === 'object' && !Array.isArray(input)) {
            logger.info('[INVOICE_PROCESSOR] Input type: Structured Object');
            return this._parseObject(input);
        }

        // ── Array (bulk JSON objects — same shape as CSV parsed rows) ──────────
        if (Array.isArray(input)) {
            logger.info(`[INVOICE_PROCESSOR] Input type: JSON Array (${input.length} rows)`);
            return this._parseBulkArray(input);
        }

        // ── CSV String ─────────────────────────────────────────────────────────
        if (typeof input === 'string') {
            const trimmed = input.trim();

            // Detect if it's a single-line CSV row or multi-line
            if (trimmed.includes('\n') || trimmed.includes(',')) {
                logger.info('[INVOICE_PROCESSOR] Input type: CSV String');
                return this._parseCsvString(trimmed);
            }

            throw new Error('InvoiceProcessor.parseInvoice: string input must be valid CSV text');
        }

        throw new Error(`InvoiceProcessor.parseInvoice: unsupported input type: ${typeof input}`);
    }

    // ─── INTERNAL: PDF Parser ──────────────────────────────────────────────────

    async _parsePdf(buffer) {
        const invoice = await parsePdfInvoice(buffer);
        return this._validate(invoice);
    }

    // ─── INTERNAL: Object Parser ───────────────────────────────────────────────

    _parseObject(raw) {
        // Handle both canonical field names and flexible aliases
        const mapped = this._mapFields(raw);
        const invoice = this._buildInvoiceObject(mapped);
        return this._validate(invoice);
    }

    // ─── INTERNAL: CSV String Parser ──────────────────────────────────────────

    _parseCsvString(csvText) {
        let rows;
        try {
            rows = csvParse(csvText, {
                columns: true, // First row is header
                skip_empty_lines: true,
                trim: true,
                relax_quotes: true, // Handles messy Indian CSV exports
                relax_column_count: true, // Handles rows with extra commas
            });
        } catch (csvErr) {
            throw new Error(`CSV parsing failed: ${csvErr.message}`);
        }

        if (rows.length === 0) throw new Error('CSV has no data rows');

        if (rows.length === 1) {
            return this._parseObject(rows[0]);
        }

        return this._parseBulkArray(rows);
    }

    // ─── INTERNAL: Bulk Array Parser ───────────────────────────────────────────

    _parseBulkArray(rows) {
        logger.info(`[INVOICE_PROCESSOR] Parsing bulk array of ${rows.length} invoices`);
        // Process synchronously in chunks — no blocking since this is CPU-only
        const results = [];
        for (const row of rows) {
            try {
                results.push(this._parseObject(row));
            } catch (err) {
                logger.warn(`[INVOICE_PROCESSOR] ⚠️ Skipping malformed row: ${err.message}`);
                results.push({ _parseError: err.message, _rawRow: row });
            }
        }
        return results;
    }

    // ─── INTERNAL: Field Mapper ────────────────────────────────────────────────

    /**
     * Maps flexible input field names to canonical names via CSV_COLUMN_MAP.
     * Case-insensitive, handles underscores/spaces interchangeably.
     *
     * @param {Object} raw
     * @returns {Object} Mapped object with canonical field names
     */
    _mapFields(raw) {
        // Canonical camelCase keys that must NEVER be lowercased/remapped
        const CANONICAL_PASS_THROUGH = new Set([
            'invoiceId',
            'invoiceDate',
            'dueDate',
            'totalAmount',
            'currency',
            'lineItems',
            'paymentTermsDays',
            'rawConditions',
            'extractedConditions',
            'sourceType',
            'seller',
            'buyer',
            'iso20022',
            'enrichmentHash',
            'isoCompliant',
            'enrichedAt',
            'amlPreCheck',
            '_pdfMeta',
        ]);

        const mapped = {};
        for (const [key, value] of Object.entries(raw)) {
            // 1. If key is already a canonical camelCase field, pass through unchanged
            if (CANONICAL_PASS_THROUGH.has(key)) {
                mapped[key] = value;
                continue;
            }

            // 2. If the value is a nested object (e.g. seller/buyer with structuredAddress),
            //    preserve it under its original key — do NOT remap to CSV alias.
            if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                mapped[key] = value;
                continue;
            }

            // 3. Flat string/number values from CSV rows — apply CSV alias mapping
            const normKey = key.toLowerCase().replace(/[\s-]/g, '_');
            const canonicalKey = CSV_COLUMN_MAP[normKey] || normKey;
            mapped[canonicalKey] = value;
        }
        return mapped;
    }

    // ─── INTERNAL: Build Canonical InvoiceObject ────────────────────────────────

    /**
     * Builds the canonical InvoiceObject from a mapped field set.
     * Auto-generates missing required fields where safe to do so.
     *
     * @param {Object} mapped
     * @returns {Object} Normalised InvoiceObject
     */
    _buildInvoiceObject(mapped) {
        // ── Invoice ID (idempotency key) ─────────────────────────────────────
        const invoiceId =
            (mapped.invoiceId || mapped.invoice_id || '').toString().trim() ||
            `INV-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

        // ── Dates ────────────────────────────────────────────────────────────
        const invoiceDate =
            this._normaliseDate(mapped.invoiceDate || mapped.invoice_date) ||
            new Date().toISOString().split('T')[0];

        const paymentTermsDays =
            parseInt(mapped.paymentTermsDays || mapped.payment_terms_days || 90) || 90;

        let dueDate = this._normaliseDate(mapped.dueDate || mapped.due_date);
        if (!dueDate) {
            // Auto-calculate from invoice date + payment terms
            const dueDateMs =
                new Date(invoiceDate).getTime() + paymentTermsDays * 24 * 60 * 60 * 1000;
            dueDate = new Date(dueDateMs).toISOString().split('T')[0];
        }

        // ── Amount & Currency ────────────────────────────────────────────────
        const totalAmount =
            parseFloat(String(mapped.totalAmount || mapped.amount || 0).replace(/,/g, '')) || 0;

        const currency = (mapped.currency || 'USD').toString().trim().toUpperCase();

        // ── Seller ───────────────────────────────────────────────────────────
        const seller = {
            name: (mapped.seller_name || mapped.seller?.name || '').toString().trim(),
            gstPan: (mapped.seller_gstin || mapped.seller?.gstPan || '').toString().trim() || null,
            structuredAddress: {
                streetName:
                    mapped.seller_street || mapped.seller?.structuredAddress?.streetName || '',
                buildingNumber:
                    mapped.seller_building ||
                    mapped.seller?.structuredAddress?.buildingNumber ||
                    '',
                townName:
                    mapped.seller_city ||
                    mapped.seller_town ||
                    mapped.seller?.structuredAddress?.townName ||
                    '',
                countrySubDivision:
                    mapped.seller_state ||
                    mapped.seller?.structuredAddress?.countrySubDivision ||
                    '',
                postCode: (
                    mapped.seller_pincode ||
                    mapped.seller_postcode ||
                    mapped.seller?.structuredAddress?.postCode ||
                    ''
                )
                    .toString()
                    .trim(),
                country: (
                    mapped.seller_country ||
                    mapped.seller?.structuredAddress?.country ||
                    'IN'
                ).toUpperCase(),
            },
        };

        // Allow pre-built seller.structuredAddress to pass through directly
        if (mapped.seller && typeof mapped.seller === 'object' && mapped.seller.structuredAddress) {
            seller.structuredAddress = {
                ...seller.structuredAddress,
                ...mapped.seller.structuredAddress,
            };
            seller.name = seller.name || mapped.seller.name || '';
            seller.gstPan = seller.gstPan || mapped.seller.gstPan || null;
        }

        // ── Buyer ─────────────────────────────────────────────────────────────
        const buyer = {
            name: (mapped.buyer_name || mapped.buyer?.name || '').toString().trim(),
            structuredAddress: {
                streetName:
                    mapped.buyer_street || mapped.buyer?.structuredAddress?.streetName || '',
                buildingNumber:
                    mapped.buyer_building || mapped.buyer?.structuredAddress?.buildingNumber || '',
                townName:
                    mapped.buyer_city ||
                    mapped.buyer_town ||
                    mapped.buyer?.structuredAddress?.townName ||
                    '',
                countrySubDivision:
                    mapped.buyer_state || mapped.buyer?.structuredAddress?.countrySubDivision || '',
                postCode: (
                    mapped.buyer_pincode ||
                    mapped.buyer_postcode ||
                    mapped.buyer?.structuredAddress?.postCode ||
                    ''
                )
                    .toString()
                    .trim(),
                country: (
                    mapped.buyer_country ||
                    mapped.buyer?.structuredAddress?.country ||
                    'US'
                ).toUpperCase(),
            },
        };

        if (mapped.buyer && typeof mapped.buyer === 'object' && mapped.buyer.structuredAddress) {
            buyer.structuredAddress = {
                ...buyer.structuredAddress,
                ...mapped.buyer.structuredAddress,
            };
            buyer.name = buyer.name || mapped.buyer.name || '';
        }

        // ── Line Items ────────────────────────────────────────────────────────
        const lineItems = mapped.lineItems || mapped.line_items || [];

        // ── Payment Conditions ────────────────────────────────────────────────
        const rawConditions = mapped.rawConditions || mapped.payment_terms || '';

        return {
            invoiceId,
            invoiceDate,
            dueDate,
            totalAmount,
            currency,
            seller,
            buyer,
            lineItems: Array.isArray(lineItems) ? lineItems : [],
            paymentTermsDays,
            rawConditions,
            extractedConditions: [], // Populated by createProgrammableConditions()
            sourceType: mapped.sourceType || 'object',
        };
    }

    // ─── INTERNAL: Date Normalisation ──────────────────────────────────────────

    _normaliseDate(raw) {
        if (!raw) return null;
        const str = String(raw).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
        const ddmmyyyy = str.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
        if (ddmmyyyy) {
            const [, dd, mm, yyyy] = ddmmyyyy;
            return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
        }
        // ISO timestamp → date only
        const isoMatch = str.match(/^(\d{4}-\d{2}-\d{2})T/);
        if (isoMatch) return isoMatch[1];
        return null;
    }

    // ─── INTERNAL: Validation ──────────────────────────────────────────────────

    /**
     * Validates the normalised invoice object.
     * Logs warnings for missing optional fields.
     * Throws for missing critical fields.
     *
     * @param {Object} invoice
     * @returns {Object} The same invoice object (pass-through for chaining)
     */
    _validate(invoice) {
        if (!invoice.invoiceId) throw new Error('Invoice must have an invoiceId');
        if (!invoice.totalAmount || invoice.totalAmount <= 0) {
            logger.warn(
                `[INVOICE_PROCESSOR] ⚠️ Invoice ${invoice.invoiceId} has zero or missing totalAmount`
            );
        }
        if (!invoice.currency) {
            logger.warn(
                `[INVOICE_PROCESSOR] ⚠️ Invoice ${invoice.invoiceId} missing currency — defaulting to USD`
            );
            invoice.currency = 'USD';
        }
        if (!invoice.seller?.name) {
            logger.warn(`[INVOICE_PROCESSOR] ⚠️ Invoice ${invoice.invoiceId} missing seller name`);
        }
        if (!invoice.buyer?.name) {
            logger.warn(`[INVOICE_PROCESSOR] ⚠️ Invoice ${invoice.invoiceId} missing buyer name`);
        }
        return invoice;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // METHOD 2: enrichToISO
    // Enforces ISO 20022 structured address and adds remittance block.
    // Delegates to isoEnricher.js — hard fails on missing address fields.
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Enriches a normalised invoice to ISO 20022 compliance.
     * Will NOT fallback to unstructured addresses — returns validation errors instead.
     *
     * @param {Object} invoice - From parseInvoice()
     * @returns {{ success: boolean, enriched: Object|null, validationErrors: string[] }}
     */
    enrichToISO(invoice) {
        if (!invoice || !invoice.invoiceId) {
            throw new Error('enrichToISO requires a valid invoice object from parseInvoice()');
        }
        return enrichToISO(invoice);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // METHOD 3: createProgrammableConditions
    // Converts invoice payment terms into saga-compatible step array.
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Converts invoice payment conditions to programmable saga steps.
     * Applies default GIFT City exporter rules if no specific terms are given.
     *
     * @param {Object} invoice - Normalised or enriched invoice object
     * @returns {{ extractedConditions: Array, sagaSteps: Array, useDefaultRules: boolean, totalEscrowAmount: number }}
     */
    createProgrammableConditions(invoice) {
        if (!invoice || !invoice.invoiceId) {
            throw new Error('createProgrammableConditions requires a valid invoice object');
        }
        const result = createProgrammableConditions(invoice);
        // Attach conditions to invoice object for downstream use
        invoice.extractedConditions = result.extractedConditions;
        return result;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // METHOD 4: createSagaConfig
    // Builds a Saga config that slots directly into the existing orchestrators.
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Creates a Saga configuration object compatible with:
     *  - processInstructionSagaAtomic() in core/orchestrator/sagaCore.js
     *  - runExporterFxSaga() in core/saga/exporterFxManagement.js
     *
     * The output produces one instruction per saga step, all in PENDING_APPROVAL state.
     * Operator must call POST /api/instruction/approve to trigger execution.
     *
     * IDEMPOTENCY: Same invoiceId always produces the same sagaId.
     *
     * @param {Object} invoice - Normalised and preferably enriched invoice
     * @returns {Object} sagaConfig
     */
    createSagaConfig(invoice) {
        if (!invoice || !invoice.invoiceId) {
            throw new Error('createSagaConfig requires a valid invoice object');
        }

        // Run conditions if not already done
        let conditionsResult;
        if (!invoice.extractedConditions || invoice.extractedConditions.length === 0) {
            conditionsResult = this.createProgrammableConditions(invoice);
        } else {
            conditionsResult = {
                extractedConditions: invoice.extractedConditions,
                sagaSteps: [], // Will rebuild below
                useDefaultRules: false,
            };
            // Rebuild sagaSteps from extractedConditions
            const { conditionsToSagaSteps } = require('./conditionsEngine');
            conditionsResult.sagaSteps = conditionsToSagaSteps(
                invoice.extractedConditions,
                invoice.totalAmount,
                invoice.currency
            );
        }

        const { sagaSteps } = conditionsResult;

        // IDEMPOTENT saga ID — same invoice always maps to same saga
        const sagaId = `SAGA-INV-${crypto
            .createHash('sha256')
            .update(invoice.invoiceId)
            .digest('hex')
            .substring(0, 16)
            .toUpperCase()}`;

        const instructions = sagaSteps.map((step, idx) => {
            const stepIdStr = `${sagaId}-STEP-${String(idx + 1).padStart(2, '0')}`;
            const hash = crypto.createHash('md5').update(stepIdStr).digest('hex');
            const detUuid = `${hash.substring(0, 8)}-${hash.substring(8, 12)}-4${hash.substring(13, 16)}-a${hash.substring(17, 20)}-${hash.substring(20, 32)}`;
            return {
                instruction_id: detUuid,
                amount: step.amountAbsolute.toString(),
                currency: step.currency,
                sender: invoice.buyer.name, // Buyer is the payer
                recipient: invoice.seller.name, // Seller is the payee
                purpose: `INVOICE_PAYMENT_${step.condition.toUpperCase()}`,
                state: 'PENDING_APPROVAL', // Human approval required before saga triggers
                provider: null, // Determined at routing time by sagaCore
                net_amount: step.amountAbsolute,
                tax_withheld: 0, // Calculated by complianceInterceptor at execution
                // Invoice-specific metadata (stored in saga_state JSON column)
                _invoiceMeta: {
                    invoiceId: invoice.invoiceId,
                    sagaId,
                    stepId: step.stepId,
                    stepIndex: idx + 1,
                    totalSteps: sagaSteps.length,
                    condition: step.condition,
                    triggerType: step.triggerType,
                    timeoutDays: step.timeoutDays,
                    escrow_required: step.escrow_required,
                    escrow_note: step.escrow_note,
                    amountPct: step.amountPct,
                    rail: step.rail,
                    compensatingAction: step.compensatingAction,
                },
            };
        });

        // Saga config shape for logging/audit (not directly passed to orchestrator)
        const sagaConfig = {
            sagaId,
            invoiceId: invoice.invoiceId,
            invoiceDate: invoice.invoiceDate,
            dueDate: invoice.dueDate,
            totalAmount: invoice.totalAmount,
            currency: invoice.currency,
            seller: {
                name: invoice.seller.name,
                gstPan: invoice.seller.gstPan,
            },
            buyer: {
                name: invoice.buyer.name,
            },
            paymentTermsDays: invoice.paymentTermsDays,
            steps: sagaSteps,
            instructions,
            useDefaultRules: conditionsResult.useDefaultRules,
            totalEscrowAmount: conditionsResult.totalEscrowAmount || 0,
            hasEscrow: sagaSteps.some((s) => s.escrow_required),
            // Regulatory flags
            regulatory: {
                isoMessageType: invoice.iso20022?.messageType || 'pacs.008.001.10',
                femaReporting: invoice.iso20022?.femaReporting || null,
                purposeCode: 'IVPT',
                giftIFSCPSR2024: true,
                escrowNote:
                    '[PROTOTYPE] Conditional holds shadow-debited on balances table. Production requires IBU escrow at GIFT City.',
            },
            // Full ISO 20022 envelope if enrichment was done
            iso20022: invoice.iso20022 || null,
            // State machine
            sagaState: {
                currentStep: null,
                lastStep: 'INVOICE_PARSED',
                approvalPending: true,
                createdAt: new Date().toISOString(),
            },
            createdAt: new Date().toISOString(),
        };

        logger.info(
            `[INVOICE_PROCESSOR] ✅ Saga config created: ${sagaId} | ${sagaSteps.length} steps | ${invoice.currency} ${invoice.totalAmount} | Escrow: ${sagaConfig.hasEscrow}`
        );

        return sagaConfig;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // FULL PIPELINE CONVENIENCE METHOD
    // parse → enrich → conditions → sagaConfig in one call
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Runs the full processing pipeline on a raw input.
     * Suitable for single invoice processing via API.
     *
     * @param {Buffer|string|Object} input
     * @returns {Promise<{ invoice, isoResult, conditionsResult, sagaConfig, success, errors }>}
     */
    async processInvoice(input) {
        const errors = [];

        // Step 1: Parse
        let invoice;
        try {
            invoice = await this.parseInvoice(input);
            // If bulk, process each independently
            if (Array.isArray(invoice)) {
                logger.info(
                    `[INVOICE_PROCESSOR] Bulk pipeline: processing ${invoice.length} invoices`
                );
                return await this._processBulkPipeline(invoice);
            }
        } catch (parseErr) {
            return { success: false, errors: [`PARSE_FAILED: ${parseErr.message}`] };
        }

        // Step 2: ISO Enrichment
        const isoResult = this.enrichToISO(invoice);
        if (!isoResult.success) {
            errors.push(...isoResult.validationErrors);
            // Populate iso20022 as null but continue — let caller decide to reject or flag
            invoice.iso20022 = null;
            invoice.isoCompliant = false;
        } else {
            // Merge enriched fields back
            Object.assign(invoice, isoResult.enriched);
        }

        // Step 3: Programmable Conditions
        const conditionsResult = this.createProgrammableConditions(invoice);

        // Step 4: Saga Config
        const sagaConfig = this.createSagaConfig(invoice);

        return {
            success: errors.length === 0,
            invoice,
            isoResult,
            conditionsResult,
            sagaConfig,
            errors,
        };
    }

    /**
     * Processes a bulk array of invoices, non-blocking, chunked.
     *
     * @param {Array} invoices - Array of parsed InvoiceObjects
     * @returns {Promise<Object>} Bulk processing result
     */
    async _processBulkPipeline(invoices) {
        const results = [];
        const CHUNK_SIZE = this.BULK_CHUNK_SIZE;

        for (let i = 0; i < invoices.length; i += CHUNK_SIZE) {
            const chunk = invoices.slice(i, i + CHUNK_SIZE);
            logger.info(
                `[INVOICE_PROCESSOR] Bulk chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(invoices.length / CHUNK_SIZE)} (${chunk.length} invoices)`
            );

            // Process chunk (synchronous — CPU only, no I/O blocking)
            for (const invoice of chunk) {
                if (invoice._parseError) {
                    results.push({
                        success: false,
                        errors: [invoice._parseError],
                        _rawRow: invoice._rawRow,
                    });
                    continue;
                }

                const isoResult = this.enrichToISO(invoice);
                if (isoResult.success) Object.assign(invoice, isoResult.enriched);

                const conditionsResult = this.createProgrammableConditions(invoice);
                const sagaConfig = this.createSagaConfig(invoice);

                results.push({
                    success: isoResult.success,
                    invoice,
                    isoResult,
                    conditionsResult,
                    sagaConfig,
                    errors: isoResult.validationErrors || [],
                });
            }

            // Yield to event loop between chunks to prevent blocking (non-blocking promise tick)
            if (i + CHUNK_SIZE < invoices.length) {
                await new Promise((resolve) => setImmediate(resolve));
            }
        }

        const successCount = results.filter((r) => r.success).length;
        logger.info(
            `[INVOICE_PROCESSOR] ✅ Bulk complete: ${successCount}/${invoices.length} processed successfully`
        );

        return {
            success: true,
            isBulk: true,
            total: invoices.length,
            successCount,
            failureCount: invoices.length - successCount,
            results,
        };
    }
}

module.exports = InvoiceProcessor;
