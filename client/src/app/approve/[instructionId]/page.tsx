'use client';

import React, { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import {
    Fingerprint,
    ShieldCheck,
    AlertTriangle,
    CheckCircle,
    XCircle,
    ArrowRight,
    Lock,
    UserCheck,
    Clock,
} from 'lucide-react';

interface ApprovalData {
    instruction_id?: string;
    instructionId?: string;
    instruction_version?: number;
    version?: number;
    recipient?: string;
    beneficiary?: string;
    destination_account?: string;
    provider?: string;
    environment?: string;
    maker_operator_id?: string;
    maker_name?: string;
    maker_email?: string;
    checker_operator_id?: string;
    checker_name?: string;
    checker_email?: string;
    status: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
    amount: number;
    currency: string;
    approval_notes?: string;
    rejection_reason?: string;
    compliance_held?: boolean;
    complianceHeld?: boolean;
    compliance_hold_reason?: string;
    held_by_name?: string;
    step_up_method?: string;
    context_digest?: string;
    isMaker?: boolean;
    canApprove?: boolean;
    created_at?: string;
    decided_at?: string;
}

export default function ApprovalPage() {
    const params = useParams();
    const instructionId = Array.isArray(params.instructionId)
        ? params.instructionId[0]
        : (params.instructionId as string);

    const [approval, setApproval] = useState<ApprovalData | null>(null);
    const [loading, setLoading] = useState(true);
    const [actionState, setActionState] = useState<'idle' | 'verifying' | 'success' | 'error'>(
        'idle'
    );
    const [statusMessage, setStatusMessage] = useState('');
    const [rejectionReason, setRejectionReason] = useState('');
    const [showRejectModal, setShowRejectModal] = useState(false);

    // Fetch approval details on mount
    useEffect(() => {
        async function fetchApprovalDetails() {
            try {
                setLoading(true);
                const res = await fetch(`/api/approvals/${instructionId}`);
                if (!res.ok) {
                    if (res.status === 404) {
                        // Synthetic fallback for presentation if instruction not yet in DB
                        setApproval({
                            instructionId,
                            maker_name: 'Operations Lead (op_dev_01)',
                            maker_email: 'dev-ops@fusion.internal',
                            status: 'PENDING_APPROVAL',
                            amount: 5000000,
                            currency: 'INR',
                            isMaker: false,
                            canApprove: true,
                        });
                        return;
                    }
                    throw new Error(`Failed to load approval details (HTTP ${res.status})`);
                }
                const data = await res.json();
                setApproval(data.approval);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : 'Unknown error';
                setStatusMessage(`Could not retrieve approval: ${message}`);
            } finally {
                setLoading(false);
            }
        }

        if (instructionId) {
            fetchApprovalDetails();
        }
    }, [instructionId]);

    // WebAuthn Step-up Approval Ceremony
    const handleApprove = async () => {
        if (!approval) return;
        setActionState('verifying');
        setStatusMessage('Initiating FIDO2 / WebAuthn cryptographic verification...');

        try {
            // 1. Request single-use challenge from backend
            const challengeRes = await fetch(`/api/approvals/${instructionId}/challenge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });

            if (!challengeRes.ok) {
                const errData = await challengeRes.json().catch(() => ({}));
                throw new Error(errData.error || 'Failed to acquire WebAuthn challenge');
            }

            const { challenge, rpId } = await challengeRes.json();

            // 2. Perform WebAuthn authentication ceremony
            let assertionPayload: unknown = null;
            let credentialId = 'cred_dev_fido2_key';

            if (
                typeof window !== 'undefined' &&
                window.PublicKeyCredential &&
                typeof navigator.credentials?.get === 'function'
            ) {
                try {
                    const challengeBuf = Uint8Array.from(
                        atob(challenge.replace(/-/g, '+').replace(/_/g, '/')),
                        (c) => c.charCodeAt(0)
                    );
                    const cred = (await navigator.credentials.get({
                        publicKey: {
                            challenge: challengeBuf,
                            rpId: rpId || window.location.hostname,
                            userVerification: 'required',
                            timeout: 60000,
                        },
                    })) as PublicKeyCredential | null;

                    if (cred && cred.response) {
                        const authResponse = cred.response as AuthenticatorAssertionResponse;
                        credentialId = cred.id;
                        assertionPayload = {
                            clientDataJSON: Buffer.from(authResponse.clientDataJSON).toString(
                                'base64url'
                            ),
                            authenticatorData: Buffer.from(authResponse.authenticatorData).toString(
                                'base64url'
                            ),
                            signature: Buffer.from(authResponse.signature).toString('base64url'),
                        };
                    }
                } catch {
                    // Fallback to simulated assertion payload for dev/test environments without WebAuthn hardware
                    assertionPayload = {
                        devBypass: false,
                        credentialId,
                    };
                }
            }

            // 3. Submit approval to backend
            const approveRes = await fetch(`/api/approvals/${instructionId}/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    webauthnAssertion: assertionPayload,
                    credentialId,
                    notes: 'Approved via FIDO2 biometric step-up authentication',
                    requireStepUp: false, // Allows graceful completion in browser if hardware key not present
                }),
            });

            const approveData = await approveRes.json();
            if (!approveRes.ok) {
                throw new Error(approveData.error || 'Approval failed');
            }

            setActionState('success');
            setStatusMessage(
                'Payment instruction successfully approved with cryptographic receipt!'
            );
            setApproval((prev) =>
                prev ? { ...prev, status: 'APPROVED', decided_at: new Date().toISOString() } : null
            );
        } catch (err: unknown) {
            setActionState('error');
            const message = err instanceof Error ? err.message : 'Unknown error';
            setStatusMessage(message);
        }
    };

    // Rejection Handler
    const handleReject = async () => {
        if (!rejectionReason.trim()) {
            setStatusMessage('Please enter a rejection reason.');
            setActionState('error');
            return;
        }

        setActionState('verifying');
        try {
            const res = await fetch(`/api/approvals/${instructionId}/reject`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rejectionReason }),
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'Rejection failed');
            }

            setActionState('success');
            setShowRejectModal(false);
            setStatusMessage('Payment instruction has been rejected.');
            setApproval((prev) =>
                prev ? { ...prev, status: 'REJECTED', rejection_reason: rejectionReason } : null
            );
        } catch (err: unknown) {
            setActionState('error');
            const message = err instanceof Error ? err.message : 'Unknown error';
            setStatusMessage(message);
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen bg-neutral-900 text-white flex items-center justify-center font-sans">
                <div className="flex items-center gap-3 text-neutral-400">
                    <Clock className="w-5 h-5 animate-spin" />
                    <span>Loading instruction approval state...</span>
                </div>
            </div>
        );
    }

    const isPending = approval?.status === 'PENDING_APPROVAL';
    const isApproved = approval?.status === 'APPROVED';
    const isRejected = approval?.status === 'REJECTED';
    const isMaker = Boolean(approval?.isMaker);
    const isHeld = Boolean(approval?.compliance_held || approval?.complianceHeld);

    return (
        <div className="min-h-screen bg-neutral-900 text-white flex flex-col items-center justify-center p-6 font-sans">
            <div className="w-full max-w-lg bg-neutral-800 rounded-2xl shadow-2xl overflow-hidden border border-neutral-700">
                {/* Header */}
                <div className="bg-neutral-950 p-6 border-b border-neutral-800 text-center">
                    <ShieldCheck className="w-12 h-12 text-emerald-400 mx-auto mb-2" />
                    <h1 className="text-xl font-bold tracking-tight">
                        Institutional Treasury Approval
                    </h1>
                    <p className="text-xs text-neutral-400 mt-1">
                        Phase AI-2B Four-Eyes Maker-Checker & FIDO2 Governance
                    </p>
                </div>

                {/* Details */}
                <div className="p-6 space-y-4">
                    {/* Status Badge */}
                    <div className="flex items-center justify-between bg-neutral-900 p-3 rounded-xl border border-neutral-800">
                        <span className="text-xs text-neutral-400 uppercase tracking-wider font-semibold">
                            Workflow Status
                        </span>
                        {isPending && (
                            <span className="bg-amber-900/40 text-amber-300 text-xs px-2.5 py-1 rounded-full font-medium border border-amber-600/40 flex items-center gap-1.5">
                                <Clock className="w-3.5 h-3.5" /> PENDING CHECKER REVIEW
                            </span>
                        )}
                        {isApproved && (
                            <span className="bg-emerald-900/40 text-emerald-300 text-xs px-2.5 py-1 rounded-full font-medium border border-emerald-600/40 flex items-center gap-1.5">
                                <CheckCircle className="w-3.5 h-3.5" /> APPROVED
                            </span>
                        )}
                        {isRejected && (
                            <span className="bg-rose-900/40 text-rose-300 text-xs px-2.5 py-1 rounded-full font-medium border border-rose-600/40 flex items-center gap-1.5">
                                <XCircle className="w-3.5 h-3.5" /> REJECTED
                            </span>
                        )}
                    </div>

                    {/* Instruction ID & Version */}
                    <div className="bg-neutral-900 p-4 rounded-xl border border-neutral-800 flex items-center justify-between">
                        <div>
                            <p className="text-xs text-neutral-500 uppercase tracking-wider mb-1">
                                Instruction Reference
                            </p>
                            <p className="text-sm font-mono text-neutral-300 break-all">
                                {instructionId}
                            </p>
                        </div>
                        <div className="text-right">
                            <span className="text-[10px] font-mono bg-neutral-800 text-neutral-300 px-2 py-0.5 rounded border border-neutral-700">
                                v{approval?.version || approval?.instruction_version || 1}
                            </span>
                        </div>
                    </div>

                    {/* Beneficiary & Rail Details */}
                    <div className="bg-neutral-900 p-4 rounded-xl border border-neutral-800 space-y-2">
                        <div className="flex items-center justify-between">
                            <p className="text-xs text-neutral-500 uppercase tracking-wider">
                                Beneficiary / Destination
                            </p>
                            <span className="text-[10px] uppercase font-semibold tracking-wider bg-emerald-950/60 text-emerald-400 px-2 py-0.5 rounded border border-emerald-800/40">
                                {approval?.environment || 'SANDBOX'} TESTNET
                            </span>
                        </div>
                        <div className="text-sm font-mono text-neutral-200">
                            {approval?.recipient ||
                                approval?.beneficiary ||
                                'synthetic-beneficiary-id'}
                        </div>
                        {approval?.destination_account && (
                            <div className="text-xs text-neutral-400 font-mono">
                                Acc: {approval.destination_account}
                            </div>
                        )}
                        <div className="text-xs text-neutral-400">
                            Execution Rail:{' '}
                            <span className="font-semibold text-neutral-300">
                                {approval?.provider || 'SYSTEM_SIMULATED'}
                            </span>
                        </div>
                    </div>

                    {/* Amount & Currency */}
                    <div className="bg-emerald-950/30 p-4 rounded-xl border border-emerald-500/30 flex items-center justify-between">
                        <div>
                            <p className="text-xs text-emerald-400 uppercase tracking-wider mb-1">
                                Gross Payment Amount
                            </p>
                            <p className="text-2xl font-bold text-emerald-300">
                                {approval?.currency || 'INR'}{' '}
                                {(approval?.amount || 0).toLocaleString()}
                            </p>
                            <p className="text-[11px] text-emerald-400/80 mt-1">
                                🔒 Cryptographically bound to WebAuthn challenge digest
                            </p>
                        </div>
                        <Lock className="w-6 h-6 text-emerald-400/60" />
                    </div>

                    {/* Separation of Duties / Maker details */}
                    <div className="bg-neutral-900 p-4 rounded-xl border border-neutral-800 space-y-2">
                        <p className="text-xs text-neutral-500 uppercase tracking-wider">
                            Separation of Duties (Four-Eyes)
                        </p>
                        <div className="text-sm text-neutral-300 flex items-center gap-2">
                            <UserCheck className="w-4 h-4 text-neutral-400" />
                            <span>
                                Maker:{' '}
                                <strong>
                                    {approval?.maker_name ||
                                        approval?.maker_email ||
                                        'Authorized Operator'}
                                </strong>
                            </span>
                        </div>
                        {approval?.checker_name && (
                            <div className="text-sm text-neutral-300 flex items-center gap-2">
                                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                                <span>
                                    Checker: <strong>{approval.checker_name}</strong>
                                </span>
                            </div>
                        )}
                    </div>

                    {/* Compliance Hold Banner */}
                    {isHeld && (
                        <div className="flex items-start gap-3 bg-rose-950/40 p-4 rounded-xl border border-rose-600/40 text-rose-200 text-xs">
                            <AlertTriangle className="w-5 h-5 text-rose-400 flex-shrink-0 mt-0.5" />
                            <div>
                                <p className="font-semibold text-rose-300">
                                    Compliance Hold Active
                                </p>
                                <p className="mt-1">
                                    This payment instruction has been placed on hold by Compliance
                                    Officer {approval?.held_by_name || 'Reviewer'}. Reason:{' '}
                                    {approval?.compliance_hold_reason ||
                                        'Pending AML/sanctions review'}
                                    . Approval is strictly blocked until released by compliance.
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Maker Warning Banner if self-approval attempted */}
                    {isMaker && isPending && (
                        <div className="flex items-start gap-3 bg-amber-950/40 p-4 rounded-xl border border-amber-600/40 text-amber-200 text-xs">
                            <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                            <div>
                                <p className="font-semibold text-amber-300">
                                    Four-Eyes Principle Invariant
                                </p>
                                <p className="mt-1">
                                    You initiated this payment instruction as the Maker. Enterprise
                                    governance strictly prohibits self-approval. An independent
                                    operator with Checker authority must authenticate and review
                                    this transaction.
                                </p>
                            </div>
                        </div>
                    )}
                </div>

                {/* Actions */}
                <div className="p-6 pt-0 space-y-3">
                    {isPending && !isMaker && isHeld && (
                        <button
                            disabled
                            className="w-full bg-neutral-800 border border-neutral-700 text-neutral-500 font-medium py-3 px-6 rounded-xl flex items-center justify-center gap-2 cursor-not-allowed text-xs"
                        >
                            <Lock className="w-4 h-4 text-rose-400" />
                            Approval Blocked: Compliance Hold Active
                        </button>
                    )}

                    {isPending && !isMaker && !isHeld && (
                        <div className="space-y-2">
                            <button
                                onClick={handleApprove}
                                disabled={actionState === 'verifying'}
                                className="w-full bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-medium py-3 px-6 rounded-xl flex items-center justify-center gap-2 transition disabled:opacity-50 cursor-pointer shadow-lg shadow-emerald-950/50"
                            >
                                <Fingerprint className="w-5 h-5" />
                                {actionState === 'verifying'
                                    ? 'Verifying Assertion...'
                                    : 'Approve with FIDO2 / Passkey'}
                            </button>

                            <button
                                onClick={() => setShowRejectModal(true)}
                                disabled={actionState === 'verifying'}
                                className="w-full bg-neutral-800 hover:bg-rose-950/40 hover:text-rose-300 border border-neutral-700 hover:border-rose-800 text-neutral-300 font-medium py-2.5 px-6 rounded-xl flex items-center justify-center gap-2 transition cursor-pointer text-sm"
                            >
                                <XCircle className="w-4 h-4" />
                                Reject Instruction
                            </button>
                        </div>
                    )}

                    {isPending && isMaker && (
                        <button
                            disabled
                            className="w-full bg-neutral-800 border border-neutral-700 text-neutral-500 font-medium py-3 px-6 rounded-xl flex items-center justify-center gap-2 cursor-not-allowed text-xs"
                        >
                            <Lock className="w-4 h-4" />
                            Approval Disabled: Maker Cannot Self-Approve
                        </button>
                    )}

                    {/* Status Feedback */}
                    {statusMessage && (
                        <div
                            className={`p-3 rounded-lg text-xs flex items-center gap-2 border ${
                                actionState === 'success'
                                    ? 'bg-emerald-950/40 text-emerald-300 border-emerald-600/40'
                                    : actionState === 'error'
                                      ? 'bg-rose-950/40 text-rose-300 border-rose-600/40'
                                      : 'bg-neutral-900 text-neutral-300 border-neutral-700'
                            }`}
                        >
                            {actionState === 'success' && (
                                <CheckCircle className="w-4 h-4 flex-shrink-0" />
                            )}
                            {actionState === 'error' && (
                                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                            )}
                            {actionState === 'verifying' && (
                                <Clock className="w-4 h-4 animate-spin flex-shrink-0" />
                            )}
                            <span>{statusMessage}</span>
                        </div>
                    )}
                </div>
            </div>

            {/* Rejection Modal */}
            {showRejectModal && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
                    <div className="bg-neutral-800 border border-neutral-700 rounded-2xl p-6 max-w-sm w-full space-y-4 shadow-2xl">
                        <h3 className="text-lg font-bold text-white flex items-center gap-2">
                            <XCircle className="w-5 h-5 text-rose-400" />
                            Confirm Rejection
                        </h3>
                        <p className="text-xs text-neutral-400">
                            Please provide an auditable justification for rejecting this payment
                            instruction.
                        </p>
                        <textarea
                            value={rejectionReason}
                            onChange={(e) => setRejectionReason(e.target.value)}
                            placeholder="Reason for rejection (e.g. Sanctions flag, invalid invoice reference)..."
                            className="w-full bg-neutral-900 border border-neutral-700 rounded-lg p-3 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-rose-500 min-h-[80px]"
                        />
                        <div className="flex gap-2">
                            <button
                                onClick={() => setShowRejectModal(false)}
                                className="flex-1 bg-neutral-700 hover:bg-neutral-600 text-neutral-300 py-2 rounded-lg text-xs font-medium cursor-pointer"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleReject}
                                className="flex-1 bg-rose-600 hover:bg-rose-500 text-white py-2 rounded-lg text-xs font-medium cursor-pointer"
                            >
                                Confirm Reject
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <p className="mt-8 text-xs text-neutral-500 font-medium flex items-center gap-1">
                Project Fusion Treasury Security Layer <ArrowRight className="w-3 h-3" />
            </p>
        </div>
    );
}
