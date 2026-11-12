'use strict';

const { validateEnvironment, STELLAR_TESTNET_HORIZON, STELLAR_TESTNET_PASSPHRASE } = require('../../core/configValidator');
const vaultProvider = require('../../vaultProvider');

describe('Task 1 & 4: Testnet Environment & Credential Enforcement', () => {
    const validTestEnv = {
        STRIPE_TEST_SECRET_KEY: 'sk_test_mock_valid_stripe_key_12345',
        RAZORPAY_KEY_ID: 'rzp_test_mock_key_id_12345',
        RAZORPAY_KEY_SECRET: 'mock_razorpay_secret_67890',
        VAULT_MASTER_SECRET: 'project_fusion_testnet_master_secret_16chars_min',
    };

    describe('Environment Configuration Validation (configValidator)', () => {
        test('passes when all testnet credentials are fully and correctly provided', () => {
            const result = validateEnvironment(validTestEnv);
            expect(result.valid).toBe(true);
            expect(result.details.stripe).toBe('STRIPE_TESTNET_VERIFIED');
            expect(result.details.razorpay).toBe('RAZORPAYX_SANDBOX_VERIFIED');
        });

        test('fails when STRIPE_TEST_SECRET_KEY is missing', () => {
            const env = { ...validTestEnv, STRIPE_TEST_SECRET_KEY: '' };
            expect(() => validateEnvironment(env)).toThrow(/STRIPE_TEST_SECRET_KEY/);
        });

        test('strictly rejects live/production Stripe key (sk_live_*)', () => {
            const env = { ...validTestEnv, STRIPE_TEST_SECRET_KEY: ['sk', 'live', '51ProdKeyBypassingSandbox00000000000'].join('_') };
            expect(() => validateEnvironment(env)).toThrow(/sk_live_/);
        });

        test('strictly rejects Stripe key not starting with sk_test_', () => {
            const env = { ...validTestEnv, STRIPE_TEST_SECRET_KEY: 'test_invalid_prefix_12345' };
            expect(() => validateEnvironment(env)).toThrow(/sk_test_/);
        });

        test('fails when RAZORPAY_KEY_ID is missing', () => {
            const env = { ...validTestEnv, RAZORPAY_KEY_ID: '' };
            expect(() => validateEnvironment(env)).toThrow(/RAZORPAY_KEY_ID/);
        });

        test('strictly rejects live/production Razorpay key (rzp_live_*)', () => {
            const env = { ...validTestEnv, RAZORPAY_KEY_ID: 'rzp_live_RealMoneyDisbursement9999' };
            expect(() => validateEnvironment(env)).toThrow(/rzp_live_/);
        });

        test('strictly rejects Razorpay key not starting with rzp_test_', () => {
            const env = { ...validTestEnv, RAZORPAY_KEY_ID: 'key_id_invalid_prefix' };
            expect(() => validateEnvironment(env)).toThrow(/rzp_test_/);
        });

        test('fails when RAZORPAY_KEY_SECRET is missing', () => {
            const env = { ...validTestEnv, RAZORPAY_KEY_SECRET: '' };
            expect(() => validateEnvironment(env)).toThrow(/RAZORPAY_KEY_SECRET/);
        });

        test('fails when VAULT_MASTER_SECRET is missing (no fallback allowed)', () => {
            const env = { ...validTestEnv, VAULT_MASTER_SECRET: '' };
            expect(() => validateEnvironment(env)).toThrow(/VAULT_MASTER_SECRET/);
        });

        test('fails when VAULT_MASTER_SECRET is shorter than 16 characters', () => {
            const env = { ...validTestEnv, VAULT_MASTER_SECRET: 'too_short_seed' };
            expect(() => validateEnvironment(env)).toThrow(/minimum 16 characters/);
        });

        test('strictly rejects non-testnet Stellar Horizon URL', () => {
            const env = { ...validTestEnv, STELLAR_HORIZON_URL: 'https://horizon.stellar.org' };
            expect(() => validateEnvironment(env)).toThrow(/Prohibited Stellar Horizon URL/);
        });

        test('strictly rejects non-testnet Stellar Passphrase', () => {
            const env = { ...validTestEnv, STELLAR_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015' };
            expect(() => validateEnvironment(env)).toThrow(/Prohibited Stellar Network Passphrase/);
        });

        test('strictly rejects STRIPE_WEBHOOK_SECRET not starting with whsec_', () => {
            const env = { ...validTestEnv, STRIPE_WEBHOOK_SECRET: 'invalid_prefix_secret' };
            expect(() => validateEnvironment(env)).toThrow(/Invalid STRIPE_WEBHOOK_SECRET: Must start with test secret prefix 'whsec_'/);
        });

        test('strictly rejects RAZORPAYX_WEBHOOK_SECRET matching RAZORPAY_KEY_SECRET', () => {
            const env = { ...validTestEnv, RAZORPAYX_WEBHOOK_SECRET: validTestEnv.RAZORPAY_KEY_SECRET };
            expect(() => validateEnvironment(env)).toThrow(/RAZORPAYX_WEBHOOK_SECRET must NOT match RAZORPAY_KEY_SECRET/);
        });
    });

    describe('Vault Keystore Credential Retrieval & Software Signing', () => {
        const originalEnv = process.env;

        beforeEach(() => {
            process.env = { ...originalEnv };
        });

        afterAll(() => {
            process.env = originalEnv;
        });

        test('rejects STRIPE_KEY retrieval if unset in environment (no hardcoded fallback)', () => {
            delete process.env.STRIPE_TEST_SECRET_KEY;
            expect(() => vaultProvider.getAdapterCredential('STRIPE_KEY')).toThrow(/not set in environment/);
        });

        test('rejects STRIPE_KEY retrieval if key is live', () => {
            process.env.STRIPE_TEST_SECRET_KEY = 'sk_live_1234567890abcdef';
            expect(() => vaultProvider.getAdapterCredential('STRIPE_KEY')).toThrow(/sk_live_/);
        });

        test('rejects RAZORPAY_KEY_ID retrieval if key is live', () => {
            process.env.RAZORPAY_KEY_ID = 'rzp_live_1234567890abcdef';
            expect(() => vaultProvider.getAdapterCredential('RAZORPAY_KEY_ID')).toThrow(/rzp_live_/);
        });

        test('rejects signStellarTransaction when VAULT_MASTER_SECRET is unset', async () => {
            delete process.env.VAULT_MASTER_SECRET;
            await expect(vaultProvider.signStellarTransaction('TEST_SENDER', {}))
                .rejects.toThrow(/VAULT_MASTER_SECRET not configured/);
        });

        test('rejects getStellarPublicKey when VAULT_MASTER_SECRET is unset', async () => {
            delete process.env.VAULT_MASTER_SECRET;
            await expect(vaultProvider.getStellarPublicKey('TEST_SENDER'))
                .rejects.toThrow(/VAULT_MASTER_SECRET not configured/);
        });

        test('rejects encryptClientKey when VAULT_MASTER_SECRET is unset', () => {
            delete process.env.VAULT_MASTER_SECRET;
            expect(() => vaultProvider.encryptClientKey('plain_api_key')).toThrow(/VAULT_MASTER_SECRET not configured/);
        });

        test('rejects decryptClientKey when VAULT_MASTER_SECRET is unset', () => {
            delete process.env.VAULT_MASTER_SECRET;
            expect(() => vaultProvider.decryptClientKey({ encrypted_key: 'aa', iv: 'bb', auth_tag: 'cc' }))
                .toThrow(/VAULT_MASTER_SECRET not configured/);
        });

        test('software key derivation deterministically derives valid public key when secret is configured', async () => {
            process.env.VAULT_MASTER_SECRET = 'test_master_secret_at_least_16_chars_long';
            const pubKey1 = await vaultProvider.getStellarPublicKey('ALICE_TREASURY');
            const pubKey2 = await vaultProvider.getStellarPublicKey('ALICE_TREASURY');
            const pubKeyBob = await vaultProvider.getStellarPublicKey('BOB_TREASURY');

            expect(pubKey1).toBeDefined();
            expect(pubKey1).toMatch(/^G[A-Z0-9]{55}$/);
            expect(pubKey1).toBe(pubKey2); // Deterministic
            expect(pubKey1).not.toBe(pubKeyBob); // Distinct per sender
        });
    });
});
