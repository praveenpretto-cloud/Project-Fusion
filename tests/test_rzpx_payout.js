require('dotenv').config();

async function testPayout() {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
        console.error('Missing keys');
        process.exit(1);
    }

    const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const headers = { 'Content-Type': 'application/json', Authorization: auth };

    try {
        console.log('1. Creating Contact...');
        let res = await fetch('https://api.razorpay.com/v1/contacts', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                name: 'Rahul Sharma (Vendor)',
                email: 'rahul.sandbox@example.com',
                contact: '919999999999',
                type: 'vendor',
                reference_id: 'test_' + Date.now(),
            }),
        });
        let contact = await res.json();
        if (contact.error) throw contact.error;
        console.log('Contact Created: ', contact.id);

        console.log('2. Creating Fund Account...');
        res = await fetch('https://api.razorpay.com/v1/fund_accounts', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                contact_id: contact.id,
                account_type: 'bank_account',
                bank_account: {
                    name: 'Rahul Sharma',
                    ifsc: 'HDFC0000053',
                    account_number: '765432123456789',
                },
            }),
        });
        let fundAccount = await res.json();
        if (fundAccount.error) throw fundAccount.error;
        console.log('Fund Account Created: ', fundAccount.id);

        console.log('3. Initiating Payout...');
        res = await fetch('https://api.razorpay.com/v1/payouts', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                account_number: '2323230040153680',
                fund_account_id: fundAccount.id,
                amount: 10000,
                currency: 'INR',
                mode: 'IMPS',
                purpose: 'payout',
                queue_if_low_balance: true,
                reference_id: 'payout_' + Date.now(),
                narration: 'Project Fusion IFSCA',
            }),
        });
        let payout = await res.json();
        console.log('Payout Response: ');
        console.log(payout);
    } catch (err) {
        console.error('Flow failed: ', err);
    }
}

testPayout();
