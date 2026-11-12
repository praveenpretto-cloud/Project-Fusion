'use client';

import { useState, useEffect, useCallback } from 'react';
import CashOverviewTab, { type Snapshot } from './components/cashiq/CashOverviewTab';
import ObligationsTab, { type Obligation } from './components/cashiq/ObligationsTab';
import AlertsTab, { type AlertEvent, type AlertRule } from './components/cashiq/AlertsTab';
import AccountsPanel, { type Account } from './components/cashiq/AccountsPanel';
import CAWorkspaceTab from './components/cashiq/CAWorkspaceTab';
import ARAPAgingTab from './components/cashiq/ARAPAgingTab';
import VendorDirectoryTab from './components/cashiq/VendorDirectoryTab';
import BudgetVarianceTab from './components/cashiq/BudgetVarianceTab';
import IntegrationsTab from './components/cashiq/IntegrationsTab';
import ConsolidatedDashboardTab from './components/cashiq/ConsolidatedDashboardTab';
import HistoricalTrendsTab from './components/cashiq/HistoricalTrendsTab';
import FXExposureTab from './components/cashiq/FXExposureTab';
import PaymentInvestigationModal from './components/ai/PaymentInvestigationModal';
import { ToastContainer, useToast } from './components/ui/Toast';

const CURRENCIES = [
    { code: 'INR', flag: '🇮🇳', rate: 83.2 },
    { code: 'USD', flag: '🇺🇸', rate: 1.0 },
    { code: 'EUR', flag: '🇪🇺', rate: 0.92 },
    { code: 'GBP', flag: '🇬🇧', rate: 0.79 },
    { code: 'SGD', flag: '🇸🇬', rate: 1.35 },
    { code: 'JPY', flag: '🇯🇵', rate: 151.2 },
    { code: 'CHF', flag: '🇨🇭', rate: 0.9 },
    { code: 'AUD', flag: '🇦🇺', rate: 1.52 },
    { code: 'CAD', flag: '🇨🇦', rate: 1.36 },
    { code: 'XLM', flag: '🚀', rate: 8.33 },
    { code: 'USDC', flag: '💵', rate: 1.0 },
    { code: 'BTC', flag: '₿', rate: 0.000015 },
    { code: 'ETH', flag: 'Ξ', rate: 0.00028 },
];

interface InstructionMetadata {
    category?: string;
    notes?: string;
    gstApplicable?: string;
    linkedInvoiceId?: string;
    version?: number;
    business_id?: string;
    annotated_by?: string;
    annotated_by_email?: string;
    annotated_at?: string;
    [key: string]: unknown;
}

interface Instruction {
    instruction_id: string;
    amount: string;
    currency: string;
    sender?: string;
    sender_hash: string;
    recipient_hash: string;
    purpose: string;
    state: string;
    timestamp: string;
    ledger_hashes: string[];
    error_message?: string;
    trace_id?: string;
    external_intent_id?: string;
    metadata?: InstructionMetadata;
}

interface Invoice {
    invoice_id: string;
    saga_id: string;
    state: string;
    total_amount: string;
    currency: string;
    seller_name: string;
    buyer_name: string;
    created_at: string;
    source_type: string;
}

interface CashBusiness {
    business_id: string;
    name: string;
    industry?: string;
}

interface ZohoPullItem {
    success?: boolean;
    zohoInvoiceId?: string;
    currency?: string;
    amount?: string | number;
    decision?: string;
}

interface ZohoPullResult {
    success?: boolean;
    message?: string;
    error?: string;
    successCount?: number;
    total?: number;
    results?: ZohoPullItem[];
}

interface SearchResultItem {
    id: string;
    type: string;
    label: string;
    state?: string;
    currency?: string;
    amount?: string | number;
}

type ActiveTabType =
    | 'cash_overview' | 'obligations' | 'alerts' | 'accounts' | 'ca_workspace' | 'ar_ap' | 'budgets' | 'integrations' | 'historical_trends' | 'fx_exposure'
    | 'overview' | 'instructions' | 'rails' | 'ledger' | 'approvals' | 'invoices' | 'vendor_directory';

const ROLE_PERMISSIONS: Record<'CFO' | 'CA' | 'Ops', ActiveTabType[]> = {
    CFO: ['cash_overview', 'ar_ap', 'alerts', 'accounts', 'budgets', 'overview', 'ledger', 'approvals', 'vendor_directory', 'integrations', 'historical_trends', 'fx_exposure'],
    CA: ['ca_workspace', 'ar_ap', 'obligations', 'budgets', 'invoices', 'ledger', 'vendor_directory'],
    Ops: ['overview', 'instructions', 'invoices', 'rails', 'accounts', 'approvals', 'vendor_directory']
};

