'use client';

import { useState } from 'react';

export interface AlertRule {
    rule_id: string;
    rule_type: string;
    threshold_value: number | null;
    threshold_days: number | null;
    is_active: boolean;
}

export interface AlertEvent {
    event_id: string;
    severity: 'HIGH' | 'MEDIUM' | 'LOW';
    title: string;
    message: string;
    is_read: boolean;
    triggered_at: string;
}

interface Props {
    businessId: string;
    alerts: AlertEvent[];
    rules: AlertRule[];
    loading: boolean;
    onMarkRead: (eventId: string) => void;
    onSweep: () => void;
    isSweeping: boolean;
}

const RULE_LABELS: Record<string, string> = {
    LOW_BALANCE: 'Low Balance',
    LARGE_DEBIT: 'Large Debit',
    OVERDUE_INVOICE: 'Overdue Invoice',
    UPCOMING_GST: 'Upcoming GST',
    UPCOMING_EMI: 'Upcoming EMI',
};

function severityStyle(s: string) {
    if (s === 'HIGH')
        return {
            badge: 'bg-red-500/20 text-red-400 border-red-500/40',
            dot: 'bg-red-500',
            card: 'border-red-900/30 bg-red-950/15',
        };
    if (s === 'MEDIUM')
        return {
            badge: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
            dot: 'bg-amber-500',
            card: 'border-amber-900/30 bg-amber-950/15',
        };
    return {
        badge: 'bg-blue-500/20 text-blue-400 border-blue-500/40',
        dot: 'bg-blue-500',
        card: 'border-blue-900/30 bg-blue-950/15',
    };
}

function timeAgo(iso: string) {
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

export default function AlertsTab({
    alerts,
    rules,
    loading,
    onMarkRead,
    onSweep,
    isSweeping,
}: Props) {
    const [showRules, setShowRules] = useState(false);

    const highCount = alerts.filter((a) => a.severity === 'HIGH').length;
    const mediumCount = alerts.filter((a) => a.severity === 'MEDIUM').length;

    return (
        <div className="space-y-5">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-sm font-semibold text-gray-200">CashSentinel Alerts</h2>
                    <div className="flex items-center gap-3 mt-0.5">
                        {highCount > 0 && (
                            <span className="text-[10px] text-red-400">{highCount} HIGH</span>
                        )}
                        {mediumCount > 0 && (
                            <span className="text-[10px] text-amber-400">{mediumCount} MEDIUM</span>
                        )}
                        {alerts.length === 0 && (
                            <span className="text-[10px] text-emerald-400">All clear ✓</span>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setShowRules((s) => !s)}
                        className="text-xs px-3 py-1.5 rounded-lg bg-gray-900/50 border border-gray-700/50 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
                    >
                        ⚙ Alert Rules
                    </button>
                    <button
                        onClick={onSweep}
                        disabled={isSweeping}
                        className="text-xs px-3 py-1.5 rounded-lg bg-indigo-900/30 border border-indigo-700/50 text-indigo-300 hover:bg-indigo-800/40 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                    >
                        <span className={isSweeping ? 'animate-spin inline-block' : ''}>⟳</span>
                        {isSweeping ? 'Sweeping...' : 'Run Sweep'}
                    </button>
                </div>
            </div>

            {/* Alert Rules Panel */}
            {showRules && (
                <div className="bg-[#0F1318] border border-gray-800/60 rounded-xl p-4">
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-3 font-bold">
                        Alert Rule Thresholds
                    </div>
                    <div className="space-y-2">
                        {rules.length === 0 ? (
                            <div className="text-gray-600 text-xs">No rules configured</div>
                        ) : (
                            rules.map((rule) => (
                                <div
                                    key={rule.rule_id}
                                    className="flex items-center justify-between py-2 border-b border-gray-800/40 last:border-0"
                                >
                                    <div className="flex items-center gap-2">
                                        <span
                                            className={`w-1.5 h-1.5 rounded-full ${rule.is_active ? 'bg-emerald-500' : 'bg-gray-600'}`}
                                        />
                                        <span className="text-xs text-gray-300">
                                            {RULE_LABELS[rule.rule_type] || rule.rule_type}
                                        </span>
                                    </div>
                                    <div className="text-[10px] text-gray-500 font-mono">
                                        {rule.threshold_value &&
                                            `₹${rule.threshold_value.toLocaleString('en-IN')}`}
                                        {rule.threshold_days && `${rule.threshold_days}d`}
                                        {!rule.threshold_value && !rule.threshold_days && 'Auto'}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}

            {/* Alert Events */}
            {loading ? (
                <div className="text-center text-gray-600 text-sm py-12 animate-pulse">
                    Loading alerts...
                </div>
            ) : alerts.length === 0 ? (
                <div className="text-center py-16">
                    <div className="text-4xl mb-3">🟢</div>
                    <div className="text-gray-400 text-sm font-medium">No active alerts</div>
                    <div className="text-gray-600 text-xs mt-1">
                        CashSentinel is watching — runs every hour
                    </div>
                </div>
            ) : (
                <div className="space-y-3">
                    {alerts.map((alert) => {
                        const s = severityStyle(alert.severity);
                        return (
                            <div
                                key={alert.event_id}
                                className={`border rounded-xl p-4 transition-all ${s.card}`}
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex items-start gap-3 flex-1">
                                        <div className="mt-0.5">
                                            <span
                                                className={`w-2 h-2 rounded-full ${s.dot} inline-block`}
                                            />
                                        </div>
                                        <div className="flex-1">
                                            <div className="flex items-center gap-2 mb-0.5">
                                                <span
                                                    className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${s.badge}`}
                                                >
                                                    {alert.severity}
                                                </span>
                                                <span className="text-[10px] text-gray-600">
                                                    {timeAgo(alert.triggered_at)}
                                                </span>
                                            </div>
                                            <div className="text-xs text-gray-200 font-semibold">
                                                {alert.title}
                                            </div>
                                            <div className="text-[11px] text-gray-400 mt-1 leading-relaxed">
                                                {alert.message}
                                            </div>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => onMarkRead(alert.event_id)}
                                        className="text-[9px] text-gray-600 hover:text-gray-400 border border-gray-700/50 px-2 py-1 rounded-md shrink-0 transition-colors"
                                    >
                                        Dismiss
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
