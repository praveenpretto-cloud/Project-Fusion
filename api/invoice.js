'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * INVOICE API ROUTER — /api/invoice/*
 * GIFT City IFSC Invoice Processing Endpoints
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ALL ROUTES ARE ISOLATED UNDER /api/invoice/* ONLY.
 * ZERO CHANGES TO EXISTING ROUTES (/api/instruction/*, /api/saga/*, etc.)
 *
 * Routes:
 *  POST /api/invoice/process          → Full pipeline: single invoice → sagaConfig
 *  POST /api/invoice/bulk             → Bulk CSV processing (500+ rows, non-blocking)
 *  POST /api/invoice/upload-pdf       → PDF upload via multipart/form-data
 *  GET  /api/invoice/:invoiceId       → Fetch recorded invoice by ID
 *  GET  /api/invoice/:invoiceId/saga-config → Get saga config for an invoice
 *
 * AUTH: All routes require x-api-key header (same as existing API middleware).
 *
 * SAGA INTEGRATION NOTE:
 *  - Processing creates instruction records in state PENDING_APPROVAL.
 *  - Operator must call POST /api/instruction/approve to trigger the saga.
 *  - This is intentional — human approval gate per GIFT IFSC institutional requirements.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const logger = require('../logger');
const InvoiceProcessor = require('../core/invoice/InvoiceProcessor');

// ── MULTER: Memory storage for PDF uploads (no disk write, direct buffer processing) ─
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') return cb(null, true);
        cb(new Error('Only PDF files are accepted for invoice upload'));
    },
});

// Singleton processor instance (no state — safe to share across requests)
const processor = new InvoiceProcessor();

// ─── RESPONSE HELPERS ──────────────────────────────────────────────────────────

function apiSuccess(res, data, statusCode = 200) {
    return res.status(statusCode).json({
        success: true,
        timestamp: new Date().toISOString(),
        ...data,
    });
}

function apiError(res, message, details = null, statusCode = 400) {
    logger.warn(`[INVOICE_API] Error response: ${message}`);
    return res.status(statusCode).json({
        success: false,
        error: message,
        details,
        timestamp: new Date().toISOString(),
    });
}

// ─── DB HELPERS ────────────────────────────────────────────────────────────────

/**
 * Persists a processed invoice and its saga steps to the database.
 * Uses INSERT ... ON CONFLICT DO NOTHING for idempotency.
 *
 * @param {Object} pool - pg Pool from app.locals
 * @param {Object} invoice - Normalised invoice object
 * @param {Object} sagaConfig - Saga configuration object
 * @param {string} sourceType - 'csv', 'pdf', 'object'
 */
