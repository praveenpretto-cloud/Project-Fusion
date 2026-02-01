// PAYMENTS ADAPTER

async function executePaymentRail(instruction, adapterConfig) {
    const { getAdapterCredential } = require('../vaultProvider');
    const stripeKey = getAdapterCredential('STRIPE_KEY');
    const stripe = require('stripe')(stripeKey);
    const logger = require('../logger');
    const { instructionId, amount, currency, sender, recipient } = instruction;

    logger.info(`[STRIPE] Creating PaymentIntent for ${amount} ${currency}`);

    // MOCK BYPASS FOR LOAD TESTING
    if (instruction.purpose === 'STRIPE_SCALE_TEST') {
        const mockDelay = Math.floor(Math.random() * 200) + 50; // 50-250ms delay
        await new Promise(resolve => setTimeout(resolve, mockDelay));
        logger.info(`[STRIPE MOCK] Simulated success for ${instructionId}`);
        return {
            status: 'SUCCESS',
            intent_id: `mock_pi_${instructionId}_${Date.now()}`,
            timestamp: new Date().toISOString()
        };
    }

    try {
        // Simulate different payment brands/types based on purpose or random
        const paymentMethods = {
            'CARD': 'pm_card_visa',
            'BANK_TRANSFER': 'pm_card_mastercard', // Simulated as Mastercard for demo
            'NEFT': 'pm_card_amex',              // Simulated as Amex for demo
            'SWIFT': 'pm_card_unionpay'          // Simulated as UnionPay for demo
        };

        const methodKey = (instruction.purpose || 'CARD').toUpperCase();
        const pmToUse = paymentMethods[methodKey] || 'pm_card_visa';

        const intent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100),
            currency: currency.toLowerCase(),
            payment_method_types: ['card'],
            payment_method: pmToUse,
            confirm: true,
            metadata: {
                instructionId,
                sender,
                recipient,
                simulated_rail: methodKey === 'CARD' ? 'VISA' : methodKey
            },
        });

        return {
            status: intent.status === 'succeeded' ? 'SUCCESS' : intent.status.toUpperCase(),
            intent_id: intent.id,
            timestamp: new Date().toISOString()
        };
    } catch (err) {
        logger.error(`[STRIPE ERROR] ${err.message}`);
        return { status: 'FAILED', error: err.message };
    }
}

async function queryStatus(intentId) {
    if (!intentId) return 'UNKNOWN';
    const { getAdapterCredential } = require('../vaultProvider');
    const stripeKey = getAdapterCredential('STRIPE_KEY');
    const stripe = require('stripe')(stripeKey);
    try {
        const intent = await stripe.paymentIntents.retrieve(intentId);
        return intent.status;
    } catch {
        return 'UNKNOWN';
    }
}

module.exports = { executePaymentRail, queryStatus };
