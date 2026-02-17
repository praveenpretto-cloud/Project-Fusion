const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'fusion_db',
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
});

async function verifyChain() {
    console.log('🔐 Starting Ledger Integrity Verification...');
    const client = await pool.connect();
    try {
        // Fetch all entries in strict chronological order
        const res = await client.query('SELECT * FROM ledger_journal ORDER BY timestamp ASC, entry_id ASC');
        const chain = res.rows;

        console.log(`Scanning ${chain.length} ledger entries...`);
        let verifiedCount = 0;
        let errors = 0;

        for (let i = 0; i < chain.length; i++) {
            const entry = chain[i];

            // Skip genesis blocks or pre-migration data if hash is null
            if (!entry.hash) {
                console.warn(`[SKIP] Entry ${entry.entry_id} has no hash (Pre-Migration Data)`);
                continue;
            }

            // 1. Verify Linkage (Prev Hash)
            if (i > 0) {
                const prevEntry = chain[i - 1];
                if (prevEntry.hash && entry.prev_hash !== prevEntry.hash) {
                    // Logic: If prevEntry has a hash, the current entry MUST point to it
                    // Exception: If we have gaps due to migration, we might need softer checks.
                    // For this prototype, we assume continuous chain after migration.
                    console.error(`❌ BROKEN CHAIN at ${entry.entry_id}`);
                    console.error(`   Expected Prev: ${prevEntry.hash}`);
                    console.error(`   Actual Prev:   ${entry.prev_hash}`);
                    errors++;
                }
            }

            // 2. Verify Data Integrity (Re-Hash)
            const payload = `${entry.prev_hash}${entry.entry_id}${entry.instruction_id}${entry.account_id}${entry.direction}${entry.amount}${entry.currency}${entry.timestamp.toISOString()}`;
            const computedHash = crypto.createHash('sha256').update(payload).digest('hex');

            if (computedHash !== entry.hash) {
                console.error(`❌ TAMPER DETECTED at ${entry.entry_id}`);
                console.error(`   Stored Hash:   ${entry.hash}`);
                console.error(`   Computed Hash: ${computedHash}`);
                errors++;
            } else {
                verifiedCount++;
            }
        }

        if (errors === 0) {
            console.log(`\n✅ INTEGRITY CONFIRMED: ${verifiedCount} blocks verified.`);
            console.log('   No tampering detected. The ledger is immutable.');
        } else {
            console.error(`\n❌ VERIFICATION FAILED: ${errors} integrity violations found.`);
            process.exit(1);
        }

    } catch (err) {
        console.error('System Error:', err.message);
    } finally {
        client.release();
        await pool.end();
    }
}

verifyChain();
