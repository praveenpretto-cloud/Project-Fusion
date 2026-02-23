'use client';

import { useState, useEffect } from 'react';

const COINS = [
    { s: 'BTC', n: 'Bitcoin', p: 64230.50, c: 2.4 }, { s: 'ETH', n: 'Ethereum', p: 3450.20, c: 1.8 },
    { s: 'SOL', n: 'Solana', p: 145.80, c: 5.2 }, { s: 'XLM', n: 'Stellar', p: 0.11, c: 0.5 },
    { s: 'ADA', n: 'Cardano', p: 0.45, c: -1.2 }, { s: 'DOT', n: 'Polkadot', p: 7.20, c: -0.8 },
    { s: 'XRP', n: 'Ripple', p: 0.62, c: 1.1 }, { s: 'DOGE', n: 'Dogecoin', p: 0.16, c: 4.5 },
    { s: 'AVAX', n: 'Avalanche', p: 35.40, c: 2.1 }, { s: 'SHIB', n: 'Shiba Inu', p: 0.00002, c: 3.2 },
    { s: 'LINK', n: 'Chainlink', p: 18.50, c: 0.9 }, { s: 'MATIC', n: 'Polygon', p: 0.68, c: -2.1 },
    { s: 'LTC', n: 'Litecoin', p: 85.20, c: 1.5 }, { s: 'BCH', n: 'Bitcoin Cash', p: 450.10, c: 1.2 },
    { s: 'UNI', n: 'Uniswap', p: 10.50, c: -1.5 }, { s: 'ATOM', n: 'Cosmos', p: 8.90, c: 0.4 },
    { s: 'ETC', n: 'Ethereum Classic', p: 28.50, c: 0.2 }, { s: 'XMR', n: 'Monero', p: 120.40, c: -0.5 },
    { s: 'FIL', n: 'Filecoin', p: 6.20, c: -3.2 }, { s: 'HBAR', n: 'Hedera', p: 0.12, c: 4.1 },
    { s: 'ICP', n: 'Internet Computer', p: 12.50, c: 6.5 }, { s: 'APT', n: 'Aptos', p: 9.20, c: 2.2 },
    { s: 'NEAR', n: 'Near Protocol', p: 6.80, c: 1.9 }, { s: 'ARB', n: 'Arbitrum', p: 1.10, c: -4.5 },
    { s: 'OP', n: 'Optimism', p: 2.40, c: -3.1 }, { s: 'STX', n: 'Stacks', p: 2.10, c: 5.4 },
    { s: 'RNDR', n: 'Render', p: 10.20, c: 8.1 }, { s: 'INJ', n: 'Injective', p: 28.40, c: -1.2 },
    { s: 'GRT', n: 'The Graph', p: 0.32, c: 2.5 }, { s: 'IMX', n: 'Immutable', p: 2.10, c: 0.8 },
    { s: 'VET', n: 'VeChain', p: 0.04, c: 1.5 }, { s: 'AAVE', n: 'Aave', p: 95.20, c: 3.2 },
    { s: 'ALGO', n: 'Algorand', p: 0.22, c: -0.5 }, { s: 'QNT', n: 'Quant', p: 110.50, c: 1.1 },
    { s: 'FTM', n: 'Fantom', p: 0.85, c: 6.2 }, { s: 'SAND', n: 'Sandbox', p: 0.55, c: -1.8 },
    { s: 'MANA', n: 'Decentraland', p: 0.52, c: -2.1 }, { s: 'THETA', n: 'Theta', p: 2.40, c: 4.2 },
    { s: 'AXS', n: 'Axie Infinity', p: 8.50, c: 1.1 }, { s: 'EGLD', n: 'MultiversX', p: 45.20, c: 0.9 }
];

const CURRENCIES = [
    { code: 'USD', flag: '🇺🇸', rate: 1.0 },
    { code: 'EUR', flag: '🇪🇺', rate: 0.92 },
    { code: 'GBP', flag: '🇬🇧', rate: 0.79 },
    { code: 'SGD', flag: '🇸🇬', rate: 1.35 },
    { code: 'JPY', flag: '🇯🇵', rate: 151.2 },
    { code: 'CHF', flag: '🇨🇭', rate: 0.90 },
    { code: 'AUD', flag: '🇦🇺', rate: 1.52 },
    { code: 'CAD', flag: '🇨🇦', rate: 1.36 }
];

