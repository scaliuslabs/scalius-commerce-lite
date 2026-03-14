// src/components/admin/settings/PaymentGatewaysManager.tsx
// Accordion-based payment gateway management with lazy-loaded credentials.

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import {
    Loader2, Save, CheckCircle2, AlertTriangle, ExternalLink,
    Eye, EyeOff, HelpCircle, ChevronDown, Zap,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Accordion, AccordionItem, AccordionContent } from "@/components/ui/accordion";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

const MASKED = "••••••••••••";

// --- Types ---

interface GatewayStatus { configured: boolean; enabled: boolean; }
interface PaymentMethodsData {
    enabledMethods: MethodKey[]; defaultMethod: MethodKey;
    gatewayStatus: Record<MethodKey, GatewayStatus>;
}
interface StripeData { secretKey: string; publishableKey: string; webhookSecret: string; enabled: boolean; }
interface SSLCommerzData { storeId: string; storePassword: string; sandbox: boolean; enabled: boolean; }
interface PolarData { accessToken: string; webhookSecret: string; productId: string; sandbox: boolean; enabled: boolean; }
type MethodKey = "stripe" | "sslcommerz" | "polar" | "cod";

// --- Gateway Logo SVGs ---

const StripeLogo = ({ className }: { className?: string }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none">
        <rect width="24" height="24" rx="4" fill="url(#sg)" />
        <path d="M11.2 9.4c0-.7.6-1 1.5-1 1.3 0 3 .4 4.3 1.1V5.8c-1.4-.6-2.9-.8-4.3-.8C9.8 5 7.5 6.7 7.5 9.6c0 4.5 6.2 3.8 6.2 5.7 0 .8-.7 1.1-1.7 1.1-1.5 0-3.4-.6-4.9-1.4v3.8c1.7.7 3.3 1 4.9 1 2.9 0 5-1.4 5-4.4 0-4.8-6.2-4-6.2-5.9z" fill="white" />
        <defs><linearGradient id="sg" x1="0" y1="0" x2="24" y2="24"><stop stopColor="#635bff" /><stop offset="1" stopColor="#7a73ff" /></linearGradient></defs>
    </svg>
);

const SSLCommerzLogo = ({ className }: { className?: string }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none">
        <rect width="24" height="24" rx="4" fill="#16a34a" />
        <path d="M12 4a3.5 3.5 0 0 0-3.5 3.5V9H7v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9h-1.5V7.5A3.5 3.5 0 0 0 12 4zm0 1.5a2 2 0 0 1 2 2V9h-4V7.5a2 2 0 0 1 2-2zm0 6a1.5 1.5 0 0 1 .75 2.8V16a.75.75 0 0 1-1.5 0v-1.7A1.5 1.5 0 0 1 12 11.5z" fill="white" />
    </svg>
);

const PolarLogo = ({ className }: { className?: string }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none">
        <rect width="24" height="24" rx="4" fill="url(#pg)" />
        <path d="M13.5 4L9 13h4l-2.5 7L16 11h-4l1.5-7z" fill="white" />
        <defs><linearGradient id="pg" x1="0" y1="0" x2="24" y2="24"><stop stopColor="#6366f1" /><stop offset="1" stopColor="#8b5cf6" /></linearGradient></defs>
    </svg>
);

const CODLogo = ({ className }: { className?: string }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none">
        <rect width="24" height="24" rx="4" fill="#16a34a" />
        <rect x="4" y="7" width="16" height="10" rx="1.5" fill="white" opacity="0.9" />
        <circle cx="12" cy="12" r="2.5" fill="#16a34a" />
        <path d="M12 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" fill="white" />
    </svg>
);

const META: Record<MethodKey, {
    label: string; desc: string; Logo: React.FC<{ className?: string }>;
    borderColor: string; headerBg: string;
}> = {
    stripe: { label: "Stripe", desc: "Accept card payments globally", Logo: StripeLogo, borderColor: "border-violet-500/20 dark:border-violet-500/10", headerBg: "bg-violet-50/50 dark:bg-violet-950/10" },
    sslcommerz: { label: "SSLCommerz", desc: "BD payments (bKash, Nagad, cards)", Logo: SSLCommerzLogo, borderColor: "border-green-500/20 dark:border-green-500/10", headerBg: "bg-green-50/50 dark:bg-green-950/10" },
    polar: { label: "Polar", desc: "Global digital payments", Logo: PolarLogo, borderColor: "border-indigo-500/20 dark:border-indigo-500/10", headerBg: "bg-indigo-50/50 dark:bg-indigo-950/10" },
    cod: { label: "Cash on Delivery", desc: "Collect payment on delivery", Logo: CODLogo, borderColor: "border-green-500/20 dark:border-green-500/10", headerBg: "bg-green-50/50 dark:bg-green-950/10" },
};

