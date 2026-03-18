interface EthereumProvider {
    isMetaMask?: boolean;
    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    on?: (eventName: string, handler: (...args: unknown[]) => void) => void;
    providers?: EthereumProvider[];
}

interface Window {
    ethereum?: EthereumProvider;
}
