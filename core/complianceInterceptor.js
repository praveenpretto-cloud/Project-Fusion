const logger = require('../logger');
const crypto = require('crypto');

/**
 * 1. MOCK AML CHECK (Anti-Money Laundering)
 * In production, this would integrate with a screening gateway like Chainalysis,
 * ComplyAdvantage, or Dow Jones to screen against sanctioned entity lists.
 */
async function checkAML(pool, sender, recipient) {
    logger.info(
        `[COMPLIANCE] Running Guardian AML screening for Sender: ${sender}, Recipient: ${recipient}`
    );

    // 1. Static Mock Rule (legacy)
    if (recipient && recipient.toLowerCase().includes('sanctioned')) {
        logger.error(`[COMPLIANCE] AML BLOCK: Recipient flagged by static heuristic.`);
        throw new Error('COMPLIANCE_ERROR_AML_SANCTIONED_ENTITY');
    }

    // 2. Dynamic Database Check (The Guardian) - Uses shared pool
    const { checkSanctions } = require('../services/complianceService');
    const result = await checkSanctions(pool, recipient);

    if (result.blocked) {
        logger.error(
            `[COMPLIANCE] GUARDIAN BLOCK: ${result.entity} is on the sanctions list. Reason: ${result.reason}`
        );
        const err = new Error('REJECTED_COMPLIANCE');
        err.details = result;
        throw err;
    }

    return true;
}

/**
 * TDS SECTION → RATE TABLE
 * Per Indian Income Tax Act:
 *   Sec 194C — Contractor / Subcontractor: 1% (individual/HUF), 2% (company)
 *   Sec 194J — Professional / Technical services: 10%
 *   Sec 194I — Rent (plant/machinery/land/building): 10%
 *   Sec 194A — Interest (other than on securities): 10%
 *   Sec 194B — Lottery / Prize: 30%
 * Default: 1% (194C individual rate — safest fallback for unclassified vendor payments)
 */
const TDS_RATE_TABLE = {
    '194C_INDIVIDUAL': 0.01, // Contractor, individual/HUF
    '194C_COMPANY': 0.02, // Contractor, company
    '194J': 0.1, // Professional / technical fees
    '194I': 0.1, // Rent
    '194A': 0.1, // Interest
    '194B': 0.3, // Lottery / prize
    EXEMPT: 0.0, // Salary handled via employer; exports exempt
};

/**
 * Determine TDS section from transaction purpose and recipient type.
 * @param {string} purpose - e.g. VENDOR_PAYMENT, SALARY, PROFESSIONAL_FEE, RENT, EXPORT_INVOICE
 * @param {string} recipientType - 'individual' | 'company' (defaults to 'individual')
 * @returns {{ section: string, rate: number }}
 */
function determineTDSSection(purpose, recipientType = 'individual') {
    const p = (purpose || '').toUpperCase();

    // Salary — employer handles via Form 16, TDS not withheld at payout level here
    if (['SALARY', 'PAYROLL', 'BULK_PAYOUT'].includes(p)) {
        return { section: 'EXEMPT', rate: TDS_RATE_TABLE['EXEMPT'] };
    }
    // Export invoices — exempt under FEMA / IGST zero-rating
    if (['EXPORT_INVOICE', 'CROSS_BORDER', 'FX_SWAP', 'TREASURY'].includes(p)) {
        return { section: 'EXEMPT', rate: TDS_RATE_TABLE['EXEMPT'] };
    }
    // Professional fees
    if (['PROFESSIONAL_FEE', 'TECHNICAL_FEE', 'CONSULTING', 'PROFESSIONAL_SERVICES'].includes(p)) {
        return { section: '194J', rate: TDS_RATE_TABLE['194J'] };
    }
    // Rent
    if (['RENT', 'LEASE', 'RENTAL_PAYMENT'].includes(p)) {
        return { section: '194I', rate: TDS_RATE_TABLE['194I'] };
    }
    // Interest payments
    if (['INTEREST', 'LOAN_INTEREST', 'EMI_INTEREST'].includes(p)) {
        return { section: '194A', rate: TDS_RATE_TABLE['194A'] };
    }
    // Default: 194C vendor/contractor payment
    const sectionKey = recipientType === 'company' ? '194C_COMPANY' : '194C_INDIVIDUAL';
    return { section: sectionKey, rate: TDS_RATE_TABLE[sectionKey] };
}

/**
 * 2. TAX WITHHOLDING CALCULATOR (Indian TDS — Section-Based)
 * Dynamically splits the gross amount into net_payout and tax_withheld
 * using the correct TDS section and rate per Income Tax Act.
 */
function calculateTDS(amount, currency, purpose, recipientType) {
    let tdsInfo = { section: 'EXEMPT', rate: 0 };

    // TDS only applies to INR-denominated domestic transactions
    if (['INR'].includes((currency || '').toUpperCase())) {
        tdsInfo = determineTDSSection(purpose, recipientType);
    }
    // Crypto payouts (XLM/USDC/BTC/ETH) — apply 1% under 194C as default
    // RBI has not yet issued specific TDS guidance for crypto; using conservative 194C rate
    else if (['BTC', 'ETH', 'USDC', 'XLM'].includes((currency || '').toUpperCase())) {
        tdsInfo = { section: '194C_INDIVIDUAL', rate: TDS_RATE_TABLE['194C_INDIVIDUAL'] };
    }

    const numericAmount = parseFloat(amount);
    const taxWithheld = numericAmount * tdsInfo.rate;
    const netPayout = numericAmount - taxWithheld;

    return {
        gross_amount: numericAmount,
        tax_withheld: parseFloat(taxWithheld.toFixed(2)),
        net_payout: parseFloat(netPayout.toFixed(2)),
        tds_rate: tdsInfo.rate,
        tds_section: tdsInfo.section,
    };
}

