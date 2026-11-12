'use client';

import { useState, useRef } from 'react';

export interface Account {
    account_id: string;
    bank_name: string;
    account_type: string;
    account_number_masked: string;
    data_source: string;
    is_active: boolean;
    last_synced_at: string | null;
    balance: number;
    od_limit?: number;
}

interface Props {
    businessId: string;
    accounts: Account[];
    loading: boolean;
    apiKey?: string;
    onRefresh: () => void;
}

const BANK_COLORS: Record<string, string> = {
    'HDFC Bank': 'from-blue-900/30 to-blue-950/20 border-blue-800/30',
    'ICICI Bank': 'from-orange-900/20 to-orange-950/10 border-orange-800/20',
    SBI: 'from-indigo-900/30 to-indigo-950/20 border-indigo-800/30',
    'Axis Bank': 'from-purple-900/20 to-purple-950/10 border-purple-800/20',
    Kotak: 'from-red-900/20 to-red-950/10 border-red-800/20',
};

const BANK_INITIALS: Record<string, string> = {
    'HDFC Bank': 'HD',
    'ICICI Bank': 'IC',
    SBI: 'SB',
    'Axis Bank': 'AX',
    Kotak: 'KO',
};

function fmt(n: number) {
    return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
}

function BankLogo({ bankName }: { bankName: string }) {
    const initials = BANK_INITIALS[bankName] || bankName.slice(0, 2).toUpperCase();
    return (
        <div className="w-10 h-10 rounded-xl bg-gray-800 border border-gray-700/50 flex items-center justify-center">
            <span className="text-xs font-black text-gray-300">{initials}</span>
        </div>
    );
}

function SourceBadge({ source }: { source: string }) {
    if (source === 'AA_CONSENT') {
        return (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
                AA CONNECTED
            </span>
        );
    }
    return (
        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/40">
            MANUAL IMPORT
        </span>
    );
}

function UploadModal({
    account,
    businessId,
    apiKey,
    onClose,
    onSuccess,
}: {
    account: Account;
    businessId: string;
    apiKey?: string;
    onClose: () => void;
    onSuccess: (result: { imported: number }) => void;
}) {
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState('');
    const fileRef = useRef<HTMLInputElement>(null);

    async function handleUpload() {
        const file = fileRef.current?.files?.[0];
        if (!file) {
            setError('Please select a CSV file');
            return;
        }

        setUploading(true);
        setError('');
        try {
            const formData = new FormData();
            formData.append('statement', file);

            const res = await fetch(
                `/api/cashiq/${businessId}/accounts/${account.account_id}/import-statement`,
                { method: 'POST', body: formData }
            );
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Upload failed');
            onSuccess({ imported: data.imported });
            onClose();
        } catch (e: unknown) {
            setError((e as Error).message);
        } finally {
            setUploading(false);
        }
    }

    return (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="bg-[#0F1318] border border-gray-700/50 rounded-2xl p-6 w-[420px] shadow-2xl">
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h3 className="text-sm font-semibold text-gray-200">
                            Upload Bank Statement
                        </h3>
                        <p className="text-[10px] text-gray-500 mt-0.5">
                            {account.bank_name} · {account.account_number_masked}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-gray-600 hover:text-gray-400 text-lg leading-none"
                    >
                        ×
                    </button>
                </div>

                <div className="bg-[#0a0d11] border border-dashed border-gray-700/60 rounded-xl p-5 text-center mb-4">
                    <div className="text-2xl mb-2">📄</div>
                    <div className="text-xs text-gray-400 mb-3">
                        Upload a CSV bank statement export
                    </div>
                    <div className="text-[10px] text-gray-600 mb-3">
                        Supported formats: HDFC, ICICI, SBI, Axis, Kotak
                        <br />
                        Columns: Date, Narration, Debit, Credit, Balance
                    </div>
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".csv"
                        className="text-xs text-gray-400 file:mr-3 file:text-[10px] file:font-bold file:px-3 file:py-1 file:rounded-lg file:bg-indigo-900/40 file:border file:border-indigo-700/50 file:text-indigo-300 hover:file:bg-indigo-800/50 file:cursor-pointer file:transition-colors"
                    />
                </div>

                {error && (
                    <div className="text-xs text-red-400 bg-red-950/20 border border-red-900/30 rounded-lg px-3 py-2 mb-3">
                        {error}
                    </div>
                )}

                <div className="flex gap-2">
                    <button
                        onClick={onClose}
                        className="flex-1 text-xs py-2 rounded-lg border border-gray-700/50 text-gray-500 hover:text-gray-300 hover:border-gray-600 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleUpload}
                        disabled={uploading}
                        className="flex-1 text-xs py-2 rounded-lg bg-indigo-600/80 hover:bg-indigo-600 text-white font-bold transition-colors disabled:opacity-50"
                    >
                        {uploading ? 'Importing...' : 'Import Transactions'}
                    </button>
                </div>
            </div>
        </div>
    );
}

