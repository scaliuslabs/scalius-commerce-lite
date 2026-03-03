// src/components/admin/settings/PaymentGatewaysManager.tsx
// Unified compact payment gateway management - toggles + credentials in one view.

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
    Loader2,
    Save,
    CreditCard,
    Banknote,
    Shield,
    Zap,
    CheckCircle2,
    AlertTriangle,
    ExternalLink,
    Eye,
    EyeOff,
    HelpCircle,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog";

const MASKED_VALUE = "••••••••••••";

// --- Types ---

interface GatewayStatus {
    configured: boolean;
    enabled: boolean;
}

interface PaymentMethodsData {
    enabledMethods: ("stripe" | "sslcommerz" | "polar" | "cod")[];
    defaultMethod: "stripe" | "sslcommerz" | "polar" | "cod";
    gatewayStatus: {
        stripe: GatewayStatus;
        sslcommerz: GatewayStatus;
        polar: GatewayStatus;
        cod: GatewayStatus;
    };
}

interface StripeData {
    secretKey: string;
    publishableKey: string;
    webhookSecret: string;
    enabled: boolean;
}

interface SSLCommerzData {
    storeId: string;
    storePassword: string;
    sandbox: boolean;
    enabled: boolean;
}

interface PolarData {
    accessToken: string;
    webhookSecret: string;
    productId: string;
    sandbox: boolean;
    enabled: boolean;
}

const METHOD_META = {
    stripe: {
        label: "Stripe",
        desc: "Accept card payments globally",
        icon: CreditCard,
        color: "text-violet-600",
        bg: "bg-violet-50 dark:bg-violet-500/10",
    },
    sslcommerz: {
        label: "SSLCommerz",
        desc: "BD payments (bKash, Nagad, cards)",
        icon: Shield,
        color: "text-blue-600",
        bg: "bg-blue-50 dark:bg-blue-500/10",
    },
    polar: {
        label: "Polar",
        desc: "Global digital payments",
        icon: Zap,
        color: "text-indigo-600",
        bg: "bg-indigo-50 dark:bg-indigo-500/10",
    },
    cod: {
        label: "Cash on Delivery",
        desc: "Collect payment on delivery",
        icon: Banknote,
        color: "text-green-600",
        bg: "bg-green-50 dark:bg-green-500/10",
    },
} as const;

type MethodKey = keyof typeof METHOD_META;

// --- Small sub-components ---

function PasswordInput({
    id,
    value,
    onChange,
    placeholder,
    configured,
}: {
    id: string;
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
    configured: boolean;
}) {
    const [show, setShow] = useState(false);
    return (
        <div className="relative">
            <Input
                id={id}
                type={show ? "text" : "password"}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={configured ? MASKED_VALUE : placeholder}
                className="font-mono pr-10"
            />
            <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                tabIndex={-1}
            >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
            {configured && value === MASKED_VALUE && (
                <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1 mt-1">
                    <CheckCircle2 className="h-3 w-3" /> Configured — type to replace
                </p>
            )}
        </div>
    );
}

// --- Main Component ---

