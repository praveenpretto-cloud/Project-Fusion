'use client';

import React, { useState } from 'react';
import {
    ShieldAlert,
    CheckCircle2,
    AlertTriangle,
    Database,
    Cpu,
    ChevronRight,
    Info,
    Eye,
    HelpCircle,
} from 'lucide-react';
import EvidenceCitationBadge from './EvidenceCitationBadge';

export interface ConfirmedFinding {
    claim: string;
    evidence_references: string[];
    source_field: string;
}

export interface Hypothesis {
    hypothesis: string;
    supporting_evidence: string[];
    missing_evidence: string[];
}

export interface RecommendedCheckDisplay {
    code: string;
    description: string;
}

export interface InvestigationReport {
    investigation_id: string;
    transaction_id: string;
    intent: string;
    status: string;
    summary: string;
    confirmed_findings: ConfirmedFinding[];
    hypotheses?: Hypothesis[];
    missing_information?: string[];
    recommended_checks?: string[];
    recommended_checks_display?: RecommendedCheckDisplay[];
    evidence_references?: string[];
    limitations?: string[];
    model_metadata?: {
        provider: string;
        model: string;
        latency_ms?: number;
        tokens?: {
            prompt?: number;
            completion?: number;
        };
    };
}

export interface CopilotInvestigationCardProps {
    report: InvestigationReport;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rawEvidence?: Record<string, any>;
    caseId?: string;
    latencyMs?: number;
    warnings?: string[];
}

