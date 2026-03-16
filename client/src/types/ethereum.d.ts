interface EthereumProvider {
    isMetaMask?: boolean;
    request: (args: { method: string; params?: any[] }) => Promise<any>;
    on?: (eventName: string, handler: (...args: any[]) => void) => void;
    providers?: EthereumProvider[];
}

interface Window {
    ethereum?: EthereumProvider;
}
