'use client';

import { useState, useEffect, useCallback } from 'react';

interface Contact {
    id: string;
    name: string;
    type: 'VENDOR' | 'CUSTOMER';
    gstin?: string;
    pan?: string;
    email?: string;
    phone?: string;
    bank_name?: string;
    ifsc?: string;
    account_number?: string;
    outstanding_balance: number;
    total_paid: number;
    last_txn_date?: string;
    payment_terms_days: number;
    notes?: string;
    created_at: string;
}

interface Props {
    businessId: string;
    apiKey?: string;
}

function fmtLakh(n: number): string {
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 10000000) return `${sign}₹${(abs / 10000000).toFixed(1)}Cr`;
    if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(1)}L`;
    if (abs >= 1000) return `${sign}₹${(abs / 1000).toFixed(0)}K`;
    return `${sign}₹${abs.toFixed(0)}`;
}

const EMPTY_FORM = {
    name: '',
    type: 'VENDOR' as 'VENDOR' | 'CUSTOMER',
    gstin: '',
    pan: '',
    email: '',
    phone: '',
    bank_name: '',
    ifsc: '',
    account_number: '',
    payment_terms_days: 30,
    notes: '',
};

export default function VendorDirectoryTab({ businessId, apiKey }: Props) {
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [filterType, setFilterType] = useState<'ALL' | 'VENDOR' | 'CUSTOMER'>('ALL');
    const [showForm, setShowForm] = useState(false);
    const [editContact, setEditContact] = useState<Contact | null>(null);
    const [form, setForm] = useState({ ...EMPTY_FORM });
    const [saving, setSaving] = useState(false);
    const [saveMsg, setSaveMsg] = useState('');

    const headers = { 'Content-Type': 'application/json' };

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const r = await fetch(`/api/cashiq/${businessId}/contacts`, {
                headers: { 'Content-Type': 'application/json' },
            });
            const d = await r.json();
            setContacts(d.contacts || []);
        } catch {
            /* fail silently */
        } finally {
            setLoading(false);
        }
    }, [businessId]);

    useEffect(() => {
        if (businessId) load();
    }, [businessId, load]);

    function openNew() {
        setEditContact(null);
        setForm({ ...EMPTY_FORM });
        setShowForm(true);
        setSaveMsg('');
    }

    function openEdit(c: Contact) {
        setEditContact(c);
        setForm({
            name: c.name,
            type: c.type,
            gstin: c.gstin || '',
            pan: c.pan || '',
            email: c.email || '',
            phone: c.phone || '',
            bank_name: c.bank_name || '',
            ifsc: c.ifsc || '',
            account_number: c.account_number || '',
            payment_terms_days: c.payment_terms_days || 30,
            notes: c.notes || '',
        });
        setShowForm(true);
        setSaveMsg('');
    }

    async function handleSave() {
        if (!form.name.trim()) {
            setSaveMsg('Name is required');
            return;
        }
        setSaving(true);
        try {
            const url = editContact
                ? `/api/cashiq/${businessId}/contacts/${editContact.id}`
                : `/api/cashiq/${businessId}/contacts`;
            const method = editContact ? 'PUT' : 'POST';
            const r = await fetch(url, {
                method,
                headers,
                body: JSON.stringify({ ...form, business_id: businessId }),
            });
            const d = await r.json();
            if (!d.success) throw new Error(d.error || 'Save failed');
            setSaveMsg('Saved ✓');
            setShowForm(false);
            load();
        } catch (e: unknown) {
            setSaveMsg((e as Error).message);
        } finally {
            setSaving(false);
        }
    }

    async function handleDelete(id: string) {
        if (!confirm('Delete this contact?')) return;
        await fetch(`/api/cashiq/${businessId}/contacts/${id}`, { method: 'DELETE', headers });
        load();
    }

    const filtered = contacts.filter((c) => {
        const matchType = filterType === 'ALL' || c.type === filterType;
        const q = search.toLowerCase();
        const matchSearch =
            !q ||
            c.name.toLowerCase().includes(q) ||
            (c.gstin || '').toLowerCase().includes(q) ||
            (c.pan || '').toLowerCase().includes(q) ||
            (c.email || '').toLowerCase().includes(q);
        return matchType && matchSearch;
    });

    const totalVendors = contacts.filter((c) => c.type === 'VENDOR').length;
    const totalCustomers = contacts.filter((c) => c.type === 'CUSTOMER').length;
    const totalOutstandingAP = contacts
        .filter((c) => c.type === 'VENDOR')
        .reduce((s, c) => s + c.outstanding_balance, 0);
    const totalOutstandingAR = contacts
        .filter((c) => c.type === 'CUSTOMER')
        .reduce((s, c) => s + c.outstanding_balance, 0);

    return (
        <div className="space-y-5">
            {/* ─ HEADER ──────────────────────────────── */}
            <div className="flex items-start justify-between">
                <div>
                    <h2 className="text-sm font-semibold text-gray-200">
                        Vendor & Customer Directory
                    </h2>
                    <p className="text-xs text-gray-500 mt-0.5">
                        Master list of vendors and customers with payment history and outstanding
                        balances
                    </p>
                </div>
                <button
                    onClick={openNew}
                    className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg font-semibold transition-colors flex items-center gap-1.5"
                >
                    <span>+</span> Add Contact
                </button>
            </div>

            {/* ─ KPI SUMMARY ─────────────────────────── */}
            <div className="grid grid-cols-4 gap-3">
                {[
                    {
                        label: 'Total Vendors',
                        value: totalVendors,
                        sub: 'in directory',
                        color: 'text-blue-400',
                        bg: 'bg-blue-500/10',
                        border: 'border-blue-800/40',
                    },
                    {
                        label: 'Total Customers',
                        value: totalCustomers,
                        sub: 'in directory',
                        color: 'text-emerald-400',
                        bg: 'bg-emerald-500/10',
                        border: 'border-emerald-800/40',
                    },
                    {
                        label: 'AP Outstanding',
                        value: fmtLakh(totalOutstandingAP),
                        sub: 'owed to vendors',
                        color: 'text-red-400',
                        bg: 'bg-red-500/10',
                        border: 'border-red-800/40',
                    },
                    {
                        label: 'AR Outstanding',
                        value: fmtLakh(totalOutstandingAR),
                        sub: 'owed by customers',
                        color: 'text-amber-400',
                        bg: 'bg-amber-500/10',
                        border: 'border-amber-800/40',
                    },
                ].map((k) => (
                    <div key={k.label} className={`${k.bg} border ${k.border} rounded-xl p-4`}>
                        <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">
                            {k.label}
                        </div>
                        <div className={`text-xl font-bold ${k.color} font-mono`}>{k.value}</div>
                        <div className="text-[10px] text-gray-600 mt-0.5">{k.sub}</div>
                    </div>
                ))}
            </div>

            {/* ─ SEARCH + FILTER ─────────────────────── */}
            <div className="flex items-center gap-3">
                <div className="relative flex-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-xs">
                        🔍
                    </span>
                    <input
                        type="text"
                        placeholder="Search by name, GSTIN, PAN or email..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full pl-8 pr-4 py-2 bg-[#0F1318] border border-gray-800 rounded-lg text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-blue-700"
                    />
                </div>
                <div className="flex gap-1 bg-[#0F1318] border border-gray-800 rounded-lg p-1">
                    {(['ALL', 'VENDOR', 'CUSTOMER'] as const).map((t) => (
                        <button
                            key={t}
                            onClick={() => setFilterType(t)}
                            className={`text-[11px] font-medium px-3 py-1 rounded-md transition-colors ${filterType === t ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-gray-300'}`}
                        >
                            {t === 'ALL' ? 'All' : t === 'VENDOR' ? '🏪 Vendors' : '👤 Customers'}
                        </button>
                    ))}
                </div>
            </div>

            {/* ─ TABLE ─────────────────────────────────── */}
            {loading ? (
                <div className="flex items-center justify-center h-40">
                    <div className="animate-spin rounded-full h-7 w-7 border-2 border-blue-500 border-t-transparent" />
                </div>
            ) : filtered.length === 0 ? (
                <div className="text-center py-16 text-gray-600">
                    <div className="text-4xl mb-3 opacity-30">📋</div>
                    <div className="text-sm">
                        {contacts.length === 0
                            ? 'No contacts yet. Add your first vendor or customer.'
                            : 'No contacts match your search.'}
                    </div>
                </div>
            ) : (
                <div className="bg-[#0F1318] border border-gray-800/60 rounded-xl overflow-hidden">
                    {/* Table header */}
                    <div className="grid grid-cols-12 text-[10px] font-bold uppercase tracking-widest text-gray-600 border-b border-gray-800/60 px-4 py-2.5">
                        <div className="col-span-3">Name / Type</div>
                        <div className="col-span-2">GSTIN / PAN</div>
                        <div className="col-span-2 text-right">Outstanding</div>
                        <div className="col-span-2 text-right">Total Paid</div>
                        <div className="col-span-2">Last Transaction</div>
                        <div className="col-span-1 text-right">Actions</div>
                    </div>
                    <div className="divide-y divide-gray-800/40 max-h-[520px] overflow-y-auto">
                        {filtered.map((c) => {
                            const isVendor = c.type === 'VENDOR';
                            const hasRisk =
                                isVendor &&
                                c.outstanding_balance > 0 &&
                                c.last_txn_date &&
                                Math.floor(
                                    (Date.now() - new Date(c.last_txn_date).getTime()) / 86400000
                                ) > 45;
                            return (
                                <div
                                    key={c.id}
                                    className="grid grid-cols-12 items-center px-4 py-3 hover:bg-white/[0.02] transition-colors text-xs"
                                >
                                    <div className="col-span-3">
                                        <div className="flex items-center gap-2">
                                            <span
                                                className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold ${isVendor ? 'bg-blue-900/50 text-blue-400' : 'bg-emerald-900/50 text-emerald-400'}`}
                                            >
                                                {isVendor ? 'V' : 'C'}
                                            </span>
                                            <div>
                                                <div className="text-gray-200 font-medium">
                                                    {c.name}
                                                </div>
                                                <div
                                                    className={`text-[9px] font-bold mt-0.5 ${isVendor ? 'text-blue-500' : 'text-emerald-500'}`}
                                                >
                                                    {c.type}
                                                    {hasRisk && (
                                                        <span className="ml-1.5 text-red-400 font-bold">
                                                            ⚠ 43B RISK
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="col-span-2 text-gray-500 font-mono text-[10px]">
                                        {c.gstin ? (
                                            <div className="text-amber-500/80">{c.gstin}</div>
                                        ) : null}
                                        {c.pan ? (
                                            <div className="text-gray-600">{c.pan}</div>
                                        ) : (
                                            <div className="text-gray-700 italic">No PAN</div>
                                        )}
                                    </div>
                                    <div className="col-span-2 text-right">
                                        {c.outstanding_balance > 0 ? (
                                            <span
                                                className={`font-bold font-mono ${isVendor ? 'text-red-400' : 'text-amber-400'}`}
                                            >
                                                {fmtLakh(c.outstanding_balance)}
                                            </span>
                                        ) : (
                                            <span className="text-emerald-500 font-mono">₹0</span>
                                        )}
                                    </div>
                                    <div className="col-span-2 text-right text-gray-400 font-mono">
                                        {fmtLakh(c.total_paid)}
                                    </div>
                                    <div className="col-span-2 text-gray-500 text-[10px]">
                                        {c.last_txn_date ? (
                                            new Date(c.last_txn_date).toLocaleDateString('en-IN', {
                                                day: '2-digit',
                                                month: 'short',
                                                year: 'numeric',
                                            })
                                        ) : (
                                            <span className="text-gray-700 italic">Never</span>
                                        )}
                                        {c.payment_terms_days && (
                                            <div className="text-[9px] text-gray-700">
                                                Net {c.payment_terms_days}D terms
                                            </div>
                                        )}
                                    </div>
                                    <div className="col-span-1 flex justify-end gap-1.5">
                                        <button
                                            onClick={() => openEdit(c)}
                                            className="text-[10px] text-blue-400 hover:text-blue-300 px-1.5 py-0.5 rounded hover:bg-blue-900/20 transition-colors"
                                            title="Edit"
                                        >
                                            ✏️
                                        </button>
                                        <button
                                            onClick={() => handleDelete(c.id)}
                                            className="text-[10px] text-red-500/60 hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-red-900/20 transition-colors"
                                            title="Delete"
                                        >
                                            🗑
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* ─ ADD/EDIT MODAL ───────────────────────── */}
            {showForm && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
                    <div className="bg-[#0F1318] border border-gray-700/60 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl">
                        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-800">
                            <h3 className="text-sm font-bold text-white">
                                {editContact ? 'Edit Contact' : 'Add New Contact'}
                            </h3>
                            <button
                                onClick={() => setShowForm(false)}
                                className="text-gray-500 hover:text-gray-300 text-lg"
                            >
                                ✕
                            </button>
                        </div>
                        <div className="px-6 py-5 space-y-4">
                            {/* Type selector */}
                            <div className="flex gap-2">
                                {(['VENDOR', 'CUSTOMER'] as const).map((t) => (
                                    <button
                                        key={t}
                                        onClick={() => setForm((f) => ({ ...f, type: t }))}
                                        className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-colors ${form.type === t ? (t === 'VENDOR' ? 'bg-blue-600 border-blue-500 text-white' : 'bg-emerald-600 border-emerald-500 text-white') : 'bg-transparent border-gray-800 text-gray-500 hover:border-gray-600'}`}
                                    >
                                        {t === 'VENDOR' ? '🏪 Vendor' : '👤 Customer'}
                                    </button>
                                ))}
                            </div>

                            {/* Fields */}
                            {[
                                {
                                    key: 'name',
                                    label: 'Name *',
                                    placeholder: 'e.g. Ravi Traders Pvt Ltd',
                                },
                                { key: 'gstin', label: 'GSTIN', placeholder: '29ABCDE1234F1Z5' },
                                { key: 'pan', label: 'PAN', placeholder: 'ABCDE1234F' },
                                {
                                    key: 'email',
                                    label: 'Email',
                                    placeholder: 'billing@company.com',
                                },
                                { key: 'phone', label: 'Phone', placeholder: '+91 9876543210' },
                                { key: 'bank_name', label: 'Bank Name', placeholder: 'HDFC Bank' },
                                { key: 'ifsc', label: 'IFSC Code', placeholder: 'HDFC0000123' },
                                {
                                    key: 'account_number',
                                    label: 'Account Number',
                                    placeholder: '1234567890',
                                },
                                {
                                    key: 'notes',
                                    label: 'Notes',
                                    placeholder: 'Any special terms or notes...',
                                },
                            ].map((f) => (
                                <div key={f.key}>
                                    <label className="block text-[10px] text-gray-500 uppercase tracking-widest mb-1">
                                        {f.label}
                                    </label>
                                    {f.key === 'notes' ? (
                                        <textarea
                                            value={(form as Record<string, string | number>)[f.key]}
                                            onChange={(e) =>
                                                setForm((prev) => ({
                                                    ...prev,
                                                    [f.key]: e.target.value,
                                                }))
                                            }
                                            placeholder={f.placeholder}
                                            rows={2}
                                            className="w-full bg-[#161B22] border border-gray-800 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-700 focus:outline-none focus:border-blue-700 resize-none"
                                        />
                                    ) : (
                                        <input
                                            type="text"
                                            value={(form as Record<string, string | number>)[f.key]}
                                            onChange={(e) =>
                                                setForm((prev) => ({
                                                    ...prev,
                                                    [f.key]: e.target.value,
                                                }))
                                            }
                                            placeholder={f.placeholder}
                                            className="w-full bg-[#161B22] border border-gray-800 rounded-lg px-3 py-2 text-xs text-gray-300 placeholder-gray-700 focus:outline-none focus:border-blue-700"
                                        />
                                    )}
                                </div>
                            ))}

                            <div>
                                <label className="block text-[10px] text-gray-500 uppercase tracking-widest mb-1">
                                    Payment Terms (Days)
                                </label>
                                <select
                                    value={form.payment_terms_days}
                                    onChange={(e) =>
                                        setForm((f) => ({
                                            ...f,
                                            payment_terms_days: parseInt(e.target.value),
                                        }))
                                    }
                                    className="w-full bg-[#161B22] border border-gray-800 rounded-lg px-3 py-2 text-xs text-gray-300 focus:outline-none focus:border-blue-700"
                                >
                                    {[7, 15, 30, 45, 60, 90].map((d) => (
                                        <option key={d} value={d}>
                                            Net {d} Days{d === 45 ? ' (Sec 43B limit)' : ''}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {saveMsg && (
                                <div
                                    className={`text-xs px-3 py-2 rounded-lg ${saveMsg.includes('✓') ? 'bg-emerald-900/30 text-emerald-400 border border-emerald-800' : 'bg-red-900/30 text-red-400 border border-red-800'}`}
                                >
                                    {saveMsg}
                                </div>
                            )}

                            <div className="flex gap-3 pt-2">
                                <button
                                    onClick={() => setShowForm(false)}
                                    className="flex-1 py-2 rounded-lg text-xs border border-gray-700 text-gray-400 hover:border-gray-500 transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="flex-1 py-2 rounded-lg text-xs bg-blue-600 hover:bg-blue-500 text-white font-bold transition-colors disabled:opacity-50"
                                >
                                    {saving
                                        ? 'Saving...'
                                        : editContact
                                          ? 'Update Contact'
                                          : 'Add Contact'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
