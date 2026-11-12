const { Client } = require('pg');
const currencies = [
    'USD',
    'EUR',
    'INR',
    'SGD',
    'BTC',
    'ETH',
    'USDC',
    'XLM',
    'PBM_VOUCHER',
    'GBP',
    'CAD',
];

async function addBalances() {
    const client = new Client({
        user: 'postgres',
        password: 'praveen123',
        database: 'fusion_db',
    });
    await client.connect();
    try {
        await client.query('BEGIN');
        for (const c of currencies) {
            await client.query(
                `
                INSERT INTO balances (account_id, currency, balance) 
                VALUES ('Alice_Corp', $1, 10000000.00) 
                ON CONFLICT (account_id, currency) DO UPDATE SET balance = 10000000.00
            `,
                [c]
            );

            await client.query(
                `
                INSERT INTO balances (account_id, currency, balance) 
                VALUES ('Test_Sender_INR', $1, 10000000.00) 
                ON CONFLICT (account_id, currency) DO UPDATE SET balance = 10000000.00
            `,
                [c]
            );

            // For bulk uploads using Contractor_005 etc
            await client.query(
                `
                INSERT INTO balances (account_id, currency, balance) 
                VALUES ('Corporate_HQ', $1, 10000000.00) 
                ON CONFLICT (account_id, currency) DO UPDATE SET balance = 10000000.00
            `,
                [c]
            );
        }
        await client.query('COMMIT');
        console.log('Successfully seeded balances.');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Error:', e);
    } finally {
        await client.end();
    }
}
addBalances();
