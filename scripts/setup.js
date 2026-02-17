const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const rootDir = path.join(__dirname, '..');

console.log('🚀 Starting Project Fusion Setup...');

// 1. Copy .env
const envPath = path.join(rootDir, '.env');
const examplePath = path.join(rootDir, '.env.example');

if (!fs.existsSync(envPath)) {
    if (fs.existsSync(examplePath)) {
        fs.copyFileSync(examplePath, envPath);
        console.log('✅ Created .env from .env.example');
    } else {
        console.warn('⚠️ .env.example not found, skipping .env creation');
    }
} else {
    console.log('ℹ️ .env already exists');
}

// 2. Generate Certs
const certDir = path.join(rootDir, 'certs');
if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir);
    console.log('✅ Created certs/ directory');
}

const keyPath = path.join(certDir, 'server.key');
const certPath = path.join(certDir, 'server.crt');
const caPath = path.join(certDir, 'ca.crt');

if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.log('🔐 Generating Self-Signed MD5/SHA256 Certificates via OpenSSL...');
    try {
        // Simple self-signed for dev
        execSync(
            `openssl req -nodes -new -x509 -keyout "${keyPath}" -out "${certPath}" -days 365 -subj "/CN=localhost"`,
            { stdio: 'ignore' }
        );
        // For client auth, we need a CA. For prototype, we reuse server cert as CA or generate one.
        // Let's just copy server cert as CA for simplicity in "Zero Budget" mode unless we want full chain.
        // Full chain is better.
        // Let's just generate a CA and then a client cert signed by it?
        // Too complex for a 1-click script.
        // Let's just assume the user accepts the server cert as CA for client auth testing.
        if (!fs.existsSync(caPath)) {
            fs.copyFileSync(certPath, caPath);
        }
        // Also generate client certs?
        const clientKey = path.join(certDir, 'client.key');
        const clientCert = path.join(certDir, 'client.crt');
        if (!fs.existsSync(clientKey)) {
            execSync(
                `openssl req -nodes -new -x509 -keyout "${clientKey}" -out "${clientCert}" -days 365 -subj "/CN=client"`,
                { stdio: 'ignore' }
            );
        }

        console.log('✅ Certificates generated in certs/');
    } catch (e) {
        console.warn(
            '⚠️ OpenSSL failed or not found. Please install OpenSSL or manually generate certs.'
        );
    }
} else {
    console.log('ℹ️ Certificates already exist');
}

// 3. Database Setup
(async () => {
    // Determine DB connection from env or default
    // Note: We might need to connect to 'postgres' db first to create the specific db?
    // But usually in dev, the DB exists or we use the default.
    // Let's assume the DB 'fusion_db' might not exist.
    // We try to connect to 'postgres' first.

    // Actually, asking user to createdb is safer.
    // But we can try using the 'pg' client to run schema.

    // Let's check if we can connect.
    const dbConfig = {
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || 'fusion_db',
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT || 5432,
    };

    const client = new Client(dbConfig);

    try {
        await client.connect();
        console.log('📦 Connected to Database...');

        const schemaPath = path.join(rootDir, 'db', 'schema.sql');
        if (fs.existsSync(schemaPath)) {
            const schema = fs.readFileSync(schemaPath, 'utf8');
            await client.query(schema);
            console.log('✅ Database schema applied successfully');
        } else {
            console.warn('⚠️ db/schema.sql not found');
        }
    } catch (err) {
        console.error('❌ Database Setup Failed:', err.message);
        console.log('   (Make sure PostgreSQL is running and the database exists)');
    } finally {
        await client.end();
    }

    console.log('\n✨ Setup Complete! Run "npm start" to launch.');
})();
