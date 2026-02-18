const http = require('http');

const options = {
    hostname: 'localhost',
    port: 3001,
    path: '/',
    method: 'GET'
};

const req = http.request(options, (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    if (res.statusCode === 200) {
        console.log('✅ Frontend is accessible');
        process.exit(0);
    } else {
        console.log('❌ Frontend returned error');
        process.exit(1);
    }
});

req.on('error', (e) => {
    console.error(`❌ Problem with request: ${e.message}`);
    process.exit(1);
});

req.end();
