const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function checkStates() {
    try {
        const res = await pool.query(`
            SELECT state, COUNT(*) as count
            FROM instructions
            GROUP BY state
            ORDER BY count DESC
        `);
        console.log('--- Current Transaction States ---');
        console.table(res.rows);
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

checkStates();
