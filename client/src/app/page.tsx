'use client';

import { useState, useEffect } from 'react';

const CURRENCIES = [
    { code: 'USD', flag: '🇺🇸', rate: 1.0 },
    { code: 'EUR', flag: '🇪🇺', rate: 0.92 },
    { code: 'GBP', flag: '🇬🇧', rate: 0.79 },
    { code: 'SGD', flag: '🇸🇬', rate: 1.35 },
    { code: 'JPY', flag: '🇯🇵', rate: 151.2 },
    { code: 'CHF', flag: '🇨🇭', rate: 0.9 },
    { code: 'AUD', flag: '🇦🇺', rate: 1.52 },
    { code: 'CAD', flag: '🇨🇦', rate: 1.36 },
    { code: 'INR', flag: '🇮🇳', rate: 83.2 },
];

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
    ledger_hashes?: string[];
}

export default function Dashboard() {
    const [instructions, setInstructions] = useState<Instruction[]>([]);
    const [activeTab, setActiveTab] = useState<'overview' | 'instructions' | 'rails' | 'ledger'>(
        'overview'
    );
    const [lastUpdated, setLastUpdated] = useState<string>('Loading...');
    const [totalVolume, setTotalVolume] = useState<number>(0);
    const [currentPage, setCurrentPage] = useState(1);
    const ITEMS_PER_PAGE = 8;
    const [fromCurrency, setFromCurrency] = useState(CURRENCIES[0]);
    const [toCurrency, setToCurrency] = useState(CURRENCIES[1]);
    const [walletAddress, setWalletAddress] = useState<string | null>(null);
    const [activeModal, setActiveModal] = useState<
        null | 'initiate' | 'exchange' | 'send' | 'crypto'
    >(null);
    const [actionAmount, setActionAmount] = useState('');
    const [actionRecipient, setActionRecipient] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);
    const [serverHealth, setServerHealth] = useState<'online' | 'offline' | 'checking'>('checking');

    const connectMetaMask = async () => {
        if (typeof window !== 'undefined' && 'ethereum' in window) {
            try {
                // @ts-ignore
                let provider: any = window.ethereum;
                // @ts-ignore
                if (window.ethereum.providers) {
                    // @ts-ignore
                    provider =
                        window.ethereum.providers.find((p: any) => p.isMetaMask) || window.ethereum;
                }
                const accounts = (await provider.request({
                    method: 'eth_requestAccounts',
                })) as string[];
                setWalletAddress(accounts[0]);
            } catch (error) {
                console.error(error);
            }
        }
    };

    useEffect(() => {
        fetch('/api/kyc/onboard', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: 'Alice_Corp',
                document_type: 'PASSPORT',
                document_number: 'DEMO123',
            }),
        }).catch(() => {});

        const fetchData = async () => {
            try {
                const [obsRes, healthRes] = await Promise.all([
                    fetch(`/api/observe?limit=100`),
                    fetch(`/health`),
                ]);
                if (obsRes.ok) {
                    const data = await obsRes.json();
                    const sorted = (data.data || []).sort(
                        (a: Instruction, b: Instruction) =>
                            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
                    );
                    setInstructions(sorted);
                    if (data.meta?.total_volume) setTotalVolume(data.meta.total_volume);
                    setLastUpdated(new Date().toLocaleTimeString());
                }
                setServerHealth(healthRes.ok ? 'online' : 'offline');
            } catch {
                setServerHealth('offline');
            }
        };

        fetchData();
        const interval = setInterval(fetchData, 2000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        setCurrentPage(1);
    }, [activeTab]);

    // ── METRICS ──────────────────────────────────────────────────────────────
    const settled = instructions.filter((i) => i.state === 'SETTLED');
    const failed = instructions.filter((i) => i.state === 'FAILED');
    const pending = instructions.filter((i) =>
        ['INITIATED', 'LOCKED', 'PENDING_EXECUTION'].includes(i.state)
    );
    const successRate =
        instructions.length > 0
            ? ((settled.length / instructions.length) * 100).toFixed(1)
            : '100.0';

    const railCounts: Record<string, number> = {};
    settled.forEach((i) => {
        const rail = ['XLM', 'BTC', 'ETH', 'USDC'].includes(i.currency)
            ? 'Crypto (Web3)'
            : i.currency === 'INR'
              ? 'RazorpayX (INR)'
              : i.currency === 'SGD'
                ? 'PayNow (SGD)'
                : parseFloat(i.amount) >= 10000
                  ? 'SWIFT/ISO20022'
                  : 'Stripe (Fiat)';
        railCounts[rail] = (railCounts[rail] || 0) + 1;
    });

    // ── TRANSACTION LIST ──────────────────────────────────────────────────────
    const getFiltered = () => {
        switch (activeTab) {
            case 'instructions':
                return instructions.filter((i) =>
                    ['USD', 'EUR', 'SGD', 'GBP', 'INR'].includes(i.currency)
                );
            case 'rails':
                return instructions.filter((i) =>
                    ['XLM', 'USDC', 'BTC', 'ETH'].includes(i.currency)
                );
            case 'ledger':
                return instructions.filter((i) => i.ledger_hashes && i.ledger_hashes.length > 0);
            default:
                return instructions;
        }
    };

    const filteredData = getFiltered();
    const totalPages = Math.ceil(filteredData.length / ITEMS_PER_PAGE);
    const currentData = filteredData.slice(
        (currentPage - 1) * ITEMS_PER_PAGE,
        currentPage * ITEMS_PER_PAGE
    );

    // ── TRANSACTION HANDLER ────────────────────────────────────────────────────
    const handleSimulateAction = async () => {
        setIsProcessing(true);
        try {
            const user_id = 'Alice_Corp';
            const otpReq = await fetch('/api/auth/otp/generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': 'fusion_bank_secret_key_2025',
                    'x-idempotency-key': Date.now().toString(),
                },
                body: JSON.stringify({ user_id }),
            });
            const otpData = await otpReq.json();
            const vReq = await fetch('/api/auth/otp/verify', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': 'fusion_bank_secret_key_2025',
                    'x-idempotency-key': Date.now().toString(),
                },
                body: JSON.stringify({ user_id, otp_code: otpData.otp_code }),
            });
            const vData = await vReq.json();
            if (vData.error) throw new Error(vData.error);
            if (vData.auth_token) {
                const currency =
                    activeModal === 'exchange'
                        ? fromCurrency.code
                        : activeModal === 'crypto'
                          ? 'XLM'
                          : 'USD';
                const finalRecipient = actionRecipient.trim() || 'Bob_Supply';
                await fetch('/api/kyc/onboard', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        user_id: finalRecipient,
                        document_type: 'PASSPORT',
                        document_number: 'JIT123',
                    }),
                }).catch(() => {});
                const initReq = await fetch('/api/instruction/initiate', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': 'fusion_bank_secret_key_2025',
                        'x-idempotency-key': Date.now().toString(),
                    },
                    body: JSON.stringify({
                        amount: parseFloat(actionAmount),
                        currency,
                        sender: user_id,
                        recipient: finalRecipient,
                        purpose: activeModal === 'exchange' ? 'FX_SWAP' : 'CROSS_BORDER',
                        auth_token: vData.auth_token,
                    }),
                });
                const initData = await initReq.json();
                if (initData.error) throw new Error(initData.error);
                if (initData.instructionId) {
                    await fetch('/api/policy/evaluate', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': 'fusion_bank_secret_key_2025',
                            'x-idempotency-key': Date.now().toString() + 'e',
                        },
                        body: JSON.stringify({ instructionId: initData.instructionId }),
                    });
                    const routeReq = await fetch('/api/orchestration/route', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': 'fusion_bank_secret_key_2025',
                            'x-idempotency-key': Date.now().toString() + 'r',
                        },
                        body: JSON.stringify({ instructionId: initData.instructionId }),
                    });
                    const routeData = await routeReq.json();
                    if (routeData.error) throw new Error('Route failed: ' + routeData.error);
                    const execReq = await fetch('/api/adapter/execute', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': 'fusion_bank_secret_key_2025',
                            'x-idempotency-key': Date.now().toString() + 'x',
                        },
                        body: JSON.stringify({
                            instructionId: initData.instructionId,
                            adapter: routeData.selectedAdapter,
                        }),
                    });
                    const execData = await execReq.json();
                    if (execData.error) throw new Error('Execute failed: ' + execData.error);
                }
            }
        } catch (err: any) {
            alert('Instruction Failed: ' + err.message);
        }
        setIsProcessing(false);
        setActiveModal(null);
        setActionAmount('');
        setActionRecipient('');
    };

    return (
        <div className="min-h-screen bg-[#0B0E14] text-white font-sans">
            {/* ── SIDEBAR NAV ───────────────────────────────────────────────────── */}
            <aside className="fixed top-0 left-0 h-full w-56 bg-[#0F1318] border-r border-gray-800/60 flex flex-col z-30 py-6 px-4">
                <div className="mb-8 px-2">
                    <div className="text-lg font-bold tracking-tight text-white">
                        Project<span className="text-blue-500">Fusion</span>
                    </div>
                    <div className="text-[10px] text-gray-500 mt-0.5 font-mono uppercase tracking-widest">
                        Orchestration Console
                    </div>
                </div>

                <nav className="flex flex-col gap-1">
                    <SideNavItem
                        label="Overview"
                        icon="◈"
                        active={activeTab === 'overview'}
                        onClick={() => setActiveTab('overview')}
                    />
                    <SideNavItem
                        label="Instructions"
                        icon="⇄"
                        active={activeTab === 'instructions'}
                        onClick={() => setActiveTab('instructions')}
                    />
                    <SideNavItem
                        label="Crypto Rails"
                        icon="◎"
                        active={activeTab === 'rails'}
                        onClick={() => setActiveTab('rails')}
                    />
                    <SideNavItem
                        label="Ledger Audit"
                        icon="⬡"
                        active={activeTab === 'ledger'}
                        onClick={() => setActiveTab('ledger')}
                    />
                </nav>

                <div className="mt-auto space-y-3">
                    {/* Adapter Health */}
                    <div className="bg-[#161B22] rounded-lg border border-gray-800 p-3">
                        <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2">
                            Adapter Health
                        </div>
                        <AdapterStatus label="Stripe" status="online" />
                        <AdapterStatus label="RazorpayX" status="online" />
                        <AdapterStatus label="SWIFT/ISO20022" status="online" />
                        <AdapterStatus label="Web3 Rail" status="online" />
                    </div>
                    <div
                        className={`text-[10px] font-mono px-2 flex items-center gap-1.5 ${serverHealth === 'online' ? 'text-green-500' : 'text-red-500'}`}
                    >
                        <span
                            className={`inline-block w-1.5 h-1.5 rounded-full ${serverHealth === 'online' ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}
                        />
                        ENGINE {serverHealth.toUpperCase()} · {lastUpdated}
                    </div>
                </div>
            </aside>

            {/* ── MAIN CONTENT ──────────────────────────────────────────────────── */}
            <div className="ml-56">
                {/* TOP BAR */}
                <header className="h-14 border-b border-gray-800/60 bg-[#0B0E14] flex items-center justify-between px-6 sticky top-0 z-20">
                    <div>
                        <h1 className="text-sm font-semibold text-gray-200">
                            {activeTab === 'overview' && 'Operations Overview'}
                            {activeTab === 'instructions' && 'Fiat Instruction Log'}
                            {activeTab === 'rails' && 'Crypto Rail Log'}
                            {activeTab === 'ledger' && 'Ledger Audit Trail'}
                        </h1>
                        <p className="text-xs text-gray-600 font-mono">
                            api.projectfusion.io · v1.0.0
                        </p>
                    </div>
                    <div className="flex items-center gap-3">
                        {walletAddress ? (
                            <span className="text-[10px] font-mono text-green-400 bg-green-900/20 border border-green-900/40 px-2 py-1 rounded">
                                Web3: {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
                            </span>
                        ) : (
                            <button
                                onClick={connectMetaMask}
                                className="text-xs text-gray-400 border border-gray-700 px-3 py-1.5 rounded hover:border-blue-600 hover:text-blue-400 transition-colors"
                            >
                                Connect Web3 Wallet
                            </button>
                        )}
                        <button
                            onClick={() => setActiveModal('initiate')}
                            className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors flex items-center gap-2"
                        >
                            + New Instruction
                        </button>
                    </div>
                </header>

                <main
                    className={`p-6 ${activeModal ? 'opacity-30 blur-sm pointer-events-none' : ''}`}
                >
                    {activeTab === 'overview' && (
                        <>
                            {/* ── KPI METRICS ROW ──────────────────────────────────────── */}
                            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                                <KpiCard
                                    label="Total Volume Processed"
                                    value={`$${totalVolume.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
                                    sub="All rails combined"
                                    accent="blue"
                                />
                                <KpiCard
                                    label="Settled Instructions"
                                    value={settled.length.toString()}
                                    sub={`${successRate}% success rate`}
                                    accent="green"
                                />
                                <KpiCard
                                    label="Pending / In-flight"
                                    value={pending.length.toString()}
                                    sub="Across SAGA stages"
                                    accent="yellow"
                                />
                                <KpiCard
                                    label="Failed Instructions"
                                    value={failed.length.toString()}
                                    sub="SAGA rollback triggered"
                                    accent="red"
                                />
                            </div>

                            {/* ── 2-COL GRID ───────────────────────────────────────────── */}
                            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                                {/* TRANSACTION TABLE */}
                                <div className="lg:col-span-2">
                                    <SectionHeader
                                        title="Recent Instructions"
                                        subtitle={`${instructions.length} total dispatched`}
                                    />
                                    <InstructionTable
                                        data={currentData}
                                        currentPage={currentPage}
                                        totalPages={totalPages}
                                        onPrev={() => setCurrentPage((p) => Math.max(p - 1, 1))}
                                        onNext={() =>
                                            setCurrentPage((p) => Math.min(p + 1, totalPages))
                                        }
                                    />
                                </div>

                                {/* RIGHT WIDGETS */}
                                <div className="space-y-4">
                                    {/* SMART ROUTER BREAKDOWN */}
                                    <div className="bg-[#0F1318] rounded-xl border border-gray-800/60 p-5">
                                        <SectionHeader
                                            title="Smart Router Decisions"
                                            subtitle="By rail (settled only)"
                                        />
                                        <div className="space-y-2 mt-2">
                                            {Object.keys(railCounts).length === 0 ? (
                                                <p className="text-xs text-gray-600">
                                                    No settled instructions yet.
                                                </p>
                                            ) : (
                                                Object.entries(railCounts)
                                                    .sort((a, b) => b[1] - a[1])
                                                    .map(([rail, count]) => (
                                                        <RailBar
                                                            key={rail}
                                                            label={rail}
                                                            count={count}
                                                            total={settled.length}
                                                        />
                                                    ))
                                            )}
                                        </div>
                                    </div>

                                    {/* API KEYS */}
                                    <div className="bg-[#0F1318] rounded-xl border border-gray-800/60 p-5">
                                        <SectionHeader
                                            title="API Credentials"
                                            subtitle="Sandbox environment"
                                        />
                                        <div className="mt-3 space-y-2">
                                            <ApiKeyRow
                                                label="Key ID"
                                                value="fusion_bank_***_2025"
                                            />
                                            <ApiKeyRow
                                                label="Environment"
                                                value="TESTNET / SANDBOX"
                                            />
                                            <ApiKeyRow label="Rate Limit" value="60,000 req/min" />
                                            <ApiKeyRow
                                                label="SAGA Mode"
                                                value="ENABLED"
                                                highlight
                                            />
                                        </div>
                                    </div>

                                    {/* QUICK ACTIONS */}
                                    <div className="bg-[#0F1318] rounded-xl border border-gray-800/60 p-5">
                                        <SectionHeader title="Quick Actions" subtitle="" />
                                        <div className="mt-3 grid grid-cols-2 gap-2">
                                            <QuickAction
                                                label="Fiat Instruction"
                                                onClick={() => setActiveModal('initiate')}
                                            />
                                            <QuickAction
                                                label="FX Exchange"
                                                onClick={() => setActiveModal('exchange')}
                                            />
                                            <QuickAction
                                                label="Crypto Send"
                                                onClick={() => setActiveModal('crypto')}
                                            />
                                            <QuickAction
                                                label="Wire Transfer"
                                                onClick={() => setActiveModal('send')}
                                            />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </>
                    )}

                    {(activeTab === 'instructions' ||
                        activeTab === 'rails' ||
                        activeTab === 'ledger') && (
                        <div>
                            <div className="mb-4 flex items-center justify-between">
                                <SectionHeader
                                    title={
                                        activeTab === 'instructions'
                                            ? 'Fiat Instructions'
                                            : activeTab === 'rails'
                                              ? 'Crypto Rail Instructions'
                                              : 'Ledger-Verified Instructions'
                                    }
                                    subtitle={`${filteredData.length} records`}
                                />
                            </div>
                            <InstructionTable
                                data={currentData}
                                currentPage={currentPage}
                                totalPages={totalPages}
                                onPrev={() => setCurrentPage((p) => Math.max(p - 1, 1))}
                                onNext={() => setCurrentPage((p) => Math.min(p + 1, totalPages))}
                            />
                        </div>
                    )}
                </main>
            </div>

            {/* ── MODAL ─────────────────────────────────────────────────────────── */}
            {activeModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div
                        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
                        onClick={() => setActiveModal(null)}
                    />
                    <div className="relative bg-[#0F1318] w-full max-w-md rounded-2xl border border-gray-700 shadow-2xl overflow-hidden">
                        <div className="p-5 border-b border-gray-800 flex justify-between items-center">
                            <div>
                                <h3 className="text-base font-bold text-white">
                                    {activeModal === 'initiate' && 'Initiate Payment Instruction'}
                                    {activeModal === 'exchange' &&
                                        'FX Exchange Instruction (SWIFT)'}
                                    {activeModal === 'send' && 'Wire Transfer Instruction'}
                                    {activeModal === 'crypto' && 'Crypto Rail Instruction (Web3)'}
                                </h3>
                                <p className="text-xs text-gray-500 mt-0.5">
                                    Instruction will be KYC/AFA verified, SAGA-locked, and routed
                                    automatically.
                                </p>
                            </div>
                            <button
                                onClick={() => setActiveModal(null)}
                                className="text-gray-500 hover:text-white ml-4"
                            >
                                ✕
                            </button>
                        </div>
                        <div className="p-5 space-y-4">
                            <div className="space-y-1">
                                <label className="text-xs text-gray-500 uppercase tracking-widest">
                                    Amount
                                </label>
                                <input
                                    type="number"
                                    value={actionAmount}
                                    onChange={(e) => setActionAmount(e.target.value)}
                                    placeholder="0.00"
                                    className="w-full bg-[#161B22] border border-gray-700 rounded-lg px-4 py-3 text-xl font-mono text-white focus:outline-none focus:border-blue-500 transition-colors"
                                    autoFocus
                                />
                            </div>
                            {activeModal === 'exchange' && (
                                <div className="bg-[#161B22] p-4 rounded-xl border border-gray-800 space-y-2">
                                    <div className="flex justify-between items-center">
                                        <select
                                            className="bg-transparent text-white font-bold outline-none cursor-pointer text-sm"
                                            value={fromCurrency.code}
                                            onChange={(e) =>
                                                setFromCurrency(
                                                    CURRENCIES.find(
                                                        (c) => c.code === e.target.value
                                                    ) || CURRENCIES[0]
                                                )
                                            }
                                        >
                                            {CURRENCIES.map((c) => (
                                                <option key={c.code} value={c.code}>
                                                    {c.flag} {c.code}
                                                </option>
                                            ))}
                                        </select>
                                        <span className="text-gray-600 text-xs">
                                            SOURCE CURRENCY
                                        </span>
                                    </div>
                                    <div className="text-gray-700 py-1 text-center text-sm">
                                        ↓ SMART ROUTER WILL ROUTE
                                    </div>
                                    <div className="flex justify-between items-center">
                                        <select
                                            className="bg-transparent text-white font-bold outline-none cursor-pointer text-sm"
                                            value={toCurrency.code}
                                            onChange={(e) =>
                                                setToCurrency(
                                                    CURRENCIES.find(
                                                        (c) => c.code === e.target.value
                                                    ) || CURRENCIES[1]
                                                )
                                            }
                                        >
                                            {CURRENCIES.map((c) => (
                                                <option key={c.code} value={c.code}>
                                                    {c.flag} {c.code}
                                                </option>
                                            ))}
                                        </select>
                                        <span className="text-gray-600 text-xs">
                                            DESTINATION CURRENCY
                                        </span>
                                    </div>
                                </div>
                            )}
                            <div className="space-y-1">
                                <label className="text-xs text-gray-500 uppercase tracking-widest">
                                    Recipient Entity ID
                                </label>
                                <input
                                    type="text"
                                    value={actionRecipient}
                                    onChange={(e) => setActionRecipient(e.target.value)}
                                    placeholder="e.g. Vendor_Corp_001"
                                    className="w-full bg-[#161B22] border border-gray-700 rounded-lg px-4 py-2.5 text-sm font-mono text-white focus:outline-none focus:border-blue-500 transition-colors"
                                />
                            </div>
                            <div className="bg-blue-900/10 border border-blue-900/30 rounded-lg p-3 text-xs text-blue-400 font-mono">
                                SAGA engine will auto-select rail via Smart Router → execute via
                                licensed adapter → write to hash-chained ledger
                            </div>
                            <button
                                onClick={handleSimulateAction}
                                disabled={isProcessing || !actionAmount}
                                className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2 text-sm"
                            >
                                {isProcessing ? (
                                    <>
                                        <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                                        Processing via SAGA...
                                    </>
                                ) : (
                                    'Dispatch Instruction'
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// ── SUB COMPONENTS ────────────────────────────────────────────────────────────

function SideNavItem({
    label,
    icon,
    active,
    onClick,
}: {
    label: string;
    icon: string;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all text-left ${
                active
                    ? 'bg-blue-600/15 text-blue-400 border border-blue-600/30'
                    : 'text-gray-500 hover:text-gray-200 hover:bg-white/5'
            }`}
        >
            <span className="text-base w-4">{icon}</span>
            {label}
        </button>
    );
}

function AdapterStatus({
    label,
    status,
}: {
    label: string;
    status: 'online' | 'offline' | 'degraded';
}) {
    const colors = {
        online: 'text-green-500',
        offline: 'text-red-500',
        degraded: 'text-yellow-500',
    };
    const dots = { online: '●', offline: '○', degraded: '◐' };
    return (
        <div className="flex items-center justify-between py-0.5">
            <span className="text-[10px] text-gray-400 font-mono">{label}</span>
            <span className={`text-[10px] font-mono ${colors[status]}`}>
                {dots[status]} {status.toUpperCase()}
            </span>
        </div>
    );
}

function KpiCard({
    label,
    value,
    sub,
    accent,
}: {
    label: string;
    value: string;
    sub: string;
    accent: 'blue' | 'green' | 'yellow' | 'red';
}) {
    const borderColors = {
        blue: 'border-blue-800/40',
        green: 'border-green-800/40',
        yellow: 'border-yellow-800/40',
        red: 'border-red-800/40',
    };
    const valueColors = {
        blue: 'text-blue-300',
        green: 'text-green-300',
        yellow: 'text-yellow-300',
        red: 'text-red-300',
    };
    return (
        <div className={`bg-[#0F1318] rounded-xl border p-5 ${borderColors[accent]}`}>
            <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2">{label}</div>
            <div className={`text-2xl font-bold font-mono ${valueColors[accent]}`}>{value}</div>
            <div className="text-xs text-gray-600 mt-1">{sub}</div>
        </div>
    );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
    return (
        <div className="mb-3">
            <h2 className="text-sm font-semibold text-gray-200">{title}</h2>
            {subtitle && <p className="text-xs text-gray-600 mt-0.5">{subtitle}</p>}
        </div>
    );
}

function InstructionTable({
    data,
    currentPage,
    totalPages,
    onPrev,
    onNext,
}: {
    data: Instruction[];
    currentPage: number;
    totalPages: number;
    onPrev: () => void;
    onNext: () => void;
}) {
    return (
        <div className="bg-[#0F1318] rounded-xl border border-gray-800/60 overflow-hidden">
            <div className="grid grid-cols-12 text-[10px] text-gray-600 uppercase tracking-widest px-4 py-2 border-b border-gray-800 bg-[#0B0E14]">
                <div className="col-span-1">Type</div>
                <div className="col-span-3">Instruction ID</div>
                <div className="col-span-2">Amount</div>
                <div className="col-span-1">Rail</div>
                <div className="col-span-2">Status</div>
                <div className="col-span-3">Ledger Hash</div>
            </div>
            {data.length === 0 ? (
                <div className="p-8 text-center text-gray-600 text-sm">
                    No instructions in this view. Dispatch instructions to begin.
                </div>
            ) : (
                <div>
                    {data.map((inst) => (
                        <InstructionRow key={inst.instruction_id} inst={inst} />
                    ))}
                    {totalPages > 1 && (
                        <div className="flex justify-between items-center px-4 py-3 border-t border-gray-800">
                            <button
                                onClick={onPrev}
                                disabled={currentPage === 1}
                                className="text-xs text-gray-500 hover:text-gray-200 disabled:opacity-30 font-mono"
                            >
                                ← PREV
                            </button>
                            <span className="text-[10px] text-gray-700 font-mono">
                                PAGE {currentPage} / {totalPages}
                            </span>
                            <button
                                onClick={onNext}
                                disabled={currentPage === totalPages}
                                className="text-xs text-gray-500 hover:text-gray-200 disabled:opacity-30 font-mono"
                            >
                                NEXT →
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function InstructionRow({ inst }: { inst: Instruction }) {
    const isCrypto = ['XLM', 'BTC', 'ETH', 'USDC'].includes(inst.currency);
    const rail = isCrypto
        ? 'Web3'
        : inst.currency === 'INR'
          ? 'RZPX'
          : inst.currency === 'SGD'
            ? 'PayNow'
            : parseFloat(inst.amount) >= 10000
              ? 'SWIFT'
              : 'Stripe';
    const statusColors: Record<string, string> = {
        SETTLED: 'text-green-400 bg-green-900/20',
        FAILED: 'text-red-400 bg-red-900/20',
        LOCKED: 'text-yellow-400 bg-yellow-900/20',
        INITIATED: 'text-blue-400 bg-blue-900/20',
        PENDING_EXECUTION: 'text-purple-400 bg-purple-900/20',
        MANUAL_CHECK: 'text-orange-400 bg-orange-900/20',
    };
    const typeIcon = isCrypto ? '◎' : '⇄';
    const firstHash = inst.ledger_hashes?.[0];

    return (
        <div className="grid grid-cols-12 items-center px-4 py-3 border-b border-gray-800/50 last:border-0 hover:bg-white/[0.02] transition-colors text-xs">
            <div className="col-span-1">
                <span className="text-gray-500 font-mono">{typeIcon}</span>
            </div>
            <div className="col-span-3 font-mono text-gray-400 text-[10px] truncate pr-2">
                {inst.instruction_id?.slice(0, 16)}...
            </div>
            <div className="col-span-2 font-mono text-white font-semibold">
                {parseFloat(inst.amount).toFixed(2)}{' '}
                <span className="text-gray-600">{inst.currency}</span>
            </div>
            <div className="col-span-1 font-mono text-blue-400 text-[10px]">{rail}</div>
            <div className="col-span-2">
                <span
                    className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold ${statusColors[inst.state] || 'text-gray-400'}`}
                >
                    {inst.state}
                </span>
            </div>
            <div className="col-span-3 font-mono text-[9px] text-gray-600 truncate pr-1">
                {firstHash ? (
                    firstHash.slice(0, 32) + '...'
                ) : (
                    <span className="text-gray-800">—</span>
                )}
            </div>
        </div>
    );
}

function RailBar({ label, count, total }: { label: string; count: number; total: number }) {
    const pct = total > 0 ? (count / total) * 100 : 0;
    return (
        <div className="space-y-1">
            <div className="flex justify-between text-[10px] font-mono">
                <span className="text-gray-400">{label}</span>
                <span className="text-gray-600">
                    {count} ({pct.toFixed(0)}%)
                </span>
            </div>
            <div className="w-full bg-gray-800 rounded h-1">
                <div
                    className="bg-blue-600 h-1 rounded transition-all"
                    style={{ width: `${pct}%` }}
                />
            </div>
        </div>
    );
}

function ApiKeyRow({
    label,
    value,
    highlight,
}: {
    label: string;
    value: string;
    highlight?: boolean;
}) {
    return (
        <div className="flex justify-between items-center">
            <span className="text-[10px] text-gray-600 uppercase tracking-widest">{label}</span>
            <span
                className={`text-[10px] font-mono ${highlight ? 'text-green-400' : 'text-gray-400'}`}
            >
                {value}
            </span>
        </div>
    );
}

function QuickAction({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            className="bg-[#161B22] border border-gray-800 hover:border-blue-600/50 hover:text-blue-400 text-gray-400 text-xs font-medium py-2.5 px-3 rounded-lg transition-all text-left"
        >
            {label}
        </button>
    );
}
