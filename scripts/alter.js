const { Client } = require('pg');
require('dotenv').config({ path: __dirname + '/../.env' });

const dbConfig = {
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'fusion_db',
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
};

const client = new Client(dbConfig);

client
    .connect()
    .then(() => {
        console.log('Connected to DB');
        return client.query(
            `ALTER TABLE instructions ADD COLUMN IF NOT EXISTS fx_rate DECIMAL(20, 6)`
        );
    })
    .then(() => {
        return client.query(
            `ALTER TABLE instructions ADD COLUMN IF NOT EXISTS quote_id VARCHAR(100)`
        );
    })
    .then(() => {
        console.log('✅ Altered database successfully');
        process.exit(0);
    })
    .catch((err) => {
        console.error('❌ Database migration failed:', err.message);
        process.exit(1);
    });
