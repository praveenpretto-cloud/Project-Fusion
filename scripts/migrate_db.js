const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'fusion_db',
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
});

async function migrate() {
    console.log('📦 Starting Database Migration...');
    const client = await pool.connect();
    try {
        const sqlPath = path.join(__dirname, '..', 'db', 'migrations', 'add_hash_chain.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');
        console.log(`Executing: ${sqlPath}`);

        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');

        console.log('✅ Migration "add_hash_chain" applied successfully.');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Migration Failed:', err.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate();