// --- Reusable sub-components ---

function PasswordInput({ id, value, onChange, placeholder, configured }: {
    id: string; value: string; onChange: (v: string) => void; placeholder: string; configured: boolean;
}) {
    const [show, setShow] = useState(false);
    return (
        <div className="relative">
            <Input id={id} type={show ? "text" : "password"} value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={configured ? MASKED : placeholder} className="font-mono pr-10" />
            <button type="button" onClick={() => setShow((s) => !s)} tabIndex={-1}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
            {configured && value === MASKED && (
                <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1 mt-1">
                    <CheckCircle2 className="h-3 w-3" /> Configured -- type to replace
                </p>
            )}
        </div>
    );
}

function LiveWarning({ message }: { message: string }) {
    return (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span><strong>{message}</strong></span>
        </div>
    );
}

function SaveBtn({ saving, label }: { saving: boolean; label: string }) {
    return (
        <div className="flex justify-end pt-1">
            <Button type="submit" disabled={saving} size="sm">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                {label}
            </Button>
        </div>
    );
}

function SandboxToggle({ checked, onChange, extra }: {
    checked: boolean; onChange: (v: boolean) => void; extra?: React.ReactNode;
}) {
    return (
        <div className="flex items-center justify-between">
            <div>
                <p className="text-sm font-medium">Sandbox Mode</p>
                <p className="text-xs text-muted-foreground">Use test credentials</p>
            </div>
            <div className="flex items-center gap-2">
                {extra}
                <Switch checked={checked} onCheckedChange={onChange} />
            </div>
        </div>
    );
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
    return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
            {children} <ExternalLink className="h-2.5 w-2.5" />
        </a>
    );
}

// --- Main Component ---

