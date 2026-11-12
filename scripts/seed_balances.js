
const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', host: 'localhost', database: 'fusion_db', password: 'praveen123', port: 5432 });

async function seed() {
    console.log('[SEED] Seeding balances for GENERIC_USER_099...');
    const users = ['GENERIC_USER_099'];
    const currencies = ['USD', 'INR', 'XLM', 'EUR', 'GBP'];
    
    for (const u of users) {
        for (const c of currencies) {
            await pool.query(
                "INSERT INTO balances (account_id, currency, balance) VALUES ($1, $2, 100000) ON CONFLICT (account_id, currency) DO UPDATE SET balance = balances.balance + 100000",
                [u, c]
            );
        }
    }
    console.log('[SEED] Done.');
    process.exit(0);
}
seed();
