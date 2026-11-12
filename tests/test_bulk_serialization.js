const adapterRegistry = require('../core/AdapterRegistry');

async function test() {
    console.log('[TEST] Evoking AdapterRegistry Batch Serialization...');

    const instructions = [
        {
            instruction_id: 'bulk-ser-1',
            amount: 1.0,
            currency: 'XLM',
            sender: 'GENERIC_USER_099',
            recipient: 'STELLAR_B_1',
            purpose: 'SER_TEST',
        },
        {
            instruction_id: 'bulk-ser-2',
            amount: 1.0,
            currency: 'XLM',
            sender: 'GENERIC_USER_099',
            recipient: 'STELLAR_B_2',
            purpose: 'SER_TEST',
        },
        {
            instruction_id: 'bulk-ser-3',
            amount: 1.0,
            currency: 'XLM',
            sender: 'GENERIC_USER_099',
            recipient: 'STELLAR_B_3',
            purpose: 'SER_TEST',
        },
    ];

    try {
        console.log('Dispatching batch of 3 XLM instructions...');
        const results = await adapterRegistry.executeBatchConcurrently(instructions);

        results.forEach((res, i) => {
            console.log(`Instruction ${i + 1}: ${res.status} ${res.error || ''}`);
        });
    } catch (e) {
        console.error('TEST FATAL:', e);
    }
}
test();
