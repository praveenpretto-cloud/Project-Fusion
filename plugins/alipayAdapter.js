module.exports = {
    id: 'plugin_alipay_mock',
    name: 'Alipay Global Payments',
    is_mock: true,

    // Predicate checks if currency is CNY
    supports: (instruction) => {
        return instruction.currency === 'CNY';
    },

    execute: async (instruction, context) => {
        const logger = context?.logger || console;
        logger.info(
            `[ALIPAY_PLUGIN] Executing simulated payment for ${instruction.amount} ${instruction.currency}`
        );

        return {
            adapter_type: 'ALIPAY_SDK',
            status: 'SIMULATED',
            simulated: true,
            settlement_confirmed: false,
            intent_id: 'alipay_test_999',
            timestamp: new Date().toISOString(),
            note: 'Isolated synthetic simulation. Not a provider-confirmed transaction.',
        };
    },
    rollback: async () => {
        return {
            status: 'SIMULATED_REVERSED',
            simulated: true,
            settlement_confirmed: false,
            note: 'Simulated rollback. Not a financial reversal.',
        };
    },
};
