'use client';

import React, { useState } from 'react';
import {
    Activity,
    Clock,
    Cpu,
    Database,
    Eye,
    Layers,
    ShieldCheck,
    Wrench,
    CheckCircle2,
    ChevronRight,
    ChevronDown,
    Info,
} from 'lucide-react';

export interface SpanData {
    span_id: string;
    trace_id: string;
    name: string;
    parent_span_id?: string | null;
    parent_name?: string | null;
    duration_ms: number;
    status: string;
    attributes: Record<string, unknown>;
}

export interface TraceData {
    success: boolean;
    trace_id: string;
    spans_count: number;
    total_duration_ms: number;
    spans: SpanData[];
}

interface TraceVisualizerProps {
    trace: TraceData | null;
    isLoading?: boolean;
    error?: string | null;
}

export default function TraceVisualizer({ trace, isLoading, error }: TraceVisualizerProps) {
    const [selectedSpan, setSelectedSpan] = useState<SpanData | null>(null);
    const [viewMode, setViewMode] = useState<'waterfall' | 'hierarchy'>('waterfall');

    if (isLoading) {
        return (
            <div className="bg-[#0A0D14] border border-gray-800 rounded-xl p-8 text-center font-mono space-y-3">
                <div className="w-8 h-8 rounded-full border-2 border-blue-500/20 border-t-blue-500 animate-spin mx-auto" />
                <p className="text-xs text-gray-400">Loading OpenTelemetry execution trace...</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="bg-red-950/20 border border-red-800/40 rounded-xl p-4 font-mono text-xs text-red-300">
                <span className="font-bold">Trace Inspection Error:</span> {error}
            </div>
        );
    }

    if (!trace || !trace.spans || trace.spans.length === 0) {
        return (
            <div className="bg-[#0A0D14] border border-gray-800/80 rounded-xl p-8 text-center font-mono space-y-2">
                <Layers className="w-8 h-8 text-gray-600 mx-auto" />
                <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                    No Trace Telemetry Available
                </h4>
                <p className="text-[11px] text-gray-500 max-w-md mx-auto">
                    Execute an investigation to capture distributed tracing spans with latency
                    breakdowns, tool calls, and LLM inference markers.
                </p>
            </div>
        );
    }

    const totalDuration = Math.max(trace.total_duration_ms || 1, 0.01);

    // Compute Model Inference vs Deterministic Tool & Overhead Duration
    const modelSpans = trace.spans.filter((s) => s.name === 'ai.llm.inference');
    const modelDuration = modelSpans.reduce((sum, s) => sum + (s.duration_ms || 0), 0);
    const modelPercentage = Math.min(100, Math.round((modelDuration / totalDuration) * 100));

    const getSpanCategoryStyle = (name: string) => {
        if (name.includes('llm') || name.includes('inference')) {
            return {
                bg: 'bg-amber-500/15',
                border: 'border-amber-500/40',
                text: 'text-amber-300',
                bar: 'bg-amber-500',
                badge: 'LLM Inference',
                icon: Cpu,
            };
        }
        if (name.includes('rag') || name.includes('embedding') || name.includes('search')) {
            return {
                bg: 'bg-purple-500/15',
                border: 'border-purple-500/40',
                text: 'text-purple-300',
                bar: 'bg-purple-500',
                badge: 'RAG Knowledge',
                icon: Database,
            };
        }
        if (name.includes('tool')) {
            return {
                bg: 'bg-cyan-500/15',
                border: 'border-cyan-500/40',
                text: 'text-cyan-300',
                bar: 'bg-cyan-500',
                badge: 'Tool Call',
                icon: Wrench,
            };
        }
        if (name.includes('validation')) {
            return {
                bg: 'bg-emerald-500/15',
                border: 'border-emerald-500/40',
                text: 'text-emerald-300',
                bar: 'bg-emerald-500',
                badge: 'Validation',
                icon: CheckCircle2,
            };
        }
        if (name.includes('dlp')) {
            return {
                bg: 'bg-blue-500/15',
                border: 'border-blue-500/40',
                text: 'text-blue-300',
                bar: 'bg-blue-500',
                badge: 'DLP Redact',
                icon: ShieldCheck,
            };
        }
        return {
            bg: 'bg-blue-600/15',
            border: 'border-blue-600/40',
            text: 'text-blue-300',
            bar: 'bg-blue-600',
            badge: 'Orchestration',
            icon: Layers,
        };
    };

    return (
        <div className="bg-[#0B0E14] border border-gray-800 rounded-xl p-5 font-mono text-xs space-y-5">
            {/* ── HEADER TELEMETRY METRICS ── */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-800/80 pb-4">
                <div className="space-y-1">
                    <div className="flex items-center gap-2">
                        <Layers className="w-4 h-4 text-blue-400" />
                        <h4 className="text-gray-200 font-bold uppercase tracking-wider text-xs">
                            OpenTelemetry Execution Trace
                        </h4>
                        <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                            VERIFIED (LOOPBACK)
                        </span>
                    </div>
                    <div className="text-[11px] text-gray-400">
                        Trace ID: <span className="text-gray-200 font-bold">{trace.trace_id}</span>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/40 border border-gray-800">
                        <Clock className="w-3.5 h-3.5 text-gray-400" />
                        <span className="text-gray-400 text-[10px]">Total Latency:</span>
                        <span className="text-white font-bold text-xs">
                            {trace.total_duration_ms}ms
                        </span>
                    </div>

                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/40 border border-gray-800">
                        <Activity className="w-3.5 h-3.5 text-blue-400" />
                        <span className="text-gray-400 text-[10px]">Spans:</span>
                        <span className="text-white font-bold text-xs">{trace.spans_count}</span>
                    </div>

                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/40 border border-gray-800">
                        <Cpu className="w-3.5 h-3.5 text-amber-400" />
                        <span className="text-gray-400 text-[10px]">LLM Ratio:</span>
                        <span className="text-amber-300 font-bold text-xs">{modelPercentage}%</span>
                    </div>
                </div>
            </div>

            {/* ── LATENCY BREAKDOWN PROGRESS BAR ── */}
            <div className="space-y-1.5 bg-black/30 p-3 rounded-lg border border-gray-800/60">
                <div className="flex items-center justify-between text-[11px] text-gray-400">
                    <span>Latency Distribution:</span>
                    <span>
                        LLM:{' '}
                        <strong className="text-amber-300">{modelDuration.toFixed(1)}ms</strong> /
                        Overhead &amp; Tools:{' '}
                        <strong className="text-cyan-300">
                            {(totalDuration - modelDuration).toFixed(1)}ms
                        </strong>
                    </span>
                </div>
                <div className="h-2 rounded-full bg-gray-800 overflow-hidden flex">
                    <div
                        className="bg-amber-500 h-full transition-all duration-300"
                        style={{ width: `${modelPercentage}%` }}
                        title={`LLM Inference: ${modelDuration}ms (${modelPercentage}%)`}
                    />
                    <div
                        className="bg-cyan-500 h-full transition-all duration-300"
                        style={{ width: `${100 - modelPercentage}%` }}
                        title={`Tools and Orchestration: ${(totalDuration - modelDuration).toFixed(1)}ms`}
                    />
                </div>
            </div>

            {/* ── VIEW MODE TOGGLE ── */}
            <div className="flex items-center justify-between">
                <span className="text-[11px] text-gray-400 uppercase tracking-wider font-semibold">
                    Finished Spans ({trace.spans.length})
                </span>
                <div className="inline-flex rounded-lg border border-gray-800 bg-black/40 p-0.5">
                    <button
                        type="button"
                        onClick={() => setViewMode('waterfall')}
                        className={`px-2.5 py-1 rounded text-[11px] transition-colors ${
                            viewMode === 'waterfall'
                                ? 'bg-blue-600 text-white font-bold'
                                : 'text-gray-400 hover:text-gray-200'
                        }`}
                    >
                        Waterfall Timeline
                    </button>
                    <button
                        type="button"
                        onClick={() => setViewMode('hierarchy')}
                        className={`px-2.5 py-1 rounded text-[11px] transition-colors ${
                            viewMode === 'hierarchy'
                                ? 'bg-blue-600 text-white font-bold'
                                : 'text-gray-400 hover:text-gray-200'
                        }`}
                    >
                        Parent-Child Tree
                    </button>
                </div>
            </div>

            {/* ── SPANS RENDERER ── */}
            <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
                {trace.spans.map((span, idx) => {
                    const style = getSpanCategoryStyle(span.name);
                    const IconComponent = style.icon;
                    const durationWidthPct = Math.max(
                        3,
                        Math.min(100, ((span.duration_ms || 0.1) / totalDuration) * 100)
                    );
                    const isSelected = selectedSpan?.span_id === span.span_id;

                    return (
                        <div
                            key={span.span_id || idx}
                            onClick={() => setSelectedSpan(isSelected ? null : span)}
                            className={`p-2.5 rounded-lg border transition-all cursor-pointer ${
                                isSelected
                                    ? 'bg-blue-950/30 border-blue-500/80 shadow-md'
                                    : 'bg-[#10141D] border-gray-800/80 hover:border-gray-700'
                            }`}
                        >
                            <div className="flex items-center justify-between gap-3">
                                <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-[10px] text-gray-500 w-5 text-right shrink-0">
                                        #{idx + 1}
                                    </span>
                                    <span
                                        className={`p-1 rounded ${style.bg} ${style.text} border ${style.border} shrink-0`}
                                    >
                                        <IconComponent className="w-3 h-3" />
                                    </span>
                                    <div className="min-w-0">
                                        <div className="font-bold text-gray-200 truncate flex items-center gap-1.5 text-xs">
                                            <span>{span.name}</span>
                                            <span
                                                className={`px-1.5 py-0.2 rounded text-[9px] uppercase tracking-wider font-extrabold ${style.text} ${style.bg} border ${style.border}`}
                                            >
                                                {style.badge}
                                            </span>
                                        </div>
                                        {viewMode === 'hierarchy' && span.parent_name && (
                                            <div className="text-[10px] text-gray-500 truncate flex items-center gap-1">
                                                <span>parent:</span>
                                                <span className="text-gray-400">
                                                    {span.parent_name}
                                                </span>
                                                <span className="text-gray-600">
                                                    ({span.parent_span_id?.substring(0, 8)})
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="text-right shrink-0">
                                    <div className="font-bold text-gray-200 text-xs">
                                        {span.duration_ms !== undefined
                                            ? `${span.duration_ms}ms`
                                            : '0ms'}
                                    </div>
                                    <div className="text-[10px] text-gray-500">
                                        ID: {span.span_id.substring(0, 8)}
                                    </div>
                                </div>
                            </div>

                            {/* Waterfall Bar Preview */}
                            {viewMode === 'waterfall' && (
                                <div className="mt-2 pt-1 border-t border-gray-800/50">
                                    <div className="h-1.5 rounded-full bg-gray-900 overflow-hidden">
                                        <div
                                            className={`h-full rounded-full ${style.bar}`}
                                            style={{ width: `${durationWidthPct}%` }}
                                        />
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* ── SELECTED SPAN ATTRIBUTE DRAWER ── */}
            {selectedSpan && (
                <div className="p-4 bg-black/60 border border-blue-500/40 rounded-xl space-y-3 animate-in fade-in duration-150">
                    <div className="flex items-center justify-between border-b border-gray-800 pb-2">
                        <div className="flex items-center gap-2">
                            <Info className="w-3.5 h-3.5 text-blue-400" />
                            <span className="font-bold text-white text-xs">
                                Span Detail: {selectedSpan.name}
                            </span>
                        </div>
                        <button
                            type="button"
                            onClick={() => setSelectedSpan(null)}
                            className="text-gray-500 hover:text-white text-xs px-1.5 py-0.5 rounded"
                        >
                            ✕
                        </button>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
                        <div>
                            <span className="text-gray-500 block">Span ID</span>
                            <span className="text-gray-300 font-bold">{selectedSpan.span_id}</span>
                        </div>
                        <div>
                            <span className="text-gray-500 block">Parent ID</span>
                            <span className="text-gray-300 font-bold">
                                {selectedSpan.parent_span_id || 'root'}
                            </span>
                        </div>
                        <div>
                            <span className="text-gray-500 block">Status</span>
                            <span className="text-emerald-400 font-bold">
                                {selectedSpan.status || 'OK'}
                            </span>
                        </div>
                        <div>
                            <span className="text-gray-500 block">Duration</span>
                            <span className="text-white font-bold">
                                {selectedSpan.duration_ms}ms
                            </span>
                        </div>
                    </div>

                    {/* Allowlisted Attributes */}
                    {selectedSpan.attributes && Object.keys(selectedSpan.attributes).length > 0 && (
                        <div className="space-y-1 pt-1">
                            <span className="text-gray-500 text-[10px] uppercase font-bold tracking-wider">
                                Allowlisted Telemetry Attributes:
                            </span>
                            <div className="bg-[#0B0E14] p-2.5 rounded-lg border border-gray-800 space-y-1 text-[11px]">
                                {Object.entries(selectedSpan.attributes).map(([key, val]) => (
                                    <div
                                        key={key}
                                        className="flex items-start justify-between gap-2"
                                    >
                                        <span className="text-blue-400 font-semibold">{key}:</span>
                                        <span className="text-gray-300 text-right truncate max-w-xs font-mono">
                                            {typeof val === 'object'
                                                ? JSON.stringify(val)
                                                : String(val)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