// --- TYPES ---
interface Instruction {
    instruction_id: string;
    amount: string;
    currency: string;
    sender_hash: string;
    recipient_hash: string;
    purpose: string;
    state: 'INITIATED' | 'LOCKED' | 'PENDING_EXECUTION' | 'SETTLED' | 'FAILED' | 'MANUAL_CHECK';
    timestamp: string;
    trace_id?: string;
}

// --- MAIN DASHBOARD COMPONENT ---
export default function Dashboard() {
    const [instructions, setInstructions] = useState<Instruction[]>([]);
    const [activeTab, setActiveTab] = useState<'home' | 'payments' | 'crypto' | 'wealth'>('home');
    const [lastUpdated, setLastUpdated] = useState<string>('Loading...');
    const [totalVolume, setTotalVolume] = useState<number>(0);

    // Exchange State
    const [fromCurrency, setFromCurrency] = useState(CURRENCIES[0]);
    const [toCurrency, setToCurrency] = useState(CURRENCIES[1]);

    // --- POLLING & DATA FETCHING ---
    useEffect(() => {
        const fetchData = async () => {
            try {
                // Fetch ALL recent txns for client-side filtering (Simulating "Smart Sync")
                const res = await fetch(`/api/observe?limit=100`);
                if (res.ok) {
                    const data = await res.json();
                    const sorted = (data.data || []).sort(
                        (a: Instruction, b: Instruction) =>
                            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
                    );
                    setInstructions(sorted);
                    if (data.meta?.total_volume) setTotalVolume(data.meta.total_volume);
                    setLastUpdated(new Date().toLocaleTimeString());
                }
            } catch (err) {
                console.error(err);
            }
        };
        fetchData();
        const interval = setInterval(fetchData, 2000);
        return () => clearInterval(interval);
    }, []);

    // --- FILTERING LOGIC ---
    const getFilteredInstructions = () => {
        switch (activeTab) {
            case 'payments':
                return instructions.filter(i => ['USD', 'EUR', 'SGD'].includes(i.currency) && i.purpose !== 'INVESTMENT');
            case 'crypto':
                return instructions.filter(i => ['XLM', 'USDC', 'BTC', 'ETH'].includes(i.currency));
            case 'wealth':
                return instructions.filter(i => i.purpose === 'INVESTMENT' || i.currency === 'AAPL' || i.currency === 'GOOGL');
            default:
                return instructions; // Home shows everything (Global Feed)
        }
    };

    const filteredData = getFilteredInstructions();
    // --- TRANSACTIONS & MODALS ---

    // --- MODAL HANDLERS ---
    const [activeModal, setActiveModal] = useState<null | 'add' | 'exchange' | 'send' | 'more' | 'buy_crypto' | 'sell_crypto' | 'send_crypto'>(null);
    const [actionAmount, setActionAmount] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);

    const handleSimulateAction = async () => {
        setIsProcessing(true);
        // Simulate network delay for realism
        await new Promise(r => setTimeout(r, 1500));
        setIsProcessing(false);
        setActiveModal(null);
        setActionAmount('');
        // In a real app, this would refresh data. 
        // For the demo, the polling will pick up any actual backend changes, 
        // or we just close to show smooth interaction.
    };

    const assets = calculateAssets(instructions);

    return (
        <div className="min-h-screen bg-[#0F1115] text-white font-sans selection:bg-blue-500/30 relative">
            {/* TOP NAVIGATION (REVOLUT STYLE) */}
            <nav className="border-b border-gray-800 bg-[#0F1115] sticky top-0 z-40">
                <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
                    <div className="flex items-center gap-8">
                        <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">
                            Fusion<span className="text-gray-600 font-light">|Core</span>
                        </h1>
                        <div className="hidden md:flex gap-1 bg-gray-900/50 p-1 rounded-full border border-gray-800">
                            <TabButton label="Home" active={activeTab === 'home'} onClick={() => setActiveTab('home')} />
                            <TabButton label="Payments" active={activeTab === 'payments'} onClick={() => setActiveTab('payments')} />
                            <TabButton label="Crypto" active={activeTab === 'crypto'} onClick={() => setActiveTab('crypto')} />
                            <TabButton label="Wealth" active={activeTab === 'wealth'} onClick={() => setActiveTab('wealth')} />
                        </div>
                    </div>
                    <div className="flex items-center gap-4 text-xs font-mono text-gray-500">
                        <span className="flex items-center gap-1.5 text-green-500">
                            <span className="relative flex h-2 w-2">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                            </span>
                            LIVE
                        </span>
                        <span>{lastUpdated}</span>
                    </div>
                </div>
            </nav>

            <main className={`max-w-6xl mx-auto px-6 py-8 transition-opacity duration-300 ${activeModal ? 'opacity-30 blur-sm pointer-events-none' : ''}`}>
                {/* DYNAMIC HEADER BASED ON TAB */}
                <div className="mb-10">
                    <h2 className="text-gray-400 text-sm font-medium uppercase tracking-wider mb-2">
                        {activeTab === 'home' ? 'Total Liquidity' : `${activeTab} Balance`}
                    </h2>
                    <div className="flex items-baseline gap-4">
                        <span className="text-5xl font-bold tracking-tight text-white">
                            {activeTab === 'home' ? `$${totalVolume.toLocaleString(undefined, { minimumFractionDigits: 2 })}` :
                                activeTab === 'crypto' ? `${assets.crypto.toLocaleString()} XLM` :
                                    activeTab === 'wealth' ? `$${assets.wealth.toLocaleString()}` :
                                        `$${assets.fiat.toLocaleString()}`}
                        </span>
                        <span className="text-green-500 text-sm font-medium bg-green-900/20 px-2 py-0.5 rounded-full border border-green-900/30">
                            +2.4% today
                        </span>
                    </div>
                </div>

                {/* ACTION BUTTONS (DYNAMIC) */}
                <div className="flex gap-4 mb-10">
                    {activeTab === 'crypto' ? (
                        <>
                            <ActionButton label="Buy" icon="+" primary onClick={() => setActiveModal('buy_crypto')} />
                            <ActionButton label="Sell" icon="-" onClick={() => setActiveModal('sell_crypto')} />
                            <ActionButton label="Send" icon="→" onClick={() => setActiveModal('send_crypto')} />
                            <ActionButton label="More" icon="•••" onClick={() => setActiveModal('more')} />
                        </>
                    ) : (
                        <>
                            <ActionButton label="Add Money" icon="+" primary onClick={() => setActiveModal('add')} />
                            <ActionButton label="Exchange" icon="⇄" onClick={() => setActiveModal('exchange')} />
                            <ActionButton label="Send" icon="→" onClick={() => setActiveModal('send')} />
                            <ActionButton label="More" icon="•••" onClick={() => setActiveModal('more')} />
                        </>
                    )}
                </div>

                {/* CONTENT GRID */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

                    {/* LEFT: ASSET BREAKDOWN CARDS */}
                    <div className="lg:col-span-2 space-y-6">

                        {/* CRYPTO MARKET - ONLY SHOW ON CRYPTO TAB */}
                        {activeTab === 'crypto' && (
                            <div className="bg-[#161920] rounded-2xl border border-gray-800/50 p-6">
                                <h3 className="text-lg font-semibold text-gray-200 mb-4">Market</h3>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 h-64 overflow-y-auto pr-2 custom-scrollbar">
                                    {COINS.map(c => (
                                        <div key={c.s} className="bg-gray-800/30 p-3 rounded-xl border border-gray-800 hover:bg-gray-800 transition-colors cursor-pointer group">
                                            <div className="flex justify-between items-start mb-2">
                                                <span className="font-bold text-gray-300">{c.s}</span>
                                                <span className={`text-xs font-medium ${c.c >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                    {c.c > 0 ? '+' : ''}{c.c}%
                                                </span>
                                            </div>
                                            <div className="text-sm font-mono text-gray-400 group-hover:text-white">${c.p.toLocaleString()}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* RECENT ACTIVITY (Show on all tabs, logic filters it) */}
                        <div className="bg-[#161920] rounded-2xl border border-gray-800/50 overflow-hidden shadow-xl">
                            <div className="p-4 border-b border-gray-800 flex justify-between items-center">
                                <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Recent Transactions</h3>
                            </div>
                            {filteredData.length === 0 ? (
                                <div className="p-8 text-center text-gray-500 text-sm">No recent activity.</div>
                            ) : (
                                <div>
                                    {filteredData.slice(0, 10).map((inst, i) => (
                                        <TransactionRow key={inst.instruction_id} inst={inst} index={i} />
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* RIGHT: WIDGETS */}
                    <div className="space-y-6">
                        <WidgetCard title="My Cards (Virtual)">
                            <div className="bg-gradient-to-br from-purple-600 to-blue-600 p-5 rounded-xl text-white shadow-lg transform transition hover:scale-105 cursor-pointer">
                                <div className="flex justify-between items-start mb-8">
                                    <div className="opacity-80 text-xs font-mono">FUSION BLACK</div>
                                    <div className="text-xl font-bold italic">VISA</div>
                                </div>
                                <div className="font-mono text-lg tracking-widest mb-2">•••• 4242</div>
                                <div className="flex justify-between text-xs opacity-75">
                                    <span>Praveen K.</span>
                                    <span>12/28</span>
                                </div>
                            </div>
                        </WidgetCard>

                        <WidgetCard title="Suggested Actions">
                            <div className="space-y-3">
                                <ActionItem title="Verify Identity" desc="Required for >$10k limits" alert />
                                <ActionItem title="Connect Wallet" desc="Link MetaMask / Phantom" />
                            </div>
                        </WidgetCard>
                    </div>
                </div>
            </main>

            {/* --- MODALS --- */}
            {activeModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setActiveModal(null)} />

                    <div className="relative bg-[#1A1D24] w-full max-w-md rounded-2xl border border-gray-700 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                        {/* MODAL HEADER */}
                        <div className="p-6 border-b border-gray-700 flex justify-between items-center">
                            <h3 className="text-xl font-bold text-white">
                                {activeModal === 'add' && 'Add Money'}
                                {activeModal === 'exchange' && 'Exchange (SWIFT/FX)'}
                                {activeModal === 'send' && 'Send Funds'}
                                {activeModal === 'more' && 'More Options'}
                                {activeModal === 'buy_crypto' && 'Buy Crypto'}
                                {activeModal === 'sell_crypto' && 'Sell Crypto'}
                                {activeModal === 'send_crypto' && 'Transfer Crypto'}
                            </h3>
                            <button onClick={() => setActiveModal(null)} className="text-gray-400 hover:text-white">✕</button>
                        </div>

                        {/* MODAL BODY */}
                        <div className="p-6 space-y-4">
                            {activeModal === 'more' ? (
                                <div className="grid grid-cols-2 gap-3">
                                    <MoreOption icon="📄" label="Statements" />
                                    <MoreOption icon="📊" label="Analytics" />
                                    <MoreOption icon="⚙️" label="Settings" />
                                    <MoreOption icon="🔒" label="Security" />
                                    <MoreOption icon="💳" label="Cards" />
                                    <MoreOption icon="❓" label="Help" />
                                </div>
                            ) : (
                                <>
                                    {/* AMOUNT INPUT (Common) */}
                                    <div className="space-y-2">
                                        <label className="text-xs text-gray-400 uppercase tracking-wide">Amount</label>
                                        <div className="relative">
                                            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">
                                                {['buy_crypto', 'add', 'exchange', 'send'].includes(activeModal) ? '$' : ''}
                                            </span>
                                            <input
                                                type="number"
                                                value={actionAmount}
                                                onChange={(e) => setActionAmount(e.target.value)}
                                                placeholder="0.00"
                                                className="w-full bg-[#0F1115] border border-gray-700 rounded-xl px-4 pl-8 py-3 text-2xl font-mono text-white focus:outline-none focus:border-blue-500 transition-colors"
                                                autoFocus
                                            />
                                        </div>
                                    </div>

                                    {/* EXCHANGE UI */}
                                    {activeModal === 'exchange' && (
                                        <div className="bg-[#0F1115] p-4 rounded-xl border border-gray-800 space-y-3">
                                            {/* FROM */}
                                            <div className="flex justify-between items-center">
                                                <div className="flex items-center gap-2">
                                                    <select
                                                        className="bg-transparent text-white font-bold outline-none cursor-pointer"
                                                        value={fromCurrency.code}
                                                        onChange={(e) => setFromCurrency(CURRENCIES.find(c => c.code === e.target.value) || CURRENCIES[0])}
                                                    >
                                                        {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                                                    </select>
                                                </div>
                                                <span className="text-gray-500 text-sm">Balance: ${(12450 / fromCurrency.rate).toFixed(2)}</span>
                                            </div>

                                            <div className="flex justify-center text-gray-500 py-1">↓</div>

                                            {/* TO */}
                                            <div className="flex justify-between items-center">
                                                <div className="flex items-center gap-2">
                                                    <select
                                                        className="bg-transparent text-white font-bold outline-none cursor-pointer"
                                                        value={toCurrency.code}
                                                        onChange={(e) => setToCurrency(CURRENCIES.find(c => c.code === e.target.value) || CURRENCIES[1])}
                                                    >
                                                        {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                                                    </select>
                                                </div>
                                                <span className="text-gray-500 text-sm">
                                                    1 {fromCurrency.code} = {(toCurrency.rate / fromCurrency.rate).toFixed(4)} {toCurrency.code}
                                                </span>
                                            </div>
                                        </div>
                                    )}

                                    {/* CRYPTO BUY/SELL UI */}
                                    {(activeModal === 'buy_crypto' || activeModal === 'sell_crypto') && (
                                        <div className="bg-[#0F1115] p-4 rounded-xl border border-gray-800 flex justify-between items-center">
                                            <span className="text-gray-400">Asset</span>
                                            <select className="bg-gray-800 text-white p-2 rounded border border-gray-700">
                                                <option>Bitcoin (BTC)</option>
                                                <option>Ethereum (ETH)</option>
                                                <option>Stellar (XLM)</option>
                                            </select>
                                        </div>
                                    )}

                                    {/* SEND / CRYPTO TRANSFER UI */}
                                    {(activeModal === 'send' || activeModal === 'send_crypto') && (
                                        <div className="space-y-3">
                                            <label className="text-xs text-gray-400 uppercase tracking-wide">Recipient Type</label>
                                            <div className="grid grid-cols-2 gap-2 mb-2">
                                                <button className="px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 text-xs">Fusion User</button>
                                                <button className="px-3 py-2 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 text-xs text-blue-400">External/Cold</button>
                                            </div>
                                            <input
                                                type="text"
                                                placeholder={activeModal === 'send_crypto' ? "Wallet Address (0x...)" : "@username or email"}
                                                className="w-full bg-[#0F1115] border border-gray-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                                            />
                                        </div>
                                    )}
                                </>
                            )}
                        </div>

                        {/* MODAL FOOTER */}
                        {activeModal !== 'more' && (
                            <div className="p-6 border-t border-gray-700 bg-gray-800/30">
                                <button
                                    onClick={handleSimulateAction}
                                    disabled={isProcessing || !actionAmount}
                                    className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2"
                                >
                                    {isProcessing ? (
                                        <>
                                            <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></span>
                                            Processing...
                                        </>
                                    ) : (
                                        <>
                                            {activeModal === 'add' && 'Add Funds'}
                                            {activeModal === 'exchange' && 'Sign & Exchange'}
                                            {activeModal === 'send' && 'Send Now'}
                                            {activeModal === 'buy_crypto' && 'Place Buy Order'}
                                            {activeModal === 'sell_crypto' && 'Place Sell Order'}
                                            {activeModal === 'send_crypto' && 'Withdraw to Wallet'}
                                        </>
                                    )}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

// --- SUBCOMPONENTS ---

function MoreOption({ icon, label }: { icon: string, label: string }) {
    return (
        <button className="flex flex-col items-center justify-center gap-2 p-4 bg-[#0F1115] hover:bg-gray-800 border border-gray-800 rounded-xl transition-colors">
            <span className="text-2xl">{icon}</span>
            <span className="text-sm font-medium text-gray-300">{label}</span>
        </button>
    );
}

function TabButton({ label, active, onClick }: { label: string, active: boolean, onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200 ${active
                ? 'bg-gray-800 text-white shadow-sm ring-1 ring-white/10'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                }`}
        >
            {label}
        </button>
    );
}

function ActionButton({ label, icon, primary, onClick }: { label: string, icon: string, primary?: boolean, onClick?: () => void }) {
    return (
        <div className="flex flex-col items-center gap-2 group cursor-pointer" onClick={onClick}>
            <div className={`w-12 h-12 rounded-full flex items-center justify-center text-xl transition-all duration-200 ${primary
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/50 group-hover:bg-blue-500'
                : 'bg-gray-800 text-blue-400 group-hover:bg-gray-700'
                }`}>
                {icon}
            </div>
            <span className="text-xs font-medium text-gray-400 group-hover:text-gray-200">{label}</span>
        </div>
    );
}

function TransactionRow({ inst, index }: { inst: Instruction, index: number }) {
    const isCrypto = ['XLM', 'BTC', 'ETH'].includes(inst.currency);
    const isWealth = inst.purpose === 'INVESTMENT';

    // Icon Logic
    let icon = '💸'; // Default Fiat
    let bg = 'bg-blue-900/20 text-blue-400 border-blue-900/30';
    if (isCrypto) { icon = '₿'; bg = 'bg-purple-900/20 text-purple-400 border-purple-900/30'; }
    if (isWealth) { icon = '📈'; bg = 'bg-green-900/20 text-green-400 border-green-900/30 text-xs'; }

    return (
        <div className={`p-4 flex items-center justify-between hover:bg-white/5 transition-colors border-b border-gray-800/50 last:border-0`}>
            <div className="flex items-center gap-4">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center border ${bg}`}>
                    {icon}
                </div>
                <div>
                    <div className="text-sm font-medium text-gray-200">
                        {inst.recipient_hash ? `Transfer to ...${inst.recipient_hash.slice(0, 4)}` : 'Top Up'}
                    </div>
                    <div className="text-xs text-gray-500 flex items-center gap-2">
                        {new Date(inst.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} •
                        <StatusDot state={inst.state} /> {inst.state}
                    </div>
                </div>
            </div>
            <div className="text-right">
                <div className={`text-sm font-bold font-mono ${inst.state === 'FAILED' ? 'text-gray-500 line-through' : 'text-white'}`}>
                    -{inst.amount} <span className="text-xs text-gray-500">{inst.currency}</span>
                </div>
                <div className="text-[10px] text-gray-500 uppercase tracking-wide">{inst.purpose}</div>
            </div>
        </div>
    );
}

function StatusDot({ state }: { state: string }) {
    const colors = {
        INITIATED: 'text-blue-500',
        LOCKED: 'text-yellow-500',
        PENDING_EXECUTION: 'text-purple-500',
        SETTLED: 'text-green-500',
        FAILED: 'text-red-500',
    };
    const color = colors[state as keyof typeof colors] || 'text-gray-500';
    return <span className={`text-[8px] ${color}`}>●</span>;
}

function WidgetCard({ title, children }: { title: string, children: React.ReactNode }) {
    return (
        <div className="bg-[#161920] p-6 rounded-2xl border border-gray-800/50">
            <h3 className="text-sm font-medium text-gray-400 mb-4 uppercase tracking-wider">{title}</h3>
            {children}
        </div>
    );
}

function ActionItem({ title, desc, alert }: { title: string, desc: string, alert?: boolean }) {
    return (
        <div className="flex items-center justify-between p-3 rounded-lg hover:bg-white/5 cursor-pointer transition-colors group">
            <div className="flex items-center gap-3">
                {alert && <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />}
                <div>
                    <div className="text-sm font-medium text-gray-200">{title}</div>
                    <div className="text-xs text-gray-500 group-hover:text-gray-400">{desc}</div>
                </div>
            </div>
            <span className="text-gray-600">→</span>
        </div>
    );
}

// --- HELPER ---
function calculateAssets(data: Instruction[]) {
    // A simple mock calculation for the banner
    let fiat = 0;
    let crypto = 0;
    let wealth = 0;

    data.forEach(d => {
        const val = parseFloat(d.amount);
        if (d.state === 'SETTLED') {
            if (['USD', 'EUR', 'SGD'].includes(d.currency)) fiat += val;
            if (['XLM', 'BTC'].includes(d.currency)) crypto += val;
            if (d.purpose === 'INVESTMENT') wealth += val;
        }
    });

    // Seed with some initial values if empty for demo
    if (fiat === 0) fiat = 12450.00;
    if (crypto === 0) crypto = 50000;
    if (wealth === 0) wealth = 8500.50;

    return { fiat, crypto, wealth };
}
