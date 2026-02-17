require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function check() {
    try {
        const res = await pool.query(`
            SELECT count(*) as count, max(created_at) as last_tx 
            FROM instructions 
            WHERE created_at > NOW() - INTERVAL '15 minutes'
        `);
        console.log('Recent Transactions:', res.rows[0]);
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

check();
