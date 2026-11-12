'use client';

import { useState, useEffect } from 'react';
import {
    Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
    ComposedChart, Area
} from 'recharts';
import ReactMarkdown from 'react-markdown';

export interface Account {
    account_id: string;
    bank_name: string;
    account_type: string;
    data_source: string;
    masked_number: string;
    balance: number;
    last_synced_at: string | null;
}

export interface Obligation {
    id: string;
    type: string;
    description: string;
    due_date: string;
    amount: number | null;
    currency: string;
    status: string;
    days_until: number;
    source: string;
    created_at?: string;
}

export interface Alert {
    event_id: string;
    severity: 'HIGH' | 'MEDIUM' | 'LOW';
    title: string;
    message: string;
    is_read: boolean;
    triggered_at: string;
}

export interface FlowBar {
    date: string;
    inflow: number;
    outflow: number;
    net: number;
}

export interface Snapshot {
    business: {
        id: string;
        name: string;
        gstin: string;
        city: string;
        ca_name?: string;
        ca_membership_number?: string;
        ca_email?: string;
        ca_phone?: string;
        ca_firm_name?: string;
        ca_city?: string;
    };
    current_balance: number;
    od_limit?: number;
    data_completeness: 'FULL' | 'PARTIAL' | 'MANUAL_ONLY';
    accounts: Account[];
    upcoming_obligations: Obligation[];
    monthly_flow: FlowBar[];
    active_alerts: Alert[];
    snapshot_at: string;
}

interface Props {
    snapshot: Snapshot | null;
    loading: boolean;
    businessId: string;
    apiKey?: string;
    globalCurrency?: { code: string; flag: string; rate: number };
    setGlobalCurrency?: (c: { code: string; flag: string; rate: number }) => void;
    currencies?: { code: string; flag: string; rate: number }[];
    onSelectBusiness?: (id: string) => void;
}

const PRIMARY_AUTHORIZED_BUSINESS_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

let globalFormatter = { code: 'INR', flag: '🇮🇳', rate: 1.0 };

const DEFAULT_OD_LIMIT = 2000000;

// ─ FORMATTERS ─────────────────────────────────────────────────
function fmt(n: number) {
    const val = n / globalFormatter.rate;
    const prefix = globalFormatter.code === 'INR' ? '₹' : globalFormatter.code === 'USD' ? '$' : globalFormatter.code === 'EUR' ? '€' : globalFormatter.code === 'GBP' ? '£' : globalFormatter.code + ' ';
    return prefix + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(val);
}

/** Lakh/Crore for INR, standard K/M/B for others */
function fmtLakh(n: number): string {
    const abs = Math.abs(n) / globalFormatter.rate;
    const sign = n < 0 ? '-' : '';
    const pre = globalFormatter.code === 'INR' ? '₹' : globalFormatter.code === 'USD' ? '$' : globalFormatter.code === 'EUR' ? '€' : globalFormatter.code === 'GBP' ? '£' : globalFormatter.code + ' ';
    
    if (globalFormatter.code === 'INR') {
        if (abs >= 10000000) return `${sign}${pre}${(abs / 10000000).toFixed(1)}Cr`;
        if (abs >= 100000)   return `${sign}${pre}${(abs / 100000).toFixed(1)}L`;
        if (abs >= 1000)     return `${sign}${pre}${(abs / 1000).toFixed(0)}K`;
        return `${sign}${pre}${abs.toFixed(0)}`;
    } else {
        if (abs >= 1000000000) return `${sign}${pre}${(abs / 1000000000).toFixed(1)}B`;
        if (abs >= 1000000)    return `${sign}${pre}${(abs / 1000000).toFixed(1)}M`;
        if (abs >= 1000)       return `${sign}${pre}${(abs / 1000).toFixed(1)}K`;
        return `${sign}${pre}${abs.toFixed(0)}`;
    }
}

// ─ HELPERS ────────────────────────────────────────────────────
function severityColor(s: string) {
    if (s === 'HIGH')   return { bg: 'bg-red-900/30',    border: 'border-red-700/50',    text: 'text-red-400',    dot: 'bg-red-500' };
    if (s === 'MEDIUM') return { bg: 'bg-amber-900/30',  border: 'border-amber-700/50',  text: 'text-amber-400',  dot: 'bg-amber-500' };
    return                     { bg: 'bg-blue-900/30',   border: 'border-blue-700/50',   text: 'text-blue-400',   dot: 'bg-blue-500' };
}

function obligationColor(ob: Obligation) {
    if (ob.status === 'OVERDUE')            return 'border-l-red-500    bg-red-900/10';
    if (ob.days_until !== null && ob.days_until <= 3) return 'border-l-amber-500  bg-amber-900/10';
    return 'border-l-emerald-500 bg-emerald-900/10';
}

function obligationBadge(ob: Obligation) {
    if (ob.status === 'OVERDUE') return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/40">OVERDUE</span>;
    if (ob.days_until !== null && ob.days_until <= 3) return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/40">DUE SOON</span>;
    return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">{ob.days_until}D</span>;
}

function completenessConfig(c: string) {
    if (c === 'FULL')    return { label: 'ALL ACCOUNTS SYNCED', color: 'text-emerald-400', dot: 'bg-emerald-500' };
    if (c === 'PARTIAL') return { label: 'PARTIAL AA COVERAGE', color: 'text-amber-400',   dot: 'bg-amber-500' };
    return                      { label: 'MANUAL DATA ONLY',    color: 'text-blue-400',    dot: 'bg-blue-500' };
}

// ─ GSTR CALENDAR ──────────────────────────────────────────────
interface GSTREvent {
    label: string;
    detail: string;
    date: Date;
    color: string;
    urgencyColor: string;
}

function getGSTRCalendar(): GSTREvent[] {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth(); // 0-indexed

    const events: GSTREvent[] = [];

    // Next 3 months of GSTR-1 (11th) and GSTR-3B (20th)
    for (let i = 0; i <= 2; i++) {
        const month = (m + i) % 12;
        const year = y + Math.floor((m + i) / 12);

        const gstr1Date = new Date(year, month, 11);
        const gstr3bDate = new Date(year, month, 20);

        if (gstr1Date >= now) {
            events.push({
                label: 'GSTR-1 Filing',
                detail: `${gstr1Date.toLocaleString('en-IN', { month: 'short', year: 'numeric' })} — Sales Register`,
                date: gstr1Date,
                color: 'border-blue-700/50 bg-blue-900/10',
                urgencyColor: 'text-blue-400',
            });
        }
        if (gstr3bDate >= now) {
            events.push({
                label: 'GSTR-3B Filing',
                detail: `${gstr3bDate.toLocaleString('en-IN', { month: 'short', year: 'numeric' })} — Tax Liability`,
                date: gstr3bDate,
                color: 'border-indigo-700/50 bg-indigo-900/10',
                urgencyColor: 'text-indigo-400',
            });
        }
    }

    // GSTR-9 annual (Dec 31)
    const gstr9Date = new Date(y, 11, 31);
    if (gstr9Date >= now) {
        events.push({
            label: 'GSTR-9 Annual Return',
            detail: `FY ${y - 1}-${String(y).slice(2)} — Due Dec 31`,
            date: gstr9Date,
            color: 'border-purple-700/50 bg-purple-900/10',
            urgencyColor: 'text-purple-400',
        });
    }

    // TDS Deposit (7th next month)
    const tdsDate = new Date(y, m + 1, 7);
    if (tdsDate >= now) {
        events.push({
            label: 'TDS Deposit Due',
            detail: `Challan 281 — By 7th of ${tdsDate.toLocaleString('en-IN', { month: 'long' })}`,
            date: tdsDate,
            color: 'border-amber-700/50 bg-amber-900/10',
            urgencyColor: 'text-amber-400',
        });
    }

    // Sort ascending
    events.sort((a, b) => a.date.getTime() - b.date.getTime());
    return events.slice(0, 5);
}

function daysUntil(d: Date): number {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return Math.ceil((d.getTime() - now.getTime()) / 86400000);
}

// ─ DEFAULT BUDGETS ────────────────────────────────────────────
const DEFAULT_BUDGETS: Record<string, { label: string; budget: number; icon: string }> = {
    SALARY:         { label: 'Salaries & Payroll',      budget: 1000000,  icon: '👥' },
    VENDOR_PAYMENT: { label: 'Vendor & Supplier Bills', budget: 2500000,  icon: '🏪' },
    GST_PAYMENT:    { label: 'GST Compliance Outflow',  budget: 500000,   icon: '🧾' },
    TDS:            { label: 'TDS Compliance Outflow',  budget: 150000,   icon: '📋' },
};

