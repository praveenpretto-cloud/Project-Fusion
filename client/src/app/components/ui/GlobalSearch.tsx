'use client';

import { useState, useEffect, useRef } from 'react';

interface SearchResult {
    id: string;
    type: 'instruction' | 'invoice' | 'alert' | 'obligation' | 'contact';
    title: string;
    subtitle: string;
    badge?: string;
    badgeColor?: string;
    amount?: string;
    onClick: () => void;
}

interface SearchInstruction {
    instruction_id: string;
    recipient_hash?: string;
    sender_hash?: string;
    amount?: string | number;
    currency?: string;
    state?: string;
}

interface SearchInvoice {
    invoice_id: string;
    buyer_name?: string;
    seller_name?: string;
    total_amount?: string | number;
    currency?: string;
    source_type?: string;
    state?: string;
}

interface SearchAlert {
    event_id: string;
    title?: string;
    message?: string;
    severity?: string;
}

interface SearchObligation {
    id?: string;
    obligation_id?: string;
    description?: string;
    obligation_type?: string;
    amount?: string | number;
    due_date?: string;
    currency?: string;
    status?: string;
}

interface SearchContact {
    id: string;
    name: string;
    type?: string;
    gstin?: string;
    pan?: string;
    email?: string;
    outstanding_balance?: number;
}

interface Props {
    instructions: SearchInstruction[];
    invoices: SearchInvoice[];
    alerts: SearchAlert[];
    obligations: SearchObligation[];
    contacts?: SearchContact[];
    onNavigate: (tab: string) => void;
    onSelectInstruction?: (inst: SearchInstruction) => void;
}