export default function PaymentGatewaysManager() {
    const [loading, setLoading] = useState(true);

    // --- Methods state ---
    const [methods, setMethods] = useState<PaymentMethodsData | null>(null);
    const [enabledMethods, setEnabledMethods] = useState<Set<MethodKey>>(new Set(["cod"]));
    const [defaultMethod, setDefaultMethod] = useState<MethodKey>("cod");
    const [savingMethods, setSavingMethods] = useState(false);

    // --- Stripe state ---
    const [stripe, setStripe] = useState<StripeData>({
        secretKey: "",
        publishableKey: "",
        webhookSecret: "",
        enabled: false,
    });
    const [stripeConfigured, setStripeConfigured] = useState({ secret: false, webhook: false });
    const [savingStripe, setSavingStripe] = useState(false);

    // --- SSLCommerz state ---
    const [ssl, setSsl] = useState<SSLCommerzData>({
        storeId: "",
        storePassword: "",
        sandbox: true,
        enabled: false,
    });
    const [sslConfigured, setSslConfigured] = useState({ password: false });
    const [savingSsl, setSavingSsl] = useState(false);

    // --- Polar state ---
    const [polar, setPolar] = useState<PolarData>({
        accessToken: "",
        webhookSecret: "",
        productId: "",
        sandbox: true,
        enabled: false,
    });
    const [polarConfigured, setPolarConfigured] = useState({ token: false, webhook: false });
    const [savingPolar, setSavingPolar] = useState(false);
    const [showPolarHelp, setShowPolarHelp] = useState(false);

    // --- Load all data in parallel ---
    const loadAll = useCallback(async () => {
        setLoading(true);
        try {
            const [methodsRes, stripeRes, sslRes, polarRes] = await Promise.all([
                fetch("/api/v1/admin/settings/payment-methods"),
                fetch("/api/v1/admin/settings/stripe"),
                fetch("/api/v1/admin/settings/sslcommerz"),
                fetch("/api/v1/admin/settings/polar"),
            ]);

            if (methodsRes.ok) {
                const d = await methodsRes.json() as PaymentMethodsData;
                setMethods(d);
                setEnabledMethods(new Set(d.enabledMethods as MethodKey[]));
                setDefaultMethod(d.defaultMethod as MethodKey);
            }
            if (stripeRes.ok) {
                const d = await stripeRes.json() as StripeData;
                setStripe(d);
                setStripeConfigured({ secret: !!d.secretKey, webhook: !!d.webhookSecret });
            }
            if (sslRes.ok) {
                const d = await sslRes.json() as SSLCommerzData;
                setSsl(d);
                setSslConfigured({ password: !!d.storePassword });
            }
            if (polarRes.ok) {
                const d = await polarRes.json() as PolarData;
                setPolar(d);
                setPolarConfigured({ token: !!d.accessToken, webhook: !!d.webhookSecret });
            }
        } catch {
            toast.error("Failed to load payment settings");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadAll(); }, [loadAll]);

    // --- Helper to sync method toggle with global list ---
    const toggleMethod = (method: MethodKey, isActive: boolean) => {
        let nextMethods = new Set(enabledMethods);
        if (isActive) {
            nextMethods.add(method);
        } else {
            if (nextMethods.size <= 1) {
                toast.error("At least one payment method must be enabled.");
                return;
            }
            nextMethods.delete(method);
            if (defaultMethod === method) {
                setDefaultMethod(Array.from(nextMethods)[0] as MethodKey);
            }
        }

        setEnabledMethods(nextMethods);

        if (method === "stripe") setStripe(prev => ({ ...prev, enabled: isActive }));
        if (method === "sslcommerz") setSsl(prev => ({ ...prev, enabled: isActive }));
        if (method === "polar") setPolar(prev => ({ ...prev, enabled: isActive }));
    };

    // --- Save methods (Global state) ---
    const saveMethods = async (silent = false) => {
        setSavingMethods(true);
        try {
            const res = await fetch("/api/v1/admin/settings/payment-methods", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ enabledMethods: Array.from(enabledMethods), defaultMethod }),
            });
            if (!res.ok) throw new Error("Failed to save methods");
            if (!silent) toast.success("Storefront settings updated");
        } catch {
            if (!silent) toast.error("Error saving payment methods");
        } finally {
            setSavingMethods(false);
        }
    };

    // --- Save Stripe (Combines stripe settings + methods config) ---
    const saveStripe = async () => {
        setSavingStripe(true);
        try {
            const res = await fetch("/api/v1/admin/settings/stripe", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(stripe),
            });
            if (res.ok) {
                await saveMethods(true); // Sync the global enabled state
                toast.success("Stripe settings saved");
                await loadAll();
            } else {
                const e = await res.json() as any; toast.error(e.message || "Save failed");
            }
        } catch { toast.error("Error saving Stripe settings"); }
        finally { setSavingStripe(false); }
    };

    // --- Save SSLCommerz ---
    const saveSsl = async () => {
        setSavingSsl(true);
        try {
            const res = await fetch("/api/v1/admin/settings/sslcommerz", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(ssl),
            });
            if (res.ok) {
                await saveMethods(true);
                toast.success("SSLCommerz settings saved");
                await loadAll();
            } else {
                const e = await res.json() as any; toast.error(e.message || "Save failed");
            }
        } catch { toast.error("Error saving SSLCommerz settings"); }
        finally { setSavingSsl(false); }
    };

    // --- Save Polar ---
    const savePolar = async () => {
        setSavingPolar(true);
        try {
            const res = await fetch("/api/v1/admin/settings/polar", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(polar),
            });
            if (res.ok) {
                await saveMethods(true);
                toast.success("Polar settings saved");
                await loadAll();
            } else {
                const e = await res.json() as any; toast.error(e.message || "Save failed");
            }
        } catch { toast.error("Error saving Polar settings"); }
        finally { setSavingPolar(false); }
    };

    // --- Status helpers ---
    const stripeStatus = methods?.gatewayStatus.stripe;
    const sslStatus = methods?.gatewayStatus.sslcommerz;
    const polarStatus = methods?.gatewayStatus.polar;

    const getStatusBadge = (method: MethodKey) => {
        if (method === "cod") {
            return enabledMethods.has("cod") ? (
                <Badge variant="default" className="text-xs bg-green-500/10 text-green-600 hover:bg-green-500/20 shadow-none border-0 gap-1"><CheckCircle2 className="h-3 w-3" /> Active</Badge>
            ) : (
                <Badge variant="secondary" className="text-xs">Inactive</Badge>
            );
        }
        if (method === "stripe") {
            if (!stripeStatus?.configured) return <Badge variant="outline" className="text-xs text-muted-foreground">Needs Setup</Badge>;
            if (!enabledMethods.has("stripe")) return <Badge variant="secondary" className="text-xs">Inactive</Badge>;
            const isLive = stripe.secretKey && stripe.secretKey !== MASKED_VALUE && stripe.secretKey.startsWith("sk_live_");
            return <Badge variant="default" className="text-xs bg-violet-500/10 text-violet-600 hover:bg-violet-500/20 shadow-none border-0 gap-1"><CheckCircle2 className="h-3 w-3" />{isLive ? "Live" : "Test"}</Badge>;
        }
        if (method === "sslcommerz") {
            if (!sslStatus?.configured) return <Badge variant="outline" className="text-xs text-muted-foreground">Needs Setup</Badge>;
            if (!enabledMethods.has("sslcommerz")) return <Badge variant="secondary" className="text-xs">Inactive</Badge>;
            return <Badge variant="default" className="text-xs bg-blue-500/10 text-blue-600 hover:bg-blue-500/20 shadow-none border-0 gap-1"><CheckCircle2 className="h-3 w-3" />{ssl.sandbox ? "Sandbox" : "Live"}</Badge>;
        }
        if (method === "polar") {
            if (!polarStatus?.configured) return <Badge variant="outline" className="text-xs text-muted-foreground">Needs Setup</Badge>;
            if (!enabledMethods.has("polar")) return <Badge variant="secondary" className="text-xs">Inactive</Badge>;
            return <Badge variant="default" className="text-xs bg-indigo-500/10 text-indigo-600 hover:bg-indigo-500/20 shadow-none border-0 gap-1"><CheckCircle2 className="h-3 w-3" />{polar.sandbox ? "Sandbox" : "Live"}</Badge>;
        }
        return null;
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-16">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    const allMethods: MethodKey[] = ["stripe", "sslcommerz", "polar", "cod"];

    return (
        <div className="space-y-6 max-w-3xl">

            {/* General Preferences */}
            <Card>
                <CardHeader className="pb-3 border-b border-border">
                    <CardTitle className="text-base font-semibold">Gateway Preferences</CardTitle>
                    <CardDescription>Configure which payment method is selected by default.</CardDescription>
                </CardHeader>
                <CardContent className="pt-4 flex items-center justify-between pb-4">
                    <span className="text-sm font-medium">Default Payment Method</span>
                    <Select value={defaultMethod} onValueChange={(v) => setDefaultMethod(v as MethodKey)}>
                        <SelectTrigger className="w-[200px] h-9">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {allMethods.filter((m) => enabledMethods.has(m)).map((m) => (
                                <SelectItem key={m} value={m} className="text-sm">
                                    {METHOD_META[m].label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </CardContent>
                <CardFooter className="pt-0 justify-end">
                    <Button variant="secondary" size="sm" onClick={() => saveMethods()} disabled={savingMethods}>
                        {savingMethods ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                        Save Preference
                    </Button>
                </CardFooter>
            </Card>

            {/* --- STRIPE --- */}
            <Card className="overflow-hidden border-violet-500/20 dark:border-violet-500/10">
                <div className="flex items-center justify-between p-5 bg-violet-50/50 dark:bg-violet-950/10 border-b border-border">
                    <div className="flex items-center gap-4">
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${METHOD_META.stripe.bg}`}>
                            <METHOD_META.stripe.icon className={`h-5 w-5 ${METHOD_META.stripe.color}`} />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h3 className="text-base font-medium">{METHOD_META.stripe.label}</h3>
                                {getStatusBadge("stripe")}
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">{METHOD_META.stripe.desc}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <Label htmlFor="toggle-stripe" className="text-sm">Enable gateway</Label>
                        <Switch
                            id="toggle-stripe"
                            checked={enabledMethods.has("stripe")}
                            onCheckedChange={(v) => toggleMethod("stripe", v)}
                        />
                    </div>
                </div>

                <CardContent className="p-5 space-y-4 pt-5">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                            <Label htmlFor="stripe-secret" className="flex items-center gap-1.5 text-sm">
                                Secret Key
                                {stripeConfigured.secret && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
                            </Label>
                            <PasswordInput
                                id="stripe-secret"
                                value={stripe.secretKey}
                                onChange={(v) => setStripe((s) => ({ ...s, secretKey: v }))}
                                placeholder="sk_live_... or sk_test_..."
                                configured={stripeConfigured.secret}
                            />
                            <p className="text-xs text-muted-foreground">
                                <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                                    dashboard.stripe.com/apikeys <ExternalLink className="h-2.5 w-2.5" />
                                </a>
                            </p>
                        </div>

                        <div className="space-y-1.5">
                            <Label htmlFor="stripe-pub" className="text-sm">Publishable Key</Label>
                            <Input
                                id="stripe-pub"
                                type="text"
                                value={stripe.publishableKey}
                                onChange={(e) => setStripe((s) => ({ ...s, publishableKey: e.target.value }))}
                                placeholder="pk_live_... or pk_test_..."
                                className="font-mono"
                            />
                        </div>

                        <div className="space-y-1.5 sm:col-span-2">
                            <Label htmlFor="stripe-webhook" className="flex items-center gap-1.5 text-sm">
                                Webhook Secret
                                {stripeConfigured.webhook && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
                            </Label>
                            <PasswordInput
                                id="stripe-webhook"
                                value={stripe.webhookSecret}
                                onChange={(v) => setStripe((s) => ({ ...s, webhookSecret: v }))}
                                placeholder="whsec_..."
                                configured={stripeConfigured.webhook}
                            />
                            <p className="text-xs text-muted-foreground">
                                Add endpoint <code className="text-xs bg-muted px-1 rounded">/api/v1/webhooks/stripe</code> in Stripe webhooks setting.
                            </p>
                        </div>
                    </div>

                    {stripe.secretKey && stripe.secretKey !== MASKED_VALUE && stripe.secretKey.startsWith("sk_live_") && stripe.enabled && (
                        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                            <span><strong>Live key detected.</strong> Real cards will be charged.</span>
                        </div>
                    )}
                </CardContent>
                <CardFooter className="bg-muted/10 border-t border-border py-3 flex justify-end">
                    <Button onClick={saveStripe} disabled={savingStripe} size="sm">
                        {savingStripe ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                        Save Stripe Configuration
                    </Button>
                </CardFooter>
            </Card>

            {/* --- SSLCOMMERZ --- */}
            <Card className="overflow-hidden border-blue-500/20 dark:border-blue-500/10">
                <div className="flex items-center justify-between p-5 bg-blue-50/50 dark:bg-blue-950/10 border-b border-border">
                    <div className="flex items-center gap-4">
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${METHOD_META.sslcommerz.bg}`}>
                            <METHOD_META.sslcommerz.icon className={`h-5 w-5 ${METHOD_META.sslcommerz.color}`} />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h3 className="text-base font-medium">{METHOD_META.sslcommerz.label}</h3>
                                {getStatusBadge("sslcommerz")}
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">{METHOD_META.sslcommerz.desc}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <Label htmlFor="toggle-ssl" className="text-sm">Enable gateway</Label>
                        <Switch
                            id="toggle-ssl"
                            checked={enabledMethods.has("sslcommerz")}
                            onCheckedChange={(v) => toggleMethod("sslcommerz", v)}
                        />
                    </div>
                </div>

                <CardContent className="p-5 space-y-4 pt-5">
                    <div className="flex items-center justify-between pb-2">
                        <div>
                            <p className="text-sm font-medium">Sandbox Mode</p>
                            <p className="text-xs text-muted-foreground">Use test credentials to simulate payments</p>
                        </div>
                        <Switch
                            checked={ssl.sandbox}
                            onCheckedChange={(v) => setSsl((s) => ({ ...s, sandbox: v }))}
                        />
                    </div>

                    {!ssl.sandbox && ssl.enabled && (
                        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive mb-2">
                            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                            <span><strong>Live mode enabled.</strong> Real customer payments will be processed.</span>
                        </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                            <Label htmlFor="ssl-store-id" className="text-sm">Store ID</Label>
                            <Input
                                id="ssl-store-id"
                                type="text"
                                value={ssl.storeId}
                                onChange={(e) => setSsl((s) => ({ ...s, storeId: e.target.value }))}
                                placeholder="your_store_id"
                                className="font-mono"
                            />
                        </div>

                        <div className="space-y-1.5">
                            <Label htmlFor="ssl-password" className="flex items-center gap-1.5 text-sm">
                                Store Password
                                {sslConfigured.password && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
                            </Label>
                            <PasswordInput
                                id="ssl-password"
                                value={ssl.storePassword}
                                onChange={(v) => setSsl((s) => ({ ...s, storePassword: v }))}
                                placeholder="your_store_password"
                                configured={sslConfigured.password}
                            />
                        </div>
                    </div>
                </CardContent>
                <CardFooter className="bg-muted/10 border-t border-border py-3 flex justify-end">
                    <Button onClick={saveSsl} disabled={savingSsl} size="sm">
                        {savingSsl ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                        Save SSLCommerz Configuration
                    </Button>
                </CardFooter>
            </Card>

            {/* --- POLAR --- */}
            <Card className="overflow-hidden border-indigo-500/20 dark:border-indigo-500/10">
                <div className="flex items-center justify-between p-5 bg-indigo-50/50 dark:bg-indigo-950/10 border-b border-border">
                    <div className="flex items-center gap-4">
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${METHOD_META.polar.bg}`}>
                            <METHOD_META.polar.icon className={`h-5 w-5 ${METHOD_META.polar.color}`} />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h3 className="text-base font-medium">{METHOD_META.polar.label}</h3>
                                {getStatusBadge("polar")}
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">{METHOD_META.polar.desc}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <Button variant="ghost" size="sm" className="text-xs gap-1 text-muted-foreground h-7" onClick={() => setShowPolarHelp(true)}>
                            <HelpCircle className="h-3.5 w-3.5" /> Setup Guide
                        </Button>
                        <Label htmlFor="toggle-polar" className="text-sm">Enable gateway</Label>
                        <Switch
                            id="toggle-polar"
                            checked={enabledMethods.has("polar")}
                            onCheckedChange={(v) => toggleMethod("polar", v)}
                        />
                    </div>
                </div>

                <CardContent className="p-5 space-y-4 pt-5">
                    <div className="flex items-center justify-between pb-2">
                        <div>
                            <p className="text-sm font-medium">Sandbox Mode</p>
                            <p className="text-xs text-muted-foreground">Use test credentials to simulate payments</p>
                        </div>
                        <Switch
                            checked={polar.sandbox}
                            onCheckedChange={(v) => setPolar((s) => ({ ...s, sandbox: v }))}
                        />
                    </div>

                    {!polar.sandbox && polar.enabled && (
                        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive mb-2">
                            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                            <span><strong>Live mode enabled.</strong> Real customer payments will be processed.</span>
                        </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1.5 sm:col-span-2">
                            <Label htmlFor="polar-token" className="flex items-center gap-1.5 text-sm">
                                Access Token
                                {polarConfigured.token && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
                            </Label>
                            <PasswordInput
                                id="polar-token"
                                value={polar.accessToken}
                                onChange={(v) => setPolar((s) => ({ ...s, accessToken: v }))}
                                placeholder="polar_pat_..."
                                configured={polarConfigured.token}
                            />
                            <p className="text-xs text-muted-foreground">
                                <a href="https://polar.sh/settings" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                                    polar.sh/settings <ExternalLink className="h-2.5 w-2.5" />
                                </a>
                            </p>
                        </div>

                        <div className="space-y-1.5">
                            <Label htmlFor="polar-webhook" className="flex items-center gap-1.5 text-sm">
                                Webhook Secret
                                {polarConfigured.webhook && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
                            </Label>
                            <PasswordInput
                                id="polar-webhook"
                                value={polar.webhookSecret}
                                onChange={(v) => setPolar((s) => ({ ...s, webhookSecret: v }))}
                                placeholder="polar_whs_..."
                                configured={polarConfigured.webhook}
                            />
                            <p className="text-xs text-muted-foreground">
                                Add endpoint <code className="text-xs bg-muted px-1 rounded">/api/v1/webhooks/polar</code> in Polar webhook settings.
                            </p>
                        </div>

                        <div className="space-y-1.5">
                            <Label htmlFor="polar-product" className="text-sm">Product ID</Label>
                            <Input
                                id="polar-product"
                                type="text"
                                value={polar.productId}
                                onChange={(e) => setPolar((s) => ({ ...s, productId: e.target.value }))}
                                placeholder="prod_..."
                                className="font-mono"
                            />
                            <p className="text-xs text-muted-foreground">
                                Create a generic product on Polar and paste its ID here.
                            </p>
                        </div>
                    </div>
                </CardContent>
                <CardFooter className="bg-muted/10 border-t border-border py-3 flex justify-end">
                    <Button onClick={savePolar} disabled={savingPolar} size="sm">
                        {savingPolar ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                        Save Polar Configuration
                    </Button>
                </CardFooter>
            </Card>

            {/* --- CASH ON DELIVERY --- */}
            <Card className="overflow-hidden border-green-500/20 dark:border-green-500/10">
                <div className="flex items-center justify-between p-5 bg-green-50/50 dark:bg-green-950/10">
                    <div className="flex items-center gap-4">
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${METHOD_META.cod.bg}`}>
                            <METHOD_META.cod.icon className={`h-5 w-5 ${METHOD_META.cod.color}`} />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h3 className="text-base font-medium">{METHOD_META.cod.label}</h3>
                                {getStatusBadge("cod")}
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">{METHOD_META.cod.desc}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        <Label htmlFor="toggle-cod" className="text-sm">Enable COD</Label>
                        <Switch
                            id="toggle-cod"
                            checked={enabledMethods.has("cod")}
                            onCheckedChange={async (v) => {
                                toggleMethod("cod", v);
                                // For COD, we autosave because there is no other configuration to submit.
                                setTimeout(() => saveMethods(true), 100);
                            }}
                        />
                    </div>
                </div>
            </Card>

            {/* --- Polar Setup Instructions Dialog --- */}
            <Dialog open={showPolarHelp} onOpenChange={setShowPolarHelp}>
                <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Zap className="h-5 w-5 text-indigo-600" />
                            Polar Setup Guide
                        </DialogTitle>
                        <DialogDescription>
                            Follow these steps to integrate Polar with your store.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 text-sm">
                        <div className="space-y-2">
                            <h4 className="font-semibold flex items-center gap-2">
                                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold dark:bg-indigo-900 dark:text-indigo-300">1</span>
                                Create a Polar Account
                            </h4>
                            <p className="text-muted-foreground pl-7">
                                Sign up at{" "}
                                <a href="https://polar.sh" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">
                                    polar.sh <ExternalLink className="h-3 w-3" />
                                </a>{" "}
                                and create an organization for your store.
                            </p>
                        </div>

                        <div className="space-y-2">
                            <h4 className="font-semibold flex items-center gap-2">
                                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold dark:bg-indigo-900 dark:text-indigo-300">2</span>
                                Generate an Access Token
                            </h4>
                            <p className="text-muted-foreground pl-7">
                                Go to{" "}
                                <a href="https://polar.sh/settings" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">
                                    Organization Settings <ExternalLink className="h-3 w-3" />
                                </a>
                                {" "}&rarr; <strong>Access Tokens</strong> &rarr; Create a new token with <code className="bg-muted px-1 rounded text-xs">checkouts:write</code> scope. Paste it in the <strong>Access Token</strong> field.
                            </p>
                        </div>

                        <div className="space-y-2">
                            <h4 className="font-semibold flex items-center gap-2">
                                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold dark:bg-indigo-900 dark:text-indigo-300">3</span>
                                Create a Generic Product
                            </h4>
                            <p className="text-muted-foreground pl-7">
                                In Polar Dashboard &rarr; <strong>Products</strong> &rarr; Create a product (e.g., &quot;Store Order&quot;). The name and price can be anything &mdash; our system uses <strong>ad-hoc pricing</strong> to send the real order total at checkout.
                            </p>
                            <p className="text-muted-foreground pl-7">
                                Click the <strong>&hellip; menu</strong> &rarr; <strong>Copy Product ID</strong> and paste it in the <strong>Product ID</strong> field.
                            </p>
                        </div>

                        <div className="space-y-2">
                            <h4 className="font-semibold flex items-center gap-2">
                                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold dark:bg-indigo-900 dark:text-indigo-300">4</span>
                                Configure Webhooks
                            </h4>
                            <p className="text-muted-foreground pl-7">
                                In Polar Dashboard &rarr; <strong>Settings</strong> &rarr; <strong>Webhooks</strong> &rarr; Add endpoint:
                            </p>
                            <div className="pl-7">
                                <code className="block bg-muted px-3 py-2 rounded text-xs break-all">
                                    https://your-domain.com/api/v1/webhooks/polar
                                </code>
                            </div>
                            <p className="text-muted-foreground pl-7">
                                Select events: <code className="bg-muted px-1 rounded text-xs">checkout.updated</code> and <code className="bg-muted px-1 rounded text-xs">order.paid</code>. Copy the generated <strong>webhook secret</strong> and paste it in the <strong>Webhook Secret</strong> field.
                            </p>
                        </div>

                        <div className="space-y-2">
                            <h4 className="font-semibold flex items-center gap-2">
                                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold dark:bg-indigo-900 dark:text-indigo-300">5</span>
                                Enable & Save
                            </h4>
                            <p className="text-muted-foreground pl-7">
                                Toggle <strong>Enable gateway</strong> on, then click <strong>Save Polar Configuration</strong>. Customers will now see Polar as a payment option on checkout.
                            </p>
                        </div>

                        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 px-4 py-3 mt-2">
                            <p className="text-amber-800 dark:text-amber-200 text-xs">
                                <strong>💡 Tip:</strong> Start with <strong>Sandbox Mode</strong> enabled to test payments without charging real customers. Switch to live mode once everything works.
                            </p>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

        </div>
    );
}
