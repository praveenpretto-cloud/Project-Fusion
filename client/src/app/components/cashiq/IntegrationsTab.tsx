import React, { useState, useEffect } from 'react';

interface WhatsAppConfig {
    number?: string;
    features?: {
        invoice_scanning?: boolean;
        daily_forecast?: boolean;
        payment_approvals?: boolean;
    };
}

export default function IntegrationsTab({ businessId, apiKey }: { businessId: string, apiKey?: string }) {
    const [config, setConfig] = useState<WhatsAppConfig>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [phoneNumber, setPhoneNumber] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [successMsg, setSuccessMsg] = useState<string | null>(null);

    useEffect(() => {
        if (!businessId) return;
        setLoading(true);
        fetch('/api/cashiq/businesses')
            .then(res => res.json())
            .then(json => {
                if (json.success) {
                    const biz = json.businesses.find((b: { business_id: string; whatsapp_config?: WhatsAppConfig }) => b.business_id === businessId);
                    if (biz && biz.whatsapp_config) {
                        setConfig(biz.whatsapp_config);
                        setPhoneNumber(biz.whatsapp_config.number || '');
                    }
                }
            })
            .catch(err => setError(err.message))
            .finally(() => setLoading(false));
    }, [businessId]);

    const handleSave = async (newConfig: WhatsAppConfig) => {
        setSaving(true);
        setError(null);
        setSuccessMsg(null);
        try {
            const res = await fetch(`/api/cashiq/${businessId}/whatsapp`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ whatsapp_config: newConfig })
            });
            const json = await res.json();
            if (json.success) {
                setConfig(json.whatsapp_config);
                setSuccessMsg('Settings saved successfully!');
                setTimeout(() => setSuccessMsg(null), 3000);
            } else {
                setError(json.error);
            }
        } catch (err: unknown) {
            setError((err as Error).message);
        } finally {
            setSaving(false);
        }
    };

    const handleConnect = () => {
        if (!phoneNumber) return setError('Please enter a valid phone number');
        handleSave({
            number: phoneNumber,
            features: {
                invoice_scanning: true,
                daily_forecast: true,
                payment_approvals: true
            }
        });
    };

    const handleDisconnect = () => {
        setPhoneNumber('');
        handleSave({});
    };

    const toggleFeature = (feature: keyof NonNullable<WhatsAppConfig['features']>) => {
        const newFeatures = { ...config.features, [feature]: !config.features?.[feature] };
        handleSave({ ...config, features: newFeatures });
    };

    if (loading) return <div className="p-10 text-center text-gray-500 font-mono animate-pulse">Loading configurations...</div>;

    const isConnected = !!config.number;

    return (
        <div className="space-y-8 max-w-3xl pb-20">
            {/* Header */}
            <div>
                <h2 className="text-3xl font-semibold tracking-tight text-white/90 mb-2">CFO Co-Pilot</h2>
                <p className="text-[15px] text-white/50 font-medium">Configure your WhatsApp intelligence and AI features.</p>
            </div>

            {error && <div className="bg-red-500/10 backdrop-blur-md text-red-200 p-4 rounded-2xl text-[14px] font-medium border border-red-500/20 shadow-sm">{error}</div>}
            {successMsg && <div className="bg-emerald-500/10 backdrop-blur-md text-emerald-200 p-4 rounded-2xl text-[14px] font-medium border border-emerald-500/20 shadow-sm">{successMsg}</div>}

            {/* Main Apple-Style Card */}
            <div className="bg-white/[0.02] backdrop-blur-3xl border border-white/[0.08] shadow-[0_8px_32px_rgba(0,0,0,0.4)] rounded-[24px] p-8 overflow-hidden relative">
                {/* Subtle gradient orb behind the card for that VisionOS feel */}
                <div className="absolute -top-32 -right-32 w-64 h-64 bg-emerald-500/20 rounded-full blur-[80px] pointer-events-none" />

                <div className="flex items-center gap-5 mb-8 relative z-10">
                    <div className="w-14 h-14 bg-gradient-to-br from-emerald-400 to-emerald-600 rounded-2xl flex items-center justify-center text-white text-2xl shadow-[0_4px_16px_rgba(16,185,129,0.3)]">
                        <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>
                    </div>
                    <div>
                        <h3 className="text-[20px] font-semibold text-white/90">WhatsApp Intelligence</h3>
                        <p className="text-[14px] text-white/50">Your business connected directly to Fusion.</p>
                    </div>
                </div>

                {!isConnected ? (
                    <div className="bg-black/20 backdrop-blur-md rounded-[16px] p-6 border border-white/[0.05] relative z-10 flex flex-col sm:flex-row gap-4">
                        <div className="flex-1">
                            <label className="text-[12px] text-white/40 font-semibold mb-2 block tracking-wide">Phone Number</label>
                            <input 
                                type="text" 
                                placeholder="+91 98765 43210" 
                                className="w-full bg-white/[0.03] border border-white/10 rounded-[12px] px-4 py-3 text-[15px] text-white/90 placeholder-white/20 outline-none focus:bg-white/[0.05] focus:border-emerald-500/50 transition-all font-mono shadow-inner"
                                value={phoneNumber}
                                onChange={e => setPhoneNumber(e.target.value)}
                            />
                        </div>
                        <div className="flex items-end">
                            <button 
                                onClick={handleConnect}
                                disabled={saving}
                                className="w-full sm:w-auto bg-white text-black hover:bg-gray-100 font-semibold px-6 py-3 rounded-[12px] transition-all disabled:opacity-50 shadow-[0_2px_10px_rgba(255,255,255,0.1)] hover:shadow-[0_4px_16px_rgba(255,255,255,0.2)] text-[15px]"
                            >
                                {saving ? 'Connecting...' : 'Connect Number'}
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-8 relative z-10">
                        <div className="bg-black/20 backdrop-blur-xl rounded-[16px] p-5 border border-white/[0.05] flex justify-between items-center shadow-inner">
                            <div className="flex items-center gap-4">
                                <div className="relative flex items-center justify-center">
                                    <div className="absolute w-3 h-3 bg-emerald-500 rounded-full animate-ping opacity-75" />
                                    <div className="relative w-2 h-2 bg-emerald-400 rounded-full shadow-[0_0_8px_rgba(16,185,129,0.8)]" />
                                </div>
                                <div>
                                    <div className="text-[11px] text-white/40 font-semibold tracking-widest uppercase mb-0.5">Active Number</div>
                                    <div className="text-[18px] font-mono text-white/90 font-medium tracking-wide">{config.number}</div>
                                </div>
                            </div>
                            <button 
                                onClick={handleDisconnect}
                                disabled={saving}
                                className="bg-red-500/10 hover:bg-red-500/20 text-red-400 font-semibold px-4 py-2 rounded-[10px] transition-colors text-[14px]"
                            >
                                Disconnect
                            </button>
                        </div>

                        <div>
                            <h4 className="text-[12px] font-semibold text-white/40 uppercase tracking-widest mb-4 pl-1">Configuration</h4>
                            
                            <div className="bg-white/[0.02] rounded-[16px] border border-white/[0.05] overflow-hidden divide-y divide-white/[0.05]">
                                
                                {/* Feature 1 */}
                                <div className="flex items-center justify-between p-5 hover:bg-white/[0.01] transition-colors">
                                    <div className="pr-8">
                                        <div className="font-semibold text-white/90 text-[15px] mb-1 flex items-center gap-2">
                                            <span className="text-lg">🧾</span> AI Invoice Scanning
                                        </div>
                                        <div className="text-[13px] text-white/40 leading-relaxed">Forward PDF invoices on WhatsApp. Our AI will automatically extract data and log it to your Obligations ledger.</div>
                                    </div>
                                    <button 
                                        onClick={() => toggleFeature('invoice_scanning')}
                                        className={`relative shrink-0 w-[50px] h-[30px] rounded-full transition-all duration-300 ease-in-out ${config.features?.invoice_scanning ? 'bg-emerald-500' : 'bg-white/10'}`}
                                    >
                                        <div className={`absolute top-[3px] w-[24px] h-[24px] rounded-full bg-white shadow-[0_2px_4px_rgba(0,0,0,0.2)] transition-all duration-300 ease-in-out ${config.features?.invoice_scanning ? 'left-[23px]' : 'left-[3px]'}`} />
                                    </button>
                                </div>

                                {/* Feature 2 */}
                                <div className="flex items-center justify-between p-5 hover:bg-white/[0.01] transition-colors">
                                    <div className="pr-8">
                                        <div className="font-semibold text-white/90 text-[15px] mb-1 flex items-center gap-2">
                                            <span className="text-lg">📈</span> Daily Morning Forecast
                                        </div>
                                        <div className="text-[13px] text-white/40 leading-relaxed">Receive an automated 9:00 AM WhatsApp message summarizing today&apos;s runway, bank balances, and overdue bills.</div>
                                    </div>
                                    <button 
                                        onClick={() => toggleFeature('daily_forecast')}
                                        className={`relative shrink-0 w-[50px] h-[30px] rounded-full transition-all duration-300 ease-in-out ${config.features?.daily_forecast ? 'bg-emerald-500' : 'bg-white/10'}`}
                                    >
                                        <div className={`absolute top-[3px] w-[24px] h-[24px] rounded-full bg-white shadow-[0_2px_4px_rgba(0,0,0,0.2)] transition-all duration-300 ease-in-out ${config.features?.daily_forecast ? 'left-[23px]' : 'left-[3px]'}`} />
                                    </button>
                                </div>

                                {/* Feature 3 */}
                                <div className="flex items-center justify-between p-5 hover:bg-white/[0.01] transition-colors">
                                    <div className="pr-8">
                                        <div className="font-semibold text-white/90 text-[15px] mb-1 flex items-center gap-2">
                                            <span className="text-lg">✅</span> SAGA Payment Approvals
                                        </div>
                                        <div className="text-[13px] text-white/40 leading-relaxed">When an Operator initiates a vendor payout, receive an instant WhatsApp prompt to Approve or Reject the bank transfer.</div>
                                    </div>
                                    <button 
                                        onClick={() => toggleFeature('payment_approvals')}
                                        className={`relative shrink-0 w-[50px] h-[30px] rounded-full transition-all duration-300 ease-in-out ${config.features?.payment_approvals ? 'bg-emerald-500' : 'bg-white/10'}`}
                                    >
                                        <div className={`absolute top-[3px] w-[24px] h-[24px] rounded-full bg-white shadow-[0_2px_4px_rgba(0,0,0,0.2)] transition-all duration-300 ease-in-out ${config.features?.payment_approvals ? 'left-[23px]' : 'left-[3px]'}`} />
                                    </button>
                                </div>

                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
