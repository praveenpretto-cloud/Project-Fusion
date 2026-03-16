module.exports = {
    id: 'plugin_alipay_mock',
    name: 'Alipay Global Payments',

    // Predicate checks if currency is CNY
    supports: (instruction) => {
        return instruction.currency === 'CNY';
    },

    execute: async (instruction, context) => {
        const logger = context.logger;
        logger.info(
            `[ALIPAY_PLUGIN] Executing payment for ${instruction.amount} ${instruction.currency}`
        );

        return {
            adapter_type: 'ALIPAY_SDK',
            status: 'SUCCESS',
            intent_id: 'alipay_test_999',
            timestamp: new Date().toISOString(),
        };
    },
    rollback: async () => {
        return { status: 'MOCK_REVERSED' };
    },
};
