const adapterRegistry = require('../../core/AdapterRegistry');
const path = require('path');

describe('Adapter SDK & Registry', () => {
    it('should dynamically load plugins from a directory', () => {
        const pluginsDir = path.join(__dirname, '../../plugins');
        adapterRegistry.loadPluginsFromDirectory(pluginsDir);

        // Find the alipay adapter
        const mockInstruction = { currency: 'CNY', amount: 500 };
        const adapter = adapterRegistry.findAdapterForInstruction(mockInstruction);

        expect(adapter).toBeDefined();
        expect(adapter.id).toBe('plugin_alipay_mock');
    });

    it('should successfully execute the dynamically loaded plugin', async () => {
        const mockInstruction = { currency: 'CNY', amount: 500 };
        const adapter = adapterRegistry.findAdapterForInstruction(mockInstruction);

        const mockContext = {
            logger: { info: jest.fn(), error: jest.fn() },
        };

        const result = await adapter.execute(mockInstruction, mockContext);

        expect(result.status).toBe('SUCCESS');
        expect(result.adapter_type).toBe('ALIPAY_SDK');
    });
});
