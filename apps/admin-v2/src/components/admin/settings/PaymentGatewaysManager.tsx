// src/components/admin/settings/PaymentGatewaysManager.tsx
// Accordion-based payment gateway management with lazy-loaded credentials.

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getStripeCredentialEnvironment } from "@scalius/shared/payment-gateway-environment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import {
    Loader2, CheckCircle2, ChevronDown, Zap, AlertTriangle, RefreshCw,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Accordion, AccordionItem, AccordionContent } from "@/components/ui/accordion";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import {
    type MethodKey,
    type PaymentMethodsData,
    type StripeData,
    type SSLCommerzData,
    type PolarData,
    META,
    MASKED,
    PasswordInput,
    LiveWarning,
    SaveBtn,
    SandboxToggle,
    ExtLink,
} from "./payment-gateway-utils";
import {
    getEligibleDefaultPaymentMethods,
    getPaymentMethodFlowEligibility,
    getPaymentMethodFlowExclusionReason,
    getPaymentMethodOutcome,
    type PaymentMethodEnvironment,
    type PaymentMethodOutcome,
} from "./payment-method-outcome";
import {
    polarDraftIsDirty,
    sslCommerzDraftIsDirty,
    stripeDraftIsDirty,
} from "./payment-gateway-draft";
import { PolarForm, PolarSetupGuide } from "./PolarSettingsForm";
import { UnsavedChangesGuard } from "@/components/admin/shared/UnsavedChangesGuard";
import { getServerFnError } from "@/lib/api-helpers";
import { getSettingsLoadErrorMessage } from "@/hooks/use-settings-form";
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

function OutcomeBadge({ outcome }: { outcome: PaymentMethodOutcome }) {
    if (outcome.state === "visible") {
        return (
            <Badge className="gap-1 border-0 bg-emerald-500/10 text-xs text-emerald-700 shadow-none hover:bg-emerald-500/15 dark:text-emerald-300">
                <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                {outcome.label}
            </Badge>
        );
    }
    if (outcome.state === "blocked" || outcome.state === "needs_setup") {
        return (
            <Badge variant={outcome.state === "blocked" ? "destructive" : "outline"} className="gap-1 text-xs">
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                {outcome.label}
            </Badge>
        );
    }
    if (outcome.state === "hidden_by_flow") {
        return <Badge variant="outline" className="border-amber-500/40 text-xs text-amber-700 dark:text-amber-300">{outcome.label}</Badge>;
    }
    if (outcome.state === "flow_unknown") {
        return <Badge variant="outline" className="border-amber-500/40 text-xs text-amber-700 dark:text-amber-300">{outcome.label}</Badge>;
    }
    return <Badge variant="secondary" className="text-xs">{outcome.label}</Badge>;
}

