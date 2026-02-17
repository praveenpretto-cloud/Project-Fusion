const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function check() {
    console.log('🔍 Checking Ledger Hash Chain...');
    const client = await pool.connect();
    try {
        const res = await client.query(
            'SELECT entry_id, hash, prev_hash, timestamp FROM ledger_journal ORDER BY timestamp DESC LIMIT 5'
        );
        console.table(
            res.rows.map((r) => ({
                id: r.entry_id.substring(0, 8),
                hash: r.hash ? r.hash.substring(0, 16) + '...' : 'NULL',
                prev: r.prev_hash ? r.prev_hash.substring(0, 16) + '...' : 'NULL',
                time: r.timestamp,
            }))
        );
    } finally {
        client.release();
        await pool.end();
    }
}

check();
