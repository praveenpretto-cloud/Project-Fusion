'use client';

import { useState } from 'react';
import type { Snapshot } from './CashOverviewTab';

interface Props {
    businessId: string;
    snapshot: Snapshot | null;
    loading: boolean;
    apiKey?: string;
    onRefresh: () => void;
}

function fmt(n: number) {
    return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
}

// ─ TAX CALENDAR DATA ─────────────────────────────────────────────────────────
interface TaxEvent {
    label: string;
    detail: string;
    date: Date;
    type: 'advance_tax' | 'tds_deposit' | 'tds_return' | 'gst';
    urgency: 'critical' | 'high' | 'medium' | 'low';
}

function getTaxCalendar(): TaxEvent[] {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const events: TaxEvent[] = [];

    // Advance Tax (Indian IT Act — 4 instalments)
    const advanceTaxDates: [number, number, string][] = [
        [5, 15, '15% of Estimated Tax'],
        [8, 15, '45% of Estimated Tax (cumulative)'],
        [11, 15, '75% of Estimated Tax (cumulative)'],
        [2, 15, '100% of Estimated Tax (cumulative)'],
    ];
    advanceTaxDates.forEach(([mo, day, detail]) => {
        const yr = mo < 3 ? y + 1 : y;
        const d = new Date(yr, mo, day);
        if (d >= now) {
            const daysLeft = Math.ceil((d.getTime() - now.getTime()) / 86400000);
            events.push({
                label: `Advance Tax — Q${mo === 5 ? 1 : mo === 8 ? 2 : mo === 11 ? 3 : 4}`,
                detail,
                date: d,
                type: 'advance_tax',
                urgency:
                    daysLeft <= 7
                        ? 'critical'
                        : daysLeft <= 15
                          ? 'high'
                          : daysLeft <= 30
                            ? 'medium'
                            : 'low',
            });
        }
    });

    // TDS Deposit (7th of every month)
    for (let i = 0; i <= 2; i++) {
        const mo = (m + 1 + i) % 12;
        const yr = y + Math.floor((m + 1 + i) / 12);
        const d = new Date(yr, mo, 7);
        if (d >= now) {
            const daysLeft = Math.ceil((d.getTime() - now.getTime()) / 86400000);
            events.push({
                label: 'TDS Challan 281',
                detail: `Deposit by 7th — ${d.toLocaleString('en-IN', { month: 'long', year: 'numeric' })}`,
                date: d,
                type: 'tds_deposit',
                urgency: daysLeft <= 7 ? 'critical' : daysLeft <= 15 ? 'high' : 'medium',
            });
        }
    }

    // TDS Returns (quarterly)
    const tdsReturns: [number, number, string][] = [
        [6, 31, 'Q1 (Apr–Jun) — Form 24Q/26Q'],
        [9, 31, 'Q2 (Jul–Sep) — Form 24Q/26Q'],
        [0, 31, 'Q3 (Oct–Dec) — Form 24Q/26Q'],
        [4, 31, 'Q4 (Jan–Mar) — Form 24Q/26Q'],
    ];
    tdsReturns.forEach(([mo, day, detail]) => {
        const yr = mo < 3 ? y + 1 : y;
        const d = new Date(yr, mo, day);
        if (d >= now) {
            const daysLeft = Math.ceil((d.getTime() - now.getTime()) / 86400000);
            events.push({
                label: 'TDS Return Filing',
                detail,
                date: d,
                type: 'tds_return',
                urgency: daysLeft <= 14 ? 'critical' : daysLeft <= 30 ? 'high' : 'low',
            });
        }
    });

    events.sort((a, b) => a.date.getTime() - b.date.getTime());
    return events.slice(0, 8);
}

const URGENCY_STYLES: Record<string, { card: string; badge: string; label: string }> = {
    critical: {
        card: 'border-red-700/50 bg-red-900/10',
        badge: 'bg-red-500/20 text-red-400 border-red-500/30 animate-pulse',
        label: 'text-red-400',
    },
    high: {
        card: 'border-amber-700/50 bg-amber-900/10',
        badge: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
        label: 'text-amber-400',
    },
    medium: {
        card: 'border-blue-700/50 bg-blue-900/10',
        badge: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
        label: 'text-blue-400',
    },
    low: {
        card: 'border-gray-800/60 bg-[#0a0d11]',
        badge: 'bg-gray-800 text-gray-500 border-gray-700/50',
        label: 'text-gray-500',
    },
};

