/**
 * UNIT TEST: Input Validators
 *
 * Tests the Joi validation schemas for API requests.
 */

const { instructionInitiateSchema, adapterExecuteSchema } = require('../../validators');

describe('Input Validators', () => {
    describe('Instruction Initiate Schema', () => {
        test('should accept valid instruction data', () => {
            const validData = {
                amount: 100.5,
                currency: 'USD',
                sender: 'Alice_123',
                recipient: 'Bob_456',
                purpose: 'CARD',
            };

            const { error } = instructionInitiateSchema.validate(validData);
            expect(error).toBeUndefined();
        });

        test('should reject negative amount', () => {
            const invalidData = {
                amount: -50.0,
                currency: 'USD',
                sender: 'Alice',
                recipient: 'Bob',
                purpose: 'CARD',
            };

            const { error } = instructionInitiateSchema.validate(invalidData);
            expect(error).toBeDefined();
            expect(error.message).toContain('positive');
        });

        test('should reject invalid currency', () => {
            const invalidData = {
                amount: 100.0,
                currency: 'INVALID',
                sender: 'Alice',
                recipient: 'Bob',
                purpose: 'CARD',
            };

            const { error } = instructionInitiateSchema.validate(invalidData);
            expect(error).toBeDefined();
            expect(error.message).toContain('Currency');
        });

        test('should reject amount with more than 2 decimal places', () => {
            const invalidData = {
                amount: 100.123,
                currency: 'USD',
                sender: 'Alice',
                recipient: 'Bob',
                purpose: 'CARD',
            };

            const { error } = instructionInitiateSchema.validate(invalidData);
            expect(error).toBeDefined();
        });

        test('should reject sender with invalid characters', () => {
            const invalidData = {
                amount: 100.0,
                currency: 'USD',
                sender: 'Alice@#$',
                recipient: 'Bob',
                purpose: 'CARD',
            };

            const { error } = instructionInitiateSchema.validate(invalidData);
            expect(error).toBeDefined();
        });
    });

    describe('Adapter Execute Schema', () => {
        test('should accept valid adapter data', () => {
            const validData = {
                instructionId: '550e8400-e29b-41d4-a716-446655440000',
                adapter: 'ADAPTER_PAYNOW',
            };

            const { error } = adapterExecuteSchema.validate(validData);
            expect(error).toBeUndefined();
        });

        test('should reject invalid UUID', () => {
            const invalidData = {
                instructionId: 'not-a-uuid',
                adapter: 'ADAPTER_PAYNOW',
            };

            const { error } = adapterExecuteSchema.validate(invalidData);
            expect(error).toBeDefined();
        });

        test('should reject invalid adapter name', () => {
            const invalidData = {
                instructionId: '550e8400-e29b-41d4-a716-446655440000',
                adapter: 'INVALID_ADAPTER',
            };

            const { error } = adapterExecuteSchema.validate(invalidData);
            expect(error).toBeDefined();
        });
    });
});
