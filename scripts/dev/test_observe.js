const http = require('http');

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/observe?limit=10',
    method: 'GET',
    headers: {
        'x-api-key': 'fusion_bank_secret_key_2025'
    }
};

const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    res.on('end', () => {
        try {
            const parsed = JSON.parse(data);
            console.log(JSON.stringify(parsed.data[0], null, 2));
        } catch (e) {
            console.error('Error parsing response:', e);
            console.log(data);
        }
    });
});

req.on('error', (e) => {
    console.error(`problem with request: ${e.message}`);
});

req.end();
