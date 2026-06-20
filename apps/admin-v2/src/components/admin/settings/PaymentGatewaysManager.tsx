// src/components/admin/settings/PaymentGatewaysManager.tsx
// Accordion-based payment gateway management with lazy-loaded credentials.

import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import {
    Loader2, CheckCircle2, ChevronDown, Zap, AlertTriangle,
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
import { queryKeys } from "@/lib/query-keys";
import { checkoutFlowSettingsQueryOptions } from "@/lib/api-query-options/settings";
import {
    getPaymentMethods,
    updatePaymentMethods,
    getPaymentGatewaySettings,
    type SettingsPayload,
    updatePaymentGatewaySettings,
} from "@/lib/api-functions/settings";

// --- Main Component ---

const ALL_METHODS: MethodKey[] = ["stripe", "sslcommerz", "polar", "cod"];

export default function PaymentGatewaysManager() {
    const queryClient = useQueryClient();
    const { data: checkoutFlowSettings } = useQuery(checkoutFlowSettingsQueryOptions());
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
    };

    const saveMethods = async (silent = false) => {
        setSavingMethods(true);
        try {
            await updatePaymentMethods({ data: { enabledMethods: Array.from(enabledMethods), defaultMethod } });
            await queryClient.invalidateQueries({ queryKey: queryKeys.settings.paymentMethods() });
            await queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutFlow() });
            if (!silent) toast.success("Storefront settings updated");
            return true;
        } catch (err) {
            if (!silent) toast.error(getServerFnError(err, "Error saving payment methods"));
            else throw err;
            return false;
        }
        finally { setSavingMethods(false); }
    };

    const saveGw = async (gw: MethodKey, body: object, setSaving: (v: boolean) => void) => {
        setSaving(true);
        try {
            await updatePaymentGatewaySettings({ data: { gateway: gw, settings: body as unknown as SettingsPayload } });
            await queryClient.invalidateQueries({ queryKey: queryKeys.settings.paymentMethods() });
            await queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutFlow() });
            toast.success(`${META[gw].label} settings saved`);
            loadedGateways.current.delete(gw);
            await Promise.all([loadMethods(), loadCreds(gw)]);
        } catch (err) {
            toast.error(getServerFnError(err, `Error saving ${META[gw].label} settings`));
        }
        finally { setSaving(false); }
    };

    const methodAllowedByFlow = useCallback((method: MethodKey) => {
        const checkoutMode = checkoutFlowSettings?.checkoutMode ?? "all";
        const partialPaymentEnabled = checkoutFlowSettings?.partialPaymentEnabled === true;
        const partialPaymentAmount = checkoutFlowSettings?.partialPaymentAmount ?? 0;
        if (partialPaymentEnabled && partialPaymentAmount > 0) return method !== "cod";
        if (checkoutMode === "guest_cod_only") return method === "cod";
        if (checkoutMode === "gateways_only") return method !== "cod";
        return true;
    }, [checkoutFlowSettings]);

    const getFlowHiddenReason = useCallback((method: MethodKey) => {
        const checkoutMode = checkoutFlowSettings?.checkoutMode ?? "all";
        const partialPaymentEnabled = checkoutFlowSettings?.partialPaymentEnabled === true;
        const partialPaymentAmount = checkoutFlowSettings?.partialPaymentAmount ?? 0;
        if (partialPaymentEnabled && partialPaymentAmount > 0 && method === "cod") {
            return "COD is hidden while Online advance deposit is enabled.";
        }
        if (checkoutMode === "guest_cod_only" && method !== "cod") {
            return "Fast COD Only hides online gateways from customers.";
        }
        if (checkoutMode === "gateways_only" && method === "cod") {
            return "Online Gateways Only hides COD from customers.";
        }
        return null;
    }, [checkoutFlowSettings]);

    useEffect(() => {
        const visibleEnabledMethods = ALL_METHODS.filter((method) =>
            enabledMethods.has(method) && methodAllowedByFlow(method),
        );
        if (visibleEnabledMethods.length > 0 && !visibleEnabledMethods.includes(defaultMethod)) {
            setDefaultMethod(visibleEnabledMethods[0]);
        }
    }, [defaultMethod, enabledMethods, methodAllowedByFlow]);

    const getStatusBadge = (m: MethodKey) => {
        const selected = enabledMethods.has(m);
        const flowAllowed = methodAllowedByFlow(m);
        if (m === "cod") {
            if (!selected) return <Badge variant="secondary" className="text-xs">Hidden</Badge>;
            if (!flowAllowed) return <Badge variant="outline" className="text-xs border-amber-500/40 text-amber-700 dark:text-amber-400">Hidden by flow</Badge>;
            return <Badge variant="default" className="text-xs bg-green-500/10 text-green-600 hover:bg-green-500/20 shadow-none border-0 gap-1"><CheckCircle2 className="h-3 w-3" /> Visible</Badge>;
        }
        const st = methods?.gatewayStatus?.[m];
        const providerEnabled = st?.providerEnabled ?? st?.enabled === true;
        const usable = st?.usable ?? (providerEnabled && st?.configured === true);
        if (!st?.configured) return <Badge variant="outline" className="text-xs text-muted-foreground">Needs setup</Badge>;
        if (!providerEnabled) return <Badge variant="secondary" className="text-xs">Provider off</Badge>;
        if (selected && !usable) {
            return <Badge variant="destructive" className="text-xs gap-1"><AlertTriangle className="h-3 w-3" />Blocked</Badge>;
        }
        if (!selected) return <Badge variant="secondary" className="text-xs">Hidden</Badge>;
        if (!flowAllowed) return <Badge variant="outline" className="text-xs border-amber-500/40 text-amber-700 dark:text-amber-400">Hidden by flow</Badge>;
        if (usable) {
            return <Badge variant="default" className="text-xs bg-green-500/10 text-green-600 hover:bg-green-500/20 shadow-none border-0 gap-1"><CheckCircle2 className="h-3 w-3" />Visible</Badge>;
        }
        return <Badge variant="outline" className="text-xs text-muted-foreground">Ready</Badge>;
    };

    const getGatewayNotice = (m: MethodKey) => {
        if (!enabledMethods.has(m)) return null;
        const flowHiddenReason = getFlowHiddenReason(m);
        if (flowHiddenReason) return flowHiddenReason;
        if (m === "cod") return null;
        const st = methods?.gatewayStatus?.[m];
        if (!st) return null;
        if (st.blockedReason) return st.blockedReason;
        if (st.configured && !(st.providerEnabled ?? st.enabled)) {
            return `${META[m].label} has credentials, but the gateway itself is off. Save ${META[m].label} after turning it on.`;
        }
        if (st.usable === false) {
            return `${META[m].label} is selected but cannot be shown to customers yet.`;
        }
        return null;
    };

    if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;

    const defaultOptions = ALL_METHODS.filter((method) => enabledMethods.has(method) && methodAllowedByFlow(method));
    const canSaveMethods = defaultOptions.length > 0 && defaultOptions.includes(defaultMethod);

    return (
        <div className="space-y-6 max-w-4xl">
            {/* Gateway Preferences */}
            <Card>
                <CardHeader className="pb-3 border-b border-border">
                    <CardTitle className="text-base font-semibold">Checkout Visibility</CardTitle>
                    <CardDescription>Choose which ready payment methods customers can see, and which one is selected first.</CardDescription>
                </CardHeader>
                <CardContent className="pt-4 flex items-center justify-between pb-4">
                    <span className="text-sm font-medium">Default selected checkout method</span>
                    <Select
                        value={canSaveMethods ? defaultMethod : undefined}
                        onValueChange={(v) => setDefaultMethod(v as MethodKey)}
                        disabled={defaultOptions.length === 0}
                    >
                        <SelectTrigger className="w-[200px] h-9"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            {defaultOptions.map((m) => (
                                <SelectItem key={m} value={m} className="text-sm">{META[m].label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </CardContent>
                <CardFooter className="pt-0 justify-end">
                    <Button variant="secondary" size="sm" onClick={() => saveMethods()} disabled={savingMethods || !canSaveMethods}>
                        {savingMethods && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                        Save checkout visibility
                    </Button>
                </CardFooter>
            </Card>

            {/* Gateway Cards - 2x2 Grid */}
            <Accordion type="multiple" value={expanded} onValueChange={handleAccordion}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {ALL_METHODS.map((method) => {
                        const meta = META[method];
                        const isOpen = expanded.includes(method);
                        const gatewayNotice = getGatewayNotice(method);
                        const selected = enabledMethods.has(method);
                        const status = methods?.gatewayStatus?.[method];
                        const providerEnabled = status?.providerEnabled ?? status?.enabled === true;
                        const usable = method === "cod"
                            ? true
                            : status?.usable ?? (providerEnabled && status?.configured === true);
                        const toggleDisabled = method !== "cod" && !selected && !usable;
                        return (
                            <AccordionItem key={method} value={method} className={`border rounded-lg overflow-hidden ${meta.borderColor}`}>
                                <div className={`p-4 ${meta.headerBg}`}>
                                    <div className="flex items-center justify-between gap-3">
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
                                        <div className="flex shrink-0 flex-col items-end gap-1">
                                            <Switch
                                                id={`toggle-${method}`}
                                                checked={enabledMethods.has(method)}
                                                aria-label={`Show ${meta.label} at checkout`}
                                                disabled={toggleDisabled}
                                                onCheckedChange={(v) => toggleMethod(method, v)}
                                            />
                                            <span className="text-[11px] leading-none text-muted-foreground">Show at checkout</span>
                                        </div>
                                    </div>
                                    {gatewayNotice && (
                                        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/25 bg-background/80 px-3 py-2 text-xs text-destructive">
                                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                            <span>{gatewayNotice}</span>
                                        </div>
                                    )}
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
            <div className="flex items-center justify-between rounded-md border border-border/70 px-3 py-2">
                <div className="space-y-0.5">
                    <Label htmlFor="stripe-enabled" className="text-sm">Provider enabled</Label>
                    <p className="text-xs text-muted-foreground">Allows Stripe sessions after credentials are complete.</p>
                </div>
                <Switch
                    id="stripe-enabled"
                    checked={s.enabled}
                    onCheckedChange={(v) => set((p) => ({ ...p, enabled: v }))}
                />
            </div>
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
            <div className="flex items-center justify-between rounded-md border border-border/70 px-3 py-2">
                <div className="space-y-0.5">
                    <Label htmlFor="ssl-enabled" className="text-sm">Provider enabled</Label>
                    <p className="text-xs text-muted-foreground">Allows SSLCommerz sessions after credentials are complete.</p>
                </div>
                <Switch
                    id="ssl-enabled"
                    checked={s.enabled}
                    onCheckedChange={(v) => set((p) => ({ ...p, enabled: v }))}
                />
            </div>
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
