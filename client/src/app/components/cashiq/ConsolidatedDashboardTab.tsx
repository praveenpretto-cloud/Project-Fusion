import React, { useState, useEffect } from 'react';
import { XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, BarChart, Bar, Legend } from 'recharts';

interface EntityMetrics {
    balance: number;
    inflow: number;
    outflow: number;
    ap: number;
    pending_ap?: number;
    net_flow?: number;
    [key: string]: unknown;
}

interface EntityData {
    business_id: string;
    name: string;
    industry?: string;
    metrics: EntityMetrics;
}

interface ConsolidatedData {
    global_metrics: {
        total_liquidity: number;
        net_cashflow_30d: number;
        global_runway_days: number;
        total_ap: number;
        [key: string]: unknown;
    };
    entities: EntityData[];
}

export default function ConsolidatedDashboardTab({ apiKey }: { apiKey?: string } = {}) {
    const [data, setData] = useState<ConsolidatedData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let ignore = false;
        fetch('/api/cashiq/consolidated/dashboard')
            .then(res => res.json())
            .then(json => {
                if (!ignore) {
                    if (json.success) setData(json);
                    else setError(json.error);
                }
            })
            .catch(err => {
                if (!ignore) setError(err.message);
            })
            .finally(() => {
                if (!ignore) setLoading(false);
            });
        return () => {
            ignore = true;
        };
    }, [apiKey]);

    if (loading) return <div className="p-10 text-center text-gray-500 font-mono animate-pulse">Aggregating Holdings Group Data...</div>;
    if (error) return <div className="p-10 text-center text-red-500 bg-red-950/20 rounded-xl">Error: {error}</div>;
    if (!data) return null;

    const { global_metrics, entities } = data;

    // Format for charts
    const entityChartData = entities.map((e: EntityData) => ({
        name: e.name,
        Balance: Number(e.metrics.balance),
        Inflow: Number(e.metrics.inflow),
        Outflow: Number(e.metrics.outflow)
    }));

    return (
        <div className="space-y-8 pb-10">
            {/* Header */}
            <div>
                <div className="flex items-center gap-3 mb-2">
                    <span className="text-3xl">🏢</span>
                    <h2 className="text-3xl font-semibold tracking-tight text-white/90">Holding Company Dashboard</h2>
                </div>
                <p className="text-[15px] text-white/50 font-medium ml-11">Consolidated financial overview of all subsidiary entities.</p>
            </div>

            {/* Global Thermometer (KPIs) */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-gradient-to-br from-indigo-900/40 to-black/40 border border-indigo-500/30 p-5 rounded-2xl shadow-glow-indigo">
                    <div className="text-indigo-300/80 text-xs font-bold uppercase tracking-widest mb-2">Group Total Liquidity</div>
                    <div className="text-3xl font-mono text-white font-semibold">
                        ₹{global_metrics.total_liquidity.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </div>
                </div>
                <div className="bg-white/[0.02] border border-white/10 p-5 rounded-2xl">
                    <div className="text-white/40 text-xs font-bold uppercase tracking-widest mb-2">30D Consolidated Net Cashflow</div>
                    <div className={`text-2xl font-mono font-semibold ${global_metrics.net_cashflow_30d >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {global_metrics.net_cashflow_30d >= 0 ? '+' : '-'}₹{Math.abs(global_metrics.net_cashflow_30d).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </div>
                </div>
                <div className="bg-white/[0.02] border border-white/10 p-5 rounded-2xl">
                    <div className="text-white/40 text-xs font-bold uppercase tracking-widest mb-2">Global Group Runway</div>
                    <div className="text-2xl font-mono text-white font-semibold">
                        {global_metrics.global_runway_days === 999 ? '> 3 Years' : `${global_metrics.global_runway_days} Days`}
                    </div>
                </div>
                <div className="bg-white/[0.02] border border-white/10 p-5 rounded-2xl">
                    <div className="text-white/40 text-xs font-bold uppercase tracking-widest mb-2">Total Outstanding Payables</div>
                    <div className="text-2xl font-mono text-red-400 font-semibold">
                        ₹{global_metrics.total_ap.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Visual Chart */}
                <div className="bg-white/[0.02] border border-white/10 rounded-2xl p-6">
                    <h3 className="text-white/80 font-semibold mb-6">Liquidity Distribution by Entity</h3>
                    <div className="h-64">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={entityChartData} margin={{ left: 10, right: 10 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                                <XAxis dataKey="name" stroke="#ffffff50" tick={{ fill: '#ffffff50', fontSize: 12 }} axisLine={false} tickLine={false} />
                                <YAxis stroke="#ffffff50" tick={{ fill: '#ffffff50', fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${(v/100000).toFixed(1)}L`} />
                                <Tooltip 
                                    contentStyle={{ backgroundColor: '#0F1318', border: '1px solid #ffffff20', borderRadius: '8px', color: '#fff' }}
                                    formatter={(value: unknown) => `₹${Number(value).toLocaleString()}`}
                                />
                                <Bar dataKey="Balance" fill="#4F46E5" radius={[4, 4, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </div>

                {/* Performance Chart */}
                <div className="bg-white/[0.02] border border-white/10 rounded-2xl p-6">
                    <h3 className="text-white/80 font-semibold mb-6">30-Day Cash Flow by Entity</h3>
                    <div className="h-64">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={entityChartData} margin={{ left: 10, right: 10 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                                <XAxis dataKey="name" stroke="#ffffff50" tick={{ fill: '#ffffff50', fontSize: 12 }} axisLine={false} tickLine={false} />
                                <YAxis stroke="#ffffff50" tick={{ fill: '#ffffff50', fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${(v/100000).toFixed(1)}L`} />
                                <Tooltip 
                                    contentStyle={{ backgroundColor: '#0F1318', border: '1px solid #ffffff20', borderRadius: '8px', color: '#fff' }}
                                    formatter={(value: unknown) => `₹${Number(value).toLocaleString()}`}
                                />
                                <Legend wrapperStyle={{ fontSize: '12px', opacity: 0.7 }} />
                                <Bar dataKey="Inflow" fill="#10B981" radius={[4, 4, 0, 0]} name="Cash In" />
                                <Bar dataKey="Outflow" fill="#EF4444" radius={[4, 4, 0, 0]} name="Cash Out" />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </div>
            </div>

            {/* Matrix Table */}
            <div className="bg-white/[0.02] border border-white/10 rounded-2xl overflow-hidden">
                <div className="p-6 border-b border-white/10">
                    <h3 className="text-white/80 font-semibold">Entity Performance Matrix</h3>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm text-gray-300">
                        <thead className="text-xs uppercase bg-black/40 text-gray-500 border-b border-white/10">
                            <tr>
                                <th className="px-6 py-4 font-semibold">Subsidiary Entity</th>
                                <th className="px-6 py-4 font-semibold">Total Liquidity</th>
                                <th className="px-6 py-4 font-semibold">30D Cash In</th>
                                <th className="px-6 py-4 font-semibold">30D Cash Out</th>
                                <th className="px-6 py-4 font-semibold">Outstanding AP</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {entities.map((e: EntityData) => (
                                <tr key={e.business_id} className="hover:bg-white/[0.02] transition-colors">
                                    <td className="px-6 py-4">
                                        <div className="font-semibold text-white/90">{e.name}</div>
                                        <div className="text-xs text-white/30">{e.industry}</div>
                                    </td>
                                    <td className="px-6 py-4 font-mono font-medium text-white/80">
                                        ₹{e.metrics.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </td>
                                    <td className="px-6 py-4 font-mono text-emerald-400">
                                        ₹{e.metrics.inflow.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </td>
                                    <td className="px-6 py-4 font-mono text-red-400">
                                        ₹{e.metrics.outflow.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </td>
                                    <td className="px-6 py-4 font-mono text-orange-400">
                                        ₹{e.metrics.ap.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
