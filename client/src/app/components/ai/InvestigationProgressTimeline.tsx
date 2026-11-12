'use client';

import React from 'react';
import {
    Activity,
    CheckCircle2,
    Clock,
    Cpu,
    Database,
    FileText,
    HelpCircle,
    Layers,
    ShieldCheck,
    Wrench,
    XCircle,
} from 'lucide-react';

export interface ProgressEventItem {
    id: string;
    type: string;
    stage?: string;
    round?: number;
    tool?: string;
    is_rag?: boolean;
    status?: string;
    chunks_count?: number;
    duration_ms?: number;
    valid?: boolean;
    errors_count?: number;
    confirmed_findings_count?: number;
    timestamp: string;
    message?: string;
}

interface InvestigationProgressTimelineProps {
    events: ProgressEventItem[];
    currentStage: string;
    isRunning: boolean;
    traceId?: string;
}

export default function InvestigationProgressTimeline({
    events,
    currentStage,
    isRunning,
    traceId,
}: InvestigationProgressTimelineProps) {
    // Determine milestone state presence
    const hasDlp = events.some((e) => e.stage === 'DLP_SANITIZATION');
    const dlpDone = events.some(
        (e) => e.type === 'stage.completed' && e.stage === 'DLP_SANITIZATION'
    );

    const hasOrchestration = events.some((e) => e.stage === 'AGENT_ORCHESTRATION');

    const toolEvents = events.filter((e) => e.type === 'tool.completed');
    const ragStarted = events.some((e) => e.type === 'rag.started');
    const ragEvent = events.find((e) => e.type === 'rag.completed');

    const validationEvent = events.find((e) => e.type === 'validation.completed');
    const isCompleted = events.some((e) => e.type === 'investigation.completed');
    const isFailed = events.some((e) => e.type === 'investigation.failed');

    return (
        <div className="bg-[#0B0E14] border border-gray-800 rounded-xl p-4 font-mono text-xs space-y-4">
            <div className="flex items-center justify-between border-b border-gray-800 pb-2.5">
                <div className="flex items-center gap-2">
                    <Activity
                        className={`w-4 h-4 ${isRunning ? 'text-blue-400 animate-spin' : isCompleted ? 'text-emerald-400' : isFailed ? 'text-rose-400' : 'text-gray-400'}`}
                    />
                    <span className="text-gray-200 font-bold uppercase tracking-wider text-[11px]">
                        Live Execution Progress
                    </span>
                    {isRunning && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/30 animate-pulse">
                            ACTIVE
                        </span>
                    )}
                </div>
                {traceId && (
                    <div className="text-[10px] text-gray-500 font-mono">
                        Trace:{' '}
                        <span className="text-gray-400 font-semibold">
                            {traceId.substring(0, 8)}...
                        </span>
                    </div>
                )}
            </div>

            {/* Stage Progression Pills */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {/* 1. DLP Sanitization */}
                <div
                    className={`p-2 rounded-lg border ${dlpDone ? 'bg-emerald-950/20 border-emerald-800/50 text-emerald-300' : hasDlp ? 'bg-blue-950/20 border-blue-800/50 text-blue-300' : 'bg-gray-900/40 border-gray-800/60 text-gray-500'}`}
                >
                    <div className="flex items-center gap-1.5 font-semibold text-[10px] uppercase">
                        <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                        <span>1. DLP Redaction</span>
                    </div>
                    <div className="text-[10px] mt-1 text-gray-400">
                        {dlpDone ? 'Sanitized (Safe)' : hasDlp ? 'Masking in-flight...' : 'Pending'}
                    </div>
                </div>

                {/* 2. Tool Execution */}
                <div
                    className={`p-2 rounded-lg border ${toolEvents.length > 0 ? 'bg-emerald-950/20 border-emerald-800/50 text-emerald-300' : hasOrchestration && isRunning ? 'bg-blue-950/20 border-blue-800/50 text-blue-300' : 'bg-gray-900/40 border-gray-800/60 text-gray-500'}`}
                >
                    <div className="flex items-center gap-1.5 font-semibold text-[10px] uppercase">
                        <Wrench className="w-3.5 h-3.5 shrink-0" />
                        <span>2. Tools Executed</span>
                    </div>
                    <div className="text-[10px] mt-1 text-gray-400">
                        {toolEvents.length > 0
                            ? `${toolEvents.length} call(s) executed`
                            : isRunning
                              ? 'Observing...'
                              : 'Pending'}
                    </div>
                </div>

                {/* 3. Knowledge Retrieval (RAG) */}
                <div
                    className={`p-2 rounded-lg border ${ragEvent ? 'bg-purple-950/20 border-purple-800/50 text-purple-300' : ragStarted ? 'bg-blue-950/20 border-blue-800/50 text-blue-300' : 'bg-gray-900/40 border-gray-800/60 text-gray-500'}`}
                >
                    <div className="flex items-center gap-1.5 font-semibold text-[10px] uppercase">
                        <Database className="w-3.5 h-3.5 shrink-0" />
                        <span>3. RAG Retrieval</span>
                    </div>
                    <div className="text-[10px] mt-1 text-gray-400">
                        {ragEvent
                            ? `${ragEvent.chunks_count || 0} chunk(s) retrieved`
                            : ragStarted
                              ? 'Searching...'
                              : 'Not Invoked'}
                    </div>
                </div>

                {/* 4. Evidence Citation Validation */}
                <div
                    className={`p-2 rounded-lg border ${validationEvent?.valid ? 'bg-emerald-950/20 border-emerald-800/50 text-emerald-300' : validationEvent && !validationEvent.valid ? 'bg-rose-950/20 border-rose-800/50 text-rose-300' : 'bg-gray-900/40 border-gray-800/60 text-gray-500'}`}
                >
                    <div className="flex items-center gap-1.5 font-semibold text-[10px] uppercase">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        <span>4. Citations Valid</span>
                    </div>
                    <div className="text-[10px] mt-1 text-gray-400">
                        {validationEvent
                            ? validationEvent.valid
                                ? 'Verified (100%)'
                                : `${validationEvent.errors_count} error(s)`
                            : 'Pending'}
                    </div>
                </div>
            </div>

            {/* Event Stream Log */}
            <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                {events.length === 0 ? (
                    <div className="text-gray-600 italic py-2 text-center">
                        Waiting for investigation to launch...
                    </div>
                ) : (
                    events.map((evt, idx) => (
                        <div
                            key={evt.id || idx}
                            className="flex items-start gap-2 py-1 border-b border-gray-800/40 last:border-0"
                        >
                            <span className="text-gray-500 text-[10px] shrink-0 mt-0.5">
                                {new Date(evt.timestamp).toLocaleTimeString([], {
                                    hour12: false,
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    second: '2-digit',
                                })}
                            </span>
                            <div className="flex-1">
                                {evt.type === 'investigation.started' && (
                                    <span className="text-blue-400 font-semibold">
                                        ⚡ Investigation started for {evt.stage || 'case'} (Intent:{' '}
                                        {evt.status || 'ANOMALY_DETECTION'})
                                    </span>
                                )}
                                {evt.type === 'stage.started' && (
                                    <span className="text-gray-300">
                                        ▶ Entering stage:{' '}
                                        <strong className="text-blue-300">{evt.stage}</strong>
                                    </span>
                                )}
                                {evt.type === 'stage.completed' && (
                                    <span className="text-emerald-400">
                                        ✓ Completed stage:{' '}
                                        <strong className="text-emerald-300">{evt.stage}</strong>
                                    </span>
                                )}
                                {evt.type === 'model.started' && (
                                    <span className="text-amber-300">
                                        🤖 Model Turn {evt.round}: Inquiring provider
                                    </span>
                                )}
                                {evt.type === 'model.completed' && (
                                    <span className="text-gray-300">
                                        ✓ Model Turn {evt.round} completed in {evt.duration_ms}ms
                                    </span>
                                )}
                                {evt.type === 'tool.started' && (
                                    <span className="text-cyan-300">
                                        🔧 Executing tool: <strong>{evt.tool}</strong>
                                    </span>
                                )}
                                {evt.type === 'tool.completed' && (
                                    <span className="text-emerald-400">
                                        ✓ Tool <strong>{evt.tool}</strong> returned ({evt.status})
                                        in {evt.duration_ms}ms
                                    </span>
                                )}
                                {evt.type === 'rag.started' && (
                                    <span className="text-purple-300">
                                        📚 Executing technical knowledge base search (BM25 + Dense
                                        hybrid)...
                                    </span>
                                )}
                                {evt.type === 'rag.completed' && (
                                    <span className="text-purple-400">
                                        ✓ RAG search returned {evt.chunks_count} authoritative
                                        document chunk(s) in {evt.duration_ms}ms
                                    </span>
                                )}
                                {evt.type === 'validation.completed' && (
                                    <span
                                        className={
                                            evt.valid
                                                ? 'text-emerald-400 font-semibold'
                                                : 'text-rose-400 font-semibold'
                                        }
                                    >
                                        {evt.valid
                                            ? '✓ Citation verification passed: All claims grounded in observed tools'
                                            : `✕ Citation verification rejected: ${evt.errors_count} ungrounded claims`}
                                    </span>
                                )}
                                {evt.type === 'investigation.completed' && (
                                    <span className="text-emerald-300 font-bold">
                                        🎉 Investigation completed: Report generated (
                                        {evt.confirmed_findings_count} verified finding(s)) in{' '}
                                        {evt.duration_ms}ms
                                    </span>
                                )}
                                {evt.type === 'investigation.failed' && (
                                    <span className="text-rose-400 font-bold">
                                        ✕ Investigation halted:{' '}
                                        {evt.status || evt.message || 'Verification failure'}
                                    </span>
                                )}
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