const LOCALSTORAGE_KEY = 'pf_budgets_v1';

function loadBudgets(): Record<string, number> {
    try {
        const saved = localStorage.getItem(LOCALSTORAGE_KEY);
        if (saved) return JSON.parse(saved);
    } catch { /* ignore */ }
    return Object.fromEntries(Object.entries(DEFAULT_BUDGETS).map(([k, v]) => [k, v.budget]));
}

interface FlowTooltipPayloadItem {
    dataKey?: string;
    value?: number;
    [key: string]: unknown;
}

interface FlowTooltipProps {
    active?: boolean;
    payload?: FlowTooltipPayloadItem[];
    label?: string;
}

// ─ CUSTOM TOOLTIP ─────────────────────────────────────────────
function FlowTooltip({ active, payload, label }: FlowTooltipProps) {
    if (!active || !payload?.length) return null;
    const inflow = payload.find((p) => p.dataKey === 'inflow')?.value || 0;
    const outflow = payload.find((p) => p.dataKey === 'outflow')?.value || 0;
    const balance = payload.find((p) => p.dataKey === 'balance')?.value;
    const net = inflow - outflow;
    return (
        <div className="bg-[#161B22] border border-gray-800 rounded-lg px-3.5 py-2.5 text-xs shadow-2xl font-sans text-left space-y-1">
            <div className="text-gray-500 mb-1 font-mono font-bold uppercase text-[9px] tracking-wider">{label}</div>
            <div className="flex justify-between gap-6">
                <span className="text-gray-400">Inflow:</span>
                <span className="text-emerald-400 font-bold font-mono">{fmtLakh(inflow)}</span>
            </div>
            <div className="flex justify-between gap-6">
                <span className="text-gray-400">Outflow:</span>
                <span className="text-red-400 font-bold font-mono">{fmtLakh(outflow)}</span>
            </div>
            <div className="flex justify-between gap-6 border-t border-gray-800 pt-1">
                <span className="text-gray-400">Net Flow:</span>
                <span className={`font-bold font-mono ${net >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{fmtLakh(net)}</span>
            </div>
            {balance !== undefined && (
                <div className="flex justify-between gap-6 border-t border-gray-800 pt-1">
                    <span className="text-blue-400">Cash Position:</span>
                    <span className="text-blue-300 font-bold font-mono">{fmtLakh(balance)}</span>
                </div>
            )}
        </div>
    );
}

// ─ RUNWAY BADGE ───────────────────────────────────────────────
function RunwayBadge({ days }: { days: number }) {
    if (days <= 0)  return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/40 animate-pulse">CRITICAL</span>;
    if (days <= 30) return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/40">URGENT</span>;
    if (days <= 60) return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/40">WATCH</span>;
    return               <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">HEALTHY</span>;
}

interface ChatMessage {
    role: string;
    content: string;
}

interface TransactionItem {
    direction?: string;
    category?: string;
    amount?: string | number;
    [key: string]: unknown;
}

interface ApprovalItem {
    instruction_id: string;
    seller_name?: string;
    buyer_name?: string;
    invoice_id?: string;
    amount: string;
    [key: string]: unknown;
}

interface ReconciliationItem {
    id: string;
    instruction_id: string;
    seller_name?: string;
    status?: string;
    amount: string;
    [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════
export default function CashOverviewTab({ snapshot, loading, businessId, apiKey, globalCurrency, setGlobalCurrency, currencies, onSelectBusiness }: Props) {
    if (globalCurrency) globalFormatter = globalCurrency;
    
    const isAuthorizedForAi = (businessId?.toLowerCase() === PRIMARY_AUTHORIZED_BUSINESS_ID.toLowerCase());
    
    const [timeframe, setTimeframe] = useState<'DAILY' | 'WEEKLY' | 'MONTHLY'>('DAILY');
    const [simHiresCount, setSimHiresCount] = useState<number>(0);
    const [simMachineryAmt, setSimMachineryAmt] = useState<number>(0);
    const [simPaymentDelayPct, setSimPaymentDelayPct] = useState<number>(0);
    const [simulatorOpen, setSimulatorOpen] = useState(false);

    const [transactions, setTransactions] = useState<TransactionItem[]>([]);
    const [loadingTxns, setLoadingTxns] = useState(false);

    // AI Advisor State
    const [aiAdvice, setAiAdvice] = useState<string | null>(null);
    const [loadingAi, setLoadingAi] = useState(false);

    // AI Chat State
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
    const [chatInput, setChatInput] = useState('');
    const [isChatLoading, setIsChatLoading] = useState(false);

    // Maker-Checker & Auto-Recon State
    const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
    const [reconciliations, setReconciliations] = useState<ReconciliationItem[]>([]);

    const fetchMeta = async () => {
        try {
            const [appRes, recRes] = await Promise.all([
                fetch('/api/zoho/approvals').then(r => r.json()),
                fetch('/api/zoho/reconciliations').then(r => r.json())
            ]);
            if (appRes.approvals) setApprovals(appRes.approvals);
            if (recRes.reconciliations) setReconciliations(recRes.reconciliations);
        } catch {}
    };

    useEffect(() => {
        fetchMeta();
        const interval = setInterval(fetchMeta, 10000);
        return () => clearInterval(interval);
    }, []);

    const sendChatMessage = async () => {
        if (!chatInput.trim() || !snapshot) return;
        
        const newMsg = { role: 'user', content: chatInput };
        const newHistory = [...chatMessages, newMsg];
        setChatMessages(newHistory);
        setChatInput('');

        if (!isAuthorizedForAi) {
            setChatMessages([
                ...newHistory,
                {
                    role: 'assistant',
                    content: 'Access Denied (403): Your local operator session is authorized only for Coimbatore Textile Mills Pvt Ltd. Cross-business AI advisory is disabled to enforce tenant isolation.'
                }
            ]);
            return;
        }

        setIsChatLoading(true);

        try {
            const totalInflow = snapshot.monthly_flow.reduce((s, d) => s + d.inflow, 0);
            const totalOutflow = snapshot.monthly_flow.reduce((s, d) => s + d.outflow, 0);
            const overdueAmount = snapshot.upcoming_obligations
                .filter(o => o.status === 'OVERDUE')
                .reduce((s, o) => s + (o.amount || 0), 0);
            const upcomingAmount = snapshot.upcoming_obligations
                .filter(o => o.days_until !== null && o.days_until <= 7 && o.status !== 'OVERDUE')
                .reduce((s, o) => s + (o.amount || 0), 0);

            const res = await fetch('/api/ai/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    businessId: snapshot.business?.id || businessId,
                    messages: newHistory,
                    contextPayload: {
                        businessId: snapshot.business?.id || businessId,
                        balance: snapshot.current_balance,
                        simulatedBalance: snapshot.current_balance,
                        odLimit: snapshot.od_limit || 2000000,
                        totalInflow,
                        totalOutflow,
                        overdueAmount,
                        upcomingAmount,
                        transactionCount: transactions.length
                    }
                })
            });

            if (res.status === 403) {
                const data = await res.json().catch(() => ({}));
                setChatMessages([
                    ...newHistory,
                    {
                        role: 'assistant',
                        content: `Access Denied (403): ${data.detail || "Cross-business access prohibited. Multi-business entitlement mapping does not exist for this operator identity."}`
                    }
                ]);
                return;
            }

            const data = await res.json();
            if (data.reply) {
                setChatMessages([...newHistory, { role: 'assistant', content: data.reply }]);
            }
        } catch (err) {
            console.error('Chat error', err);
        } finally {
            setIsChatLoading(false);
        }
    };

    const fetchAiAdvice = async () => {
        if (!snapshot) return;

        if (!isAuthorizedForAi) {
            setAiAdvice("Access Denied (403): Your local operator session is restricted to the primary authorized business (Coimbatore Textile Mills Pvt Ltd). Cross-business AI inference is refused by server-side policy.");
            return;
        }

        setLoadingAi(true);
        try {
            const totalInflow = snapshot.monthly_flow.reduce((s, d) => s + d.inflow, 0);
            const totalOutflow = snapshot.monthly_flow.reduce((s, d) => s + d.outflow, 0);
            const overdueAmount = snapshot.upcoming_obligations
                .filter(o => o.status === 'OVERDUE')
                .reduce((s, o) => s + (o.amount || 0), 0);
            const upcomingAmount = snapshot.upcoming_obligations
                .filter(o => o.days_until !== null && o.days_until <= 7 && o.status !== 'OVERDUE')
                .reduce((s, o) => s + (o.amount || 0), 0);
            const highSeverityAlerts = snapshot.active_alerts.filter(a => a.severity === 'HIGH').length;

            const res = await fetch('/api/ai/cashflow-advisor', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    businessId: snapshot.business?.id || businessId,
                    balance: snapshot.current_balance,
                    odLimit: snapshot.od_limit || 2000000,
                    totalInflow,
                    totalOutflow,
                    overdueAmount,
                    upcomingAmount,
                    highSeverityAlerts,
                    simulatedBalance: snapshot.current_balance
                })
            });

            if (res.status === 403) {
                const data = await res.json().catch(() => ({}));
                setAiAdvice(`Access Denied (403): ${data.detail || "Cross-business access prohibited. Your operator session is restricted to Coimbatore Textile Mills Pvt Ltd."}`);
                return;
            }

            const data = await res.json();
            if (data.advice) {
                setAiAdvice(data.advice);
            } else {
                setAiAdvice("Failed to generate advice. Please try again.");
            }
        } catch {
            setAiAdvice("Error communicating with local AI model.");
        } finally {
            setLoadingAi(false);
        }
    };

    // Editable budgets — persisted to localStorage
    const [budgets, setBudgets] = useState<Record<string, number>>(() => {
        if (typeof window !== 'undefined') return loadBudgets();
        return Object.fromEntries(Object.entries(DEFAULT_BUDGETS).map(([k, v]) => [k, v.budget]));
    });
    const [editingBudget, setEditingBudget] = useState<string | null>(null);
    const [editBudgetValue, setEditBudgetValue] = useState<string>('');

    function saveBudget(catKey: string) {
        const val = parseInt(editBudgetValue.replace(/,/g, '')) || DEFAULT_BUDGETS[catKey].budget;
        const next = { ...budgets, [catKey]: val };
        setBudgets(next);
        try { localStorage.setItem(LOCALSTORAGE_KEY, JSON.stringify(next)); } catch {}
        setEditingBudget(null);
    }

    // Fetch transactions for budget tracker
    useEffect(() => {
        if (!businessId) return;
        setLoadingTxns(true);
        fetch(`/api/cashiq/${businessId}/transactions?limit=100`)
        .then(res => res.json())
        .then(data => {
            if (data.success && data.data) setTransactions(data.data);
        })
        .catch(err => console.error('Error fetching txns:', err))
        .finally(() => setLoadingTxns(false));
    }, [businessId]);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="flex flex-col items-center gap-3">
                    <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent" />
                    <div className="text-gray-500 text-xs font-mono animate-pulse">Fetching cash position...</div>
                </div>
            </div>
        );
    }

    if (!snapshot) {
        return (
            <div className="flex flex-col items-center justify-center h-64 gap-3">
                <div className="text-4xl opacity-30">🏦</div>
                <div className="text-gray-500 text-sm">No business selected</div>
                <div className="text-gray-700 text-xs">Select a business from the dropdown above</div>
            </div>
        );
    }

    // ── BASELINE STATS ────────────────────────────────────────────
    const odLimit = snapshot.od_limit !== undefined ? snapshot.od_limit : DEFAULT_OD_LIMIT;
    const comp = completenessConfig(snapshot.data_completeness);
    const totalInflow  = snapshot.monthly_flow.reduce((s, d) => s + d.inflow, 0);
    const totalOutflow = snapshot.monthly_flow.reduce((s, d) => s + d.outflow, 0);
    const netFlow      = totalInflow - totalOutflow;
    const overdueCount = snapshot.active_alerts.filter(a => a.severity === 'HIGH').length;

    // ── CASH RUNWAY ───────────────────────────────────────────────
    // Use the actual date range in monthly_flow data, not a hardcoded 30-day window
    const flowDays = (() => {
        if (snapshot.monthly_flow.length < 2) return 30;
        const first = new Date(snapshot.monthly_flow[0].date).getTime();
        const last  = new Date(snapshot.monthly_flow[snapshot.monthly_flow.length - 1].date).getTime();
        const days  = Math.ceil((last - first) / 86400000) + 1;
        return days > 0 ? days : 30;
    })();
    const avgDailyBurn = totalOutflow > 0 ? totalOutflow / flowDays : 1;
    const runwayDays   = snapshot.current_balance > 0
        ? Math.floor(snapshot.current_balance / avgDailyBurn)
        : 0;

    // ── BUDGET ACTUALS ────────────────────────────────────────────
    const debits = transactions.filter(t => t.direction === 'DEBIT');
    const getActual = (cat: string) =>
        debits.filter(t => t.category === cat).reduce((s, t) => s + parseFloat(String(t.amount || '0')), 0);

    // ── FORECAST SIMULATION ───────────────────────────────────────
    const totalHiringImpact = simHiresCount * 50000;
    const simulatedBalance = snapshot.current_balance - totalHiringImpact - simMachineryAmt;
    const inflowMultiplier = 1 - (simPaymentDelayPct / 100) * 0.7;

    // Calculate baseline start balance by subtracting net flow of period from current balance
    const netFlowTotal = snapshot.monthly_flow.reduce((s, d) => s + (d.inflow - d.outflow), 0);
    const initialBalance = snapshot.current_balance - netFlowTotal;

    let runningBalance = initialBalance;
    const simulatedFlowData = snapshot.monthly_flow.map(day => {
        const inflow  = day.inflow * inflowMultiplier;
        const outflow = simHiresCount > 0 ? day.outflow + (totalHiringImpact / 30) : day.outflow;
        const net = inflow - outflow;
        runningBalance += net;
        return { ...day, inflow, outflow, net, balance: runningBalance };
    });

    if (simMachineryAmt > 0 && simulatedFlowData.length > 0) {
        const last = simulatedFlowData.length - 1;
        simulatedFlowData[last] = {
            ...simulatedFlowData[last],
            outflow: simulatedFlowData[last].outflow + simMachineryAmt,
            net: simulatedFlowData[last].inflow - (simulatedFlowData[last].outflow + simMachineryAmt),
            balance: simulatedFlowData[last].balance - simMachineryAmt,
        };
    }

    const simTotalInflow  = simulatedFlowData.reduce((s, d) => s + d.inflow, 0);
    const simTotalOutflow = simulatedFlowData.reduce((s, d) => s + d.outflow, 0);
    const simNetFlow      = simTotalInflow - simTotalOutflow;
    const isSimulating    = simHiresCount > 0 || simMachineryAmt > 0 || simPaymentDelayPct > 0;

    const isOverdraftLimitBreached = simulatedBalance < -odLimit;
    const isUtilizingOverdraft     = simulatedBalance < 0 && simulatedBalance >= -odLimit;
    const odUtilizedAmt = simulatedBalance < 0 ? Math.min(Math.abs(simulatedBalance), odLimit) : 0;
    const odUtilizedPct = odLimit > 0 ? (odUtilizedAmt / odLimit) * 100 : 0;

    // ── TIMEFRAME AGGREGATION ────────────────────────────────────
    const getAggregatedData = (data: (FlowBar & { balance?: number })[]) => {
        if (timeframe === 'DAILY') return data;
        const chunkSize = timeframe === 'WEEKLY' ? 7 : 15;
        const result: (FlowBar & { balance?: number })[] = [];
        let runningBal = data[0]?.balance || snapshot.current_balance;
        for (let i = 0; i < data.length; i += chunkSize) {
            const chunk = data.slice(i, Math.min(i + chunkSize, data.length));
            const inflow  = chunk.reduce((s, d) => s + d.inflow, 0);
            const outflow = chunk.reduce((s, d) => s + d.outflow, 0);
            const balance = chunk[chunk.length - 1]?.balance || runningBal;
            runningBal = balance;
            const label   = timeframe === 'WEEKLY'
                ? `Wk ${Math.floor(i / 7) + 1} (${chunk[0]?.date?.slice(5) || ''})`
                : `Fortnight ${Math.floor(i / 15) + 1}`;
            result.push({ date: label, inflow, outflow, net: inflow - outflow, balance });
        }
        return result;
    };

    const finalChartData = getAggregatedData(simulatedFlowData);
    const gstrEvents = getGSTRCalendar();

    // ──────────────────────────────────────────────────────────────
    return (
        <div className="space-y-5">

            {/* ─ HERO ROW ──────────────────────────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

                {/* Current Cash Position */}
                <div className="lg:col-span-2 cash-position-card bg-gradient-to-br from-[#0F1318]/90 via-[#0d1117]/80 to-[#111827]/90 border border-white/10 rounded-2xl p-6 relative overflow-hidden glass-panel shadow-glow-indigo transition-all duration-500 hover:-translate-y-1">
                    <div className="absolute top-0 right-0 w-40 h-40 opacity-5 text-[8rem] font-black text-emerald-400 font-mono leading-none select-none">{globalFormatter.code === 'INR' ? '₹' : globalFormatter.code === 'USD' ? '$' : globalFormatter.code === 'EUR' ? '€' : globalFormatter.code === 'GBP' ? '£' : globalFormatter.code}</div>
                    <div className="relative z-10 flex flex-col justify-between h-full">
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <div className="flex items-center gap-2">
                                    <span className={`w-2 h-2 rounded-full ${comp.dot} animate-pulse`} />
                                    <span className={`text-[10px] font-bold uppercase tracking-[0.2em] ${comp.color}`}>{comp.label}</span>
                                </div>
                                {currencies && setGlobalCurrency && (
                                    <select
                                        value={globalFormatter.code}
                                        onChange={(e) => {
                                            const c = currencies.find(x => x.code === e.target.value);
                                            if (c) setGlobalCurrency(c);
                                        }}
                                        className="text-[10px] bg-[#161B22] border border-gray-700/50 text-gray-300 px-2 py-0.5 rounded outline-none font-mono tracking-wider cursor-pointer hover:border-indigo-500/50 transition-colors"
                                    >
                                        {currencies.map(c => (
                                            <option key={c.code} value={c.code}>{c.flag} {c.code}</option>
                                        ))}
                                    </select>
                                )}
                            </div>
                            <div className="text-[10px] text-gray-500 font-mono mb-4">
                                {snapshot.business.name} · {snapshot.business.city}
                                {snapshot.business.gstin && (
                                    <span className="ml-2 px-1.5 py-0.5 bg-gray-800/60 rounded font-mono text-gray-600">
                                        GST: {snapshot.business.gstin}
                                    </span>
                                )}
                            </div>

                            <div className="text-4xl font-black text-white font-mono tracking-tight tabular-nums mb-1 flex items-baseline gap-2">
                                <span>{fmt(isSimulating ? simulatedBalance : snapshot.current_balance)}</span>
                                {isSimulating && (
                                    <span className="text-[9px] font-bold bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded border border-blue-500/30 animate-pulse">SIMULATED</span>
                                )}
                            </div>
                            <div className="text-xs text-gray-500">
                                Aggregate across {snapshot.accounts.length} account{snapshot.accounts.length !== 1 ? 's' : ''}
                            </div>
                        </div>

                        {/* OD gauge */}
                        <div className="mt-5 pt-4 border-t border-gray-800/40">
                            <div className="flex justify-between items-center text-[10px] text-gray-400 mb-1">
                                <span>Overdraft (Cash Credit) Line Utilization</span>
                                <span className="font-mono text-gray-300">
                                    {fmtLakh(odUtilizedAmt)} / {fmtLakh(odLimit)} ({odUtilizedPct.toFixed(0)}%)
                                </span>
                            </div>
                            <div className="w-full bg-gray-800/60 rounded-full h-1.5 overflow-hidden border border-gray-700/30">
                                <div
                                    className={`h-full rounded-full transition-all duration-500 ${
                                        isOverdraftLimitBreached ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]' :
                                        isUtilizingOverdraft ? 'bg-amber-500' : 'bg-emerald-500/80'
                                    }`}
                                    style={{ width: `${Math.min(odUtilizedPct, 100)}%` }}
                                />
                            </div>
                            <div className="flex justify-between items-center text-[8px] text-gray-600 mt-1">
                                <span>0% CC</span>
                                <span>Sanctioned Limit: -{fmtLakh(odLimit)}</span>
                            </div>
                        </div>

                        {/* 30D stats */}
                        <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-gray-800/40">
                            <div>
                                <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">30D Inflows</div>
                                <div className="text-emerald-400 font-bold text-sm font-mono tabular-nums">{fmtLakh(isSimulating ? simTotalInflow : totalInflow)}</div>
                            </div>
                            <div>
                                <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">30D Outflows</div>
                                <div className="text-red-400 font-bold text-sm font-mono tabular-nums">-{fmtLakh(isSimulating ? simTotalOutflow : totalOutflow)}</div>
                            </div>
                            <div>
                                <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">Net Flow</div>
                                <div className={`font-bold text-sm font-mono tabular-nums ${(isSimulating ? simNetFlow : netFlow) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                    {(isSimulating ? simNetFlow : netFlow) >= 0 ? '+' : ''}{fmtLakh(isSimulating ? simNetFlow : netFlow)}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right KPI Cards */}
                <div className="space-y-3">
                    {/* Cash Runway — NEW */}
                    <div className={`rounded-xl border p-4 glass-panel transition-all duration-300 hover:-translate-y-1 ${
                        runwayDays <= 30 ? 'bg-red-900/20 border-red-700/40 shadow-glow-amber' :
                        runwayDays <= 60 ? 'bg-amber-900/20 border-amber-700/40 shadow-glow-amber' :
                        'bg-[#0F1318]/60 border-white/5 shadow-2xl hover:shadow-glow-indigo'
                    }`}>
                        <div className="flex items-center justify-between mb-1">
                            <div className="text-[10px] text-gray-500 uppercase tracking-wider">Cash Runway</div>
                            <RunwayBadge days={runwayDays} />
                        </div>
                        <div className={`text-2xl font-black tracking-tight tabular-nums ${runwayDays <= 30 ? 'text-red-400' : runwayDays <= 60 ? 'text-amber-400' : 'text-white'}`}>
                            {runwayDays}
                            <span className="text-sm font-normal text-gray-500 ml-1">days</span>
                        </div>
                        <div className="text-[10px] text-gray-600 mt-0.5">
                            At {fmtLakh(avgDailyBurn)}/day burn rate
                        </div>
                    </div>

                    <div className="bg-[#0F1318]/60 border border-white/5 rounded-xl p-4 glass-panel shadow-2xl transition-all duration-300 hover:-translate-y-1 hover:border-white/10">
                        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Active Alerts</div>
                        <div className="flex items-end gap-2">
                            <span className="text-2xl font-black tracking-tight tabular-nums text-white">{snapshot.active_alerts.length}</span>
                            {overdueCount > 0 && (
                                <span className="text-xs text-red-400 mb-0.5 tracking-tight font-bold">{overdueCount} high priority</span>
                            )}
                        </div>
                    </div>

                    <div className="bg-[#0F1318]/60 border border-white/5 rounded-xl p-4 glass-panel shadow-2xl transition-all duration-300 hover:-translate-y-1 hover:border-white/10">
                        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Upcoming Obligations</div>
                        <div className="text-2xl font-black tracking-tight tabular-nums text-white">{snapshot.upcoming_obligations.length}</div>
                        <div className="text-[10px] text-gray-600 mt-0.5">next 30 days</div>
                    </div>
                </div>
            </div>

            {/* ─ MULTI-BANK LIQUIDITY & SMART SWEEP ────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-2 bg-[#0F1318]/60 border border-white/5 rounded-2xl p-5 glass-panel shadow-2xl transition-all duration-300 hover:border-white/10">
                    <h3 className="text-sm font-semibold text-gray-200 mb-4 flex items-center gap-2">
                        🏦 Multi-Bank Liquidity Map
                    </h3>
                    <div className="space-y-3">
                        {snapshot.accounts.map(acc => (
                            <div key={acc.account_id} className="flex justify-between items-center p-3 rounded-xl bg-[#0a0d11]/50 border border-gray-800/60">
                                <div>
                                    <div className="flex items-center gap-2">
                                        <div className="w-6 h-6 rounded bg-gradient-to-br from-gray-800 to-gray-900 flex items-center justify-center font-bold text-[10px]">
                                            {acc.bank_name.substring(0,1)}
                                        </div>
                                        <span className="font-bold text-gray-300 text-sm">{acc.bank_name}</span>
                                        <span className="text-[9px] font-mono text-gray-500 bg-gray-900 px-1.5 py-0.5 rounded">{acc.account_type}</span>
                                    </div>
                                    <div className="text-[10px] text-gray-500 font-mono mt-1 pl-8">*{acc.masked_number} · AA SYNCED</div>
                                </div>
                                <div className={`text-right font-mono font-bold ${acc.balance >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                    {fmt(acc.balance)}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Smart Sweep Recommendation */}
                <div className="bg-gradient-to-br from-indigo-900/20 to-blue-900/10 border border-indigo-500/20 rounded-2xl p-5 glass-panel shadow-glow-indigo relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/10 blur-2xl rounded-full" />
                    <h3 className="text-sm font-semibold text-indigo-300 mb-2 flex items-center gap-2">
                        ⚡ Smart Sweep
                        <span className="text-[9px] bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded border border-indigo-500/30 animate-pulse">ORCHESTRATION</span>
                    </h3>
                    {snapshot.accounts.some(a => a.balance < 0) && snapshot.accounts.some(a => a.balance > 0) ? (
                        <div className="mt-4 relative z-10">
                            <p className="text-xs text-gray-300 leading-relaxed mb-4">
                                You are utilizing a high-interest credit facility while holding idle cash. Sweep funds to reduce your interest burden instantly.
                            </p>
                            <div className="p-3 bg-black/40 rounded-xl border border-indigo-500/20 mb-4">
                                <div className="flex justify-between text-[10px] text-gray-400 mb-1">
                                    <span>From: {snapshot.accounts.find(a => a.balance > 0)?.bank_name}</span>
                                    <span>To: {snapshot.accounts.find(a => a.balance < 0)?.bank_name}</span>
                                </div>
                                <div className="flex justify-between font-mono font-bold text-sm">
                                    <span className="text-emerald-400">{fmt(snapshot.accounts.find(a => a.balance > 0)?.balance || 0)}</span>
                                    <span className="text-red-400">{fmt(snapshot.accounts.find(a => a.balance < 0)?.balance || 0)}</span>
                                </div>
                            </div>
                            <button className="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-[10px] tracking-wider transition-all shadow-[0_0_15px_rgba(79,70,229,0.3)] active:scale-95">
                                SWEEP FUNDS NOW
                            </button>
                        </div>
                    ) : (
                        <div className="mt-6 flex flex-col items-center text-center opacity-60 relative z-10">
                            <div className="text-2xl mb-2">⚖️</div>
                            <p className="text-xs text-gray-400">Liquidity is optimally balanced.</p>
                            <p className="text-[10px] text-gray-500 mt-1">No sweep required.</p>
                        </div>
                    )}
                </div>
            </div>

            {/* ─ GSTR COMPLIANCE CALENDAR ──────────────────────────── */}
            <div className="bg-[#0F1318]/60 border border-white/5 rounded-2xl p-5 glass-panel shadow-2xl transition-all duration-300 hover:border-white/10">
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                            📅 GST & Tax Compliance Calendar
                            <span className="text-[9px] bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded border border-amber-500/30 font-bold">INDIA-SPECIFIC</span>
                        </h3>
                        <p className="text-[10px] text-gray-600 mt-0.5">Upcoming statutory filing deadlines for your business</p>
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                    {gstrEvents.map((ev, i) => {
                        const days = daysUntil(ev.date);
                        const isUrgent = days <= 7;
                        const isSoon   = days <= 15;
                        return (
                            <div key={i} className={`rounded-xl border p-3 flex flex-col gap-1.5 ${ev.color} ${isUrgent ? 'animate-pulse-slow' : ''}`}>
                                <div className={`text-[9px] font-bold uppercase tracking-widest ${ev.urgencyColor}`}>{ev.label}</div>
                                <div className="text-xs font-semibold text-gray-300 leading-snug">{ev.detail}</div>
                                <div className="flex items-center justify-between mt-auto pt-1">
                                    <span className="font-mono text-[10px] text-gray-400">
                                        {ev.date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                                    </span>
                                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                                        isUrgent ? 'bg-red-500/20 text-red-400 border border-red-500/30 animate-pulse' :
                                        isSoon   ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' :
                                                   'bg-gray-800 text-gray-500 border border-gray-700/50'
                                    }`}>
                                        {days <= 0 ? 'TODAY' : `${days}D`}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* ─ FORECAST SIMULATOR (collapsible) ─────────────────── */}
            <div className="bg-[#0F1318] border border-gray-800/60 rounded-2xl overflow-hidden">
                {/* Header — always visible, click to toggle */}
                <button
                    onClick={() => setSimulatorOpen(v => !v)}
                    className="w-full flex items-center justify-between p-5 text-left hover:bg-white/[0.02] transition-colors group"
                >
                    <div>
                        <div className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                            <span>🔮 Interactive Cash Forecast Simulator</span>
                            <span className="text-[9px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded border border-blue-500/30">TREASURY GRADE</span>
                            {isSimulating && (
                                <span className="text-[9px] bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded border border-indigo-500/30 animate-pulse">ACTIVE</span>
                            )}
                        </div>
                        <div className="text-[10px] text-gray-600 mt-0.5">Simulate hiring, CAPEX investments & customer payment delays</div>
                    </div>
                    <div className="flex items-center gap-2">
                        {isSimulating && (
                            <span
                                onClick={(e) => { e.stopPropagation(); setSimHiresCount(0); setSimMachineryAmt(0); setSimPaymentDelayPct(0); }}
                                className="text-[9px] text-red-400 bg-red-950/20 px-2 py-1 rounded border border-red-900/40 hover:bg-red-900/30 transition-colors font-medium cursor-pointer"
                            >
                                Reset
                            </span>
                        )}
                        <span className={`text-gray-500 transition-transform duration-200 ${simulatorOpen ? 'rotate-180' : ''}`}>▼</span>
                    </div>
                </button>

                {simulatorOpen && (
                    <div className="px-5 pb-5 border-t border-gray-800/40 pt-4">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                            {/* Hires */}
                            <div className="p-4 rounded-xl border bg-[#0a0d11]/30 border-gray-800 space-y-3">
                                <div className="flex justify-between items-center">
                                    <span className="text-xs font-semibold text-gray-200">New Employee Hires</span>
                                    <span className="text-[10px] font-mono text-indigo-400 font-bold">{simHiresCount} Staff</span>
                                </div>
                                <p className="text-[9px] text-gray-500 leading-normal">Adds ₹50,000/month in payroll outflows per employee.</p>
                                <input
                                    type="number" min="0" max="50"
                                    value={simHiresCount || ''}
                                    onChange={e => setSimHiresCount(Math.max(0, parseInt(e.target.value) || 0))}
                                    placeholder="Number of hires"
                                    className="w-full bg-[#0a0d11] text-xs px-2.5 py-1.5 rounded border border-gray-800 text-gray-300 outline-none focus:border-indigo-600"
                                />
                            </div>

                            {/* CAPEX */}
                            <div className="p-4 rounded-xl border bg-[#0a0d11]/30 border-gray-800 space-y-3">
                                <div className="flex justify-between items-center">
                                    <span className="text-xs font-semibold text-gray-200">Capital Machinery Outlay</span>
                                    <span className="text-[10px] font-mono text-indigo-400 font-bold">{fmtLakh(simMachineryAmt)}</span>
                                </div>
                                <p className="text-[9px] text-gray-500 leading-normal">One-time capital expenditure hit on final period.</p>
                                <input
                                    type="number" min="0" step="100000"
                                    value={simMachineryAmt || ''}
                                    onChange={e => setSimMachineryAmt(Math.max(0, parseInt(e.target.value) || 0))}
                                    placeholder="Enter amount in ₹"
                                    className="w-full bg-[#0a0d11] text-xs px-2.5 py-1.5 rounded border border-gray-800 text-gray-300 outline-none focus:border-indigo-600"
                                />
                            </div>

                            {/* Delay */}
                            <div className="p-4 rounded-xl border bg-[#0a0d11]/30 border-gray-800 space-y-3">
                                <div className="flex justify-between items-center">
                                    <span className="text-xs font-semibold text-gray-200">Customer Payment Delay</span>
                                    <span className="text-[10px] font-mono text-indigo-400 font-bold">{simPaymentDelayPct}% Delay</span>
                                </div>
                                <p className="text-[9px] text-gray-500 leading-normal">Reduces immediate inflows up to 70% at full delay.</p>
                                <div className="flex items-center gap-2 pt-1">
                                    <span className="text-[9px] text-gray-600 font-mono">0%</span>
                                    <input
                                        type="range" min="0" max="100"
                                        value={simPaymentDelayPct}
                                        onChange={e => setSimPaymentDelayPct(parseInt(e.target.value))}
                                        className="flex-1 accent-indigo-500 h-1 rounded"
                                    />
                                    <span className="text-[9px] text-gray-600 font-mono">100%</span>
                                </div>
                            </div>
                        </div>

                        {isSimulating && (
                            <div className={`mt-4 p-4 rounded-xl border flex items-center justify-between gap-3 ${
                                isOverdraftLimitBreached ? 'bg-red-950/25 border-red-700/30' :
                                isUtilizingOverdraft    ? 'bg-amber-950/20 border-amber-800/30' :
                                'bg-blue-950/15 border-blue-800/30'
                            }`}>
                                <div>
                                    <div className={`text-xs font-bold uppercase tracking-wider ${
                                        isOverdraftLimitBreached ? 'text-red-400' :
                                        isUtilizingOverdraft ? 'text-amber-400' : 'text-blue-400'
                                    }`}>
                                        {isOverdraftLimitBreached ? '🚨 CRITICAL OVERDRAFT BREACH' :
                                         isUtilizingOverdraft ? '⚠️ OD LINE UTILIZED' : '✅ STABLE OUTLOOK'}
                                    </div>
                                    <p className="text-[10px] text-gray-400 leading-relaxed mt-1">
                                        {isOverdraftLimitBreached
                                            ? `Simulated balance (${fmtLakh(simulatedBalance)}) breaches your ${fmtLakh(odLimit)} OD limit. Secure bridge financing immediately.`
                                            : isUtilizingOverdraft
                                            ? `Simulated balance negative (${fmtLakh(simulatedBalance)}). CC line engaged. Monitor interest outflow.`
                                            : `Simulated balance remains positive at ${fmtLakh(simulatedBalance)}.`}
                                    </p>
                                </div>
                                <div className="text-right whitespace-nowrap shrink-0">
                                    <div className="text-[10px] text-gray-500 font-semibold uppercase">Simulated</div>
                                    <div className={`text-lg font-black font-mono ${
                                        isOverdraftLimitBreached ? 'text-red-400' :
                                        isUtilizingOverdraft ? 'text-amber-400' : 'text-emerald-400'
                                    }`}>{fmtLakh(simulatedBalance)}</div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* ─ AI CASHFLOW ADVISOR ──────────────────────────── */}
            <div className="bg-[#0F1318] border border-gray-800/60 rounded-2xl p-5 overflow-hidden relative ai-advisor-card">
                <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/5 blur-[50px] rounded-full pointer-events-none"></div>
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                    <div>
                        <div className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                            <span>🧠 CashIQ Nexus Intelligence</span>
                            <span className="text-[9px] bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded border border-indigo-500/30 font-bold tracking-widest">LLAMA 3 LOCAL</span>
                        </div>
                        <div className="text-[10px] text-gray-500 mt-0.5">Generate highly contextual, treasury-grade financial advice from your live data securely on-device.</div>
                    </div>
                    <button
                        onClick={fetchAiAdvice}
                        disabled={loadingAi || !isAuthorizedForAi}
                        title={!isAuthorizedForAi ? "Restricted: Operator session is authorized only for Coimbatore Textile Mills Pvt Ltd" : undefined}
                        className="shrink-0 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-800 disabled:text-gray-500 text-white force-white text-xs font-bold rounded-lg transition-colors border border-indigo-500 shadow-[0_0_15px_rgba(79,70,229,0.3)] disabled:cursor-not-allowed"
                    >
                        {loadingAi ? 'ANALYZING...' : !isAuthorizedForAi ? 'RESTRICTED (DEMO OPERATOR)' : 'GENERATE AI ADVICE'}
                    </button>
                </div>

                {!isAuthorizedForAi && (
                    <div className="mt-4 p-3.5 border border-amber-600/40 bg-amber-950/20 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                        <div className="flex items-start gap-2.5">
                            <span className="text-amber-400 text-base">⚠️</span>
                            <div>
                                <div className="font-semibold text-amber-200">Local Operator Authorization Restricted</div>
                                <div className="text-[11px] text-amber-300/80 mt-0.5">
                                    Your authenticated local demo session is authorized exclusively for <strong>Coimbatore Textile Mills Pvt Ltd</strong>. Cross-business AI advisory is disabled to enforce tenant isolation.
                                </div>
                            </div>
                        </div>
                        {onSelectBusiness && (
                            <button
                                onClick={() => onSelectBusiness(PRIMARY_AUTHORIZED_BUSINESS_ID)}
                                className="shrink-0 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-lg text-xs transition-colors"
                            >
                                Switch to Authorized Business
                            </button>
                        )}
                    </div>
                )}

                {(aiAdvice || loadingAi) && (
                    <div className="mt-4 p-4 border border-indigo-900/40 bg-indigo-950/20 rounded-xl relative">
                        {loadingAi ? (
                            <div className="flex items-center gap-3 text-indigo-400 text-xs font-mono animate-pulse">
                                <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                                Running local inference on LLaMA 3 parameters...
                            </div>
                        ) : (
                            <div className="text-sm text-indigo-100 leading-relaxed">
                                <ReactMarkdown 
                                    components={{
                                        h1: ({ ...props }) => <h1 className="text-lg font-bold text-white mb-2" {...props} />,
                                        h2: ({ ...props }) => <h2 className="text-md font-bold text-indigo-300 mt-4 mb-2 uppercase tracking-wide" {...props} />,
                                        h3: ({ ...props }) => <h3 className="text-sm font-bold text-indigo-200 mt-3 mb-1" {...props} />,
                                        p: ({ ...props }) => <p className="mb-3 text-indigo-100/90" {...props} />,
                                        ul: ({ ...props }) => <ul className="list-disc pl-5 space-y-1 mb-3 text-indigo-100/90" {...props} />,
                                        li: ({ ...props }) => <li {...props} />,
                                        strong: ({ ...props }) => <strong className="font-semibold text-indigo-50" {...props} />
                                    }}
                                >
                                    {aiAdvice}
                                </ReactMarkdown>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* ─ CASH FLOW BAR CHART ───────────────────────────────── */}
            <div className="bg-[#0F1318]/60 border border-white/5 rounded-2xl p-5 glass-panel shadow-2xl transition-all duration-300 hover:border-white/10">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
                    <div>
                        <div className="text-sm font-semibold text-gray-200">
                            Cash Flow Timeline {isSimulating && <span className="text-xs text-blue-400 font-normal">(Simulated)</span>}
                        </div>
                        <div className="text-[10px] text-gray-600 mt-0.5">Aggregated cash inflow vs outflow volumes — Indian Rupee</div>
                    </div>

                    <div className="flex items-center gap-4">
                        <div className="flex border border-gray-800 bg-[#0a0d11] p-0.5 rounded-lg">
                            {(['DAILY', 'WEEKLY', 'MONTHLY'] as const).map(mode => (
                                <button
                                    key={mode}
                                    onClick={() => setTimeframe(mode)}
                                    className={`text-[9px] font-bold px-2.5 py-1 rounded transition-colors uppercase ${
                                        timeframe === mode ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-gray-300'
                                    }`}
                                >
                                    {mode}
                                </button>
                            ))}
                        </div>
                        <div className="flex items-center gap-3 text-[10px]">
                            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-emerald-500/70 inline-block" /> Inflow</span>
                            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-red-500/70 inline-block" /> Outflow</span>
                            <span className="flex items-center gap-1.5"><span className="w-2.5 h-0.5 bg-blue-500 inline-block" /> Cash Position</span>
                        </div>
                    </div>
                </div>

                {snapshot.monthly_flow.length > 0 ? (
                    <ResponsiveContainer width="100%" height={180}>
                        <ComposedChart data={finalChartData} barSize={timeframe === 'DAILY' ? 8 : 28} barGap={2}>
                            <defs>
                                <linearGradient id="colorInflow" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.8}/>
                                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.1}/>
                                </linearGradient>
                                <linearGradient id="colorOutflow" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#f87171" stopOpacity={0.8}/>
                                    <stop offset="95%" stopColor="#f87171" stopOpacity={0.1}/>
                                </linearGradient>
                                <linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.5}/>
                                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="#ffffff" strokeOpacity={0.05} vertical={false} />
                            <XAxis
                                dataKey="date"
                                tick={{ fill: '#4b5563', fontSize: 9 }}
                                tickFormatter={d => timeframe === 'DAILY' ? d.slice(5) : d}
                                axisLine={false} tickLine={false} interval="preserveStartEnd"
                            />
                            <YAxis
                                tick={{ fill: '#4b5563', fontSize: 9 }}
                                tickFormatter={v => fmtLakh(v)}
                                axisLine={false} tickLine={false} width={62}
                            />
                            <Tooltip content={<FlowTooltip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                            <ReferenceLine y={0} stroke="#ffffff" strokeOpacity={0.1} strokeDasharray="3 3" />
                            <Area type="monotone" dataKey="balance" fill="url(#colorBalance)" stroke="none" />
                            <Bar dataKey="inflow"  fill="url(#colorInflow)" radius={[3, 3, 0, 0]} />
                            <Bar dataKey="outflow" fill="url(#colorOutflow)" radius={[3, 3, 0, 0]} />
                            <Line type="monotone" dataKey="balance" stroke="#3b82f6" strokeWidth={2} dot={false} name="Cash Position" />
                        </ComposedChart>
                    </ResponsiveContainer>
                ) : (
                    <div className="h-44 flex flex-col items-center justify-center text-gray-600 gap-2">
                        <div className="text-3xl opacity-30">📊</div>
                        <div className="text-sm">No transactions yet</div>
                        <div className="text-xs">Import a bank statement or sync Zoho Books to see cash flow</div>
                    </div>
                )}
            </div>

            {/* ─ BUDGET TRACKER (with editable targets) ────────────── */}
            <div className="bg-[#0F1318]/60 border border-white/5 rounded-2xl p-5 glass-panel shadow-2xl transition-all duration-300 hover:border-white/10">
                <div className="flex items-center justify-between mb-1">
                    <h3 className="text-xs font-bold text-gray-200 uppercase tracking-widest flex items-center gap-1.5">
                        <span>📊 Outflow Budget Tracker</span>
                        <span className="text-[8px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-500/30">MONTHLY</span>
                    </h3>
                    <span className="text-[9px] text-gray-600 font-mono">Click budget amount to edit</span>
                </div>
                <p className="text-[10px] text-gray-600 mb-4">
                    Monitor actual monthly tax and operating outflows against target budget ceilings.
                </p>

                {loadingTxns ? (
                    <div className="text-center text-gray-600 text-xs py-4 animate-pulse">Loading budget actuals...</div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {Object.entries(DEFAULT_BUDGETS).map(([catKey, meta]) => {
                            const actual        = getActual(catKey);
                            const budget        = budgets[catKey] ?? meta.budget;
                            const utilPct       = (actual / budget) * 100;
                            const isOver        = actual > budget;
                            const isWarning     = actual >= budget * 0.8 && !isOver;
                            const barColor      = isOver ? 'bg-red-500' : isWarning ? 'bg-amber-500' : 'bg-emerald-500';
                            const textColor     = isOver ? 'text-red-400' : isWarning ? 'text-amber-400' : 'text-emerald-400';
                            const isEditing     = editingBudget === catKey;

                            return (
                                <div key={catKey} className="border border-gray-800/60 bg-[#0a0d11]/25 rounded-xl p-3.5 space-y-2.5">
                                    <div className="flex justify-between items-start text-[10px]">
                                        <div className="flex items-center gap-1.5">
                                            <span>{meta.icon}</span>
                                            <span className="font-semibold text-gray-300">{meta.label}</span>
                                        </div>
                                        <div className="text-right">
                                            <div className={`font-bold ${textColor}`}>
                                                {fmtLakh(actual)} / {' '}
                                                {isEditing ? (
                                                    <input
                                                        autoFocus
                                                        type="number"
                                                        value={editBudgetValue}
                                                        onChange={e => setEditBudgetValue(e.target.value)}
                                                        onBlur={() => saveBudget(catKey)}
                                                        onKeyDown={e => { if (e.key === 'Enter') saveBudget(catKey); if (e.key === 'Escape') setEditingBudget(null); }}
                                                        className="w-20 bg-[#161B22] border border-indigo-600 rounded px-1 py-0.5 text-[10px] text-white outline-none font-mono"
                                                    />
                                                ) : (
                                                    <button
                                                        onClick={() => { setEditingBudget(catKey); setEditBudgetValue(String(budget)); }}
                                                        className="font-mono text-gray-400 hover:text-indigo-400 hover:underline transition-colors cursor-pointer"
                                                        title="Click to edit budget"
                                                    >
                                                        {fmtLakh(budget)}
                                                    </button>
                                                )}
                                                {' '}
                                                <span className="text-gray-600">({utilPct.toFixed(0)}%)</span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="w-full bg-gray-800 h-1.5 rounded-full overflow-hidden">
                                        <div
                                            className={`h-full rounded-full transition-all duration-500 ${barColor}`}
                                            style={{ width: `${Math.min(utilPct, 100)}%` }}
                                        />
                                    </div>
                                    {isOver && (
                                        <div className="text-[8px] text-red-400 font-mono">
                                            ⚠ Over budget by {fmtLakh(actual - budget)}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ─ OBLIGATIONS + ALERTS (2 column) ──────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {/* Upcoming Obligations */}
                <div className="bg-[#0F1318]/60 border border-white/5 rounded-2xl p-5 glass-panel shadow-2xl transition-all duration-300 hover:border-white/10">
                    <div className="text-sm font-semibold text-gray-200 mb-4">Upcoming Obligations</div>
                    {snapshot.upcoming_obligations.length === 0 ? (
                        <div className="flex flex-col items-center py-8 gap-2">
                            <div className="text-2xl opacity-40">✅</div>
                            <div className="text-gray-600 text-xs">No obligations in the next 30 days</div>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {snapshot.upcoming_obligations.slice(0, 5).map(ob => (
                                <div key={ob.id} className={`border-l-2 pl-3 py-2 pr-3 rounded-r-lg ${obligationColor(ob)}`}>
                                    <div className="flex items-center justify-between">
                                        <div className="text-xs text-gray-300 font-medium truncate max-w-[180px]">{ob.description}</div>
                                        {obligationBadge(ob)}
                                    </div>
                                    <div className="flex items-center justify-between mt-0.5">
                                        <div className="text-[10px] text-gray-500">{ob.due_date}</div>
                                        {ob.amount !== null && ob.amount > 0 && (
                                            <div className="text-[10px] font-mono text-gray-400">{fmtLakh(ob.amount)}</div>
                                        )}
                                    </div>
                                </div>
                            ))}
                            {snapshot.upcoming_obligations.length > 5 && (
                                <div className="text-[10px] text-gray-600 text-center pt-1">
                                    +{snapshot.upcoming_obligations.length - 5} more — see Obligations tab
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Active Alerts */}
                <div className="bg-[#0F1318]/60 border border-white/5 rounded-2xl p-5 glass-panel shadow-2xl transition-all duration-300 hover:-translate-y-1 hover:border-white/10">
                    <div className="text-sm font-semibold text-gray-200 mb-4">Active Alerts</div>
                    {snapshot.active_alerts.length === 0 ? (
                        <div className="flex flex-col items-center py-8 gap-2">
                            <div className="text-2xl opacity-40">🔔</div>
                            <div className="text-gray-600 text-xs">No active alerts — all looks good</div>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {snapshot.active_alerts.slice(0, 4).map(alert => {
                                const c = severityColor(alert.severity);
                                return (
                                    <div key={alert.event_id} className={`border rounded-lg px-3 py-2.5 ${c.bg} ${c.border}`}>
                                        <div className="flex items-center gap-2 mb-0.5">
                                            <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                                            <span className={`text-[10px] font-bold uppercase tracking-wider ${c.text}`}>{alert.severity}</span>
                                        </div>
                                        <div className="text-xs text-gray-200 font-medium">{alert.title}</div>
                                        <div className="text-[10px] text-gray-500 mt-0.5 leading-relaxed line-clamp-2">{alert.message}</div>
                                    </div>
                                );
                            })}
                            {snapshot.active_alerts.length > 4 && (
                                <div className="text-[10px] text-gray-600 text-center pt-1">
                                    +{snapshot.active_alerts.length - 4} more — see Alerts tab
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* ─ SAGA MAKER-CHECKER APPROVALS & RECONCILIATION ──────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {/* Approvals Queue */}
                <div className="bg-[#0F1318]/60 border border-white/5 rounded-2xl p-5 glass-panel shadow-2xl transition-all duration-300 hover:border-white/10">
                    <div className="text-sm font-semibold text-gray-200 mb-4 flex items-center justify-between">
                        <span>Maker-Checker Approvals</span>
                        <span className="text-[9px] bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded border border-indigo-500/30 tracking-widest font-bold">CFO QUEUE</span>
                    </div>
                    {approvals.length === 0 ? (
                        <div className="flex flex-col items-center py-8 gap-2">
                            <div className="text-2xl opacity-40">🔐</div>
                            <div className="text-gray-600 text-xs">No pending SAGA executions</div>
                        </div>
                    ) : (
                        <div className="space-y-2 max-h-[300px] overflow-y-auto">
                            {approvals.map(app => (
                                <div key={app.instruction_id} className="border border-indigo-900/30 bg-indigo-900/10 rounded-lg p-3">
                                    <div className="flex justify-between items-start mb-2">
                                        <div>
                                            <div className="text-xs font-bold text-gray-200">{app.seller_name || app.buyer_name || 'Vendor'}</div>
                                            <div className="text-[9px] text-gray-500 font-mono mt-0.5">INV: {app.invoice_id}</div>
                                        </div>
                                        <div className="text-right">
                                            <div className="text-xs font-bold text-white tabular-nums font-mono">
                                                {globalFormatter.code === 'INR' ? '₹' : globalFormatter.code === 'USD' ? '$' : globalFormatter.code === 'EUR' ? '€' : globalFormatter.code === 'GBP' ? '£' : globalFormatter.code} 
                                                {new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(parseFloat(app.amount) / globalFormatter.rate)}
                                            </div>
                                            <div className="text-[8px] text-amber-400 tracking-wider mt-0.5">AWAITING SIGN-OFF</div>
                                        </div>
                                    </div>
                                    <button 
                                        onClick={async () => {
                                            const res = await fetch(`/api/zoho/approve/${app.instruction_id}`, { method: 'POST' });
                                            if (res.ok) {
                                                setApprovals(prev => prev.filter(x => x.instruction_id !== app.instruction_id));
                                                setChatMessages(prev => [...prev, { role: 'assistant', content: `🔐 **SAGA Executed**\nInstruction ${app.instruction_id} has been signed off and is now processing on the blockchain rails.` }]);
                                            }
                                        }}
                                        className="w-full mt-2 bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 rounded py-1.5 px-3 font-bold text-[10px] uppercase tracking-wider flex items-center justify-center gap-2 transition-all shadow-[0_0_10px_rgba(16,185,129,0.05)] hover:shadow-[0_0_15px_rgba(16,185,129,0.15)]"
                                    >
                                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)] animate-pulse"></span>
                                        APPROVE & EXECUTE
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Auto-Reconciliation Engine */}
                <div className="bg-[#0F1318]/60 border border-white/5 rounded-2xl p-5 glass-panel shadow-2xl transition-all duration-300 hover:border-white/10">
                    <div className="text-sm font-semibold text-gray-200 mb-4 flex items-center justify-between">
                        <span>Auto-Reconciliation Engine</span>
                        <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-500/30 tracking-widest font-bold">100% CONFIDENCE</span>
                    </div>
                    {reconciliations.length === 0 ? (
                        <div className="flex flex-col items-center py-8 gap-2">
                            <div className="text-2xl opacity-40">🔄</div>
                            <div className="text-gray-600 text-xs">Waiting for settlements...</div>
                        </div>
                    ) : (
                        <div className="space-y-2 max-h-[300px] overflow-y-auto">
                            {reconciliations.map(rec => (
                                <div key={rec.id} className="border border-gray-800/60 bg-[#0a0d11]/50 rounded-lg p-3 flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-full bg-emerald-900/30 border border-emerald-700/50 flex items-center justify-center shrink-0 shadow-[0_0_10px_rgba(16,185,129,0.1)]">
                                        <span className="text-emerald-400 text-xs font-bold">✓</span>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[10px] text-gray-400 font-mono truncate">Inst: {rec.instruction_id.slice(0, 13)}...</div>
                                        <div className="text-xs font-medium text-gray-200 truncate flex items-center gap-1.5 mt-0.5">
                                            <span>{rec.seller_name || 'Vendor'}</span>
                                            <span className="text-gray-600">→</span>
                                            <span className="text-emerald-400 font-bold">Zoho Books</span>
                                        </div>
                                    </div>
                                    <div className="text-right shrink-0">
                                        <div className="text-[10px] font-bold text-gray-300 font-mono tabular-nums">
                                            {globalFormatter.code === 'INR' ? '₹' : globalFormatter.code === 'USD' ? '$' : globalFormatter.code === 'EUR' ? '€' : globalFormatter.code === 'GBP' ? '£' : globalFormatter.code} 
                                            {new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(parseFloat(rec.amount) / globalFormatter.rate)}
                                        </div>
                                        <div className="text-[8px] text-emerald-500 tracking-wider mt-0.5 font-bold">RECONCILED</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* ─ FLOATING CFO CHAT ─────────────────────────────── */}
            <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end pointer-events-none">
                {isChatOpen && (
                    <div className="bg-[#0F1318]/80 border border-indigo-500/30 rounded-2xl w-80 sm:w-96 mb-4 shadow-glow-indigo glass-panel flex flex-col overflow-hidden pointer-events-auto ai-advisor-card">
                        <div className="bg-indigo-950/40 border-b border-indigo-500/30 p-4 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <span className="text-lg">🧠</span>
                                <span className="text-sm font-bold text-indigo-100">CFO Copilot</span>
                                <span className="text-[9px] bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded border border-indigo-500/30 font-bold tracking-widest">LIVE</span>
                            </div>
                            <button onClick={() => setIsChatOpen(false)} className="text-gray-400 hover:text-white">&times;</button>
                        </div>
                        {!isAuthorizedForAi && (
                            <div className="p-3 bg-amber-950/40 border-b border-amber-500/30 text-amber-200 text-xs flex flex-col gap-1.5">
                                <div className="flex items-center gap-1.5 font-bold text-amber-400">
                                    <span>⚠️</span> Operator Access Restricted
                                </div>
                                <p className="text-[11px] text-amber-300/80 leading-relaxed">
                                    AI Chat is restricted to the primary authorized business (Coimbatore Textile Mills Pvt Ltd).
                                </p>
                                {onSelectBusiness && (
                                    <button
                                        type="button"
                                        onClick={() => onSelectBusiness(PRIMARY_AUTHORIZED_BUSINESS_ID)}
                                        className="self-start text-[10px] px-2.5 py-1 bg-amber-600 hover:bg-amber-500 rounded font-bold text-white transition-colors"
                                    >
                                        Switch to Coimbatore Textile Mills
                                    </button>
                                )}
                            </div>
                        )}
                        <div className="h-80 overflow-y-auto p-4 space-y-4 flex flex-col">
                            {chatMessages.length === 0 && (
                                <div className="text-center text-xs text-gray-500 mt-4 leading-relaxed">
                                    {isAuthorizedForAi
                                        ? "Ask me anything about your cashflow, or request an email draft for overdue payments."
                                        : "Operator session is restricted to Coimbatore Textile Mills Pvt Ltd. Switch business to chat."}
                                </div>
                            )}
                            {chatMessages.map((msg, idx) => (
                                <div key={idx} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                                    <div className={`px-3 py-2 rounded-xl text-xs max-w-[85%] ${msg.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-[#161B22] text-gray-200 border border-gray-800'}`}>
                                        <ReactMarkdown
                                            components={{
                                                p: ({ ...props }) => <p className="mb-1 last:mb-0 leading-relaxed" {...props} />,
                                                ul: ({ ...props }) => <ul className="list-disc pl-4 space-y-1 mb-1" {...props} />,
                                            }}
                                        >{msg.content}</ReactMarkdown>
                                    </div>
                                </div>
                            ))}
                            {isChatLoading && (
                                <div className="flex items-start">
                                    <div className="px-3 py-2 rounded-xl text-xs bg-[#161B22] border border-gray-800 text-gray-400 flex items-center gap-2 animate-pulse">
                                        <div className="w-3 h-3 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                                        Analyzing...
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className="p-3 bg-[#0a0d11] border-t border-gray-800/60">
                            <form onSubmit={(e) => { e.preventDefault(); sendChatMessage(); }} className="flex gap-2">
                                <input 
                                    type="text" 
                                    value={chatInput}
                                    onChange={e => setChatInput(e.target.value)}
                                    placeholder={isAuthorizedForAi ? "Type your question..." : "Disabled: Switch to Coimbatore Textile Mills"}
                                    disabled={!isAuthorizedForAi || isChatLoading}
                                    className="flex-1 bg-[#161B22] border border-gray-800 text-sm text-gray-200 rounded-lg px-3 py-2 outline-none focus:border-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                                />
                                <button 
                                    type="submit"
                                    disabled={!isAuthorizedForAi || !chatInput.trim() || isChatLoading}
                                    className="bg-indigo-600 disabled:bg-gray-800 disabled:text-gray-500 text-white px-3 rounded-lg text-xs font-bold transition-colors force-white disabled:cursor-not-allowed"
                                >
                                    SEND
                                </button>
                            </form>
                        </div>
                    </div>
                )}
                <button
                    onClick={() => setIsChatOpen(!isChatOpen)}
                    className="w-14 h-14 bg-indigo-600 hover:bg-indigo-500 text-white force-white rounded-full flex items-center justify-center shadow-[0_0_20px_rgba(79,70,229,0.4)] pointer-events-auto transition-transform hover:scale-105"
                >
                    <span className="text-2xl leading-none">{isChatOpen ? '×' : '💬'}</span>
                </button>
            </div>
        </div>
    );
}
