const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function seed() {
    try {
        const client = await pool.connect();

        // Fund user_stripe_test
        await client.query(`
            INSERT INTO balances (account_id, currency, balance)
            VALUES ('user_stripe_test', 'USD', 1000000.00)
            ON CONFLICT (account_id, currency) 
            DO UPDATE SET balance = 1000000.00;
        `);
        console.log('✅ Funded user_stripe_test with $1,000,000');

        // Fund user_e2e_check
        await client.query(`
            INSERT INTO balances (account_id, currency, balance)
            VALUES ('user_e2e_check', 'USD', 1000000.00)
            ON CONFLICT (account_id, currency) 
            DO UPDATE SET balance = 1000000.00;
        `);
        console.log('✅ Funded user_e2e_check with $1,000,000');

        client.release();
        process.exit(0);
    } catch (err) {
        console.error('Seeding failed:', err);
        process.exit(1);
    }
}

seed();
