import React, { useState, useEffect } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { Activity } from 'lucide-react';

interface TrendPoint {
    month: string;
    inflow: number;
    outflow: number;
    net: number;
}

export default function HistoricalTrendsTab({ apiKey, businessId }: { apiKey?: string, businessId: string }) {
    const [trends, setTrends] = useState<TrendPoint[]>([]);
    const [loading, setLoading] = useState(Boolean(businessId && businessId !== 'ALL'));
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!businessId || businessId === 'ALL') {
            return;
        }

        let ignore = false;

        fetch(`/api/cashiq/${businessId}/historical-trends`)
            .then(res => res.json())
            .then(data => {
                if (!ignore) {
                    if (data.trends) {
                        const formatted = data.trends.map((t: { month: string; inflow: string | number; outflow: string | number }) => ({
                            month: t.month,
                            inflow: parseFloat(String(t.inflow)) || 0,
                            outflow: parseFloat(String(t.outflow)) || 0,
                            net: (parseFloat(String(t.inflow)) || 0) - (parseFloat(String(t.outflow)) || 0)
                        }));
                        setTrends(formatted);
                    } else if (data.error) {
                        setError(data.error);
                    }
                }
            })
            .catch(err => {
                if (!ignore) {
                    console.error('Trends Fetch error', err);
                    setError(err.message);
                }
            })
            .finally(() => {
                if (!ignore) setLoading(false);
            });

        return () => {
            ignore = true;
        };
    }, [businessId]);

    if (loading) {
        return (
            <div className="p-10 text-center flex flex-col items-center justify-center space-y-3">
                <span className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-xs text-gray-500 font-mono animate-pulse">Loading 3-Year Historical Data...</span>
            </div>
        );
    }

    if (businessId === 'ALL') {
        return (
            <div className="bg-[#0F1318] border border-gray-800 rounded-2xl p-10 text-center space-y-3">
                <div className="text-3xl">📈</div>
                <h3 className="text-base font-semibold text-gray-200">Consolidated View Active</h3>
                <p className="text-xs text-gray-500 max-w-md mx-auto">
                    Historical cash trajectories and burn trends are tracked per operating entity. Please select an individual business entity from the header dropdown to view multi-year trends.
                </p>
            </div>
        );
    }

    if (!businessId) {
        return (
            <div className="bg-[#0F1318] border border-gray-800 rounded-2xl p-10 text-center space-y-3">
                <div className="text-3xl">📊</div>
                <h3 className="text-base font-semibold text-gray-200">No Business Entity Selected</h3>
                <p className="text-xs text-gray-500 max-w-md mx-auto">
                    Please select an entity from the header selector to inspect 36-month burn trajectories and cash flow velocity.
                </p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="bg-red-950/20 border border-red-800/40 rounded-2xl p-8 text-center space-y-3">
                <div className="text-2xl text-red-400">⚠️</div>
                <h3 className="text-sm font-semibold text-red-300">Unable to load historical trends</h3>
                <p className="text-xs text-red-400/80 font-mono max-w-md mx-auto">{error}</p>
            </div>
        );
    }

    if (trends.length === 0) {
        return (
            <div className="bg-[#0F1318] border border-gray-800 rounded-2xl p-10 text-center space-y-2">
                <p className="text-sm text-gray-300 font-medium">No historical transactions recorded</p>
                <p className="text-xs text-gray-500 max-w-md mx-auto">
                    Import bank statements or initiate payments to populate multi-year inflow and outflow trajectories.
                </p>
            </div>
        );
    }

    // Quick metrics based on the last 12 months vs previous 12 months
    const last12 = trends.slice(-12);
    const prev12 = trends.slice(-24, -12);

    const l12Outflow = last12.reduce((acc, curr) => acc + curr.outflow, 0);
    const p12Outflow = prev12.reduce((acc, curr) => acc + curr.outflow, 0);
    
    const burnGrowth = p12Outflow > 0 ? ((l12Outflow - p12Outflow) / p12Outflow) * 100 : 0;

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-end">
                <div>
                    <h2 className="text-2xl font-semibold text-white tracking-tight">Multi-Year Historical Trends</h2>
                    <p className="text-sm text-gray-400 mt-1">Analyzing burn trajectories and seasonal cash flows over 36 months.</p>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-[#0F1318]/80 backdrop-blur-md border border-gray-800 rounded-2xl p-6 relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-6 opacity-10 text-white">
                        <Activity size={64} />
                    </div>
                    <p className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2">LTM Cash Outflow</p>
                    <div className="text-3xl font-light tracking-tight text-white">
                        ₹{(l12Outflow / 100000).toFixed(2)}L
                    </div>
                    <p className="text-xs text-gray-400 mt-4">Last 12 Months</p>
                </div>

                <div className="bg-[#0F1318]/80 backdrop-blur-md border border-gray-800 rounded-2xl p-6 relative overflow-hidden">
                    <p className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2">YoY Burn Growth</p>
                    <div className={`text-3xl font-light tracking-tight ${burnGrowth > 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
                        {burnGrowth > 0 ? '+' : ''}{burnGrowth.toFixed(1)}%
                    </div>
                    <p className="text-xs text-gray-400 mt-4">Compared to previous 12 months</p>
                </div>

                <div className="bg-[#0F1318]/80 backdrop-blur-md border border-gray-800 rounded-2xl p-6 relative overflow-hidden">
                    <p className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2">Data Depth</p>
                    <div className="text-3xl font-light tracking-tight text-white">
                        36 Months
                    </div>
                    <p className="text-xs text-gray-400 mt-4">Full historical dataset active</p>
                </div>
            </div>

            <div className="bg-[#0F1318]/80 backdrop-blur-md border border-gray-800 rounded-2xl p-6">
                <h3 className="text-sm font-medium text-gray-200 mb-6">3-Year Trajectory: Inflow vs Outflow</h3>
                <div className="h-96 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={trends} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                            <defs>
                                <linearGradient id="colorIn" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#10B981" stopOpacity={0.3} />
                                    <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
                                </linearGradient>
                                <linearGradient id="colorOut" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#EF4444" stopOpacity={0.3} />
                                    <stop offset="95%" stopColor="#EF4444" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                            <XAxis 
                                dataKey="month" 
                                stroke="#ffffff50" 
                                tick={{ fill: '#ffffff50', fontSize: 12 }} 
                                axisLine={false} 
                                tickLine={false} 
                                minTickGap={30}
                            />
                            <YAxis 
                                stroke="#ffffff50" 
                                tick={{ fill: '#ffffff50', fontSize: 12 }} 
                                axisLine={false} 
                                tickLine={false} 
                                tickFormatter={(v) => `₹${(v/100000).toFixed(0)}L`} 
                            />
                            <Tooltip 
                                contentStyle={{ backgroundColor: '#0F1318', border: '1px solid #ffffff20', borderRadius: '8px', color: '#fff' }}
                                formatter={(value: unknown) => `₹${Number(value).toLocaleString()}`}
                                labelStyle={{ color: '#ffffff70', marginBottom: '4px' }}
                            />
                            <Legend wrapperStyle={{ fontSize: '12px', opacity: 0.7 }} />
                            <Area type="monotone" dataKey="inflow" stroke="#10B981" fillOpacity={1} fill="url(#colorIn)" name="Cash In" strokeWidth={2} />
                            <Area type="monotone" dataKey="outflow" stroke="#EF4444" fillOpacity={1} fill="url(#colorOut)" name="Cash Out" strokeWidth={2} />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>
            </div>
        </div>
    );
}
