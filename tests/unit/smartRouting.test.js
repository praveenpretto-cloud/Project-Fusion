const { evaluatePolicy } = require('../../policyEngine');

describe('Smart Routing Policy Engine', () => {
    const apiSecretKey = 'mock_secret_key';

    it('should route Treasury transfers bypassing retail to ADAPTER_CRYPTO_CUSTODIAN', () => {
        const txn = { instruction_id: '123', purpose: 'TREASURY', currency: 'USDC', amount: 50000 };
        const result = evaluatePolicy(txn, apiSecretKey);
        expect(result.decision).toBe('APPROVED');
        expect(result.recommended_rail).toBe('ADAPTER_CRYPTO_CUSTODIAN');
    });

    it('should route High-Value Supply Chain settlements to ADAPTER_ISO20022', () => {
        const txn = {
            instruction_id: '124',
            purpose: 'SUPPLY_CHAIN_VENDOR',
            currency: 'USD',
            amount: 15000,
        };
        const result = evaluatePolicy(txn, apiSecretKey);
        expect(result.decision).toBe('APPROVED');
        expect(result.recommended_rail).toBe('ADAPTER_ISO20022');
    });

    it('should not override standard routing for low-value Supply Chain', () => {
        const txn = {
            instruction_id: '125',
            purpose: 'SUPPLY_CHAIN_VENDOR',
            currency: 'USD',
            amount: 5000,
        };
        const result = evaluatePolicy(txn, apiSecretKey);
        expect(result.decision).toBe('APPROVED');
        expect(result.recommended_rail).toBeNull();
    });
});
