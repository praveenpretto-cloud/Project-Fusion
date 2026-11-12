'use client';

import { useState, useEffect } from 'react';

interface Approval {
    approval_id: string;
    invoice_id: string;
    vendor: string;
    amount: number;
    status: string;
}

export default function CFOAuthenticatorPage() {
    const [approvals, setApprovals] = useState<Approval[]>([]);
    const [loading, setLoading] = useState(true);
    const [executingId, setExecutingId] = useState<string | null>(null);

    useEffect(() => {
        const fetchQueue = async () => {
            try {
                const res = await fetch('/api/zoho/approvals');
                const data = await res.json();
                if (data.approvals) {
                    setApprovals(data.approvals.filter((a: Approval) => a.status === 'DRAFTED' || a.status === 'PENDING_APPROVAL'));
                }
            } catch {
                console.error("Failed to fetch approvals");
            } finally {
                setLoading(false);
            }
        };

        fetchQueue();
        const interval = setInterval(fetchQueue, 5000);
        return () => clearInterval(interval);
    }, []);

    // ADR-002 Governance: Direct unauthenticated execution is disabled.
    // Approvals must be authenticated and cryptographically authorized via WebAuthn step-up (/approve/[instructionId]).
    const executePayment = async (_approvalId: string) => {
        alert("Direct unauthenticated mobile execution is disabled by ADR-002 Dual-Control Governance. Please use the Institutional Treasury Approval Portal (/approve/[id]) with your WebAuthn security key.");
    };

    return (
        <div className="min-h-screen bg-black text-white font-sans overflow-x-hidden selection:bg-indigo-500/30 flex flex-col">
            {/* Header */}
            <div className="pt-12 pb-6 px-6 bg-gradient-to-b from-indigo-950/40 to-transparent sticky top-0 z-10 backdrop-blur-md border-b border-white/5">
                <div className="flex justify-between items-center mb-2">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center font-bold text-lg shadow-[0_0_15px_rgba(99,102,241,0.5)]">
                            F
                        </div>
                        <span className="font-bold tracking-widest text-sm text-gray-300">FUSION <span className="text-indigo-400">AUTH</span></span>
                    </div>
                    <div className="w-2 h-2 bg-emerald-500 rounded-full shadow-[0_0_8px_rgba(16,185,129,0.8)] animate-pulse" />
                </div>
                <h1 className="text-2xl font-black tracking-tight mt-4">Approvals</h1>
                <p className="text-xs text-gray-400 mt-1">SAGA-Safe Execution Environment</p>
            </div>

            {/* Main Content */}
            <div className="flex-1 px-4 pt-4 pb-20 space-y-4 relative">
                {/* Institutional Governance Notice */}
                <div className="bg-amber-950/20 border border-amber-800/40 rounded-xl p-3.5 text-xs text-amber-300">
                    <div className="flex items-center gap-2 font-bold mb-1">
                        <span>🛡️</span>
                        <span>Institutional Governance Policy (ADR-002)</span>
                    </div>
                    <p className="text-[11px] text-amber-200/80 leading-relaxed">
                        Direct unauthenticated mobile execution is disabled. Dual-control governance requires an authenticated operator session and cryptographic FIDO2 verification via the Institutional Treasury Approval Portal.
                    </p>
                </div>
                {loading ? (
                    <div className="flex flex-col items-center justify-center h-48 gap-3">
                        <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                        <span className="text-xs text-gray-500 font-mono tracking-widest uppercase">Syncing Queue...</span>
                    </div>
                ) : approvals.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-64 opacity-50">
                        <div className="text-4xl mb-4">🛡️</div>
                        <p className="text-sm font-medium text-gray-300">No Pending Approvals</p>
                        <p className="text-xs text-gray-500 text-center mt-2 max-w-[200px]">You are all caught up. Your treasury is secure.</p>
                    </div>
                ) : (
                    approvals.map((app) => {
                        const isExecuting = executingId === app.approval_id;
                        return (
                            <div key={app.approval_id} className={`bg-[#0F1318] border ${isExecuting ? 'border-emerald-500/50 shadow-[0_0_20px_rgba(16,185,129,0.2)]' : 'border-gray-800'} rounded-2xl p-5 relative overflow-hidden transition-all duration-500`}>
                                
                                {/* Background execution glow */}
                                {isExecuting && (
                                    <div className="absolute inset-0 bg-emerald-900/10 animate-pulse" />
                                )}

                                <div className="relative z-10">
                                    <div className="flex justify-between items-start mb-3">
                                        <div>
                                            <span className="text-[9px] font-bold tracking-widest uppercase text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                                                REQUIRES SIGN-OFF
                                            </span>
                                            <h3 className="text-base font-bold text-gray-200 mt-2">{app.vendor}</h3>
                                        </div>
                                        <div className="text-right">
                                            <div className="text-xl font-black text-white font-mono tracking-tight">
                                                ₹{new Intl.NumberFormat('en-IN').format(app.amount)}
                                            </div>
                                            <div className="text-[10px] text-gray-500 font-mono mt-0.5">INV: {app.invoice_id}</div>
                                        </div>
                                    </div>

                                    {/* Security Badges */}
                                    <div className="flex flex-wrap gap-2 mb-6 border-y border-gray-800/60 py-3 mt-4">
                                        <div className="flex items-center gap-1.5 bg-gray-900 px-2 py-1 rounded">
                                            <span className="text-[10px]">🔒</span>
                                            <span className="text-[9px] text-gray-400 font-mono">SAGA LOCKED</span>
                                        </div>
                                        <div className="flex items-center gap-1.5 bg-gray-900 px-2 py-1 rounded">
                                            <span className="text-[10px]">🏦</span>
                                            <span className="text-[9px] text-gray-400 font-mono">VIA HDFC</span>
                                        </div>
                                        <div className="flex items-center gap-1.5 bg-emerald-950/30 px-2 py-1 rounded">
                                            <span className="text-[10px]">✅</span>
                                            <span className="text-[9px] text-emerald-400 font-mono">43B COMPLIANT</span>
                                        </div>
                                    </div>

                                    {/* Action Button: routes to authenticated FIDO2 step-up portal */}
                                    <a
                                        href={`/approve/${app.approval_id || app.invoice_id}`}
                                        className="w-full py-4 rounded-xl font-bold tracking-wide transition-all duration-300 flex items-center justify-center gap-3 bg-indigo-600 hover:bg-indigo-500 text-white shadow-[0_0_20px_rgba(79,70,229,0.3)] active:scale-95 text-sm"
                                    >
                                        <span className="text-lg">🔐</span>
                                        <span>OPEN FIDO2 STEP-UP PORTAL</span>
                                    </a>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            {/* Bottom Nav Mock */}
            <div className="fixed bottom-0 left-0 right-0 h-20 bg-[#0a0d11]/90 backdrop-blur-lg border-t border-white/5 flex justify-around items-center px-6 pb-4">
                <div className="flex flex-col items-center gap-1 opacity-100">
                    <span className="text-lg">🛡️</span>
                    <span className="text-[9px] font-bold tracking-wider text-indigo-400">APPROVE</span>
                </div>
                <div className="flex flex-col items-center gap-1 opacity-40">
                    <span className="text-lg">📊</span>
                    <span className="text-[9px] font-bold tracking-wider text-gray-400">LIMITS</span>
                </div>
                <div className="flex flex-col items-center gap-1 opacity-40">
                    <span className="text-lg">⚙️</span>
                    <span className="text-[9px] font-bold tracking-wider text-gray-400">SETTINGS</span>
                </div>
            </div>
        </div>
    );
}
