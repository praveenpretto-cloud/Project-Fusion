const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function diagnose() {
    console.log('🔍 Diagnosing Stuck Transactions...');

    try {
        // 1. Summary by State
        const res = await pool.query(`
            SELECT state, COUNT(*) as count, MIN(created_at) as oldest, MAX(created_at) as newest
            FROM instructions
            GROUP BY state
            ORDER BY count DESC
        `);
        console.log('--- Summary ---');
        res.rows.forEach(r => {
            console.log(`${r.state}: ${r.count} (Oldest: ${r.oldest})`);
        });

        // 2. Details of Stuck Items (> 1 hour old and not SETTLED/FAILED)
        const stuck = await pool.query(`
            SELECT instruction_id, state, created_at, purpose
            FROM instructions
            WHERE state NOT IN ('SETTLED', 'FAILED')
            AND created_at < NOW() - INTERVAL '1 hour'
            LIMIT 10
        `);

        if (stuck.rows.length > 0) {
            console.log('\n⚠️  Sample of Stuck Transactions (>1h old):');
            stuck.rows.forEach(r => {
                console.log(`[${r.state}] ${r.instruction_id} (${r.created_at})`);
            });
        } else {
            console.log('\n✅ No stuck transactions older than 1 hour found.');
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

diagnose();
