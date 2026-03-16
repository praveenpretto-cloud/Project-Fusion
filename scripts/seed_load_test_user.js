/**
 * Load Test Seed Script
 * Creates a verified user and permanent auth_token for Artillery load tests.
 * Run with: node scripts/seed_load_test_user.js
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

const LOAD_TEST_USER = 'load_test_user';
const LOAD_TEST_RECIPIENT = 'load_test_recipient';
const AUTH_TOKEN_ID = 'a0000000-0000-0000-0000-000000000001';
const AUTH_TOKEN = `afat_${AUTH_TOKEN_ID}`;

async function seed() {
    const client = await pool.connect();
    try {
        console.log('[SEED] Starting load test user setup...');

        // 1. Create sender user (KYC verified)
        await client.query(
            `
            INSERT INTO users (user_id, kyc_status, kyc_verified_at, reference_id)
            VALUES ($1, 'VERIFIED', NOW(), 'load_test_kyc_ref')
            ON CONFLICT (user_id) DO UPDATE SET kyc_status = 'VERIFIED'
        `,
            [LOAD_TEST_USER]
        );
        console.log('[SEED] Sender user created/verified:', LOAD_TEST_USER);

        // 2. Create recipient user
        await client.query(
            `
            INSERT INTO users (user_id, kyc_status, kyc_verified_at, reference_id)
            VALUES ($1, 'VERIFIED', NOW(), 'load_test_recipient_kyc')
            ON CONFLICT (user_id) DO UPDATE SET kyc_status = 'VERIFIED'
        `,
            [LOAD_TEST_RECIPIENT]
        );
        console.log('[SEED] Recipient user created:', LOAD_TEST_RECIPIENT);

        // 3. Large balances for sender to handle thousands of test transactions
        const currencies = ['USD', 'EUR', 'GBP', 'SGD', 'INR'];
        for (const curr of currencies) {
            await client.query(
                `
                INSERT INTO balances (account_id, currency, balance)
                VALUES ($1, $2, 99999999.00)
                ON CONFLICT (account_id, currency) DO UPDATE SET balance = 99999999.00
            `,
                [LOAD_TEST_USER, curr]
            );
        }
        console.log('[SEED] Balances set to 99,999,999 for USD, EUR, GBP, SGD, INR');

        // 4. Create a permanent verified OTP entry with far-future expiry
        await client.query(
            `
            INSERT INTO otps (id, user_id, otp_code, expires_at, verified, created_at)
            VALUES ($1, $2, '000000', NOW() + INTERVAL '999 days', true, NOW())
            ON CONFLICT (id) DO UPDATE SET verified = true, expires_at = NOW() + INTERVAL '999 days'
        `,
            [AUTH_TOKEN_ID, LOAD_TEST_USER]
        );
        console.log('[SEED] Auth token created:', AUTH_TOKEN);

        console.log('\n[SEED] ===== LOAD TEST READY =====');
        console.log('[SEED] AUTH TOKEN:', AUTH_TOKEN);
        console.log('[SEED] SENDER:    ', LOAD_TEST_USER);
        console.log('[SEED] RECIPIENT: ', LOAD_TEST_RECIPIENT);
        console.log(
            '[SEED] Run: npx artillery run tests/load/load_test.yml --output tests/load/load_test_report.json'
        );
    } catch (err) {
        console.error('[SEED] ERROR:', err.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

seed();