function fmtLakh(n: number): string {
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 10000000) return `${sign}₹${(abs / 10000000).toFixed(1)}Cr`;
    if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(1)}L`;
    if (abs >= 1000) return `${sign}₹${(abs / 1000).toFixed(0)}K`;
    return `${sign}₹${abs.toFixed(0)}`;
}

const TYPE_ICONS: Record<string, string> = {
    instruction: '⇄',
    invoice: '📄',
    alert: '🔔',
    obligation: '⏰',
    contact: '👤',
};

const TYPE_COLORS: Record<string, string> = {
    instruction: 'text-blue-400',
    invoice: 'text-indigo-400',
    alert: 'text-red-400',
    obligation: 'text-amber-400',
    contact: 'text-emerald-400',
};

export default function GlobalSearch({
    instructions,
    invoices,
    alerts,
    obligations,
    contacts = [],
    onNavigate,
    onSelectInstruction,
}: Props) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [cursor, setCursor] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    // Open on Cmd+K / Ctrl+K
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                setOpen((o) => !o);
                setQuery('');
                setCursor(0);
            }
            if (e.key === 'Escape') setOpen(false);
        }
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);

    useEffect(() => {
        if (open) setTimeout(() => inputRef.current?.focus(), 50);
    }, [open]);

    // Build result list
    const results: SearchResult[] = (() => {
        if (!query.trim()) return [];
        const q = query.toLowerCase();
        const out: SearchResult[] = [];

        // Instructions
        instructions.forEach((inst) => {
            const match =
                inst.instruction_id?.toLowerCase().includes(q) ||
                inst.recipient_hash?.toLowerCase().includes(q) ||
                inst.sender_hash?.toLowerCase().includes(q) ||
                String(inst.amount).includes(q) ||
                inst.currency?.toLowerCase().includes(q) ||
                inst.state?.toLowerCase().includes(q);
            if (match)
                out.push({
                    id: inst.instruction_id,
                    type: 'instruction',
                    title: `${inst.currency || ''} ${parseFloat(String(inst.amount || 0)).toFixed(2)} → ${inst.recipient_hash || 'Unknown'}`,
                    subtitle: `ID: ${(inst.instruction_id || '').slice(0, 12)}...`,
                    badge: inst.state,
                    badgeColor:
                        inst.state === 'SETTLED'
                            ? 'text-emerald-400'
                            : inst.state === 'FAILED'
                              ? 'text-red-400'
                              : 'text-amber-400',
                    amount:
                        inst.currency === 'INR'
                            ? fmtLakh(parseFloat(String(inst.amount || 0)))
                            : `${inst.currency || ''} ${parseFloat(String(inst.amount || 0)).toFixed(2)}`,
                    onClick: () => {
                        onNavigate('instructions');
                        onSelectInstruction?.(inst);
                        setOpen(false);
                    },
                });
        });

        // Invoices
        invoices.forEach((inv) => {
            const match =
                inv.invoice_id?.toLowerCase().includes(q) ||
                inv.buyer_name?.toLowerCase().includes(q) ||
                inv.seller_name?.toLowerCase().includes(q) ||
                String(inv.total_amount).includes(q);
            if (match)
                out.push({
                    id: inv.invoice_id,
                    type: 'invoice',
                    title: `${inv.buyer_name || inv.seller_name || 'Invoice'} — ${inv.currency || ''} ${parseFloat(String(inv.total_amount || 0)).toFixed(2)}`,
                    subtitle: `Invoice ${inv.invoice_id?.slice(0, 12)}...  ·  ${inv.source_type || 'manual'}`,
                    badge: inv.state,
                    badgeColor:
                        inv.state === 'SETTLED'
                            ? 'text-emerald-400'
                            : inv.state === 'FAILED'
                              ? 'text-red-400'
                              : 'text-amber-400',
                    onClick: () => {
                        onNavigate('invoices');
                        setOpen(false);
                    },
                });
        });

        // Alerts
        alerts.forEach((al) => {
            const match =
                al.title?.toLowerCase().includes(q) || al.message?.toLowerCase().includes(q);
            if (match)
                out.push({
                    id: al.event_id,
                    type: 'alert',
                    title: al.title || 'Alert',
                    subtitle:
                        (al.message || '').slice(0, 80) +
                        ((al.message?.length || 0) > 80 ? '...' : ''),
                    badge: al.severity,
                    badgeColor:
                        al.severity === 'HIGH'
                            ? 'text-red-400'
                            : al.severity === 'MEDIUM'
                              ? 'text-amber-400'
                              : 'text-blue-400',
                    onClick: () => {
                        onNavigate('alerts');
                        setOpen(false);
                    },
                });
        });

        // Obligations
        obligations.forEach((ob) => {
            const match =
                ob.description?.toLowerCase().includes(q) ||
                ob.obligation_type?.toLowerCase().includes(q) ||
                String(ob.amount).includes(q);
            if (match)
                out.push({
                    id: ob.id || ob.obligation_id || 'ob',
                    type: 'obligation',
                    title: ob.description || ob.obligation_type || 'Obligation',
                    subtitle: `Due: ${ob.due_date ? new Date(ob.due_date).toLocaleDateString('en-IN') : 'N/A'} · ${ob.currency || 'INR'}`,
                    badge: ob.status,
                    badgeColor:
                        ob.status === 'OVERDUE'
                            ? 'text-red-400'
                            : ob.status === 'UPCOMING'
                              ? 'text-amber-400'
                              : 'text-gray-400',
                    amount: ob.amount ? fmtLakh(parseFloat(String(ob.amount))) : undefined,
                    onClick: () => {
                        onNavigate('obligations');
                        setOpen(false);
                    },
                });
        });

        // Contacts
        if (contacts) {
            contacts.forEach((c) => {
                const match =
                    c.name?.toLowerCase().includes(q) ||
                    c.gstin?.toLowerCase().includes(q) ||
                    c.pan?.toLowerCase().includes(q) ||
                    c.email?.toLowerCase().includes(q);
                if (match)
                    out.push({
                        id: c.id,
                        type: 'contact',
                        title: c.name,
                        subtitle: `${c.type || 'Contact'} · ${c.gstin || c.pan || c.email || 'No details'}`,
                        badge: c.type,
                        badgeColor: c.type === 'VENDOR' ? 'text-blue-400' : 'text-emerald-400',
                        amount:
                            c.outstanding_balance && c.outstanding_balance > 0
                                ? fmtLakh(c.outstanding_balance)
                                : undefined,
                        onClick: () => {
                            onNavigate('contacts');
                            setOpen(false);
                        },
                    });
            });
        }

        return out.slice(0, 12);
    })();

    // Keyboard navigation
    useEffect(() => {
        if (!open) return;
        function onKey(e: KeyboardEvent) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, results.length - 1));
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
            }
            if (e.key === 'Enter' && results[cursor]) {
                results[cursor].onClick();
            }
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, cursor, results]);

    // Scroll cursor into view
    useEffect(() => {
        const el = listRef.current?.children[cursor] as HTMLElement;
        el?.scrollIntoView({ block: 'nearest' });
    }, [cursor]);

    if (!open) {
        return (
            <button
                onClick={() => {
                    setOpen(true);
                    setQuery('');
                    setCursor(0);
                }}
                className="flex items-center gap-2 bg-[#0F1318] border border-gray-800 rounded-lg px-3 py-1.5 text-xs text-gray-500 hover:border-gray-600 hover:text-gray-400 transition-colors cursor-pointer"
                title="Global Search (⌘K)"
            >
                <span>🔍</span>
                <span>Search</span>
                <span className="hidden md:flex items-center gap-0.5 ml-1">
                    <kbd className="text-[9px] bg-gray-800 border border-gray-700 rounded px-1 py-0.5 font-mono">
                        ⌘
                    </kbd>
                    <kbd className="text-[9px] bg-gray-800 border border-gray-700 rounded px-1 py-0.5 font-mono">
                        K
                    </kbd>
                </span>
            </button>
        );
    }

    return (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-xl bg-[#0F1318] border border-gray-700/70 rounded-2xl shadow-2xl overflow-hidden">
                {/* Input */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
                    <span className="text-gray-500 text-base">🔍</span>
                    <input
                        ref={inputRef}
                        type="text"
                        placeholder="Search transactions, invoices, alerts, vendors..."
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setCursor(0);
                        }}
                        className="flex-1 bg-transparent text-sm text-gray-200 placeholder-gray-600 focus:outline-none"
                    />
                    <kbd
                        className="text-[10px] text-gray-600 bg-gray-800/60 border border-gray-700 rounded px-1.5 py-0.5 font-mono cursor-pointer"
                        onClick={() => setOpen(false)}
                    >
                        ESC
                    </kbd>
                </div>

                {/* Results */}
                <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
                    {!query.trim() ? (
                        <div className="px-4 py-6 text-center text-xs text-gray-600">
                            Type to search across all transactions, invoices, alerts, obligations
                            and contacts
                        </div>
                    ) : results.length === 0 ? (
                        <div className="px-4 py-6 text-center text-xs text-gray-600">
                            No results found for &quot;{query}&quot;
                        </div>
                    ) : (
                        results.map((r, i) => (
                            <div
                                key={`${r.type}-${r.id}`}
                                onClick={r.onClick}
                                onMouseEnter={() => setCursor(i)}
                                className={`flex items-start gap-3 px-4 py-2.5 cursor-pointer transition-colors ${cursor === i ? 'bg-blue-600/20' : 'hover:bg-white/3'}`}
                            >
                                <span
                                    className={`mt-0.5 text-sm w-5 text-center ${TYPE_COLORS[r.type]}`}
                                >
                                    {TYPE_ICONS[r.type]}
                                </span>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-gray-200 font-medium truncate">
                                            {r.title}
                                        </span>
                                        {r.badge && (
                                            <span
                                                className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-white/5 border border-white/10 ${r.badgeColor}`}
                                            >
                                                {r.badge}
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-[10px] text-gray-600 truncate mt-0.5">
                                        {r.subtitle}
                                    </div>
                                </div>
                                {r.amount && (
                                    <span className="text-xs font-mono text-gray-400 font-bold shrink-0">
                                        {r.amount}
                                    </span>
                                )}
                            </div>
                        ))
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-4 py-2 border-t border-gray-800/60 text-[10px] text-gray-600">
                    <span>{results.length > 0 ? `${results.length} results` : 'No results'}</span>
                    <span className="flex items-center gap-2">
                        <span>↑↓ navigate</span>
                        <span>↵ select</span>
                        <span>ESC close</span>
                    </span>
                </div>
            </div>
        </div>
    );
}