export default function CopilotInvestigationCard({
    report,
    rawEvidence = {},
    caseId,
    latencyMs,
    warnings = [],
}: CopilotInvestigationCardProps) {
    const [selectedToolKey, setSelectedToolKey] = useState<string | null>(() => {
        const keys = Object.keys(rawEvidence);
        return keys.length > 0 ? keys[0] : null;
    });
    const [showRawJson, setShowRawJson] = useState(false);
    const [activeSection, setActiveSection] = useState<
        'findings' | 'hypotheses' | 'checks' | 'evidence'
    >('findings');

    const handleCitationClick = (citation: string) => {
        // Find matching tool in rawEvidence
        const rawKeys = Object.keys(rawEvidence);
        const matched = rawKeys.find(
            (k) =>
                citation.toLowerCase().includes(k.toLowerCase()) ||
                k.toLowerCase().includes(citation.toLowerCase())
        );
        if (matched) {
            setSelectedToolKey(matched);
            setActiveSection('evidence');
        }
    };

    const getIntentBadgeClass = (intent: string) => {
        switch (intent) {
            case 'FAILURE_INVESTIGATION':
                return 'bg-amber-950/50 text-amber-300 border-amber-800/80';
            case 'LEDGER_AUDIT':
                return 'bg-emerald-950/50 text-emerald-300 border-emerald-800/80';
            case 'SAGA_INVESTIGATION':
                return 'bg-indigo-950/50 text-indigo-300 border-indigo-800/80';
            case 'WEBHOOK_INVESTIGATION':
                return 'bg-purple-950/50 text-purple-300 border-purple-800/80';
            case 'RECONCILIATION_INVESTIGATION':
                return 'bg-blue-950/50 text-blue-300 border-blue-800/80';
            case 'ISO_VALIDATION':
                return 'bg-rose-950/50 text-rose-300 border-rose-800/80';
            default:
                return 'bg-gray-900 text-gray-300 border-gray-700';
        }
    };

    const evidenceToolList = Object.keys(rawEvidence);

    return (
        <div className="bg-[#0D1117] border border-gray-800 rounded-2xl overflow-hidden shadow-2xl font-sans text-gray-200">
            {/* ── PORTFOLIO WATERMARK & DEMONSTRATION MANDATE ── */}
            <div className="bg-linear-to-r from-blue-950/60 via-indigo-950/40 to-purple-950/60 px-5 py-2.5 border-b border-blue-900/40 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono font-extrabold uppercase tracking-widest bg-blue-500/20 text-blue-400 border border-blue-500/30">
                        SYNTHETIC DATA — PORTFOLIO DEMONSTRATION
                    </span>
                    <span className="text-xs text-gray-400 hidden sm:inline">•</span>
                    <span className="text-xs text-gray-400 font-mono">
                        Razorpay AI Builder Candidate Evaluation
                    </span>
                </div>
                <div className="text-[11px] font-mono text-gray-400 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                    <span>Read-Only Decision Support</span>
                </div>
            </div>

            {/* ── CARD HEADER ── */}
            <div className="p-6 border-b border-gray-800/80 bg-[#12161E]/50">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-mono font-bold text-white tracking-tight">
                                {report.investigation_id || 'INV-INTEL-REPORT'}
                            </span>
                            {caseId && (
                                <span className="px-2 py-0.5 rounded text-xs font-mono font-bold bg-blue-950 text-blue-300 border border-blue-800">
                                    {caseId}
                                </span>
                            )}
                            <span
                                className={`px-2.5 py-0.5 rounded text-xs font-mono font-semibold border ${getIntentBadgeClass(report.intent)}`}
                            >
                                {report.intent}
                            </span>
                            <span className="px-2 py-0.5 rounded text-xs font-mono font-semibold bg-emerald-950/60 text-emerald-300 border border-emerald-800/80 flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                                {report.status || 'COMPLETED'}
                            </span>
                        </div>
                        <p className="text-xs text-gray-400 font-mono">
                            Target Instruction:{' '}
                            <span className="text-blue-400 font-bold">{report.transaction_id}</span>
                        </p>
                    </div>

                    {/* Model Telemetry */}
                    <div className="flex items-center gap-3 text-right">
                        <div className="text-[11px] font-mono text-gray-400 bg-black/40 px-3 py-1.5 rounded-lg border border-gray-800 space-y-0.5">
                            <div className="flex items-center justify-end gap-1 text-gray-300">
                                <Cpu className="w-3.5 h-3.5 text-purple-400" />
                                <span className="font-semibold">
                                    {report.model_metadata?.provider || 'local-ai'}
                                </span>
                                <span className="text-gray-500">/</span>
                                <span className="text-blue-300">
                                    {report.model_metadata?.model || 'llama3.1:latest'}
                                </span>
                            </div>
                            <div className="text-[10px] text-gray-500">
                                Latency:{' '}
                                <span className="text-gray-300 font-bold">
                                    {report.model_metadata?.latency_ms || latencyMs || 15}ms
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Warnings banner if any */}
                {warnings.length > 0 && (
                    <div className="mt-4 p-3 bg-amber-950/30 border border-amber-800/50 rounded-xl flex items-start gap-2.5 text-xs text-amber-300">
                        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                        <div>
                            <span className="font-bold">Investigation Diagnostic Notes: </span>
                            <span>{warnings.join(' • ')}</span>
                        </div>
                    </div>
                )}
            </div>

            {/* ── EXECUTIVE SUMMARY ── */}
            <div className="p-6 border-b border-gray-800/60 bg-[#0F141C]">
                <div className="flex items-center gap-2 mb-2">
                    <Info className="w-4 h-4 text-blue-400" />
                    <h4 className="text-xs uppercase tracking-wider font-bold text-gray-400 font-mono">
                        Executive Investigation Summary
                    </h4>
                </div>
                <div className="text-sm leading-relaxed text-gray-100 bg-black/30 p-4 rounded-xl border border-gray-800/80 font-normal">
                    {report.summary}
                </div>
            </div>

            {/* ── SECTION NAV TABS ── */}
            <div className="flex items-center border-b border-gray-800 bg-[#111620] px-6 gap-2 overflow-x-auto text-xs font-mono">
                <button
                    type="button"
                    onClick={() => setActiveSection('findings')}
                    className={`px-3 py-3 font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
                        activeSection === 'findings'
                            ? 'border-blue-500 text-blue-400 bg-blue-950/20'
                            : 'border-transparent text-gray-400 hover:text-gray-200'
                    }`}
                >
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Confirmed Findings ({report.confirmed_findings?.length || 0})</span>
                </button>

                <button
                    type="button"
                    onClick={() => setActiveSection('hypotheses')}
                    className={`px-3 py-3 font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
                        activeSection === 'hypotheses'
                            ? 'border-blue-500 text-blue-400 bg-blue-950/20'
                            : 'border-transparent text-gray-400 hover:text-gray-200'
                    }`}
                >
                    <HelpCircle className="w-3.5 h-3.5 text-amber-400" />
                    <span>Hypotheses &amp; Unknowns</span>
                </button>

                <button
                    type="button"
                    onClick={() => setActiveSection('checks')}
                    className={`px-3 py-3 font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
                        activeSection === 'checks'
                            ? 'border-blue-500 text-blue-400 bg-blue-950/20'
                            : 'border-transparent text-gray-400 hover:text-gray-200'
                    }`}
                >
                    <ShieldAlert className="w-3.5 h-3.5 text-blue-400" />
                    <span>
                        Four-Eyes Review Checks (
                        {report.recommended_checks_display?.length ||
                            report.recommended_checks?.length ||
                            0}
                        )
                    </span>
                </button>

                <button
                    type="button"
                    onClick={() => setActiveSection('evidence')}
                    className={`px-3 py-3 font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
                        activeSection === 'evidence'
                            ? 'border-blue-500 text-blue-400 bg-blue-950/20'
                            : 'border-transparent text-gray-400 hover:text-gray-200'
                    }`}
                >
                    <Database className="w-3.5 h-3.5 text-purple-400" />
                    <span>Forensic Evidence ({evidenceToolList.length})</span>
                </button>
            </div>

            {/* ── SECTION CONTENT ── */}
            <div className="p-6">
                {/* 1. CONFIRMED FINDINGS */}
                {activeSection === 'findings' && (
                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <h4 className="text-xs font-mono font-bold text-gray-400 uppercase tracking-wider">
                                Grounded Diagnostic Findings (Strict Citation Enforced)
                            </h4>
                            <span className="text-[11px] text-gray-500 font-mono">
                                Click citations to inspect underlying telemetry
                            </span>
                        </div>

                        {report.confirmed_findings && report.confirmed_findings.length > 0 ? (
                            <div className="space-y-3">
                                {report.confirmed_findings.map((finding, idx) => (
                                    <div
                                        key={idx}
                                        className="bg-[#121620] border border-gray-800/80 rounded-xl p-4 space-y-3 transition-colors hover:border-gray-700"
                                    >
                                        <div className="flex items-start gap-3">
                                            <span className="w-5 h-5 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800 flex items-center justify-center font-mono text-[11px] shrink-0 font-bold">
                                                {idx + 1}
                                            </span>
                                            <p className="text-sm font-medium text-gray-100 leading-snug">
                                                {finding.claim}
                                            </p>
                                        </div>

                                        <div className="pl-8 flex flex-wrap items-center gap-2 pt-1 border-t border-gray-800/40">
                                            <span className="text-[11px] text-gray-400 font-mono">
                                                Grounded by:
                                            </span>
                                            {finding.evidence_references &&
                                                finding.evidence_references.map((ref, rIdx) => (
                                                    <EvidenceCitationBadge
                                                        key={rIdx}
                                                        citation={ref}
                                                        sourceField={finding.source_field}
                                                        onClick={handleCitationClick}
                                                    />
                                                ))}
                                            {finding.source_field && (
                                                <span className="text-[10px] font-mono text-gray-400 px-2 py-0.5 bg-black/40 rounded border border-gray-800">
                                                    field: {finding.source_field}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="p-8 text-center text-gray-500 font-mono text-xs bg-black/20 rounded-xl border border-gray-800">
                                No confirmed findings recorded.
                            </div>
                        )}
                    </div>
                )}

                {/* 2. HYPOTHESES & UNKNOWNS */}
                {activeSection === 'hypotheses' && (
                    <div className="space-y-6">
                        <div>
                            <h4 className="text-xs font-mono font-bold text-gray-400 uppercase tracking-wider mb-3">
                                Operational Hypotheses (Tentatively Framed)
                            </h4>

                            {report.hypotheses && report.hypotheses.length > 0 ? (
                                <div className="space-y-3">
                                    {report.hypotheses.map((hypo, idx) => (
                                        <div
                                            key={idx}
                                            className="bg-[#121620] border border-amber-900/40 rounded-xl p-4 space-y-3"
                                        >
                                            <div className="flex items-start gap-2.5">
                                                <HelpCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                                                <p className="text-sm text-gray-200 font-medium">
                                                    {hypo.hypothesis}
                                                </p>
                                            </div>

                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pl-6 pt-2 border-t border-gray-800/40 text-xs font-mono">
                                                <div className="space-y-1">
                                                    <span className="text-emerald-400 text-[10px] uppercase font-bold tracking-wider">
                                                        Supporting Evidence:
                                                    </span>
                                                    {hypo.supporting_evidence &&
                                                    hypo.supporting_evidence.length > 0 ? (
                                                        <ul className="list-disc list-inside text-gray-300 space-y-0.5 text-[11px]">
                                                            {hypo.supporting_evidence.map(
                                                                (s, sIdx) => (
                                                                    <li key={sIdx}>{s}</li>
                                                                )
                                                            )}
                                                        </ul>
                                                    ) : (
                                                        <span className="text-gray-500 text-[11px] italic block">
                                                            None noted
                                                        </span>
                                                    )}
                                                </div>

                                                <div className="space-y-1">
                                                    <span className="text-amber-400 text-[10px] uppercase font-bold tracking-wider">
                                                        Missing Verification Evidence:
                                                    </span>
                                                    {hypo.missing_evidence &&
                                                    hypo.missing_evidence.length > 0 ? (
                                                        <ul className="list-disc list-inside text-gray-300 space-y-0.5 text-[11px]">
                                                            {hypo.missing_evidence.map(
                                                                (m, mIdx) => (
                                                                    <li key={mIdx}>{m}</li>
                                                                )
                                                            )}
                                                        </ul>
                                                    ) : (
                                                        <span className="text-gray-500 text-[11px] italic block">
                                                            None required
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="p-6 text-center text-gray-500 font-mono text-xs bg-black/20 rounded-xl border border-gray-800">
                                    No unresolved hypotheses generated for this scenario.
                                </div>
                            )}
                        </div>

                        {/* Missing Information Callout */}
                        {report.missing_information && report.missing_information.length > 0 && (
                            <div className="p-4 bg-gray-900/40 border border-gray-800 rounded-xl space-y-2">
                                <span className="text-xs font-mono font-bold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                                    <Info className="w-3.5 h-3.5 text-blue-400" />
                                    Missing Telemetry or Unrecorded Pipeline Data
                                </span>
                                <ul className="list-disc list-inside text-xs text-gray-300 space-y-1 font-mono">
                                    {report.missing_information.map((info, idx) => (
                                        <li key={idx}>{info}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                )}

                {/* 3. FOUR-EYES REVIEW CHECKS */}
                {activeSection === 'checks' && (
                    <div className="space-y-4">
                        <div className="p-3 bg-blue-950/30 border border-blue-800/40 rounded-xl text-xs text-blue-300 flex items-start gap-2.5">
                            <ShieldAlert className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                            <div>
                                <span className="font-bold">
                                    Institutional Dual-Control Governance:{' '}
                                </span>
                                <span>
                                    All recommended operational checks are advisory guidance for
                                    human operators. The AI engine possesses zero execution
                                    authority and cannot trigger disbursements, reversals, or ledger
                                    mutations.
                                </span>
                            </div>
                        </div>

                        <div className="space-y-3">
                            {report.recommended_checks_display &&
                            report.recommended_checks_display.length > 0 ? (
                                report.recommended_checks_display.map((check, idx) => (
                                    <div
                                        key={idx}
                                        className="bg-[#121620] border border-gray-800 rounded-xl p-4 flex items-start justify-between gap-4"
                                    >
                                        <div className="space-y-1">
                                            <div className="flex items-center gap-2">
                                                <span className="font-mono text-xs font-bold text-blue-300 px-2 py-0.5 bg-blue-950/70 rounded border border-blue-800/60">
                                                    {check.code}
                                                </span>
                                                <span className="text-[10px] font-mono text-emerald-400 uppercase font-bold tracking-wider">
                                                    Manual Check Required
                                                </span>
                                            </div>
                                            <p className="text-xs text-gray-300 leading-relaxed pt-1">
                                                {check.description}
                                            </p>
                                        </div>

                                        <div className="shrink-0">
                                            <span className="text-[10px] font-mono font-semibold px-2.5 py-1 rounded bg-black/40 text-gray-400 border border-gray-800">
                                                Human Operator Action
                                            </span>
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <div className="p-6 text-center text-gray-500 font-mono text-xs bg-black/20 rounded-xl border border-gray-800">
                                    No manual checks required for this scenario.
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* 4. FORENSIC EVIDENCE DETAIL INSPECTOR */}
                {activeSection === 'evidence' && (
                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <h4 className="text-xs font-mono font-bold text-gray-400 uppercase tracking-wider">
                                Retrieved Fixture Evidence Telemetry
                            </h4>
                            <button
                                type="button"
                                onClick={() => setShowRawJson(!showRawJson)}
                                className="text-xs font-mono text-blue-400 hover:text-blue-300 flex items-center gap-1"
                            >
                                <Eye className="w-3.5 h-3.5" />
                                {showRawJson ? 'View Structured Card' : 'View Raw JSON'}
                            </button>
                        </div>

                        {evidenceToolList.length > 0 ? (
                            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                                {/* Tool Selector Sidebar */}
                                <div className="space-y-1">
                                    {evidenceToolList.map((toolName) => (
                                        <button
                                            key={toolName}
                                            type="button"
                                            onClick={() => setSelectedToolKey(toolName)}
                                            className={`w-full text-left px-3 py-2.5 rounded-lg text-xs font-mono transition-all flex items-center justify-between ${
                                                selectedToolKey === toolName
                                                    ? 'bg-blue-600 text-white font-bold shadow-md'
                                                    : 'bg-[#121620] text-gray-400 hover:text-gray-200 hover:bg-[#161c28]'
                                            }`}
                                        >
                                            <span className="truncate">{toolName}</span>
                                            {selectedToolKey === toolName ? (
                                                <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                                            ) : null}
                                        </button>
                                    ))}
                                </div>

                                {/* Tool Data Display */}
                                <div className="md:col-span-3 bg-[#0a0d14] border border-gray-800 rounded-xl p-4 overflow-x-auto min-h-55">
                                    {selectedToolKey && rawEvidence[selectedToolKey] ? (
                                        showRawJson ? (
                                            <pre className="text-[11px] font-mono text-gray-300 leading-relaxed whitespace-pre-wrap">
                                                {JSON.stringify(
                                                    rawEvidence[selectedToolKey],
                                                    null,
                                                    2
                                                )}
                                            </pre>
                                        ) : (
                                            <div className="space-y-3 font-mono">
                                                <div className="flex items-center justify-between border-b border-gray-800 pb-2">
                                                    <span className="text-xs font-bold text-blue-400">
                                                        Tool: {selectedToolKey}
                                                    </span>
                                                    <span className="text-[10px] text-gray-500">
                                                        Status:{' '}
                                                        {rawEvidence[selectedToolKey]?.status ||
                                                            'AVAILABLE'}
                                                    </span>
                                                </div>

                                                {/* Specialized Renderers for Known Tools */}
                                                {selectedToolKey === 'getTransactionTimeline' &&
                                                    rawEvidence.getTransactionTimeline.timeline && (
                                                        <div className="space-y-2 text-xs">
                                                            <div className="grid grid-cols-2 gap-2 text-[11px]">
                                                                <div>
                                                                    State:{' '}
                                                                    <span className="text-white font-bold">
                                                                        {
                                                                            rawEvidence
                                                                                .getTransactionTimeline
                                                                                .timeline
                                                                                .current_state
                                                                        }
                                                                    </span>
                                                                </div>
                                                                <div>
                                                                    Amount:{' '}
                                                                    <span className="text-white font-bold">
                                                                        {
                                                                            rawEvidence
                                                                                .getTransactionTimeline
                                                                                .timeline.amount
                                                                        }{' '}
                                                                        {
                                                                            rawEvidence
                                                                                .getTransactionTimeline
                                                                                .timeline.currency
                                                                        }
                                                                    </span>
                                                                </div>
                                                            </div>
                                                            {rawEvidence.getTransactionTimeline
                                                                .timeline.error_message && (
                                                                <div className="p-2 bg-red-950/40 text-red-300 rounded border border-red-900/60 text-[11px]">
                                                                    Error:{' '}
                                                                    {
                                                                        rawEvidence
                                                                            .getTransactionTimeline
                                                                            .timeline.error_message
                                                                    }
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}

                                                {selectedToolKey === 'getProviderFailureDetails' &&
                                                    rawEvidence.getProviderFailureDetails.data && (
                                                        <div className="space-y-2 text-xs">
                                                            <div className="grid grid-cols-2 gap-2 text-[11px]">
                                                                <div>
                                                                    Classification:{' '}
                                                                    <span className="text-amber-400 font-bold">
                                                                        {
                                                                            rawEvidence
                                                                                .getProviderFailureDetails
                                                                                .data
                                                                                .provider_classification
                                                                        }
                                                                    </span>
                                                                </div>
                                                                <div>
                                                                    Provider:{' '}
                                                                    <span className="text-white font-bold">
                                                                        {rawEvidence
                                                                            .getProviderFailureDetails
                                                                            .data
                                                                            .resolved_provider ||
                                                                            'N/A'}
                                                                    </span>
                                                                </div>
                                                            </div>
                                                            <div className="p-2 bg-black/40 text-gray-300 rounded border border-gray-800 text-[11px]">
                                                                Gateway Message:{' '}
                                                                {
                                                                    rawEvidence
                                                                        .getProviderFailureDetails
                                                                        .data.error_message
                                                                }
                                                            </div>
                                                        </div>
                                                    )}

                                                {selectedToolKey === 'verifyLedgerIntegrity' && (
                                                    <div className="space-y-2 text-xs">
                                                        <div className="text-[11px] text-emerald-400">
                                                            Integrity Status:{' '}
                                                            {
                                                                rawEvidence.verifyLedgerIntegrity
                                                                    .status
                                                            }
                                                        </div>
                                                        {rawEvidence.verifyLedgerIntegrity
                                                            .discrepancy && (
                                                            <div className="p-2 bg-amber-950/40 text-amber-300 rounded border border-amber-900/60 text-[11px]">
                                                                Discrepancy:{' '}
                                                                {
                                                                    rawEvidence
                                                                        .verifyLedgerIntegrity
                                                                        .discrepancy
                                                                }
                                                            </div>
                                                        )}
                                                    </div>
                                                )}

                                                {/* Fallback JSON view for other tools */}
                                                {![
                                                    'getTransactionTimeline',
                                                    'getProviderFailureDetails',
                                                    'verifyLedgerIntegrity',
                                                ].includes(selectedToolKey) && (
                                                    <pre className="text-[11px] font-mono text-gray-300 whitespace-pre-wrap">
                                                        {JSON.stringify(
                                                            rawEvidence[selectedToolKey],
                                                            null,
                                                            2
                                                        )}
                                                    </pre>
                                                )}
                                            </div>
                                        )
                                    ) : (
                                        <div className="text-gray-500 font-mono text-xs text-center py-10">
                                            Select an evidence tool to inspect telemetry.
                                        </div>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <div className="p-6 text-center text-gray-500 font-mono text-xs bg-black/20 rounded-xl border border-gray-800">
                                No raw evidence records available for this report.
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* ── CARD FOOTER & GOVERNANCE DISCLAIMERS ── */}
            <div className="px-6 py-4 bg-[#0a0d13] border-t border-gray-800/80 flex flex-wrap items-center justify-between gap-3 text-xs text-gray-500 font-mono">
                <div className="flex items-center gap-2">
                    <ShieldAlert className="w-3.5 h-3.5 text-blue-400" />
                    <span>
                        Four-Eyes Governance: Diagnostic decisions require human authorization.
                    </span>
                </div>
                <div className="text-[11px] text-gray-400">
                    Project Fusion Operations Intelligence v1.0
                </div>
            </div>
        </div>
    );
}
