// POLICY ENGINE

const crypto = require('crypto');
const logger = require('./logger');

function evaluatePolicy(transaction, apiSecretKey) {
    // PROTOTYPE ONLY: Hardcoded rules
    let decision = 'APPROVED';
    let rationale = 'Standard compliance checks passed';
    let recommendedRail = null;

    // Inter-Company Treasury Routing Rule
    if (transaction.purpose === 'TREASURY' && ['USD', 'USDC'].includes(transaction.currency)) {
        recommendedRail = 'ADAPTER_CRYPTO_CUSTODIAN';
        rationale = 'Inter-Company Treasury bypassing external 3rd party margins via USDC.';
    }

    // Supply Chain Smart Routing (Mock RFQ check)
    if (transaction.purpose === 'SUPPLY_CHAIN_VENDOR' && parseFloat(transaction.amount) >= 10000) {
        recommendedRail = 'ADAPTER_ISO20022';
        rationale = 'Supply Chain High-Value routing optimized for SWIFT (ISO20022)';
    }

    // Rule 1: PBM Constraints
    if (
        transaction.currency === 'PBM_VOUCHER' &&
        !['FOOD', 'EDUCATION'].includes(transaction.purpose)
    ) {
        decision = 'REJECTED';
        rationale = 'PBM Violation: Invalid purpose for restricted asset';
    }

    // Rule 2: AML Thresholds
    // RBI CTR (Currency Transaction Report) threshold: ₹10,00,000 (₹10L)
    // Above this, flag for manual review — do NOT block automatically for wire transfers.
    // STR (Suspicious Transaction Report) is subjective and handled by compliance team.
    const AML_CTR_THRESHOLD_INR = 1000000; // ₹10L
    const AML_HARD_LIMIT_INR = 50000000; // ₹5 Crore absolute safety ceiling
    const amountInINR = parseFloat(transaction.amount) *
        (['INR'].includes(transaction.currency) ? 1 : 83.2); // Approximate USD→INR conversion

    if (amountInINR > AML_HARD_LIMIT_INR) {
        decision = 'REJECTED';
        rationale = `AML Violation: Transaction amount (₹${(amountInINR / 10000000).toFixed(1)}Cr) exceeds maximum safety ceiling of ₹5Cr.`;
    } else if (amountInINR > AML_CTR_THRESHOLD_INR) {
        // Flag for enhanced due diligence — but do NOT auto-reject wire transfers
        // (FEMA allows high-value wire transfers with proper documentation)
        rationale = `High-Value Transaction: CTR filing required (₹${(amountInINR / 100000).toFixed(1)}L). Routed to enhanced review queue.`;
        logger.info?.(`[POLICY] CTR flag: Amount ${amountInINR.toFixed(0)} INR exceeds ₹10L threshold.`);
        // In production: submit CTR to FIU-IND via API; do not block the instruction.
    }

    // In production, these rules would come from OPA:
    // const opaResponse = await httpClient.post('http://opa-server:8181/v1/data/payment/compliance', {
    //     input: transaction
    // });
    // decision = opaResponse.result.allow ? 'APPROVED' : 'REJECTED';

    const permitId = crypto.randomUUID();
    const issuedTime = new Date().toISOString();
    const expiryTime = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min expiry

    // Signature must cover ALL LOCK data (not just decision)
    // This proves permit is bound to the economic lock
    const signaturePayload =
        permitId +
        transaction.instruction_id +
        decision +
        transaction.sender +
        transaction.amount +
        transaction.currency +
        issuedTime +
        expiryTime;

    const signature = crypto
        .createHmac('sha256', apiSecretKey)
        .update(signaturePayload)
        .digest('hex');

    return {
        permit_id: permitId,
        instruction_id: transaction.instruction_id,
        decision,
        rationale,
        recommended_rail: recommendedRail,

        // Economic lock semantics (MANDATORY)
        locked_account: transaction.sender,
        locked_amount: transaction.amount.toString(),
        locked_currency: transaction.currency,
        lock_status: decision === 'APPROVED' ? 'RESERVED' : 'FAILED',

        // State binding (prevents misuse in wrong state)
        valid_state: 'LOCKED',

        // Temporal validity
        issued_at: issuedTime,
        expires_at: expiryTime,

        // Retry & replay constraints
        constraints: {
            max_execution_attempts: 1,
            replay_allowed: false,
        },

        // Signature now covers lock data
        prototype_signature: signature, // PROTOTYPE ONLY
        // PRODUCTION: signature would be from HSM or MPC signer
    };
}

module.exports = { evaluatePolicy };
