// src/components/admin/settings/PaymentGatewaysManager.tsx
// Gateway index table plus a lazy-loaded credential editor per provider.

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getStripeCredentialEnvironment } from "@scalius/shared/payment-gateway-environment";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { Badge } from "~/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { toast } from "sonner";
import {
    Loader2, CheckCircle2, Zap, AlertTriangle, RefreshCw,
    ArrowUp, ArrowDown, CreditCard, MoreHorizontal, Settings2,
} from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "~/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import {
    ContextualSaveBar,
    EmptyState,
    IndexTable,
    InlineHelp,
    SettingsSection,
    SkeletonPage,
    StatusBadge,
    type IndexTableColumn,
    type StatusTone,
} from "~/components/admin/shell";

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
import { getServerFnError } from "~/lib/api-helpers";
import { getSettingsLoadErrorMessage } from "~/hooks/use-settings-form";
import { queryKeys } from "~/lib/query-keys";
import { checkoutFlowSettingsQueryOptions } from "~/lib/api-query-options/settings";
import { currencySettingsQueryOptions } from "~/lib/api-query-options/currency";
import {
    getPaymentMethods,
    updatePaymentMethods,
    getPaymentGatewaySettings,
    type SettingsPayload,
    updatePaymentGatewaySettings,
} from "~/lib/api-functions/settings";

// --- Main Component ---

const ALL_METHODS: MethodKey[] = ["stripe", "sslcommerz", "polar", "cod"];

/**
 * Buyer-visible outcome to badge tone. The label always names the state, so the
 * colour is only a second signal.
 */
const OUTCOME_TONES: Record<PaymentMethodOutcome["state"], StatusTone> = {
    visible: "success",
    ready_hidden: "neutral",
    hidden_by_flow: "attention",
    flow_unknown: "attention",
    provider_off: "neutral",
    needs_setup: "warning",
    blocked: "critical",
};