export default function PaymentGatewaysManager() {
    const queryClient = useQueryClient();
    const {
        data: checkoutFlowSettings,
        isError: checkoutFlowError,
        error: checkoutFlowQueryError,
        isFetching: checkoutFlowFetching,
        refetch: refetchCheckoutFlow,
    } = useQuery(checkoutFlowSettingsQueryOptions());
    const [loading, setLoading] = useState(true);
    const [methodsLoadError, setMethodsLoadError] = useState<string | null>(null);
    const [methods, setMethods] = useState<PaymentMethodsData | null>(null);
    const [enabledMethods, setEnabledMethods] = useState<Set<MethodKey>>(new Set(["cod"]));
    const [defaultMethod, setDefaultMethod] = useState<MethodKey>("cod");
    const [savingMethods, setSavingMethods] = useState(false);

    const [stripe, setStripe] = useState<StripeData>({ secretKey: "", publishableKey: "", webhookSecret: "", enabled: false });
    const [savedStripe, setSavedStripe] = useState<StripeData | null>(null);
    const [stripeConf, setStripeConf] = useState({ secret: false, webhook: false });
    const [savingStripe, setSavingStripe] = useState(false);

    const [ssl, setSsl] = useState<SSLCommerzData>({ storeId: "", storePassword: "", sandbox: true, enabled: false });
    const [savedSsl, setSavedSsl] = useState<SSLCommerzData | null>(null);
    const [sslConf, setSslConf] = useState({ password: false });
    const [savingSsl, setSavingSsl] = useState(false);

    const [polar, setPolar] = useState<PolarData>({ accessToken: "", webhookSecret: "", productId: "", sandbox: true, enabled: false });
    const [savedPolar, setSavedPolar] = useState<PolarData | null>(null);
    const [polarConf, setPolarConf] = useState({ token: false, webhook: false });
    const [savingPolar, setSavingPolar] = useState(false);

    const [showPolarHelp, setShowPolarHelp] = useState(false);
    const loadedGateways = useRef<Set<string>>(new Set());
    const [loadingGw, setLoadingGw] = useState<string | null>(null);
    const [gatewayLoadErrors, setGatewayLoadErrors] = useState<Partial<Record<MethodKey, string>>>({});
    const [expanded, setExpanded] = useState<string[]>([]);

    // Load only payment-methods on mount (1 API call)
    const loadMethods = useCallback(async (showInitialLoader = true, notifyOnError = true, preserveDraft = false) => {
        if (showInitialLoader) setLoading(true);
        setMethodsLoadError(null);
        try {
            const d = await getPaymentMethods() as PaymentMethodsData;
            setMethods(d);
            if (!preserveDraft) {
                setEnabledMethods(new Set(d.enabledMethods));
                setDefaultMethod(d.defaultMethod);
            }
            return true;
        } catch (err) {
            const message = getServerFnError(err, "Failed to load payment settings");
            if (showInitialLoader) setMethods(null);
            setMethodsLoadError(message);
            if (notifyOnError) toast.error(message);
            return false;
        }
        finally {
            if (showInitialLoader) setLoading(false);
        }
    }, []);

    useEffect(() => { void loadMethods(); }, [loadMethods]);

    // Lazy-load gateway credentials on accordion expand
    const loadCreds = useCallback(async (gw: MethodKey, force = false, notifyOnError = true) => {
        if (gw === "cod" || (loadedGateways.current.has(gw) && !force)) return true;
        setLoadingGw(gw);
        setGatewayLoadErrors((prev) => {
            const next = { ...prev };
            delete next[gw];
            return next;
        });
        try {
            const d = await getPaymentGatewaySettings({ data: { gateway: gw } }) as Record<string, unknown>;
            if (gw === "stripe") {
                const sd = d as unknown as StripeData;
                setStripe(sd); setSavedStripe({ ...sd }); setStripeConf({ secret: !!sd.secretKey, webhook: !!sd.webhookSecret });
            } else if (gw === "sslcommerz") {
                const sd = d as unknown as SSLCommerzData;
                setSsl(sd); setSavedSsl({ ...sd }); setSslConf({ password: !!sd.storePassword });
            } else if (gw === "polar") {
                const sd = d as unknown as PolarData;
                setPolar(sd); setSavedPolar({ ...sd }); setPolarConf({ token: !!sd.accessToken, webhook: !!sd.webhookSecret });
            }
            loadedGateways.current.add(gw);
            return true;
        } catch (err) {
            loadedGateways.current.delete(gw);
            const message = getSettingsLoadErrorMessage(
                err,
                `Failed to load ${META[gw].label} settings. Existing credentials were not changed.`,
            );
            setGatewayLoadErrors((prev) => ({ ...prev, [gw]: message }));
            if (notifyOnError) toast.error(message);
            return false;
        }
        finally { setLoadingGw(null); }
    }, []);

    const handleAccordion = (vals: string[]) => {
        setExpanded(vals);
        for (const v of vals) {
            if (v !== "cod" && !loadedGateways.current.has(v)) void loadCreds(v as MethodKey);
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
        if (loading || !methods || methodsLoadError || !checkoutFlowSettings) {
            const message = !checkoutFlowSettings
                ? "Reload checkout flow before saving buyer payment methods."
                : "Reload payment status before saving buyer payment methods.";
            if (!silent) toast.error(message);
            return false;
        }
        setSavingMethods(true);
        try {
            const nextEnabledMethods = Array.from(enabledMethods);
            await updatePaymentMethods({ data: { enabledMethods: nextEnabledMethods, defaultMethod } });
            setMethods((current) => current
                ? { ...current, enabledMethods: nextEnabledMethods, defaultMethod }
                : current);
            await queryClient.invalidateQueries({ queryKey: queryKeys.settings.paymentMethods() });
            await queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutFlow() });
            const refreshed = await loadMethods(false, false);
            if (!silent) {
                if (refreshed) toast.success("Buyer payment methods saved");
                else toast.warning("Payment methods were saved, but their current status could not be refreshed.");
            }
            return refreshed;
        } catch (err) {
            if (!silent) toast.error(getServerFnError(err, "Error saving payment methods"));
            else throw err;
            return false;
        }
        finally { setSavingMethods(false); }
    };

    const saveGw = async (gw: MethodKey, body: object, setSaving: (v: boolean) => void) => {
        if (gw !== "cod" && !loadedGateways.current.has(gw)) {
            toast.error(`Load ${META[gw].label} settings before saving.`);
            return;
        }
        setSaving(true);
        try {
            await updatePaymentGatewaySettings({ data: { gateway: gw, settings: body as unknown as SettingsPayload } });
            if (gw === "stripe") {
                const committed = {
                    ...stripe,
                    secretKey: (stripe.secretKey.trim() || stripeConf.secret) ? MASKED : "",
                    publishableKey: stripe.publishableKey.trim(),
                    webhookSecret: (stripe.webhookSecret.trim() || stripeConf.webhook) ? MASKED : "",
                };
                setStripe(committed);
                setSavedStripe({ ...committed });
                setStripeConf({ secret: Boolean(committed.secretKey), webhook: Boolean(committed.webhookSecret) });
            } else if (gw === "sslcommerz") {
                const committed = {
                    ...ssl,
                    storeId: ssl.storeId.trim(),
                    storePassword: (ssl.storePassword.trim() || sslConf.password) ? MASKED : "",
                };
                setSsl(committed);
                setSavedSsl({ ...committed });
                setSslConf({ password: Boolean(committed.storePassword) });
            } else if (gw === "polar") {
                const committed = {
                    ...polar,
                    accessToken: (polar.accessToken.trim() || polarConf.token) ? MASKED : "",
                    webhookSecret: (polar.webhookSecret.trim() || polarConf.webhook) ? MASKED : "",
                    productId: polar.productId.trim(),
                };
                setPolar(committed);
                setSavedPolar({ ...committed });
                setPolarConf({ token: Boolean(committed.accessToken), webhook: Boolean(committed.webhookSecret) });
            }
            await queryClient.invalidateQueries({ queryKey: queryKeys.settings.paymentMethods() });
            await queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutFlow() });
            loadedGateways.current.delete(gw);
            const [methodsRefreshed, credentialsRefreshed] = await Promise.all([
                loadMethods(false, false, true),
                loadCreds(gw, false, false),
            ]);
            if (methodsRefreshed && credentialsRefreshed) toast.success(`${META[gw].label} settings saved`);
            else toast.warning(`${META[gw].label} was saved, but its current checkout status could not be refreshed.`);
        } catch (err) {
            toast.error(getServerFnError(err, `Error saving ${META[gw].label} settings`));
        }
        finally { setSaving(false); }
    };

    const methodAllowedByFlow = useCallback((method: MethodKey) => {
        if (!checkoutFlowSettings) return undefined;
        return getPaymentMethodFlowEligibility(method, {
            checkoutMode: checkoutFlowSettings.checkoutMode,
            partialPaymentEnabled: checkoutFlowSettings.partialPaymentEnabled === true,
            partialPaymentAmount: checkoutFlowSettings.partialPaymentAmount ?? 0,
        });
    }, [checkoutFlowSettings]);

    const getFlowHiddenReason = useCallback((method: MethodKey) => {
        if (!checkoutFlowSettings) return null;
        return getPaymentMethodFlowExclusionReason(method, {
            checkoutMode: checkoutFlowSettings.checkoutMode,
            partialPaymentEnabled: checkoutFlowSettings.partialPaymentEnabled === true,
            partialPaymentAmount: checkoutFlowSettings.partialPaymentAmount ?? 0,
        });
    }, [checkoutFlowSettings]);

    const defaultOptions = useMemo(() => methods
        ? getEligibleDefaultPaymentMethods({
            methods: ALL_METHODS,
            statuses: methods.gatewayStatus,
            selectedMethods: enabledMethods,
            flowAllowed: methodAllowedByFlow,
        })
        : [], [enabledMethods, methodAllowedByFlow, methods]);

    useEffect(() => {
        if (defaultOptions.length > 0 && !defaultOptions.includes(defaultMethod)) {
            setDefaultMethod(defaultOptions[0]);
        }
    }, [defaultMethod, defaultOptions]);

    if (loading) return <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground" role="status" aria-live="polite"><Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />Loading payment settings…</div>;

    if (!methods) {
        return (
            <Card className="max-w-4xl border-amber-200 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20">
                <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base font-semibold text-amber-950 dark:text-amber-100">
                        <AlertTriangle className="h-4 w-4" />
                        Payment settings could not be loaded
                    </CardTitle>
                    <CardDescription className="text-amber-900/80 dark:text-amber-200/80">
                        Checkout visibility is locked until the saved payment-method settings load successfully.
                    </CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                    <p className="rounded-md border border-amber-200/70 bg-background/70 px-3 py-2 text-sm text-amber-950 dark:border-amber-900/50 dark:text-amber-100">
                        {methodsLoadError ?? "Reload payment settings before changing checkout visibility."}
                    </p>
                </CardContent>
                <CardFooter className="justify-end">
                    <Button type="button" variant="secondary" size="sm" onClick={() => void loadMethods()}>
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                        Retry
                    </Button>
                </CardFooter>
            </Card>
        );
    }

    const getSavedEnvironment = (method: MethodKey): PaymentMethodEnvironment | undefined => {
        if (method === "cod") return "not_applicable";
        if (!loadedGateways.current.has(method)) return undefined;
        if (method === "stripe") return getStripeCredentialEnvironment(stripe);
        if (method === "sslcommerz") return ssl.sandbox ? "test" : "live";
        return polar.sandbox ? "test" : "live";
    };
    const getMethodOutcome = (method: MethodKey) => getPaymentMethodOutcome({
        method,
        status: methods.gatewayStatus[method],
        checkoutSelected: enabledMethods.has(method),
        flowAllowed: methodAllowedByFlow(method),
        environment: getSavedEnvironment(method),
    });
    const defaultMethodAvailable = defaultOptions.includes(defaultMethod);
    const canSaveMethods = Boolean(checkoutFlowSettings)
        && !methodsLoadError
        && defaultOptions.length > 0
        && defaultMethodAvailable;
    const savedEnabledMethods = new Set(methods.enabledMethods);
    const enabledMethodsChanged = ALL_METHODS.some((method) => (
        enabledMethods.has(method) !== savedEnabledMethods.has(method)
    ));
    const methodsDirty = enabledMethodsChanged || defaultMethod !== methods.defaultMethod;
    const stripeDirty = loadedGateways.current.has("stripe") && stripeDraftIsDirty(stripe, savedStripe);
    const sslDirty = loadedGateways.current.has("sslcommerz") && sslCommerzDraftIsDirty(ssl, savedSsl);
    const polarDirty = loadedGateways.current.has("polar") && polarDraftIsDirty(polar, savedPolar);
    const anyGatewayDirty = stripeDirty || sslDirty || polarDirty;
    const anySavePending = savingMethods || savingStripe || savingSsl || savingPolar;
    const resetMethods = () => {
        setEnabledMethods(new Set(methods.enabledMethods));
        setDefaultMethod(methods.defaultMethod);
    };

    return (
        <>
        <UnsavedChangesGuard isDirty={methodsDirty || anyGatewayDirty} isSubmitting={anySavePending} />
        <div className="max-w-4xl space-y-4">
            {!checkoutFlowSettings && (
                <Alert className={checkoutFlowError ? "border-amber-500/30 bg-amber-500/5" : undefined}>
                    {checkoutFlowError
                        ? <AlertTriangle className="h-4 w-4 text-amber-500" />
                        : <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    <AlertTitle>{checkoutFlowError ? "Checkout flow could not be loaded" : "Checking checkout flow"}</AlertTitle>
                    <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <span>
                            {checkoutFlowError
                                ? checkoutFlowQueryError instanceof Error
                                    ? checkoutFlowQueryError.message
                                    : "Buyer visibility cannot be confirmed until the saved checkout flow loads."
                                : "Buyer visibility and payment-method saves stay locked until the saved flow is known."}
                        </span>
                        {checkoutFlowError && (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="shrink-0"
                                onClick={() => void refetchCheckoutFlow()}
                                disabled={checkoutFlowFetching}
                            >
                                {checkoutFlowFetching && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                                Retry flow check
                            </Button>
                        )}
                    </AlertDescription>
                </Alert>
            )}
            {methodsLoadError && methods && (
                <Alert className="border-amber-500/30 bg-amber-500/5">
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                    <AlertTitle>Payment status needs a refresh</AlertTitle>
                    <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <span>
                            The last loaded workspace is preserved, but saves are locked because current provider status could not be confirmed.
                        </span>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            onClick={() => void loadMethods(false, true, true)}
                        >
                            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                            Refresh status
                        </Button>
                    </AlertDescription>
                </Alert>
            )}
            <Card>
                <CardHeader className="p-4 pb-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="text-base font-semibold">Buyer payment methods</CardTitle>
                        <Badge variant={methodsLoadError || methodsDirty ? "outline" : "secondary"} className="text-xs">
                            {methodsLoadError ? "Refresh needed" : methodsDirty ? "Unsaved" : "Saved"}
                        </Badge>
                    </div>
                    <CardDescription>
                        Choose which setup-complete, provider-enabled methods buyers can use. Card results preview this draft until you save.
                    </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2 px-4 pb-4 sm:grid-cols-[minmax(0,1fr)_15rem] sm:items-center">
                    <div>
                        <Label htmlFor="default-payment-method">Default buyer selection</Label>
                        <p className="mt-0.5 text-xs text-muted-foreground">Only setup-complete, provider-enabled methods allowed by the saved checkout flow appear here.</p>
                    </div>
                    <Select
                        value={defaultMethodAvailable ? defaultMethod : undefined}
                        onValueChange={(value) => setDefaultMethod(value as MethodKey)}
                        disabled={defaultOptions.length === 0 || Boolean(methodsLoadError) || !checkoutFlowSettings}
                    >
                        <SelectTrigger id="default-payment-method" className="h-9 w-full"><SelectValue placeholder="No eligible method" /></SelectTrigger>
                        <SelectContent>
                            {defaultOptions.map((method) => (
                                <SelectItem key={method} value={method} className="text-sm">{META[method].label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </CardContent>
                {!canSaveMethods && !methodsLoadError && checkoutFlowSettings && (
                    <div className="mx-4 mb-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>Select at least one setup-complete, provider-enabled method allowed by the current checkout flow.</span>
                    </div>
                )}
                <CardFooter className="justify-between gap-2 border-t px-4 py-3">
                    <Button type="button" variant="ghost" size="sm" onClick={resetMethods} disabled={!methodsDirty || savingMethods}>
                        Reset
                    </Button>
                    <Button type="button" size="sm" onClick={() => void saveMethods()} disabled={savingMethods || !canSaveMethods || !methodsDirty}>
                        {savingMethods && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                        Save payment methods
                    </Button>
                </CardFooter>
            </Card>

            <Accordion type="multiple" value={expanded} onValueChange={handleAccordion}>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    {ALL_METHODS.map((method) => {
                        const meta = META[method];
                        const isOpen = expanded.includes(method);
                        const selected = enabledMethods.has(method);
                        const outcome = getMethodOutcome(method);
                        const gatewayLoaded = method === "cod" || loadedGateways.current.has(method);
                        const gatewayLoadError = gatewayLoadErrors[method];
                        const gatewayNotice = outcome.state === "hidden_by_flow"
                            ? getFlowHiddenReason(method) ?? outcome.description
                            : outcome.state === "visible" || outcome.state === "ready_hidden"
                                ? null
                                : outcome.description;
                        const toggleDisabled = !selected && !outcome.canSelect;
                        return (
                            <AccordionItem key={method} value={method} className={`border rounded-lg overflow-hidden ${meta.borderColor}`}>
                                <div className={`p-3.5 ${meta.headerBg}`}>
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="flex min-w-0 items-start gap-3">
                                            <meta.Mark />
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <h3 className="text-sm font-medium">{meta.label}</h3>
                                                    <OutcomeBadge outcome={outcome} />
                                                </div>
                                                <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{meta.desc}</p>
                                                <dl className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] leading-4">
                                                    <div className="flex items-center gap-1">
                                                        <dt className="text-muted-foreground">Setup</dt>
                                                        <dd className={outcome.setupLabel === "Required" ? "font-medium text-destructive" : "font-medium text-foreground"}>
                                                            {outcome.setupLabel}
                                                        </dd>
                                                    </div>
                                                    <div className="flex items-center gap-1">
                                                        <dt className="text-muted-foreground">Provider</dt>
                                                        <dd className={outcome.providerLabel === "Off" ? "font-medium text-muted-foreground" : "font-medium text-foreground"}>
                                                            {outcome.providerLabel}
                                                        </dd>
                                                    </div>
                                                    <div className="flex items-center gap-1">
                                                        <dt className="text-muted-foreground">Checkout</dt>
                                                        <dd className={outcome.effective ? "font-medium text-emerald-700 dark:text-emerald-300" : "font-medium text-muted-foreground"}>
                                                            {outcome.checkoutLabel}
                                                        </dd>
                                                    </div>
                                                    <div className="flex items-center gap-1">
                                                        <dt className="text-muted-foreground">Environment</dt>
                                                        <dd className="font-medium text-foreground">{outcome.environmentLabel}</dd>
                                                    </div>
                                                    <div className="flex items-center gap-1">
                                                        <dt className="text-muted-foreground">Connection</dt>
                                                        <dd className="font-medium text-muted-foreground">{outcome.healthLabel}</dd>
                                                    </div>
                                                </dl>
                                                {method !== "cod" && outcome.healthLabel === "Not checked" && (
                                                    <span className="sr-only">No provider connection health check is available.</span>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex shrink-0 flex-col items-end gap-1">
                                            <Switch
                                                id={`toggle-${method}`}
                                                checked={enabledMethods.has(method)}
                                                aria-label={`Show ${meta.label} at checkout`}
                                                disabled={toggleDisabled || Boolean(methodsLoadError) || !checkoutFlowSettings}
                                                onCheckedChange={(v) => toggleMethod(method, v)}
                                            />
                                            <Label htmlFor={`toggle-${method}`} className="max-w-20 cursor-pointer text-right text-[11px] font-normal leading-3 text-muted-foreground">Offer to buyers</Label>
                                        </div>
                                    </div>
                                    {gatewayNotice && (
                                        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/25 bg-background/80 px-3 py-2 text-xs text-foreground">
                                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                            <span>{gatewayNotice}</span>
                                        </div>
                                    )}
                                </div>
                                {method !== "cod" && (
                                    <AccordionPrimitive.Header className="flex">
                                        <AccordionPrimitive.Trigger className="flex min-h-11 w-full cursor-pointer items-center justify-center gap-1.5 border-t border-border/50 text-xs text-muted-foreground transition-colors hover:text-foreground [&[data-state=open]>svg]:rotate-180">
                                            {isOpen ? "Hide" : "Configure"} credentials
                                            <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200" />
                                        </AccordionPrimitive.Trigger>
                                    </AccordionPrimitive.Header>
                                )}
                                {method !== "cod" && (
                                    <AccordionContent className="px-4 pb-4">
                                        {loadingGw === method ? (
                                            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading {meta.label} setup…</div>
                                        ) : gatewayLoadError ? (
                                            <Alert variant="destructive" className="mt-3">
                                                <AlertTriangle className="h-4 w-4" />
                                                <AlertTitle>Gateway settings unavailable</AlertTitle>
                                                <AlertDescription className="space-y-3">
                                                    <p>{gatewayLoadError}</p>
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => void loadCreds(method, true)}
                                                    >
                                                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                                                        Retry
                                                    </Button>
                                                </AlertDescription>
                                            </Alert>
                                        ) : !gatewayLoaded ? (
                                            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading {meta.label} setup…</div>
                                        ) : method === "stripe" ? (
                                            <StripeForm s={stripe} set={setStripe} conf={stripeConf} saving={savingStripe} dirty={stripeDirty}
                                                onReset={() => savedStripe && setStripe({ ...savedStripe })}
                                                onSave={() => saveGw("stripe", stripe, setSavingStripe)} />
                                        ) : method === "sslcommerz" ? (
                                            <SSLForm s={ssl} set={setSsl} conf={sslConf} saving={savingSsl} dirty={sslDirty}
                                                onReset={() => savedSsl && setSsl({ ...savedSsl })}
                                                onSave={() => saveGw("sslcommerz", ssl, setSavingSsl)} />
                                        ) : method === "polar" ? (
                                            <PolarForm s={polar} set={setPolar} conf={polarConf} saving={savingPolar} dirty={polarDirty}
                                                onReset={() => savedPolar && setPolar({ ...savedPolar })}
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
        </>
    );
}

// --- Inline Form Sub-Components (Stripe & SSL kept inline as they're small) ---

function StripeForm({ s, set, conf, saving, dirty, onReset, onSave }: {
    s: StripeData; set: React.Dispatch<React.SetStateAction<StripeData>>;
    conf: { secret: boolean; webhook: boolean }; saving: boolean; dirty: boolean; onReset: () => void; onSave: () => void;
}) {
    const keyEnvironment = getStripeCredentialEnvironment(s);
    const environmentLabel = keyEnvironment === "mixed"
        ? "Key mismatch"
        : keyEnvironment === "test"
            ? "Test mode"
            : keyEnvironment === "live"
                ? "Live mode"
                : "Not detected";
    return (
        <form method="post" onSubmit={(e) => { e.preventDefault(); if (dirty && !saving) onSave(); }} className="space-y-3 pt-2" noValidate>
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
                <div className="flex min-h-6 items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>Key environment</span>
                    <Badge
                        variant={keyEnvironment === "mixed" ? "destructive" : "outline"}
                        className="h-5 rounded px-1.5 text-xs font-medium"
                    >
                        {environmentLabel}
                    </Badge>
                </div>
            </div>
            <div className="space-y-1.5">
                <Label htmlFor="stripe-wh" className="flex items-center gap-1.5 text-sm">
                    Webhook Secret {conf.webhook && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
                </Label>
                <PasswordInput id="stripe-wh" value={s.webhookSecret} onChange={(v) => set((p) => ({ ...p, webhookSecret: v }))}
                    placeholder="whsec_..." configured={conf.webhook} />
                <p className="text-xs text-muted-foreground">Add endpoint <code className="text-xs bg-muted px-1 rounded">/api/v1/webhooks/stripe</code> in Stripe webhooks.</p>
            </div>
            {keyEnvironment === "live" && s.enabled && (
                <LiveWarning message="Live mode enabled. Real cards will be charged." />
            )}
            <SaveBtn saving={saving} dirty={dirty} onReset={onReset} label="Save Stripe" />
        </form>
    );
}

function SSLForm({ s, set, conf, saving, dirty, onReset, onSave }: {
    s: SSLCommerzData; set: React.Dispatch<React.SetStateAction<SSLCommerzData>>;
    conf: { password: boolean }; saving: boolean; dirty: boolean; onReset: () => void; onSave: () => void;
}) {
    return (
        <form method="post" onSubmit={(e) => { e.preventDefault(); if (dirty && !saving) onSave(); }} className="space-y-3 pt-2" noValidate>
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
            <SandboxToggle id="ssl-sandbox" checked={s.sandbox} onChange={(v) => set((p) => ({ ...p, sandbox: v }))} />
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
            <SaveBtn saving={saving} dirty={dirty} onReset={onReset} label="Save SSLCommerz" />
        </form>
    );
}
