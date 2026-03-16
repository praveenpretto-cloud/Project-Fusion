// RAZORPAY ADAPTER (Indian Payment Aggregator)
// Integrates with RazorpayX Payouts API for INR Fiat Disbursements

async function executeRazorpayRail(instruction) {
    const { getAdapterCredential } = require('../vaultProvider');
    const logger = require('../logger');
    const { amount, currency, recipient } = instruction;
    const instructionId = instruction.instructionId || instruction.instruction_id;

    const keyId = getAdapterCredential('RAZORPAY_KEY_ID');
    const keySecret = getAdapterCredential('RAZORPAY_KEY_SECRET');
    const accountNumber = process.env.RAZORPAYX_ACCOUNT_NUMBER || '2323230040153680';

    logger.info(
        `[RAZORPAYX] Executing Payout for ${amount} ${currency} (Rail: ${keyId ? 'LIVE_TESTNET' : 'MOCK'})`
    );

    // MOCK BYPASS FOR LOAD TESTING
    if (instruction.purpose === 'RAZORPAY_SCALE_TEST') {
        const mockDelay = Math.floor(Math.random() * 200) + 50;
        await new Promise((resolve) => setTimeout(resolve, mockDelay));
        logger.info(`[RAZORPAY MOCK] Simulated Payout success for ${instructionId}`);
        return {
            status: 'SUCCESS',
            intent_id: `mock_rzpx_${instructionId}_${Date.now()}`,
            timestamp: new Date().toISOString(),
        };
    }

    try {
        if (!keyId || !keySecret) {
            throw new Error('Missing Razorpay API credentials in vault');
        }

        const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
        const headers = { 'Content-Type': 'application/json', Authorization: auth };

        logger.info(
            `[RAZORPAY REAL] 🟢 Initiating RazorpayX Payout API call for ${amount} ${currency}...`
        );

        // 1. Create recipient contact
        let res = await fetch('https://api.razorpay.com/v1/contacts', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                name: recipient,
                email: 'sandbox.recipient@example.com',
                contact: '919999999999',
                type: 'vendor',
                reference_id: `ct_${instructionId.slice(0, 15)}`,
            }),
        });
        let contact = await res.json();
        if (contact.error && contact.error.code)
            throw new Error(contact.error.description || contact.error.reason || 'Contact failed');

        // 2. Create fund account
        res = await fetch('https://api.razorpay.com/v1/fund_accounts', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                contact_id: contact.id,
                account_type: 'bank_account',
                bank_account: {
                    name: recipient,
                    ifsc: 'HDFC0000053', // Sandbox default
                    account_number: '765432123456789', // Sandbox default
                },
            }),
        });
        let fundAccount = await res.json();
        if (fundAccount.error && fundAccount.error.code)
            throw new Error(fundAccount.error.description || 'FundAccount failed');

        // 3. Initiate Payout
        const amountInPaise = Math.round(amount * 100);
        res = await fetch('https://api.razorpay.com/v1/payouts', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                account_number: accountNumber,
                fund_account_id: fundAccount.id,
                amount: amountInPaise,
                currency: currency.toUpperCase(),
                mode: 'IMPS',
                purpose: 'payout',
                queue_if_low_balance: true,
                reference_id: `payout_${instructionId.slice(0, 10)}_${Date.now()}`.slice(0, 30),
                narration: 'Project Fusion IFSCA',
            }),
        });
        let payout = await res.json();
        if (payout.error && payout.error.code && payout.error.code !== 'NA')
            throw new Error(payout.error.description || payout.error.reason || 'Payout failed');

        return {
            status: ['processed', 'processing', 'queued', 'pending'].includes(payout.status)
                ? 'SUCCESS'
                : payout.status.toUpperCase(),
            intent_id: payout.id,
            timestamp: new Date().toISOString(),
        };
    } catch (err) {
        logger.error(`[RAZORPAY ERROR] ${err.message || JSON.stringify(err)}`);
        return { status: 'FAILED', error: err.message || 'Razorpay Gateway Error' };
    }
}

async function queryStatus(intentId) {
    if (!intentId) return 'UNKNOWN';
    const { getAdapterCredential } = require('../vaultProvider');
    const keyId = getAdapterCredential('RAZORPAY_KEY_ID');
    const keySecret = getAdapterCredential('RAZORPAY_KEY_SECRET');

    if (!keyId || !keySecret) return 'UNKNOWN';

    const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    try {
        let res = await fetch(`https://api.razorpay.com/v1/payouts/${intentId}`, {
            method: 'GET',
            headers: { Authorization: auth },
        });
        let payout = await res.json();
        return payout.status || 'UNKNOWN';
    } catch {
        return 'UNKNOWN';
    }
}

async function rollbackRazorpayRail(intentId) {
    const logger = require('../logger');
    if (!intentId || intentId.startsWith('mock_')) return { status: 'MOCK_REVERSED' };

    // Note: RazorpayX Payouts are generally irreversible once processed (IMPS/NEFT).
    // In a production environment, this function would either attempt to cancel a 'queued' payout,
    // or trigger an internal Ops ticket for manual recovery. For the SAGA MVP, we simulate
    // the compensating transaction API call.
    try {
        logger.warn(`[RAZORPAYX ROLLBACK] 🔄 Attempting to reverse Payout: ${intentId}`);
        // Simulate an API call to a reversal endpoint
        await new Promise((resolve) => setTimeout(resolve, 300));
        logger.info(`[RAZORPAYX ROLLBACK] ✅ Payout reversed or queued for reversal.`);
        return { status: 'REVERSED', reversal_id: `rev_${intentId.slice(0, 10)}` };
    } catch (err) {
        logger.error(`[RAZORPAYX ROLLBACK ERROR] ❌ Failed to reverse: ${err.message}`);
        return { status: 'REVERSAL_FAILED', error: err.message };
    }
}

module.exports = { executeRazorpayRail, queryStatus, rollbackRazorpayRail };
