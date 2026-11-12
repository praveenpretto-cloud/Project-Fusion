const axios = require('axios');

async function test() {
    console.log('Fetching checkout intent status directly...');
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
        console.warn(
            '[E2E CONFIG] Skipping Razorpay check: RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET not set in environment.'
        );
        return;
    }

    const client = axios.create({
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: true }),
        validateStatus: () => true,
    });

    const payoutId = process.argv[2] || 'pout_sample_test_id';
    console.log(`Checking status for target payout ID...`);

    const res = await client.get(`https://api.razorpay.com/v1/payouts/${payoutId}`, {
        headers: {
            Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
        },
    });
    console.log(JSON.stringify(res.data, null, 2));
}

test();