export default function PaymentGatewaysManager() {
    const [loading, setLoading] = useState(true);
    const [methods, setMethods] = useState<PaymentMethodsData | null>(null);
    const [enabledMethods, setEnabledMethods] = useState<Set<MethodKey>>(new Set(["cod"]));
    const [defaultMethod, setDefaultMethod] = useState<MethodKey>("cod");
    const [savingMethods, setSavingMethods] = useState(false);

    const [stripe, setStripe] = useState<StripeData>({ secretKey: "", publishableKey: "", webhookSecret: "", enabled: false });
    const [stripeConf, setStripeConf] = useState({ secret: false, webhook: false });
    const [savingStripe, setSavingStripe] = useState(false);

    const [ssl, setSsl] = useState<SSLCommerzData>({ storeId: "", storePassword: "", sandbox: true, enabled: false });
    const [sslConf, setSslConf] = useState({ password: false });
    const [savingSsl, setSavingSsl] = useState(false);

    const [polar, setPolar] = useState<PolarData>({ accessToken: "", webhookSecret: "", productId: "", sandbox: true, enabled: false });
    const [polarConf, setPolarConf] = useState({ token: false, webhook: false });
    const [savingPolar, setSavingPolar] = useState(false);

    const [showPolarHelp, setShowPolarHelp] = useState(false);
    const loadedGateways = useRef<Set<string>>(new Set());
    const [loadingGw, setLoadingGw] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<string[]>([]);

    // Load only payment-methods on mount (1 API call)
    const loadMethods = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/v1/admin/settings/payment-methods");
            if (res.ok) {
                const d = await res.json() as PaymentMethodsData;
                setMethods(d);
                setEnabledMethods(new Set(d.enabledMethods));
                setDefaultMethod(d.defaultMethod);
            }
        } catch { toast.error("Failed to load payment settings"); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { loadMethods(); }, [loadMethods]);

    // Lazy-load gateway credentials on accordion expand
    const loadCreds = useCallback(async (gw: MethodKey) => {
        if (gw === "cod" || loadedGateways.current.has(gw)) return;
        setLoadingGw(gw);
        try {
            const res = await fetch(`/api/v1/admin/settings/${gw}`);
            if (!res.ok) return;
            if (gw === "stripe") {
                const d = await res.json() as StripeData;
                setStripe(d); setStripeConf({ secret: !!d.secretKey, webhook: !!d.webhookSecret });
            } else if (gw === "sslcommerz") {
                const d = await res.json() as SSLCommerzData;
                setSsl(d); setSslConf({ password: !!d.storePassword });
            } else if (gw === "polar") {
                const d = await res.json() as PolarData;
                setPolar(d); setPolarConf({ token: !!d.accessToken, webhook: !!d.webhookSecret });
            }
            loadedGateways.current.add(gw);
        } catch { toast.error(`Failed to load ${META[gw].label} settings`); }
        finally { setLoadingGw(null); }
    }, []);

    const handleAccordion = (vals: string[]) => {
        setExpanded(vals);
        for (const v of vals) {
            if (v !== "cod" && !loadedGateways.current.has(v)) loadCreds(v as MethodKey);
        }
    };

    const toggleMethod = (method: MethodKey, on: boolean) => {
        const next = new Set(enabledMethods);
        if (on) { next.add(method); }
        else {
            if (next.size <= 1) { toast.error("At least one payment method must be enabled."); return; }
            next.delete(method);
            if (defaultMethod === method) setDefaultMethod(Array.from(next)[0] as MethodKey);
        }
        setEnabledMethods(next);
        if (method === "stripe") setStripe(p => ({ ...p, enabled: on }));
        if (method === "sslcommerz") setSsl(p => ({ ...p, enabled: on }));
        if (method === "polar") setPolar(p => ({ ...p, enabled: on }));
    };

    const saveMethods = async (silent = false) => {
        setSavingMethods(true);
        try {
            const res = await fetch("/api/v1/admin/settings/payment-methods", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ enabledMethods: Array.from(enabledMethods), defaultMethod }),
            });
            if (!res.ok) throw new Error();
            if (!silent) toast.success("Storefront settings updated");
        } catch { if (!silent) toast.error("Error saving payment methods"); }
        finally { setSavingMethods(false); }
    };

    const saveGw = async (gw: MethodKey, body: object, setSaving: (v: boolean) => void) => {
        setSaving(true);
        try {
            const res = await fetch(`/api/v1/admin/settings/${gw}`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (res.ok) {
                await saveMethods(true);
                toast.success(`${META[gw].label} settings saved`);
                loadedGateways.current.delete(gw);
                await Promise.all([loadMethods(), loadCreds(gw)]);
            } else {
                const e = await res.json() as any;
                toast.error(e.message || "Save failed");
            }
        } catch { toast.error(`Error saving ${META[gw].label} settings`); }
        finally { setSaving(false); }
    };

    const getStatusBadge = (m: MethodKey) => {
        if (m === "cod") {
            return enabledMethods.has("cod")
                ? <Badge variant="default" className="text-xs bg-green-500/10 text-green-600 hover:bg-green-500/20 shadow-none border-0 gap-1"><CheckCircle2 className="h-3 w-3" /> Active</Badge>
                : <Badge variant="secondary" className="text-xs">Inactive</Badge>;
        }
        const st = methods?.gatewayStatus?.[m];
        if (!st?.configured) return <Badge variant="outline" className="text-xs text-muted-foreground">Needs Setup</Badge>;
        if (!enabledMethods.has(m)) return <Badge variant="secondary" className="text-xs">Inactive</Badge>;
        if (m === "stripe") {
            const live = stripe.secretKey && stripe.secretKey !== MASKED && stripe.secretKey.startsWith("sk_live_");
            return <Badge variant="default" className="text-xs bg-violet-500/10 text-violet-600 hover:bg-violet-500/20 shadow-none border-0 gap-1"><CheckCircle2 className="h-3 w-3" />{live ? "Live" : "Test"}</Badge>;
        }
        if (m === "sslcommerz")
            return <Badge variant="default" className="text-xs bg-green-500/10 text-green-600 hover:bg-green-500/20 shadow-none border-0 gap-1"><CheckCircle2 className="h-3 w-3" />{ssl.sandbox ? "Sandbox" : "Live"}</Badge>;
        if (m === "polar")
            return <Badge variant="default" className="text-xs bg-indigo-500/10 text-indigo-600 hover:bg-indigo-500/20 shadow-none border-0 gap-1"><CheckCircle2 className="h-3 w-3" />{polar.sandbox ? "Sandbox" : "Live"}</Badge>;
        return null;
    };

    if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;

    const allMethods: MethodKey[] = ["stripe", "sslcommerz", "polar", "cod"];

    return (
        <div className="space-y-6 max-w-4xl">
            {/* Gateway Preferences */}
            <Card>
                <CardHeader className="pb-3 border-b border-border">
                    <CardTitle className="text-base font-semibold">Gateway Preferences</CardTitle>
                    <CardDescription>Configure which payment method is selected by default.</CardDescription>
                </CardHeader>
                <CardContent className="pt-4 flex items-center justify-between pb-4">
                    <span className="text-sm font-medium">Default Payment Method</span>
                    <Select value={defaultMethod} onValueChange={(v) => setDefaultMethod(v as MethodKey)}>
                        <SelectTrigger className="w-[200px] h-9"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {allMethods.filter((m) => enabledMethods.has(m)).map((m) => (
                                <SelectItem key={m} value={m} className="text-sm">{META[m].label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </CardContent>
                <CardFooter className="pt-0 justify-end">
                    <Button variant="secondary" size="sm" onClick={() => saveMethods()} disabled={savingMethods}>
                        {savingMethods && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                        Save Preference
                    </Button>
                </CardFooter>
            </Card>

            {/* Gateway Cards - 2x2 Grid */}
            <Accordion type="multiple" value={expanded} onValueChange={handleAccordion}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {allMethods.map((method) => {
                        const meta = META[method];
                        const isOpen = expanded.includes(method);
                        return (
                            <AccordionItem key={method} value={method} className={`border rounded-lg overflow-hidden ${meta.borderColor}`}>
                                <div className={`flex items-center justify-between p-4 ${meta.headerBg}`}>
                                    <div className="flex items-center gap-3 min-w-0">
                                        <meta.Logo className="h-8 w-8 shrink-0 rounded" />
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <h3 className="text-sm font-medium">{meta.label}</h3>
                                                {getStatusBadge(method)}
                                            </div>
                                            <p className="text-xs text-muted-foreground mt-0.5 truncate">{meta.desc}</p>
                                        </div>
                                    </div>
                                    <Switch id={`toggle-${method}`} checked={enabledMethods.has(method)} className="shrink-0"
                                        onCheckedChange={(v) => { toggleMethod(method, v); if (method === "cod") setTimeout(() => saveMethods(true), 100); }} />
                                </div>
                                {method !== "cod" && (
                                    <AccordionPrimitive.Header className="flex">
                                        <AccordionPrimitive.Trigger className="flex w-full items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors border-t border-border/50 cursor-pointer [&[data-state=open]>svg]:rotate-180">
                                            {isOpen ? "Hide" : "Configure"} credentials
                                            <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200" />
                                        </AccordionPrimitive.Trigger>
                                    </AccordionPrimitive.Header>
                                )}
                                {method !== "cod" && (
                                    <AccordionContent className="px-4 pb-4">
                                        {loadingGw === method ? (
                                            <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                                        ) : method === "stripe" ? (
                                            <StripeForm s={stripe} set={setStripe} conf={stripeConf} saving={savingStripe}
                                                onSave={() => saveGw("stripe", stripe, setSavingStripe)} />
                                        ) : method === "sslcommerz" ? (
                                            <SSLForm s={ssl} set={setSsl} conf={sslConf} saving={savingSsl}
                                                onSave={() => saveGw("sslcommerz", ssl, setSavingSsl)} />
                                        ) : method === "polar" ? (
                                            <PolarForm s={polar} set={setPolar} conf={polarConf} saving={savingPolar}
                                                onSave={() => saveGw("polar", polar, setSavingPolar)} onHelp={() => setShowPolarHelp(true)} />
                                        ) : null}
                                    </AccordionContent>
                                )}
                            </AccordionItem>
                        );
                    })}
                </div>
            </Accordion>

            <Dialog open={showPolarHelp} onOpenChange={setShowPolarHelp}>
                <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2"><Zap className="h-5 w-5 text-indigo-600" /> Polar Setup Guide</DialogTitle>
                        <DialogDescription>Follow these steps to integrate Polar with your store.</DialogDescription>
                    </DialogHeader>
                    <PolarSetupGuide />
                </DialogContent>
            </Dialog>
        </div>
    );
}

// --- Form Sub-Components ---

function StripeForm({ s, set, conf, saving, onSave }: {
    s: StripeData; set: React.Dispatch<React.SetStateAction<StripeData>>;
    conf: { secret: boolean; webhook: boolean }; saving: boolean; onSave: () => void;
}) {
    return (
        <form onSubmit={(e) => { e.preventDefault(); onSave(); }} className="space-y-3 pt-2">
            <div className="space-y-1.5">
                <Label htmlFor="stripe-secret" className="flex items-center gap-1.5 text-sm">
                    Secret Key {conf.secret && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
                </Label>
                <PasswordInput id="stripe-secret" value={s.secretKey} onChange={(v) => set((p) => ({ ...p, secretKey: v }))}
                    placeholder="sk_live_... or sk_test_..." configured={conf.secret} />
                <p className="text-xs text-muted-foreground"><ExtLink href="https://dashboard.stripe.com/apikeys">dashboard.stripe.com/apikeys</ExtLink></p>
            </div>
            <div className="space-y-1.5">
                <Label htmlFor="stripe-pub" className="text-sm">Publishable Key</Label>
                <Input id="stripe-pub" type="text" value={s.publishableKey} className="font-mono"
                    onChange={(e) => set((p) => ({ ...p, publishableKey: e.target.value }))} placeholder="pk_live_... or pk_test_..." />
            </div>
            <div className="space-y-1.5">
                <Label htmlFor="stripe-wh" className="flex items-center gap-1.5 text-sm">
                    Webhook Secret {conf.webhook && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
                </Label>
                <PasswordInput id="stripe-wh" value={s.webhookSecret} onChange={(v) => set((p) => ({ ...p, webhookSecret: v }))}
                    placeholder="whsec_..." configured={conf.webhook} />
                <p className="text-xs text-muted-foreground">Add endpoint <code className="text-xs bg-muted px-1 rounded">/api/v1/webhooks/stripe</code> in Stripe webhooks.</p>
            </div>
            {s.secretKey && s.secretKey !== MASKED && s.secretKey.startsWith("sk_live_") && s.enabled && (
                <LiveWarning message="Live key detected. Real cards will be charged." />
            )}
            <SaveBtn saving={saving} label="Save Stripe" />
        </form>
    );
}

function SSLForm({ s, set, conf, saving, onSave }: {
    s: SSLCommerzData; set: React.Dispatch<React.SetStateAction<SSLCommerzData>>;
    conf: { password: boolean }; saving: boolean; onSave: () => void;
}) {
    return (
        <form onSubmit={(e) => { e.preventDefault(); onSave(); }} className="space-y-3 pt-2">
            <SandboxToggle checked={s.sandbox} onChange={(v) => set((p) => ({ ...p, sandbox: v }))} />
            {!s.sandbox && s.enabled && <LiveWarning message="Live mode enabled. Real payments will be processed." />}
            <div className="space-y-1.5">
                <Label htmlFor="ssl-id" className="text-sm">Store ID</Label>
                <Input id="ssl-id" type="text" value={s.storeId} className="font-mono"
                    onChange={(e) => set((p) => ({ ...p, storeId: e.target.value }))} placeholder="your_store_id" />
            </div>
            <div className="space-y-1.5">
                <Label htmlFor="ssl-pw" className="flex items-center gap-1.5 text-sm">
                    Store Password {conf.password && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
                </Label>
                <PasswordInput id="ssl-pw" value={s.storePassword} onChange={(v) => set((p) => ({ ...p, storePassword: v }))}
                    placeholder="your_store_password" configured={conf.password} />
            </div>
            <SaveBtn saving={saving} label="Save SSLCommerz" />
        </form>
    );
}

function PolarForm({ s, set, conf, saving, onSave, onHelp }: {
    s: PolarData; set: React.Dispatch<React.SetStateAction<PolarData>>;
    conf: { token: boolean; webhook: boolean }; saving: boolean; onSave: () => void; onHelp: () => void;
}) {
    return (
        <form onSubmit={(e) => { e.preventDefault(); onSave(); }} className="space-y-3 pt-2">
            <SandboxToggle checked={s.sandbox} onChange={(v) => set((p) => ({ ...p, sandbox: v }))}
                extra={<Button type="button" variant="ghost" size="sm" className="text-xs gap-1 text-muted-foreground h-7" onClick={onHelp}>
                    <HelpCircle className="h-3.5 w-3.5" /> Setup Guide
                </Button>} />
            {!s.sandbox && s.enabled && <LiveWarning message="Live mode enabled. Real payments will be processed." />}
            <div className="space-y-1.5">
                <Label htmlFor="polar-tok" className="flex items-center gap-1.5 text-sm">
                    Access Token {conf.token && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
                </Label>
                <PasswordInput id="polar-tok" value={s.accessToken} onChange={(v) => set((p) => ({ ...p, accessToken: v }))}
                    placeholder="polar_pat_..." configured={conf.token} />
                <p className="text-xs text-muted-foreground"><ExtLink href="https://polar.sh/settings">polar.sh/settings</ExtLink></p>
            </div>
            <div className="space-y-1.5">
                <Label htmlFor="polar-wh" className="flex items-center gap-1.5 text-sm">
                    Webhook Secret {conf.webhook && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
                </Label>
                <PasswordInput id="polar-wh" value={s.webhookSecret} onChange={(v) => set((p) => ({ ...p, webhookSecret: v }))}
                    placeholder="polar_whs_..." configured={conf.webhook} />
                <p className="text-xs text-muted-foreground">Add endpoint <code className="text-xs bg-muted px-1 rounded">/api/v1/webhooks/polar</code> in Polar webhooks.</p>
            </div>
            <div className="space-y-1.5">
                <Label htmlFor="polar-pid" className="text-sm">Product ID</Label>
                <Input id="polar-pid" type="text" value={s.productId} className="font-mono"
                    onChange={(e) => set((p) => ({ ...p, productId: e.target.value }))} placeholder="prod_..." />
                <p className="text-xs text-muted-foreground">Create a generic product on Polar and paste its ID here.</p>
            </div>
            <SaveBtn saving={saving} label="Save Polar" />
        </form>
    );
}

function PolarSetupGuide() {
    const steps = [
        { t: "Create a Polar Account", c: <>Sign up at <ExtLink href="https://polar.sh">polar.sh</ExtLink> and create an organization.</> },
        { t: "Generate an Access Token", c: <>Go to <ExtLink href="https://polar.sh/settings">Organization Settings</ExtLink> &rarr; <strong>Access Tokens</strong> &rarr; Create a token with <code className="bg-muted px-1 rounded text-xs">checkouts:write</code> scope.</> },
        { t: "Create a Generic Product", c: <>In Polar Dashboard &rarr; <strong>Products</strong> &rarr; Create a product. Copy the <strong>Product ID</strong> from the &hellip; menu.</> },
        { t: "Configure Webhooks", c: <>Add endpoint <code className="block bg-muted px-3 py-2 rounded text-xs break-all mt-1">https://your-domain.com/api/v1/webhooks/polar</code>Select events: <code className="bg-muted px-1 rounded text-xs">checkout.updated</code> and <code className="bg-muted px-1 rounded text-xs">order.paid</code>.</> },
        { t: "Enable & Save", c: <>Toggle <strong>Enable gateway</strong> on, then click <strong>Save Polar</strong>.</> },
    ];
    return (
        <div className="space-y-4 text-sm">
            {steps.map((s, i) => (
                <div key={i} className="space-y-2">
                    <h4 className="font-semibold flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold dark:bg-indigo-900 dark:text-indigo-300">{i + 1}</span>
                        {s.t}
                    </h4>
                    <p className="text-muted-foreground pl-7">{s.c}</p>
                </div>
            ))}
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 px-4 py-3 mt-2">
                <p className="text-amber-800 dark:text-amber-200 text-xs">
                    <strong>Tip:</strong> Start with <strong>Sandbox Mode</strong> enabled to test without charging real customers.
                </p>
            </div>
        </div>
    );
}
