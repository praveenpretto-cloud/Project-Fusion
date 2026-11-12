'use client';

import React from 'react';
import { Database, Clock, AlertCircle, Radio, GitFork, BookOpen, FileCode, CheckSquare, Sparkles } from 'lucide-react';

export interface EvidenceCitationBadgeProps {
    citation: string;
    sourceField?: string;
    onClick?: (citation: string) => void;
    isSelected?: boolean;
    size?: 'sm' | 'md';
}

function getCitationMeta(citation: string): { label: string; icon: React.ReactNode; colorClasses: string } {
    const raw = citation.toLowerCase();

    if (raw.includes('timeline') || raw.includes('transaction')) {
        return {
            label: 'Lifecycle Timeline',
            icon: <Clock className="w-3 h-3 text-cyan-400" />,
            colorClasses: 'bg-cyan-950/40 text-cyan-300 border-cyan-800/60 hover:border-cyan-500'
        };
    }
    if (raw.includes('provider') || raw.includes('failure')) {
        return {
            label: 'Provider Gateway',
            icon: <AlertCircle className="w-3 h-3 text-amber-400" />,
            colorClasses: 'bg-amber-950/40 text-amber-300 border-amber-800/60 hover:border-amber-500'
        };
    }
    if (raw.includes('ledger') || raw.includes('hash') || raw.includes('predecessor')) {
        return {
            label: 'Ledger Audit Chain',
            icon: <Database className="w-3 h-3 text-emerald-400" />,
            colorClasses: 'bg-emerald-950/40 text-emerald-300 border-emerald-800/60 hover:border-emerald-500'
        };
    }
    if (raw.includes('webhook') || raw.includes('settlement')) {
        return {
            label: 'Webhook Telemetry',
            icon: <Radio className="w-3 h-3 text-purple-400" />,
            colorClasses: 'bg-purple-950/40 text-purple-300 border-purple-800/60 hover:border-purple-500'
        };
    }
    if (raw.includes('saga')) {
        return {
            label: 'Saga State Machine',
            icon: <GitFork className="w-3 h-3 text-indigo-400" />,
            colorClasses: 'bg-indigo-950/40 text-indigo-300 border-indigo-800/60 hover:border-indigo-500'
        };
    }
    if (raw.includes('reconciliation') || raw.includes('zoho')) {
        return {
            label: 'Zoho Reconciliation',
            icon: <BookOpen className="w-3 h-3 text-blue-400" />,
            colorClasses: 'bg-blue-950/40 text-blue-300 border-blue-800/60 hover:border-blue-500'
        };
    }
    if (raw.includes('iso') || raw.includes('xml')) {
        return {
            label: 'ISO 20022 Schema',
            icon: <FileCode className="w-3 h-3 text-rose-400" />,
            colorClasses: 'bg-rose-950/40 text-rose-300 border-rose-800/60 hover:border-rose-500'
        };
    }

    return {
        label: citation.replace(/([A-Z])/g, ' $1').trim(),
        icon: <CheckSquare className="w-3 h-3 text-gray-400" />,
        colorClasses: 'bg-gray-900 text-gray-300 border-gray-700 hover:border-gray-500'
    };
}

export default function EvidenceCitationBadge({
    citation,
    sourceField,
    onClick,
    isSelected = false,
    size = 'sm'
}: EvidenceCitationBadgeProps) {
    const meta = getCitationMeta(citation);

    // Extract subfield for succinct display if sourceField or citation has dot/colon notation
    const displayDetail = sourceField 
        ? sourceField.split('.').slice(-1)[0]
        : citation.includes('.') 
            ? citation.split('.').slice(-1)[0] 
            : null;

    return (
        <button
            type="button"
            onClick={() => onClick && onClick(citation)}
            title={`Evidence Source: ${citation}${sourceField ? ` (Field: ${sourceField})` : ''} - Click to inspect`}
            className={`inline-flex items-center gap-1.5 font-mono rounded-md border transition-all select-none ${
                size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'
            } ${meta.colorClasses} ${
                isSelected 
                    ? 'ring-2 ring-blue-500 ring-offset-1 ring-offset-gray-950 font-bold shadow-lg scale-105' 
                    : 'opacity-90 hover:opacity-100 cursor-pointer'
            }`}
        >
            <span className="shrink-0">{meta.icon}</span>
            <span className="font-semibold tracking-tight">{meta.label}</span>
            {displayDetail && displayDetail !== meta.label && (
                <span className="text-[10px] opacity-75 font-normal px-1 py-0.2 bg-black/30 rounded border border-white/5">
                    .{displayDetail}
                </span>
            )}
            <Sparkles className="w-2.5 h-2.5 opacity-50 shrink-0 ml-0.5" />
        </button>
    );
}

