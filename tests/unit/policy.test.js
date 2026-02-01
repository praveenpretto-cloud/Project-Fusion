const { evaluatePolicy } = require('../../policyEngine');

describe('Policy Engine', () => {
    const secretKey = 'test_secret_key';

    test('should approve valid transaction', () => {
        const txn = { instruction_id: '1', amount: 100, currency: 'USD', sender: 'A', recipient: 'B', purpose: 'GIFT' };
        const result = evaluatePolicy(txn, secretKey);
        expect(result.decision).toBe('APPROVED');
    });

    test('should reject AML violation', () => {
        const txn = { instruction_id: '2', amount: 1000001, currency: 'USD', sender: 'A', recipient: 'B', purpose: 'GIFT' };
        const result = evaluatePolicy(txn, secretKey);
        expect(result.decision).toBe('REJECTED');
    });
});
