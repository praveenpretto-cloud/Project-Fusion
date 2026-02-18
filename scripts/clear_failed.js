const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function clearFailed() {
    console.log('🗑️  Deleting FAILED transactions...');

    try {
        // 1. Delete from Ledger Journal
        const ledgerResult = await pool.query(`
            DELETE FROM ledger_journal
            WHERE instruction_id::text IN (
                SELECT instruction_id::text 
                FROM instructions 
                WHERE state = 'FAILED'
            )
        `);
        console.log(`✅ Deleted ${ledgerResult.rowCount} dependent ledger entries.`);

        // 2. Delete from Audit Trail
        const auditResult = await pool.query(`
            DELETE FROM audit_trail
            WHERE instruction_id IN (
                SELECT instruction_id::text 
                FROM instructions 
                WHERE state = 'FAILED'
            )
        `);
        console.log(`✅ Deleted ${auditResult.rowCount} dependent audit logs.`);

        // 2. Delete from Instructions (Parent Table)
        const result = await pool.query(`
            DELETE FROM instructions
            WHERE state = 'FAILED'
        `);

        console.log(`✅ Deleted ${result.rowCount} FAILED transactions.`);
        console.log('   The dashboard should now be free of red "Failed" items.');

    } catch (err) {
        console.error('❌ Error during deletion:', err);
    } finally {
        await pool.end();
    }
}

clearFailed();
