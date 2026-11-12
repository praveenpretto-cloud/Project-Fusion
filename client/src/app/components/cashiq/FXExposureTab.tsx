import React, { useState, useEffect } from 'react';
import { AlertCircle, TrendingDown } from 'lucide-react';

interface FXExposure {
    exposure_id: string;
    vendor_name: string;
    currency: string;
    foreign_amount: string;
    base_rate: string;
    current_rate: string;
    current_inr_value: string;
    unrealized_loss: string;
}

export default function FXExposureTab({ apiKey, businessId }: { apiKey?: string, businessId: string }) {
    const [exposures, setExposures] = useState<FXExposure[]>([]);
    const [loading, setLoading] = useState(Boolean(businessId && businessId !== 'ALL'));
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!businessId || businessId === 'ALL') {
            return;
        }

        let ignore = false;

        fetch(`/api/cashiq/${businessId}/fx-exposures`)
        .then(res => res.json())
        .then(data => {
            if (!ignore) {
                if (data.exposures) {
                    setExposures(data.exposures);
                } else if (data.error) {
                    setError(data.error);
                }
            }
        })
        .catch(err => {
            if (!ignore) {
                console.error('FX Fetch error', err);
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
                <span className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-xs text-gray-500 font-mono animate-pulse">Loading FX Risk Profile...</span>
            </div>
        );
    }

    if (businessId === 'ALL') {
        return (
            <div className="bg-[#0F1318] border border-gray-800 rounded-2xl p-10 text-center space-y-3">
                <div className="text-3xl">💱</div>
                <h3 className="text-base font-semibold text-gray-200">Consolidated View Active</h3>
                <p className="text-xs text-gray-500 max-w-md mx-auto">
                    Foreign exchange exposure and mark-to-market risks are evaluated per legal entity based on their open payables. Please select a specific entity from the top selector.
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
                    Please select an entity from the header selector to inspect currency hedges and mark-to-market AP exposure.
                </p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="bg-red-950/20 border border-red-800/40 rounded-2xl p-8 text-center space-y-3">
                <div className="text-2xl text-red-400">⚠️</div>
                <h3 className="text-sm font-semibold text-red-300">Unable to load FX exposure</h3>
                <p className="text-xs text-red-400/80 font-mono max-w-md mx-auto">{error}</p>
            </div>
        );
    }

    const totalUnrealizedLoss = exposures.reduce((acc, curr) => acc + parseFloat(String(curr.unrealized_loss)), 0);

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-end">
                <div>
                    <h2 className="text-2xl font-semibold text-white tracking-tight">FX Exposure & Risk</h2>
                    <p className="text-sm text-gray-400 mt-1">Real-time unrealized currency risk for active accounts payable.</p>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-[#0F1318]/80 backdrop-blur-md border border-gray-800 rounded-2xl p-6 relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-6 opacity-10 text-white">
                        <TrendingDown size={64} />
                    </div>
                    <p className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2">Total Unrealized Loss (INR)</p>
                    <div className={`text-4xl font-light tracking-tight ${totalUnrealizedLoss > 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
                        ₹{totalUnrealizedLoss.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                    </div>
                    <p className="text-xs text-gray-400 mt-4 flex items-center gap-1">
                        <AlertCircle size={12} className={totalUnrealizedLoss > 0 ? 'text-rose-500' : ''} />
                        Based on spot rates vs invoice booking rates.
                    </p>
                </div>

                <div className="bg-[#0F1318]/80 backdrop-blur-md border border-gray-800 rounded-2xl p-6 relative overflow-hidden">
                    <p className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2">Active Open Exposures</p>
                    <div className="text-4xl font-light tracking-tight text-white">
                        {exposures.length} Invoices
                    </div>
                    <p className="text-xs text-gray-400 mt-4">Across USD, EUR.</p>
                </div>
            </div>

            <div className="bg-[#0F1318]/80 backdrop-blur-md border border-gray-800 rounded-2xl overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-800 bg-white/[0.02]">
                    <h3 className="text-sm font-medium text-white">Pending Foreign Obligations</h3>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left">
                        <thead className="text-xs text-gray-400 uppercase bg-[#1A1E23]/50">
                            <tr>
                                <th className="px-6 py-3 font-medium">Vendor</th>
                                <th className="px-6 py-3 font-medium text-right">Foreign Amount</th>
                                <th className="px-6 py-3 font-medium text-right">Base Rate</th>
                                <th className="px-6 py-3 font-medium text-right">Live Rate</th>
                                <th className="px-6 py-3 font-medium text-right">Current Value (INR)</th>
                                <th className="px-6 py-3 font-medium text-right">Impact (INR)</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-800/50">
                            {exposures.map((exp) => (
                                <tr key={exp.exposure_id} className="hover:bg-white/[0.02] transition-colors">
                                    <td className="px-6 py-4 font-medium text-white">{exp.vendor_name}</td>
                                    <td className="px-6 py-4 text-right">
                                        {exp.currency === 'USD' ? '$' : '€'}
                                        {parseFloat(exp.foreign_amount).toLocaleString()}
                                    </td>
                                    <td className="px-6 py-4 text-right text-white">₹{parseFloat(exp.base_rate).toFixed(2)}</td>
                                    <td className="px-6 py-4 text-right text-white font-mono">₹{parseFloat(exp.current_rate).toFixed(2)}</td>
                                    <td className="px-6 py-4 text-right text-white">
                                        ₹{parseFloat(exp.current_inr_value).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                                    </td>
                                    <td className={`px-6 py-4 text-right font-medium ${parseFloat(exp.unrealized_loss) > 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
                                        {parseFloat(exp.unrealized_loss) > 0 ? '+' : ''}₹{parseFloat(exp.unrealized_loss).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                                    </td>
                                </tr>
                            ))}
                            {exposures.length === 0 && (
                                <tr>
                                    <td colSpan={6} className="px-6 py-8 text-center text-gray-400">No open foreign exposures found.</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
