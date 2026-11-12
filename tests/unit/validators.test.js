/**
 * UNIT TEST: Input Validators
 *
 * Tests the Joi validation schemas for API requests.
 */

const { instructionInitiateSchema, adapterExecuteSchema } = require('../../validators');

describe('Input Validators', () => {
    describe('Instruction Initiate Schema', () => {
        test('should accept valid instruction data with decimal string', () => {
            const validData = {
                amount: '100.50',
                currency: 'USD',
                sender: 'Alice_123',
                recipient: 'Bob_456',
                purpose: 'CARD',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(validData);
            expect(error).toBeUndefined();
        });

        test('should reject JavaScript Number monetary inputs', () => {
            const invalidData = {
                amount: 100.5,
                currency: 'USD',
                sender: 'Alice_123',
                recipient: 'Bob_456',
                purpose: 'CARD',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(invalidData);
            expect(error).toBeDefined();
            expect(error.message).toContain('Unsafe JavaScript Number monetary inputs are rejected');
        });

        test('should accept XLM with up to 7 decimal places', () => {
            const validData = {
                amount: '0.1234567',
                currency: 'XLM',
                sender: 'Alice_Stellar',
                recipient: 'Bob_Stellar',
                purpose: 'CRYPTO_TRANSFER',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(validData);
            expect(error).toBeUndefined();
        });

        test('should accept XLM stroop minimum amount (0.0000001)', () => {
            const validData = {
                amount: '0.0000001',
                currency: 'XLM',
                sender: 'Alice_Stellar',
                recipient: 'Bob_Stellar',
                purpose: 'CRYPTO_TRANSFER',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(validData);
            expect(error).toBeUndefined();
        });

        test('should reject XLM with 8 decimal places', () => {
            const invalidData = {
                amount: '0.12345678',
                currency: 'XLM',
                sender: 'Alice_Stellar',
                recipient: 'Bob_Stellar',
                purpose: 'CRYPTO_TRANSFER',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(invalidData);
            expect(error).toBeDefined();
            expect(error.message).toContain('cannot have more than 7 decimal places');
        });

        test('should accept ETH with up to 18 decimal places', () => {
            const validData = {
                amount: '0.123456789012345678',
                currency: 'ETH',
                sender: 'Alice_Eth',
                recipient: 'Bob_Eth',
                purpose: 'CRYPTO_TRANSFER',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(validData);
            expect(error).toBeUndefined();
        });

        test('should accept ETH minimum unit (1 wei: 0.000000000000000001)', () => {
            const validData = {
                amount: '0.000000000000000001',
                currency: 'ETH',
                sender: 'Alice_Eth',
                recipient: 'Bob_Eth',
                purpose: 'CRYPTO_TRANSFER',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(validData);
            expect(error).toBeUndefined();
        });

        test('should reject ETH with 19 decimal places', () => {
            const invalidData = {
                amount: '0.1234567890123456789',
                currency: 'ETH',
                sender: 'Alice_Eth',
                recipient: 'Bob_Eth',
                purpose: 'CRYPTO_TRANSFER',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(invalidData);
            expect(error).toBeDefined();
            expect(error.message).toContain('cannot have more than 18 decimal places');
        });

        test('should accept BTC with up to 8 decimal places', () => {
            const validData = {
                amount: '0.12345678',
                currency: 'BTC',
                sender: 'Alice_Btc',
                recipient: 'Bob_Btc',
                purpose: 'CRYPTO_TRANSFER',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(validData);
            expect(error).toBeUndefined();
        });

        test('should accept BTC minimum unit (1 satoshi: 0.00000001)', () => {
            const validData = {
                amount: '0.00000001',
                currency: 'BTC',
                sender: 'Alice_Btc',
                recipient: 'Bob_Btc',
                purpose: 'CRYPTO_TRANSFER',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(validData);
            expect(error).toBeUndefined();
        });

        test('should reject BTC with 9 decimal places', () => {
            const invalidData = {
                amount: '0.123456789',
                currency: 'BTC',
                sender: 'Alice_Btc',
                recipient: 'Bob_Btc',
                purpose: 'CRYPTO_TRANSFER',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(invalidData);
            expect(error).toBeDefined();
            expect(error.message).toContain('cannot have more than 8 decimal places');
        });

        test('should accept USDC with up to 6 decimal places', () => {
            const validData = {
                amount: '50.123456',
                currency: 'USDC',
                sender: 'Alice_Usdc',
                recipient: 'Bob_Usdc',
                purpose: 'CRYPTO_TRANSFER',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(validData);
            expect(error).toBeUndefined();
        });

        test('should reject USDC with 7 decimal places', () => {
            const invalidData = {
                amount: '50.1234567',
                currency: 'USDC',
                sender: 'Alice_Usdc',
                recipient: 'Bob_Usdc',
                purpose: 'CRYPTO_TRANSFER',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(invalidData);
            expect(error).toBeDefined();
            expect(error.message).toContain('cannot have more than 6 decimal places');
        });

        test('should reject negative amount', () => {
            const invalidData = {
                amount: '-50.00',
                currency: 'USD',
                sender: 'Alice',
                recipient: 'Bob',
                purpose: 'CARD',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(invalidData);
            expect(error).toBeDefined();
            expect(error.message).toContain('positive');
        });

        test('should reject zero amount', () => {
            const invalidData = {
                amount: '0.00',
                currency: 'USD',
                sender: 'Alice',
                recipient: 'Bob',
                purpose: 'CARD',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(invalidData);
            expect(error).toBeDefined();
            expect(error.message).toContain('positive');
        });

        test('should reject scientific notation', () => {
            const invalidData = {
                amount: '1e-5',
                currency: 'USD',
                sender: 'Alice',
                recipient: 'Bob',
                purpose: 'CARD',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(invalidData);
            expect(error).toBeDefined();
            expect(error.message).toContain('Scientific notation is not permitted');
        });

        test('should reject malformed decimal string', () => {
            const invalidData = {
                amount: '100.abc',
                currency: 'USD',
                sender: 'Alice',
                recipient: 'Bob',
                purpose: 'CARD',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(invalidData);
            expect(error).toBeDefined();
            expect(error.message).toContain('valid positive decimal string');
        });

        test('should reject invalid currency', () => {
            const invalidData = {
                amount: '100.00',
                currency: 'INVALID',
                sender: 'Alice',
                recipient: 'Bob',
                purpose: 'CARD',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(invalidData);
            expect(error).toBeDefined();
            expect(error.message).toContain('Currency');
        });

        test('should reject USD with more than 2 decimal places', () => {
            const invalidData = {
                amount: '100.123',
                currency: 'USD',
                sender: 'Alice',
                recipient: 'Bob',
                purpose: 'CARD',
                auth_token: 'afat_1234567890abcdef',
            };

            const { error } = instructionInitiateSchema.validate(invalidData);
            expect(error).toBeDefined();
            expect(error.message).toContain('cannot have more than 2 decimal places');
        });

        test('should reject sender with invalid characters', () => {
            const invalidData = {
                amount: '100.00',
                currency: 'USD',
                sender: 'Alice@#$',
                recipient: 'Bob',
                purpose: 'CARD',
                auth_token: 'afat_1234567890abcdef',
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
