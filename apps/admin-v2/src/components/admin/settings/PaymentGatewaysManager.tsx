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
    Loader2, CheckCircle2, ChevronDown, Zap,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Accordion, AccordionItem, AccordionContent } from "@/components/ui/accordion";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

import {
    MASKED,
    type MethodKey,
    type PaymentMethodsData,
    type StripeData,
    type SSLCommerzData,
    type PolarData,
    META,
    PasswordInput,
    LiveWarning,
    SaveBtn,
    SandboxToggle,
    ExtLink,
} from "./payment-gateway-utils";
import { PolarForm, PolarSetupGuide } from "./PolarSettingsForm";
import { getServerFnError } from "@/lib/api-helpers";
import {
    getPaymentMethods,
    updatePaymentMethods,
    getPaymentGatewaySettings,
    type SettingsPayload,
    updatePaymentGatewaySettings,
} from "@/lib/api-functions/settings";

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
            const d = await getPaymentMethods() as PaymentMethodsData;
            setMethods(d);
            setEnabledMethods(new Set(d.enabledMethods));
            setDefaultMethod(d.defaultMethod);
        } catch { toast.error("Failed to load payment settings"); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { loadMethods(); }, [loadMethods]);

    // Lazy-load gateway credentials on accordion expand
    const loadCreds = useCallback(async (gw: MethodKey) => {
        if (gw === "cod" || loadedGateways.current.has(gw)) return;
        setLoadingGw(gw);
        try {
            const d = await getPaymentGatewaySettings({ data: { gateway: gw } }) as Record<string, unknown>;
            if (gw === "stripe") {
                const sd = d as unknown as StripeData;
                setStripe(sd); setStripeConf({ secret: !!sd.secretKey, webhook: !!sd.webhookSecret });
            } else if (gw === "sslcommerz") {
                const sd = d as unknown as SSLCommerzData;
                setSsl(sd); setSslConf({ password: !!sd.storePassword });
            } else if (gw === "polar") {
                const sd = d as unknown as PolarData;
                setPolar(sd); setPolarConf({ token: !!sd.accessToken, webhook: !!sd.webhookSecret });
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
            await updatePaymentMethods({ data: { enabledMethods: Array.from(enabledMethods), defaultMethod } });
            if (!silent) toast.success("Storefront settings updated");
        } catch { if (!silent) toast.error("Error saving payment methods"); }
        finally { setSavingMethods(false); }
    };

    const saveGw = async (gw: MethodKey, body: object, setSaving: (v: boolean) => void) => {
        setSaving(true);
        try {
            await updatePaymentGatewaySettings({ data: { gateway: gw, settings: body as unknown as SettingsPayload } });
            await saveMethods(true);
            toast.success(`${META[gw].label} settings saved`);
            loadedGateways.current.delete(gw);
            await Promise.all([loadMethods(), loadCreds(gw)]);
        } catch (err) {
            toast.error(getServerFnError(err, `Error saving ${META[gw].label} settings`));
        }
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

// --- Inline Form Sub-Components (Stripe & SSL kept inline as they're small) ---

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
