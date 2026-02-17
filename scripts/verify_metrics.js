const https = require('https');
const fs = require('fs');
const path = require('path');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Allow self-signed certs

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/metrics',
    method: 'GET'
};

const req = https.request(options, res => {
    console.log(`StatusCode: ${res.statusCode}`);
    let data = '';

    res.on('data', chunk => {
        data += chunk;
    });

    res.on('end', () => {
        if (data.includes('fusion_http_request_duration_seconds') && data.includes('fusion_transaction_total')) {
            console.log('✅ Metrics Verification PASSED');
            console.log('   Found expected metrics keys.');
        } else {
            console.error('❌ Metrics Verification FAILED');
            console.error('   Expected keys not found in response.');
            console.log('Response Preview:', data.substring(0, 200));
            process.exit(1);
        }
    });
});

req.on('error', error => {
    console.error('❌ Config Verification FAILED: ' + error.message);
    process.exit(1);
});

req.end();
