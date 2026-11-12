'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
    Activity,
    Clock,
    Cpu,
    Database,
    Eye,
    RefreshCw,
    ShieldAlert,
    ShieldCheck,
    TrendingUp,
    Wrench,
    AlertTriangle,
    Layers,
    BarChart3,
} from 'lucide-react';

export interface TelemetryMetrics {
    timestamp: string;
    investigations: {
        total: number;
        failures: number;
        active: number;
        duration_ms: {
            count: number;
            min: number;
            max: number;
            median: number;
            p90: number;
            p95: number;
            p99: number;
            mean: number;
        };
    };
    models: {
        requests: number;
        timeouts: number;
        errors: number;
        input_tokens: number;
        output_tokens: number;
        duration_ms: {
            count: number;
            min: number;
            max: number;
            median: number;
            p90: number;
            p95: number;
            p99: number;
            mean: number;
        };
    };
    agent: {
        rounds: number;
        tool_calls: number;
        repeated_tool_calls: number;
        refusals: number;
        validation_failures: number;
    };
    rag: {
        retrieval_duration_ms: {
            count: number;
            min: number;
            max: number;
            median: number;
            p90: number;
            p95: number;
            p99: number;
            mean: number;
        };
        embedding_duration_ms: {
            count: number;
            min: number;
            max: number;
            median: number;
            p90: number;
            p95: number;
            p99: number;
            mean: number;
        };
        chunks_returned: number;
        abstentions: number;
        citation_failures: number;
    };
    dlp: {
        redactions: number;
        duration_ms: {
            count: number;
            min: number;
            max: number;
            median: number;
            p90: number;
            p95: number;
            p99: number;
            mean: number;
        };
        detection_failures: number;
    };
}

