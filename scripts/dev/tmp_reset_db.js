require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'fusion_db',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432
});

async function reset() {
  try {
    const res = await pool.query("UPDATE instructions SET state = 'INITIATED' WHERE state = 'MANUAL_CHECK'");
    console.log(`Successfully reset ${res.rowCount} MANUAL_CHECK entries to INITIATED.`);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
reset();