export default function Dashboard() {
    const [instructions, setInstructions] = useState<Instruction[]>([]);
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [activeTab, setActiveTab] = useState<ActiveTabType>('cash_overview');
    const [userRole, setUserRole] = useState<'CFO' | 'CA' | 'Ops'>('CFO');

    // ── AI Payment Operations Copilot State ────────────────────────────────
    const [isCopilotOpen, setIsCopilotOpen] = useState(false);
    const [copilotCaseId, setCopilotCaseId] = useState<string | undefined>();
    const [copilotTxId, setCopilotTxId] = useState<string | undefined>();

    const handleRoleChange = (role: 'CFO' | 'CA' | 'Ops') => {
        setUserRole(role);
        const permitted = ROLE_PERMISSIONS[role];
        if (!permitted.includes(activeTab)) {
            setActiveTab(permitted[0]);
        }
    };

    const [theme, setTheme] = useState<'dark' | 'light'>('dark');

    useEffect(() => {
        try {
            const savedTheme = localStorage.getItem('pf_theme') as 'dark' | 'light';
            if (savedTheme) {
                setTheme(savedTheme);
            }
        } catch {}
    }, []);

    const handleThemeChange = (newTheme: 'dark' | 'light') => {
        setTheme(newTheme);
        try {
            localStorage.setItem('pf_theme', newTheme);
        } catch {}
    };

    // ── Global Date Filter State ───────────────────────────────────────────
    const [datePreset, setDatePreset] = useState<string>('last_30_days');
    const [startDate, setStartDate] = useState<string>('');
    const [endDate, setEndDate] = useState<string>('');

    const updateDatesFromPreset = useCallback((preset: string) => {
        const today = new Date();
        let start = new Date();
        let end = new Date();

        if (preset === 'last_30_days') {
            start.setDate(today.getDate() - 30);
        } else if (preset === 'this_month') {
            start = new Date(today.getFullYear(), today.getMonth(), 1);
            end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        } else if (preset === 'last_month') {
            start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            end = new Date(today.getFullYear(), today.getMonth(), 0);
        } else if (preset === 'this_quarter') {
            const qStartMonth = Math.floor(today.getMonth() / 3) * 3;
            start = new Date(today.getFullYear(), qStartMonth, 1);
            end = new Date(today.getFullYear(), qStartMonth + 3, 0);
        } else if (preset === 'last_quarter') {
            const qStartMonth = Math.floor(today.getMonth() / 3) * 3 - 3;
            start = new Date(today.getFullYear(), qStartMonth, 1);
            end = new Date(today.getFullYear(), qStartMonth + 3, 0);
        }

        const formatDate = (d: Date) => d.toISOString().split('T')[0];
        setStartDate(formatDate(start));
        setEndDate(formatDate(end));
    }, []);

    // Initialize dates
    useEffect(() => {
        updateDatesFromPreset('last_30_days');
    }, [updateDatesFromPreset]);

    // ── Toast System ───────────────────────────────────────────────────────
    const { toasts, showToast, dismiss } = useToast();

    // ── CashIQ State ───────────────────────────────────────────────────────
    const [cashiqBusinesses, setCashiqBusinesses] = useState<CashBusiness[]>([]);
    const [selectedBusiness, setSelectedBusiness] = useState<string>('');
    const [cashSnapshot,     setCashSnapshot]     = useState<Snapshot | null>(null);
    const [cashObligations,  setCashObligations]  = useState<Obligation[]>([]);
    const [cashAlerts,       setCashAlerts]       = useState<AlertEvent[]>([]);
    const [cashAlertRules,   setCashAlertRules]   = useState<AlertRule[]>([]);
    const [cashAccounts,     setCashAccounts]     = useState<Account[]>([]);
    const [cashLoading,      setCashLoading]      = useState(false);
    const [cashSyncing,      setCashSyncing]      = useState(false);
    const [cashSweeping,     setCashSweeping]     = useState(false);

    // Fetch businesses on mount
    useEffect(() => {
        fetch('/api/cashiq/businesses')
            .then(r => r.json())
            .then(d => {
                if (d.businesses?.length > 0) {
                    setCashiqBusinesses(d.businesses);
                    setSelectedBusiness(d.businesses[0].business_id);
                }
            })
            .catch(() => {});
    }, []);

    // Load CashIQ data whenever business or relevant tab changes
    const loadCashData = useCallback(async () => {
        if (!selectedBusiness || selectedBusiness === 'ALL') return;
        setCashLoading(true);
        try {
            const bid = selectedBusiness;
            const params = startDate && endDate ? `?from=${startDate}&to=${endDate}` : '';
            const [snap, obs, alr, rules, accs] = await Promise.all([
                fetch(`/api/cashiq/${bid}/snapshot${params}`).then(r => r.json()),
                fetch(`/api/cashiq/${bid}/obligations${params}`).then(r => r.json()),
                fetch(`/api/cashiq/${bid}/alerts`).then(r => r.json()),
                fetch(`/api/cashiq/${bid}/alert-rules`).then(r => r.json()),
                fetch(`/api/cashiq/${bid}/accounts`).then(r => r.json()),
            ]);
            if (snap.snapshot)      setCashSnapshot(snap.snapshot);
            if (obs.obligations)    setCashObligations(obs.obligations);
            if (alr.alerts)         setCashAlerts(alr.alerts);
            if (rules.rules)        setCashAlertRules(rules.rules);
            if (accs.accounts)      setCashAccounts(accs.accounts);
        } catch { /* fail silently — server may be starting */ }
        finally { setCashLoading(false); }
    }, [selectedBusiness, startDate, endDate]);

    useEffect(() => {
        if (['cash_overview','obligations','alerts','accounts','ca_workspace','ar_ap','budgets'].includes(activeTab) && selectedBusiness) {
            loadCashData();
        }
    }, [activeTab, selectedBusiness, loadCashData]);

    async function handleSyncZoho() {
        if (!selectedBusiness || selectedBusiness === 'ALL') return;
        setCashSyncing(true);
        try {
            await fetch(`/api/cashiq/${selectedBusiness}/sync-zoho`, {
                method: 'POST',
            });
            await loadCashData();
        } finally { setCashSyncing(false); }
    }

    async function handleMarkAlertRead(eventId: string) {
        await fetch(`/api/cashiq/${selectedBusiness}/alerts/${eventId}/read`, {
            method: 'PUT',
        });
        setCashAlerts(prev => prev.filter(a => a.event_id !== eventId));
    }

    async function handleSentinelSweep() {
        setCashSweeping(true);
        try {
            await fetch('/api/cashiq/sentinel/sweep', {
                method: 'POST',
            });
            await loadCashData();
        } finally { setCashSweeping(false); }
    }
    const [approverName, setApproverName] = useState('');
    const [isApproving, setIsApproving] = useState(false);
    const [lastUpdated, setLastUpdated] = useState<string>('Loading...');
    const [currentPage, setCurrentPage] = useState(1);
    const ITEMS_PER_PAGE = 8;
    const [fromCurrency, setFromCurrency] = useState(CURRENCIES[0]);
    const [toCurrency, setToCurrency] = useState(CURRENCIES[1]);
    const [selectedCurrency, setSelectedCurrency] = useState(CURRENCIES[0]); // For Fiat/Wire modals
    const [activeModal, setActiveModal] = useState<
        null | 'initiate' | 'exchange' | 'send' | 'crypto' | 'bulk' | 'topup' | 'invoice'
    >(null);
    const [fusionBalances, setFusionBalances] = useState<{ currency: string; virtual_balance: string }[]>([]);
    const totalFusionBalance = fusionBalances.reduce((acc, b) => {
        const currencyData = CURRENCIES.find((c) => c.code === b.currency);
        const rate = currencyData ? 1 / currencyData.rate : 1;
        return acc + parseFloat(b.virtual_balance) * rate;
    }, 0);
    const [topUpAmount, setTopUpAmount] = useState('');
    const [topUpCurrency, setTopUpCurrency] = useState('INR');
    const [topUpResult, setTopUpResult] = useState<string | null>(null);
    const [actionAmount, setActionAmount] = useState('');
    const [actionRecipient, setActionRecipient] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);
    const [serverHealth, setServerHealth] = useState<'online' | 'degraded' | 'offline' | 'auth_error' | 'checking'>('checking');
    const [degradedDependency, setDegradedDependency] = useState<string | null>(null);
    const [csvFile, setCsvFile] = useState<File | null>(null);
    const [selectedInstruction, setSelectedInstruction] = useState<Instruction | null>(null);
    interface BulkArbitrageSimulation {
        isSimulated: boolean;
        isExecutable: boolean;
        disclaimer: string;
        dataProvenance: string;
        asset: string;
        quoteCurrency: string;
        quantity: string;
        buyPrice: string;
        sellPrice: string;
        adjustedBuyPrice: string;
        adjustedSellPrice: string;
        buyNotional: string;
        sellNotional: string;
        grossPriceSpread: string;
        grossSpreadNotional: string;
        fees: {
            buyFeeBps: number;
            buyFeeFixed: string;
            totalBuyFee: string;
            sellFeeBps: number;
            sellFeeFixed: string;
            totalSellFee: string;
            networkFee: string;
            transferFee: string;
            settlementFee: string;
            totalOperationalFees: string;
            totalEstimatedCosts: string;
        };
        totalEstimatedCosts: string;
        totalAcquisitionCost: string;
        netSaleProceeds: string;
        netProceeds?: string;
        estimatedNetPnL: string;
        netProfit?: string;
        estimatedRoiPercent: string;
        isProfitable: boolean;
        totalBatchVolume: number;
        display?: {
            buyNotional?: string;
            sellNotional?: string;
            grossProceeds?: string;
            grossSpreadNotional?: string;
            totalEstimatedCosts?: string;
            totalAcquisitionCost?: string;
            grossTotalOutlays?: string;
            netSaleProceeds?: string;
            netProceeds?: string;
            estimatedNetPnL?: string;
            netProfit?: string;
            estimatedRoiPercent?: string;
        };
    }
    const [bulkPreview, setBulkPreview] = useState<BulkArbitrageSimulation | null>(null);
    const [isSimulatingBulk, setIsSimulatingBulk] = useState(false);

    const [isScheduled, setIsScheduled] = useState(false);
    const [scheduledDate, setScheduledDate] = useState('');
    const [scheduledRecurrence, setScheduledRecurrence] = useState('ONCE');
    const [scheduleLabel, setScheduleLabel] = useState('');
    const [scheduleNote, setScheduleNote] = useState('');

    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
    const [searchLoading, setSearchLoading] = useState(false);

    const handleBulkUpload = async () => {
        if (!csvFile) return;
        if (serverHealth === 'offline' || serverHealth === 'auth_error') {
            showToast('error', serverHealth === 'auth_error' ? 'Authentication Required' : 'API Offline', 'The Project Fusion Core is unreachable or unauthorized.');
            return;
        }
        if (serverHealth === 'degraded') {
            showToast('error', 'Database Service Unavailable', `Cannot process bulk payout batch: ${degradedDependency || 'database'} is offline.`);
            return;
        }
        setIsProcessing(true);
        try {
            const text = await csvFile.text();
            const rows = text.split('\n').map(r => r.trim()).filter(r => r);
            if (rows.length < 2) throw new Error("CSV file is empty or missing data rows");
            
            // Dynamic Header Parsing
            const headers = rows[0].split(',').map(h => h.trim().toLowerCase());
            
            const idxAmount = headers.findIndex(h => h.includes('amount') || h.includes('salary'));
            const idxCurrency = headers.findIndex(h => h.includes('currency'));
            const idxFirstName = headers.findIndex(h => h.includes('first name'));
            const idxLastName = headers.findIndex(h => h.includes('last name'));
            const idxRecipient = headers.findIndex(h => h.includes('recipient'));
            const idxPurpose = headers.findIndex(h => h.includes('purpose') || h.includes('job title'));

            if (idxAmount === -1 || idxCurrency === -1) {
                throw new Error("CSV must contain columns for Amount/Salary and Currency");
            }

            const payload = [];
            for(let i = 1; i < rows.length; i++) {
                const cols = rows[i].split(',').map(c => c.trim());
                if (cols.length >= headers.length) {
                     let recipientStr = `Recipient_${i}`;
                     if (idxFirstName !== -1 && idxLastName !== -1) {
                         recipientStr = `${cols[idxFirstName]}_${cols[idxLastName]}`;
                     } else if (idxRecipient !== -1) {
                         recipientStr = cols[idxRecipient];
                     }

                     payload.push({
                          amount: String(cols[idxAmount]),
                          currency: cols[idxCurrency],
                          sender: 'Corporate_HQ', // Using seeded account
                          recipient: recipientStr,
                          purpose: idxPurpose !== -1 ? cols[idxPurpose] : 'BULK_PAYOUT',
                          auth_token: 'afat_valid' // Valid token for batch
                     });
                }
            }
            
            const initReq = await fetch('/api/instruction/initiate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-idempotency-key': 'bulk_' + Date.now().toString(),
                },
                body: JSON.stringify(payload),
            });
            const initData = await initReq.json();
            if (initData.error) throw new Error(initData.error);
            setBulkPreview(null);
        } catch (err) {
            console.error(err);
            showToast('error', 'Bulk Upload Failed', String(err));
        } finally {
            setIsProcessing(false);
            setActiveModal(null);
            setCsvFile(null);
        }
    };

    const handlePreviewBulk = async () => {
        if (!csvFile) return;
        setIsSimulatingBulk(true);
        try {
            const text = await csvFile.text();
            const rows = text.split('\n').filter(r => r.trim());
            const headers = rows[0].split(',').map(h => h.trim().toLowerCase());
            const idxAmount = headers.findIndex(h => h.includes('amount') || h.includes('salary'));
            const idxCurrency = headers.findIndex(h => h.includes('currency'));
            
            let total = 0;
            let currency = 'INR';
            for(let i = 1; i < rows.length; i++) {
                const cols = rows[i].split(',').map(c => c.trim());
                if (cols[idxAmount]) {
                    const parsed = parseFloat(cols[idxAmount]);
                    if (!isNaN(parsed) && parsed > 0) {
                        total += parsed;
                    }
                    if (cols[idxCurrency]) currency = cols[idxCurrency].trim().toUpperCase();
                }
            }

            if (total <= 0) {
                showToast('error', 'Simulation Failed', 'CSV does not contain any valid positive transaction amounts.');
                setIsSimulatingBulk(false);
                return;
            }

            // Transparent simulation assumptions based on detected batch currency
            const cleanCurrency = currency || 'USD';
            const isINR = cleanCurrency === 'INR';
            const simAsset = isINR ? 'USDC' : 'XLM';
            const buyPrice = isINR ? '86.50' : '0.1200';
            const sellPrice = isINR ? '86.95' : '0.1300';
            const approxUnitQty = isINR ? (total / parseFloat(buyPrice)).toFixed(6) : '10000';

            const simPayload = {
                asset: simAsset,
                quoteCurrency: cleanCurrency,
                quantity: approxUnitQty,
                buyPrice,
                sellPrice,
                buySlippageBps: 10,
                sellSlippageBps: isINR ? 15 : 10,
                buyFeeBps: 20,
                buyFeeFixed: isINR ? '15.00' : '0.50',
                sellFeeBps: 20,
                sellFeeFixed: isINR ? '15.00' : '0.50',
                networkFee: isINR ? '5.00' : '0.20',
                transferFee: '0.00',
                settlementFee: '0.00'
            };

            const res = await fetch('/api/treasury/arbitrage/calculate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(simPayload)
            });

            const data = await res.json();
            if (!res.ok || data.status !== 'SUCCESS') {
                showToast('error', 'Simulation Failed', data.error || 'Failed to calculate deterministic arbitrage simulation.');
                setIsSimulatingBulk(false);
                return;
            }

            setBulkPreview({
                ...data,
                totalBatchVolume: total
            });
        } catch (err) {
            showToast('error', 'Simulation Failed', String(err));
        } finally {
            setIsSimulatingBulk(false);
        }
    };


    useEffect(() => {
        fetch('/api/kyc/onboard', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: 'Alice_Corp',
                document_type: 'PASSPORT',
                document_number: 'DEMO123',
            }),
        }).catch(() => {});

        const fetchData = async () => {
            try {
                const headers = {};
                const [obsRes, healthRes, invRes] = await Promise.all([
                    fetch(`/api/observe?limit=100`, { headers }),
                    fetch(`/api/health/detailed`, { headers }),
                    fetch(`/api/invoice/list?limit=100`, { headers }),
                ]);
                if (obsRes.ok) {
                    const data = await obsRes.json();
                    const sorted = (data.data || []).sort(
                        (a: Instruction, b: Instruction) =>
                            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
                    );
                    setInstructions(sorted);
                    setLastUpdated(new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true }) + ' IST');
                } else if (obsRes.status === 401 || healthRes.status === 401) {
                    setServerHealth('auth_error');
                    setLastUpdated('Auth Error');
                }

                if (invRes.ok) {
                    const invData = await invRes.json();
                    setInvoices(invData.data || []);
                }

                // Fetch the user's unified Fusion Virtual Balances (All currencies)
                const vBalRes = await fetch('/api/virtual-account/all-balances', { headers });
                if (vBalRes.ok) {
                    const vBalData = await vBalRes.json();
                    // Filter for Alice_Corp for the prototype view
                    const aliceBalances = vBalData.data.filter((b: { account_id: string; currency: string; virtual_balance: string }) => b.account_id === 'Alice_Corp');
                    setFusionBalances(aliceBalances);
                }

                if (healthRes.ok) {
                    setServerHealth('online');
                    setDegradedDependency(null);
                } else if (healthRes.status === 401 || obsRes.status === 401) {
                    setServerHealth('auth_error');
                    setDegradedDependency(null);
                    setLastUpdated((prev) => (prev === 'Loading...' ? 'Auth Error' : prev));
                } else if (healthRes.status === 503) {
                    try {
                        const healthData = await healthRes.clone().json();
                        if (healthData && (healthData.status === 'degraded' || healthData.dependencies)) {
                            setServerHealth('degraded');
                            const downDeps = Object.entries(healthData.dependencies || {})
                                .filter(([, v]) => (v as { status?: string } | null)?.status === 'down')
                                .map(([k]) => k)
                                .join(', ');
                            setDegradedDependency(downDeps || 'database');
                            setLastUpdated((prev) => (prev === 'Loading...' ? 'Degraded' : prev));
                        } else {
                            setServerHealth('offline');
                            setDegradedDependency(null);
                            setLastUpdated((prev) => (prev === 'Loading...' ? 'Offline' : prev));
                        }
                    } catch {
                        setServerHealth('offline');
                        setDegradedDependency(null);
                        setLastUpdated((prev) => (prev === 'Loading...' ? 'Offline' : prev));
                    }
                } else {
                    setServerHealth('offline');
                    setDegradedDependency(null);
                    setLastUpdated((prev) => (prev === 'Loading...' ? 'Offline' : prev));
                }
            } catch {
                setServerHealth('offline');
                setDegradedDependency(null);
                setLastUpdated((prev) => (prev === 'Loading...' ? 'Unavailable' : prev));
            }
        };

        fetchData();
        const interval = setInterval(fetchData, 2000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        setCurrentPage(1);
    }, [activeTab]);

    // Cmd+K listener for global search
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                setSearchOpen(prev => !prev);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    // Fetch search results from api
    useEffect(() => {
        if (!searchQuery.trim()) {
            setSearchResults([]);
            return;
        }
        setSearchLoading(true);
        const timer = setTimeout(async () => {
            try {
                const r = await fetch(`/api/cashiq/${selectedBusiness}/search?q=${encodeURIComponent(searchQuery)}`);
                const d = await r.json();
                setSearchResults(d.results || []);
            } catch (err) {
                console.error('Search error:', err);
            } finally {
                setSearchLoading(false);
            }
        }, 300);
        return () => clearTimeout(timer);
    }, [searchQuery, selectedBusiness]);

    // ─ METRICS ───────────────────────────────
    const settled = instructions.filter((i) => i.state === 'SETTLED');
    const failed = instructions.filter((i) => i.state === 'FAILED');
    const pending = instructions.filter((i) =>
        ['INITIATED', 'LOCKED', 'PENDING_EXECUTION', 'PENDING_SETTLEMENT'].includes(i.state)
    );
    const successRate =
        instructions.length > 0
            ? ((settled.length / instructions.length) * 100).toFixed(1)
            : '100.0';

    const volumeByCurrency = instructions.reduce((acc: Record<string, number>, inst) => {
        const curr = (inst.currency || 'USD').toUpperCase();
        const amt = parseFloat(inst.amount) || 0;
        acc[curr] = (acc[curr] || 0) + amt;
        return acc;
    }, {});

    const volumeDisplay = Object.keys(volumeByCurrency).length > 0
        ? `$${(volumeByCurrency['USD'] || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`
        : '$0.00 USD';

    const volumeSub = Object.keys(volumeByCurrency).length > 0
        ? Object.entries(volumeByCurrency)
            .filter(([curr]) => curr !== 'USD')
            .map(([curr, amt]) => {
                const prefix = curr === 'INR' ? '₹' : '';
                return `${prefix}${amt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${curr}`;
            })
            .join(' · ') || 'Single rail volume'
        : 'Multi-rail institutional volume';

    const railCounts: Record<string, number> = {};
    settled.forEach((i) => {
        const rail = ['XLM', 'BTC', 'ETH', 'USDC'].includes(i.currency)
            ? 'Digital Asset Network'
            : i.currency === 'INR'
              ? 'Domestic Payment Network'
              : i.currency === 'SGD'
                ? 'Regional Network (SGD)'
                : parseFloat(i.amount) >= 10000
                  ? 'Institutional Network (SWIFT)'
                  : 'Global Fiat Network';
        railCounts[rail] = (railCounts[rail] || 0) + 1;
    });

    // ─ TRANSACTION LIST ───────────────────────────
    const getFiltered = () => {
        switch (activeTab) {
            case 'instructions':
                return instructions.filter((i) =>
                    ['USD', 'EUR', 'SGD', 'GBP', 'INR'].includes(i.currency)
                );
            case 'rails':
                return instructions.filter((i) =>
                    ['XLM', 'USDC', 'BTC', 'ETH'].includes(i.currency)
                );
            case 'ledger':
                return instructions.filter((i) => i.ledger_hashes && i.ledger_hashes.length > 0);
            default:
                return instructions;
        }
    };

    const filteredData = getFiltered();
    const totalPages = Math.ceil(filteredData.length / ITEMS_PER_PAGE);
    const currentData = filteredData.slice(
        (currentPage - 1) * ITEMS_PER_PAGE,
        currentPage * ITEMS_PER_PAGE
    );

    // ─ TRANSACTION HANDLER ──────────────────────────
    const handleSimulateAction = async () => {
        if (serverHealth === 'offline' || serverHealth === 'auth_error') {
            showToast('error', serverHealth === 'auth_error' ? 'Authentication Required' : 'API Offline', 'The Project Fusion Core is unreachable or unauthorized. Ensure backend is running.');
            return;
        }
        if (serverHealth === 'degraded') {
            showToast('error', 'Database Service Unavailable', `Cannot process payment instruction: ${degradedDependency || 'database'} is offline. Core services are operating in degraded mode.`);
            return;
        }

        if (!actionAmount || parseFloat(actionAmount) <= 0) {
            showToast('warning', 'Invalid Amount', 'Please enter a numeric amount greater than zero.');
            return;
        }

        setIsProcessing(true);
        try {
            const user_id = 'Alice_Corp';
            const currency =
                activeModal === 'exchange'
                    ? fromCurrency.code
                    : activeModal === 'crypto'
                      ? 'XLM'
                      : selectedCurrency.code;
            const finalRecipient = actionRecipient.trim() || 'Bob_Supply';

            if (isScheduled) {
                if (!scheduledDate) {
                    showToast('warning', 'Scheduled Date Required', 'Please enter a valid future date.');
                    setIsProcessing(false);
                    return;
                }
                const schedReq = await fetch(`/api/cashiq/${selectedBusiness}/scheduled-payments`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        label: scheduleLabel.trim() || undefined,
                        amount: String(actionAmount),
                        currency,
                        recipient_name: finalRecipient,
                        purpose: activeModal === 'exchange' ? 'FX_SWAP' : 'VENDOR_PAYMENT',
                        scheduled_date: scheduledDate,
                        recurrence: scheduledRecurrence,
                        note: scheduleNote.trim() || undefined
                    })
                });
                const schedData = await schedReq.json();
                if (schedData.error) throw new Error(schedData.error);
                showToast('success', 'Payment Scheduled', schedData.message || `Payment scheduled for ${scheduledDate}.`);
                setActiveModal(null);
                setActionAmount('');
                setActionRecipient('');
                setIsScheduled(false);
                setScheduledDate('');
                setScheduledRecurrence('ONCE');
                setScheduleLabel('');
                setScheduleNote('');
                loadCashData();
            } else {
                await fetch('/api/kyc/onboard', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        user_id: finalRecipient,
                        document_type: 'PASSPORT',
                        document_number: 'JIT123',
                    }),
                }).catch(() => {});
                const isStripeCard = ['USD', 'EUR', 'GBP', 'CAD'].includes(currency);
                const initReq = await fetch('/api/instruction/initiate', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-idempotency-key': Date.now().toString(),
                    },
                    body: JSON.stringify({
                        amount: String(actionAmount),
                        currency,
                        sender: user_id,
                        recipient: finalRecipient,
                        purpose: activeModal === 'exchange' ? 'FX_SWAP' : (isStripeCard ? 'CARD' : 'CROSS_BORDER'),
                        ...(isStripeCard ? { payment_method: 'CARD', rail: 'CARD' } : {}),
                    }),
                });
                const initData = await initReq.json();
                if (initData.error) throw new Error(initData.error || initData.detail);
                showToast('success', 'Instruction Dispatched', initData.message || 'Payment instruction queued successfully.');
            }
        } catch (err) {
            console.error('Instruction Flow Error:', err);
            const errorMsg = err instanceof Error ? err.message : String(err);
            if (errorMsg.includes('Failed to fetch')) {
                showToast('error', 'Connection Failed', 'Unable to reach the SAGA Orchestration Engine. Your backend may have crashed.');
            } else {
                showToast('error', 'Instruction Failed', errorMsg);
            }
        } finally {
            setIsProcessing(false);
            setActiveModal(null);
            setActionAmount('');
            setActionRecipient('');
            setCsvFile(null);
            setInvoiceFile(null);
        }
    };

    const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
    const [selectedInvoiceForSaga, setSelectedInvoiceForSaga] = useState<Invoice | null>(null);
    const [sagaSteps, setSagaSteps] = useState<{ condition?: string; status?: string; amount_pct?: number; rail?: string; escrow_flagged?: boolean }[]>([]);
    const [isLoadingSaga, setIsLoadingSaga] = useState(false);

    // ── ZOHO STATE ─────────────────────────────────────────────────────
    const [isZohoPulling, setIsZohoPulling] = useState(false);
    const [zohoPullResult, setZohoPullResult] = useState<ZohoPullResult | null>(null);
    const [zohoStatusMap, setZohoStatusMap] = useState<Record<string, Record<string, unknown>>>({});

    const handleZohoPull = async () => {
        setIsZohoPulling(true);
        setZohoPullResult(null);
        try {
            const res = await fetch('/api/zoho/pull');
            const data = await res.json();
            setZohoPullResult(data);

            // Refresh invoice list immediately so pulled invoices appear right away
            const invRes = await fetch('/api/invoice/list?limit=100');
            if (invRes.ok) {
                const invData = await invRes.json();
                setInvoices(invData.data || []);
            }
        } catch (err) {
            setZohoPullResult({ success: false, error: String(err) });
        } finally {
            setIsZohoPulling(false);
        }
    };

    // ── ZOHO PAY STATE ─────────────────────────────────────────────────────
    const [zohoPayInvoice, setZohoPayInvoice]   = useState<Invoice | null>(null);
    const [zohoPayRail,    setZohoPayRail]       = useState('core_razorpay');
    const [zohoPayCurrency, setZohoPayCurrency]  = useState('INR');
    const [zohoPayResult,  setZohoPayResult]     = useState<{ success?: boolean; instructionId?: string; rail?: string; amount?: string | number; currency?: string; state?: string; error?: string } | null>(null);
    const [isZohoPaying,   setIsZohoPaying]      = useState(false);

    const FUSION_RAILS = [
        { id: 'core_razorpay',  label: '🇮🇳 Razorpay — INR Domestic',   currencies: ['INR'] },
        { id: 'legacy_fiat',    label: '🏦 Legacy Fiat Rails — General', currencies: ['USD','EUR','INR','GBP'] },
        { id: 'legacy_crypto',  label: '🚀 Crypto Rail — XLM / USDC',   currencies: ['XLM','USDC'] },
    ];

    const handleZohoPay = async () => {
        if (!zohoPayInvoice) return;
        if (serverHealth === 'offline' || serverHealth === 'auth_error') {
            showToast('error', serverHealth === 'auth_error' ? 'Authentication Required' : 'API Offline', 'The Project Fusion Core is unreachable.');
            return;
        }
        if (serverHealth === 'degraded') {
            showToast('error', 'Database Service Unavailable', `Cannot dispatch payment via Fusion SAGA: ${degradedDependency || 'database'} is offline.`);
            return;
        }
        setIsZohoPaying(true);
        setZohoPayResult(null);
        // Extract the raw Zoho invoice ID (strip "ZOHO-" prefix)
        const rawId = zohoPayInvoice.invoice_id.startsWith('ZOHO-')
            ? zohoPayInvoice.invoice_id.slice(5)
            : zohoPayInvoice.invoice_id;
        try {
            const res = await fetch(`/api/zoho/pay/${rawId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    rail:     zohoPayRail,
                    currency: zohoPayCurrency,
                    payer:    'Alice_Corp',
                }),
            });
            const data = await res.json();
            setZohoPayResult(data);

            // Refresh invoices list so state updates immediately
            if (data.success) {
                const invRes = await fetch('/api/invoice/list?limit=100');
                if (invRes.ok) {
                    const invData = await invRes.json();
                    setInvoices(invData.data || []);
                }
            }
        } catch (err) {
            setZohoPayResult({ success: false, error: String(err) });
        } finally {
            setIsZohoPaying(false);
        }
    };


    const handleZohoStatus = async (zohoInvoiceId: string) => {
        try {
            const res = await fetch(`/api/zoho/invoice-status/${zohoInvoiceId}`);
            const data = await res.json();
            setZohoStatusMap(prev => ({ ...prev, [zohoInvoiceId]: data }));
        } catch (err) {
            console.error('Zoho status check failed:', err);
        }
    };

    const handleViewSaga = async (inv: Invoice) => {
        setSelectedInvoiceForSaga(inv);
        setIsLoadingSaga(true);
        try {
            const res = await fetch(`/api/invoice/${inv.invoice_id}/saga-config`);
            const data = await res.json();
            setSagaSteps(data.steps || []);
        } catch (err) {
            console.error('Failed to fetch saga steps:', err);
        } finally {
            setIsLoadingSaga(false);
        }
    };

    const handleInvoiceUpload = async () => {
        if (!invoiceFile) return;
        setIsProcessing(true);
        try {
            const isPdf = invoiceFile.type === 'application/pdf';
            const endpoint = isPdf ? '/api/invoice/upload-pdf' : '/api/invoice/bulk';
            
            const formData = new FormData();
            if (isPdf) {
                formData.append('invoice', invoiceFile);
            } else {
                // Bulk CSV - can be raw text or file
                formData.append('csvData', await invoiceFile.text());
            }

            const res = await fetch(endpoint, {
                method: 'POST',
                body: isPdf ? formData : JSON.stringify({ csvData: await invoiceFile.text() }),
                // Need to fix headers for JSON vs Multipart
                ...(isPdf ? {} : { headers: { 
                    'Content-Type': 'application/json',
                }})
            });

            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            
            showToast('success', `${isPdf ? 'PDF' : 'CSV'} Processed`, 'Saga generated and instructions queued for approval.');
            setActiveModal(null);
            setInvoiceFile(null);
        } catch (err) {
            showToast('error', 'Upload Failed', String(err));
        } finally {
            setIsProcessing(false);
        }
    };

    return (
        <div className={`min-h-screen bg-[#0B0E14] text-white font-sans ${theme === 'light' ? 'light-mode' : ''}`}>
            {/* ─ TOAST NOTIFICATIONS ─────────────────── */}
            <ToastContainer toasts={toasts} onDismiss={dismiss} />
            {/* ─ SIDEBAR NAV ─────────────────────────── */}
            <aside className="fixed top-0 left-0 h-full w-56 bg-[#0F1318] border-r border-gray-800/60 flex flex-col z-30 py-6 px-4">
                <div className="mb-8 px-2 flex items-center justify-between">
                    <div>
                        <div className="text-lg font-bold tracking-tight text-white">
                            Project<span className="text-blue-500">Fusion</span>
                        </div>
                        <div className="text-[10px] text-gray-500 mt-0.5 font-mono uppercase tracking-widest">
                            Console
                        </div>
                    </div>
                    <select
                        value={userRole}
                        onChange={e => handleRoleChange(e.target.value as 'CFO' | 'CA' | 'Ops')}
                        className="bg-[#161B22] border border-gray-800 text-[9px] font-bold text-blue-400 focus:outline-none rounded-md px-1.5 py-0.5 cursor-pointer hover:border-gray-700 hover:text-blue-300 transition-colors mr-1"
                    >
                        <option value="CFO">CFO</option>
                        <option value="CA">CA</option>
                        <option value="Ops">Ops</option>
                    </select>
                </div>

                <nav className="flex flex-col gap-1 overflow-y-auto">
                    {/* ── CashIQ Intelligence ── */}
                    {ROLE_PERMISSIONS[userRole].some(t => ['cash_overview', 'ar_ap', 'obligations', 'alerts', 'accounts', 'budgets', 'integrations', 'historical_trends', 'fx_exposure'].includes(t)) && (
                        <>
                            <div className="text-[8px] font-bold uppercase tracking-[0.2em] text-gray-600 px-2 pt-2 pb-1">CashIQ Intelligence</div>
                            {ROLE_PERMISSIONS[userRole].includes('cash_overview') && (
                                <SideNavItem label="Cash Overview" icon={'◈'} active={activeTab === 'cash_overview'} onClick={() => setActiveTab('cash_overview')} />
                            )}
                            {ROLE_PERMISSIONS[userRole].includes('ar_ap') && (
                                <SideNavItem label="AR/AP Aging" icon={'⚖️'} active={activeTab === 'ar_ap'} onClick={() => setActiveTab('ar_ap')} />
                            )}
                            {ROLE_PERMISSIONS[userRole].includes('obligations') && (
                                <SideNavItem label="Obligations" icon={'⏰'} active={activeTab === 'obligations'} onClick={() => setActiveTab('obligations')} />
                            )}
                            {ROLE_PERMISSIONS[userRole].includes('budgets') && (
                                <SideNavItem label="Department Budgets" icon={'📊'} active={activeTab === 'budgets'} onClick={() => setActiveTab('budgets')} />
                            )}
                            {ROLE_PERMISSIONS[userRole].includes('alerts') && (
                                <SideNavItem label="Alerts" icon={'🔔'} active={activeTab === 'alerts'} onClick={() => setActiveTab('alerts')} />
                            )}
                            {ROLE_PERMISSIONS[userRole].includes('accounts') && (
                                <SideNavItem label="Accounts" icon={'🏦'} active={activeTab === 'accounts'} onClick={() => setActiveTab('accounts')} />
                            )}
                            {ROLE_PERMISSIONS[userRole].includes('vendor_directory') && (
                                <SideNavItem label="Vendor Directory" icon={'🏪'} active={activeTab === 'vendor_directory'} onClick={() => setActiveTab('vendor_directory')} />
                            )}
                            {ROLE_PERMISSIONS[userRole].includes('integrations') && (
                                <SideNavItem label="Integrations & AI" icon={'🤖'} active={activeTab === 'integrations'} onClick={() => setActiveTab('integrations')} />
                            )}
                            {ROLE_PERMISSIONS[userRole].includes('historical_trends') && (
                                <SideNavItem label="Historical Trends" icon={'📈'} active={activeTab === 'historical_trends'} onClick={() => setActiveTab('historical_trends')} />
                            )}
                            {ROLE_PERMISSIONS[userRole].includes('fx_exposure') && (
                                <SideNavItem label="FX Exposure" icon={'💱'} active={activeTab === 'fx_exposure'} onClick={() => setActiveTab('fx_exposure')} />
                            )}
                        </>
                    )}

                    {/* ── Compliance India ── */}
                    {ROLE_PERMISSIONS[userRole].includes('ca_workspace') && (
                        <>
                            <div className="text-[8px] font-bold uppercase tracking-[0.2em] text-amber-700/80 px-2 pt-3 pb-1">Compliance · India</div>
                            <SideNavItem label="CA Workspace" icon={'💼'} active={activeTab === 'ca_workspace'} onClick={() => setActiveTab('ca_workspace')} />
                        </>
                    )}

                    {/* ── Fusion Engine ── */}
                    {ROLE_PERMISSIONS[userRole].some(t => ['overview', 'instructions', 'invoices', 'rails', 'ledger', 'approvals'].includes(t)) && (
                        <>
                            <div className="text-[8px] font-bold uppercase tracking-[0.2em] text-gray-600 px-2 pt-3 pb-1">Fusion Engine</div>
                            {ROLE_PERMISSIONS[userRole].includes('overview') && (
                                <SideNavItem label="Overview"            icon={'\u25C8'} active={activeTab === 'overview'}      onClick={() => setActiveTab('overview')} />
                            )}
                            {ROLE_PERMISSIONS[userRole].includes('instructions') && (
                                <SideNavItem label="Instructions"        icon={'\u21C4'} active={activeTab === 'instructions'}  onClick={() => setActiveTab('instructions')} />
                            )}
                            {ROLE_PERMISSIONS[userRole].includes('invoices') && (
                                <SideNavItem label="Invoices"            icon={'\uD83D\uDCC4'} active={activeTab === 'invoices'} onClick={() => setActiveTab('invoices')} />
                            )}
                            {ROLE_PERMISSIONS[userRole].includes('rails') && (
                                <SideNavItem label="Digital Asset Rails" icon={'\u25CE'} active={activeTab === 'rails'}         onClick={() => setActiveTab('rails')} />
                            )}
                            {ROLE_PERMISSIONS[userRole].includes('ledger') && (
                                <SideNavItem label="Ledger Audit"        icon={'\u2B21'} active={activeTab === 'ledger'}        onClick={() => setActiveTab('ledger')} />
                            )}
                            {ROLE_PERMISSIONS[userRole].includes('approvals') && (
                                <SideNavItem label="Approvals"           icon={'\u2705'} active={activeTab === 'approvals'}     onClick={() => setActiveTab('approvals')} />
                            )}
                            {/* AI Payment Operations Copilot Entrypoint */}
                            <SideNavItem 
                                label="AI Ops Copilot" 
                                icon={'⚡'} 
                                active={isCopilotOpen} 
                                onClick={() => {
                                    setCopilotCaseId(undefined);
                                    setCopilotTxId(undefined);
                                    setIsCopilotOpen(true);
                                }} 
                            />
                        </>
                    )}
                </nav>


                <div className="mt-auto space-y-3">
                    {/* Adapter Health */}
                    <div className="bg-[#161B22] rounded-lg border border-gray-800 p-3">
                        <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2">
                            Network Health
                        </div>
                        <AdapterStatus label="Global Fiat Network" status="online" />
                        <AdapterStatus label="Domestic Network" status="online" />
                        <AdapterStatus label="Failover Network" status="online" />
                        <AdapterStatus label="Digital Asset Network" status="online" />
                        <div className="mt-3 pt-2 border-t border-gray-800/40">
                             <div className="flex items-center justify-between">
                                 <span className="text-[10px] text-blue-400 font-bold uppercase tracking-tighter">Core API Status</span>
                                 <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${
                                     serverHealth === 'online'
                                         ? 'bg-green-500/20 text-green-400 border-green-500/30'
                                         : serverHealth === 'degraded'
                                         ? 'bg-amber-500/20 text-amber-400 border-amber-500/30 animate-pulse'
                                         : serverHealth === 'auth_error'
                                         ? 'bg-amber-500/20 text-amber-400 border-amber-500/30'
                                         : serverHealth === 'checking'
                                         ? 'bg-blue-500/20 text-blue-400 border-blue-500/30 animate-pulse'
                                         : 'bg-red-500/20 text-red-400 border-red-500/30'
                                 }`}>
                                     {serverHealth === 'online' ? 'ONLINE' : serverHealth === 'degraded' ? 'DEGRADED' : serverHealth === 'auth_error' ? 'AUTH ERROR' : serverHealth === 'checking' ? 'CHECKING' : 'OFFLINE'}
                                 </span>
                             </div>
                        </div>
                    </div>
                    <div
                        className={`text-[10px] font-mono px-2 flex items-center gap-1.5 ${
                            serverHealth === 'online'
                                ? 'text-green-500'
                                : serverHealth === 'degraded'
                                ? 'text-amber-400'
                                : serverHealth === 'auth_error'
                                ? 'text-amber-500'
                                : serverHealth === 'checking'
                                ? 'text-blue-500'
                                : 'text-red-500'
                        }`}
                    >
                        <span
                            className={`inline-block w-1.5 h-1.5 rounded-full ${
                                serverHealth === 'online'
                                    ? 'bg-green-500 animate-pulse'
                                    : serverHealth === 'degraded'
                                    ? 'bg-amber-400 animate-pulse'
                                    : serverHealth === 'auth_error'
                                    ? 'bg-amber-500'
                                    : serverHealth === 'checking'
                                    ? 'bg-blue-500'
                                    : 'bg-red-500'
                            }`}
                        />
                        CORE API {serverHealth === 'auth_error' ? 'AUTH ERROR' : serverHealth.toUpperCase()} {serverHealth === 'degraded' && degradedDependency ? `(${degradedDependency})` : ''} {' \u00B7 '} {lastUpdated}
                    </div>
                </div>
            </aside>

            {/* ─ MAIN CONTENT ────────────────────────── */}
            <div className="ml-56">
                {/* TOP BAR */}
                <header className="h-14 border-b border-gray-800/60 bg-[#0B0E14] flex items-center justify-between px-6 sticky top-0 z-20">
                    <div>
                        <h1 className="text-sm font-semibold text-gray-200">
                            {activeTab === 'cash_overview' && '◈ Cash Overview'}
                            {activeTab === 'ar_ap'        && '⚖️ AR / AP Aging'}
                            {activeTab === 'obligations'  && '⏰ Obligations'}
                            {activeTab === 'budgets'      && '📊 Department Budgets'}
                            {activeTab === 'historical_trends' && '📈 Historical Trends'}
                            {activeTab === 'fx_exposure'  && '💱 FX Exposure'}
                            {activeTab === 'alerts'       && '🔔 CashSentinel Alerts'}
                            {activeTab === 'accounts'     && '🏦 Bank Accounts'}
                            {activeTab === 'vendor_directory' && '🏪 Vendor Directory'}
                            {activeTab === 'integrations' && '🤖 Integrations & AI'}
                            {activeTab === 'ca_workspace' && '💼 CA Workspace'}
                            {activeTab === 'overview'     && 'Operations Overview'}
                            {activeTab === 'instructions' && 'Fiat Instruction Log'}
                            {activeTab === 'rails'        && 'Digital Asset Rail Log'}
                            {activeTab === 'ledger'       && 'Ledger Audit Trail'}
                            {activeTab === 'approvals'    && '✅ Maker-Checker Approvals'}
                            {activeTab === 'invoices'     && '📄 Invoices'}
                        </h1>
                        <p className="text-xs text-gray-600 font-mono">
                            api.projectfusion.io \u00B7 v1.0.0
                        </p>
                    </div>
                    <div className="flex items-center gap-3">
                        {['cash_overview','obligations','ca_workspace','ar_ap','budgets'].includes(activeTab) && (
                            <div className="flex items-center gap-2 bg-[#0F1318] border border-gray-800 rounded-lg px-2.5 py-1 text-xs">
                                <span className="text-gray-500 font-mono">Range:</span>
                                <select
                                    value={datePreset}
                                    onChange={e => {
                                        const p = e.target.value;
                                        setDatePreset(p);
                                        if (p !== 'custom') {
                                            updateDatesFromPreset(p);
                                        }
                                    }}
                                    className="bg-transparent border-none text-gray-300 font-medium focus:outline-none cursor-pointer"
                                >
                                    <option value="last_30_days">Last 30 Days</option>
                                    <option value="this_month">This Month</option>
                                    <option value="last_month">Last Month</option>
                                    <option value="this_quarter">This Quarter</option>
                                    <option value="last_quarter">Last Quarter</option>
                                    <option value="custom">Custom Range</option>
                                </select>
                                {datePreset === 'custom' && (
                                    <div className="flex items-center gap-1.5 border-l border-gray-800 pl-2.5 ml-1">
                                        <input
                                            type="date"
                                            value={startDate}
                                            onChange={e => setStartDate(e.target.value)}
                                            className="bg-transparent border-none text-gray-300 focus:outline-none w-28 cursor-pointer font-mono"
                                        />
                                        <span className="text-gray-600">to</span>
                                        <input
                                            type="date"
                                            value={endDate}
                                            onChange={e => setEndDate(e.target.value)}
                                            className="bg-transparent border-none text-gray-300 focus:outline-none w-28 cursor-pointer font-mono"
                                        />
                                    </div>
                                )}
                            </div>
                        )}
                        {/* AI Payment Operations Copilot Launch Button */}
                        <button
                            type="button"
                            onClick={() => {
                                setCopilotCaseId(undefined);
                                setCopilotTxId(undefined);
                                setIsCopilotOpen(true);
                            }}
                            className="bg-linear-to-r from-blue-950/80 via-indigo-950/70 to-purple-950/80 border border-blue-600/60 hover:border-blue-400 text-blue-200 hover:text-white px-3 py-1.5 rounded-lg flex items-center gap-2 cursor-pointer font-mono text-xs font-bold transition-all shadow-md hover:shadow-blue-500/20 active:scale-98"
                            title="Open AI Payment Operations Copilot (Razorpay AI Builder Demo)"
                        >
                            <span className="text-amber-400">⚡</span>
                            <span>AI Copilot</span>
                            <span className="bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[9px] px-1.5 py-0.2 rounded font-extrabold uppercase">
                                Demo
                            </span>
                        </button>

                        <button
                            onClick={() => setSearchOpen(true)}
                            className="bg-[#0F1318] border border-gray-800 text-[10px] text-gray-500 hover:text-white px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 cursor-pointer font-mono hover:border-gray-700 transition-colors"
                        >
                            <span>🔍 Search</span>
                            <span className="bg-[#161B22] border border-gray-800 text-[8px] text-gray-600 px-1 py-0.5 rounded font-bold font-sans">⌘K</span>
                        </button>
                        <div className="text-[11px] font-mono text-blue-300 bg-blue-900/20 border border-blue-800/40 px-3 py-1.5 rounded-lg flex items-center gap-2">
                            <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />
                            Balance: <span className="font-bold text-white">${totalFusionBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                        </div>
                        {/* Theme Switcher Options */}
                        <div className="theme-switcher-container">
                            <button
                                onClick={() => handleThemeChange('light')}
                                className={`theme-switcher-btn ${theme === 'light' ? 'active' : ''}`}
                                title="Switch to Daytime Mode"
                            >
                                <span>☀️</span>
                                <span>Daytime</span>
                            </button>
                            <button
                                onClick={() => handleThemeChange('dark')}
                                className={`theme-switcher-btn ${theme === 'dark' ? 'active' : ''}`}
                                title="Switch to Darkmode"
                            >
                                <span>🌙</span>
                                <span>Darkmode</span>
                            </button>
                        </div>

                        {/* Global Business Selector */}
                        {cashiqBusinesses.length > 1 && (
                            <div className="flex items-center gap-2 border-l border-gray-800/60 pl-4 ml-2">
                                <span className="text-[10px] text-gray-500 font-medium">BUSINESS:</span>
                                <select
                                    value={selectedBusiness}
                                    onChange={e => setSelectedBusiness(e.target.value)}
                                    className="text-xs bg-[#161B22] border border-gray-800 text-gray-300 px-3 py-1.5 rounded-lg focus:outline-none hover:border-gray-700 transition-colors font-semibold"
                                >
                                    <option value="ALL">🏢 Consolidated View (All Entities)</option>
                                    {cashiqBusinesses.map(b => (
                                        <option key={b.business_id} value={b.business_id}>{b.name}</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {/* Action Buttons based on Role Permissions */}
                        {(userRole === 'CFO' || userRole === 'Ops') && (
                            <button
                                onClick={() => setActiveModal('topup')}
                                className="text-xs text-green-400 border border-green-700/60 bg-green-900/20 px-3 py-1.5 rounded-lg hover:bg-green-800/30 hover:border-green-500 transition-colors font-semibold"
                            >
                                + Add Funds
                            </button>
                        )}
                        {userRole === 'Ops' && (
                            <button
                                onClick={() => setActiveModal('initiate')}
                                className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors flex items-center gap-2"
                            >
                                + New Instruction
                            </button>
                        )}
                        {userRole === 'Ops' && (
                            <button
                                onClick={() => setActiveModal('invoice')}
                                className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-colors flex items-center gap-2"
                            >
                                + New Invoice
                            </button>
                        )}
                    </div>
                </header>

                <main
                    className={`p-6 ${activeModal ? 'opacity-30 blur-sm pointer-events-none' : ''}`}
                >
                    {selectedBusiness === 'ALL' ? (
                        <ConsolidatedDashboardTab />
                    ) : (
                        <>
                            {/* ── CashIQ tabs ─────────────────────────────── */}
                            {activeTab === 'cash_overview' && (
                                <CashOverviewTab 
                                    snapshot={cashSnapshot} 
                                    loading={cashLoading} 
                                    businessId={selectedBusiness}
                                    globalCurrency={selectedCurrency}
                                    setGlobalCurrency={setSelectedCurrency}
                                    currencies={CURRENCIES}
                                    onSelectBusiness={(id: string) => setSelectedBusiness(id)}
                                />
                            )}

                    {activeTab === 'obligations' && (
                        <ObligationsTab
                            businessId={selectedBusiness}
                            obligations={cashObligations}
                            loading={cashLoading}
                            onSyncZoho={handleSyncZoho}
                            isSyncing={cashSyncing}
                        />
                    )}

                    {activeTab === 'budgets' && (
                        <BudgetVarianceTab businessId={selectedBusiness} />
                    )}
                    {activeTab === 'historical_trends' && (
                        <HistoricalTrendsTab businessId={selectedBusiness} />
                    )}
                    {activeTab === 'fx_exposure' && (
                        <FXExposureTab businessId={selectedBusiness} />
                    )}

                    {activeTab === 'alerts' && (
                        <AlertsTab
                            businessId={selectedBusiness}
                            alerts={cashAlerts}
                            rules={cashAlertRules}
                            loading={cashLoading}
                            onMarkRead={handleMarkAlertRead}
                            onSweep={handleSentinelSweep}
                            isSweeping={cashSweeping}
                        />
                    )}

                    {activeTab === 'accounts' && (
                        <AccountsPanel
                            businessId={selectedBusiness}
                            accounts={cashAccounts}
                            loading={cashLoading}
                            onRefresh={loadCashData}
                        />
                    )}

                    {activeTab === 'vendor_directory' && (
                        <VendorDirectoryTab
                            businessId={selectedBusiness}
                        />
                    )}

                    {activeTab === 'integrations' && (
                        <IntegrationsTab
                            businessId={selectedBusiness}
                        />
                    )}

                    {activeTab === 'ca_workspace' && (
                        <CAWorkspaceTab
                            businessId={selectedBusiness}
                            snapshot={cashSnapshot}
                            loading={cashLoading}
                            onRefresh={loadCashData}
                        />
                    )}

                    {activeTab === 'ar_ap' && (
                        <ARAPAgingTab
                            businessId={selectedBusiness}
                        />
                    )}

                    {activeTab === 'overview' && (
                        <>
                            {/* ─ KPI METRICS ROW ──────────────────── */}
                            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                                <KpiCard
                                    label="Total Volume Processed"
                                    value={volumeDisplay}
                                    sub={volumeSub}
                                    accent="blue"
                                />
                                <KpiCard
                                    label="Settled Instructions"
                                    value={settled.length.toString()}
                                    sub={`${successRate}% success rate`}
                                    accent="green"
                                />
                                <KpiCard
                                    label="Pending / In-flight"
                                    value={pending.length.toString()}
                                    sub="Across SAGA stages"
                                    accent="yellow"
                                />
                                <KpiCard
                                    label="Failed Instructions"
                                    value={failed.length.toString()}
                                    sub="SAGA rollback triggered"
                                    accent="red"
                                />
                            </div>

                            {/* ─ GLOBAL FUSION BALANCE ──────────────────── */}
                            <div className="mb-6">
                                <div className="unified-liquidity-card bg-linear-to-br from-blue-900/40 via-[#0F1318] to-blue-950/20 border border-blue-700/30 rounded-2xl p-6 shadow-xl relative overflow-hidden group">
                                    <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                                        <div className="text-8xl font-black text-blue-500 font-mono tracking-tighter">AGGR</div>
                                    </div>
                                    
                                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 relative z-10">
                                        <div className="flex-1">
                                            <div className="text-[10px] text-blue-400 uppercase tracking-[0.2em] font-bold mb-1 drop-shadow-sm flex items-center gap-2">
                                                <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(59,130,246,0.6)]" /> Unified Aggregate Liquidity
                                            </div>
                                            <div className="text-[10px] text-gray-500 font-mono mb-4 flex items-center gap-2">
                                                <span className="text-blue-500/60 font-bold">IDENTITY:</span> Alice_Corp <span className="text-gray-700">|</span> <span className="text-blue-500/60 font-bold">MODEL:</span> Virtual Clearing Account
                                            </div>
                                            
                                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                                {fusionBalances.length === 0 ? (
                                                    <div className="col-span-2 text-gray-600 font-mono text-xs italic py-2">Initialising multi-currency virtual accounts...</div>
                                                ) : (
                                                    fusionBalances.map((b) => (
                                                        <div key={b.currency} className="bg-white/3 border border-white/5 rounded-xl p-3 hover:border-blue-500/30 transition-all hover:bg-blue-900/10">
                                                            <div className="text-[9px] text-gray-500 font-bold mb-1">{b.currency} GLOBAL VIRTUAL ACCOUNT</div>
                                                            <div className="text-xl font-bold font-mono text-white tracking-tight">
                                                                {parseFloat(b.virtual_balance).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                                            </div>
                                                            <div className="text-[9px] text-blue-400/60 mt-1 font-mono">HASH: {Math.random().toString(16).slice(2, 10).toUpperCase()}</div>
                                                        </div>
                                                    ))
                                                )}
                                            </div>
                                        </div>

                                        <div className="flex flex-col items-center md:items-end gap-3 min-w-35">
                                             <div className="bg-blue-600/10 border border-blue-500/20 px-3 py-1.5 rounded-lg flex flex-col items-end">
                                                <div className="text-[8px] text-blue-400 font-bold uppercase tracking-widest">Aggregate INR Value</div>
                                                <div className="text-lg font-bold text-white font-mono">
                                                    ₹{totalFusionBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                                </div>
                                             </div>
                                             <button
                                                onClick={() => setActiveModal('topup')}
                                                className="w-full text-xs font-bold text-white bg-blue-600 hover:bg-blue-500 px-6 py-2.5 rounded-xl transition-all shadow-lg shadow-blue-900/20 flex items-center justify-center gap-2 group"
                                            >
                                                <span className="text-lg group-hover:scale-125 transition-transform">+</span> Top-up Virtual Account
                                            </button>
                                        </div>
                                    </div>
                                    
                                    <div className="text-[9px] text-gray-600 mt-5 font-mono flex items-center gap-3 border-t border-white/3 pt-3">
                                        <span className="flex items-center gap-1"><span className="w-1 h-1 bg-green-500 rounded-full" /> SECURE_LEDGER_ACTIVE</span>
                                        <span className="flex items-center gap-1"><span className="w-1 h-1 bg-blue-500 rounded-full" /> HASH_CHAIN_SYNCED</span>
                                        <span className="flex items-center gap-1"><span className="w-1 h-1 bg-gray-500 rounded-full" /> PROOF_OF_RESERVE_V3</span>
                                    </div>
                                </div>
                            </div>

                            {/* ─ 2-COL GRID ──────────────────────── */}
                            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                                {/* TRANSACTION TABLE */}
                                <div className="lg:col-span-2">
                                    <SectionHeader
                                        title="Recent Instructions"
                                        subtitle={`${instructions.length} total dispatched`}
                                    />
                                    <InstructionTable
                                        data={currentData}
                                        currentPage={currentPage}
                                        totalPages={totalPages}
                                        onPrev={() => setCurrentPage((p) => Math.max(p - 1, 1))}
                                        onNext={() =>
                                            setCurrentPage((p) => Math.min(p + 1, totalPages))
                                        }
                                        onSelect={setSelectedInstruction}
                                    />
                                </div>

                                {/* RIGHT WIDGETS */}
                                <div className="space-y-4">
                                    {/* SMART ROUTER BREAKDOWN */}
                                    <div className="bg-[#0F1318] rounded-xl border border-gray-800/60 p-5">
                                        <SectionHeader
                                            title="Smart Router Decisions"
                                            subtitle="By rail (settled only)"
                                        />
                                        <div className="space-y-2 mt-2">
                                            {Object.keys(railCounts).length === 0 ? (
                                                <p className="text-xs text-gray-600">
                                                    No settled instructions yet.
                                                </p>
                                            ) : (
                                                Object.entries(railCounts)
                                                    .sort((a, b) => b[1] - a[1])
                                                    .map(([rail, count]) => (
                                                        <RailBar
                                                            key={rail}
                                                            label={rail}
                                                            count={count}
                                                            total={settled.length}
                                                        />
                                                    ))
                                            )}
                                        </div>
                                    </div>

                                    {/* QUICK ACTIONS */}
                                    <div className="bg-[#0F1318] rounded-xl border border-gray-800/60 p-5">
                                        <SectionHeader title="Quick Actions" subtitle="" />
                                        <div className="mt-3 grid grid-cols-2 gap-2">
                                            <QuickAction
                                                label="Fiat Instruction" icon={'\u21B4'} onClick={() => setActiveModal('initiate')}
                                            />
                                            <QuickAction
                                                label="FX Exchange" icon={'\u21C4'} onClick={() => setActiveModal('exchange')}
                                            />
                                            <QuickAction
                                                label="Initiate Smart Settlement" icon={'\u25CE'} onClick={() => setActiveModal('crypto')}
                                            />
                                            <QuickAction
                                                label="Wire Transfer" icon={'\u21CB'} onClick={() => setActiveModal('send')}
                                            />
                                        </div>
                                        <div className="mt-2 text-center">
                                            <button onClick={() => setActiveModal('bulk')} className="w-full bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-400 border border-indigo-600/50 py-2.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-all">
                                               <span className="text-lg">{'\u21C5'}</span> Bulk CSV Upload
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </>
                    )}

                    {(activeTab === 'instructions' ||
                        activeTab === 'rails' ||
                        activeTab === 'ledger' ||
                        activeTab === 'invoices') && (
                        <div>
                            <div className="mb-4 flex items-center justify-between">
                                <SectionHeader
                                    title={
                                        activeTab === 'instructions'
                                            ? 'Fiat Instructions'
                                            : activeTab === 'rails'
                                              ? 'Digital Asset Rail Instructions'
                                              : activeTab === 'invoices'
                                                ? 'Ingested Invoices (ISO 20022)'
                                                : 'Ledger-Verified Instructions'
                                    }
                                    subtitle={`${activeTab === 'invoices' ? invoices.length : filteredData.length} records`}
                                />
                            </div>
                            {activeTab === 'invoices' ? (
                                <>
                                    {/* ─ ZOHO PULL CARD ─────────────────────────── */}
                                    <div className="mb-4 zoho-integration-card bg-linear-to-r from-[#0F2027] via-[#0F1318] to-[#0F1318] border border-emerald-800/40 rounded-xl p-4 flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <div className="w-8 h-8 bg-emerald-500/10 border border-emerald-500/30 rounded-lg flex items-center justify-center text-sm">📗</div>
                                            <div>
                                                <div className="text-xs font-bold text-emerald-400 uppercase tracking-widest">Zoho Books Integration</div>
                                                <div className="text-[10px] text-gray-500 font-mono mt-0.5">
                                                    {zohoPullResult
                                                        ? zohoPullResult.success
                                                            ? `✅ ${zohoPullResult.message}`
                                                            : `❌ ${zohoPullResult.error}`
                                                        : 'Pull live invoices from your Zoho Books account'}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            {zohoPullResult && zohoPullResult.results && zohoPullResult.results.length > 0 && (
                                                <span className="text-[10px] bg-emerald-900/30 text-emerald-400 border border-emerald-700/40 px-2 py-1 rounded font-mono">
                                                    {zohoPullResult.successCount}/{zohoPullResult.total} imported
                                                </span>
                                            )}
                                            <button
                                                onClick={handleZohoPull}
                                                disabled={isZohoPulling}
                                                className="flex items-center gap-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold px-4 py-2 rounded-lg transition-all"
                                            >
                                                {isZohoPulling ? (
                                                    <><span className="animate-spin rounded-full h-3 w-3 border-2 border-white border-t-transparent" /> Syncing...</>
                                                ) : (
                                                    <>↓ Pull from Zoho</>
                                                )}
                                            </button>
                                        </div>
                                    </div>

                                    {/* Zoho pull results detail */}
                                    {zohoPullResult && zohoPullResult.results && zohoPullResult.results.length > 0 && (
                                        <div className="mb-4 bg-[#0F1318] border border-gray-800 rounded-xl overflow-hidden">
                                            <div className="px-4 py-2 border-b border-gray-800 bg-[#0B0E14] text-[10px] text-gray-600 uppercase tracking-widest">Zoho Pull Results</div>
                                            {zohoPullResult.results.map((r, i: number) => (
                                                <div key={i} className="px-4 py-2.5 border-b border-gray-800/50 last:border-0 flex items-center justify-between text-xs">
                                                    <div className="flex items-center gap-2">
                                                        <span className={`w-1.5 h-1.5 rounded-full ${r.success ? 'bg-emerald-500' : 'bg-red-500'}`} />
                                                        <span className="font-mono text-gray-400 text-[10px]">{r.zohoInvoiceId}</span>
                                                    </div>
                                                    <div className="flex items-center gap-3">
                                                        <span className="text-gray-500 font-mono text-[10px]">{r.currency} {r.amount}</span>
                                                        <span className={`px-2 py-0.5 rounded text-[10px] font-mono ${
                                                            r.decision === 'AUTO_APPROVE' ? 'bg-emerald-900/30 text-emerald-400' :
                                                            r.decision === 'ESCALATE' ? 'bg-amber-900/30 text-amber-400' :
                                                            'bg-gray-800 text-gray-500'
                                                        }`}>{r.decision || (r.success ? 'OK' : 'FAILED')}</span>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    <InvoicePanel 
                                        data={invoices} 
                                        onViewSaga={handleViewSaga}
                                        onZohoStatus={handleZohoStatus}
                                        onZohoPay={(inv) => {
                                            setZohoPayInvoice(inv);
                                            setZohoPayResult(null);
                                            setZohoPayRail('core_razorpay');
                                            setZohoPayCurrency(inv.currency || 'INR');
                                        }}
                                        zohoStatusMap={zohoStatusMap}
                                    />
                                </>
                            ) : (
                                <InstructionTable
                                    data={currentData}
                                    currentPage={currentPage}
                                    totalPages={totalPages}
                                    onPrev={() => setCurrentPage((p) => Math.max(p - 1, 1))}
                                    onNext={() => setCurrentPage((p) => Math.min(p + 1, totalPages))}
                                    onSelect={setSelectedInstruction}
                                />
                            )}
                        </div>
                    )}

                    {activeTab === 'approvals' && (
                        <ApprovalsPanel
                            instructions={instructions}
                            approverName={approverName}
                            setApproverName={setApproverName}
                            isApproving={isApproving}
                            setIsApproving={setIsApproving}
                            showToast={showToast}
                            userRole={userRole}
                            serverHealth={serverHealth}
                            degradedDependency={degradedDependency}
                            onApproved={() => {
                                // Refresh instructions list after approval
                                fetch('/api/observe?limit=100')
                                    .then(r => r.json())
                                    .then(data => {
                                        const sorted = (data.data || []).sort(
                                            (a: Instruction, b: Instruction) =>
                                                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
                                        );
                                        setInstructions(sorted);
                                    })
                                    .catch(() => {});
                            }}
                        />
                    )}
                        </>
                    )}
                </main>
            </div>

            {/* ─ MODAL ────────────────────────────── */}
            {activeModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div
                        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
                        onClick={() => setActiveModal(null)}
                    />
                    <div className="relative bg-[#0F1318] border border-gray-800 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
                        <div className="bg-[#161B22] px-6 py-4 border-b border-gray-800 flex justify-between items-center">
                            <h3 className="text-white font-semibold flex items-center gap-2 capitalize">
                                {activeModal === 'initiate' ? '\uD83C\uDFE6 New Instruction' : 
                                 activeModal === 'exchange' ? '\u21C4 FX Exchange' : 
                                 activeModal === 'crypto' ? '\u25CE Smart Settlement' : 
                                 activeModal === 'send' ? '\uD83C\uDFE7 Wire Transfer' : 
                                 activeModal === 'topup' ? '\uD83D\uDCB3 Add Funds' : 
                                 activeModal === 'invoice' ? '\uD83D\uDCC4 Process New Invoice' : '\u21C5 Bulk Upload'}
                            </h3>
                            <button onClick={() => setActiveModal(null)} className="text-gray-500 hover:text-white text-xl">{'\u00D7'}</button>
                        </div>
                        
                        <div className="p-6 space-y-4">
                            {activeModal === 'topup' ? (
                                <div className="space-y-4">
                                    <div className="bg-blue-900/10 border border-blue-800/30 rounded-xl p-4">
                                        <div className="text-[10px] text-blue-400 uppercase tracking-widest font-bold mb-1">Current Balance</div>
                                        <div className="text-2xl font-mono font-bold text-white">₹{totalFusionBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })} <span className="text-xs text-gray-500">Total INR Equiv.</span></div>
                                    </div>
                                    <div className="space-y-1">
                                        <label className="text-xs text-gray-500 uppercase tracking-widest">Deposit Amount</label>
                                        <input
                                            type="number"
                                            value={topUpAmount}
                                            onChange={(e) => setTopUpAmount(e.target.value)}
                                            placeholder="e.g. 10000"
                                            className="w-full bg-[#161B22] border border-gray-700 rounded-lg px-4 py-3 text-xl font-mono text-white focus:outline-none focus:border-green-500 transition-colors"
                                            autoFocus
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <label className="text-xs text-gray-500 uppercase tracking-widest">Currency</label>
                                        <select
                                            value={topUpCurrency}
                                            onChange={(e) => setTopUpCurrency(e.target.value)}
                                            className="w-full bg-[#161B22] border border-gray-700 rounded-lg px-4 py-2.5 text-sm font-mono text-white focus:outline-none focus:border-green-500"
                                        >
                                            {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
                                        </select>
                                    </div>
                                    {topUpResult && (
                                        <div className="bg-green-900/15 border border-green-700/40 rounded-lg p-3 text-xs text-green-400 font-mono">
                                            {topUpResult}
                                        </div>
                                    )}
                                    <div className="bg-gray-900/40 border border-gray-800 rounded-lg p-3 text-xs text-gray-500 font-mono">
                                        Simulates an inbound wire transfer. Fusion credits your Virtual Account and records a High-Speed Rail ledger entry.
                                    </div>
                                    <button
                                        onClick={async () => {
                                            if (!topUpAmount || parseFloat(topUpAmount) <= 0) return;
                                            setIsProcessing(true);
                                            try {
                                                const res = await fetch('/api/virtual-account/top-up', {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json', 'x-idempotency-key': 'topup_' + Date.now() },
                                                    body: JSON.stringify({ user_id: 'Alice_Corp', amount: parseFloat(topUpAmount), currency: topUpCurrency })
                                                });
                                                const data = await res.json();
                                                if (data.error) throw new Error(data.error);
                                                setTopUpResult(`✅ Deposited ${topUpAmount} ${topUpCurrency}. Your Global Virtual Account will update shortly.`);
                                                setTopUpAmount('');
                                            } catch (err) {
                                                showToast('error', 'Top-up Failed', String(err));
                                            } finally {
                                                setIsProcessing(false);
                                            }
                                        }}
                                        disabled={isProcessing || !topUpAmount}
                                        className="w-full bg-green-700 hover:bg-green-600 text-white font-semibold py-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2 text-sm"
                                    >
                                        {isProcessing ? <><span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" /> Processing...</> : 'Deposit Funds'}
                                    </button>
                                </div>
                            ) : activeModal === 'invoice' ? (
                                <div className="space-y-4">
                                    <div className="bg-indigo-900/10 border border-indigo-800/30 rounded-xl p-4">
                                        <div className="text-[10px] text-indigo-400 uppercase tracking-widest font-bold mb-1">GIFT City IFSC Gateway</div>
                                        <p className="text-[10px] text-gray-400 font-mono leading-tight">
                                            Ingest invoices for automated ISO 20022 enrichment and SAGA generation. 
                                            Supports PDF (Extraction) and CSV (Bulk).
                                        </p>
                                    </div>
                                    <div className="space-y-1">
                                        <label className="text-xs text-gray-500 uppercase tracking-widest">Select Invoice (PDF or CSV)</label>
                                        <div className="relative group">
                                            <input
                                                type="file"
                                                accept=".pdf,.csv"
                                                onChange={(e) => setInvoiceFile(e.target.files?.[0] || null)}
                                                className="w-full bg-[#161B22] border border-gray-700 rounded-lg px-4 py-8 text-sm font-mono text-white focus:outline-none focus:border-indigo-500 transition-colors file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-indigo-600/20 file:text-indigo-400 hover:file:bg-indigo-600/30"
                                            />
                                            {invoiceFile && (
                                                <div className="mt-2 text-[10px] text-indigo-300 font-mono flex items-center gap-2">
                                                    <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-ping" />
                                                    FILE READY: {invoiceFile.name} ({(invoiceFile.size / 1024).toFixed(1)} KB)
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    <div className="bg-gray-900/40 border border-gray-800 rounded-lg p-3 text-xs text-gray-500 font-mono">
                                        Processing triggers the <strong className="text-gray-300">Programmable Conditions Engine</strong> which generates escrow milestones and multi-stage saga steps.
                                    </div>
                                    <button
                                        onClick={handleInvoiceUpload}
                                        disabled={isProcessing || !invoiceFile}
                                        className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2 text-sm"
                                    >
                                        {isProcessing ? <><span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" /> Analyzing Invoice...</> : 'Process & Generate Saga'}
                                    </button>
                                </div>
                            ) : activeModal === 'bulk' ? (
                                <div className="space-y-1">
                                    <label className="text-xs text-gray-500 uppercase tracking-widest">
                                        Select CSV File
                                    </label>
                                    <input
                                        type="file"
                                        accept=".csv"
                                        onChange={(e) => {
                                            if (e.target.files && e.target.files.length > 0) {
                                                setCsvFile(e.target.files[0]);
                                                // Preview will be triggered by a "Preview" button or useEffect
                                            }
                                        }}
                                        className="w-full bg-[#161B22] border border-gray-700 rounded-lg px-4 py-3 text-sm font-mono text-white focus:outline-none focus:border-blue-500 transition-colors file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-blue-600/20 file:text-blue-400 hover:file:bg-blue-600/30"
                                    />
                                    {csvFile && !bulkPreview && (
                                        <button 
                                            onClick={handlePreviewBulk}
                                            disabled={isSimulatingBulk}
                                            className="w-full mt-2 py-2 bg-blue-600/20 text-blue-400 text-[10px] font-bold rounded border border-blue-600/30 hover:bg-blue-600/40 transition-all uppercase flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            {isSimulatingBulk ? 'Calculating Deterministic Simulation...' : 'Run Treasury Simulation'}
                                        </button>
                                    )}

                                    {bulkPreview && (
                                        <div className="mt-4 bg-[#0d1117] border border-blue-500/40 rounded-xl p-4 space-y-3 animate-in fade-in slide-in-from-top-2">
                                            {/* Header with Prominent Non-Executable Badge */}
                                            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-1.5">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] font-bold text-blue-400 uppercase tracking-wider">Treasury Intelligence</span>
                                                    <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2 py-0.5 rounded text-[8px] font-bold tracking-widest uppercase">
                                                        SIMULATED — NOT AN EXECUTABLE QUOTE
                                                    </span>
                                                </div>
                                                <span className="text-[9px] font-mono text-gray-500">{bulkPreview.dataProvenance}</span>
                                            </div>

                                            {/* Mandatory Governance Disclaimer */}
                                            <div className="bg-amber-950/20 border border-amber-700/30 rounded-lg p-2 text-[9px] text-amber-200/90 font-mono leading-relaxed">
                                                <span className="font-semibold text-amber-300">Notice: </span>
                                                {bulkPreview.disclaimer}
                                            </div>

                                            {/* Primary Metrics Grid */}
                                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 pt-1">
                                                <div className="bg-[#161b22] border border-gray-800 rounded-lg p-2.5">
                                                    <div className="text-[10px] text-gray-400">Buy Notional</div>
                                                    <div className="text-sm font-mono text-white font-bold">{bulkPreview.buyNotional} {bulkPreview.quoteCurrency}</div>
                                                    <div className="text-[9px] text-gray-500 font-mono">Adj: {bulkPreview.adjustedBuyPrice}</div>
                                                </div>
                                                <div className="bg-[#161b22] border border-gray-800 rounded-lg p-2.5">
                                                    <div className="text-[10px] text-gray-400">Sell Notional</div>
                                                    <div className="text-sm font-mono text-white font-bold">{bulkPreview.sellNotional} {bulkPreview.quoteCurrency}</div>
                                                    <div className="text-[9px] text-gray-500 font-mono">Adj: {bulkPreview.adjustedSellPrice}</div>
                                                </div>
                                                <div className="bg-[#161b22] border border-gray-800 rounded-lg p-2.5">
                                                    <div className="text-[10px] text-gray-400">Gross Price Spread</div>
                                                    <div className="text-sm font-mono text-cyan-400 font-bold">+{bulkPreview.grossPriceSpread}</div>
                                                    <div className="text-[9px] text-gray-500 font-mono">Spread: +{bulkPreview.grossSpreadNotional} {bulkPreview.quoteCurrency}</div>
                                                </div>
                                                <div className="bg-[#161b22] border border-gray-800 rounded-lg p-2.5">
                                                    <div className="text-[10px] text-gray-400">Total Estimated Costs</div>
                                                    <div className="text-sm font-mono text-orange-400 font-bold">{bulkPreview.totalEstimatedCosts} {bulkPreview.quoteCurrency}</div>
                                                    <div className="text-[9px] text-gray-400 font-mono">Total Acq Cost: <span className="text-gray-200 font-bold">{bulkPreview.totalAcquisitionCost}</span></div>
                                                </div>
                                                <div className="bg-[#161b22] border border-gray-800 rounded-lg p-2.5">
                                                    <div className="text-[10px] text-gray-400">Estimated Net P&L</div>
                                                    <div className={`text-sm font-mono font-bold ${bulkPreview.isProfitable ? 'text-green-400' : 'text-red-400'}`}>
                                                        {bulkPreview.isProfitable ? '+' : ''}{bulkPreview.display?.estimatedNetPnL || bulkPreview.estimatedNetPnL} {bulkPreview.quoteCurrency}
                                                        <span className="text-[9px] font-normal text-gray-400 ml-1 font-mono">({bulkPreview.estimatedNetPnL} raw)</span>
                                                    </div>
                                                    <div className="text-[9px] text-gray-400 font-mono">Net Proceeds: <span className="text-gray-200 font-bold">{bulkPreview.netSaleProceeds}</span></div>
                                                </div>
                                                <div className="bg-[#161b22] border border-gray-800 rounded-lg p-2.5">
                                                    <div className="text-[10px] text-gray-400">Estimated ROI</div>
                                                    <div className={`text-sm font-mono font-bold ${bulkPreview.isProfitable ? 'text-green-400' : 'text-red-400'}`}>
                                                        {bulkPreview.estimatedRoiPercent}
                                                    </div>
                                                    <div className="text-[9px] text-gray-500 font-mono">Simulated Return</div>
                                                </div>
                                            </div>

                                            {/* Transparent Assumptions & Provenance Footer */}
                                            <div className="bg-[#161b22]/70 border border-gray-800/80 rounded-lg p-2 text-[9px] font-mono text-gray-400 space-y-1">
                                                <div className="flex justify-between">
                                                    <span>Slippage Assumptions:</span>
                                                    <span className="text-gray-300">Buy: 10 bps | Sell: 15 bps</span>
                                                </div>
                                                <div className="flex justify-between">
                                                    <span>Fee Assumptions:</span>
                                                    <span className="text-gray-300">Buy: {bulkPreview.fees.buyFeeBps} bps + {bulkPreview.fees.buyFeeFixed} | Sell: {bulkPreview.fees.sellFeeBps} bps + {bulkPreview.fees.sellFeeFixed} | Op: {bulkPreview.fees.totalOperationalFees} {bulkPreview.quoteCurrency}</span>
                                                </div>
                                                <div className="flex justify-between border-t border-gray-800 pt-1 text-[8px] text-gray-500">
                                                    <span>Asset: {bulkPreview.asset} ({bulkPreview.quantity} units)</span>
                                                    <span>Batch Vol: {bulkPreview.totalBatchVolume.toLocaleString()} {bulkPreview.quoteCurrency}</span>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="space-y-1">
                                    <label className="text-xs text-gray-500 uppercase tracking-widest">
                                        Amount
                                    </label>
                                    <input
                                        type="number"
                                        value={actionAmount}
                                        onChange={(e) => setActionAmount(e.target.value)}
                                        placeholder="0.00"
                                        className="w-full bg-[#161B22] border border-gray-700 rounded-lg px-4 py-3 text-xl font-mono text-white focus:outline-none focus:border-blue-500 transition-colors"
                                        autoFocus
                                    />
                                </div>
                            )}
                            {activeModal !== 'bulk' && activeModal !== 'topup' && (
                                <>
                                    {(activeModal === 'initiate' || activeModal === 'send') && (
                                <div className="space-y-1">
                                    <label className="text-xs text-gray-500 uppercase tracking-widest">
                                        Currency
                                    </label>
                                    <div className="bg-[#161B22] p-3 rounded-lg border border-gray-700">
                                        <select
                                            className="w-full bg-transparent text-white font-bold outline-none cursor-pointer text-sm"
                                            value={selectedCurrency.code}
                                            onChange={(e) =>
                                                setSelectedCurrency(
                                                    CURRENCIES.find(
                                                        (c) => c.code === e.target.value
                                                    ) || CURRENCIES[0]
                                                )
                                            }
                                        >
                                            {CURRENCIES.map((c) => (
                                                <option key={c.code} value={c.code} className="bg-[#161B22] text-white">
                                                    {c.flag} {c.code}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    <p className="text-[10px] text-gray-600 font-mono mt-1">
                                        {selectedCurrency.code === 'INR'
                                            ? 'Selected: Domestic Payment Network (INR — RazorpayX Sandbox)'
                                            : ['USD', 'EUR', 'GBP', 'CAD'].includes(selectedCurrency.code)
                                              ? `Selected: Stripe Testnet (${selectedCurrency.code} Card Rail)`
                                              : `Selected: ${selectedCurrency.code === 'SGD' ? 'Regional Network' : 'Global Fiat Network'}`}
                                    </p>
                                </div>
                            )}
                            {activeModal === 'exchange' && (
                                <div className="bg-[#161B22] p-4 rounded-xl border border-gray-800 space-y-2">
                                    <div className="flex justify-between items-center">
                                        <select
                                            className="bg-transparent text-white font-bold outline-none cursor-pointer text-sm"
                                            value={fromCurrency.code}
                                            onChange={(e) =>
                                                setFromCurrency(
                                                    CURRENCIES.find(
                                                        (c) => c.code === e.target.value
                                                    ) || CURRENCIES[0]
                                                )
                                            }
                                        >
                                            {CURRENCIES.map((c) => (
                                                <option key={c.code} value={c.code}>
                                                    {c.flag} {c.code}
                                                </option>
                                            ))}
                                        </select>
                                        <span className="text-gray-600 text-xs">
                                            SOURCE CURRENCY
                                        </span>
                                    </div>
                                    <div className="text-gray-700 py-1 text-center text-sm">
                                        {'\u2193'} SMART ROUTER WILL ROUTE
                                    </div>
                                    <div className="flex justify-between items-center">
                                        <select
                                            className="bg-transparent text-white font-bold outline-none cursor-pointer text-sm"
                                            value={toCurrency.code}
                                            onChange={(e) =>
                                                setToCurrency(
                                                    CURRENCIES.find(
                                                        (c) => c.code === e.target.value
                                                    ) || CURRENCIES[1]
                                                )
                                            }
                                        >
                                            {CURRENCIES.map((c) => (
                                                <option key={c.code} value={c.code}>
                                                    {c.flag} {c.code}
                                                </option>
                                            ))}
                                        </select>
                                        <span className="text-gray-600 text-xs">
                                            DESTINATION CURRENCY
                                        </span>
                                    </div>
                                </div>
                            )}
                            <div className="space-y-1">
                                <label className="text-xs text-gray-500 uppercase tracking-widest">
                                    Recipient Entity ID
                                </label>
                                <input
                                    type="text"
                                    value={actionRecipient}
                                    onChange={(e) => setActionRecipient(e.target.value)}
                                    placeholder="e.g. Vendor_Corp_001"
                                    className="w-full bg-[#161B22] border border-gray-700 rounded-lg px-4 py-2.5 text-sm font-mono text-white focus:outline-none focus:border-blue-500 transition-colors"
                                />
                            </div>

                            {/* Schedule Payment Section */}
                            {(activeModal === 'initiate' || activeModal === 'send') && (
                                <div className="border border-gray-800 rounded-xl p-3 bg-[#161B22]/30 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <label className="text-xs text-gray-300 font-medium">Schedule for future date</label>
                                        <input
                                            type="checkbox"
                                            checked={isScheduled}
                                            onChange={(e) => setIsScheduled(e.target.checked)}
                                            className="w-4 h-4 rounded border-gray-800 bg-[#161B22] text-blue-600 focus:ring-blue-500 focus:ring-offset-0 focus:outline-none cursor-pointer"
                                        />
                                    </div>
                                    {isScheduled && (
                                        <div className="space-y-2.5 pt-1 border-t border-gray-800/60 animate-in fade-in duration-200">
                                            <div className="grid grid-cols-2 gap-3">
                                                <div className="space-y-1">
                                                    <label className="text-[10px] text-gray-500 uppercase tracking-widest">Date *</label>
                                                    <input
                                                        type="date"
                                                        value={scheduledDate}
                                                        onChange={(e) => setScheduledDate(e.target.value)}
                                                        className="w-full bg-[#161B22] border border-gray-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-blue-500 cursor-pointer"
                                                    />
                                                </div>
                                                <div className="space-y-1">
                                                    <label className="text-[10px] text-gray-500 uppercase tracking-widest">Recurrence</label>
                                                    <select
                                                        value={scheduledRecurrence}
                                                        onChange={(e) => setScheduledRecurrence(e.target.value)}
                                                        className="w-full bg-[#161B22] border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500 cursor-pointer"
                                                    >
                                                        <option value="ONCE">One-time (Once)</option>
                                                        <option value="DAILY">Daily</option>
                                                        <option value="WEEKLY">Weekly</option>
                                                        <option value="MONTHLY">Monthly</option>
                                                    </select>
                                                </div>
                                            </div>
                                            <div className="space-y-1">
                                                <label className="text-[10px] text-gray-500 uppercase tracking-widest">Label / Memo</label>
                                                <input
                                                    type="text"
                                                    value={scheduleLabel}
                                                    onChange={(e) => setScheduleLabel(e.target.value)}
                                                    placeholder="e.g. Monthly Consultant Fee"
                                                    className="w-full bg-[#161B22] border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
                                                />
                                            </div>
                                            <div className="space-y-1">
                                                <label className="text-[10px] text-gray-500 uppercase tracking-widest">Note (Private)</label>
                                                <input
                                                    type="text"
                                                    value={scheduleNote}
                                                    onChange={(e) => setScheduleNote(e.target.value)}
                                                    placeholder="e.g. Schedule approved by Board"
                                                    className="w-full bg-[#161B22] border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
                                                />
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                                </>
                            )}
                            <div className="bg-blue-900/10 border border-blue-900/30 rounded-lg p-3 text-xs text-blue-400 font-mono">
                                {activeModal === 'bulk' ? 'SAGA engine will segregate workloads across Fusion\'s global network queues.' : 'SAGA engine will auto-select optimal network via Smart Router \u2192 execute via licensed rail \u2192 write to hash-chained ledger'}
                            </div>
                            <button
                                onClick={activeModal === 'bulk' ? handleBulkUpload : handleSimulateAction}
                                disabled={isProcessing || (activeModal === 'bulk' ? !csvFile : !actionAmount)}
                                className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2 text-sm"
                            >
                                {isProcessing ? (
                                    <>
                                        <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                                        Processing via SAGA...
                                    </>
                                ) : isScheduled ? (
                                    'Schedule Payment'
                                ) : (
                                    'Dispatch Instruction'
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ─ TRANSACTION DETAIL MODAL ──────────────────── */}
            {selectedInstruction && (
                <TransactionDetailModal 
                    instruction={instructions.find(i => i.instruction_id === selectedInstruction.instruction_id) || selectedInstruction} 
                    invoices={invoices}
                    onClose={() => setSelectedInstruction(null)} 
                    showToast={showToast}
                    onInvestigateAI={(txId) => {
                        setCopilotTxId(txId);
                        setIsCopilotOpen(true);
                    }}
                    onMetadataUpdated={(id, meta) => {
                        setInstructions(prev => prev.map(item => item.instruction_id === id ? { ...item, metadata: meta } : item));
                    }}
                />
            )}

            {/* ─ AI PAYMENT OPERATIONS COPILOT MODAL ──────────────── */}
            <PaymentInvestigationModal
                isOpen={isCopilotOpen}
                onClose={() => setIsCopilotOpen(false)}
                initialCaseId={copilotCaseId}
                initialTransactionId={copilotTxId}
                showToast={showToast}
            />

            {/* ─ SAGA TRACKING MODAL ──────────────────── */}
            {selectedInvoiceForSaga && (
                <SagaTrackingModal
                    invoice={selectedInvoiceForSaga}
                    steps={sagaSteps}
                    isLoading={isLoadingSaga}
                    onClose={() => setSelectedInvoiceForSaga(null)}
                />
            )}

            {/* ─ GLOBAL SEARCH MODAL (Cmd+K) ──────────────────── */}
            {searchOpen && (
                <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-sm pt-[10vh]">
                    <div className="bg-[#0F1318] border border-gray-700/60 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
                        {/* Search Input */}
                        <div className="relative border-b border-gray-800 p-4 flex items-center gap-3">
                            <span className="text-gray-500 text-lg">🔍</span>
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                placeholder="Search transactions, invoices, contacts, obligations... (Esc to close)"
                                className="w-full bg-transparent border-0 text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-0 text-sm"
                                autoFocus
                                onKeyDown={e => {
                                    if (e.key === 'Escape') setSearchOpen(false);
                                }}
                            />
                            <button onClick={() => setSearchOpen(false)} className="text-xs bg-[#161B22] text-gray-500 hover:text-white px-2 py-1 rounded border border-gray-800 font-mono">ESC</button>
                        </div>

                        {/* Search Results */}
                        <div className="max-h-87.5 overflow-y-auto p-2 divide-y divide-gray-800/40">
                            {searchLoading ? (
                                <div className="p-8 text-center text-xs text-gray-500 font-mono animate-pulse">Searching Project Fusion ledger...</div>
                            ) : searchQuery.trim() && searchResults.length === 0 ? (
                                <div className="p-8 text-center text-xs text-gray-600 italic">No matching records found.</div>
                            ) : !searchQuery.trim() ? (
                                <div className="p-8 text-center text-[10px] text-gray-600 uppercase tracking-widest font-mono">Type query to start searching ledger</div>
                            ) : (
                                searchResults.map(r => (
                                    <button
                                        key={`${r.type}-${r.id}`}
                                        onClick={() => {
                                            setSearchOpen(false);
                                            setSearchQuery('');
                                            setSearchResults([]);
                                            
                                            // Handle redirection or modal trigger based on type
                                            if (r.type === 'contact') {
                                                setActiveTab('vendor_directory');
                                            } else if (r.type === 'obligation') {
                                                setActiveTab('obligations');
                                            } else if (r.type === 'invoice') {
                                                setActiveTab('invoices');
                                            } else if (r.type === 'instruction') {
                                                const found = instructions.find(i => i.instruction_id === r.id);
                                                if (found) {
                                                    setSelectedInstruction(found);
                                                } else {
                                                    showToast('info', 'Instruction Details', `Instruction ID: ${r.id}\nState: ${r.state}\nAmount: ${r.currency} ${r.amount}`);
                                                }
                                            }
                                        }}
                                        className="w-full flex items-center justify-between text-left p-3 hover:bg-white/2 rounded-lg transition-colors text-xs text-gray-300"
                                    >
                                        <div className="flex items-center gap-3">
                                            <span className="text-gray-500 text-sm">
                                                {r.type === 'contact' ? '🏪' : r.type === 'invoice' ? '📄' : r.type === 'obligation' ? '⏰' : '⚡'}
                                            </span>
                                            <div>
                                                <div className="text-gray-200 font-medium">{r.label}</div>
                                                <div className="text-[10px] text-gray-600 uppercase font-mono tracking-widest mt-0.5">{r.type}</div>
                                            </div>
                                        </div>
                                        <span className="text-gray-600 text-[10px] font-mono">➔</span>
                                    </button>
                                ))
                            )}
                        </div>

                        {/* Footer shortcut help */}
                        <div className="bg-[#161B22] px-4 py-2 border-t border-gray-800 text-[10px] text-gray-500 font-mono flex justify-between">
                            <span>Use arrows to navigate, Enter to select</span>
                            <span>Cmd+K to close</span>
                        </div>
                    </div>
                </div>
            )}

            {/* ─ ZOHO PAY MODAL ──────────────────── */}
            {zohoPayInvoice && (
                <ZohoPayModal
                    invoice={zohoPayInvoice}
                    rails={FUSION_RAILS}
                    selectedRail={zohoPayRail}
                    setSelectedRail={setZohoPayRail}
                    currency={zohoPayCurrency}
                    setCurrency={setZohoPayCurrency}
                    isPaying={isZohoPaying}
                    result={zohoPayResult}
                    onPay={handleZohoPay}
                    onClose={() => {
                        setZohoPayInvoice(null);
                        setZohoPayResult(null);
                    }}
                />
            )}
        </div>
    );
}

// ─ SUB COMPONENTS ──────────────────────────────

function SideNavItem({
    label,
    icon,
    active,
    onClick,
}: {
    label: string;
    icon: string;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all text-left ${
                active
                    ? 'bg-blue-600/15 text-blue-400 border border-blue-600/30'
                    : 'text-gray-500 hover:text-gray-200 hover:bg-white/5'
            }`}
        >
            <span className="text-base w-4">{icon}</span>
            {label}
        </button>
    );
}

function AdapterStatus({
    label,
    status,
}: {
    label: string;
    status: 'online' | 'offline' | 'degraded';
}) {
        const colors = {
        online: 'text-green-500',
        offline: 'text-red-500',
        degraded: 'text-yellow-500',
    };
    const dots = { online: '\u25CF', offline: '\u25CB', degraded: '\u25CF' };
    return (
        <div className="flex items-center justify-between py-0.5">
            <span className="text-[10px] text-gray-400 font-mono">{label}</span>
            <span className={`text-[10px] font-mono ${colors[status]}`}>
                {dots[status]} {status.toUpperCase()}
            </span>
        </div>
    );
}

function KpiCard({
    label,
    value,
    sub,
    accent,
}: {
    label: string;
    value: string;
    sub: string;
    accent: 'blue' | 'green' | 'yellow' | 'red';
}) {
    const borderColors = {
        blue: 'border-blue-800/40',
        green: 'border-green-800/40',
        yellow: 'border-yellow-800/40',
        red: 'border-red-800/40',
    };
    const valueColors = {
        blue: 'text-blue-300',
        green: 'text-green-300',
        yellow: 'text-yellow-300',
        red: 'text-red-300',
    };
    return (
        <div className={`bg-[#0F1318] rounded-xl border p-5 ${borderColors[accent]}`}>
            <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2">{label}</div>
            <div className={`text-2xl font-bold font-mono ${valueColors[accent]}`}>{value}</div>
            <div className="text-xs text-gray-600 mt-1">{sub}</div>
        </div>
    );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
    return (
        <div className="mb-3">
            <h2 className="text-sm font-semibold text-gray-200">{title}</h2>
            {subtitle && <p className="text-xs text-gray-600 mt-0.5">{subtitle}</p>}
        </div>
    );
}

function InstructionTable({
    data,
    currentPage,
    totalPages,
    onPrev,
    onNext,
    onSelect,
}: {
    data: Instruction[];
    currentPage: number;
    totalPages: number;
    onPrev: () => void;
    onNext: () => void;
    onSelect: (inst: Instruction) => void;
}) {
    return (
        <div className="bg-[#0F1318] rounded-xl border border-gray-800/60 overflow-hidden">
            <div className="grid grid-cols-12 text-[10px] text-gray-600 uppercase tracking-widest px-4 py-2 border-b border-gray-800 bg-[#0B0E14]">
                <div className="col-span-1">Type</div>
                <div className="col-span-3">Instruction ID</div>
                <div className="col-span-2">Amount</div>
                <div className="col-span-1">Rail</div>
                <div className="col-span-2">Status</div>
                <div className="col-span-3">Ledger Hash</div>
            </div>
            {data.length === 0 ? (
                <div className="p-8 text-center text-gray-600 text-sm">
                    No instructions in this view. Dispatch instructions to begin.
                </div>
            ) : (
                <div>
                    {data.map((inst) => (
                        <InstructionRow key={inst.instruction_id} inst={inst} onSelect={() => onSelect(inst)} />
                    ))}
                    {totalPages > 1 && (
                        <div className="flex justify-between items-center px-4 py-3 border-t border-gray-800">
                            <button
                                onClick={onPrev}
                                disabled={currentPage === 1}
                                className="text-xs text-gray-500 hover:text-gray-200 disabled:opacity-30 font-mono"
                            >
                                {'\u2190'} PREV
                            </button>
                            <span className="text-[10px] text-gray-700 font-mono">
                                PAGE {currentPage} / {totalPages}
                            </span>
                            <button
                                onClick={onNext}
                                disabled={currentPage === totalPages}
                                className="text-xs text-gray-500 hover:text-gray-200 disabled:opacity-30 font-mono"
                            >
                                NEXT {'\u2192'}
                            </button>
                        </div>
                    )}
                </div>
            )}

        </div>
    );
}

function ApprovalsPanel({
    instructions,
    approverName,
    setApproverName,
    isApproving,
    setIsApproving,
    onApproved,
    showToast,
    userRole,
    serverHealth,
    degradedDependency,
}: {
    instructions: Instruction[];
    approverName: string;
    setApproverName: (v: string) => void;
    isApproving: boolean;
    setIsApproving: (v: boolean) => void;
    onApproved: () => void;
    showToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, message: string) => void;
    userRole: 'CFO' | 'CA' | 'Ops';
    serverHealth?: 'online' | 'degraded' | 'offline' | 'auth_error' | 'checking';
    degradedDependency?: string | null;
}) {
    const pending = instructions.filter((i) => i.state === 'PENDING_APPROVAL');

    const handleApprove = async (ids: string[]) => {
        if (serverHealth === 'offline' || serverHealth === 'auth_error') {
            showToast('error', serverHealth === 'auth_error' ? 'Authentication Required' : 'API Offline', 'The Project Fusion Core is unreachable or unauthorized.');
            return;
        }
        if (serverHealth === 'degraded') {
            showToast('error', 'Approvals Suspended', `Cannot approve instructions while ${degradedDependency || 'database'} service is degraded.`);
            return;
        }
        if (!approverName.trim()) {
            showToast('warning', 'Approver Identity Required', 'Please enter your approver name or user ID first.');
            return;
        }
        setIsApproving(true);
        try {
            const res = await fetch('/api/instruction/approve', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-idempotency-key': Date.now().toString() + '_approve',
                },
                body: JSON.stringify({ instructionIds: ids, approved_by: approverName }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            showToast('success', 'Instructions Approved', `${data.approved} instruction(s) approved and queued for processing!`);
            onApproved();
        } catch (err) {
            showToast('error', 'Approval Failed', err instanceof Error ? err.message : String(err));
        } finally {
            setIsApproving(false);
        }
    };

    return (
        <div className="p-6 space-y-6">
            {serverHealth === 'degraded' && (
                <div className="bg-amber-950/30 border border-amber-600/50 rounded-xl p-4 text-amber-300 text-xs font-mono space-y-1">
                    <div className="font-bold flex items-center gap-1.5">
                        <span className="text-amber-400">⚠️</span> Approvals Suspended: Core Service Degraded
                    </div>
                    <div className="text-amber-400/80 text-[11px]">
                        The database dependency ({degradedDependency || 'database'}) is currently offline. Maker-Checker dual control and SAGA dispatch are paused to protect ledger integrity.
                    </div>
                </div>
            )}

            {userRole !== 'CFO' && (
                <div className="bg-red-950/20 border border-red-800/40 rounded-xl p-4 text-red-400 text-xs font-mono">
                    ⚠️ <strong>Access Denied:</strong> Only the **CFO** (authorized checker) is permitted to authorize and approve transaction instructions. Please switch your role to **CFO** in the sidebar to perform approvals.
                </div>
            )}

            <div className="bg-amber-900/10 border border-amber-800/50 rounded-xl p-4 text-amber-400 text-xs font-mono">
                {'\u26A0\uFE0F'} <strong>Four-Eyes Principle Active.</strong> Instructions are paused here until a second authorized approver reviews and approves them. You cannot approve instructions you initiated.
            </div>

            {/* Approver Identity */}
            <div className="bg-[#161B22] rounded-xl border border-gray-800 p-4 space-y-3">
                <div className="text-xs text-gray-500 uppercase tracking-widest">Your Approver Identity</div>
                <input
                    type="text"
                    placeholder="Enter your user ID or name (must differ from initiator)..."
                    value={approverName}
                    onChange={(e) => setApproverName(e.target.value)}
                    disabled={userRole !== 'CFO'}
                    className="w-full bg-[#0B0E14] border border-gray-700 rounded px-3 py-2 text-sm text-white font-mono placeholder-gray-700 focus:outline-none focus:border-amber-600 disabled:opacity-50"
                />
            </div>

            {/* Pending Approvals List */}
            <div className="bg-[#161B22] rounded-xl border border-gray-800 overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-800 flex justify-between items-center">
                    <span className="text-xs text-gray-400 font-semibold">
                        Awaiting Approval {'\u2014'} {pending.length} instruction(s)
                    </span>
                    {pending.length > 0 && (
                        <button
                            onClick={() => handleApprove(pending.map((i) => i.instruction_id))}
                            disabled={isApproving || userRole !== 'CFO'}
                            className="text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white px-4 py-1.5 rounded-lg font-semibold transition-colors"
                        >
                            {isApproving ? 'Approving...' : `Approve All (${pending.length})`}
                        </button>
                    )}
                </div>
                {pending.length === 0 ? (
                    <div className="p-8 text-center text-gray-600 text-sm">
                        No instructions awaiting approval. Upload a CSV batch to generate pending approvals.
                    </div>
                ) : (
                    pending.map((inst) => (
                        <div key={inst.instruction_id} className="grid grid-cols-12 items-center px-4 py-3 border-b border-gray-800/50 last:border-0 hover:bg-white/2 text-xs">
                            <div className="col-span-4 font-mono text-gray-400 text-[10px]">{inst.instruction_id?.slice(0, 20)}...</div>
                            <div className="col-span-2 font-mono text-white font-semibold">{parseFloat(inst.amount).toFixed(2)} <span className="text-gray-600">{inst.currency}</span></div>
                            <div className="col-span-2 text-gray-500 truncate">{inst.recipient_hash}</div>
                            <div className="col-span-2 font-mono text-gray-600 text-[10px]">{inst.purpose}</div>
                            <div className="col-span-2 flex justify-end">
                                <button
                                    onClick={() => handleApprove([inst.instruction_id])}
                                    disabled={isApproving}
                                    className="text-[10px] bg-amber-900/30 hover:bg-amber-600 text-amber-400 hover:text-white border border-amber-800/50 px-3 py-1 rounded transition-colors disabled:opacity-40"
                                >
                                    Approve
                                </button>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}

function InstructionRow({ inst, onSelect }: { inst: Instruction, onSelect?: () => void }) {
    const isCrypto = ['XLM', 'BTC', 'ETH', 'USDC'].includes(inst.currency);
    const rail = isCrypto
        ? 'Digital'
        : inst.currency === 'INR'
          ? 'Domestic'
          : inst.currency === 'SGD'
            ? 'Regional'
            : inst.state === 'PENDING_APPROVAL'
              ? '\u2014'
              : 'Global Fiat';
    const statusColors: Record<string, string> = {
        SETTLED: 'text-green-400 bg-green-900/20',
        FAILED: 'text-red-400 bg-red-900/20',
        LOCKED: 'text-yellow-400 bg-yellow-900/20',
        INITIATED: 'text-blue-400 bg-blue-900/20',
        PENDING_EXECUTION: 'text-purple-400 bg-purple-900/20',
        PENDING_SETTLEMENT: 'text-cyan-400 bg-cyan-900/20',
        MANUAL_CHECK: 'text-orange-400 bg-orange-900/20',
        PENDING_APPROVAL: 'text-amber-400 bg-amber-900/30',
        ROLLED_BACK: 'text-gray-400 bg-gray-800/40',
        REJECTED_COMPLIANCE: 'text-red-500 bg-red-900/40 font-bold border border-red-500/50',
    };
    const typeIcon = isCrypto ? '\u25CE' : '\u21C4';
    const firstHash = inst.ledger_hashes?.[0];

    return (
        <div 
            onClick={onSelect}
            className="grid grid-cols-12 items-center px-4 py-3 border-b border-gray-800/50 last:border-0 hover:bg-white/4 active:bg-white/8 transition-all text-xs cursor-pointer group"
        >
            <div className="col-span-1">
                <span className="text-gray-500 font-mono group-hover:text-blue-400 transition-colors">{typeIcon}</span>
            </div>
            <div className="col-span-3 font-mono text-gray-400 text-[10px] truncate pr-2 group-hover:text-gray-200 transition-colors">
                <div>{inst.instruction_id?.slice(0, 16)}...</div>
                {(inst.instruction_id === '99999999-9999-4999-8999-999999999999' || inst.instruction_id?.startsWith('99999999-') || inst.sender === 'SYNTHETIC_SENDER' || Boolean(inst.metadata?.notes?.includes('R3C.1'))) && (
                    <span className="text-[8px] font-mono font-extrabold text-amber-400 block truncate tracking-tight" title="SYNTHETIC DEMO FIXTURE — NOT A REAL PAYMENT">
                        SYNTHETIC DEMO FIXTURE — NOT A REAL PAYMENT
                    </span>
                )}
            </div>
            <div className="col-span-2 font-mono text-white font-semibold group-hover:text-blue-200 transition-colors">
                {parseFloat(inst.amount).toFixed(2)}{' '}
                <span className="text-gray-600">{inst.currency}</span>
            </div>
            <div className="col-span-1 font-mono text-blue-400 text-[10px]">{rail}</div>
            <div className="col-span-2 flex flex-col">
                <span
                    className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold w-fit ${statusColors[inst.state] || 'text-gray-400'}`}
                >
                    {inst.state}
                </span>
                {inst.error_message && (
                    <span className="text-[8px] text-red-500 font-mono mt-0.5 truncate max-w-full" title={inst.error_message}>
                        {inst.error_message.slice(0, 20)}...
                    </span>
                )}
            </div>

            <div className="col-span-3 font-mono text-[9px] text-gray-600 truncate pr-1 flex items-center justify-between group-hover:text-gray-400">
                <span>{firstHash ? firstHash.slice(0, 24) + '...' : '\u2014'}</span>
                {firstHash && (
                    <button 
                        onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(firstHash);
                            (e.currentTarget as HTMLButtonElement).textContent = '✓';
                        }}
                        className="opacity-0 group-hover:opacity-100 text-[8px] bg-gray-800 hover:bg-blue-600 text-gray-400 hover:text-white px-1.5 py-0.5 rounded transition-all ml-1"
                    >
                        COPY
                    </button>
                )}
            </div>
        </div>
    );
}

function RailBar({ label, count, total }: { label: string; count: number; total: number }) {
    const pct = total > 0 ? (count / total) * 100 : 0;
    return (
        <div className="space-y-1">
            <div className="flex justify-between text-[10px] font-mono">
                <span className="text-gray-400">{label}</span>
                <span className="text-gray-600">
                    {count} ({pct.toFixed(0)}%)
                </span>
            </div>
            <div className="w-full bg-gray-800 rounded h-1">
                <div
                    className="bg-blue-600 h-1 rounded transition-all"
                    style={{ width: `${pct}%` }}
                />
            </div>
        </div>
    );
}

function QuickAction({ label, icon, onClick }: { label: string; icon?: string; onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            className="bg-[#161B22] border border-gray-800 hover:border-blue-600/50 hover:text-blue-400 text-gray-400 text-[10px] font-bold py-2.5 px-3 rounded-lg transition-all text-left uppercase tracking-tighter"
        >
            <div className="flex items-center gap-2">
                {icon && <span className="text-blue-400 text-sm">{icon}</span>}
                <span>{label}</span>
            </div>
        </button>
    );
}

function TransactionDetailModal({ 
    instruction, 
    invoices = [], 
    onClose,
    showToast,
    onInvestigateAI,
    onMetadataUpdated,
}: { 
    instruction: Instruction; 
    invoices?: Invoice[]; 
    onClose: () => void;
    showToast?: (type: 'success' | 'error' | 'info' | 'warning', title: string, message: string) => void;
    onInvestigateAI?: (txId: string) => void;
    onMetadataUpdated?: (instructionId: string, metadata: InstructionMetadata) => void;
}) {
    const initialMeta = instruction.metadata || {};
    const [category, setCategory] = useState<string>(initialMeta.category || instruction.purpose || 'UNKNOWN');
    const [notes, setNotes] = useState<string>(initialMeta.notes || '');
    const [gstApplicable, setGstApplicable] = useState<string>(initialMeta.gstApplicable || 'exempt');
    const [linkedInvoiceId, setLinkedInvoiceId] = useState<string>(initialMeta.linkedInvoiceId || '');
    const [version, setVersion] = useState<number>(initialMeta.version || 1);

    // Save & Loading states
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);
    const [hasUnsavedChanges, setHasUnsavedChanges] = useState<boolean>(false);
    const [isLoadingFresh, setIsLoadingFresh] = useState<boolean>(true);
    const [lastSavedAt, setLastSavedAt] = useState<string | null>(
        initialMeta.annotated_at 
            ? new Date(initialMeta.annotated_at as string).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true }) + ' IST'
            : null
    );

    // Fetch latest persisted metadata from backend on mount or when instruction changes
    useEffect(() => {
        let isMounted = true;
        const fetchLatestMetadata = async () => {
            try {
                setIsLoadingFresh(true);
                const res = await fetch(`/api/instruction/${instruction.instruction_id}/metadata`);
                if (res.ok && isMounted) {
                    const data = await res.json();
                    if (data && data.metadata && Object.keys(data.metadata).length > 0) {
                        const m = data.metadata;
                        if (m.category) setCategory(m.category);
                        if (m.notes !== undefined) setNotes(m.notes);
                        if (m.gstApplicable) setGstApplicable(m.gstApplicable);
                        if (m.linkedInvoiceId !== undefined) setLinkedInvoiceId(m.linkedInvoiceId);
                        if (m.version) setVersion(m.version);
                        if (m.annotated_at) {
                            setLastSavedAt(new Date(m.annotated_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true }) + ' IST');
                        }
                    }
                }
            } catch {
                // Silently fallback to initial state from instruction object
            } finally {
                if (isMounted) setIsLoadingFresh(false);
            }
        };

        fetchLatestMetadata();
        return () => { isMounted = false; };
    }, [instruction.instruction_id]);

    const handleSaveAnnotations = async () => {
        if (notes.length > 1000) {
            setSaveStatus('error');
            setSaveErrorMessage(`Notes exceed maximum allowed length of 1000 characters (current: ${notes.length}).`);
            if (showToast) showToast('error', 'Validation Error', 'Notes exceed maximum length of 1000 characters.');
            return;
        }

        setSaveStatus('saving');
        setSaveErrorMessage(null);

        try {
            const executePatch = async () => {
                return await fetch(`/api/instruction/${instruction.instruction_id}/metadata`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        category,
                        notes,
                        gstApplicable,
                        linkedInvoiceId: linkedInvoiceId || undefined,
                        expectedVersion: version,
                    }),
                });
            };

            let res = await executePatch();

            // Transparent dev session recovery for local development
            if (res.status === 401) {
                try {
                    const devSessionRes = await fetch('/api/instruction/dev-session', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                    });
                    if (devSessionRes.ok) {
                        res = await executePatch();
                    }
                } catch {
                    // Fallthrough to standard error handling
                }
            }

            const data = await res.json().catch(() => ({}));

            if (res.ok && data.success) {
                setSaveStatus('saved');
                setHasUnsavedChanges(false);
                if (data.metadata?.version) {
                    setVersion(data.metadata.version);
                }
                const formattedTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true }) + ' IST';
                setLastSavedAt(formattedTime);
                if (onMetadataUpdated && data.metadata) {
                    onMetadataUpdated(instruction.instruction_id, data.metadata);
                }
                if (showToast) {
                    showToast('success', 'Annotations Saved', `Transaction annotations persisted to PostgreSQL (v${data.metadata?.version || version + 1}).`);
                }
                setTimeout(() => {
                    setSaveStatus(prev => (prev === 'saved' ? 'idle' : prev));
                }, 3000);
            } else if (res.status === 409) {
                // Optimistic concurrency conflict
                setSaveStatus('error');
                const conflictMsg = data.detail || 'Concurrent modification conflict detected: record updated by another operator.';
                setSaveErrorMessage(`Conflict: ${conflictMsg}`);
                if (data.currentMetadata?.version) {
                    setVersion(data.currentMetadata.version);
                }
                if (showToast) {
                    showToast('warning', 'Concurrency Conflict', conflictMsg);
                }
            } else {
                // Error response: preserve unsaved input in state
                setSaveStatus('error');
                const errMsg = data.detail || data.error || 'Failed to persist annotations to backend.';
                setSaveErrorMessage(errMsg);
                if (showToast) {
                    showToast('error', 'Save Failed', errMsg);
                }
            }
        } catch (err) {
            setSaveStatus('error');
            const errMsg = err instanceof Error ? err.message : 'Network error persisting annotations.';
            setSaveErrorMessage(errMsg);
            if (showToast) {
                showToast('error', 'Network Error', errMsg);
            }
        }
    };

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
    };

    return (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={onClose} />
            <div className="relative bg-[#0F1318] border border-gray-800 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200 font-sans">
                <div className="bg-[#161B22] px-6 py-4 border-b border-gray-800 flex justify-between items-center">
                    <div>
                        <h3 className="text-white font-semibold flex items-center gap-2">
                             <span className="text-blue-500">{'\u25CF'}</span> Transaction Details
                        </h3>
                        <p className="text-[10px] text-gray-500 font-mono mt-0.5 uppercase tracking-widest">Project Fusion Transaction Record</p>
                    </div>
                    <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">{'\u00D7'}</button>
                </div>
                
                <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
                    {/* SYNTHETIC DEMO FIXTURE WATERMARK */}
                    {(instruction.instruction_id === '99999999-9999-4999-8999-999999999999' || instruction.instruction_id?.startsWith('99999999-') || instruction.sender === 'SYNTHETIC_SENDER' || Boolean(instruction.metadata?.notes?.includes('R3C.1'))) && (
                        <div className="bg-amber-950/40 border border-amber-600/70 rounded-xl p-3.5 flex items-center gap-3 text-amber-200 shadow-md">
                            <span className="text-xl">🧪</span>
                            <div>
                                <span className="font-extrabold text-amber-400 uppercase tracking-wider font-mono text-xs block">
                                    SYNTHETIC DEMO FIXTURE — NOT A REAL PAYMENT
                                </span>
                                <p className="text-gray-300 text-[10px] font-mono mt-0.5">
                                    Deterministic test fixture for transaction annotation and audit qualification. Isolated from payment settlement.
                                </p>
                            </div>
                        </div>
                    )}

                    {/* COMPLIANCE ALERT */}
                    {instruction.state === 'REJECTED_COMPLIANCE' && (
                        <div className="bg-red-900/20 border border-red-500/50 rounded-xl p-4 flex items-start gap-3 animate-pulse">
                            <span className="text-2xl">{'🛡️'}</span> 
                            <div>
                                <h4 className="text-red-400 font-bold text-sm tracking-tight uppercase">Guardian Compliance Block</h4>
                                <p className="text-red-300/80 text-[10px] font-mono leading-relaxed mt-1">
                                    {instruction.error_message || "This recipient has been flagged by the integrated Sanctions Screening engine. Execution was aborted to maintain Project Fusion regulatory compliance."}
                                </p>
                            </div>
                        </div>
                    )}

                    {/* FAILURE RATIONALE */}
                    {instruction.state === 'FAILED' && instruction.error_message && (
                        <div className="bg-red-900/10 border border-red-800/50 rounded-xl p-4 flex items-start gap-3">
                            <span className="text-lg text-red-500">{'⚠'}</span>
                            <div>
                                <h4 className="text-red-400 font-bold text-xs uppercase tracking-tight">Failure Rationale</h4>
                                <p className="text-gray-300 text-[10px] font-mono leading-relaxed mt-1">
                                    {instruction.error_message}
                                </p>
                            </div>
                        </div>
                    )}


                    {/* Primary Info */}
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1">
                            <label className="text-[10px] text-gray-600 uppercase font-bold tracking-tighter">Instruction ID</label>
                            <div className="flex items-center gap-2 bg-black/40 p-2 rounded border border-gray-800">
                                <span className="font-mono text-xs text-blue-400 truncate">{instruction.instruction_id}</span>
                                <button 
                                    onClick={() => {
                                        copyToClipboard(instruction.instruction_id);
                                        if (showToast) showToast("success", "Instruction ID Copied", "The instruction ID was copied to your clipboard.");
                                    }} 
                                    className="text-[10px] text-gray-600 hover:text-blue-400 font-bold"
                                >
                                    COPY
                                </button>
                            </div>
                        </div>
                        <div className="space-y-1">
                            <label className="text-[10px] text-gray-600 uppercase font-bold tracking-tighter">Settlement Rail</label>
                            <div className="bg-black/40 p-2 rounded border border-gray-800 text-xs text-white font-mono">
                                {["XLM", "BTC", "ETH", "USDC"].includes(instruction.currency) ? "Digital Asset Network" : instruction.currency === "INR" ? "Domestic Payment Network" : "Global Fiat Network"}
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-3 gap-4">
                        <div className="space-y-1">
                            <label className="text-[10px] text-gray-600 uppercase font-bold tracking-tighter">Amount</label>
                            <div className="text-lg font-mono text-white font-bold">{parseFloat(instruction.amount).toFixed(2)}</div>
                        </div>
                        <div className="space-y-1">
                            <label className="text-[10px] text-gray-600 uppercase font-bold tracking-tighter">Currency</label>
                            <div className="text-lg font-mono text-blue-400 font-bold">{instruction.currency}</div>
                        </div>
                        <div className="space-y-1 text-right">
                             <label className="text-[10px] text-gray-600 uppercase font-bold tracking-tighter">Status</label>
                             <div>
                                <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-blue-900/30 text-blue-400 border border-blue-800/50">
                                    {instruction.state}
                                </span>
                             </div>
                        </div>
                    </div>

                    <hr className="border-gray-800" />

                    {/* Parties */}
                    <div className="space-y-4">
                        <div className="flex justify-between items-center text-xs">
                            <span className="text-gray-500">Sender Reference</span>
                            <span className="text-gray-300 font-mono italic">{instruction.sender_hash}</span>
                        </div>
                        <div className="flex justify-between items-center text-xs">
                            <span className="text-gray-500">Recipient Reference</span>
                            <span className="text-gray-300 font-mono italic">{instruction.recipient_hash}</span>
                        </div>
                        <div className="flex justify-between items-center text-xs">
                            <span className="text-gray-500">Purpose of Remittance</span>
                            <span className="text-white font-bold uppercase">{instruction.purpose}</span>
                        </div>
                        <div className="flex justify-between items-center text-xs">
                            <span className="text-gray-500">Execution Timestamp</span>
                            <span className="text-gray-400">{new Date(instruction.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true })} IST</span>
    {/* Explicitly check if the date is being interpreted correctly */}
    <span className="text-[8px] text-gray-700 block mt-0.5">(System Time: {new Date(instruction.timestamp).toISOString()})</span>
                        </div>
                    </div>

                    {/* Network Verification & External Explorer Integration */}
                    {instruction.trace_id && instruction.trace_id !== 'N/A' ? (
                        <div className="bg-[#121820] border border-blue-900/50 p-4 rounded-xl space-y-3">
                            <div className="flex items-center justify-between">
                                <label className="text-[9px] text-blue-400 uppercase font-bold tracking-wider">
                                    {['XLM', 'USDC'].includes(instruction.currency) 
                                        ? '⚡ Stellar Blockchain Transaction Hash' 
                                        : instruction.currency === 'INR' 
                                            ? (instruction.trace_id.startsWith('pout_') ? '💳 RazorpayX Payout ID' : '💳 RazorpayX UTR Number') 
                                            : '💰 Stripe Payment Intent ID'}
                                </label>
                                <span className="text-[8px] bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded border border-blue-500/20 font-mono">Verified Rail</span>
                            </div>
                            
                            <div className="flex items-center justify-between bg-black/40 p-2.5 rounded-lg border border-gray-800 gap-3 group">
                                <span className="font-mono text-xs text-blue-300 break-all select-all">{instruction.trace_id}</span>
                                <button 
                                    onClick={() => {
                                        copyToClipboard(instruction.trace_id || '');
                                        if (showToast) {
                                            showToast("success", "Transaction ID Copied", "The settlement / transaction ID has been copied to your clipboard.");
                                        } else {
                                            alert("Transaction ID/Hash copied to clipboard!");
                                        }
                                    }} 
                                    className="text-[9px] bg-gray-800 hover:bg-gray-700 text-gray-300 font-bold px-2 py-1 rounded shrink-0 transition-colors"
                                >
                                    COPY
                                </button>
                            </div>
                            
                            <div className="flex justify-start">
                                <a 
                                    href={
                                        ['XLM', 'USDC'].includes(instruction.currency)
                                            ? `https://stellar.expert/explorer/testnet/tx/${instruction.trace_id}`
                                            : instruction.currency === 'INR'
                                                ? `https://dashboard.razorpay.com/#/app/payouts/${instruction.external_intent_id || instruction.trace_id}`
                                                : `https://dashboard.stripe.com/test/payments/${instruction.trace_id}`
                                    }
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-[9px] text-blue-400 hover:text-blue-300 font-bold flex items-center gap-1 hover:underline"
                                >
                                    <span>➔ VIEW ON REAL {['XLM', 'USDC'].includes(instruction.currency) ? 'STELLAR EXPLORER' : instruction.currency === 'INR' ? 'RAZORPAYX DASHBOARD' : 'STRIPE DASHBOARD'}</span>
                                </a>
                            </div>
                        </div>
                    ) : (
                        <div className="bg-[#121820]/40 border border-gray-800 p-3 rounded-lg text-center">
                            <span className="text-[9px] text-gray-600 italic">No external gateway ID or blockchain hash available for this state.</span>
                        </div>
                    )}

                    <hr className="border-gray-800" />

                    {/* Categorization & Metadata (Indian Compliance Grade - PostgreSQL Persisted) */}
                    <div className="bg-[#161B22]/50 border border-gray-800/80 rounded-xl p-4 space-y-4">
                        <div className="flex items-center justify-between">
                            <h4 className="text-[10px] font-bold text-blue-400 uppercase tracking-wider">CFO &amp; Compliance Classification</h4>
                            <span className="text-[9px] font-mono bg-blue-950/80 text-blue-300 border border-blue-800/50 px-2 py-0.5 rounded">
                                Institutional Audit Record (v{version})
                            </span>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            {/* Category Dropdown */}
                            <div className="space-y-1">
                                <label className="text-[9px] text-gray-500 uppercase tracking-wider font-bold">Category</label>
                                <select
                                    value={category}
                                    onChange={e => { setCategory(e.target.value); setHasUnsavedChanges(true); }}
                                    className="w-full bg-[#0a0d11] text-xs px-2 py-1.5 rounded border border-gray-800 text-gray-300 outline-none focus:border-blue-600"
                                >
                                    <option value="UNKNOWN">Select Category...</option>
                                    <option value="SALARY">SALARY</option>
                                    <option value="VENDOR_PAYMENT">VENDOR_PAYMENT</option>
                                    <option value="GST_PAYMENT">GST_PAYMENT</option>
                                    <option value="TDS">TDS PAYMENT</option>
                                    <option value="TAX_PAYMENT">TAX_PAYMENT</option>
                                    <option value="EMI_REPAYMENT">EMI_REPAYMENT</option>
                                    <option value="TRANSFER_INTERNAL">TRANSFER_INTERNAL</option>
                                    <option value="CUSTOMER_RECEIPT">CUSTOMER_RECEIPT</option>
                                    <option value="OPEX">OPEX (Operating Expense)</option>
                                    <option value="CAPEX">CAPEX (Capital Expenditure)</option>
                                    <option value="LOAN">LOAN DISBURSEMENT</option>
                                </select>
                            </div>

                            {/* GST Applicability */}
                            <div className="space-y-1">
                                <label className="text-[9px] text-gray-500 uppercase tracking-wider font-bold">GST Applicability</label>
                                <select
                                    value={gstApplicable}
                                    onChange={e => { setGstApplicable(e.target.value); setHasUnsavedChanges(true); }}
                                    className="w-full bg-[#0a0d11] text-xs px-2 py-1.5 rounded border border-gray-800 text-gray-300 outline-none focus:border-blue-600"
                                >
                                    <option value="yes">GST Applicable (18% standard)</option>
                                    <option value="no">GST Not Applicable</option>
                                    <option value="exempt">GST Exempt / Nil Rated</option>
                                </select>
                            </div>
                        </div>

                        {/* Attach to Invoice Lookup */}
                        {invoices.length > 0 && (
                            <div className="space-y-1">
                                <label className="text-[9px] text-gray-500 uppercase tracking-wider font-bold">Attach to Invoice Link</label>
                                <select
                                    value={linkedInvoiceId}
                                    onChange={e => { setLinkedInvoiceId(e.target.value); setHasUnsavedChanges(true); }}
                                    className="w-full bg-[#0a0d11] text-xs px-2 py-1.5 rounded border border-gray-800 text-gray-300 outline-none focus:border-blue-600 font-mono"
                                >
                                    <option value="">No Invoice Linked</option>
                                    {invoices.map(inv => (
                                        <option key={inv.invoice_id} value={inv.invoice_id}>
                                             {inv.invoice_id.slice(0,8)}... ({inv.seller_name} → {inv.total_amount} {inv.currency})
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {/* Free-text Notes */}
                        <div className="space-y-1">
                            <div className="flex items-center justify-between">
                                <label className="text-[9px] text-gray-500 uppercase tracking-wider font-bold">Audit Notes &amp; CA Commentary</label>
                                <span className={`text-[9px] font-mono ${notes.length > 1000 ? 'text-red-400 font-bold' : notes.length > 900 ? 'text-amber-400' : 'text-gray-500'}`}>
                                    {notes.length}/1000 chars
                                </span>
                            </div>
                            <textarea
                                value={notes}
                                onChange={e => { setNotes(e.target.value); setHasUnsavedChanges(true); }}
                                placeholder="Enter transaction annotation or verification remarks..."
                                className={`w-full h-14 bg-[#0a0d11] text-xs px-2.5 py-1.5 rounded border text-gray-300 outline-none font-sans resize-none normal-case transition-colors ${
                                    notes.length > 1000 ? 'border-red-500 focus:border-red-400' : 'border-gray-800 focus:border-blue-600'
                                }`}
                            />
                        </div>

                        {/* Persistence Action Bar */}
                        <div className="pt-2 border-t border-gray-800/80 flex items-center justify-between">
                            <div className="flex items-center gap-2 text-[10px]">
                                {isLoadingFresh ? (
                                    <span className="text-gray-400 font-mono animate-pulse">⟳ Checking PostgreSQL persistence...</span>
                                ) : saveStatus === 'saving' ? (
                                    <span className="text-blue-400 font-mono animate-pulse">Saving to PostgreSQL...</span>
                                ) : saveStatus === 'saved' ? (
                                    <span className="text-emerald-400 font-mono flex items-center gap-1 font-bold">✓ Persisted to fusion_db (v{version})</span>
                                ) : saveStatus === 'error' ? (
                                    <span className="text-red-400 font-mono text-[9px] truncate max-w-70" title={saveErrorMessage || ''}>
                                        ⚠ {saveErrorMessage || 'Save failed'}
                                    </span>
                                ) : hasUnsavedChanges ? (
                                    <span className="text-amber-400 font-mono flex items-center gap-1 font-medium">● Unsaved annotations</span>
                                ) : lastSavedAt ? (
                                    <span className="text-gray-500 font-mono text-[9px]">Synced at {lastSavedAt}</span>
                                ) : (
                                    <span className="text-gray-500 font-mono text-[9px]">Ready</span>
                                )}
                            </div>

                            <button
                                type="button"
                                disabled={saveStatus === 'saving' || notes.length > 1000}
                                onClick={handleSaveAnnotations}
                                className={`text-xs px-3 py-1.5 rounded-lg font-mono font-bold transition-all shadow-sm flex items-center gap-1.5 ${
                                    saveStatus === 'saving'
                                        ? 'bg-blue-950 text-blue-400 border border-blue-800/50 cursor-not-allowed'
                                        : saveStatus === 'error'
                                        ? 'bg-red-900/60 hover:bg-red-800/80 text-red-200 border border-red-700/60'
                                        : hasUnsavedChanges
                                        ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-600/30'
                                        : 'bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700/50'
                                }`}
                            >
                                {saveStatus === 'saving' ? (
                                    <>
                                        <span className="inline-block animate-spin text-[10px]">⚙</span>
                                        <span>SAVING...</span>
                                    </>
                                ) : saveStatus === 'error' ? (
                                    <span>RETRY SAVE</span>
                                ) : (
                                    <span>SAVE ANNOTATIONS</span>
                                )}
                            </button>
                        </div>
                    </div>

                    <hr className="border-gray-800" />

                    {/* Ledger Evidence */}
                    <div className="space-y-2">
                        <label className="text-[10px] text-gray-600 uppercase font-bold tracking-tighter">Smart Settlement Ledger Hashes (Audit Log)</label>
                        <div className="space-y-1.5">
                            {instruction.ledger_hashes && instruction.ledger_hashes.length > 0 ? (
                                instruction.ledger_hashes.map((hash, i) => (
                                    <div key={i} className="flex items-center justify-between bg-black/20 p-2 rounded border border-gray-800/50 group">
                                        <span className="font-mono text-[9px] text-gray-500 truncate pr-4">{hash}</span>
                                        <button onClick={() => copyToClipboard(hash)} className="text-[9px] text-gray-700 hover:text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity font-bold">COPY</button>
                                    </div>
                                ))
                            ) : (
                                <div className="text-[10px] text-gray-700 italic">No ledger entries generated yet for this state.</div>
                            )}
                        </div>
                    </div>
                </div>

                <div className="bg-[#161B22] px-6 py-4 border-t border-gray-800 flex items-center justify-between">
                    <button
                        type="button"
                        onClick={() => {
                            if (onInvestigateAI) {
                                onInvestigateAI(instruction.instruction_id);
                            }
                        }}
                        className="bg-linear-to-r from-blue-900/50 via-indigo-900/50 to-purple-900/50 hover:from-blue-800/70 hover:to-purple-800/70 border border-blue-700/60 text-blue-200 text-xs px-3.5 py-2 rounded-lg transition-all flex items-center gap-2 font-mono font-bold shadow-md hover:shadow-blue-500/20 active:scale-98"
                    >
                        <span className="text-amber-400">⚡</span>
                        <span>Investigate with AI Copilot</span>
                    </button>
                    <button onClick={onClose} className="bg-gray-800 hover:bg-gray-700 text-white text-xs px-4 py-2 rounded-lg transition-colors">
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}

interface ZohoStatusInfo {
    state?: string;
    settled?: boolean;
    settlementRef?: string;
    settledAt?: string;
    success?: boolean;
    reconciliation?: { status?: string; [key: string]: unknown };
    complianceDocs?: { doc_type?: string; [key: string]: unknown }[];
    [key: string]: unknown;
}

interface ZohoPayResult {
    success?: boolean;
    instructionId?: string;
    rail?: string;
    amount?: string | number;
    currency?: string;
    state?: string;
    error?: string;
    [key: string]: unknown;
}

function InvoicePanel({ data, onViewSaga, onZohoStatus, onZohoPay, zohoStatusMap }: { 
    data: Invoice[], 
    onViewSaga: (inv: Invoice) => void,
    onZohoStatus?: (id: string) => void,
    onZohoPay?: (inv: Invoice) => void,
    zohoStatusMap?: Record<string, ZohoStatusInfo>
}) {
    const zohoInvoices = data.filter(i => i.source_type === 'zoho');
    const otherInvoices = data.filter(i => i.source_type !== 'zoho');
    const sortedData = [...zohoInvoices, ...otherInvoices];

    return (
        <div className="bg-[#0F1318] rounded-xl border border-gray-800/60 overflow-hidden">
            <div className="grid grid-cols-12 text-[10px] text-gray-600 uppercase tracking-widest px-4 py-2 border-b border-gray-800 bg-[#0B0E14]">
                <div className="col-span-1">Src</div>
                <div className="col-span-3">Invoice ID</div>
                <div className="col-span-2">Amount</div>
                <div className="col-span-2">Parties</div>
                <div className="col-span-2">Status</div>
                <div className="col-span-2 text-right">Actions</div>
            </div>
            {sortedData.length === 0 ? (
                <div className="p-8 text-center space-y-2">
                    <div className="text-gray-600 text-sm">No invoices recorded.</div>
                    <div className="text-gray-700 text-[10px] font-mono">Upload a PDF/CSV or pull from Zoho Books above.</div>
                </div>
            ) : (
                sortedData.map((inv) => (
                    <InvoiceRow 
                        key={inv.invoice_id} 
                        inv={inv} 
                        onViewSaga={() => onViewSaga(inv)}
                        onZohoStatus={onZohoStatus}
                        onZohoPay={onZohoPay}
                        zohoStatus={zohoStatusMap?.[inv.invoice_id]}
                    />
                ))
            )}
        </div>
    );
}

function InvoiceRow({ inv, onViewSaga, onZohoStatus, onZohoPay, zohoStatus }: { 
    inv: Invoice, 
    onViewSaga: () => void,
    onZohoStatus?: (id: string) => void,
    onZohoPay?: (inv: Invoice) => void,
    zohoStatus?: ZohoStatusInfo
}) {
    const statusColors: Record<string, string> = {
        PROCESSED:        'text-green-400 bg-green-900/20 border-green-800/30',
        PENDING_APPROVAL: 'text-amber-400 bg-amber-900/30 border-amber-800/30',
        INITIATED:        'text-blue-400 bg-blue-900/20 border-blue-800/30',
        SETTLED:          'text-emerald-400 bg-emerald-900/20 border-emerald-800/30',
        FAILED:           'text-red-400 bg-red-900/20 border-red-800/30',
    };
    
    const isZoho = inv.source_type === 'zoho';
    const canPay = isZoho && !['SETTLED', 'INITIATED'].includes(inv.state);
    const sourceIcon = isZoho ? '📗' : inv.source_type === 'pdf' ? '📄' : inv.source_type === 'csv' ? '⇅' : '◈';

    return (
        <div className={`border-b border-gray-800/50 last:border-0 transition-all ${isZoho ? 'bg-emerald-950/10 hover:bg-emerald-950/20' : 'hover:bg-white/4'}`}>
            <div className="grid grid-cols-12 items-center px-4 py-3 text-xs group">
                <div className="col-span-1">
                    <span className="text-base" title={isZoho ? 'Zoho Books' : inv.source_type}>{sourceIcon}</span>
                </div>
                <div className="col-span-3 font-mono text-gray-400 text-[10px] truncate pr-2">
                    {inv.invoice_id}
                    {isZoho && (
                        <div className="text-[9px] text-emerald-600 mt-0.5">via Zoho Books</div>
                    )}
                </div>
                <div className="col-span-2 font-mono text-white font-semibold">
                    {parseFloat(inv.total_amount).toFixed(2)}{' '}
                    <span className="text-gray-600">{inv.currency}</span>
                </div>
                <div className="col-span-2 flex flex-col gap-0.5">
                    <div className="text-[10px] text-gray-300 truncate">{inv.seller_name}</div>
                    <div className="text-[10px] text-gray-600 truncate">{inv.buyer_name}</div>
                </div>
                <div className="col-span-2">
                    <span className={`px-2 py-0.5 rounded border text-[10px] font-mono font-semibold ${statusColors[inv.state] || 'text-gray-400 bg-gray-800/30 border-gray-700/30'}`}>
                        {inv.state}
                    </span>
                </div>
                <div className="col-span-2 text-right flex items-center justify-end gap-1">
                    {/* Pay Now — only for Zoho invoices not yet settled */}
                    {canPay && onZohoPay && (
                        <button 
                            onClick={() => onZohoPay(inv)}
                            className="text-[9px] bg-emerald-600 hover:bg-emerald-500 text-white font-bold border border-emerald-500/50 px-2.5 py-1 rounded transition-all animate-pulse hover:animate-none"
                            title="Pay this invoice via Fusion payment rails"
                        >
                            ⚡ Pay Now
                        </button>
                    )}
                    {isZoho && inv.state === 'INITIATED' && (
                        <span className="text-[9px] text-blue-400 font-mono animate-pulse">Processing...</span>
                    )}
                    {isZoho && inv.state === 'SETTLED' && (
                        <span className="text-[9px] text-emerald-400 font-mono">✓ Paid</span>
                    )}
                    {isZoho && onZohoStatus && (
                        <button 
                            onClick={() => onZohoStatus(inv.invoice_id)}
                            className="text-[9px] bg-emerald-900/20 hover:bg-emerald-700/30 text-emerald-500 hover:text-emerald-300 border border-emerald-800/30 px-2 py-1 rounded transition-all"
                            title="Check Zoho pipeline status"
                        >
                            Status
                        </button>
                    )}
                    <button 
                        onClick={onViewSaga}
                        className="text-[10px] bg-blue-900/30 hover:bg-blue-600 text-blue-400 hover:text-white border border-blue-800/50 px-3 py-1 rounded transition-all"
                    >
                        View Saga
                    </button>
                </div>
            </div>

            {/* Zoho pipeline status panel (shown after clicking Status) */}
            {isZoho && zohoStatus && zohoStatus.success !== false && (
                <div className="mx-4 mb-3 bg-[#0B0E14] border border-emerald-800/20 rounded-lg p-3 space-y-2">
                    <div className="text-[9px] text-emerald-500 uppercase tracking-widest font-bold mb-2">Zoho Pipeline Status</div>
                    <div className="grid grid-cols-3 gap-3 text-[10px] font-mono">
                        <div>
                            <div className="text-gray-600">Fusion State</div>
                            <div className={`font-bold mt-0.5 ${zohoStatus.state === 'SETTLED' ? 'text-emerald-400' : zohoStatus.state === 'FAILED' ? 'text-red-400' : 'text-amber-400'}`}>
                                {zohoStatus.state || '—'}
                            </div>
                        </div>
                        <div>
                            <div className="text-gray-600">Reconciliation</div>
                            <div className={`font-bold mt-0.5 ${zohoStatus.reconciliation?.status === 'RECONCILED' ? 'text-emerald-400' : 'text-gray-500'}`}>
                                {zohoStatus.reconciliation?.status || 'PENDING'}
                            </div>
                        </div>
                        <div>
                            <div className="text-gray-600">Compliance Docs</div>
                            <div className="font-bold mt-0.5 text-blue-400">
                                {zohoStatus.complianceDocs?.length || 0} generated
                            </div>
                        </div>
                    </div>
                    {zohoStatus.settlementRef && (
                        <div className="text-[9px] text-gray-600 font-mono border-t border-gray-800 pt-2 mt-2">
                            Ref: {zohoStatus.settlementRef}
                        </div>
                    )}
                    {zohoStatus.complianceDocs && zohoStatus.complianceDocs.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                            {zohoStatus.complianceDocs.map((d: { doc_type?: string }, i: number) => (
                                <span key={i} className="text-[9px] bg-blue-900/20 text-blue-400 border border-blue-800/30 px-1.5 py-0.5 rounded font-mono">
                                    {d.doc_type}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function SagaTrackingModal({ 
    invoice, 
    steps, 
    isLoading, 
    onClose 
}: { 
    invoice: Invoice, 
    steps: { condition?: string; status?: string; amount_pct?: number; rail?: string; escrow_flagged?: boolean }[], 
    isLoading: boolean, 
    onClose: () => void 
}) {
    return (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={onClose} />
            <div className="relative bg-[#0F1318] border border-gray-800 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl animate-in fade-in zoom-in duration-200">
                <div className="bg-[#161B22] px-6 py-4 border-b border-gray-800 flex justify-between items-center">
                    <div>
                        <h3 className="text-white font-semibold flex items-center gap-2">
                             <span className="text-indigo-500">{'\u21C5'}</span> Saga Pipeline Tracking
                        </h3>
                        <p className="text-[10px] text-gray-500 font-mono mt-0.5 uppercase tracking-widest">{invoice.invoice_id}</p>
                    </div>
                    <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">{'\u00D7'}</button>
                </div>
                
                <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
                    {isLoading ? (
                        <div className="py-20 flex flex-col items-center justify-center gap-3">
                            <div className="animate-spin rounded-full h-8 w-8 border-2 border-indigo-500 border-t-transparent" />
                            <div className="text-xs text-indigo-400 font-mono animate-pulse">RECONSTRUCTING SAGA STATE...</div>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <div className="relative border-l-2 border-gray-800 ml-3 pl-6 space-y-8">
                                {steps.map((step, i) => (
                                    <div key={i} className="relative">
                                        <div className={`absolute -left-7.75 top-0 w-4 h-4 rounded-full border-2 bg-[#0F1318] ${step.status === 'COMPLETED' ? 'border-green-500' : 'border-gray-700'} flex items-center justify-center`}>
                                            {step.status === 'COMPLETED' && <span className="text-[8px] text-green-500">{'\u2713'}</span>}
                                        </div>
                                        <div className="space-y-1">
                                            <div className="flex justify-between items-center">
                                                <h4 className="text-xs font-bold text-white uppercase tracking-tight">{step.condition?.replace(/_/g, ' ')}</h4>
                                                <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${step.status === 'PENDING' ? 'text-amber-400 bg-amber-900/20' : 'text-green-400 bg-green-900/20'}`}>
                                                    {step.status}
                                                </span>
                                            </div>
                                            <div className="flex justify-between text-[10px] font-mono">
                                                <span className="text-gray-500">Distribution: {step.amount_pct}% of Total</span>
                                                <span className="text-indigo-400">Rail: {step.rail}</span>
                                            </div>
                                            {step.escrow_flagged && (
                                                <div className="mt-2 bg-indigo-900/10 border border-indigo-500/20 rounded p-2 flex items-center gap-2">
                                                    <span className="text-xs">🛡️</span>
                                                    <span className="text-[9px] text-indigo-300 font-mono">Escrow Hold Mandatory for this step (GIFT IFSC Rule)</span>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                            
                            <div className="mt-8 pt-6 border-t border-gray-800">
                                <div className="bg-gray-900/40 rounded-lg p-4 space-y-2">
                                    <div className="flex justify-between text-[10px]">
                                        <span className="text-gray-500">Deterministic Saga ID</span>
                                        <span className="text-gray-300 font-mono">{invoice.saga_id}</span>
                                    </div>
                                    <div className="flex justify-between text-[10px]">
                                        <span className="text-gray-500">Compliance Hash</span>
                                        <span className="text-gray-300 font-mono">{(invoice.saga_id || invoice.invoice_id || 'FUSION').replace(/[^a-zA-Z0-9]/g, '').padEnd(16, '0').slice(0, 16).toUpperCase()}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <div className="bg-[#161B22] px-6 py-4 border-t border-gray-800 flex justify-end">
                    <button onClick={onClose} className="bg-gray-800 hover:bg-gray-700 text-white text-xs px-4 py-2 rounded-lg transition-colors">
                        Close Tracking
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─ ZOHO PAY MODAL ──────────────────────────────────────────────────────────

function ZohoPayModal({
    invoice, rails, selectedRail, setSelectedRail,
    currency, setCurrency, isPaying, result, onPay, onClose
}: {
    invoice: Invoice;
    rails: { id: string; label: string; currencies: string[] }[];
    selectedRail: string;
    setSelectedRail: (r: string) => void;
    currency: string;
    setCurrency: (c: string) => void;
    isPaying: boolean;
    result: ZohoPayResult | null;
    onPay: () => void;
    onClose: () => void;
}) {
    const currentRail = rails.find(r => r.id === selectedRail) || rails[0];

    return (
        <div className="fixed inset-0 z-70 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={!isPaying ? onClose : undefined} />
            <div className="relative bg-[#0F1318] border border-emerald-800/30 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl shadow-emerald-950/30 animate-in fade-in zoom-in duration-200">
                
                {/* Header */}
                <div className="zoho-payment-modal-header bg-linear-to-r from-[#0F1E18] to-[#0F1318] px-6 py-4 border-b border-emerald-800/20 flex justify-between items-center">
                    <div>
                        <h3 className="text-white font-semibold flex items-center gap-2">
                            <span className="text-emerald-400">⚡</span>
                            Pay via Fusion
                        </h3>
                        <p className="text-[10px] text-emerald-700 font-mono mt-0.5 uppercase tracking-widest">
                            Zoho Books → Fusion SAGA → Settlement
                        </p>
                    </div>
                    <button onClick={onClose} disabled={isPaying} className="text-gray-500 hover:text-white text-xl disabled:opacity-30">×</button>
                </div>

                <div className="p-6 space-y-5">
                    {/* Invoice Summary */}
                    <div className="bg-emerald-950/20 border border-emerald-800/20 rounded-xl p-4">
                        <div className="text-[9px] text-emerald-600 uppercase tracking-widest font-bold mb-2">Invoice Details</div>
                        <div className="flex justify-between items-start">
                            <div>
                                <div className="text-xs text-gray-500 font-mono">{invoice.invoice_id}</div>
                                <div className="text-[10px] text-gray-600 mt-0.5">{invoice.buyer_name} → {invoice.seller_name}</div>
                            </div>
                            <div className="text-right">
                                <div className="text-xl font-bold font-mono text-white">
                                    {parseFloat(invoice.total_amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                                </div>
                                <div className="text-[10px] text-emerald-500 font-mono">{invoice.currency}</div>
                            </div>
                        </div>
                    </div>

                    {/* Rail Selector */}
                    <div className="space-y-2">
                        <label className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Payment Rail</label>
                        <div className="space-y-1.5">
                            {rails.map(rail => (
                                <button
                                    key={rail.id}
                                    onClick={() => {
                                        setSelectedRail(rail.id);
                                        // Auto-select first valid currency for this rail
                                        if (!rail.currencies.includes(currency)) {
                                            setCurrency(rail.currencies[0]);
                                        }
                                    }}
                                    className={`w-full text-left px-3 py-2.5 rounded-lg border text-xs transition-all ${
                                        selectedRail === rail.id
                                            ? 'bg-emerald-900/30 border-emerald-600/50 text-emerald-300'
                                            : 'bg-[#161B22] border-gray-800 text-gray-400 hover:border-gray-600 hover:text-gray-200'
                                    }`}
                                >
                                    <div className="flex items-center justify-between">
                                        <span>{rail.label}</span>
                                        {selectedRail === rail.id && <span className="text-emerald-500 text-[10px]">✓ Selected</span>}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Currency selector for chosen rail */}
                    {currentRail.currencies.length > 1 && (
                        <div className="space-y-1.5">
                            <label className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Settlement Currency</label>
                            <div className="flex flex-wrap gap-2">
                                {currentRail.currencies.map(c => (
                                    <button
                                        key={c}
                                        onClick={() => setCurrency(c)}
                                        className={`text-[10px] font-mono px-3 py-1.5 rounded border transition-all ${
                                            currency === c
                                                ? 'bg-blue-900/30 border-blue-600/50 text-blue-300'
                                                : 'bg-[#161B22] border-gray-800 text-gray-500 hover:border-gray-600'
                                        }`}
                                    >
                                        {c}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Result display */}
                    {result && (
                        <div className={`rounded-xl border p-4 space-y-2 ${
                            result.success
                                ? 'bg-emerald-900/15 border-emerald-700/30'
                                : 'bg-red-900/15 border-red-700/30'
                        }`}>
                            {result.success ? (
                                <>
                                    <div className="text-emerald-400 text-xs font-bold flex items-center gap-2">
                                        <span className="text-base">✅</span> Payment Dispatched via Fusion SAGA
                                    </div>
                                    <div className="space-y-1 text-[10px] font-mono">
                                        <div className="flex justify-between">
                                            <span className="text-gray-500">Instruction ID</span>
                                            <span className="text-gray-300 truncate max-w-45">{result.instructionId}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-gray-500">Rail</span>
                                            <span className="text-emerald-400">{result.rail}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-gray-500">Amount</span>
                                            <span className="text-white">{result.amount} {result.currency}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-gray-500">Status</span>
                                            <span className="text-blue-400 animate-pulse">{result.state}</span>
                                        </div>
                                    </div>
                                    <div className="text-[9px] text-gray-600 font-mono border-t border-emerald-800/20 pt-2 mt-1">
                                        Zoho Books will be auto-updated to &quot;Paid&quot; after settlement. Check &quot;Status&quot; button to track.
                                    </div>
                                </>
                            ) : (
                                <div className="text-red-400 text-xs">
                                    ❌ {result.error || 'Payment failed'}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Info box */}
                    {!result && (
                        <div className="bg-[#161B22] border border-gray-800 rounded-lg p-3 text-[9px] text-gray-600 font-mono leading-relaxed">
                            Payment will be dispatched through Fusion&apos;s SAGA orchestrator → executed on selected rail → 
                            Zoho Books invoice auto-marked as <strong className="text-gray-400">Paid</strong> on settlement.
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="bg-[#161B22] px-6 py-4 border-t border-gray-800 flex justify-between items-center gap-3">
                    <button
                        onClick={onClose}
                        disabled={isPaying}
                        className="text-xs text-gray-500 hover:text-white px-4 py-2 rounded-lg border border-gray-800 hover:border-gray-600 transition-colors disabled:opacity-30"
                    >
                        {result?.success ? 'Close' : 'Cancel'}
                    </button>
                    {!result?.success && (
                        <button
                            onClick={onPay}
                            disabled={isPaying}
                            className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-2.5 px-6 rounded-xl transition-all flex items-center justify-center gap-2 text-sm"
                        >
                            {isPaying ? (
                                <>
                                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                                    Executing via SAGA...
                                </>
                            ) : (
                                <>⚡ Execute Payment — {parseFloat(invoice.total_amount).toLocaleString('en-IN')} {currency}</>
                            )}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
