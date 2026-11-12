'use client';

import { useState } from 'react';

export interface Obligation {
    obligation_id: string;
    obligation_type: string;
    description: string;
    due_date: string;
    amount: number | null;
    currency: string;
    status: string;
    days_until: number;
    days_overdue: number;
    source: string;
}

interface Props {
    businessId: string;
    obligations: Obligation[];
    loading: boolean;
    onSyncZoho: () => void;
    isSyncing: boolean;
}

const TYPE_LABELS: Record<string, string> = {
    GST_PAYMENT: 'GST Payment',
    GST_FILING: 'GST Filing',
    EMI: 'Loan EMI',
    INVOICE_DUE: 'Invoice Due',
    SALARY: 'Salary',
    TDS: 'TDS Payment',
    ADVANCE_TAX: 'Advance Tax',
    VENDOR_PAYMENT: 'Vendor Bill',
};

const TYPE_ICON: Record<string, string> = {
    GST_PAYMENT: '🧾',
    GST_FILING: '📋',
    EMI: '🏦',
    INVOICE_DUE: '📄',
    SALARY: '👥',
    TDS: '📊',
    ADVANCE_TAX: '🏛️',
    VENDOR_PAYMENT: '🏭',
};

function fmt(n: number) {
    return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
}

function StatusBadge({ ob }: { ob: Obligation }) {
    if (ob.status === 'FACTORED') {
        return (
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400 border border-indigo-500/40">
                FACTORED
            </span>
        );
    }
    if (ob.status === 'DUNNING_SENT') {
        return (
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 border border-purple-500/40">
                LINK SENT
            </span>
        );
    }
    if (ob.status === 'OVERDUE') {
        return (
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/40">
                {ob.days_overdue}d OVERDUE
            </span>
        );
    }
    if (ob.days_until <= 0) {
        return (
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/40">
                DUE TODAY
            </span>
        );
    }
    if (ob.days_until <= 3) {
        return (
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/40">
                DUE IN {ob.days_until}D
            </span>
        );
    }
    if (ob.days_until <= 7) {
        return (
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-400 border border-orange-500/40">
                DUE IN {ob.days_until}D
            </span>
        );
    }
    return (
        <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
            IN {ob.days_until}D
        </span>
    );
}

function rowBg(ob: Obligation) {
    if (ob.status === 'OVERDUE') return 'bg-red-950/20 hover:bg-red-950/30 border-red-900/30';
    if (ob.days_until <= 3) return 'bg-amber-950/20 hover:bg-amber-950/30 border-amber-900/30';
    return 'bg-[#0F1318] hover:bg-[#161B22] border-gray-800/40';
}

