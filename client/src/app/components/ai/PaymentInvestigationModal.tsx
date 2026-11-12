'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    Sparkles,
    X,
    AlertTriangle,
    RefreshCw,
    Cpu,
    Database,
    CheckCircle2,
    Clock,
    ShieldAlert,
    ArrowRight,
    Play,
    Terminal,
    HelpCircle,
    Activity,
    Layers,
    BarChart3,
    Radio,
} from 'lucide-react';
import CopilotInvestigationCard, { InvestigationReport } from './CopilotInvestigationCard';
import InvestigationProgressTimeline, { ProgressEventItem } from './InvestigationProgressTimeline';
import TraceVisualizer, { TraceData } from './TraceVisualizer';
import AIMetricsPanel from './AIMetricsPanel';

export interface SyntheticCaseSummary {
    id: string;
    title: string;
    intent: string;
    transactionId: string;
    question: string;
    expectedStatus: string;
    groundedFinding: string;
    toolsAvailable: string[];
}

export interface PaymentInvestigationModalProps {
    isOpen: boolean;
    onClose: () => void;
    initialCaseId?: string;
    initialTransactionId?: string;
    showToast?: (
        type: 'success' | 'error' | 'warning' | 'info',
        title: string,
        message: string
    ) => void;
}

export default function PaymentInvestigationModal({
    isOpen,
    onClose,
    initialCaseId,
    initialTransactionId,
    showToast,
}: PaymentInvestigationModalProps) {
    const [cases, setCases] = useState<SyntheticCaseSummary[]>([]);
    const [isLoadingCases, setIsLoadingCases] = useState(false);
    const [casesError, setCasesError] = useState<string | null>(null);

    const [selectedCaseId, setSelectedCaseId] = useState<string>('CASE-01');
    const [customQuestion, setCustomQuestion] = useState<string>('');
    const [providerType, setProviderType] = useState<'mock' | 'ollama'>('mock');

    // UI View Tabs: 'investigate' | 'trace' | 'metrics'
    const [activeTab, setActiveTab] = useState<'investigate' | 'trace' | 'metrics'>('investigate');

    // Investigation execution & SSE progress state
    const [isInvestigating, setIsInvestigating] = useState(false);
    const [progressEvents, setProgressEvents] = useState<ProgressEventItem[]>([]);
    const [currentStage, setCurrentStage] = useState<string>('IDLE');
    const [currentTraceId, setCurrentTraceId] = useState<string | undefined>(undefined);

    // Telemetry trace data
    const [traceData, setTraceData] = useState<TraceData | null>(null);
    const [isLoadingTrace, setIsLoadingTrace] = useState<boolean>(false);
    const [traceError, setTraceError] = useState<string | null>(null);

    const [investigationOutcome, setInvestigationOutcome] = useState<{
        report?: InvestigationReport;
        raw_evidence?: Record<string, unknown>;
        case_id?: string;
        warnings?: string[];
        latency_ms?: number;
    } | null>(null);

    const [investigationError, setInvestigationError] = useState<{
        status: string;
        message: string;
        detail?: string;
    } | null>(null);

    const [isCustomerTxNotice, setIsCustomerTxNotice] = useState(false);

    // Abort controller reference for active SSE stream
    const abortControllerRef = useRef<AbortController | null>(null);

    // Fetch available synthetic cases from backend
    const loadSyntheticCases = useCallback(async () => {
        setIsLoadingCases(true);
        setCasesError(null);
        try {
            const res = await fetch('/api/ai/synthetic-cases');
            const data = await res.json();
            if (res.ok && data.success && Array.isArray(data.cases)) {
                setCases(data.cases);
                if (
                    initialCaseId &&
                    data.cases.some((c: SyntheticCaseSummary) => c.id === initialCaseId)
                ) {
                    setSelectedCaseId(initialCaseId);
                    setIsCustomerTxNotice(false);
                } else if (initialTransactionId) {
                    const matched = data.cases.find(
                        (c: SyntheticCaseSummary) => c.transactionId === initialTransactionId
                    );
                    if (matched) {
                        setSelectedCaseId(matched.id);
                        setIsCustomerTxNotice(false);
                    } else {
                        setIsCustomerTxNotice(true);
                    }
                } else {
                    setIsCustomerTxNotice(false);
                }
            } else {
                setCasesError(data.message || data.error || 'Failed to load synthetic cases');
            }
        } catch (err: unknown) {
            setCasesError(
                err instanceof Error ? err.message : 'Network error fetching synthetic cases'
            );
        } finally {
            setIsLoadingCases(false);
        }
    }, [initialCaseId, initialTransactionId]);

    useEffect(() => {
        if (isOpen) {
            loadSyntheticCases();
        }
    }, [isOpen, loadSyntheticCases]);

    // Current selected case object
    const currentCase = cases.find((c) => c.id === selectedCaseId) || cases[0];

    // Synchronize default question when scenario changes
    useEffect(() => {
        if (currentCase) {
            setCustomQuestion(currentCase.question || '');
            setInvestigationOutcome(null);
            setInvestigationError(null);
            setProgressEvents([]);
            setTraceData(null);
            setCurrentTraceId(undefined);
            setCurrentStage('IDLE');
        }
    }, [selectedCaseId, currentCase]);

    // Fetch trace data by trace ID
    const fetchTraceData = useCallback(async (traceId: string) => {
        if (!traceId) return;
        setIsLoadingTrace(true);
        setTraceError(null);
        try {
            const res = await fetch(`/api/ai/observability/traces/${traceId}`);
            const data = await res.json();
            if (res.ok && data.success) {
                setTraceData(data);
            } else {
                setTraceError(data.error || data.message || 'Failed to retrieve execution trace');
            }
        } catch (err: unknown) {
            setTraceError(
                err instanceof Error ? err.message : 'Network error retrieving execution trace'
            );
        } finally {
            setIsLoadingTrace(false);
        }
    }, []);

    // Handle investigation run via SSE stream
    const handleRunInvestigation = async () => {
        if (!currentCase) return;

        // Cancel previous request if any
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        setIsInvestigating(true);
        setInvestigationError(null);
        setInvestigationOutcome(null);
        setProgressEvents([]);
        setTraceData(null);
        setCurrentTraceId(undefined);
        setCurrentStage('DLP_SANITIZATION');

        try {
            const res = await fetch('/api/ai/agent-investigate/stream', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    caseId: currentCase.id,
                    question: customQuestion.trim() || currentCase.question,
                    providerType,
                }),
                signal: abortController.signal,
            });

            if (!res.ok && !res.body) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.message || errData.error || `HTTP ${res.status}`);
            }

            if (!res.body) {
                throw new Error('Response body stream not available from gateway');
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // Keep partial line in buffer

                let currentEventType = 'message';
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) continue;

                    if (line.startsWith('event:')) {
                        currentEventType = line.slice(6).trim();
                    } else if (line.startsWith('data:')) {
                        const dataStr = line.slice(5).trim();
                        try {
                            const parsedData = JSON.parse(dataStr);
                            handleStreamEvent(currentEventType, parsedData);
                        } catch (parseErr) {
                            console.warn('[SSE] JSON parse error:', parseErr, dataStr);
                        }
                    }
                }
            }
        } catch (err: unknown) {
            const errObj = err as Error;
            if (errObj?.name === 'AbortError') {
                return;
            }
            setInvestigationError({
                status: 'NETWORK_ERROR',
                message: errObj?.message || 'Failed to stream autonomous investigation events',
            });
            if (showToast) {
                showToast('error', 'Investigation Failed', errObj?.message || 'Stream interrupted');
            }
        } finally {
            setIsInvestigating(false);
            abortControllerRef.current = null;
        }
    };

    // Process SSE event and update UI state
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleStreamEvent = (eventType: string, data: any) => {
        const eventId = `evt-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        const timestamp = data.timestamp || new Date().toISOString();

        if (data.trace_id) {
            setCurrentTraceId(data.trace_id);
        }

        const newEvent: ProgressEventItem = {
            id: eventId,
            type: eventType,
            stage: data.stage,
            round: data.round,
            tool: data.tool,
            is_rag: data.is_rag,
            status: data.status,
            chunks_count: data.chunks_count,
            duration_ms: data.duration_ms,
            valid: data.valid,
            errors_count: data.errors_count,
            timestamp,
            message: data.message,
        };

        setProgressEvents((prev) => [...prev, newEvent]);

        // Stage Transitions
        if (eventType === 'stage.started' && data.stage) {
            setCurrentStage(data.stage);
        }

        // Completion Handling
        if (eventType === 'investigation.completed') {
            setCurrentStage('COMPLETED');
            if (data.report) {
                setInvestigationOutcome({
                    report: data.report,
                    raw_evidence: data.raw_evidence,
                    case_id: data.case_id || currentCase?.id,
                    warnings: data.warnings,
                    latency_ms: data.total_duration_ms || data.latency_ms,
                });
            }
            if (data.trace_id) {
                fetchTraceData(data.trace_id);
            }
            if (showToast) {
                showToast(
                    'success',
                    'Investigation Completed',
                    `Diagnosed ${currentCase?.id} with status ${data.status || 'COMPLETED'}`
                );
            }
        }

        // Failure Handling
        if (eventType === 'investigation.failed') {
            setCurrentStage('FAILED');
            let message = data.message || data.error || 'Investigation failed';
            if (data.error === 'AI_UNAVAILABLE') {
                message =
                    'Local Ollama service is offline. Switch to Mock Provider for instant offline demonstration.';
            }
            setInvestigationError({
                status: data.error || 'ERROR',
                message,
            });
            if (showToast) {
                showToast('error', 'Investigation Alert', message);
            }
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-6 overflow-y-auto">
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/85 backdrop-blur-md transition-opacity"
                onClick={onClose}
            />

            {/* Modal Body */}
            <div className="relative bg-[#0A0D12] border border-gray-800 rounded-2xl w-full max-w-5xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden font-sans z-10 animate-in fade-in zoom-in-95 duration-200">
                {/* ── MODAL HEADER ── */}
                <div className="bg-[#10141D] px-6 py-4 border-b border-gray-800 flex items-center justify-between shrink-0">
                    <div className="space-y-0.5">
                        <div className="flex items-center gap-2.5">
                            <div className="w-7 h-7 rounded-lg bg-blue-600/20 border border-blue-500/40 flex items-center justify-center text-blue-400">
                                <Sparkles className="w-4 h-4" />
                            </div>
                            <h3 className="text-white font-bold text-base tracking-tight flex items-center gap-2">
                                AI Payment Operations Copilot
                            </h3>
                            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-extrabold uppercase tracking-widest bg-amber-500/10 text-amber-400 border border-amber-500/30">
                                SYNTHETIC DEMO
                            </span>
                        </div>
                        <p className="text-xs text-gray-400 font-mono pl-9">
                            Autonomous Evidence Gathering &amp; Root Cause Diagnostics · Razorpay AI
                            Builder Portfolio
                        </p>
                    </div>

                    <button
                        type="button"
                        onClick={onClose}
                        className="text-gray-400 hover:text-white p-1.5 rounded-lg hover:bg-gray-800 transition-colors"
                        title="Close Modal"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* ── MANDATORY WATERMARK NOTICE ── */}
                <div className="bg-[#121622] px-6 py-2 border-b border-gray-800/80 text-[11px] font-mono text-gray-400 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-blue-300">
                        <ShieldAlert className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                        <span>
                            <strong>Safety Invariant:</strong> Read-only in-memory execution. Zero
                            queries to live customer data. Zero payment mutation capacity.
                        </span>
                    </div>
                    <span className="text-gray-500 hidden md:inline">
                        15 Deterministic Operational Exceptions
                    </span>
                </div>

                {/* ── NAVIGATION TABS ── */}
                <div className="bg-[#0E131C] px-6 py-2.5 border-b border-gray-800 flex items-center justify-between gap-3 shrink-0 font-mono text-xs">
                    <div className="inline-flex rounded-lg border border-gray-800 bg-black/40 p-0.5">
                        <button
                            type="button"
                            onClick={() => setActiveTab('investigate')}
                            className={`px-3 py-1.5 rounded flex items-center gap-1.5 transition-colors ${
                                activeTab === 'investigate'
                                    ? 'bg-blue-600 text-white font-bold shadow'
                                    : 'text-gray-400 hover:text-gray-200'
                            }`}
                        >
                            <Terminal className="w-3.5 h-3.5" />
                            <span>Investigation &amp; Report</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => setActiveTab('trace')}
                            className={`px-3 py-1.5 rounded flex items-center gap-1.5 transition-colors ${
                                activeTab === 'trace'
                                    ? 'bg-blue-600 text-white font-bold shadow'
                                    : 'text-gray-400 hover:text-gray-200'
                            }`}
                        >
                            <Layers className="w-3.5 h-3.5" />
                            <span>Execution Trace</span>
                            {traceData && (
                                <span className="w-2 h-2 rounded-full bg-emerald-400 ml-0.5" />
                            )}
                        </button>
                        <button
                            type="button"
                            onClick={() => setActiveTab('metrics')}
                            className={`px-3 py-1.5 rounded flex items-center gap-1.5 transition-colors ${
                                activeTab === 'metrics'
                                    ? 'bg-blue-600 text-white font-bold shadow'
                                    : 'text-gray-400 hover:text-gray-200'
                            }`}
                        >
                            <BarChart3 className="w-3.5 h-3.5" />
                            <span>System Telemetry</span>
                        </button>
                    </div>

                    {/* Active Trace Pill */}
                    {currentTraceId && (
                        <div className="hidden sm:flex items-center gap-1.5 text-[11px] text-gray-400">
                            <span>Active Trace:</span>
                            <span className="text-blue-400 font-bold">
                                {currentTraceId.substring(0, 8)}...
                            </span>
                        </div>
                    )}
                </div>

                {/* ── MODAL SCROLLABLE CONTENT ── */}
                <div className="p-6 space-y-6 overflow-y-auto flex-1">
                    {/* TAB 1: INVESTIGATION & REPORT */}
                    {activeTab === 'investigate' && (
                        <>
                            {/* Customer Data Privacy Guard Notice */}
                            {isCustomerTxNotice && (
                                <div className="p-4 bg-blue-950/40 border border-blue-700/60 rounded-xl flex items-start gap-3 text-xs text-blue-200">
                                    <ShieldAlert className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
                                    <div className="space-y-1">
                                        <span className="font-bold text-white uppercase tracking-wider font-mono text-[11px] block">
                                            Customer Data Privacy Guard Active
                                        </span>
                                        <p className="text-gray-300 leading-relaxed">
                                            Live customer payment records are strictly excluded from
                                            AI telemetry and are never transmitted to external or
                                            local model runtimes. The scenario selector below allows
                                            you to evaluate identical operational diagnostics using
                                            15 verified synthetic scenarios.
                                        </p>
                                    </div>
                                </div>
                            )}

                            {/* SCENARIO SELECTION & CONFIGURATION PANEL */}
                            <div className="bg-[#0E131C] border border-gray-800 rounded-xl p-5 space-y-4">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <label className="text-xs font-mono font-bold uppercase tracking-wider text-gray-300 flex items-center gap-1.5">
                                        <Terminal className="w-3.5 h-3.5 text-blue-400" />
                                        Select Payment Exception Scenario:
                                    </label>

                                    {/* Provider Mode Selector */}
                                    <div className="flex items-center gap-2 text-xs font-mono">
                                        <span className="text-gray-400 text-[11px]">Provider:</span>
                                        <div className="inline-flex rounded-lg border border-gray-800 bg-black/40 p-0.5">
                                            <button
                                                type="button"
                                                onClick={() => setProviderType('mock')}
                                                className={`px-2.5 py-1 rounded text-xs transition-colors ${
                                                    providerType === 'mock'
                                                        ? 'bg-blue-600 text-white font-bold'
                                                        : 'text-gray-400 hover:text-gray-200'
                                                }`}
                                                title="Offline deterministic responses from mock provider"
                                            >
                                                Mock (Offline)
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setProviderType('ollama')}
                                                className={`px-2.5 py-1 rounded text-xs transition-colors ${
                                                    providerType === 'ollama'
                                                        ? 'bg-purple-600 text-white font-bold'
                                                        : 'text-gray-400 hover:text-gray-200'
                                                }`}
                                                title="Local Ollama LLM loopback (127.0.0.1:11434)"
                                            >
                                                Local Ollama
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {/* Scenario Dropdown */}
                                {isLoadingCases ? (
                                    <div className="py-4 text-center text-xs font-mono text-gray-500 flex items-center justify-center gap-2">
                                        <RefreshCw className="w-4 h-4 animate-spin text-blue-400" />
                                        Loading registered synthetic scenarios...
                                    </div>
                                ) : casesError ? (
                                    <div className="p-3 bg-red-950/30 border border-red-800/50 rounded-lg text-xs text-red-300 flex items-center justify-between">
                                        <span>{casesError}</span>
                                        <button
                                            type="button"
                                            onClick={loadSyntheticCases}
                                            className="px-2 py-1 bg-red-900/40 rounded text-[11px] font-mono hover:bg-red-800"
                                        >
                                            Retry
                                        </button>
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        <select
                                            value={selectedCaseId}
                                            onChange={(e) => setSelectedCaseId(e.target.value)}
                                            className="w-full bg-[#141A24] border border-gray-700/80 rounded-lg px-3.5 py-2.5 text-sm text-gray-100 font-mono focus:border-blue-500 focus:outline-none"
                                        >
                                            {cases.map((c) => (
                                                <option key={c.id} value={c.id}>
                                                    {c.id} — {c.title} [{c.intent}]
                                                </option>
                                            ))}
                                        </select>

                                        {/* Selected Scenario Metadata Preview */}
                                        {currentCase && (
                                            <div className="bg-black/30 border border-gray-800/80 rounded-lg p-3 text-xs font-mono space-y-2">
                                                <div className="flex flex-wrap items-center justify-between gap-2">
                                                    <div>
                                                        <span className="text-gray-500">
                                                            Target UUID:{' '}
                                                        </span>
                                                        <span className="text-blue-400 font-semibold">
                                                            {currentCase.transactionId}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-gray-500">
                                                            Expected:{' '}
                                                        </span>
                                                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-950 text-emerald-300 border border-emerald-800">
                                                            {currentCase.expectedStatus}
                                                        </span>
                                                    </div>
                                                </div>
                                                <div>
                                                    <span className="text-gray-500">
                                                        Expected Grounded Finding:{' '}
                                                    </span>
                                                    <span className="text-gray-300 italic">
                                                        {currentCase.groundedFinding}
                                                    </span>
                                                </div>
                                                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                                                    <span className="text-gray-500 text-[11px]">
                                                        Authorized Evidence Tools:{' '}
                                                    </span>
                                                    {currentCase.toolsAvailable &&
                                                        currentCase.toolsAvailable.map(
                                                            (tool, idx) => (
                                                                <span
                                                                    key={idx}
                                                                    className="px-1.5 py-0.2 rounded text-[10px] bg-gray-900 text-gray-400 border border-gray-800"
                                                                >
                                                                    {tool}
                                                                </span>
                                                            )
                                                        )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Operator Question Prompt */}
                                <div className="space-y-1.5">
                                    <label className="text-xs font-mono text-gray-400 flex items-center justify-between">
                                        <span>Operator Investigation Query:</span>
                                        <span className="text-[10px] text-gray-500">
                                            Max 500 chars (Strict Sanitization)
                                        </span>
                                    </label>
                                    <textarea
                                        value={customQuestion}
                                        onChange={(e) => setCustomQuestion(e.target.value)}
                                        rows={2}
                                        maxLength={500}
                                        placeholder="Enter operational question or accept scenario default..."
                                        className="w-full bg-[#141A24] border border-gray-700/80 rounded-lg px-3.5 py-2 text-xs text-gray-100 font-sans focus:border-blue-500 focus:outline-none resize-none"
                                    />
                                </div>

                                {/* Execute Action Bar */}
                                <div className="flex items-center justify-between pt-1">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (currentCase)
                                                setCustomQuestion(currentCase.question);
                                            setInvestigationOutcome(null);
                                            setInvestigationError(null);
                                            setProgressEvents([]);
                                        }}
                                        className="text-xs font-mono text-gray-500 hover:text-gray-300 transition-colors"
                                    >
                                        Reset to Default
                                    </button>

                                    <button
                                        type="button"
                                        onClick={handleRunInvestigation}
                                        disabled={isInvestigating || !currentCase}
                                        className={`px-5 py-2 rounded-lg text-xs font-mono font-bold flex items-center gap-2 transition-all ${
                                            isInvestigating
                                                ? 'bg-blue-800 text-blue-200 cursor-wait'
                                                : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg hover:shadow-blue-500/25 active:scale-98'
                                        }`}
                                    >
                                        {isInvestigating ? (
                                            <>
                                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                                <span>Investigating (Live Stream)...</span>
                                            </>
                                        ) : (
                                            <>
                                                <Play className="w-3.5 h-3.5 fill-current" />
                                                <span>Run Autonomous Investigation</span>
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>

                            {/* ── LIVE PROGRESS TIMELINE (SSE STREAM) ── */}
                            {(isInvestigating || progressEvents.length > 0) && (
                                <InvestigationProgressTimeline
                                    events={progressEvents}
                                    currentStage={currentStage}
                                    isRunning={isInvestigating}
                                    traceId={currentTraceId}
                                />
                            )}

                            {/* ── ERROR DISPLAY ── */}
                            {investigationError && !isInvestigating && (
                                <div className="p-5 bg-red-950/30 border border-red-800/60 rounded-xl space-y-3">
                                    <div className="flex items-start gap-3">
                                        <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                                        <div className="space-y-1">
                                            <h4 className="text-xs font-mono font-bold text-red-400 uppercase tracking-wider">
                                                Investigation Alert [{investigationError.status}]
                                            </h4>
                                            <p className="text-xs text-gray-200 leading-relaxed">
                                                {investigationError.message}
                                            </p>
                                        </div>
                                    </div>

                                    {investigationError.status === 'AI_UNAVAILABLE' && (
                                        <div className="pt-2 pl-8 flex items-center gap-3">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setProviderType('mock');
                                                    setTimeout(handleRunInvestigation, 50);
                                                }}
                                                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs font-mono font-bold text-white transition-colors"
                                            >
                                                Switch to Mock Provider &amp; Retry
                                            </button>
                                            <span className="text-[11px] text-gray-400 font-mono">
                                                Runs 100% offline without local daemon
                                            </span>
                                        </div>
                                    )}

                                    {investigationError.status !== 'AI_UNAVAILABLE' && (
                                        <div className="pt-2 pl-8">
                                            <button
                                                type="button"
                                                onClick={handleRunInvestigation}
                                                className="px-3 py-1.5 bg-red-900/40 hover:bg-red-800/60 rounded text-xs font-mono font-bold text-red-200 transition-colors"
                                            >
                                                Retry Investigation
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* ── INVESTIGATION RESULT CARD ── */}
                            {investigationOutcome &&
                                investigationOutcome.report &&
                                !isInvestigating && (
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between">
                                            <h4 className="text-xs font-mono font-bold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                                                Investigation Findings &amp; Root Cause Analysis
                                            </h4>
                                            <div className="flex items-center gap-3">
                                                {currentTraceId && (
                                                    <button
                                                        type="button"
                                                        onClick={() => setActiveTab('trace')}
                                                        className="text-xs font-mono text-blue-400 hover:text-blue-300 underline flex items-center gap-1"
                                                    >
                                                        <span>View Trace Waterfall</span>
                                                        <ArrowRight className="w-3 h-3" />
                                                    </button>
                                                )}
                                                <span className="text-[11px] font-mono text-gray-500">
                                                    Latency: {investigationOutcome.latency_ms || 15}
                                                    ms
                                                </span>
                                            </div>
                                        </div>

                                        <CopilotInvestigationCard
                                            report={investigationOutcome.report}
                                            rawEvidence={investigationOutcome.raw_evidence}
                                            caseId={investigationOutcome.case_id}
                                            latencyMs={investigationOutcome.latency_ms}
                                            warnings={investigationOutcome.warnings}
                                        />
                                    </div>
                                )}

                            {/* ── EMPTY STATE GUIDANCE ── */}
                            {!investigationOutcome &&
                                !isInvestigating &&
                                !investigationError &&
                                progressEvents.length === 0 && (
                                    <div className="p-8 bg-[#0D1117] border border-gray-800/60 rounded-xl text-center space-y-4">
                                        <div className="w-12 h-12 rounded-2xl bg-blue-950/40 border border-blue-800/60 flex items-center justify-center text-blue-400 mx-auto">
                                            <Sparkles className="w-6 h-6" />
                                        </div>
                                        <div className="space-y-1.5 max-w-lg mx-auto">
                                            <h4 className="text-sm font-bold text-white">
                                                Select an Operational Exception to Begin Diagnostics
                                            </h4>
                                            <p className="text-xs text-gray-400 leading-relaxed font-sans">
                                                The Copilot deterministically evaluates 15 synthetic
                                                failure modes—including provider gateway drops,
                                                ledger arithmetic mismatches, broken hash chains,
                                                and ISO 20022 schema syntax errors—without querying
                                                persistent database records.
                                            </p>
                                        </div>
                                        <div className="flex flex-wrap justify-center gap-2 pt-2">
                                            {[
                                                'CASE-01 (Provider)',
                                                'CASE-06 (Ledger Audit)',
                                                'CASE-09 (Reconciliation)',
                                                'CASE-10 (ISO 20022)',
                                                'CASE-13 (Adversarial)',
                                            ].map((tag, idx) => (
                                                <span
                                                    key={idx}
                                                    className="px-2.5 py-1 rounded text-[11px] font-mono bg-black/40 text-gray-400 border border-gray-800"
                                                >
                                                    {tag}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                        </>
                    )}

                    {/* TAB 2: EXECUTION TRACE WATERFALL */}
                    {activeTab === 'trace' && (
                        <div className="space-y-4">
                            <TraceVisualizer
                                trace={traceData}
                                isLoading={isLoadingTrace}
                                error={traceError}
                            />
                        </div>
                    )}

                    {/* TAB 3: SYSTEM METRICS DASHBOARD */}
                    {activeTab === 'metrics' && (
                        <div className="space-y-4">
                            <AIMetricsPanel />
                        </div>
                    )}
                </div>

                {/* ── MODAL FOOTER ── */}
                <div className="bg-[#10141D] px-6 py-3 border-t border-gray-800 flex items-center justify-between shrink-0 text-xs font-mono text-gray-500">
                    <div>
                        Candidate Portfolio Project:{' '}
                        <span className="text-gray-300">Razorpay AI Builder</span>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-1.5 rounded-lg border border-gray-800 hover:border-gray-700 text-gray-300 hover:text-white transition-colors"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
