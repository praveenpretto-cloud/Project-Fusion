const { Client } = require('pg');
const client = new Client({
    connectionString: 'postgres://postgres:praveen123@localhost:5432/fusion_db',
});

async function check() {
    try {
        await client.connect();
        const res = await client.query(
            "SELECT instruction_id, state, currency, purpose FROM instructions WHERE purpose LIKE 'SEQ_TEST_%' ORDER BY purpose ASC"
        );
        console.table(res.rows);
    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

check();
