const { getAdapterCredential } = require('../../vaultProvider');
const stripeKey = getAdapterCredential('STRIPE_KEY');
const stripe = require('stripe')(stripeKey);

async function run() {
    try {
        console.log('Fetching recent Stripe PaymentIntents...');
        const paymentIntents = await stripe.paymentIntents.list({ limit: 10 });
        for (const pi of paymentIntents.data) {
            console.log({
                id: pi.id,
                amount: pi.amount / 100,
                currency: pi.currency.toUpperCase(),
                status: pi.status,
                instructionId: pi.metadata.instructionId,
                sender: pi.metadata.sender,
                recipient: pi.metadata.recipient,
                created: new Date(pi.created * 1000).toISOString(),
            });
        }
    } catch (e) {
        console.error('Error fetching PaymentIntents:', e.message);
    }
}
run();
