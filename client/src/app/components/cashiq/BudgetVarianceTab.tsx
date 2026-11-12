import React, { useState, useEffect } from 'react';

interface VarianceData {
    department_name: string;
    category: string;
    monthly_limit: string;
    actual_spend: string;
    variance: string;
    is_over_budget: boolean;
}

export default function BudgetVarianceTab({
    businessId,
    apiKey,
}: {
    businessId: string;
    apiKey?: string;
}) {
    const [data, setData] = useState<VarianceData[]>([]);
    const [loading, setLoading] = useState(Boolean(businessId && businessId !== 'ALL'));
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!businessId || businessId === 'ALL') {
            return;
        }

        let ignore = false;

        fetch(`/api/cashiq/${businessId}/budgets/variance`)
            .then((res) => res.json())
            .then((json) => {
                if (!ignore) {
                    if (json.success) {
                        setData(json.variance || []);
                    } else {
                        setError(json.error || 'Failed to fetch budget variance');
                    }
                }
            })
            .catch((err) => {
                if (!ignore) setError(err.message);
            })
            .finally(() => {
                if (!ignore) setLoading(false);
            });

        return () => {
            ignore = true;
        };
    }, [businessId]);

    if (loading)
        return (
            <div className="p-10 text-center flex flex-col items-center justify-center space-y-3">
                <span className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-xs text-gray-500 font-mono animate-pulse">
                    Computing department variances...
                </span>
            </div>
        );

    if (businessId === 'ALL') {
        return (
            <div className="bg-[#0F1318] border border-gray-800 rounded-2xl p-10 text-center space-y-3">
                <div className="text-3xl">🏢</div>
                <h3 className="text-base font-semibold text-gray-200">Consolidated View Active</h3>
                <p className="text-xs text-gray-500 max-w-md mx-auto">
                    Departmental budgets are tracked at the legal entity level. Please select an
                    individual business entity from the header dropdown to view departmental OPEX
                    variances.
                </p>
            </div>
        );
    }

    if (!businessId) {
        return (
            <div className="bg-[#0F1318] border border-gray-800 rounded-2xl p-10 text-center space-y-3">
                <div className="text-3xl">📊</div>
                <h3 className="text-base font-semibold text-gray-200">
                    No Business Entity Selected
                </h3>
                <p className="text-xs text-gray-500 max-w-md mx-auto">
                    Please select an entity from the header selector to review departmental budget
                    limits, actual spends, and utilization rates.
                </p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="bg-red-950/20 border border-red-800/40 rounded-2xl p-8 text-center space-y-3">
                <div className="text-2xl text-red-400">⚠️</div>
                <h3 className="text-sm font-semibold text-red-300">
                    Unable to load budget variances
                </h3>
                <p className="text-xs text-red-400/80 font-mono max-w-md mx-auto">{error}</p>
            </div>
        );
    }

    if (data.length === 0) {
        return (
            <div className="bg-[#0F1318] border border-gray-800 rounded-2xl p-10 text-center space-y-2">
                <p className="text-sm text-gray-300 font-medium">No budget records found</p>
                <p className="text-xs text-gray-500 max-w-md mx-auto">
                    No active departmental budget categories are currently configured for this
                    entity.
                </p>
            </div>
        );
    }

    // Group by department
    const deps = data.reduce(
        (acc, curr) => {
            if (!acc[curr.department_name]) acc[curr.department_name] = [];
            acc[curr.department_name].push(curr);
            return acc;
        },
        {} as Record<string, VarianceData[]>
    );

    const fmtLakh = (n: number) => {
        const abs = Math.abs(n);
        if (abs >= 10000000) return `₹${(abs / 10000000).toFixed(2)}Cr`;
        if (abs >= 100000) return `₹${(abs / 100000).toFixed(1)}L`;
        if (abs >= 1000) return `₹${(abs / 1000).toFixed(0)}K`;
        return `₹${abs.toFixed(0)}`;
    };

    const totalLimit = data.reduce((s, d) => s + parseFloat(d.monthly_limit), 0);
    const totalActual = data.reduce((s, d) => s + parseFloat(d.actual_spend), 0);
    const overallUtil = totalLimit > 0 ? (totalActual / totalLimit) * 100 : 0;

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-end">
                <div>
                    <h2 className="text-xl font-bold text-white mb-1">
                        Departmental Budgets vs Actuals
                    </h2>
                    <p className="text-sm text-gray-400">
                        Tracking 12-month OPEX limits across {Object.keys(deps).length} departments.
                    </p>
                </div>
                <div className="text-right">
                    <div className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mb-1">
                        Total Organization Utilization
                    </div>
                    <div
                        className={`text-2xl font-mono font-black ${overallUtil > 100 ? 'text-red-400' : 'text-emerald-400'}`}
                    >
                        {overallUtil.toFixed(1)}%
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {Object.entries(deps).map(([depName, items]) => {
                    const depTotalLimit = items.reduce(
                        (s, i) => s + parseFloat(i.monthly_limit),
                        0
                    );
                    const depTotalActual = items.reduce(
                        (s, i) => s + parseFloat(i.actual_spend),
                        0
                    );
                    const utilPct = depTotalLimit > 0 ? (depTotalActual / depTotalLimit) * 100 : 0;

                    return (
                        <div
                            key={depName}
                            className="glass-panel border border-white/10 rounded-2xl p-5 relative overflow-hidden group hover:border-indigo-500/30 transition-colors"
                        >
                            {/* Background bar */}
                            <div className="absolute top-0 left-0 h-1 bg-white/5 w-full">
                                <div
                                    className={`h-full ${utilPct > 100 ? 'bg-red-500' : utilPct > 80 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                                    style={{ width: `${Math.min(utilPct, 100)}%` }}
                                />
                            </div>

                            <div className="flex justify-between items-center mb-5">
                                <h3 className="text-lg font-bold text-white">{depName}</h3>
                                <div className="text-right">
                                    <div className="text-sm font-mono font-bold text-white">
                                        {fmtLakh(depTotalActual)}{' '}
                                        <span className="text-gray-500 text-xs">
                                            / {fmtLakh(depTotalLimit)}
                                        </span>
                                    </div>
                                    <div
                                        className={`text-[10px] font-bold ${utilPct > 100 ? 'text-red-400' : 'text-gray-400'}`}
                                    >
                                        {utilPct.toFixed(0)}% UTILIZED
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-4">
                                {items.map((item) => {
                                    const limit = parseFloat(item.monthly_limit);
                                    const actual = parseFloat(item.actual_spend);
                                    const pct = limit > 0 ? (actual / limit) * 100 : 0;
                                    const isOver = actual > limit;

                                    return (
                                        <div key={item.category} className="space-y-1">
                                            <div className="flex justify-between items-center text-xs">
                                                <span className="text-gray-300">
                                                    {item.category}
                                                </span>
                                                <span className="font-mono text-gray-400">
                                                    {fmtLakh(actual)}{' '}
                                                    <span className="text-gray-600">
                                                        / {fmtLakh(limit)}
                                                    </span>
                                                </span>
                                            </div>
                                            <div className="h-1.5 w-full bg-gray-800 rounded-full overflow-hidden">
                                                <div
                                                    className={`h-full rounded-full transition-all duration-500 ${isOver ? 'bg-red-500' : 'bg-blue-500'}`}
                                                    style={{ width: `${Math.min(pct, 100)}%` }}
                                                />
                                            </div>
                                            {isOver && (
                                                <div className="text-[9px] text-red-400 font-bold mt-1 uppercase text-right">
                                                    Over Budget by {fmtLakh(actual - limit)}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
