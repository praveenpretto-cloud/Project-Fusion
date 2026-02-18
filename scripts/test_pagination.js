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

async function testPagination() {
    console.log('🔍 Testing Pagination...');

    // Page 1
    const p1 = await client.get(`${API_URL}/observe?limit=1&offset=0`);
    if (p1.status !== 200) {
        console.error('❌ Page 1 failed');
        process.exit(1);
    }
    const id1 = p1.data.data[0]?.instruction_id;
    console.log(`   Page 1 ID: ${id1}`);

    // Page 2
    const p2 = await client.get(`${API_URL}/observe?limit=1&offset=1`);
    if (p2.status !== 200) {
        console.error('❌ Page 2 failed');
        process.exit(1);
    }
    const id2 = p2.data.data[0]?.instruction_id;
    console.log(`   Page 2 ID: ${id2}`);

    if (id1 && id2 && id1 !== id2) {
        console.log('✅ Pagination Works! IDs are different.');
        process.exit(0);
    } else {
        console.error('❌ Pagination Failed: IDs are same or missing.');
        process.exit(1);
    }
}

testPagination();
