const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'fusion_db',
    password: process.env.DB_PASSWORD || 'praveen123',
    port: process.env.DB_PORT || 5432,
});

async function writeLedger(client, instructionId, sender, recipient, amount, currency) {
    const entryId1 = crypto.randomUUID();
    const entryId2 = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // 1. Transaction-Level Advisory Lock (SERIALIZABLE SAGA TIP)
    await client.query('SELECT pg_advisory_xact_lock(998877)');

    const lastEntry = await client.query(
        'SELECT hash FROM ledger_journal ORDER BY sequence_id DESC LIMIT 1'
    );
    let prevHash = lastEntry.rows.length > 0 ? lastEntry.rows[0].hash : 'GENESIS_HASH';

    const payload1 = `${prevHash}${entryId1}${instructionId}${sender}DEBIT${amount}${currency}${timestamp}`;
    const hash1 = crypto.createHash('sha256').update(payload1).digest('hex');

    await client.query(
        `INSERT INTO ledger_journal (entry_id, instruction_id, account_id, direction, amount, currency, timestamp, hash, prev_hash) 
         VALUES ($1, $2, $3, 'DEBIT', $4, $5, $6, $7, $8)`,
        [entryId1, instructionId, sender, amount, currency, timestamp, hash1, prevHash]
    );

    const payload2 = `${hash1}${entryId2}${instructionId}${recipient}CREDIT${amount}${currency}${timestamp}`;
    const hash2 = crypto.createHash('sha256').update(payload2).digest('hex');

    await client.query(
        `INSERT INTO ledger_journal (entry_id, instruction_id, account_id, direction, amount, currency, timestamp, hash, prev_hash) 
         VALUES ($1, $2, $3, 'CREDIT', $4, $5, $6, $7, $8)`,
        [entryId2, instructionId, recipient, amount, currency, timestamp, hash2, hash1]
    );

    console.log(`[LEDGER_TEST] Wrote entries for ${instructionId.slice(0,8)}. Hash Chain: ${prevHash.slice(0,8)} -> ${hash1.slice(0,8)} -> ${hash2.slice(0,8)}`);
    
    return hash2;
}

async function runTest() {
    console.log("Starting Concurrency Ledger Test...");
    const numConcurrent = 5;
    const promises = [];

    for (let i = 0; i < numConcurrent; i++) {
        promises.push((async () => {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const id = crypto.randomUUID();
                await writeLedger(client, id, 'SENDER_CONC', 'RECP_CONC', 100, 'USD', 0);
                await client.query('COMMIT');
                console.log(`Transaction ${i} committed.`);
            } catch (err) {
                await client.query('ROLLBACK');
                console.log(`Transaction ${i} failed: ${err.message}`);
            } finally {
                client.release();
            }
        })());
    }

    await Promise.all(promises);

    // Verify hash chain
    const res = await pool.query('SELECT hash, prev_hash FROM ledger_journal ORDER BY sequence_id DESC LIMIT 10');
    console.log("\nRecent Ledger Entries (Hash Chain):");
    const rows = res.rows;
    for (let i = 0; i < rows.length - 1; i++) {
        const current = rows[i];
        const prev = rows[i+1];
        if (current.prev_hash === prev.hash) {
            console.log(`[OK] Entry ${i} (sequence_id: ${current.sequence_id || '?'}) points correctly to ${i+1}`);
        } else {
            console.log(`[FAIL] Entry ${i} (prev_hash: ${current.prev_hash.slice(0,8)}) DOES NOT match Entry ${i+1} (hash: ${prev.hash.slice(0,8)})`);
        }
    }
    
    await pool.end();
}

runTest();
