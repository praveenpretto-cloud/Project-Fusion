const { Pool } = require('pg');
const pool = new Pool({
    connectionString: 'postgres://postgres:praveen123@localhost:5432/fusion_db',
});

async function check() {
    const res = await pool.query(
        'SELECT instruction_id, currency, state, external_intent_id FROM instructions ORDER BY created_at DESC LIMIT 20'
    );
    console.table(res.rows);
    process.exit(0);
}
check().catch((e) => {
    console.error(e);
    process.exit(1);
});
