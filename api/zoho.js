'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════
 * ZOHO API ROUTER — api/zoho.js
 * Routes:
 *   POST /api/zoho/webhook          → Receives Zoho invoice events
 *   GET  /api/zoho/pull             → Manually pulls pending invoices
 *   GET  /api/zoho/invoice-status/:zohoInvoiceId → Status tracking
 *   POST /api/zoho/reconcile/sweep  → Trigger daily reconciliation
 *   GET  /api/compliance/documents/:instructionId → Fetch compliance docs
 * ═══════════════════════════════════════════════════════════════════
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const logger  = require('../logger');

const { fetchPendingInvoices, fetchInvoiceById, normalizeZohoInvoice } = require('../adapters/zohoAdapter');
const { evaluateInvoice, applyDecisionToInstruction } = require('../core/decisioning/decisionEngine');
const { runDailyReconciliationSweep, getReconciliationStatus } = require('../core/reconciliation/reconciliationService');
const InvoiceProcessor = require('../core/invoice/InvoiceProcessor');

const processor = new InvoiceProcessor();

// ── HELPERS ──────────────────────────────────────────────────────────────────

function ok(res, data, status = 200) {
    return res.status(status).json({ success: true, timestamp: new Date().toISOString(), ...data });
}
function fail(res, message, detail = null, status = 400) {
    return res.status(status).json({ success: false, error: message, detail, timestamp: new Date().toISOString() });
}

/**
 * Core pipeline: normalize → decision → process → persist → (auto-approve?)
 */
async function processZohoInvoice(pool, rawZohoInvoice) {
    // Step 1: Normalize Zoho → Fusion schema
    const normalized = normalizeZohoInvoice(rawZohoInvoice);

    // Step 2: Payment decisioning
    const decision = evaluateInvoice(normalized);

    // Step 3: Apply decision to instruction state
    const enriched = applyDecisionToInstruction(normalized, decision);

    // Step 4: Run through InvoiceProcessor (ISO20022 enrichment + saga config generation)
    const result = await processor.processInvoice(enriched);

    if (!result.sagaConfig) {
        throw new Error(`InvoiceProcessor failed for Zoho invoice ${rawZohoInvoice.invoice_id}`);
    }

    // Step 5: Persist to DB with zoho_invoice_id stored on instructions
    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');

        // Insert into invoices table
        await dbClient.query(
            `INSERT INTO invoices (
               invoice_id, saga_id, invoice_date, due_date, total_amount, currency,
               seller_name, seller_gst_pan, buyer_name, payment_terms_days,
               iso_enriched, saga_config, state, source_type, created_at, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())
             ON CONFLICT (invoice_id) DO UPDATE SET
               state = CASE WHEN invoices.state IN ('INITIATED', 'SETTLED', 'PENDING_EXECUTION') THEN invoices.state ELSE EXCLUDED.state END,
               updated_at = NOW()`,
            [
                result.invoice.invoiceId,
                result.sagaConfig.sagaId,
                result.invoice.invoiceDate,
                result.invoice.dueDate,
                result.invoice.totalAmount,
                result.invoice.currency,
                result.invoice.seller?.name || null,
                result.invoice.seller?.gstPan || null,
                result.invoice.buyer?.name || null,
                result.invoice.paymentTermsDays || 30,
                JSON.stringify(result.invoice.iso20022 || {}),
                JSON.stringify(result.sagaConfig),
                enriched.state,
                'zoho',
            ]
        );

        // Insert instructions with zoho_invoice_id
        for (const inst of result.sagaConfig.instructions || []) {
            const instState = decision.autoApprove ? 'INITIATED' : 'PENDING_APPROVAL';
            await dbClient.query(
                `INSERT INTO instructions (
                   instruction_id, amount, currency, sender, recipient, purpose,
                   state, provider, created_at, updated_at, net_amount, tax_withheld,
                   source, zoho_invoice_id
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW(),$9,$10,$11,$12)
                 ON CONFLICT (instruction_id) DO NOTHING`,
                [
                    inst.instruction_id,
                    inst.amount,
                    inst.currency,
                    inst.sender,
                    inst.recipient,
                    inst.purpose,
                    instState,
                    null,
                    inst.net_amount || inst.amount,
                    inst.tax_withheld || 0,
                    'zoho',
                    rawZohoInvoice.invoice_id,
                ]
            );
        }

        await dbClient.query('COMMIT');
    } catch (err) {
        await dbClient.query('ROLLBACK');
        throw err;
    } finally {
        dbClient.release();
    }

    // Step 6: Auto-approve — trigger SAGA immediately for qualifying invoices
    if (decision.autoApprove) {
        const { processInstructionSagaAtomic } = require('../core/orchestrator/sagaCore');
        for (const inst of result.sagaConfig.instructions || []) {
            processInstructionSagaAtomic(inst.instruction_id, pool)
                .catch(e => logger.error(`[ZOHO_AUTO] SAGA error for ${inst.instruction_id}: ${e.message}`));
        }
        logger.info(`[ZOHO] ✅ Auto-approved and triggered SAGA for ${result.sagaConfig.instructions?.length} instruction(s)`);
    }

    return { result, decision, normalized };
}

