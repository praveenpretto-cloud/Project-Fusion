const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const API_KEY = process.env.API_SECRET_KEY || 'fusion_bank_secret_key_2025';
const URL = 'https://localhost:3000/api/instruction/initiate';

async function test() {
    try {
        console.log('Sending request to:', URL);
        const response = await fetch(URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEY,
                'x-idempotency-key': 'debug-' + Date.now()
            },
            body: JSON.stringify({
                amount: 100.50,
                currency: "USD",
                sender: "user_123",
                recipient: "user_456",
                purpose: "DEBUG_PAYMENT"
            })
        });

        console.log('Status:', response.status);
        const text = await response.text();
        console.log('Body:', text);
    } catch (err) {
        console.error('Fetch error:', err);
    }
}

test();
