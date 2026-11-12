const axios = require('axios');

async function testFetchAccounts() {
    console.log('Fetching Razorpay accounts associated with configured key...');
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
        console.warn(
            '[E2E CONFIG] Skipping Razorpay account check: RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET not set in environment.'
        );
        return;
    }

    const client = axios.create({
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: true }),
        validateStatus: () => true,
    });
    const res = await client.get(
        `https://api.razorpay.com/v1/fund_accounts?account_type=bank_account`,
        {
            headers: {
                Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
            },
        }
    );
    console.log('Accounts search result:');
    console.log(JSON.stringify(res.data, null, 2));
}

testFetchAccounts();
