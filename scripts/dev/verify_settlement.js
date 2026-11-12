const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgres://postgres:praveen123@localhost:5432/fusion_db' });
pool.query("SELECT instruction_id, external_intent_id, state FROM instructions WHERE currency = 'INR' AND state != 'SETTLED' LIMIT 5").then(res => {
    if (res.rows.length > 0) {
        console.table(res.rows);
    } else {
        console.log('No unsettled INR transactions found.');
    }
    process.exit(0);
}).catch(e => {
    console.error(e);
    process.exit(1);
});
