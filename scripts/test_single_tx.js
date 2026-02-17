require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.API_SECRET_KEY;
const PORT = process.env.PORT || 3000;

const options = {
    hostname: 'localhost',
    port: PORT,
    path: '/api/instruction/initiate',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'x-idempotency-key': `diag_${Date.now()}`,
    },
    key: fs.readFileSync(path.join(__dirname, 'certs', 'client.key')),
    cert: fs.readFileSync(path.join(__dirname, 'certs', 'client.crt')),
    ca: fs.readFileSync(path.join(__dirname, 'certs', 'ca.crt')),
    rejectUnauthorized: false,
};

console.log('--- STARTING DIAGNOSTIC TX ---');
const req = https.request(options, (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    let data = '';
    res.on('data', (chunk) => {
        console.log('CHUNK Received');
        data += chunk;
    });
    res.on('end', () => {
        console.log('BODY:', data);
        console.log('--- END DIAGNOSTIC TX ---');
    });
});

req.on('error', (e) => {
    console.error(`PROBLEM: ${e.message}`);
});

req.on('socket', (s) => {
    console.log('Socket assigned');
    s.on('connect', () => console.log('Socket connected'));
    s.on('secureConnect', () => console.log('Socket secureConnect'));
});

req.write(
    JSON.stringify({
        amount: 100.0,
        currency: 'USD',
        sender: 'user_diag',
        recipient: 'user_diag_r',
        purpose: 'PAYMENT',
    })
);
req.end();
console.log('Request sent, waiting...');
