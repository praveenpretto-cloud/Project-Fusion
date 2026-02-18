const axios = require('axios');
const https = require('https');

const API_URL = 'https://localhost:3000/api';
const API_KEY = 'fusion_bank_secret_key_2025';

const agent = new https.Agent({ rejectUnauthorized: false });
const client = axios.create({
    httpsAgent: agent,
    headers: { 'x-api-key': API_KEY },
    validateStatus: () => true
});

async function verifyMetrics() {
    console.log('🔍 Verifying Global Metrics...');

    const res = await client.get(`${API_URL}/observe?limit=1`);
    if (res.status !== 200) {
        console.error('❌ API Call failed');
        process.exit(1);
    }

    const meta = res.data.meta;
    if (meta && meta.total_volume !== undefined) {
        console.log(`✅ Global Volume Found: $${meta.total_volume}`);
        console.log(`✅ Total Count: ${meta.total_count}`);
        process.exit(0);
    } else {
        console.error('❌ Global Metrics Missing in Response');
        console.log('Response:', JSON.stringify(res.data, null, 2));
        process.exit(1);
    }
}

verifyMetrics();