async function persistInvoice(pool, invoice, sagaConfig, sourceType) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Persist invoice record (idempotent)
        await client.query(
            `INSERT INTO invoices (
               invoice_id, saga_id, invoice_date, due_date, total_amount, currency,
               seller_name, seller_gst_pan, buyer_name, payment_terms_days,
               iso_enriched, saga_config, raw_conditions, state, source_type,
               created_at, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())
             ON CONFLICT (invoice_id) DO UPDATE SET
               saga_config = EXCLUDED.saga_config,
               state = 'PENDING_APPROVAL',
               updated_at = NOW()`,
            [
                invoice.invoiceId,
                sagaConfig.sagaId,
                invoice.invoiceDate,
                invoice.dueDate,
                invoice.totalAmount,
                invoice.currency,
                invoice.seller?.name || null,
                invoice.seller?.gstPan || null,
                invoice.buyer?.name || null,
                invoice.paymentTermsDays,
                JSON.stringify(invoice.iso20022 || {}),
                JSON.stringify(sagaConfig),
                invoice.rawConditions || null,
                'PENDING_APPROVAL',
                sourceType,
            ]
        );

        // Persist saga step records (for audit trail and step tracking)
        for (const step of sagaConfig.steps || []) {
            await client.query(
                `INSERT INTO invoice_saga_steps (
                   invoice_id, step_id, amount_pct, condition, rail, status, escrow_flagged, created_at
                 ) VALUES ($1,$2,$3,$4,$5,'PENDING',$6,NOW())
                 ON CONFLICT DO NOTHING`,
                [
                    invoice.invoiceId,
                    step.stepId,
                    step.amountPct,
                    step.condition,
                    step.rail,
                    step.escrow_required || false,
                ]
            );
        }

        // Persist instructions to the existing instructions table so /api/instruction/approve works
        for (const inst of sagaConfig.instructions || []) {
            await client.query(
                `INSERT INTO instructions (
                   instruction_id, amount, currency, sender, recipient, purpose,
                   state, provider, saga_state, created_at, updated_at, net_amount, tax_withheld
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW(),$10,$11)
                 ON CONFLICT (instruction_id) DO NOTHING`,
                [
                    inst.instruction_id,
                    inst.amount,
                    inst.currency,
                    inst.sender,
                    inst.recipient,
                    inst.purpose,
                    'PENDING_APPROVAL',
                    null,
                    JSON.stringify(inst._invoiceMeta || {}),
                    inst.net_amount || inst.amount,
                    inst.tax_withheld || 0,
                ]
            );
        }

        await client.query('COMMIT');
        logger.info(
            `[INVOICE_API] ✅ Persisted invoice ${invoice.invoiceId} with ${sagaConfig.steps?.length || 0} saga steps and ${sagaConfig.instructions?.length || 0} instructions`
        );
    } catch (dbErr) {
        await client.query('ROLLBACK');
        logger.error(
            `[INVOICE_API] ❌ DB persist failed for ${invoice.invoiceId}: ${dbErr.message}`
        );
        throw dbErr;
    } finally {
        client.release();
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE 1: POST /api/invoice/process
// Full pipeline for a single invoice (JSON body or CSV row).
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @openapi
 * /api/invoice/process:
 *   post:
 *     summary: Process a single invoice through the full pipeline
 *     description: |
 *       Accepts a structured invoice object (or CSV row JSON) and runs it through:
 *       parse → ISO 20022 enrichment → programmable conditions → saga config.
 *       Creates instruction records in PENDING_APPROVAL state. Operator must
 *       call POST /api/instruction/approve to trigger actual settlement.
 *     tags: [Invoice]
 *     security:
 *       - ApiKeyAuth: []
 */
router.post('/process', async (req, res) => {
    const pool = req.app.locals.pool;

    try {
        const input = req.body;

        if (!input || Object.keys(input).length === 0) {
            return apiError(
                res,
                'Request body is required',
                'Provide a structured invoice object',
                400
            );
        }

        logger.info(`[INVOICE_API] POST /process — Processing single invoice`);

        const result = await processor.processInvoice(input);

        if (!result.success && result.errors?.length > 0 && !result.sagaConfig) {
            return apiError(res, 'Invoice processing failed', result.errors, 422);
        }

        // Persist to DB (idempotent)
        try {
            await persistInvoice(
                pool,
                result.invoice,
                result.sagaConfig,
                result.invoice.sourceType || 'object'
            );
        } catch (dbErr) {
            logger.error(`[INVOICE_API] DB persist failed: ${dbErr.message}`);
            // Return saga config even if DB failed — let operator retry persist
        }

        return apiSuccess(
            res,
            {
                message: result.success
                    ? 'Invoice processed and instructions queued for approval'
                    : 'Invoice processed with ISO validation warnings — review required before approval',
                invoiceId: result.invoice.invoiceId,
                sagaId: result.sagaConfig.sagaId,
                isoCompliant: result.isoResult?.success || false,
                hasEscrow: result.sagaConfig.hasEscrow,
                totalSteps: result.sagaConfig.steps?.length || 0,
                instructionIds: result.sagaConfig.instructions?.map((i) => i.instruction_id) || [],
                approvalRequired: true,
                approvalNote:
                    'Call POST /api/instruction/approve with the instructionIds to trigger settlement',
                sagaConfig: result.sagaConfig,
                validationErrors: result.errors || [],
            },
            202
        );
    } catch (err) {
        logger.error(`[INVOICE_API] /process error: ${err.message}`);
        return apiError(res, 'Invoice processing failed', err.message, 500);
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE 2: POST /api/invoice/bulk
// Bulk CSV processing — handles 500+ rows non-blocking via chunked processing.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @openapi
 * /api/invoice/bulk:
 *   post:
 *     summary: Process bulk invoices from CSV text or JSON array
 *     description: |
 *       Accepts a CSV string (Content-Type: text/csv) or JSON array
 *       (Content-Type: application/json) of invoice rows.
 *       Processes in chunks of 50 — non-blocking. Returns aggregate results.
 *     tags: [Invoice]
 */
router.post('/bulk', async (req, res) => {
    const pool = req.app.locals.pool;

    try {
        let input;
        const contentType = req.headers['content-type'] || '';

        if (contentType.includes('text/csv')) {
            // Raw CSV body
            let csvText = '';
            req.on('data', (chunk) => {
                csvText += chunk.toString();
            });
            await new Promise((resolve) => req.on('end', resolve));
            input = csvText;
        } else if (Array.isArray(req.body)) {
            input = req.body;
        } else if (req.body?.csvData) {
            // CSV text inside JSON payload
            input = req.body.csvData;
        } else {
            return apiError(
                res,
                'Bulk endpoint requires JSON array or CSV text',
                'Set Content-Type to text/csv for CSV uploads',
                400
            );
        }

        logger.info(`[INVOICE_API] POST /bulk — Bulk invoice processing initiated`);

        const result = await processor.processInvoice(input);

        if (!result.isBulk) {
            // processInvoice returned a single result — wrap it
            const wrapped = {
                isBulk: true,
                total: 1,
                successCount: result.success ? 1 : 0,
                failureCount: result.success ? 0 : 1,
                results: [result],
            };
            Object.assign(result, wrapped);
        }

        // Persist all successful results to DB
        let persistedCount = 0;
        for (const r of result.results) {
            if (r.success && r.invoice && r.sagaConfig) {
                try {
                    await persistInvoice(pool, r.invoice, r.sagaConfig, 'csv');
                    persistedCount++;
                } catch (dbErr) {
                    logger.error(
                        `[INVOICE_API] Bulk persist failed for ${r.invoice?.invoiceId}: ${dbErr.message}`
                    );
                }
            }
        }

        // Gather all instruction IDs for approval
        const allInstructionIds = result.results
            .filter((r) => r.success && r.sagaConfig)
            .flatMap((r) => r.sagaConfig.instructions?.map((i) => i.instruction_id) || []);

        return apiSuccess(
            res,
            {
                message: `Bulk processing complete: ${result.successCount}/${result.total} invoices processed`,
                total: result.total,
                successCount: result.successCount,
                failureCount: result.failureCount,
                persistedCount,
                approvalRequired: true,
                approvalNote:
                    'Call POST /api/instruction/approve with instructionIds array to trigger settlement for each invoice',
                instructionIds: allInstructionIds,
                results: result.results.map((r) => ({
                    invoiceId: r.invoice?.invoiceId || null,
                    sagaId: r.sagaConfig?.sagaId || null,
                    success: r.success,
                    isoCompliant: r.isoResult?.success || false,
                    steps: r.sagaConfig?.steps?.length || 0,
                    errors: r.errors || [],
                })),
            },
            202
        );
    } catch (err) {
        logger.error(`[INVOICE_API] /bulk error: ${err.message}`);
        return apiError(res, 'Bulk invoice processing failed', err.message, 500);
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE 3: POST /api/invoice/upload-pdf
// Multipart PDF upload — extracts invoice data from PDF buffer.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @openapi
 * /api/invoice/upload-pdf:
 *   post:
 *     summary: Upload a PDF invoice for automated extraction
 *     description: |
 *       Accepts a PDF file upload (multipart/form-data, field name: "invoice").
 *       Uses pdf2json + rule-based regex to extract invoice fields.
 *       Returns extracted data + saga config. Address fields flagged for review
 *       if extraction confidence is LOW.
 *     tags: [Invoice]
 */
router.post('/upload-pdf', upload.single('invoice'), async (req, res) => {
    const pool = req.app.locals.pool;

    try {
        if (!req.file) {
            return apiError(
                res,
                'PDF file is required',
                'Upload a PDF using form field name "invoice"',
                400
            );
        }

        logger.info(
            `[INVOICE_API] POST /upload-pdf — PDF received: ${req.file.originalname} (${req.file.size} bytes)`
        );

        const result = await processor.processInvoice(req.file.buffer);

        // Persist to DB
        try {
            await persistInvoice(pool, result.invoice, result.sagaConfig, 'pdf');
        } catch (dbErr) {
            logger.error(`[INVOICE_API] PDF persist failed: ${dbErr.message}`);
        }

        const confidence = result.invoice?._pdfMeta?.extractionConfidence || 'UNKNOWN';

        return apiSuccess(
            res,
            {
                message: `PDF invoice extracted with ${confidence} confidence`,
                invoiceId: result.invoice.invoiceId,
                sagaId: result.sagaConfig.sagaId,
                extractionConfidence: confidence,
                isoCompliant: result.isoResult?.success || false,
                extractedFields: {
                    invoiceDate: result.invoice.invoiceDate,
                    dueDate: result.invoice.dueDate,
                    totalAmount: result.invoice.totalAmount,
                    currency: result.invoice.currency,
                    sellerName: result.invoice.seller?.name,
                    buyerName: result.invoice.buyer?.name,
                    lineItemCount: result.invoice.lineItems?.length || 0,
                },
                approvalRequired: true,
                approvalNote:
                    confidence !== 'HIGH'
                        ? '⚠️ Extraction confidence is not HIGH — please review extracted fields before approving instructions'
                        : 'Call POST /api/instruction/approve with instructionIds to trigger settlement',
                instructionIds: result.sagaConfig.instructions?.map((i) => i.instruction_id) || [],
                sagaConfig: result.sagaConfig,
                validationErrors: result.errors || [],
            },
            202
        );
    } catch (err) {
        logger.error(`[INVOICE_API] /upload-pdf error: ${err.message}`);
        return apiError(res, 'PDF processing failed', err.message, 500);
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE 4: GET /api/invoice/list
// Fetch all recorded invoices (paginated).
// IMPORTANT: Must be registered BEFORE /:invoiceId to avoid being matched as a param.
// ══════════════════════════════════════════════════════════════════════════════

router.get('/list', async (req, res) => {
    const pool = req.app.locals.pool;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    try {
        const result = await pool.query(
            'SELECT invoice_id, saga_id, state, total_amount, currency, seller_name, buyer_name, created_at, source_type FROM invoices ORDER BY created_at DESC LIMIT $1 OFFSET $2',
            [limit, offset]
        );

        return apiSuccess(res, {
            count: result.rows.length,
            data: result.rows,
        });
    } catch (err) {
        logger.error(`[INVOICE_API] GET /list error: ${err.message}`);
        return apiError(res, 'Failed to fetch invoice list', err.message, 500);
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE 5: GET /api/invoice/:invoiceId
// Fetch a recorded invoice by ID.
// ══════════════════════════════════════════════════════════════════════════════

router.get('/:invoiceId', async (req, res) => {
    const pool = req.app.locals.pool;
    const { invoiceId } = req.params;

    try {
        const result = await pool.query('SELECT * FROM invoices WHERE invoice_id = $1', [
            invoiceId,
        ]);

        if (result.rows.length === 0) {
            return apiError(res, `Invoice ${invoiceId} not found`, null, 404);
        }

        const inv = result.rows[0];
        return apiSuccess(res, {
            invoiceId: inv.invoice_id,
            sagaId: inv.saga_id,
            state: inv.state,
            invoiceDate: inv.invoice_date,
            dueDate: inv.due_date,
            totalAmount: parseFloat(inv.total_amount),
            currency: inv.currency,
            sellerName: inv.seller_name,
            buyerName: inv.buyer_name,
            paymentTermsDays: inv.payment_terms_days,
            sourceType: inv.source_type,
            rawConditions: inv.raw_conditions,
            createdAt: inv.created_at,
            updatedAt: inv.updated_at,
        });
    } catch (err) {
        logger.error(`[INVOICE_API] GET /${invoiceId} error: ${err.message}`);
        return apiError(res, 'Failed to fetch invoice', err.message, 500);
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE 6: GET /api/invoice/:invoiceId/saga-config
// Returns the full saga configuration for an invoice.
// ══════════════════════════════════════════════════════════════════════════════

router.get('/:invoiceId/saga-config', async (req, res) => {
    const pool = req.app.locals.pool;
    const { invoiceId } = req.params;

    try {
        const result = await pool.query(
            'SELECT saga_config, iso_enriched, state FROM invoices WHERE invoice_id = $1',
            [invoiceId]
        );

        if (result.rows.length === 0) {
            return apiError(res, `Invoice ${invoiceId} not found`, null, 404);
        }

        const inv = result.rows[0];
        const sagaConfig = inv.saga_config;
        const isoEnriched = inv.iso_enriched;

        // Also fetch step statuses
        const stepsResult = await pool.query(
            'SELECT * FROM invoice_saga_steps WHERE invoice_id = $1 ORDER BY id ASC',
            [invoiceId]
        );

        return apiSuccess(res, {
            invoiceId,
            invoiceState: inv.state,
            sagaConfig,
            isoEnriched,
            steps: stepsResult.rows,
        });
    } catch (err) {
        logger.error(`[INVOICE_API] GET /${invoiceId}/saga-config error: ${err.message}`);
        return apiError(res, 'Failed to fetch saga config', err.message, 500);
    }
});

// (Route /list was moved above /:invoiceId — see Route 4 above)

// ── MULTER ERROR HANDLER (scoped to this router) ──────────────────────────────
router.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
        return apiError(res, 'PDF file too large', 'Maximum file size is 10MB', 413);
    }
    if (err.message?.includes('Only PDF files')) {
        return apiError(res, 'Invalid file type', err.message, 415);
    }
    next(err);
});

module.exports = router;
