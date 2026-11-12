'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════
 * COMPLIANCE DOCUMENT WORKFLOW — core/compliance/complianceDocWorkflow.js
 * Auto-generates FIRC, eBRC, FEMA declaration, TDS certificate
 * after an instruction reaches SETTLED state.
 * ═══════════════════════════════════════════════════════════════════
 */

const crypto = require('crypto');
const logger = require('../../logger');

/**
 * Generates a FIRC (Foreign Inward Remittance Certificate).
 * Required by RBI for all foreign currency receipts.
 */
function generateFIRC(instruction, settlementRef) {
    return {
        doc_type:        'FIRC',
        certificate_no:  `FIRC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        remitter_name:   instruction.sender,
        beneficiary_name: instruction.recipient,
        amount:          instruction.net_amount || instruction.amount,
        currency:        instruction.currency,
        purpose_code:    instruction.purpose || 'P0102',   // RBI purpose code for export earnings
        settlement_ref:  settlementRef,
        bank_ref:        `FUSION-IBU-${Date.now()}`,
        issue_date:      new Date().toISOString().split('T')[0],
        fema_section:    'FEMA Section 10(4)',
        generated_by:    'Project Fusion GIFT City IBU',
        generated_at:    new Date().toISOString(),
    };
}

/**
 * Generates an eBRC (Electronic Bank Realization Certificate).
 * Required for export invoices > $1,000 USD.
 */
function generateEBRC(instruction, zohoInvoiceId, settlementRef) {
    const amount = parseFloat(instruction.net_amount || instruction.amount);
    return {
        doc_type:        'eBRC',
        ebrc_no:         `EBRC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        invoice_ref:     zohoInvoiceId || instruction.instruction_id,
        exporter_name:   instruction.recipient,
        buyer_name:      instruction.sender,
        invoice_amount:  amount,
        realized_amount: amount,
        currency:        instruction.currency,
        realization_date: new Date().toISOString().split('T')[0],
        bank_ref:        settlementRef,
        port_of_export:  'GIFT City IFSC',
        generated_by:    'Project Fusion GIFT City IBU',
        generated_at:    new Date().toISOString(),
    };
}

/**
 * Generates a FEMA declaration record.
 */
function generateFEMADeclaration(instruction) {
    const amount = parseFloat(instruction.amount);
    return {
        doc_type:        'FEMA_DECL',
        declaration_no:  `FEMA-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        section:         amount > 25000 ? 'FEMA Section 10 (IBU Reporting)' : 'FEMA Section 8',
        transaction_ref: instruction.instruction_id,
        remitter:        instruction.sender,
        beneficiary:     instruction.recipient,
        amount:          amount,
        currency:        instruction.currency,
        purpose:         instruction.purpose,
        ibu_reporting_required: amount > 25000 && instruction.currency !== 'INR',
        declaration_date: new Date().toISOString().split('T')[0],
        generated_at:    new Date().toISOString(),
    };
}

/**
 * Generates a TDS certificate for INR / crypto settlements.
 */
function generateTDSCertificate(instruction) {
    const gross  = parseFloat(instruction.amount);
    const tds    = parseFloat(instruction.tax_withheld || 0);
    const net    = parseFloat(instruction.net_amount || gross - tds);

    return {
        doc_type:        'TDS_CERT',
        certificate_no:  `TDS-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        deductor_name:   'Project Fusion Treasury',
        deductee_name:   instruction.recipient,
        transaction_ref: instruction.instruction_id,
        gross_amount:    gross,
        tds_rate:        tds > 0 ? `${((tds / gross) * 100).toFixed(1)}%` : '0%',
        tds_withheld:    tds,
        net_payout:      net,
        currency:        instruction.currency,
        period:          new Date().toISOString().split('T')[0].slice(0, 7), // YYYY-MM
        generated_at:    new Date().toISOString(),
    };
}

/**
 * Master function — called after an instruction is SETTLED.
 * Determines which documents to generate and persists them to DB.
 *
 * @param {Object} pool        - pg Pool
 * @param {Object} instruction - Settled instruction row from DB
 * @param {string} settlementRef - External intent ID (Stripe/Razorpay/ISO ref)
 * @param {string} zohoInvoiceId - Zoho invoice ID if available
 * @returns {Array} Generated document objects
 */
async function generateComplianceDocs(pool, instruction, settlementRef, zohoInvoiceId = null) {
    const docs = [];
    const currency = (instruction.currency || '').toUpperCase();
    const amount   = parseFloat(instruction.amount || 0);
    const isForeign = !['INR'].includes(currency);

    logger.info(`[COMPLIANCE_DOCS] Generating docs for instruction ${instruction.instruction_id} (${currency} ${amount})`);

    // 1. FIRC — for all foreign currency settlements
    if (isForeign) {
        docs.push(generateFIRC(instruction, settlementRef));
    }

    // 2. eBRC — for export invoices > $1,000 USD equivalent
    if (isForeign && amount > 1000) {
        docs.push(generateEBRC(instruction, zohoInvoiceId, settlementRef));
    }

    // 3. FEMA Declaration — for all cross-border payments
    if (isForeign) {
        docs.push(generateFEMADeclaration(instruction));
    }

    // 4. TDS Certificate — when tax was withheld
    if (parseFloat(instruction.tax_withheld || 0) > 0) {
        docs.push(generateTDSCertificate(instruction));
    }

    // Persist all generated documents to DB
    if (docs.length > 0 && pool) {
        try {
            for (const doc of docs) {
                await pool.query(
                    `INSERT INTO compliance_documents
                     (instruction_id, zoho_invoice_id, doc_type, doc_payload, generated_at)
                     VALUES ($1, $2, $3, $4, NOW())
                     ON CONFLICT DO NOTHING`,
                    [
                        instruction.instruction_id,
                        zohoInvoiceId,
                        doc.doc_type,
                        JSON.stringify(doc),
                    ]
                );
            }
            logger.info(`[COMPLIANCE_DOCS] ✅ Stored ${docs.length} compliance document(s) for ${instruction.instruction_id}`);
        } catch (dbErr) {
            logger.error(`[COMPLIANCE_DOCS] ❌ DB persist failed: ${dbErr.message}`);
        }
    }

    return docs;
}

module.exports = { generateComplianceDocs };
