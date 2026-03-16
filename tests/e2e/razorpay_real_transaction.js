const axios = require('axios');
const https = require('https');

const API_URL = 'https://localhost:3000/api';
const API_KEY = process.env.API_SECRET_KEY || 'fusion_bank_secret_key_2025';

const agent = new https.Agent({ rejectUnauthorized: false });
const client = axios.create({
    httpsAgent: agent,
    headers: { 'x-api-key': API_KEY },
    validateStatus: () => true,
});

async function onboardUser(userId) {
    try {
        await client.post(`${API_URL}/kyc/onboard`, {
            user_id: userId,
            document_type: 'PAN',
            document_number: `TEST${Date.now()}`,
        });
    } catch {
        // ignore if already onboarded
    }
}

async function getAuthToken(userId) {
    const otpGen = await client.post(`${API_URL}/auth/otp/generate`, { user_id: userId });
    const otpVerify = await client.post(`${API_URL}/auth/otp/verify`, {
        user_id: userId,
        otp_code: otpGen.data.otp_code,
    });
    return otpVerify.data.auth_token;
}

async function runRealRazorpayTransaction() {
    console.log('🚀 EXECUTING REAL RAZORPAY TESTNET TRANSACTION');
    console.log('   (This will appear in your RazorpayX Dashboard under Payouts)');
    try {
        const userId = 'user_razorpay_test';
        console.log('\n1. INITIATING (including KYC and Auth)...');
        await onboardUser(userId);
        const auth_token = await getAuthToken(userId);

        const initRes = await client.post(
            `${API_URL}/instruction/initiate`,
            {
                amount: 15.5, // Specific amount to easily find
                currency: 'INR',
                sender: userId,
                recipient: 'Rahul_Sharma', // Needs a name for contact creation
                purpose: 'CROSS_BORDER_PAYOUT', // This triggers the REAL Razorpay Adapter as it differs from RAZORPAY_SCALE_TEST
                auth_token,
            },
            {
                headers: { 'x-idempotency-key': `real_rzp_${Date.now()}_init` },
            }
        );

        if (initRes.status !== 200) {
            console.error('❌ INITIATE FAILED:', initRes.data);
            process.exit(1);
        }
        const { instructionId } = initRes.data;
        console.log(`   ✅ instructionId: ${instructionId}`);

        // 2. POLICY
        console.log('\n2. EVALUATING POLICY...');
        const polRes = await client.post(
            `${API_URL}/policy/evaluate`,
            { instructionId },
            {
                headers: { 'x-idempotency-key': `real_rzp_${Date.now()}_pol` },
            }
        );
        if (polRes.status !== 200) {
            console.error('❌ POLICY FAILED:', polRes.data);
            process.exit(1);
        }

        // 3. ROUTE
        console.log('\n3. ROUTING...');
        const routeRes = await client.post(
            `${API_URL}/orchestration/route`,
            { instructionId },
            {
                headers: { 'x-idempotency-key': `real_rzp_${Date.now()}_route` },
            }
        );
        if (routeRes.status !== 200) {
            console.error('❌ ROUTE FAILED:', routeRes.data);
            process.exit(1);
        }

        const { selectedAdapter } = routeRes.data;
        if (selectedAdapter !== 'ADAPTER_RAZORPAY') {
            console.error(`❌ WRONG ADAPTER SELECTED: ${selectedAdapter}`);
            process.exit(1);
        }
        console.log(`   ✅ Adapter Selected: ${selectedAdapter}`);

        // 4. EXECUTE
        console.log('\n4. EXECUTING REAL ADAPTER...');
        const execRes = await client.post(
            `${API_URL}/adapter/execute`,
            { instructionId, adapter: selectedAdapter },
            {
                headers: { 'x-idempotency-key': `real_rzp_${Date.now()}_exec` },
            }
        );

        if (execRes.status !== 200) {
            console.error('❌ EXECUTE FAILED:', execRes.data);
            process.exit(1);
        }

        console.log('\n✅ SUCCESS: Real Transaction Completed (or queued by webhook)!');
        console.log('------------------------------------------------');
        console.log('🔍 RAZORPAY INTENT (PAYOUT) ID:', execRes.data.adapter_result?.intent_id);
        console.log('   Check your RazorpayX Dashboard for this ID.');
        console.log('------------------------------------------------');
    } catch (err) {
        console.error('❌ EXCEPTION:', err.message);
        if (err.response) console.error('   RESPONSE:', err.response.data);
    }
}

runRealRazorpayTransaction();
