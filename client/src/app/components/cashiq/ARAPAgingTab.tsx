'use client';

import { useState, useEffect, useCallback } from 'react';

interface Props {
    businessId: string;
    apiKey?: string;
}

interface AgingRow {
    id: string;
    party: string;
    description: string;
    amount: number;
    currency: string;
    invoiceDate: Date;
    dueDate: Date | null;
    daysOutstanding: number;
    bucket: '0-30' | '31-60' | '61-90' | '90+';
    status: string;
    is43BRisk: boolean;
    type: 'AR' | 'AP';
}

function fmtLakh(n: number): string {
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 10000000) return `${sign}₹${(abs / 10000000).toFixed(1)}Cr`;
    if (abs >= 100000)   return `${sign}₹${(abs / 100000).toFixed(1)}L`;
    if (abs >= 1000)     return `${sign}₹${(abs / 1000).toFixed(0)}K`;
    return `${sign}₹${abs.toFixed(0)}`;
}

function bucketOf(days: number): AgingRow['bucket'] {
    if (days <= 30) return '0-30';
    if (days <= 60) return '31-60';
    if (days <= 90) return '61-90';
    return '90+';
}

function bucketColor(b: AgingRow['bucket']) {
    if (b === '0-30') return { text: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-700/30' };
    if (b === '31-60') return { text: 'text-amber-400', bg: 'bg-amber-500/15', border: 'border-amber-700/30' };
    if (b === '61-90') return { text: 'text-orange-400', bg: 'bg-orange-500/15', border: 'border-orange-700/30' };
    return { text: 'text-red-400', bg: 'bg-red-500/15', border: 'border-red-700/30' };
}

const BUCKET_ORDER: AgingRow['bucket'][] = ['0-30', '31-60', '61-90', '90+'];

interface InvoiceItem {
    invoice_id?: string;
    state: string;
    created_at?: string;
    total_amount?: string | number;
    direction?: string;
    source_type?: string;
    seller_name?: string;
    buyer_name?: string;
    currency?: string;
    [key: string]: unknown;
}

interface ObligationItem {
    id?: string;
    obligation_id?: string;
    status?: string;
    due_date?: string;
    created_at?: string;
    amount?: number;
    type?: string;
    obligation_type?: string;
    source?: string;
    description?: string;
    currency?: string;
    [key: string]: unknown;
}

export default function ARAPAgingTab({ businessId, apiKey }: Props) {
    const [now] = useState(() => Date.now());
    const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
    const [obligations, setObligations] = useState<ObligationItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [view, setView] = useState<'AR' | 'AP' | 'ALL'>('ALL');
    const [sortBy, setSortBy] = useState<'days' | 'amount'>('days');

    // Session-only reminder tracking: { [invoiceId]: 'WHATSAPP' | 'EMAIL' | 'SENDING' }
    const [reminderSent, setReminderSent] = useState<Record<string, string>>({});
    const [reminderToast, setReminderToast] = useState<string | null>(null);

    const sendReminder = useCallback(async (row: AgingRow, channel: 'WHATSAPP' | 'EMAIL') => {
        setReminderSent(prev => ({ ...prev, [row.id]: 'SENDING' }));
        try {
            const res = await fetch(`/api/cashiq/${businessId}/ar-reminder`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    invoiceId: row.id,
                    party: row.party,
                    amount: row.amount,
                    daysOutstanding: row.daysOutstanding,
                    channel,
                }),
            });
            const data = await res.json();
            if (data.success) {
                setReminderSent(prev => ({ ...prev, [row.id]: channel }));
                setReminderToast(`${channel === 'WHATSAPP' ? '📱 WhatsApp' : '📧 Email'} reminder sent to ${row.party}`);
            } else {
                setReminderSent(prev => { const n = { ...prev }; delete n[row.id]; return n; });
                setReminderToast(`❌ Failed: ${data.error}`);
            }
        } catch {
            setReminderSent(prev => { const n = { ...prev }; delete n[row.id]; return n; });
            setReminderToast('❌ Network error. Please try again.');
        }
        setTimeout(() => setReminderToast(null), 4000);
    }, [businessId]);

    useEffect(() => {
        if (!businessId) return;
        let ignore = false;
        Promise.all([
            fetch(`/api/invoice/list?limit=200`).then(r => r.json()),
            fetch(`/api/cashiq/${businessId}/obligations`).then(r => r.json()),
        ])
        .then(([invData, obData]) => {
            if (!ignore) {
                setInvoices(invData.data || []);
                setObligations(obData.obligations || []);
            }
        })
        .catch(console.error)
        .finally(() => {
            if (!ignore) setLoading(false);
        });
        return () => {
            ignore = true;
        };
    }, [businessId]);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="flex flex-col items-center gap-3">
                    <div className="animate-spin rounded-full h-8 w-8 border-2 border-indigo-500 border-t-transparent" />
                    <div className="text-gray-500 text-xs font-mono animate-pulse">Loading AR/AP aging data...</div>
                </div>
            </div>
        );
    }

    // Build aging rows from invoices
    // AR = money owed TO the business (outgoing invoices / receivables)
    // AP = money the business OWES (incoming bills / payables)
    // Classification: use source_type if available, otherwise:
    //   - If invoice.seller_name matches our business → we issued it → AR (receivable)
    //   - If invoice.buyer_name matches our business → we are being billed → AP (payable)
    //   - Fallback: treat as AR (most invoices in system are issued by the business)
    const rows: AgingRow[] = invoices
        .filter(inv => !['SETTLED', 'PAID'].includes(inv.state))
        .map((inv, idx) => {
            const created   = new Date(inv.created_at || now);
            const daysOut   = Math.floor((now - created.getTime()) / 86400000);
            const amount    = parseFloat(String(inv.total_amount)) || 0;

            // Determine AR vs AP:
            // 1. Use explicit direction field if present on invoice
            // 2. Check if source_type indicates payable (e.g. 'zoho_bill')
            // 3. Heuristic: zoho-sourced invoices where buyer is set = AR (we issued the invoice)
            let type: 'AR' | 'AP';
            if (inv.direction === 'AP' || inv.source_type === 'bill' || inv.source_type === 'vendor_bill') {
                type = 'AP';
            } else if (inv.direction === 'AR') {
                type = 'AR';
            } else {
                // Default: if there is a buyer_name, we issued this invoice → AR
                // If only seller_name (we're the buyer), it's AP
                type = inv.seller_name && !inv.buyer_name ? 'AP' : 'AR';
            }

            return {
                id:              inv.invoice_id || `inv-${idx}`,
                party:           type === 'AR' ? (inv.buyer_name || 'Unknown Buyer') : (inv.seller_name || 'Unknown Seller'),
                description:     `Invoice ${inv.invoice_id}`,
                amount,
                currency:        inv.currency || 'INR',
                invoiceDate:     created,
                dueDate:         null,
                daysOutstanding: daysOut,
                bucket:          bucketOf(daysOut),
                status:          inv.state,
                is43BRisk:       type === 'AP' && daysOut > 45,
                type,
            };
        });

    // Add obligations as AP items (obligations are always money the business owes)
    obligations
        .filter(ob => ob.status !== 'PAID')
        .forEach((ob, idx) => {
            // For obligations, use due_date as the reference point for aging
            const dueDate   = ob.due_date ? new Date(ob.due_date) : null;
            const refDate   = new Date(ob.created_at || ob.due_date || now);
            const daysOut   = Math.floor((now - refDate.getTime()) / 86400000);
            const amount    = ob.amount || 0;

            // Classify: INVOICE_DUE obligations are AR (money owed to us)
            // VENDOR_PAYMENT, GST_PAYMENT, EMI, TDS etc. are AP (money we owe)
            const obType = (ob.type || ob.obligation_type || '').toUpperCase();
            const type: 'AR' | 'AP' = obType === 'INVOICE_DUE' ? 'AR' : 'AP';

            rows.push({
                id:              ob.id || ob.obligation_id || `ob-${idx}`,
                party:           type === 'AR' ? (ob.source || 'Customer') : (ob.source || 'Tax / Vendor'),
                description:     ob.description || '',
                amount,
                currency:        ob.currency || 'INR',
                invoiceDate:     refDate,
                dueDate,
                daysOutstanding: daysOut,
                bucket:          bucketOf(Math.max(0, daysOut)),
                status:          ob.status || '',
                is43BRisk:       type === 'AP' && obType === 'VENDOR_PAYMENT' && daysOut > 45,
                type,
            });
        });

    const filtered = rows.filter(r => view === 'ALL' || r.type === view);
    const sorted   = [...filtered].sort((a, b) =>
        sortBy === 'days' ? b.daysOutstanding - a.daysOutstanding : b.amount - a.amount
    );

    const arRows = rows.filter(r => r.type === 'AR');
    const apRows = rows.filter(r => r.type === 'AP');
    const totalAR     = arRows.reduce((s, r) => s + r.amount, 0);
    const totalAP     = apRows.reduce((s, r) => s + r.amount, 0);
    const overdueAR   = arRows.filter(r => r.bucket !== '0-30').reduce((s, r) => s + r.amount, 0);
    const risk43B     = apRows.filter(r => r.is43BRisk).length;

    // Bucket breakdown
    const bucketBreakdown = BUCKET_ORDER.map(b => ({
        bucket: b,
        ar:     arRows.filter(r => r.bucket === b).reduce((s, r) => s + r.amount, 0),
        ap:     apRows.filter(r => r.bucket === b).reduce((s, r) => s + r.amount, 0),
    }));

    return (
        <div className="space-y-5">
            {/* ─ HEADER ───────────────────────────────────────────── */}
            <div>
                <h2 className="text-sm font-semibold text-gray-200">AR / AP Aging Dashboard</h2>
                <p className="text-[10px] text-gray-600 mt-0.5">
                    Receivables owed to you (AR) and payables you owe vendors (AP) — with MSME Sec 43B compliance flags.
                </p>
            </div>

            {/* ─ KPI SUMMARY CARDS ────────────────────────────────── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-[#0F1318] border border-emerald-800/40 rounded-2xl p-4">
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Total Receivables (AR)</div>
                    <div className="text-xl font-bold text-emerald-400 font-mono">{fmtLakh(totalAR)}</div>
                    <div className="text-[10px] text-gray-600 mt-1">{arRows.length} open invoices</div>
                </div>
                <div className="bg-[#0F1318] border border-red-800/40 rounded-2xl p-4">
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Total Payables (AP)</div>
                    <div className="text-xl font-bold text-red-400 font-mono">{fmtLakh(totalAP)}</div>
                    <div className="text-[10px] text-gray-600 mt-1">{apRows.length} outstanding items</div>
                </div>
                <div className="bg-[#0F1318] border border-amber-800/40 rounded-2xl p-4">
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Overdue AR (&gt;30 days)</div>
                    <div className="text-xl font-bold text-amber-400 font-mono">{fmtLakh(overdueAR)}</div>
                    <div className="text-[10px] text-gray-600 mt-1">Follow up required</div>
                </div>
                <div className={`rounded-2xl p-4 border ${risk43B > 0 ? 'bg-red-950/20 border-red-700/50' : 'bg-[#0F1318] border-gray-800/60'}`}>
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Sec 43B Risk (AP &gt;45D)</div>
                    <div className={`text-xl font-bold font-mono ${risk43B > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                        {risk43B}
                    </div>
                    <div className="text-[10px] text-gray-600 mt-1">
                        {risk43B > 0 ? 'MSME payment overdue!' : 'All within 45 days'}
                    </div>
                </div>
            </div>

            {/* ─ BUCKET BREAKDOWN ──────────────────────────────────── */}
            <div className="bg-[#0F1318] border border-gray-800/60 rounded-2xl p-5">
                <h3 className="text-xs font-bold text-gray-200 uppercase tracking-widest mb-4">Aging Bucket Analysis</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {bucketBreakdown.map(({ bucket, ar, ap }) => {
                        const c = bucketColor(bucket);
                        const labels = { '0-30': 'Current', '31-60': 'Moderate', '61-90': 'Overdue', '90+': 'Critical' };
                        return (
                            <div key={bucket} className={`rounded-xl border p-3.5 ${c.bg} ${c.border}`}>
                                <div className={`text-[10px] font-bold uppercase tracking-wider ${c.text} mb-2`}>
                                    {bucket} Days — {labels[bucket]}
                                </div>
                                <div className="space-y-1">
                                    <div className="flex justify-between text-[9px]">
                                        <span className="text-gray-500">AR (Receive)</span>
                                        <span className={`font-mono font-bold ${c.text}`}>{fmtLakh(ar)}</span>
                                    </div>
                                    <div className="flex justify-between text-[9px]">
                                        <span className="text-gray-500">AP (Pay)</span>
                                        <span className="font-mono font-bold text-gray-300">{fmtLakh(ap)}</span>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* ─ DETAILED TABLE ────────────────────────────────────── */}
            <div className="bg-[#0F1318] border border-gray-800/60 rounded-2xl overflow-hidden">
                {/* Controls */}
                <div className="px-5 py-4 border-b border-gray-800/40 flex items-center justify-between gap-3">
                    <h3 className="text-xs font-bold text-gray-200 uppercase tracking-widest">Transaction Aging Detail</h3>
                    <div className="flex items-center gap-2">
                        {/* View toggle */}
                        <div className="flex border border-gray-800 bg-[#0a0d11] p-0.5 rounded-lg">
                            {(['ALL', 'AR', 'AP'] as const).map(v => (
                                <button
                                    key={v}
                                    onClick={() => setView(v)}
                                    className={`text-[9px] font-bold px-2.5 py-1 rounded transition-colors ${
                                        view === v ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-gray-300'
                                    }`}
                                >
                                    {v}
                                </button>
                            ))}
                        </div>
                        {/* Sort */}
                        <div className="flex border border-gray-800 bg-[#0a0d11] p-0.5 rounded-lg">
                            {(['days', 'amount'] as const).map(s => (
                                <button
                                    key={s}
                                    onClick={() => setSortBy(s)}
                                    className={`text-[9px] font-bold px-2.5 py-1 rounded transition-colors capitalize ${
                                        sortBy === s ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
                                    }`}
                                >
                                    Sort: {s}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {sorted.length === 0 ? (
                    <div className="flex flex-col items-center py-16 gap-3">
                        <div className="text-4xl opacity-30">📊</div>
                        <div className="text-gray-500 text-sm">No open items found</div>
                        <div className="text-gray-700 text-xs">All invoices are settled or no data available</div>
                    </div>
                ) : (
                    <>
                        <div className="grid grid-cols-12 text-[8px] text-gray-600 uppercase tracking-widest px-4 py-2 border-b border-gray-800 bg-[#0a0d11] font-bold">
                            <div className="col-span-1">Type</div>
                            <div className="col-span-2">Party</div>
                            <div className="col-span-2">Description</div>
                            <div className="col-span-1 text-right">Amount</div>
                            <div className="col-span-1 text-center">Days</div>
                            <div className="col-span-1 text-center">Bucket</div>
                            <div className="col-span-2 text-center">Flags</div>
                            <div className="col-span-2 text-center">Remind</div>
                        </div>

                        <div className="divide-y divide-gray-800/40 max-h-[420px] overflow-y-auto">
                            {sorted.map(row => {
                                const c = bucketColor(row.bucket);
                                const canRemind = row.type === 'AR' && row.bucket !== '0-30';
                                const sentStatus = reminderSent[row.id];
                                return (
                                    <div key={row.id} className="grid grid-cols-12 items-center px-4 py-3 hover:bg-white/[0.02] transition-colors text-xs">
                                        <div className="col-span-1">
                                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                                                row.type === 'AR'
                                                    ? 'bg-emerald-900/30 text-emerald-400 border border-emerald-700/30'
                                                    : 'bg-red-900/30 text-red-400 border border-red-700/30'
                                            }`}>
                                                {row.type}
                                            </span>
                                        </div>
                                        <div className="col-span-2 text-gray-300 font-medium truncate pr-2">{row.party || '—'}</div>
                                        <div className="col-span-2 text-gray-500 text-[10px] truncate pr-2">{row.description}</div>
                                        <div className="col-span-1 text-right font-mono text-gray-200 font-semibold text-[10px]">
                                            {fmtLakh(row.amount)}
                                        </div>
                                        <div className="col-span-1 text-center">
                                            <span className={`font-mono text-[10px] font-bold ${c.text}`}>{row.daysOutstanding}d</span>
                                        </div>
                                        <div className="col-span-1 text-center">
                                            <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded border ${c.text} ${c.bg} ${c.border}`}>
                                                {row.bucket}
                                            </span>
                                        </div>
                                        <div className="col-span-2 flex items-center justify-center gap-1.5 flex-wrap">
                                            {row.is43BRisk && (
                                                <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30 animate-pulse">
                                                    43B RISK
                                                </span>
                                            )}
                                            {row.bucket === '90+' && (
                                                <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 border border-orange-500/30">
                                                    CRITICAL
                                                </span>
                                            )}
                                        </div>
                                        {/* ── AR REMINDER BUTTONS ── */}
                                        <div className="col-span-2 flex items-center justify-center gap-1">
                                            {!canRemind ? (
                                                <span className="text-[8px] text-gray-700">—</span>
                                            ) : sentStatus === 'SENDING' ? (
                                                <span className="text-[8px] text-indigo-400 animate-pulse">Sending…</span>
                                            ) : sentStatus ? (
                                                <span className="text-[8px] font-bold text-emerald-400">
                                                    {sentStatus === 'WHATSAPP' ? '📱 Sent' : '📧 Sent'}
                                                </span>
                                            ) : (
                                                <>
                                                    <button
                                                        id={`whatsapp-remind-${row.id}`}
                                                        onClick={() => sendReminder(row, 'WHATSAPP')}
                                                        title="Send WhatsApp reminder"
                                                        className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-emerald-900/30 text-emerald-400 border border-emerald-700/40 hover:bg-emerald-800/40 transition-colors"
                                                    >
                                                        📱 WA
                                                    </button>
                                                    <button
                                                        id={`email-remind-${row.id}`}
                                                        onClick={() => sendReminder(row, 'EMAIL')}
                                                        title="Send Email reminder"
                                                        className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-indigo-900/30 text-indigo-400 border border-indigo-700/40 hover:bg-indigo-800/40 transition-colors"
                                                    >
                                                        📧 Mail
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        <div className="px-5 py-3 border-t border-gray-800/40 flex justify-between text-[10px] text-gray-600 bg-[#0a0d11]">
                            <span>Showing {sorted.length} items</span>
                            {risk43B > 0 && (
                                <span className="text-red-400 font-bold">
                                    ⚠ {risk43B} items breach MSME 43B 45-day payment rule
                                </span>
                            )}
                        </div>

                        {/* ── TOAST NOTIFICATION ── */}
                        {reminderToast && (
                            <div className="mx-4 mb-3 px-4 py-2.5 rounded-xl bg-indigo-900/40 border border-indigo-700/50 text-[11px] text-indigo-300 font-medium animate-pulse">
                                {reminderToast}
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* ─ 43B INFO ──────────────────────────────────────────── */}
            {risk43B > 0 && (
                <div className="bg-red-950/15 border border-red-700/40 rounded-2xl p-4 flex items-start gap-3">
                    <span className="text-2xl shrink-0">⚖️</span>
                    <div>
                        <h4 className="text-sm font-bold text-red-400">Section 43B — MSME Vendor Payment Compliance</h4>
                        <p className="text-[10px] text-gray-400 mt-1 leading-relaxed">
                            Under the MSMED Act 2006 and Section 43B(h) of the Income Tax Act (effective AY 2024-25), payments to MSME vendors 
                            must be made within <strong className="text-white">45 days</strong> (or contractual terms, whichever is earlier). 
                            Delayed payments are <strong className="text-red-300">disallowed as business expense</strong> and subject to interest at 3× bank rate.
                            You have <strong className="text-red-400">{risk43B} vendor payment(s)</strong> at risk.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
