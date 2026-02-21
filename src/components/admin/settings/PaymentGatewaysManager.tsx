// src/components/admin/settings/PaymentGatewaysManager.tsx
// Unified compact payment gateway management - toggles + credentials in one view.

import React, { useState, useEffect, useCallback, useRef } from "react";
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
    CheckCircle2,
    AlertTriangle,
    ExternalLink,
    Eye,
    EyeOff,
    Info,
} from "lucide-react";
import { Separator } from "@/components/ui/separator";

const MASKED_VALUE = "••••••••••••";

// --- Types ---

interface GatewayStatus {
    configured: boolean;
    enabled: boolean;
}

interface PaymentMethodsData {
    enabledMethods: ("stripe" | "sslcommerz" | "cod")[];
    defaultMethod: "stripe" | "sslcommerz" | "cod";
    gatewayStatus: {
        stripe: GatewayStatus;
        sslcommerz: GatewayStatus;
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

const METHOD_META = {
    stripe: {
        label: "Stripe",
        desc: "Accept card payments globally",
        icon: CreditCard,
        color: "text-violet-600",
        bg: "bg-violet-50 dark:bg-violet-950/30",
    },
    sslcommerz: {
        label: "SSLCommerz",
        desc: "BD payments (bKash, Nagad, cards)",
        icon: Shield,
        color: "text-blue-600",
        bg: "bg-blue-50 dark:bg-blue-950/30",
    },
    cod: {
        label: "Cash on Delivery",
        desc: "Collect payment on delivery",
        icon: Banknote,
        color: "text-green-600",
        bg: "bg-green-50 dark:bg-green-950/30",
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

    // --- Active credentials tab ---
    const [credTab, setCredTab] = useState<"stripe" | "sslcommerz" | "cod">("stripe");

    // --- Load all data in parallel ---
    const loadAll = useCallback(async () => {
        setLoading(true);
        try {
            const [methodsRes, stripeRes, sslRes] = await Promise.all([
                fetch("/api/settings/payment-methods"),
                fetch("/api/settings/stripe"),
                fetch("/api/settings/sslcommerz"),
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
        } catch {
            toast.error("Failed to load payment settings");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadAll(); }, [loadAll]);

    // --- Toggle method active/inactive ---
    const toggleMethod = (method: MethodKey) => {
        setEnabledMethods((prev) => {
            const next = new Set(prev);
            if (next.has(method)) {
                if (next.size <= 1) {
                    toast.error("At least one payment method must be enabled");
                    return prev;
                }
                next.delete(method);
                if (defaultMethod === method) setDefaultMethod(Array.from(next)[0] as MethodKey);
            } else {
                next.add(method);
            }
            return next;
        });
    };

    // --- Save methods ---
    const saveMethods = async () => {
        setSavingMethods(true);
        try {
            const res = await fetch("/api/settings/payment-methods", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ enabledMethods: Array.from(enabledMethods), defaultMethod }),
            });
            if (res.ok) { toast.success("Payment methods saved"); await loadAll(); }
            else { const e = await res.json() as any; toast.error(e.error || "Save failed"); }
        } catch { toast.error("Error saving payment methods"); }
        finally { setSavingMethods(false); }
    };

    // --- Save Stripe ---
    const saveStripe = async () => {
        setSavingStripe(true);
        try {
            const res = await fetch("/api/settings/stripe", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(stripe),
            });
            if (res.ok) { toast.success("Stripe settings saved"); await loadAll(); }
            else { const e = await res.json() as any; toast.error(e.message || "Save failed"); }
        } catch { toast.error("Error saving Stripe settings"); }
        finally { setSavingStripe(false); }
    };

    // --- Save SSLCommerz ---
    const saveSsl = async () => {
        setSavingSsl(true);
        try {
            const res = await fetch("/api/settings/sslcommerz", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(ssl),
            });
            if (res.ok) { toast.success("SSLCommerz settings saved"); await loadAll(); }
            else { const e = await res.json() as any; toast.error(e.message || "Save failed"); }
        } catch { toast.error("Error saving SSLCommerz settings"); }
        finally { setSavingSsl(false); }
    };

    // --- Status helpers ---
    const stripeStatus = methods?.gatewayStatus.stripe;
    const sslStatus = methods?.gatewayStatus.sslcommerz;

    const getStatusBadge = (method: MethodKey) => {
        if (method === "cod") {
            return enabledMethods.has("cod") ? (
                <Badge variant="default" className="text-xs gap-1"><CheckCircle2 className="h-3 w-3" /> Active</Badge>
            ) : (
                <Badge variant="secondary" className="text-xs">Inactive</Badge>
            );
        }
        if (method === "stripe") {
            if (!stripeStatus?.configured) return <Badge variant="outline" className="text-xs text-muted-foreground">No credentials</Badge>;
            if (!enabledMethods.has("stripe")) return <Badge variant="secondary" className="text-xs">Inactive</Badge>;
            const isLive = stripe.secretKey && stripe.secretKey !== MASKED_VALUE && stripe.secretKey.startsWith("sk_live_");
            return <Badge variant="default" className="text-xs gap-1"><CheckCircle2 className="h-3 w-3" />{isLive ? "Live" : "Test"}</Badge>;
        }
        if (method === "sslcommerz") {
            if (!sslStatus?.configured) return <Badge variant="outline" className="text-xs text-muted-foreground">No credentials</Badge>;
            if (!enabledMethods.has("sslcommerz")) return <Badge variant="secondary" className="text-xs">Inactive</Badge>;
            return <Badge variant="default" className="text-xs gap-1"><CheckCircle2 className="h-3 w-3" />{ssl.sandbox ? "Sandbox" : "Live"}</Badge>;
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

    const allMethods: MethodKey[] = ["stripe", "sslcommerz", "cod"];

    return (
        <div className="space-y-6 max-w-4xl">

            {/* ─── Section 1: Active payment methods ─── */}
            <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/5">
                    <div>
                        <h2 className="font-semibold text-sm">Active on Storefront</h2>
                        <p className="text-xs text-muted-foreground mt-0.5">Toggle which methods customers see at checkout</p>
                    </div>
                    <Button size="sm" onClick={saveMethods} disabled={savingMethods}>
                        {savingMethods ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                        Save
                    </Button>
                </div>

                <div className="divide-y divide-border">
                    {allMethods.map((method) => {
                        const meta = METHOD_META[method];
                        const Icon = meta.icon;
                        const isEnabled = enabledMethods.has(method);
                        const hasNoCredentials = method !== "cod" && !(method === "stripe" ? stripeStatus?.configured : sslStatus?.configured);

                        return (
                            <div key={method} className={`flex items-center gap-4 px-5 py-3.5 transition-colors ${isEnabled ? "" : "opacity-60"}`}>
                                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${isEnabled ? meta.bg : "bg-muted"}`}>
                                    <Icon className={`h-4 w-4 ${isEnabled ? meta.color : "text-muted-foreground"}`} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium">{meta.label}</span>
                                        {getStatusBadge(method)}
                                        {isEnabled && hasNoCredentials && (
                                            <Badge variant="destructive" className="text-xs gap-1">
                                                <AlertTriangle className="h-3 w-3" /> No credentials
                                            </Badge>
                                        )}
                                    </div>
                                    <p className="text-xs text-muted-foreground">{meta.desc}</p>
                                </div>
                                <Switch
                                    checked={isEnabled}
                                    onCheckedChange={() => toggleMethod(method)}
                                    aria-label={`Enable ${meta.label}`}
                                />
                            </div>
                        );
                    })}
                </div>

                <div className="flex items-center gap-4 px-5 py-3.5 border-t border-border bg-muted/5">
                    <span className="text-sm text-muted-foreground">Default at checkout</span>
                    <Select value={defaultMethod} onValueChange={(v) => setDefaultMethod(v as MethodKey)}>
                        <SelectTrigger className="h-8 w-44 text-sm">
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
                </div>
            </div>

            {/* ─── Section 2: Credential configuration ─── */}
            <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
                <div className="px-5 py-4 border-b border-border bg-muted/5">
                    <h2 className="font-semibold text-sm">Gateway Credentials</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">Stored securely in the database — never in environment variables</p>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-border">
                    {(["stripe", "sslcommerz", "cod"] as const).map((tab) => {
                        const meta = METHOD_META[tab];
                        const Icon = meta.icon;
                        const isActive = credTab === tab;
                        return (
                            <button
                                key={tab}
                                onClick={() => setCredTab(tab)}
                                className={`flex items-center gap-2 px-5 py-3 text-sm border-b-2 transition-colors ${isActive
                                    ? "border-primary text-foreground font-medium"
                                    : "border-transparent text-muted-foreground hover:text-foreground"
                                    }`}
                            >
                                <Icon className="h-3.5 w-3.5" />
                                {meta.label}
                            </button>
                        );
                    })}
                </div>

                {/* Stripe credentials */}
                {credTab === "stripe" && (
                    <div className="p-5 space-y-5">
                        {/* Enable toggle */}
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-medium">Enable Stripe</p>
                                <p className="text-xs text-muted-foreground">Toggle Stripe as active payment method</p>
                            </div>
                            <Switch
                                checked={stripe.enabled}
                                onCheckedChange={(v) => setStripe((s) => ({ ...s, enabled: v }))}
                            />
                        </div>

                        <Separator />

                        {/* Credential fields in a compact grid */}
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
                                <p className="text-xs text-muted-foreground">Safe to expose to browser</p>
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
                                    Add endpoint <code className="text-xs bg-muted px-1 rounded">/api/v1/webhooks/stripe</code> in{" "}
                                    <a href="https://dashboard.stripe.com/webhooks" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                                        Stripe webhooks <ExternalLink className="h-2.5 w-2.5" />
                                    </a>
                                </p>
                            </div>
                        </div>

                        {stripe.secretKey && stripe.secretKey !== MASKED_VALUE && stripe.secretKey.startsWith("sk_live_") && (
                            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                                <span><strong>Live key detected.</strong> Real cards will be charged.</span>
                            </div>
                        )}

                        <div className="flex justify-end">
                            <Button onClick={saveStripe} disabled={savingStripe} size="sm">
                                {savingStripe ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                                Save Stripe
                            </Button>
                        </div>
                    </div>
                )}

                {/* SSLCommerz credentials */}
                {credTab === "sslcommerz" && (
                    <div className="p-5 space-y-5">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-medium">Enable SSLCommerz</p>
                                <p className="text-xs text-muted-foreground">Toggle SSLCommerz as active payment method</p>
                            </div>
                            <Switch
                                checked={ssl.enabled}
                                onCheckedChange={(v) => setSsl((s) => ({ ...s, enabled: v }))}
                            />
                        </div>

                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-medium">Sandbox Mode</p>
                                <p className="text-xs text-muted-foreground">Use test credentials (disable in production)</p>
                            </div>
                            <Switch
                                checked={ssl.sandbox}
                                onCheckedChange={(v) => setSsl((s) => ({ ...s, sandbox: v }))}
                            />
                        </div>

                        {!ssl.sandbox && (
                            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                                <span><strong>Live mode.</strong> Real transactions will be processed.</span>
                            </div>
                        )}

                        <Separator />

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
                                <p className="text-xs text-muted-foreground">
                                    <a href="https://dashboard.sslcommerz.com" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                                        dashboard.sslcommerz.com <ExternalLink className="h-2.5 w-2.5" />
                                    </a>
                                </p>
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
                                <p className="text-xs text-muted-foreground">Webhook: <code className="text-xs bg-muted px-1 rounded">/api/v1/webhooks/sslcommerz</code></p>
                            </div>
                        </div>

                        <div className="flex justify-end">
                            <Button onClick={saveSsl} disabled={savingSsl} size="sm">
                                {savingSsl ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                                Save SSLCommerz
                            </Button>
                        </div>
                    </div>
                )}

                {/* COD — no credentials */}
                {credTab === "cod" && (
                    <div className="p-5">
                        <div className="flex items-start gap-3 rounded-lg bg-muted/40 border border-border px-5 py-4">
                            <Info className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                            <div>
                                <p className="text-sm font-medium">No credentials required</p>
                                <p className="text-sm text-muted-foreground mt-1">
                                    Cash on Delivery doesn't require any API keys or external setup. 
                                    Toggle it active/inactive using the switch in the <strong>Active on Storefront</strong> section above.
                                </p>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
