'use client';

import { useState, useEffect } from 'react';

// Types matching the backend API
interface Instruction {
    instruction_id: string;
    amount: string;
    currency: string;
    sender_hash: string; // API sends hash
    recipient_hash: string; // API sends hash
    purpose: string;
    state: 'INITIATED' | 'LOCKED' | 'PENDING_EXECUTION' | 'SETTLED' | 'FAILED';
    timestamp: string; // API sends timestamp (created_at)
}

export default function Dashboard() {
    const [instructions, setInstructions] = useState<Instruction[]>([]);
    const [lastUpdated, setLastUpdated] = useState<string>('Loading...');

    // Poll the API every 2 seconds
    useEffect(() => {
        const fetchData = async () => {
            try {
                // Fetch from our local Next.js proxy (which handles the SSL handshake)
                const res = await fetch('/api/observe');

                if (res.ok) {
                    const data = await res.json();
                    // Sort by timestamp desc (Fix: API returns 'data', not 'instructions')
                    const apiInstructions = data.data || [];
                    const sorted = apiInstructions.sort(
                        (a: Instruction, b: Instruction) =>
                            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
                    );
                    setInstructions(sorted);
                    setLastUpdated(new Date().toLocaleTimeString());
                }
            } catch (err) {
                console.error('Failed to fetch instructions:', err);
            }
        };

        fetchData(); // Initial call
        const interval = setInterval(fetchData, 2000); // Poll
        return () => clearInterval(interval);
    }, []);

    // Calculate Dynamic Total Volume
    const totalVolume = instructions
        .filter((i) => i.state === 'SETTLED')
        .reduce((acc, curr) => acc + parseFloat(curr.amount), 0);

    return (
        <div className="min-h-screen bg-gray-900 text-gray-100 p-8 font-sans">
            <header className="mb-8 flex justify-between items-center">
                <div>
                    <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
                        Project Fusion
                    </h1>
                    <p className="text-gray-400 text-sm mt-1">
                        Institutional Orchestration Control Plane
                    </p>
                </div>
                <div className="text-right">
                    <div className="text-xs text-green-400 font-mono">● SYSTEM ACTIVE</div>
                    <div className="text-xs text-gray-500">Last Sync: {lastUpdated}</div>
                </div>
            </header>

            <div className="grid grid-cols-1 gap-6">
                {/* METRICS ROW */}
                <div className="grid grid-cols-4 gap-4 mb-4">
                    <MetricCard
                        label="Total Volume"
                        value={`$${totalVolume.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                        color="blue"
                    />
                    <MetricCard
                        label="Active Sagas"
                        value={instructions
                            .filter((i) => i.state !== 'SETTLED' && i.state !== 'FAILED')
                            .length.toString()}
                        color="yellow"
                    />
                    <MetricCard
                        label="Settled 24h"
                        value={instructions.filter((i) => i.state === 'SETTLED').length.toString()}
                        color="green"
                    />
                    <MetricCard
                        label="Failed"
                        value={instructions.filter((i) => i.state === 'FAILED').length.toString()}
                        color="red"
                    />
                </div>

                {/* TRANSACTIONS TABLE */}
                <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden shadow-2xl">
                    <div className="px-6 py-4 border-b border-gray-700 bg-gray-800/50 flex justify-between">
                        <h2 className="font-semibold text-gray-200">Live Instructions</h2>
                        <span className="text-xs text-gray-400 self-center">
                            Polling /api/observe (2s)
                        </span>
                    </div>

                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead className="bg-gray-800 text-gray-400 uppercase font-medium text-xs">
                                <tr>
                                    <th className="px-6 py-3">ID / Purpose</th>
                                    <th className="px-6 py-3">Amount</th>
                                    <th className="px-6 py-3">Entities (Hash)</th>
                                    <th className="px-6 py-3">State</th>
                                    <th className="px-6 py-3 text-right">Timestamp</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-700">
                                {instructions.map((inst) => (
                                    <tr
                                        key={inst.instruction_id}
                                        className="hover:bg-gray-700/50 transition-colors"
                                    >
                                        <td className="px-6 py-4 font-mono text-gray-300">
                                            <div className="font-bold text-white">
                                                {inst.instruction_id.slice(0, 8)}...
                                            </div>
                                            <div className="text-xs text-gray-500">
                                                {inst.purpose}
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 font-medium text-gray-200">
                                            {inst.amount} {inst.currency}
                                        </td>
                                        <td className="px-6 py-4 text-xs font-mono text-gray-500">
                                            <div>From: {inst.sender_hash?.slice(0, 10)}...</div>
                                            <div>To: {inst.recipient_hash?.slice(0, 10)}...</div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <StatusBadge state={inst.state} />
                                        </td>
                                        <td className="px-6 py-4 text-right text-gray-400 font-mono text-xs">
                                            {new Date(inst.timestamp).toLocaleTimeString()}
                                        </td>
                                    </tr>
                                ))}
                                {instructions.length === 0 && (
                                    <tr>
                                        <td
                                            colSpan={5}
                                            className="px-6 py-8 text-center text-gray-500 italic"
                                        >
                                            No transactions found. Initiate payments to see them
                                            here.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
}

function MetricCard({
    label,
    value,
    color,
}: {
    label: string;
    value: string;
    color: 'blue' | 'green' | 'yellow' | 'red';
}) {
    const colors = {
        blue: 'text-blue-400',
        green: 'text-green-400',
        yellow: 'text-yellow-400',
        red: 'text-red-400',
    };
    return (
        <div className="bg-gray-800 p-4 rounded-lg border border-gray-700 shadow-sm">
            <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">{label}</div>
            <div className={`text-2xl font-bold font-mono ${colors[color]}`}>{value}</div>
        </div>
    );
}

function StatusBadge({ state }: { state: string }) {
    const styles = {
        INITIATED: 'bg-blue-900 text-blue-300 border-blue-700',
        LOCKED: 'bg-yellow-900 text-yellow-300 border-yellow-700',
        PENDING_EXECUTION: 'bg-purple-900 text-purple-300 border-purple-700', // SAGA Active
        SETTLED: 'bg-green-900 text-green-300 border-green-700',
        FAILED: 'bg-red-900 text-red-300 border-red-700',
    };
    const style = styles[state as keyof typeof styles] || 'bg-gray-800 text-gray-400';

    return (
        <span className={`px-2 py-1 rounded-full text-xs font-bold border ${style}`}>{state}</span>
    );
}
