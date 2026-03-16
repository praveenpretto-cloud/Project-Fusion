const axios = require('axios');

async function testFetchAccounts() {
    console.log('Fetching Razorpay accounts associated with the new key...');
    const client = axios.create({
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
        validateStatus: () => true,
    });
    const res = await client.get(
        `https://api.razorpay.com/v1/fund_accounts?account_type=bank_account`,
        {
            headers: {
                Authorization:
                    'Basic ' +
                    Buffer.from('rzp_test_SRnXnFMObOaShd:IYyLIUdxLYBcge5ZpQ0PP1jV').toString(
                        'base64'
                    ),
            },
        }
    );
    console.log('Accounts search result:');
    console.log(JSON.stringify(res.data, null, 2));
}

testFetchAccounts();
