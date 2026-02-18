const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function reconcileStuck() {
    console.log('🧹 Starting Stuck Transaction Cleanup...');

    try {
        const result = await pool.query(`
            UPDATE instructions
            SET state = 'FAILED', 
                updated_at = NOW()
            WHERE state NOT IN ('SETTLED', 'FAILED')
            AND created_at < NOW() - INTERVAL '1 hour'
        `);

        console.log(`✅ Cleaned up ${result.rowCount} stuck transactions.`);
        console.log('   Marked as FAILED (Reason: Expired/Stuck)');

    } catch (err) {
        console.error('❌ Error during cleanup:', err);
    } finally {
        await pool.end();
    }
}

reconcileStuck();
