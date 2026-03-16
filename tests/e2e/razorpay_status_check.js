const axios = require('axios');
async function test() {
    console.log('Fetching checkout intent status directly...');
    const client = axios.create({
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
        validateStatus: () => true,
    });

    const payoutId = process.argv[2] || 'pout_SRnGQrD2Tra8lH';
    console.log(`Checking status for: ${payoutId}`);

    const res = await client.get(`https://api.razorpay.com/v1/payouts/${payoutId}`, {
        headers: {
            Authorization:
                'Basic ' +
                Buffer.from('rzp_test_SN8k00ChMU2TRu:Wv6R15WmcJ6Gx3MavpBkACRx').toString('base64'),
        },
    });
    console.log(JSON.stringify(res.data, null, 2));
}

test();