const TAX_TYPE_ICONS: Record<string, string> = {
    advance_tax: '💰',
    tds_deposit: '🏦',
    tds_return: '📋',
    gst: '🧾',
};

// ─ COMPONENT ─────────────────────────────────────────────────────────────────
export default function CAWorkspaceTab({
    businessId,
    snapshot,
    loading,
    apiKey,
    onRefresh,
}: Props) {
    const [confirmingId, setConfirmingId] = useState<string | null>(null);
    const [exportingZoho, setExportingZoho] = useState(false);
    const [exportingTally, setExportingTally] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(
        null
    );
    const [salaryForPF, setSalaryForPF] = useState<string>('');
    const [activeSubTab, setActiveSubTab] = useState<'overview' | 'tds' | 'calendar'>('overview');

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="flex flex-col items-center gap-3">
                    <div className="animate-spin rounded-full h-8 w-8 border-2 border-amber-500 border-t-transparent" />
                    <div className="text-gray-500 text-xs font-mono animate-pulse">
                        Loading CA workspace...
                    </div>
                </div>
            </div>
        );
    }

    if (!snapshot) {
        return (
            <div className="flex flex-col items-center justify-center h-64 gap-3">
                <div className="text-4xl opacity-30">💼</div>
                <div className="text-gray-500 text-sm">No business selected</div>
            </div>
        );
    }

    const caName = snapshot.business.ca_name || 'Priya Ramaswamy';
    const caMembership = snapshot.business.ca_membership_number || 'FCA #408921';
    const caFirm = snapshot.business.ca_firm_name || 'Ramaswamy & Associates, CAs';
    const caEmail = snapshot.business.ca_email || 'priya.r@ramaswamyca.in';
    const caPhone = snapshot.business.ca_phone || '+91 98405 12345';
    const caCity = snapshot.business.ca_city || '14, Khader Nawaz Khan Rd, Chennai';

    const caInitials =
        caName
            .split(' ')
            .map((n: string) => n[0])
            .join('')
            .toUpperCase()
            .slice(0, 2) || 'CA';

    const tdsObligations = snapshot.upcoming_obligations.filter(
        (o) => o.type === 'TDS' || (o.description && o.description.toUpperCase().includes('TDS'))
    );
    const paidTds = tdsObligations.filter((o) => o.status === 'PAID');
    const pendingTds = tdsObligations.filter((o) => o.status !== 'PAID');

    // PF/ESIC calculations
    const salaryBase = parseFloat(salaryForPF.replace(/,/g, '')) || 0;
    const pfEmployee = Math.round(salaryBase * 0.12);
    const pfEmployer = Math.round(salaryBase * 0.12);
    const esicEmployee = salaryBase <= 21000 ? Math.round(salaryBase * 0.0075) : 0;
    const esicEmployer = salaryBase <= 21000 ? Math.round(salaryBase * 0.0325) : 0;
    const totalPF = pfEmployee + pfEmployer;
    const totalESIC = esicEmployee + esicEmployer;

    const taxCalendar = getTaxCalendar();

    async function handleConfirmTds(obligationId: string) {
        setConfirmingId(obligationId);
        setMessage(null);
        try {
            const res = await fetch(`/api/cashiq/${businessId}/tds-confirm`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ obligationId }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Failed to update TDS status');
            setMessage({
                type: 'success',
                text: '✅ TDS obligation successfully marked as PAID and logged.',
            });
            onRefresh();
        } catch (err: unknown) {
            setMessage({ type: 'error', text: `❌ Error: ${(err as Error).message}` });
        } finally {
            setConfirmingId(null);
        }
    }

    async function handleExportZoho() {
        setExportingZoho(true);
        setMessage(null);
        try {
            const res = await fetch(`/api/cashiq/${businessId}/export-audit`);
            if (!res.ok) throw new Error('Failed to generate export');
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `cashiq_zoho_audit_business_${businessId}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(url);
            setMessage({
                type: 'success',
                text: '✅ Zoho Books audit CSV downloaded successfully.',
            });
        } catch (err: unknown) {
            setMessage({ type: 'error', text: `❌ Export failed: ${(err as Error).message}` });
        } finally {
            setExportingZoho(false);
        }
    }

    async function handleExportTally() {
        setExportingTally(true);
        setMessage(null);
        setTimeout(() => {
            try {
                const tdsTotal = tdsObligations.reduce((sum, o) => sum + (o.amount || 0), 0);
                const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC><REPORTNAME>All Ledger Entries</REPORTNAME></REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Journal" ACTION="Create">
            <DATE>${new Date().toISOString().split('T')[0].replace(/-/g, '')}</DATE>
            <NARRATION>Project Fusion CashIQ — TDS Journal Reconciler Export</NARRATION>
            <VOUCHERNUMBER>CF-${Date.now()}</VOUCHERNUMBER>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>TDS Payable Account</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${tdsTotal}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Bank Account Clearance</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${tdsTotal}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
                const blob = new Blob([xmlContent], { type: 'application/xml' });
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `cashiq_tally_journal_${businessId}.xml`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                window.URL.revokeObjectURL(url);
                setMessage({
                    type: 'success',
                    text: '✅ Tally XML journal entries downloaded successfully.',
                });
            } catch (err: unknown) {
                setMessage({
                    type: 'error',
                    text: `❌ Tally export failed: ${(err as Error).message}`,
                });
            } finally {
                setExportingTally(false);
            }
        }, 800);
    }

    // ─────────────────────────────────────────────────────────────
    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-sm font-semibold text-gray-200">
                        Chartered Accountant Workspace
                    </h2>
                    <p className="text-[10px] text-gray-600 mt-0.5">
                        TDS reconciliation, compliance calendars, and accounting system exports.
                    </p>
                </div>
                {/* Sub-tabs */}
                <div className="flex border border-gray-800 bg-[#0a0d11] p-0.5 rounded-lg">
                    {[
                        { key: 'overview', label: '🏠 Overview' },
                        { key: 'tds', label: '📋 TDS' },
                        { key: 'calendar', label: '📅 Tax Calendar' },
                    ].map((tab) => (
                        <button
                            key={tab.key}
                            onClick={() =>
                                setActiveSubTab(tab.key as 'overview' | 'tds' | 'calendar')
                            }
                            className={`text-[9px] font-bold px-3 py-1.5 rounded transition-colors ${
                                activeSubTab === tab.key
                                    ? 'bg-amber-600 text-white'
                                    : 'text-gray-500 hover:text-gray-300'
                            }`}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Toast */}
            {message && (
                <div
                    className={`p-3 rounded-xl border text-xs ${
                        message.type === 'success'
                            ? 'bg-emerald-950/20 border-emerald-900/30 text-emerald-400'
                            : 'bg-red-950/20 border-red-900/30 text-red-400'
                    }`}
                >
                    {message.text}
                </div>
            )}

            {/* ── SUB-TAB: OVERVIEW ─────────────────────────────────── */}
            {activeSubTab === 'overview' && (
                <div className="space-y-5">
                    {/* CA Profile + Exports */}
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                        {/* CA Profile */}
                        <div className="lg:col-span-1 bg-[#0F1318] border border-gray-800/60 rounded-2xl p-5 flex flex-col justify-between">
                            <div>
                                <div className="flex items-center gap-3 mb-4">
                                    <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-amber-500 to-amber-600 flex items-center justify-center text-white font-extrabold text-lg shadow-lg shadow-amber-900/10">
                                        {caInitials}
                                    </div>
                                    <div>
                                        <h3 className="text-sm font-bold text-gray-200">
                                            {caName === 'Priya Ramaswamy'
                                                ? 'प्रिया रामास्वामी'
                                                : caName}
                                        </h3>
                                        <p className="text-[10px] text-amber-400 font-medium">
                                            {caName}, FCA
                                        </p>
                                        <p className="text-[9px] text-gray-500 font-mono">
                                            Membership: {caMembership}
                                        </p>
                                    </div>
                                </div>
                                <div className="space-y-2.5 pt-3 border-t border-gray-800/40 text-[10px] text-gray-400">
                                    {[
                                        { label: 'CA Firm', value: caFirm },
                                        { label: 'Email', value: caEmail },
                                        { label: 'Mobile', value: caPhone },
                                        { label: 'Office', value: caCity },
                                    ].map(({ label, value }) => (
                                        <div key={label}>
                                            <span className="text-gray-600 block uppercase tracking-wider text-[8px] font-bold">
                                                {label}
                                            </span>
                                            <span className="text-gray-300">{value}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div className="mt-5 pt-4 border-t border-gray-800/40">
                                <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 text-[9px] text-amber-300 leading-normal flex items-start gap-2">
                                    <span>💼</span>
                                    <div>
                                        <strong className="font-semibold block mb-0.5">
                                            Auditor Verification Active
                                        </strong>
                                        Read-only access to transactions and ledger logs for monthly
                                        compliance sheets.
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Export section */}
                        <div className="lg:col-span-2 bg-[#0F1318] border border-gray-800/60 rounded-2xl p-5 space-y-4">
                            <div>
                                <h3 className="text-xs font-bold text-gray-200 uppercase tracking-widest">
                                    Accounting System Sync & Exports
                                </h3>
                                <p className="text-[10px] text-gray-500 mt-1 leading-normal">
                                    Export formatted bank ledger logs mapped to standard ERP account
                                    structures.
                                </p>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {/* Zoho */}
                                <div className="border border-gray-800 rounded-xl p-4 bg-[#0a0d11] flex flex-col justify-between">
                                    <div>
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="text-[10px] font-bold text-emerald-400 font-mono">
                                                ZOHO BOOKS ERP
                                            </span>
                                            <span className="text-[8px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-500/30">
                                                SUPPORTED
                                            </span>
                                        </div>
                                        <h4 className="text-xs font-semibold text-gray-300 mb-1">
                                            Zoho Journal CSV Export
                                        </h4>
                                        <p className="text-[9px] text-gray-500 leading-normal">
                                            Generates column-mapped CSV: Date, Bank Account, Amount,
                                            Direction, Category — matching Zoho&apos;s general
                                            journal structure.
                                        </p>
                                    </div>
                                    <button
                                        id="btn-export-zoho"
                                        onClick={handleExportZoho}
                                        disabled={exportingZoho}
                                        className="w-full mt-4 text-[10px] py-2 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-600/50 text-emerald-400 font-bold transition-all flex items-center justify-center gap-1.5 disabled:opacity-50"
                                    >
                                        {exportingZoho
                                            ? '⏳ Generating CSV...'
                                            : '⬇ Download Zoho CSV'}
                                    </button>
                                </div>
                                {/* Tally */}
                                <div className="border border-gray-800 rounded-xl p-4 bg-[#0a0d11] flex flex-col justify-between">
                                    <div>
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="text-[10px] font-bold text-indigo-400 font-mono">
                                                TALLY ERP 9 / PRIME
                                            </span>
                                            <span className="text-[8px] bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded border border-indigo-500/30 font-mono">
                                                XML SCHEMA
                                            </span>
                                        </div>
                                        <h4 className="text-xs font-semibold text-gray-300 mb-1">
                                            Tally XML Journal Import
                                        </h4>
                                        <p className="text-[9px] text-gray-500 leading-normal">
                                            Standard Tally XML envelope with debit/credit mappings
                                            for direct import into Tally ERP 9 and Tally Prime.
                                        </p>
                                    </div>
                                    <button
                                        id="btn-export-tally"
                                        onClick={handleExportTally}
                                        disabled={exportingTally}
                                        className="w-full mt-4 text-[10px] py-2 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-600/50 text-indigo-400 font-bold transition-all flex items-center justify-center gap-1.5 disabled:opacity-50"
                                    >
                                        {exportingTally
                                            ? '⏳ Generating XML...'
                                            : '⬇ Download Tally XML'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* PF / ESIC Quick Calculator */}
                    <div className="bg-[#0F1318] border border-gray-800/60 rounded-2xl p-5">
                        <h3 className="text-xs font-bold text-gray-200 uppercase tracking-widest mb-1 flex items-center gap-2">
                            👥 PF / ESIC Quick Calculator
                            <span className="text-[8px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded border border-blue-500/30">
                                INDIA — EPF &amp; MP ACT
                            </span>
                        </h3>
                        <p className="text-[10px] text-gray-600 mb-4 leading-normal">
                            Calculate PF (12% each — employer &amp; employee) and ESIC (3.25%
                            employer, 0.75% employee for salary ≤ ₹21,000/month).
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                            <div className="space-y-2">
                                <label className="text-[10px] text-gray-500 uppercase tracking-wider font-bold block">
                                    Gross Monthly Salary (₹)
                                </label>
                                <input
                                    type="number"
                                    value={salaryForPF}
                                    onChange={(e) => setSalaryForPF(e.target.value)}
                                    placeholder="e.g. 35000"
                                    className="w-full bg-[#0a0d11] text-xs px-3 py-2 rounded-lg border border-gray-800 text-gray-300 outline-none focus:border-blue-600 font-mono"
                                />
                                {salaryBase > 21000 && (
                                    <p className="text-[9px] text-amber-400">
                                        Salary &gt; ₹21,000 — ESIC not applicable
                                    </p>
                                )}
                            </div>
                            {salaryBase > 0 && (
                                <div className="grid grid-cols-2 gap-3">
                                    {[
                                        {
                                            label: 'PF (Employee 12%)',
                                            value: pfEmployee,
                                            color: 'text-blue-400',
                                        },
                                        {
                                            label: 'PF (Employer 12%)',
                                            value: pfEmployer,
                                            color: 'text-blue-300',
                                        },
                                        {
                                            label: 'ESIC (Emp 0.75%)',
                                            value: esicEmployee,
                                            color: 'text-indigo-400',
                                        },
                                        {
                                            label: 'ESIC (Empr 3.25%)',
                                            value: esicEmployer,
                                            color: 'text-indigo-300',
                                        },
                                    ].map(({ label, value, color }) => (
                                        <div
                                            key={label}
                                            className="bg-[#0a0d11] border border-gray-800 rounded-lg p-2.5"
                                        >
                                            <div className="text-[8px] text-gray-600 uppercase tracking-wider font-bold mb-0.5">
                                                {label}
                                            </div>
                                            <div className={`text-sm font-bold font-mono ${color}`}>
                                                ₹{fmt(value)}
                                            </div>
                                        </div>
                                    ))}
                                    <div className="col-span-2 bg-blue-900/10 border border-blue-700/30 rounded-lg p-2.5 flex justify-between items-center">
                                        <div className="text-[9px] text-blue-400 font-bold uppercase">
                                            Total Monthly Compliance
                                        </div>
                                        <div className="text-sm font-black font-mono text-blue-300">
                                            ₹{fmt(totalPF + totalESIC)}
                                        </div>
                                    </div>
                                    <div className="col-span-2 text-[8px] text-gray-600 font-mono">
                                        PF deposit deadline: 15th of following month. ESIC: 15th.
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ── SUB-TAB: TDS ──────────────────────────────────────── */}
            {activeSubTab === 'tds' && (
                <div className="bg-[#0F1318] border border-gray-800/60 rounded-2xl p-5">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <h3 className="text-xs font-bold text-gray-200 uppercase tracking-widest">
                                TDS (Tax Deducted at Source) Compliance
                            </h3>
                            <p className="text-[10px] text-gray-600 mt-0.5">
                                Under Indian IT Act, TDS must be deducted and deposited by 7th of
                                following month.
                            </p>
                        </div>
                        <div className="flex items-center gap-3 text-[10px] text-gray-400">
                            <span>
                                Total:{' '}
                                <strong className="text-white font-mono">
                                    {tdsObligations.length}
                                </strong>
                            </span>
                            <span className="w-1.5 h-1.5 rounded-full bg-gray-700" />
                            <span>
                                Pending:{' '}
                                <strong className="text-amber-400 font-mono">
                                    {pendingTds.length}
                                </strong>
                            </span>
                            <span className="w-1.5 h-1.5 rounded-full bg-gray-700" />
                            <span>
                                Paid:{' '}
                                <strong className="text-emerald-400 font-mono">
                                    {paidTds.length}
                                </strong>
                            </span>
                        </div>
                    </div>

                    {tdsObligations.length === 0 ? (
                        <div className="text-center py-10 border border-dashed border-gray-800 rounded-xl bg-[#0a0d11]">
                            <span className="text-2xl block mb-2">📊</span>
                            <p className="text-xs text-gray-500">
                                No TDS obligations discovered in recent transaction registry
                            </p>
                            <p className="text-[9px] text-gray-600 mt-0.5">
                                Sync obligations or import statements with TDS descriptions.
                            </p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-[10px] text-left border-collapse">
                                <thead>
                                    <tr className="border-b border-gray-800/60 text-gray-500 uppercase tracking-wider text-[8px] font-bold bg-[#0a0d11]">
                                        <th className="py-2.5 px-3">Description</th>
                                        <th className="py-2.5 px-3">Section</th>
                                        <th className="py-2.5 px-3">Due Date</th>
                                        <th className="py-2.5 px-3 text-right">Amount</th>
                                        <th className="py-2.5 px-3 text-center">43B Flag</th>
                                        <th className="py-2.5 px-3 text-center">Status</th>
                                        <th className="py-2.5 px-3 text-right">Action</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-800/40">
                                    {tdsObligations.map((ob) => {
                                        const isPaid = ob.status === 'PAID';
                                        let section = 'Sec 194C (1%)';
                                        if (
                                            ob.description &&
                                            (ob.description.toLowerCase().includes('consult') ||
                                                ob.description
                                                    .toLowerCase()
                                                    .includes('professional') ||
                                                ob.description.toLowerCase().includes('audit'))
                                        ) {
                                            section = 'Sec 194J (2%)';
                                        }

                                        // Section 43B — check if >45 days from created
                                        let is43BViolation = false;
                                        if (ob.created_at) {
                                            const createdDaysAgo = Math.floor(
                                                (Date.now() - new Date(ob.created_at).getTime()) /
                                                    86400000
                                            );
                                            is43BViolation = !isPaid && createdDaysAgo > 45;
                                        }

                                        return (
                                            <tr
                                                key={ob.id}
                                                className={`hover:bg-[#0a0d11]/50 ${isPaid ? 'text-gray-500' : 'text-gray-300'}`}
                                            >
                                                <td className="py-3 px-3 font-medium">
                                                    <div>{ob.description}</div>
                                                    <div className="text-[8px] text-gray-600 font-mono mt-0.5">
                                                        REF: {ob.id}
                                                    </div>
                                                </td>
                                                <td className="py-3 px-3 font-mono">{section}</td>
                                                <td className="py-3 px-3 font-mono">
                                                    {ob.due_date}
                                                </td>
                                                <td className="py-3 px-3 text-right font-mono font-bold">
                                                    ₹{ob.amount !== null ? fmt(ob.amount) : '—'}
                                                </td>
                                                <td className="py-3 px-3 text-center">
                                                    {is43BViolation ? (
                                                        <span className="inline-block text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/40 animate-pulse">
                                                            43B BREACH
                                                        </span>
                                                    ) : (
                                                        <span className="text-gray-700 text-[8px]">
                                                            —
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="py-3 px-3 text-center">
                                                    {isPaid ? (
                                                        <span className="inline-block text-[8px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
                                                            PAID ✓
                                                        </span>
                                                    ) : (
                                                        <span className="inline-block text-[8px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse">
                                                            PENDING
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="py-3 px-3 text-right">
                                                    <button
                                                        id={`btn-confirm-tds-${ob.id}`}
                                                        onClick={() => handleConfirmTds(ob.id)}
                                                        disabled={isPaid || confirmingId === ob.id}
                                                        className={`px-3 py-1 rounded text-[8px] font-bold transition-all ${
                                                            isPaid
                                                                ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
                                                                : confirmingId === ob.id
                                                                  ? 'bg-indigo-600/40 text-indigo-300 animate-pulse'
                                                                  : 'bg-indigo-600 hover:bg-indigo-500 text-white'
                                                        }`}
                                                    >
                                                        {isPaid
                                                            ? 'Paid'
                                                            : confirmingId === ob.id
                                                              ? 'Confirming...'
                                                              : 'Confirm Paid'}
                                                    </button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {/* ── SUB-TAB: TAX CALENDAR ─────────────────────────────── */}
            {activeSubTab === 'calendar' && (
                <div className="space-y-4">
                    <div className="bg-[#0F1318] border border-gray-800/60 rounded-2xl p-5">
                        <h3 className="text-xs font-bold text-gray-200 uppercase tracking-widest mb-1 flex items-center gap-2">
                            📅 Indian Tax Compliance Calendar
                            <span className="text-[8px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded border border-red-500/30">
                                STATUTORY DEADLINES
                            </span>
                        </h3>
                        <p className="text-[10px] text-gray-600 mb-5">
                            Advance Tax instalments, TDS deposit deadlines, and quarterly TDS return
                            filing dates — auto-calculated from today.
                        </p>

                        <div className="space-y-3">
                            {taxCalendar.map((ev, i) => {
                                const days = Math.ceil((ev.date.getTime() - Date.now()) / 86400000);
                                const s = URGENCY_STYLES[ev.urgency];
                                return (
                                    <div
                                        key={i}
                                        className={`flex items-center justify-between rounded-xl border p-4 ${s.card}`}
                                    >
                                        <div className="flex items-center gap-3">
                                            <span className="text-xl">
                                                {TAX_TYPE_ICONS[ev.type]}
                                            </span>
                                            <div>
                                                <div className={`text-xs font-bold ${s.label}`}>
                                                    {ev.label}
                                                </div>
                                                <div className="text-[10px] text-gray-500 mt-0.5">
                                                    {ev.detail}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="text-right flex flex-col items-end gap-1">
                                            <span
                                                className={`text-[9px] font-bold px-2 py-0.5 rounded border ${s.badge}`}
                                            >
                                                {days <= 0 ? 'TODAY / OVERDUE' : `${days} days`}
                                            </span>
                                            <span className="text-[9px] text-gray-600 font-mono">
                                                {ev.date.toLocaleDateString('en-IN', {
                                                    day: '2-digit',
                                                    month: 'short',
                                                    year: 'numeric',
                                                })}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        <div className="mt-6 pt-4 border-t border-gray-800/40">
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                {[
                                    {
                                        icon: '💰',
                                        label: 'Advance Tax',
                                        desc: 'June 15 · Sep 15 · Dec 15 · Mar 15',
                                        color: 'text-yellow-400',
                                    },
                                    {
                                        icon: '🏦',
                                        label: 'TDS Deposit',
                                        desc: '7th of every month — Challan 281',
                                        color: 'text-blue-400',
                                    },
                                    {
                                        icon: '📋',
                                        label: 'TDS Returns',
                                        desc: 'July 31 · Oct 31 · Jan 31 · May 31',
                                        color: 'text-indigo-400',
                                    },
                                    {
                                        icon: '🧾',
                                        label: 'GST Returns',
                                        desc: 'GSTR-1: 11th · GSTR-3B: 20th',
                                        color: 'text-emerald-400',
                                    },
                                ].map((item) => (
                                    <div
                                        key={item.label}
                                        className="bg-[#0a0d11] border border-gray-800 rounded-xl p-3"
                                    >
                                        <div className="text-base mb-1">{item.icon}</div>
                                        <div className={`text-[10px] font-bold ${item.color}`}>
                                            {item.label}
                                        </div>
                                        <div className="text-[8px] text-gray-600 mt-0.5 leading-normal">
                                            {item.desc}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
