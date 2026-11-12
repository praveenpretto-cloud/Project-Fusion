const { Pool } = require('pg');
const pool = new Pool({
    connectionString: 'postgres://postgres:praveen123@localhost:5432/fusion_db',
});

async function check() {
    const res = await pool.query(
        "SELECT * FROM instructions WHERE instruction_id = 'c71236f0-114e-47ce-8d2c-e64f9fb3407a'"
    );
    console.log(JSON.stringify(res.rows[0], null, 2));
    process.exit(0);
}
check().catch((e) => {
    console.error(e);
    process.exit(1);
});