// ════════════════════════════════════════════════════════════════════════════
// ROUTE 1: POST /api/zoho/webhook
// Receives real-time events from Zoho Books (invoice.created, payment.received)
// ════════════════════════════════════════════════════════════════════════════
router.post('/webhook', async (req, res) => {
    const pool = req.app.locals.pool;

    try {
        const event = req.body;
        logger.info(`[ZOHO_WEBHOOK] Event received: ${event?.event_type || 'unknown'}`);

        // Verify webhook secret if configured
        const webhookSecret = process.env.ZOHO_WEBHOOK_SECRET;
        const incoming      = req.headers['x-zoho-webhook-secret'] || req.headers['authorization'];
        if (webhookSecret && incoming && incoming !== webhookSecret) {
            logger.warn('[ZOHO_WEBHOOK] Invalid webhook secret — rejected');
            return fail(res, 'Unauthorized', null, 401);
        }

        // Only process invoice creation events
        if (!event?.event_type?.includes('invoice')) {
            return ok(res, { message: `Event type ${event?.event_type} ignored` });
        }

        const invoiceData = event?.data?.invoice || event?.invoice;
        if (!invoiceData) {
            return fail(res, 'No invoice data in webhook payload');
        }

        // Fetch full invoice details from Zoho (webhook only sends summary)
        let fullInvoice;
        try {
            fullInvoice = await fetchInvoiceById(invoiceData.invoice_id);
        } catch (fetchErr) {
            logger.warn(`[ZOHO_WEBHOOK] Could not fetch full invoice — using webhook payload: ${fetchErr.message}`);
            fullInvoice = invoiceData;
        }

        const { result, decision } = await processZohoInvoice(pool, fullInvoice);

        logger.info(`[ZOHO_WEBHOOK] ✅ Processed invoice ${fullInvoice.invoice_id} → ${decision.action}`);

        return ok(res, {
            message:     'Invoice processed',
            invoiceId:   result.invoice.invoiceId,
            decision:    decision.action,
            urgency:     decision.urgency,
            autoApprove: decision.autoApprove,
            instructions: result.sagaConfig?.instructions?.map(i => i.instruction_id) || [],
        }, 202);

    } catch (err) {
        logger.error(`[ZOHO_WEBHOOK] Error: ${err.message}`);
        return fail(res, 'Webhook processing failed', err.message, 500);
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTE 2: GET /api/zoho/pull
// Manually pulls all pending invoices from Zoho and ingests them
// ════════════════════════════════════════════════════════════════════════════
router.get('/pull', async (req, res) => {
    const pool = req.app.locals.pool;

    try {
        logger.info('[ZOHO] Manual pull triggered');
        const invoices = await fetchPendingInvoices();

        if (invoices.length === 0) {
            return ok(res, { message: 'No pending invoices found in Zoho Books', count: 0 });
        }

        const results = [];
        for (const invoice of invoices) {
            try {
                const { result, decision } = await processZohoInvoice(pool, invoice);
                results.push({
                    zohoInvoiceId: invoice.invoice_id,
                    fusionId:      result.invoice.invoiceId,
                    decision:      decision.action,
                    urgency:       decision.urgency,
                    amount:        invoice.total,
                    currency:      invoice.currency_code,
                    success:       true,
                });
            } catch (err) {
                results.push({ zohoInvoiceId: invoice.invoice_id, success: false, error: err.message });
            }
        }

        const successCount = results.filter(r => r.success).length;
        return ok(res, {
            message:      `Pulled and processed ${successCount}/${invoices.length} invoices`,
            total:        invoices.length,
            successCount,
            results,
        });

    } catch (err) {
        logger.error(`[ZOHO] Pull error: ${err.message}`);
        return fail(res, 'Failed to pull invoices from Zoho', err.message, 500);
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTE 3: GET /api/zoho/invoice-status/:zohoInvoiceId
// Status tracking — given Zoho invoice ID, return Fusion pipeline state
// ════════════════════════════════════════════════════════════════════════════
router.get('/invoice-status/:zohoInvoiceId', async (req, res) => {
    const pool = req.app.locals.pool;
    const { zohoInvoiceId } = req.params;

    try {
        // Find the instruction linked to this Zoho invoice
        const instrResult = await pool.query(
            `SELECT i.instruction_id, i.state, i.amount, i.currency, i.external_intent_id, i.utr,
                    i.updated_at, i.source, i.zoho_invoice_id, i.net_amount, i.tax_withheld
             FROM instructions i
             WHERE i.zoho_invoice_id = $1
             ORDER BY i.created_at DESC`,
            [zohoInvoiceId]
        );

        if (instrResult.rows.length === 0) {
            return fail(res, `No Fusion instruction found for Zoho invoice ${zohoInvoiceId}`, null, 404);
        }

        const instructions = instrResult.rows;
        const primary = instructions[0];

        // Get reconciliation status
        const recon = await getReconciliationStatus(pool, primary.instruction_id);

        // Get compliance documents
        const docsResult = await pool.query(
            `SELECT doc_type, generated_at FROM compliance_documents WHERE instruction_id = $1`,
            [primary.instruction_id]
        );

        return ok(res, {
            zohoInvoiceId,
            fusionInstructionId: primary.instruction_id,
            state:               primary.state,
            amount:              parseFloat(primary.amount),
            netAmount:           parseFloat(primary.net_amount || primary.amount),
            taxWithheld:         parseFloat(primary.tax_withheld || 0),
            currency:            primary.currency,
            settlementRef:       primary.currency === 'INR' ? (primary.utr || primary.external_intent_id) : primary.external_intent_id,
            utr:                 primary.utr || null,
            lastUpdated:         primary.updated_at,
            reconciliation: {
                status:          recon?.status || 'PENDING',
                reconciledAt:    recon?.reconciled_at || null,
                zohoPaymentId:   recon?.zoho_payment_id || null,
            },
            complianceDocs:      docsResult.rows,
            allInstructions:     instructions.map(i => ({
                id:       i.instruction_id,
                state:    i.state,
                amount:   parseFloat(i.amount),
                currency: i.currency,
            })),
        });

    } catch (err) {
        logger.error(`[ZOHO] invoice-status error: ${err.message}`);
        return fail(res, 'Failed to fetch invoice status', err.message, 500);
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTE 4: POST /api/zoho/reconcile/sweep
// Triggers the daily reconciliation sweep manually
// ════════════════════════════════════════════════════════════════════════════
router.post('/reconcile/sweep', async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        logger.info('[ZOHO] Manual reconciliation sweep triggered');
        const result = await runDailyReconciliationSweep(pool);
        return ok(res, {
            message: 'Reconciliation sweep complete',
            ...result,
        });
    } catch (err) {
        logger.error(`[ZOHO] Sweep error: ${err.message}`);
        return fail(res, 'Reconciliation sweep failed', err.message, 500);
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTE 5: GET /api/zoho/compliance/documents/:instructionId
// Returns all compliance documents for an instruction
// ════════════════════════════════════════════════════════════════════════════
router.get('/compliance/documents/:instructionId', async (req, res) => {
    const pool = req.app.locals.pool;
    const { instructionId } = req.params;

    try {
        const result = await pool.query(
            `SELECT doc_id, doc_type, doc_payload, generated_at, zoho_invoice_id
             FROM compliance_documents
             WHERE instruction_id = $1
             ORDER BY generated_at ASC`,
            [instructionId]
        );

        return ok(res, {
            instructionId,
            count: result.rows.length,
            documents: result.rows.map(r => ({
                docId:         r.doc_id,
                docType:       r.doc_type,
                zohoInvoiceId: r.zoho_invoice_id,
                generatedAt:   r.generated_at,
                payload:       r.doc_payload,
            })),
        });

    } catch (err) {
        logger.error(`[ZOHO] compliance docs error: ${err.message}`);
        return fail(res, 'Failed to fetch compliance documents', err.message, 500);
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTE 6: POST /api/zoho/pay/:zohoInvoiceId
// Execute payment for a Zoho invoice via Fusion's SAGA payment rails.
// Body: { rail, currency, payer, draft }
// ════════════════════════════════════════════════════════════════════════════
router.post('/pay/:zohoInvoiceId', async (req, res) => {
    const pool = req.app.locals.pool;
    const { zohoInvoiceId } = req.params;
    const { rail, currency, payer = 'Alice_Corp', draft = false } = req.body;

    const VALID_RAILS = [
        'core_razorpay', 'legacy_fiat', 'legacy_crypto',
    ];

    if (!rail) return fail(res, 'Payment rail is required. Provide { rail, currency, payer }', null, 400);
    if (!VALID_RAILS.includes(rail)) return fail(res, `Invalid rail. Must be one of: ${VALID_RAILS.join(', ')}`, null, 400);

    try {
        // ── Step 1: Look up invoice in Fusion DB ──────────────────────────
        const invResult = await pool.query(
            `SELECT invoice_id, total_amount, currency, seller_name, buyer_name, state
             FROM invoices WHERE invoice_id = $1 OR invoice_id = $2`,
            [zohoInvoiceId, `ZOHO-${zohoInvoiceId}`]
        );

        if (invResult.rows.length === 0) {
            return fail(res, `Invoice not found in Fusion DB. Pull it from Zoho first.`, null, 404);
        }

        const inv = invResult.rows[0];
        const paymentCurrency = currency || inv.currency || 'INR';
        const paymentAmount   = parseFloat(inv.total_amount);

        logger.info(`[ZOHO_PAY] Initiating payment for ${inv.invoice_id}: ${paymentAmount} ${paymentCurrency} via ${rail}`);

        // ── Step 2: Auto-generate OTP auth token ─────────────────────────
        const { processInstructionSagaAtomic } = require('../core/orchestrator/sagaCore');
        const instructionId = crypto.randomUUID();

        // ── Step 3: Persist the instruction ──────────────────────────────
        const initialState = draft ? 'PENDING_APPROVAL' : 'INITIATED';
        await pool.query(
            `INSERT INTO instructions (
               instruction_id, amount, currency, sender, recipient, purpose,
               state, provider, created_at, updated_at, net_amount, tax_withheld,
               source, zoho_invoice_id
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW(),$9,$10,$11,$12)
             ON CONFLICT (instruction_id) DO NOTHING`,
            [
                instructionId,
                paymentAmount,
                paymentCurrency,
                payer,
                inv.seller_name || inv.buyer_name || 'ZOHO_VENDOR',
                paymentCurrency === 'INR' ? 'DOMESTIC_PAYMENT' : 'EXPORT_INVOICE',
                initialState,
                rail,
                paymentAmount,   // net_amount (TDS handled by SAGA)
                0,               // tax_withheld
                'zoho',
                zohoInvoiceId,
            ]
        );

        // ── Step 4: Update invoice state ───────────────────────────────
        await pool.query(
            `UPDATE invoices SET state = $1, updated_at = NOW() WHERE invoice_id = $2`,
            [initialState, inv.invoice_id]
        );

        // ── Step 5: Fire SAGA asynchronously (if not draft) ───────────────
        if (!draft) {
            processInstructionSagaAtomic(instructionId, pool)
                .catch(e => logger.error(`[ZOHO_PAY] SAGA error for ${instructionId}: ${e.message}`));
            logger.info(`[ZOHO_PAY] ✅ Dispatched instruction ${instructionId} for Zoho invoice ${zohoInvoiceId}`);
        } else {
            logger.info(`[ZOHO_PAY] 📝 Draft instruction ${instructionId} created for Zoho invoice ${zohoInvoiceId} (Pending Approval)`);
        }

        return ok(res, {
            message:       draft ? 'Payment drafted and awaiting approval' : 'Payment dispatched via Fusion SAGA',
            zohoInvoiceId,
            instructionId,
            amount:        paymentAmount,
            currency:      paymentCurrency,
            rail,
            state:         initialState,
            trackingNote:  `Monitor via GET /api/zoho/invoice-status/${zohoInvoiceId}`,
        }, 202);

    } catch (err) {
        logger.error(`[ZOHO_PAY] Error: ${err.message}`);
        return fail(res, 'Payment dispatch failed', err.message, 500);
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTE 7: GET /api/zoho/approvals
// Fetch all instructions pending CFO approval
// ════════════════════════════════════════════════════════════════════════════
router.get('/approvals', async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        const result = await pool.query(
            `SELECT i.instruction_id, i.amount, i.currency, i.recipient, i.created_at, 
                    inv.seller_name, inv.buyer_name, inv.invoice_id
             FROM instructions i
             LEFT JOIN invoices inv ON i.zoho_invoice_id = inv.invoice_id OR i.zoho_invoice_id = 'ZOHO-' || inv.invoice_id
             WHERE i.state = 'PENDING_APPROVAL'
             ORDER BY i.created_at ASC`
        );
        return ok(res, { approvals: result.rows });
    } catch (err) {
        logger.error(`[ZOHO_APPROVALS] Error: ${err.message}`);
        return fail(res, 'Failed to fetch approvals', err.message, 500);
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTE 8: POST /api/zoho/approve/:instructionId
// Approves a pending instruction via CanonicalApprovalService and enqueues durable SAGA dispatch
// ════════════════════════════════════════════════════════════════════════════
router.post('/approve/:instructionId', async (req, res) => {
    const pool = req.app.locals.pool;
    const { instructionId } = req.params;
    const { defaultCanonicalApprovalService } = require('../core/approvals/canonicalApprovalService');
    try {
        const checkResult = await pool.query(
            `SELECT state, sender, zoho_invoice_id FROM instructions WHERE instruction_id = $1`,
            [instructionId]
        );

        if (checkResult.rows.length === 0 || checkResult.rows[0].state !== 'PENDING_APPROVAL') {
            return fail(res, `Instruction ${instructionId} not found or not in PENDING_APPROVAL state`, null, 404);
        }

        const zohoInvoiceId = checkResult.rows[0].zoho_invoice_id;

        // Route through CanonicalApprovalService with CFO checker identity
        const approvalRes = await defaultCanonicalApprovalService.approvePayment({
            instructionId,
            checkerOperatorId: '00000000-0000-4000-8000-000000000001', // Dev CFO Lead
            notes: 'Approved via Zoho Invoice Approval interface',
            requireStepUp: false,
            pool,
        });

        if (zohoInvoiceId) {
            await pool.query(
                `UPDATE invoices SET state = 'APPROVED', updated_at = NOW() WHERE invoice_id = $1 OR invoice_id = $2`,
                [zohoInvoiceId, `ZOHO-${zohoInvoiceId}`]
            );
        }

        logger.info(`[ZOHO_APPROVE] ✅ CFO Approved instruction ${instructionId} via Canonical Approval Service.`);
        return ok(res, { 
            message: 'Instruction approved and durable SAGA dispatch enqueued', 
            instructionId,
            dispatch: approvalRes.dispatchRecord || null
        }, 202);
    } catch (err) {
        logger.error(`[ZOHO_APPROVE] Error: ${err.message}`);
        return fail(res, 'Failed to approve instruction', err.message, err.statusCode || 500);
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTE 9: GET /api/zoho/reconciliations
// Fetch recent auto-reconciliation ML matching logs
// ════════════════════════════════════════════════════════════════════════════
router.get('/reconciliations', async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        const result = await pool.query(
            `SELECT r.recon_id AS id, r.recon_id, r.instruction_id, r.zoho_invoice_id, r.zoho_payment_id, r.reconciled_at, r.status,
                    i.amount, i.currency, inv.seller_name
             FROM reconciliation_log r
             LEFT JOIN instructions i ON r.instruction_id = i.instruction_id
             LEFT JOIN invoices inv ON r.zoho_invoice_id = inv.invoice_id OR r.zoho_invoice_id = 'ZOHO-' || inv.invoice_id
             ORDER BY r.reconciled_at DESC
             LIMIT 50`
        );
        return ok(res, { reconciliations: result.rows });
    } catch (err) {
        logger.error(`[ZOHO_RECONCILIATION] Error: ${err.message}`);
        return fail(res, 'Failed to fetch reconciliations', err.message, 500);
    }
});

router.processZohoInvoice = processZohoInvoice;
router.fetchPendingInvoices = fetchPendingInvoices;
router.fetchInvoiceById = fetchInvoiceById;
router.normalizeZohoInvoice = normalizeZohoInvoice;

module.exports = router;