function OutcomeBadge({ outcome }: { outcome: PaymentMethodOutcome }) {
    return (
        <StatusBadge tone={OUTCOME_TONES[outcome.state]} srLabel="Buyer checkout:">
            {outcome.label}
        </StatusBadge>
    );
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
    const {
        data: currencySettings,
        isError: currencySettingsError,
        isFetching: currencySettingsFetching,
        refetch: refetchCurrencySettings,
    } = useQuery(currencySettingsQueryOptions());
    const [loading, setLoading] = useState(true);
    const [methodsLoadError, setMethodsLoadError] = useState<string | null>(null);
    const [methods, setMethods] = useState<PaymentMethodsData | null>(null);
    const [enabledMethods, setEnabledMethods] = useState<Set<MethodKey>>(new Set(["cod"]));
    const [methodOrder, setMethodOrder] = useState<MethodKey[]>(["cod"]);
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
    const [configureGateway, setConfigureGateway] = useState<MethodKey | null>(null);

    // Load only payment-methods on mount (1 API call)
    const loadMethods = useCallback(async (showInitialLoader = true, notifyOnError = true, preserveDraft = false) => {
        if (showInitialLoader) setLoading(true);
        setMethodsLoadError(null);
        try {
            const d = await getPaymentMethods() as PaymentMethodsData;
            setMethods(d);
            if (!preserveDraft) {
                setEnabledMethods(new Set(d.enabledMethods));
                setMethodOrder(d.enabledMethods);
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

    // Lazy-load gateway credentials when the configure dialog opens
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

    const openConfigure = (method: MethodKey) => {
        setConfigureGateway(method);
        if (method !== "cod" && !loadedGateways.current.has(method)) void loadCreds(method);
    };

    const toggleMethod = (method: MethodKey, on: boolean) => {
        const next = new Set(enabledMethods);
        if (on) {
            next.add(method);
            setMethodOrder((current) => current.includes(method) ? current : [...current, method]);
        }
        else {
            if (next.size <= 1) { toast.error("At least one payment method must be enabled."); return; }
            next.delete(method);
            const nextOrder = methodOrder.filter((item) => item !== method);
            setMethodOrder(nextOrder);
            if (defaultMethod === method) setDefaultMethod(nextOrder[0] ?? Array.from(next)[0] as MethodKey);
        }
        setEnabledMethods(next);
    };

    const moveMethod = (method: MethodKey, direction: -1 | 1) => {
        setMethodOrder((current) => {
            const index = current.indexOf(method);
            const targetIndex = index + direction;
            if (index < 0 || targetIndex < 0 || targetIndex >= current.length) return current;
            const next = [...current];
            [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
            return next;
        });
    };

    const saveMethods = async (silent = false) => {
        if (loading || !methods || methodsLoadError || !checkoutFlowSettings || !currencySettings) {
            const message = !checkoutFlowSettings
                ? "Reload checkout flow before saving buyer payment methods."
                : !currencySettings
                    ? "Reload store currency before saving buyer payment methods."
                    : "Reload payment status before saving buyer payment methods.";
            if (!silent) toast.error(message);
            return false;
        }
        setSavingMethods(true);
        try {
            const nextEnabledMethods = methodOrder.filter((method) => enabledMethods.has(method));
            await updatePaymentMethods({ data: { enabledMethods: nextEnabledMethods, defaultMethod } });
            setMethods((current) => current
                ? { ...current, enabledMethods: nextEnabledMethods, defaultMethod }
                : current);
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: queryKeys.settings.paymentMethods() }),
                queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutFlow() }),
                queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutReadiness() }),
            ]);
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
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: queryKeys.settings.paymentMethods() }),
                queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutFlow() }),
                queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutReadiness() }),
            ]);
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

    const getGatewayEligibilityIssue = useCallback((method: MethodKey): string | null => {
        if (method !== "sslcommerz") return null;
        if (!currencySettings) return "Store currency could not be checked.";
        return currencySettings.currencyCode === "BDT"
            ? null
            : `SSLCommerz checkout requires BDT. Current store currency: ${currencySettings.currencyCode}.`;
    }, [currencySettings]);

    const defaultOptions = useMemo(() => methods
        ? getEligibleDefaultPaymentMethods({
            methods: ALL_METHODS,
            statuses: methods.gatewayStatus,
            selectedMethods: enabledMethods,
            flowAllowed: methodAllowedByFlow,
            eligibilityIssue: getGatewayEligibilityIssue,
        })
        : [], [enabledMethods, getGatewayEligibilityIssue, methodAllowedByFlow, methods]);

    useEffect(() => {
        if (defaultOptions.length > 0 && !defaultOptions.includes(defaultMethod)) {
            setDefaultMethod(defaultOptions[0]);
        }
    }, [defaultMethod, defaultOptions]);

    if (loading) {
        return (
            <SkeletonPage
                showHeader={false}
                sections={2}
                rowsPerSection={4}
                label="Loading payment settings"
            />
        );
    }

    if (!methods) {
        return (
            <Alert className="max-w-4xl border-amber-500/30 bg-amber-500/5" role="alert">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                <AlertTitle>Payment settings could not be loaded</AlertTitle>
                <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <span className="min-w-0">
                        <span className="block">
                            {methodsLoadError ?? "Reload payment settings before changing checkout visibility."}
                        </span>
                        <span className="mt-1 block text-xs opacity-85">
                            Checkout visibility is locked until the saved payment-method settings load successfully.
                        </span>
                    </span>
                    <Button type="button" variant="outline" size="sm" className="min-h-11 shrink-0 sm:min-h-9" onClick={() => void loadMethods()}>
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                        Retry
                    </Button>
                </AlertDescription>
            </Alert>
        );
    }

    const getSavedEnvironment = (method: MethodKey): PaymentMethodEnvironment | undefined => {
        if (method === "cod") return "not_applicable";
        if (!loadedGateways.current.has(method)) return methods.gatewayStatus[method]?.environment;
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
        eligibilityIssue: getGatewayEligibilityIssue(method),
    });
    const defaultMethodAvailable = defaultOptions.includes(defaultMethod);
    const canSaveMethods = Boolean(checkoutFlowSettings)
        && Boolean(currencySettings)
        && !methodsLoadError
        && defaultOptions.length > 0
        && defaultMethodAvailable;
    const savedEnabledMethods = new Set(methods.enabledMethods);
    const enabledMethodsChanged = ALL_METHODS.some((method) => (
        enabledMethods.has(method) !== savedEnabledMethods.has(method)
    ));
    const paymentMethodOrderChanged = methodOrder.join("|") !== methods.enabledMethods.join("|");
    const methodsDirty = enabledMethodsChanged || defaultMethod !== methods.defaultMethod || paymentMethodOrderChanged;
    const stripeDirty = loadedGateways.current.has("stripe") && stripeDraftIsDirty(stripe, savedStripe);
    const sslDirty = loadedGateways.current.has("sslcommerz") && sslCommerzDraftIsDirty(ssl, savedSsl);
    const polarDirty = loadedGateways.current.has("polar") && polarDraftIsDirty(polar, savedPolar);
    const anyGatewayDirty = stripeDirty || sslDirty || polarDirty;
    const anySavePending = savingMethods || savingStripe || savingSsl || savingPolar;
    const dirtyGatewayLabel = stripeDirty
        ? META.stripe.label
        : sslDirty
            ? META.sslcommerz.label
            : polarDirty
                ? META.polar.label
                : null;
    const resetMethods = () => {
        setEnabledMethods(new Set(methods.enabledMethods));
        setMethodOrder(methods.enabledMethods);
        setDefaultMethod(methods.defaultMethod);
    };
    const discardDraft = () => {
        if (methodsDirty) resetMethods();
        if (savedStripe && stripeDirty) setStripe({ ...savedStripe });
        if (savedSsl && sslDirty) setSsl({ ...savedSsl });
        if (savedPolar && polarDirty) setPolar({ ...savedPolar });
    };
    const methodSaveDisabledReason = !methodsDirty
        ? dirtyGatewayLabel
            ? `Save ${dirtyGatewayLabel} from its configure dialog, or discard the credential changes.`
            : "There are no buyer payment method changes to save."
        : !checkoutFlowSettings
            ? "The saved checkout flow must load before buyer payment methods can be saved."
            : !currencySettings
                ? "The store currency must load before buyer payment methods can be saved."
                : methodsLoadError
                    ? "Refresh the payment status before saving."
                    : "Select at least one setup-complete, provider-enabled method allowed by the current checkout flow.";
    const orderedEnabledMethods = methodOrder.filter((method) => enabledMethods.has(method));

    const gatewayColumns: IndexTableColumn<MethodKey>[] = [
        {
            id: "gateway",
            header: "Gateway",
            mobileLabel: "Gateway",
            cell: (method) => {
                const meta = META[method];
                const outcome = getMethodOutcome(method);
                const notice = outcome.state === "hidden_by_flow"
                    ? getFlowHiddenReason(method) ?? outcome.description
                    : outcome.state === "visible" || outcome.state === "ready_hidden"
                        ? null
                        : outcome.description;
                return (
                    <span className="flex min-w-0 items-start gap-3 py-1">
                        <meta.Mark />
                        <span className="min-w-0">
                            <span className="block text-sm font-medium">{meta.label}</span>
                            <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{meta.desc}</span>
                            {notice ? (
                                <span className="mt-1.5 flex items-start gap-1.5 text-xs leading-4 text-amber-700 dark:text-amber-300">
                                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                    <span>{notice}</span>
                                </span>
                            ) : null}
                        </span>
                    </span>
                );
            },
        },
        {
            id: "status",
            header: "Status",
            mobileLabel: "Status",
            cell: (method) => <OutcomeBadge outcome={getMethodOutcome(method)} />,
        },
        {
            id: "environment",
            header: "Mode",
            mobileLabel: "Mode",
            cell: (method) => (
                <span className="text-xs text-muted-foreground">
                    {getMethodOutcome(method).environmentLabel}
                </span>
            ),
        },
        {
            id: "checkout",
            header: "At checkout",
            mobileLabel: "At checkout",
            align: "end",
            cell: (method) => {
                const meta = META[method];
                const outcome = getMethodOutcome(method);
                const selected = enabledMethods.has(method);
                const toggleDisabled = !selected && !outcome.canSelect;
                return (
                    <label htmlFor={`toggle-${method}`} className="flex min-h-11 shrink-0 cursor-pointer items-center justify-end">
                        <Switch
                            id={`toggle-${method}`}
                            checked={selected}
                            aria-label={`Show ${meta.label} at checkout`}
                            disabled={toggleDisabled || Boolean(methodsLoadError) || !checkoutFlowSettings}
                            onCheckedChange={(v) => toggleMethod(method, v)}
                        />
                    </label>
                );
            },
        },
    ];

    return (
        <>
        <ContextualSaveBar
            isDirty={methodsDirty || anyGatewayDirty}
            saving={anySavePending}
            saveDisabled={!methodsDirty || !canSaveMethods}
            saveDisabledReason={methodSaveDisabledReason}
            message={methodsDirty
                ? "Unsaved buyer payment method changes"
                : `Unsaved ${dirtyGatewayLabel ?? "gateway"} credentials`}
            saveLabel="Save payment methods"
            allowSamePathNavigation
            // The settings section picker is sticky on narrow widths.
            stickyClassName="sticky top-15 z-30 lg:top-0"
            onDiscard={discardDraft}
            onSave={() => void saveMethods()}
        />
        <div className="max-w-5xl space-y-6">
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
                                className="min-h-11 shrink-0 sm:min-h-9"
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
            {!currencySettings && (
                <Alert className={currencySettingsError ? "border-amber-500/30 bg-amber-500/5" : undefined}>
                    {currencySettingsError
                        ? <AlertTriangle className="h-4 w-4 text-amber-500" />
                        : <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    <AlertTitle>{currencySettingsError ? "Store currency could not be loaded" : "Checking store currency"}</AlertTitle>
                    <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <span>
                            Payment-method eligibility and saves stay locked until the store currency is known.
                        </span>
                        {currencySettingsError && (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="min-h-11 shrink-0 sm:min-h-9"
                                onClick={() => void refetchCurrencySettings()}
                                disabled={currencySettingsFetching}
                            >
                                {currencySettingsFetching && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                                Retry currency check
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
                            className="min-h-11 shrink-0 sm:min-h-9"
                            onClick={() => void loadMethods(false, true, true)}
                        >
                            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                            Refresh status
                        </Button>
                    </AlertDescription>
                </Alert>
            )}

            <SettingsSection
                title="Buyer payment methods"
                description="Choose which eligible methods appear at checkout, their display order, and the preselected option."
                footer={!canSaveMethods && !methodsLoadError && checkoutFlowSettings
                    ? "Select at least one setup-complete, provider-enabled method allowed by the current checkout flow."
                    : undefined}
            >
                <div className="space-y-5">
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_15rem] sm:items-center">
                        <div>
                            <Label htmlFor="default-payment-method">Default buyer selection</Label>
                            <InlineHelp id="default-payment-method-help" className="mt-1">
                                Preselected when the payment step opens.
                            </InlineHelp>
                        </div>
                        <Select
                            value={defaultMethodAvailable ? defaultMethod : undefined}
                            onValueChange={(value) => setDefaultMethod(value as MethodKey)}
                            disabled={defaultOptions.length === 0 || Boolean(methodsLoadError) || !checkoutFlowSettings || !currencySettings}
                        >
                            <SelectTrigger
                                id="default-payment-method"
                                aria-describedby="default-payment-method-help"
                                className="h-11 w-full sm:h-9"
                            >
                                <SelectValue placeholder="No eligible method" />
                            </SelectTrigger>
                            <SelectContent>
                                {defaultOptions.map((method) => (
                                    <SelectItem key={method} value={method} className="text-sm">{META[method].label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div>
                        <div className="mb-2">
                            <Label>Checkout display order</Label>
                            <InlineHelp id="checkout-display-order-help" className="mt-1">
                                The storefront shows eligible methods from top to bottom.
                            </InlineHelp>
                        </div>
                        {orderedEnabledMethods.length > 0 ? (
                            <ol
                                className="divide-y rounded-md border"
                                aria-label="Checkout payment method display order"
                                aria-describedby="checkout-display-order-help"
                            >
                                {orderedEnabledMethods.map((method, index, list) => (
                                    <li key={method} className="flex min-h-12 items-center gap-3 px-3 py-2">
                                        <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                                        <span className="min-w-0 flex-1 text-sm font-medium">{META[method].label}</span>
                                        {defaultMethod === method && <Badge variant="secondary" className="text-[11px]">Default</Badge>}
                                        <div className="flex shrink-0 gap-1">
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                className="h-11 w-11 sm:h-9 sm:w-9"
                                                aria-label={`Move ${META[method].label} up`}
                                                onClick={() => moveMethod(method, -1)}
                                                disabled={index === 0 || savingMethods}
                                            >
                                                <ArrowUp className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                className="h-11 w-11 sm:h-9 sm:w-9"
                                                aria-label={`Move ${META[method].label} down`}
                                                onClick={() => moveMethod(method, 1)}
                                                disabled={index === list.length - 1 || savingMethods}
                                            >
                                                <ArrowDown className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </li>
                                ))}
                            </ol>
                        ) : (
                            <EmptyState
                                compact
                                icon={CreditCard}
                                heading="No method is offered at checkout"
                                body="Turn on a gateway below to place it in the buyer's payment step."
                            />
                        )}
                    </div>
                </div>
            </SettingsSection>

            <SettingsSection
                title="Gateways"
                description="Connect a provider, then decide whether buyers see it at checkout."
                contentClassName="p-0 sm:p-0"
            >
                <IndexTable
                    items={ALL_METHODS}
                    columns={gatewayColumns}
                    getRowId={(method) => method}
                    label="Payment gateways"
                    stickyHeader={false}
                    className="space-y-0"
                    empty={(
                        <EmptyState
                            bordered={false}
                            icon={CreditCard}
                            heading="No payment gateway is available"
                            body="Gateways appear here once the platform exposes them to this store."
                        />
                    )}
                    rowActions={(method) => method === "cod" ? null : (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-11 w-11 sm:h-9 sm:w-9"
                                    aria-label={`${META[method].label} actions`}
                                >
                                    <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => openConfigure(method)}>
                                    <Settings2 className="h-4 w-4" aria-hidden="true" />
                                    Configure credentials
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                />
            </SettingsSection>

            <Dialog
                open={configureGateway !== null}
                onOpenChange={(open) => { if (!open) setConfigureGateway(null); }}
            >
                <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
                    {configureGateway && configureGateway !== "cod" ? ((method: MethodKey) => {
                        const meta = META[method];
                        const gatewayLoadError = gatewayLoadErrors[method];
                        const gatewayLoaded = loadedGateways.current.has(method);
                        return (
                            <>
                                <DialogHeader>
                                    <DialogTitle className="flex items-center gap-2">
                                        <meta.Mark />
                                        {meta.label} credentials
                                    </DialogTitle>
                                    <DialogDescription>
                                        Saved here and used for every {meta.label} payment session. Buyer visibility is controlled by the toggle on the gateway row.
                                    </DialogDescription>
                                </DialogHeader>
                                {loadingGw === method ? (
                                    <SkeletonPage
                                        showHeader={false}
                                        sections={1}
                                        rowsPerSection={4}
                                        label={`Loading ${meta.label} setup`}
                                        className="[&_[data-testid=skeleton-page-section]]:grid-cols-1"
                                    />
                                ) : gatewayLoadError ? (
                                    <Alert variant="destructive">
                                        <AlertTriangle className="h-4 w-4" />
                                        <AlertTitle>Gateway settings unavailable</AlertTitle>
                                        <AlertDescription className="space-y-3">
                                            <p>{gatewayLoadError}</p>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="min-h-11 sm:min-h-9"
                                                onClick={() => void loadCreds(method, true)}
                                            >
                                                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                                                Retry
                                            </Button>
                                        </AlertDescription>
                                    </Alert>
                                ) : !gatewayLoaded ? (
                                    <SkeletonPage
                                        showHeader={false}
                                        sections={1}
                                        rowsPerSection={4}
                                        label={`Loading ${meta.label} setup`}
                                        className="[&_[data-testid=skeleton-page-section]]:grid-cols-1"
                                    />
                                ) : method === "stripe" ? (
                                    <StripeForm s={stripe} set={setStripe} conf={stripeConf} saving={savingStripe} dirty={stripeDirty}
                                        onReset={() => savedStripe && setStripe({ ...savedStripe })}
                                        onSave={() => saveGw("stripe", stripe, setSavingStripe)} />
                                ) : method === "sslcommerz" ? (
                                    <SSLForm s={ssl} set={setSsl} conf={sslConf} saving={savingSsl} dirty={sslDirty}
                                        onReset={() => savedSsl && setSsl({ ...savedSsl })}
                                        onSave={() => saveGw("sslcommerz", ssl, setSavingSsl)} />
                                ) : (
                                    <PolarForm s={polar} set={setPolar} conf={polarConf} saving={savingPolar} dirty={polarDirty}
                                        onReset={() => savedPolar && setPolar({ ...savedPolar })}
                                        onSave={() => saveGw("polar", polar, setSavingPolar)} onHelp={() => setShowPolarHelp(true)} />
                                )}
                            </>
                        );
                    })(configureGateway) : null}
                </DialogContent>
            </Dialog>

            <Dialog open={showPolarHelp} onOpenChange={setShowPolarHelp}>
                <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2"><Zap className="h-5 w-5 text-indigo-600" /> Polar setup guide</DialogTitle>
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
                    <InlineHelp id="stripe-enabled-help">Allows Stripe sessions after credentials are complete.</InlineHelp>
                </div>
                <Switch
                    id="stripe-enabled"
                    aria-describedby="stripe-enabled-help"
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
                <InlineHelp><ExtLink href="https://dashboard.stripe.com/apikeys">dashboard.stripe.com/apikeys</ExtLink></InlineHelp>
            </div>
            <div className="space-y-1.5">
                <Label htmlFor="stripe-pub" className="text-sm">Publishable Key</Label>
                <Input id="stripe-pub" type="text" value={s.publishableKey} className="min-h-11 font-mono sm:min-h-9"
                    onChange={(e) => set((p) => ({ ...p, publishableKey: e.target.value }))} placeholder="pk_live_... or pk_test_..." />
                <div className="flex min-h-6 items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>Key environment</span>
                    <StatusBadge tone={keyEnvironment === "mixed" ? "critical" : "neutral"} srLabel="Key environment:">
                        {environmentLabel}
                    </StatusBadge>
                </div>
            </div>
            <div className="space-y-1.5">
                <Label htmlFor="stripe-wh" className="flex items-center gap-1.5 text-sm">
                    Webhook Secret {conf.webhook && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
                </Label>
                <PasswordInput id="stripe-wh" value={s.webhookSecret} onChange={(v) => set((p) => ({ ...p, webhookSecret: v }))}
                    placeholder="whsec_..." configured={conf.webhook} />
                <InlineHelp>Add endpoint <code className="rounded bg-muted px-1 text-xs">/api/v1/webhooks/stripe</code> in Stripe webhooks.</InlineHelp>
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
                    <InlineHelp id="ssl-enabled-help">Allows SSLCommerz sessions after credentials are complete.</InlineHelp>
                </div>
                <Switch
                    id="ssl-enabled"
                    aria-describedby="ssl-enabled-help"
                    checked={s.enabled}
                    onCheckedChange={(v) => set((p) => ({ ...p, enabled: v }))}
                />
            </div>
            <SandboxToggle id="ssl-sandbox" checked={s.sandbox} onChange={(v) => set((p) => ({ ...p, sandbox: v }))} />
            {!s.sandbox && s.enabled && <LiveWarning message="Live mode enabled. Real payments will be processed." />}
            <div className="space-y-1.5">
                <Label htmlFor="ssl-id" className="text-sm">Store ID</Label>
                <Input id="ssl-id" type="text" value={s.storeId} className="min-h-11 font-mono sm:min-h-9"
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
