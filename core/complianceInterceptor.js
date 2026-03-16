const logger = require('../logger');

/**
 * 1. MOCK AML CHECK (Anti-Money Laundering)
 * In production, this would integrate with a screening gateway like Chainalysis,
 * ComplyAdvantage, or Dow Jones to screen against sanctioned entity lists.
 */
async function checkAML(sender, recipient) {
    logger.info(
        `[COMPLIANCE] Running AML screening for Sender: ${sender}, Recipient: ${recipient}`
    );

    // Simulate API delay for screening gateway
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Mock rule: Block transactions to any entity containing "sanctioned"
    if (recipient && recipient.toLowerCase().includes('sanctioned')) {
        logger.error(`[COMPLIANCE] AML BLOCK: Recipient flagged on sanctions list.`);
        throw new Error('COMPLIANCE_ERROR_AML_SANCTIONED_ENTITY');
    }

    return true;
}

/**
 * 2. TAX WITHHOLDING CALCULATOR (e.g., Indian TDS)
 * Dynamically splits the gross amount into net_payout and tax_withheld.
 */
function calculateTDS(amount, currency) {
    // Mock rule: 1% TDS on INR and Crypto payouts, 0% on USD.
    let tdsRate = 0;

    if (['INR', 'BTC', 'ETH', 'USDC', 'XLM'].includes(currency)) {
        tdsRate = 0.01; // 1%
    }

    const numericAmount = parseFloat(amount);
    const taxWithheld = numericAmount * tdsRate;
    const netPayout = numericAmount - taxWithheld;

    return {
        gross_amount: numericAmount,
        tax_withheld: taxWithheld,
        net_payout: netPayout,
        tds_rate: tdsRate,
    };
}

/**
 * MAIN INTERCEPTOR MIDDLEWARE
 * Executed immediately prior to adapter handoff.
 */
async function runComplianceChecks(txn) {
    logger.info(`[COMPLIANCE] Intercepting instruction ${txn.instruction_id}`);

    // Step 1: AML Screening
    await checkAML(txn.sender, txn.recipient);

    // Step 2: Tax Calculation
    const taxInfo = calculateTDS(txn.amount, txn.currency);
    logger.info(
        `[COMPLIANCE] Tax calculated. Gross: ${taxInfo.gross_amount}, Tax Withheld: ${taxInfo.tax_withheld}, Net Payout: ${taxInfo.net_payout}`
    );

    // Step 3: Mutate the txn payload so the target adapter only processes the Post-Tax Net Amount
    txn.gross_amount = taxInfo.gross_amount;
    txn.tax_withheld = taxInfo.tax_withheld;
    txn.amount = taxInfo.net_payout.toString(); // OVERRIDE the target amount

    return taxInfo;
}

module.exports = {
    runComplianceChecks,
};