export default function ObligationsTab({
    businessId,
    obligations,
    loading,
    onSyncZoho,
    isSyncing,
}: Props) {
    const [filter, setFilter] = useState<'ALL' | 'OVERDUE' | 'UPCOMING'>('ALL');
    const [processingId, setProcessingId] = useState<string | null>(null);

    const handleAction = async (id: string, action: 'discount' | 'dunning') => {
        setProcessingId(id);
        try {
            const res = await fetch(`/api/cashiq/${businessId}/obligations/${id}/${action}`, {
                method: 'POST',
            });
            if (res.ok) {
                onSyncZoho(); // Refresh data after action
            } else {
                const err = await res.json();
                alert(`Action failed: ${err.error || 'Unknown error'}`);
            }
        } catch (e: unknown) {
            alert(`Error: ${(e as Error).message}`);
        } finally {
            setProcessingId(null);
        }
    };

    const filtered = obligations.filter((ob) => {
        if (filter === 'OVERDUE') return ob.status === 'OVERDUE';
        if (filter === 'UPCOMING') return ob.status !== 'OVERDUE';
        return true;
    });

    const overdueCount = obligations.filter((o) => o.status === 'OVERDUE').length;
    const totalPayable = obligations
        .filter((o) => o.amount && o.amount > 0)
        .reduce((s, o) => s + (o.amount || 0), 0);

    return (
        <div className="space-y-5">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-sm font-semibold text-gray-200">Obligations Timeline</h2>
                    <p className="text-[10px] text-gray-600 mt-0.5">
                        {obligations.length} item(s) · Total payable: ₹{fmt(totalPayable)}
                        {overdueCount > 0 && (
                            <span className="text-red-400 ml-2">· {overdueCount} overdue</span>
                        )}
                    </p>
                </div>
                <button
                    onClick={onSyncZoho}
                    disabled={isSyncing}
                    className="text-xs px-3 py-1.5 rounded-lg bg-indigo-900/30 border border-indigo-700/50 text-indigo-300 hover:bg-indigo-800/40 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                >
                    <span className={isSyncing ? 'animate-spin' : ''}>⟳</span>
                    {isSyncing ? 'Syncing...' : 'Sync from Zoho'}
                </button>
            </div>

            {/* Filter pills */}
            <div className="flex gap-2">
                {(['ALL', 'OVERDUE', 'UPCOMING'] as const).map((f) => (
                    <button
                        key={f}
                        onClick={() => setFilter(f)}
                        className={`text-[10px] font-bold px-3 py-1 rounded-full border transition-colors ${
                            filter === f
                                ? 'bg-blue-600/30 border-blue-500/60 text-blue-300'
                                : 'bg-transparent border-gray-700/50 text-gray-500 hover:border-gray-600'
                        }`}
                    >
                        {f === 'OVERDUE' && overdueCount > 0 ? `OVERDUE (${overdueCount})` : f}
                    </button>
                ))}
            </div>

            {/* Table */}
            {loading ? (
                <div className="text-center text-gray-600 text-sm py-12 animate-pulse">
                    Loading obligations...
                </div>
            ) : filtered.length === 0 ? (
                <div className="text-center text-gray-600 text-sm py-12">
                    {filter === 'OVERDUE' ? 'No overdue obligations 🎉' : 'No obligations found'}
                </div>
            ) : (
                <div className="space-y-2">
                    {filtered.map((ob) => (
                        <div
                            key={ob.obligation_id}
                            className={`border rounded-xl px-4 py-3 transition-colors ${rowBg(ob)}`}
                        >
                            <div className="flex items-center justify-between gap-3">
                                <div className="flex items-center gap-3 flex-1 min-w-0">
                                    <span className="text-base shrink-0">
                                        {TYPE_ICON[ob.obligation_type] || '📌'}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">
                                                {TYPE_LABELS[ob.obligation_type] ||
                                                    ob.obligation_type}
                                            </span>
                                            <span className="text-[9px] text-gray-700 capitalize">
                                                {ob.source}
                                            </span>
                                        </div>
                                        <div className="text-xs text-gray-300 font-medium mt-0.5 truncate">
                                            {ob.description}
                                        </div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-3 shrink-0">
                                    {ob.amount !== null && ob.amount > 0 && (
                                        <div className="text-right">
                                            <div className="text-xs font-mono font-bold text-gray-200">
                                                ₹{fmt(ob.amount)}
                                            </div>
                                            <div className="text-[9px] text-gray-600">
                                                {ob.currency}
                                            </div>
                                        </div>
                                    )}
                                    <div className="text-right">
                                        <div className="text-[10px] text-gray-500 font-mono">
                                            {ob.due_date}
                                        </div>
                                        <div className="mt-0.5">
                                            <StatusBadge ob={ob} />
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Receivables Actions Toolbar */}
                            {ob.obligation_type === 'INVOICE_DUE' &&
                                ob.status !== 'FACTORED' &&
                                ob.amount !== null &&
                                ob.amount > 0 && (
                                    <div className="flex gap-2 border-t border-gray-800/40 pt-3 mt-3">
                                        <button
                                            onClick={() =>
                                                handleAction(ob.obligation_id, 'discount')
                                            }
                                            disabled={processingId === ob.obligation_id}
                                            className="text-[10px] font-bold px-3 py-1.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20 disabled:opacity-50 transition-colors"
                                        >
                                            {processingId === ob.obligation_id
                                                ? 'Processing...'
                                                : 'Get Paid Early (1.5% Fee)'}
                                        </button>
                                        <button
                                            onClick={() =>
                                                handleAction(ob.obligation_id, 'dunning')
                                            }
                                            disabled={
                                                processingId === ob.obligation_id ||
                                                ob.status === 'DUNNING_SENT'
                                            }
                                            className="text-[10px] font-bold px-3 py-1.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/30 hover:bg-blue-500/20 disabled:opacity-50 transition-colors"
                                        >
                                            {ob.status === 'DUNNING_SENT'
                                                ? 'Reminder Sent'
                                                : 'Send Payment Link'}
                                        </button>
                                    </div>
                                )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
