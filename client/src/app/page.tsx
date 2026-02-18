'use client';

import { useState, useEffect } from 'react';

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

    // Poll API
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
    const assets = calculateAssets(instructions);

    return (
        <div className="min-h-screen bg-[#0F1115] text-white font-sans selection:bg-blue-500/30">
            {/* TOP NAVIGATION (REVOLUT STYLE) */}
            <nav className="border-b border-gray-800 bg-[#0F1115] sticky top-0 z-50">
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

            <main className="max-w-6xl mx-auto px-6 py-8">
                {/* DYNAMIC HEADER BASED ON TAB */}
                <div className="mb-10">
                    <h2 className="text-gray-400 text-sm font-medium uppercase tracking-wider mb-2">
                        {activeTab === 'home' ? 'Total Liquidity' : `${activeTab} Balance`}
                    </h2>
                    <div className="flex items-baseline gap-4">
                        <span className="text-5xl font-bold tracking-tight text-white">
                            {activeTab === 'home' ? `$${totalVolume.toLocaleString()}` :
                                activeTab === 'crypto' ? `${assets.crypto.toLocaleString()} XLM` :
                                    activeTab === 'wealth' ? `$${assets.wealth.toLocaleString()}` :
                                        `$${assets.fiat.toLocaleString()}`}
                        </span>
                        <span className="text-green-500 text-sm font-medium bg-green-900/20 px-2 py-0.5 rounded-full border border-green-900/30">
                            +2.4% today
                        </span>
                    </div>
                </div>

                {/* ACTION BUTTONS */}
                <div className="flex gap-4 mb-10">
                    <ActionButton label="Add Money" icon="+" primary />
                    <ActionButton label="Exchange" icon="⇄" />
                    <ActionButton label="Send" icon="→" />
                    <ActionButton label="More" icon="•••" />
                </div>

                {/* CONTENT GRID */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

                    {/* LEFT: ASSET BREAKDOWN CARDS */}
                    <div className="lg:col-span-2 space-y-6">
                        <div className="flex items-center justify-between mb-2">
                            <h3 className="text-lg font-semibold text-gray-200">Recent Activity</h3>
                            <button className="text-sm text-blue-400 hover:text-blue-300">See All</button>
                        </div>

                        {filteredData.length === 0 ? (
                            <div className="p-12 text-center border border-dashed border-gray-800 rounded-2xl text-gray-500">
                                No transactions found in this category.
                            </div>
                        ) : (
                            <div className="bg-[#161920] rounded-2xl border border-gray-800/50 overflow-hidden shadow-xl">
                                {filteredData.slice(0, 10).map((inst, i) => (
                                    <TransactionRow key={inst.instruction_id} inst={inst} index={i} />
                                ))}
                            </div>
                        )}
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
        </div>
    );
}

// --- SUBCOMPONENTS ---

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

function ActionButton({ label, icon, primary }: { label: string, icon: string, primary?: boolean }) {
    return (
        <div className="flex flex-col items-center gap-2 group cursor-pointer">
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
