// BROKERAGE ADAPTER

async function executeBrokerageTrade(instruction, adapterConfig) {
    const { instructionId, amount, currency, purpose } = instruction;

    const logger = require('../logger');
    logger.info(`[ADAPTER] BROKERAGE executing ${purpose} trade with ${amount} ${currency}`);

    await new Promise((resolve) => setTimeout(resolve, 200));

    return {
        adapter_type: 'BROKERAGE',
        status: 'SUCCESS',
        order_id: `ORD-${Date.now()}`,
        filled_quantity: amount,
        average_price: (Math.random() * 100).toFixed(2),
        timestamp: new Date().toISOString(),
    };
}

module.exports = { executeBrokerageTrade };
