const { Pool } = require('pg');
const pool = new Pool({
    connectionString: 'postgres://postgres:praveen123@localhost:5432/fusion_db',
});
pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")
    .then((res) => {
        console.table(res.rows);
        process.exit(0);
    })
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
