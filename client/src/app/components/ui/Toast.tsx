'use client';

import { useState, useCallback, useEffect } from 'react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
    id: string;
    type: ToastType;
    title: string;
    message?: string;
    duration?: number;
}

interface ToastItemProps {
    toast: Toast;
    onDismiss: (id: string) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
    useEffect(() => {
        const duration = toast.duration ?? 4500;
        const timer = setTimeout(() => onDismiss(toast.id), duration);
        return () => clearTimeout(timer);
    }, [toast.id, toast.duration, onDismiss]);

    const styles: Record<
        ToastType,
        { bg: string; border: string; icon: string; titleColor: string }
    > = {
        success: {
            bg: 'bg-[#0a1a11]',
            border: 'border-emerald-700/50',
            icon: '✅',
            titleColor: 'text-emerald-400',
        },
        error: {
            bg: 'bg-[#1a0a0a]',
            border: 'border-red-700/50',
            icon: '❌',
            titleColor: 'text-red-400',
        },
        warning: {
            bg: 'bg-[#1a1200]',
            border: 'border-amber-700/50',
            icon: '⚠️',
            titleColor: 'text-amber-400',
        },
        info: {
            bg: 'bg-[#0a0f1a]',
            border: 'border-blue-700/50',
            icon: 'ℹ️',
            titleColor: 'text-blue-400',
        },
    };

    const s = styles[toast.type];

    return (
        <div
            className={`flex items-start gap-3 ${s.bg} border ${s.border} rounded-xl p-3.5 shadow-2xl shadow-black/60 min-w-[280px] max-w-sm backdrop-blur-sm animate-in slide-in-from-right-5 fade-in duration-300`}
        >
            <span className="text-base shrink-0 mt-0.5">{s.icon}</span>
            <div className="flex-1 min-w-0">
                <div className={`text-xs font-bold ${s.titleColor} leading-tight`}>
                    {toast.title}
                </div>
                {toast.message && (
                    <div className="text-[10px] text-gray-400 mt-0.5 leading-relaxed">
                        {toast.message}
                    </div>
                )}
            </div>
            <button
                onClick={() => onDismiss(toast.id)}
                className="text-gray-600 hover:text-gray-300 text-xs leading-none shrink-0 mt-0.5 transition-colors"
            >
                ×
            </button>
        </div>
    );
}

interface ToastContainerProps {
    toasts: Toast[];
    onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
    if (toasts.length === 0) return null;
    return (
        <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 pointer-events-none">
            {toasts.map((t) => (
                <div key={t.id} className="pointer-events-auto">
                    <ToastItem toast={t} onDismiss={onDismiss} />
                </div>
            ))}
        </div>
    );
}

export function useToast() {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const dismiss = useCallback((id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    const showToast = useCallback(
        (type: ToastType, title: string, message?: string, duration?: number) => {
            const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            setToasts((prev) => [...prev.slice(-4), { id, type, title, message, duration }]);
        },
        []
    );

    return { toasts, showToast, dismiss };
}