export default function AIMetricsPanel() {
    const [metrics, setMetrics] = useState<TelemetryMetrics | null>(null);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);
    const [autoRefresh, setAutoRefresh] = useState<boolean>(false);

    const fetchMetrics = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/ai/observability/metrics');
            const data = await res.json();
            if (res.ok && data.success && data.telemetry) {
                setMetrics(data.telemetry);
            } else {
                setError(data.error || data.message || 'Failed to fetch observability metrics');
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Network error fetching metrics');
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchMetrics();
    }, [fetchMetrics]);

    useEffect(() => {
        if (!autoRefresh) return;
        const interval = setInterval(fetchMetrics, 3000);
        return () => clearInterval(interval);
    }, [autoRefresh, fetchMetrics]);

    if (isLoading && !metrics) {
        return (
            <div className="bg-[#0A0D14] border border-gray-800 rounded-xl p-8 text-center font-mono space-y-3">
                <div className="w-8 h-8 rounded-full border-2 border-blue-500/20 border-t-blue-500 animate-spin mx-auto" />
                <p className="text-xs text-gray-400">Loading live AI telemetry metrics...</p>
            </div>
        );
    }

    if (error && !metrics) {
        return (
            <div className="bg-red-950/20 border border-red-800/40 rounded-xl p-4 font-mono text-xs text-red-300 flex items-center justify-between">
                <span>{error}</span>
                <button
                    type="button"
                    onClick={fetchMetrics}
                    className="px-2.5 py-1 bg-red-900/40 hover:bg-red-800/60 rounded text-[11px]"
                >
                    Retry
                </button>
            </div>
        );
    }

    return (
        <div className="bg-[#0B0E14] border border-gray-800 rounded-xl p-5 font-mono text-xs space-y-5">
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-800/80 pb-3">
                <div className="flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-blue-400" />
                    <h4 className="text-gray-200 font-bold uppercase tracking-wider text-xs">
                        Autonomous AI Operations Telemetry
                    </h4>
                    <span className="px-2 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/30">
                        LIVE AGGREGATE
                    </span>
                </div>

                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => setAutoRefresh(!autoRefresh)}
                        className={`px-2.5 py-1 rounded text-[11px] border transition-colors ${
                            autoRefresh
                                ? 'bg-emerald-950/40 border-emerald-600 text-emerald-300'
                                : 'bg-black/40 border-gray-800 text-gray-400 hover:text-gray-200'
                        }`}
                        title="Poll every 3 seconds"
                    >
                        Auto-Refresh: {autoRefresh ? 'ON' : 'OFF'}
                    </button>

                    <button
                        type="button"
                        onClick={fetchMetrics}
                        disabled={isLoading}
                        className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white font-bold text-[11px] flex items-center gap-1.5 transition-colors disabled:opacity-50"
                    >
                        <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
                        <span>Refresh</span>
                    </button>
                </div>
            </div>

            {/* Metrics Grid */}
            {metrics && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                    {/* Investigations Total */}
                    <div className="bg-[#10141D] border border-gray-800 rounded-lg p-3 space-y-1">
                        <div className="flex items-center justify-between text-gray-400">
                            <span className="text-[10px] uppercase font-semibold">
                                Investigations
                            </span>
                            <Activity className="w-3.5 h-3.5 text-blue-400" />
                        </div>
                        <div className="text-lg font-bold text-white">
                            {metrics.investigations.total}
                        </div>
                        <div className="text-[10px] text-gray-500 flex justify-between">
                            <span>Failures: {metrics.investigations.failures}</span>
                            <span>Active: {metrics.investigations.active}</span>
                        </div>
                    </div>

                    {/* Investigation Latency */}
                    <div className="bg-[#10141D] border border-gray-800 rounded-lg p-3 space-y-1">
                        <div className="flex items-center justify-between text-gray-400">
                            <span className="text-[10px] uppercase font-semibold">
                                Pipeline Latency
                            </span>
                            <Clock className="w-3.5 h-3.5 text-blue-400" />
                        </div>
                        <div className="text-lg font-bold text-white">
                            {metrics.investigations.duration_ms.median}ms
                            <span className="text-[10px] text-gray-400 font-normal ml-1">
                                median
                            </span>
                        </div>
                        <div className="text-[10px] text-gray-500 flex justify-between">
                            <span>p90: {metrics.investigations.duration_ms.p90}ms</span>
                            <span>p95: {metrics.investigations.duration_ms.p95}ms</span>
                        </div>
                    </div>

                    {/* LLM Requests */}
                    <div className="bg-[#10141D] border border-gray-800 rounded-lg p-3 space-y-1">
                        <div className="flex items-center justify-between text-gray-400">
                            <span className="text-[10px] uppercase font-semibold">Model Calls</span>
                            <Cpu className="w-3.5 h-3.5 text-amber-400" />
                        </div>
                        <div className="text-lg font-bold text-amber-300">
                            {metrics.models.requests}
                        </div>
                        <div className="text-[10px] text-gray-500 flex justify-between">
                            <span>Timeouts: {metrics.models.timeouts}</span>
                            <span>Errors: {metrics.models.errors}</span>
                        </div>
                    </div>

                    {/* Token Consumption */}
                    <div className="bg-[#10141D] border border-gray-800 rounded-lg p-3 space-y-1">
                        <div className="flex items-center justify-between text-gray-400">
                            <span className="text-[10px] uppercase font-semibold">Token Usage</span>
                            <TrendingUp className="w-3.5 h-3.5 text-purple-400" />
                        </div>
                        <div className="text-lg font-bold text-purple-300">
                            {(
                                metrics.models.input_tokens + metrics.models.output_tokens
                            ).toLocaleString()}
                        </div>
                        <div className="text-[10px] text-gray-500 flex justify-between">
                            <span>In: {metrics.models.input_tokens}</span>
                            <span>Out: {metrics.models.output_tokens}</span>
                        </div>
                    </div>

                    {/* Tool Calls */}
                    <div className="bg-[#10141D] border border-gray-800 rounded-lg p-3 space-y-1">
                        <div className="flex items-center justify-between text-gray-400">
                            <span className="text-[10px] uppercase font-semibold">Tool Calls</span>
                            <Wrench className="w-3.5 h-3.5 text-cyan-400" />
                        </div>
                        <div className="text-lg font-bold text-cyan-300">
                            {metrics.agent.tool_calls}
                        </div>
                        <div className="text-[10px] text-gray-500 flex justify-between">
                            <span>Repeated: {metrics.agent.repeated_tool_calls}</span>
                            <span>Rounds: {metrics.agent.rounds}</span>
                        </div>
                    </div>

                    {/* RAG Knowledge Engine */}
                    <div className="bg-[#10141D] border border-gray-800 rounded-lg p-3 space-y-1">
                        <div className="flex items-center justify-between text-gray-400">
                            <span className="text-[10px] uppercase font-semibold">RAG Chunks</span>
                            <Database className="w-3.5 h-3.5 text-indigo-400" />
                        </div>
                        <div className="text-lg font-bold text-indigo-300">
                            {metrics.rag.chunks_returned}
                        </div>
                        <div className="text-[10px] text-gray-500 flex justify-between">
                            <span>Abstentions: {metrics.rag.abstentions}</span>
                            <span>Citations: {metrics.rag.citation_failures}</span>
                        </div>
                    </div>

                    {/* DLP Sanitization */}
                    <div className="bg-[#10141D] border border-gray-800 rounded-lg p-3 space-y-1">
                        <div className="flex items-center justify-between text-gray-400">
                            <span className="text-[10px] uppercase font-semibold">
                                DLP Redactions
                            </span>
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                        </div>
                        <div className="text-lg font-bold text-emerald-300">
                            {metrics.dlp.redactions}
                        </div>
                        <div className="text-[10px] text-gray-500 flex justify-between">
                            <span>Failures: {metrics.dlp.detection_failures}</span>
                            <span>Latency: {metrics.dlp.duration_ms.median}ms</span>
                        </div>
                    </div>

                    {/* Model Latency (Median) */}
                    <div className="bg-[#10141D] border border-gray-800 rounded-lg p-3 space-y-1">
                        <div className="flex items-center justify-between text-gray-400">
                            <span className="text-[10px] uppercase font-semibold">
                                Model Latency
                            </span>
                            <Clock className="w-3.5 h-3.5 text-amber-400" />
                        </div>
                        <div className="text-lg font-bold text-white">
                            {metrics.models.duration_ms.median}ms
                        </div>
                        <div className="text-[10px] text-gray-500 flex justify-between">
                            <span>p90: {metrics.models.duration_ms.p90}ms</span>
                            <span>p95: {metrics.models.duration_ms.p95}ms</span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