/**
 * MAIN INTERCEPTOR MIDDLEWARE
 * Executed immediately prior to adapter handoff.
 */
async function runComplianceChecks(pool, txn) {
    logger.info(`[COMPLIANCE] Intercepting instruction ${txn.instruction_id}`);

    // Step 1: AML Screening
    await checkAML(pool, txn.sender, txn.recipient);

    // Step 2: Tax Calculation — Section-based TDS
    const taxInfo = calculateTDS(txn.amount, txn.currency, txn.purpose, txn.recipient_type);
    logger.info(
        `[COMPLIANCE] TDS Sec ${taxInfo.tds_section} @ ${(taxInfo.tds_rate * 100).toFixed(0)}%. ` +
            `Gross: ₹${taxInfo.gross_amount}, Withheld: ₹${taxInfo.tax_withheld}, Net: ₹${taxInfo.net_payout}`
    );

    // Step 3: Mutate the txn payload so the target adapter only processes the Post-Tax Net Amount
    txn.gross_amount = taxInfo.gross_amount;
    txn.tax_withheld = taxInfo.tax_withheld;
    txn.tds_section = taxInfo.tds_section;
    txn.amount = taxInfo.net_payout.toString(); // OVERRIDE the target amount

    return taxInfo;
}

/**
 * EXPORTER FX COMPLIANCE MODULE
 * Processes a batch of Exporter Inflows (FCSS / USD / EUR) through
 * Indian FEMA regulations, TDS withholding, and AML screening.
 * Ensures zero-custody by only verifying off-chain metadata.
 *
 * @param {Array} batch - Array of instructions
 * @returns {Object} Compliance report with cryptographic ledger hash
 */
async function processExporterFxCompliance(pool, batch) {
    logger.info(`[EXPORTER_COMPLIANCE] Processing batch of ${batch.length} exporter transactions`);

    const report = {
        timestamp: new Date().toISOString(),
        total_processed: batch.length,
        approved: [],
        rejected: [],
    };

    for (const txn of batch) {
        try {
            // 1. Existing Pre-flight AML/Sanctions screening
            await checkAML(pool, txn.sender, txn.recipient);

            // 2. FEMA S8 & S10 Checks
            const grossAmount = parseFloat(txn.amount);
            const currency = (txn.currency || '').toUpperCase();

            const requiresIBUReport = grossAmount > 25000 && ['USD', 'EUR'].includes(currency);
            if (requiresIBUReport) {
                logger.info(
                    `[EXPORTER_COMPLIANCE] FEMA Sec 10 IBU Reporting required for ${txn.instruction_id}`
                );
            }

            // 3. Auto TDS Withholding for INR disbursements
            let taxInfo = calculateTDS(txn.amount, txn.currency);

            // Re-apply specific FEMA export rules if needed
            // e.g. Export receipts might be exempt unless converted to INR,
            // but calculateTDS handles 1% on INR.
            if (currency === 'INR') {
                logger.info(
                    `[EXPORTER_COMPLIANCE] Applied ${taxInfo.tds_rate * 100}% TDS on INR leg for ${txn.instruction_id}`
                );
            }

            // 4. FCSS Settlement Hook (5-6 seconds)
            // If the transaction is destined for the FCSS rail, simulate the RTGS settling window.
            if (txn.fcss_eligible || txn.rail === 'FCSS') {
                logger.info(
                    `[EXPORTER_COMPLIANCE] 🏦 FCSS Rail Detected. Hooking into 5.5s settlement confirmation...`
                );
                await new Promise((r) => setTimeout(r, 5500));
                logger.info(`[EXPORTER_COMPLIANCE] ✅ FCSS Settlement Confirmed (zero FX float)`);
            }

            report.approved.push({
                instruction_id: txn.instruction_id,
                net_payout: taxInfo.net_payout,
                tax_withheld: taxInfo.tax_withheld,
                fema_s10_reported: requiresIBUReport,
                fcss_confirmed: !!(txn.fcss_eligible || txn.rail === 'FCSS'),
            });
        } catch (err) {
            logger.error(`[EXPORTER_COMPLIANCE] ❌ Rejected ${txn.instruction_id}: ${err.message}`);
            report.rejected.push({
                instruction_id: txn.instruction_id,
                reason: err.message,
            });
        }
    }

    // 5. Generate Cryptographic Ledger Hash
    const reportString = JSON.stringify(report);
    const ledgerHash = crypto.createHash('sha256').update(reportString).digest('hex');
    report.ledger_hash = ledgerHash;

    logger.info(
        `[EXPORTER_COMPLIANCE] Batch Compliance Complete. Ledger Hash: ${ledgerHash.slice(0, 16)}...`
    );

    return report;
}

module.exports = {
    runComplianceChecks,
    processExporterFxCompliance,
};