interface GstStatus {
    error?: string;
    tradeName?: string;
    legalName?: string;
    gstin?: string;
    taxpayerType?: string;
    verifiedAt?: string;
    address?: string;
    [key: string]: unknown;
}

export default function AccountsPanel({ businessId, accounts, loading, apiKey, onRefresh }: Props) {
    const [uploadTarget, setUploadTarget] = useState<Account | null>(null);
    const [toast, setToast] = useState('');
    const [gstin, setGstin] = useState('');
    const [verifying, setVerifying] = useState(false);
    const [gstStatus, setGstStatus] = useState<GstStatus | null>(null);

    const [editingLimitAccountId, setEditingLimitAccountId] = useState<string | null>(null);
    const [editingLimitValue, setEditingLimitValue] = useState<string>('');
    const [savingLimit, setSavingLimit] = useState(false);

    const totalBalance = accounts.reduce((s, a) => s + a.balance, 0);

    async function saveOdLimit(accountId: string) {
        setSavingLimit(true);
        try {
            const res = await fetch(`/api/cashiq/${businessId}/accounts/${accountId}/od-limit`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ od_limit: parseFloat(editingLimitValue) || 0 }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Failed to update limit');
            showToast('✅ Overdraft limit updated successfully.');
            setEditingLimitAccountId(null);
            onRefresh();
        } catch (e: unknown) {
            showToast(`❌ Error: ${(e as Error).message}`);
        } finally {
            setSavingLimit(false);
        }
    }

    function showToast(msg: string) {
        setToast(msg);
        setTimeout(() => setToast(''), 3500);
    }

    async function verifyGstin() {
        if (!gstin) return;
        setVerifying(true);
        setGstStatus(null);
        try {
            const res = await fetch(`/api/cashiq/verify-gstin/${gstin}`);
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Verification failed');
            setGstStatus(data);
        } catch (e: unknown) {
            setGstStatus({ error: (e as Error).message || 'Verification failed' });
        } finally {
            setVerifying(false);
        }
    }

    return (
        <div className="space-y-5">
            {/* Upload modal */}
            {uploadTarget && (
                <UploadModal
                    account={uploadTarget}
                    businessId={businessId}
                    apiKey={apiKey}
                    onClose={() => setUploadTarget(null)}
                    onSuccess={({ imported }) => {
                        showToast(`✅ Imported ${imported} transactions from bank statement`);
                        onRefresh();
                    }}
                />
            )}

            {/* Toast */}
            {toast && (
                <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-emerald-900/80 border border-emerald-700/50 text-emerald-300 text-xs px-4 py-2.5 rounded-xl backdrop-blur-sm z-50 shadow-xl">
                    {toast}
                </div>
            )}

            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-sm font-semibold text-gray-200">Bank Accounts</h2>
                    <p className="text-[10px] text-gray-600 mt-0.5">
                        {accounts.length} account{accounts.length !== 1 ? 's' : ''} · Total: ₹
                        {fmt(totalBalance)}
                    </p>
                </div>
                <div className="text-[10px] text-gray-600 bg-[#0F1318] border border-gray-800/40 px-3 py-1.5 rounded-lg">
                    <span className="text-amber-400 font-bold">MANUAL IMPORT</span> · AA integration
                    coming
                </div>
            </div>

            {/* Account cards */}
            {loading ? (
                <div className="text-center text-gray-600 text-sm py-12 animate-pulse">
                    Loading accounts...
                </div>
            ) : accounts.length === 0 ? (
                <div className="text-center py-16">
                    <div className="text-4xl mb-3">🏦</div>
                    <div className="text-gray-400 text-sm">No bank accounts added yet</div>
                    <div className="text-gray-600 text-xs mt-1">
                        Add a bank account to start importing statements
                    </div>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {accounts.map((account) => {
                        const gradientClass =
                            BANK_COLORS[account.bank_name] ||
                            'from-gray-900/40 to-gray-950/20 border-gray-800/30';
                        return (
                            <div
                                key={account.account_id}
                                className={`bg-gradient-to-br ${gradientClass} border rounded-2xl p-4 transition-all hover:scale-[1.01]`}
                            >
                                <div className="flex items-start justify-between mb-4">
                                    <div className="flex items-center gap-3">
                                        <BankLogo bankName={account.bank_name} />
                                        <div>
                                            <div className="text-xs font-semibold text-gray-200">
                                                {account.bank_name}
                                            </div>
                                            <div className="text-[10px] text-gray-500 font-mono">
                                                {account.account_number_masked}
                                            </div>
                                        </div>
                                    </div>
                                    <SourceBadge source={account.data_source} />
                                </div>

                                <div className="mb-3">
                                    <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-0.5">
                                        Current Balance
                                    </div>
                                    <div className="text-xl font-black text-white font-mono">
                                        ₹{fmt(account.balance)}
                                    </div>
                                </div>

                                <div className="mb-3 border-t border-gray-800/40 pt-2.5 mt-2.5">
                                    <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-0.5">
                                        Overdraft Limit
                                    </div>
                                    {editingLimitAccountId === account.account_id ? (
                                        <div className="flex items-center gap-1.5 mt-1">
                                            <input
                                                type="number"
                                                value={editingLimitValue}
                                                onChange={(e) =>
                                                    setEditingLimitValue(e.target.value)
                                                }
                                                className="w-24 bg-[#0a0d11] text-xs px-2 py-0.5 rounded border border-gray-800 text-white font-mono outline-none focus:border-indigo-500/50"
                                                autoFocus
                                            />
                                            <button
                                                onClick={() => saveOdLimit(account.account_id)}
                                                disabled={savingLimit}
                                                className="text-[9px] px-2 py-0.5 rounded bg-emerald-600 text-white font-bold hover:bg-emerald-500"
                                            >
                                                Save
                                            </button>
                                            <button
                                                onClick={() => setEditingLimitAccountId(null)}
                                                className="text-[9px] px-2 py-0.5 rounded bg-gray-800 text-gray-400 hover:text-white"
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-2 mt-1">
                                            <span className="text-sm font-bold text-amber-500 font-mono">
                                                ₹{fmt(account.od_limit || 0)}
                                            </span>
                                            <button
                                                onClick={() => {
                                                    setEditingLimitAccountId(account.account_id);
                                                    setEditingLimitValue(
                                                        (account.od_limit || 0).toString()
                                                    );
                                                }}
                                                className="text-[9px] text-indigo-400 hover:text-indigo-300 font-bold"
                                            >
                                                ✎ Edit Limit
                                            </button>
                                        </div>
                                    )}
                                </div>

                                <div className="text-[10px] text-gray-500 mt-0.5 mb-3">
                                    {account.account_type} Account
                                </div>

                                <div className="flex items-center justify-between">
                                    <div className="text-[9px] text-gray-700">
                                        {account.last_synced_at
                                            ? `Synced ${new Date(account.last_synced_at).toLocaleDateString('en-IN')}`
                                            : 'Never synced'}
                                    </div>
                                    <button
                                        onClick={() => setUploadTarget(account)}
                                        className="text-[10px] px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-gray-400 hover:text-gray-200 hover:bg-white/10 transition-colors"
                                    >
                                        ↑ Upload Statement
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* GSTIN Verification Console */}
            <div className="bg-[#0F1318] border border-gray-800/60 rounded-2xl p-5">
                <div className="flex items-center gap-2 mb-3">
                    <h3 className="text-sm font-semibold text-gray-200">
                        🔍 GSTIN Registry Verification
                    </h3>
                    <span className="text-[9px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded border border-blue-500/30">
                        ROADMAP
                    </span>
                </div>
                <p className="text-[10px] text-gray-600 mb-4">
                    Verify taxpayer legal details and corporate addresses directly from the GST
                    Portal Central Database Registry.
                </p>

                <div className="flex gap-2">
                    <input
                        className="flex-1 bg-[#0a0d11] text-xs px-3 py-2 rounded-lg border border-gray-800 text-gray-300 font-mono outline-none focus:border-indigo-500/50"
                        placeholder="Enter 15-Digit GSTIN (e.g. 33AABCC1234D1Z5)"
                        value={gstin}
                        onChange={(e) => setGstin(e.target.value.toUpperCase())}
                    />
                    <button
                        onClick={verifyGstin}
                        disabled={verifying}
                        className="px-4 py-2 rounded-lg bg-indigo-600/80 hover:bg-indigo-600 text-white text-xs font-bold transition-colors disabled:opacity-50"
                    >
                        {verifying ? 'Verifying...' : 'Verify Registry'}
                    </button>
                </div>
                {gstStatus && (
                    <div className="mt-4">
                        {gstStatus.error ? (
                            <div className="text-xs p-3 rounded-xl bg-red-950/20 text-red-400 border border-red-900/30 font-mono">
                                ❌ {gstStatus.error}
                            </div>
                        ) : (
                            <div className="bg-[#0a0d11] border border-gray-800/60 rounded-xl p-4 space-y-3">
                                <div className="flex items-center justify-between border-b border-gray-800/40 pb-2">
                                    <span className="text-xs font-bold text-gray-200">
                                        {gstStatus.tradeName}
                                    </span>
                                    <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
                                        ✓ ACTIVE REGISTRY
                                    </span>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-2 text-[10px]">
                                    <div>
                                        <span className="text-gray-500 block">Legal Name</span>
                                        <span className="text-gray-300 font-semibold">
                                            {gstStatus.legalName}
                                        </span>
                                    </div>
                                    <div>
                                        <span className="text-gray-500 block">GSTIN</span>
                                        <span className="text-gray-300 font-mono">
                                            {gstStatus.gstin}
                                        </span>
                                    </div>
                                    <div>
                                        <span className="text-gray-500 block">Taxpayer Type</span>
                                        <span className="text-gray-300">
                                            {gstStatus.taxpayerType}
                                        </span>
                                    </div>
                                    <div>
                                        <span className="text-gray-500 block">
                                            Verification Timestamp
                                        </span>
                                        <span className="text-gray-500 font-mono">
                                            {gstStatus.verifiedAt
                                                ? new Date(gstStatus.verifiedAt).toLocaleString(
                                                      'en-IN'
                                                  )
                                                : 'N/A'}
                                        </span>
                                    </div>
                                </div>
                                <div className="text-[10px] border-t border-gray-800/40 pt-2">
                                    <span className="text-gray-500 block">
                                        Registered Place of Business
                                    </span>
                                    <span className="text-gray-300">{gstStatus.address}</span>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Info box */}
            <div className="bg-[#0a0d11] border border-gray-800/40 rounded-xl p-4 text-[10px] text-gray-600 leading-relaxed">
                <span className="text-gray-400 font-semibold">Account Aggregator (AA):</span> When
                FIU registration is complete, bank data will sync automatically via the AA
                framework. Until then, upload your bank statement CSV exports above. Supported:
                HDFC, ICICI, SBI, Axis Bank, Kotak — standard CSV export format.
            </div>
        </div>
    );
}
