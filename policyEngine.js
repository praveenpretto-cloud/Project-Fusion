/**
 * POLICY ENGINE (Prototype)
 * 
 * Decoupled policy evaluation logic.
 * 
 * PRODUCTION REPLACEMENT: Open Policy Agent (OPA) with Rego language
 * - OPA allows non-engineers to write compliance rules
 * - Rules are version-controlled separately from code
 * - Instant policy updates without redeploying the service
 * 
 * Example OPA Rule (Rego):
 * 
 *   package payment.compliance
 *   default allow = false
 *   
 *   allow {
 *       input.amount < 100000
 *       input.user.country != "SANCTIONED"
 *   }
 */

const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

function evaluatePolicy(transaction, apiSecretKey) {
    // PROTOTYPE ONLY: Hardcoded rules
    let decision = 'APPROVED';
    let rationale = 'Standard compliance checks passed';
    
    // Rule 1: PBM Constraints
    if (transaction.currency === 'PBM_VOUCHER' && 
        !['FOOD', 'EDUCATION'].includes(transaction.purpose)) {
        decision = 'REJECTED';
        rationale = 'PBM Violation: Invalid purpose for restricted asset';
    }
    
    // Rule 2: AML Thresholds
    if (parseFloat(transaction.amount) > 100000) {
        decision = 'REJECTED';
        rationale = 'AML Violation: Transaction threshold exceeded';
    }
    
    // In production, these rules would come from OPA:
    // const opaResponse = await httpClient.post('http://opa-server:8181/v1/data/payment/compliance', {
    //     input: transaction
    // });
    // decision = opaResponse.result.allow ? 'APPROVED' : 'REJECTED';
    
    const permitId = uuidv4();
    const expiryTime = new Date(Date.now() + 5 * 60 * 1000); // 5 min expiry
    
    // Generate prototype policy permit
    // PRODUCTION REPLACEMENT: HSM-signed JWT or MPC threshold signature
    const signature = crypto
        .createHmac('sha256', apiSecretKey)
        .update(permitId + transaction.instruction_id + decision)
        .digest('hex');
    
    return {
        permit_id: permitId,
        decision,
        rationale,
        instruction_id: transaction.instruction_id,
        timestamp: new Date().toISOString(),
        expires_at: expiryTime.toISOString(),
        prototype_signature: signature, // PROTOTYPE ONLY
        // PRODUCTION: signature would be from HSM or MPC signer
    };
}

module.exports = { evaluatePolicy };
