import React, { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
    RadioGroup,
    RadioGroupItem,
} from "@/components/ui/radio-group";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Loader2, MapPinned, RotateCcw, Save, ShieldCheck, Truck } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getServerFnError } from "@/lib/api-helpers";
import {
    getCheckoutFlowSettings,
    updateCheckoutFlowSettings,
    type CheckoutFlowSettingsPayload,
    type CheckoutReadinessPayload,
    type PaymentMethodsPayload,
} from "@/lib/api-functions/settings";
import { readCheckoutFlowRevisionConflict } from "@/lib/admin-api-error";
import {
    checkoutFlowSettingsQueryOptions,
    checkoutReadinessQueryOptions,
    paymentMethodsQueryOptions,
} from "@/lib/api-query-options/settings";
import { queryKeys } from "@/lib/query-keys";
import { UnsavedChangesGuard } from "@/components/admin/shared/UnsavedChangesGuard";
import {
    CHECKOUT_ADVANCE_PAYMENT_AMOUNT_LIMITS,
    CHECKOUT_ADVANCE_PAYMENT_AMOUNT_RANGE_LABEL,
    getCheckoutAdvancePaymentAmountIssue,
    getCheckoutFlowPreviewIssues,
} from "./checkout-flow-policy";
import {
    checkoutFlowValuesEqual,
    readCheckoutFlowValues,
    rebaseCheckoutFlowDraft,
    type CheckoutFlowValues,
} from "./checkout-flow-draft";

type CheckoutMode = "all" | "guest_cod_only" | "gateways_only";
const CUSTOMER_SIGN_IN_READINESS_ISSUE =
    "Configure a usable customer sign-in verification channel before requiring customer accounts at checkout.";

const checkoutModes: Array<{
    value: CheckoutMode;
    label: string;
    description: string;
}> = [
    {
        value: "all",
        label: "Standard",
        description: "Offer every compatible COD and online method.",
    },
    {
        value: "guest_cod_only",
        label: "COD only",
        description: "Skip online payment and place the order directly.",
    },
    {
        value: "gateways_only",
        label: "Online only",
        description: "Require an enabled online gateway and hide COD.",
    },
];

function normalizeCheckoutMode(value: unknown): CheckoutMode {
    return value === "guest_cod_only" || value === "gateways_only" ? value : "all";
}

interface CheckoutFlowEditorState {
    draft: CheckoutFlowValues;
    saved: CheckoutFlowValues;
    revision: number;
}

interface CheckoutFlowConflictState {
    currentRevision: number | null;
    latest: CheckoutFlowSettingsPayload | null;
    loading: boolean;
    loadFailed: boolean;
}

function createEditorState(settings: CheckoutFlowSettingsPayload): CheckoutFlowEditorState {
    const values = readCheckoutFlowValues(settings);
    return { draft: values, saved: values, revision: settings.revision };
}

function buildCheckoutFlowSummary(options: {
    guestCheckoutEnabled: boolean;
    checkoutMode: string;
    partialPaymentEnabled: boolean;
    partialPaymentAmount: number;
}): string {
    if (options.partialPaymentEnabled) {
        const amount = Number.isFinite(options.partialPaymentAmount)
            ? options.partialPaymentAmount.toLocaleString("en-US", { maximumFractionDigits: 2 })
            : "0";
        return `Customers pay ${amount} in your store currency online first. The remaining balance is due on delivery.`;
    }
    if (options.checkoutMode === "guest_cod_only") {
        return options.guestCheckoutEnabled
            ? "Customers place COD orders directly from cart without a separate payment-method step."
            : "Customers must sign in first, then place COD orders without a separate payment-method step.";
    }
    if (options.checkoutMode === "gateways_only") {
        return "Customers must choose an online payment gateway; COD is hidden.";
    }
    return options.guestCheckoutEnabled
        ? "Customers can check out as guests or signed-in customers and choose from available COD/online methods."
        : "Customers must sign in before checkout and then choose from available COD/online methods.";
}

function ReadinessRow({
    label,
    ready,
    loading,
    unknown,
    icon: Icon,
}: {
    label: string;
    ready: boolean | undefined;
    loading: boolean;
    unknown?: boolean;
    icon: React.ComponentType<{ className?: string }>;
}) {
    const status = loading
        ? { label: "Checking", className: "text-muted-foreground" }
        : ready
            ? { label: "Ready", className: "text-emerald-700 dark:text-emerald-300" }
            : unknown
                ? { label: "Unavailable", className: "text-amber-700 dark:text-amber-300" }
                : { label: "Needs setup", className: "text-destructive" };

    return (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2 text-sm">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{label}</span>
            </div>
            <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs font-medium ${status.className}`}>
                {loading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : ready ? (
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {status.label}
            </span>
        </div>
    );
}

export default function CheckoutFlowSettings() {
    const queryClient = useQueryClient();
    const {
        data: checkoutSettings,
        isLoading,
        isError,
        isFetching,
        refetch,
    } = useQuery(checkoutFlowSettingsQueryOptions());
    const {
        data: paymentMethods,
        isFetching: paymentMethodsFetching,
        isError: paymentMethodsError,
        error: paymentMethodsQueryError,
        refetch: refetchPaymentMethods,
    } = useQuery(paymentMethodsQueryOptions());
    const {
        data: checkoutReadiness,
        isFetching: checkoutReadinessFetching,
        isError: checkoutReadinessError,
        error: checkoutReadinessQueryError,
        refetch: refetchCheckoutReadiness,
    } = useQuery(checkoutReadinessQueryOptions());
    const [saving, setSaving] = useState(false);
    const [editor, setEditor] = useState<CheckoutFlowEditorState | null>(null);
    const [conflict, setConflict] = useState<CheckoutFlowConflictState | null>(null);

    useEffect(() => {
        if (!checkoutSettings) return;
        setEditor((current) => {
            if (current && !checkoutFlowValuesEqual(current.draft, current.saved)) {
                return current;
            }
            return createEditorState(checkoutSettings);
        });
    }, [checkoutSettings]);

    const guestCheckoutEnabled = editor?.draft.guestCheckoutEnabled ?? true;
    const checkoutMode = editor?.draft.checkoutMode ?? "all";
    const partialPaymentEnabled = editor?.draft.partialPaymentEnabled ?? false;
    const partialPaymentAmount = editor?.draft.partialPaymentAmount ?? 0;

    const updateDraft = <Field extends keyof CheckoutFlowValues>(
        field: Field,
        value: CheckoutFlowValues[Field],
    ) => {
        setEditor((current) => current
            ? { ...current, draft: { ...current.draft, [field]: value } }
            : current);
    };

    const activeOnlineMethods = useMemo(() => {
        const methodsPayload = paymentMethods as PaymentMethodsPayload | undefined;
        const methods = methodsPayload?.enabledMethods ?? [];
        return methods.filter((method) => {
            if (method === "cod") return false;
            const status = methodsPayload?.gatewayStatus?.[method as keyof PaymentMethodsPayload["gatewayStatus"]];
            return status?.usable ?? (status?.enabled === true && status?.configured === true);
        });
    }, [paymentMethods]);
    const codEnabled = useMemo(() => {
        const methodsPayload = paymentMethods as PaymentMethodsPayload | undefined;
        return methodsPayload?.enabledMethods?.includes("cod") === true &&
            methodsPayload.gatewayStatus?.cod?.enabled === true &&
            (methodsPayload.gatewayStatus?.cod?.usable ?? methodsPayload.gatewayStatus?.cod?.configured === true);
    }, [paymentMethods]);
    const sslCommerzEnabled = activeOnlineMethods.includes("sslcommerz");
    const paymentMethodsPending = !paymentMethods && !paymentMethodsError;
    const paymentMethodsUnavailable = !paymentMethods && paymentMethodsError;

    const flowIssues = useMemo(() => {
        return getCheckoutFlowPreviewIssues({
            checkoutMode,
            partialPaymentEnabled,
            partialPaymentAmount,
            paymentMethodsUnavailable,
            paymentMethodsLoaded: Boolean(paymentMethods),
            codEnabled,
            activeOnlineMethodCount: activeOnlineMethods.length,
            sslCommerzEnabled,
        });
    }, [activeOnlineMethods.length, checkoutMode, codEnabled, partialPaymentAmount, partialPaymentEnabled, paymentMethods, paymentMethodsUnavailable, sslCommerzEnabled]);

    const flowSummary = buildCheckoutFlowSummary({
        guestCheckoutEnabled,
        checkoutMode,
        partialPaymentEnabled,
        partialPaymentAmount,
    });
    const partialPaymentAmountIssue = partialPaymentEnabled
        ? getCheckoutAdvancePaymentAmountIssue(partialPaymentAmount, { sslCommerzEnabled })
        : null;
    const isDirty = editor ? !checkoutFlowValuesEqual(editor.draft, editor.saved) : false;
    const readiness = checkoutReadiness as CheckoutReadinessPayload | undefined;
    const readinessIssues = (readiness?.issues ?? []).filter((issue) => (
        !guestCheckoutEnabled || issue !== CUSTOMER_SIGN_IN_READINESS_ISSUE
    ));
    const prospectiveCustomerSignInIssue = !guestCheckoutEnabled
        && readiness
        && !readiness.hasUsableCustomerSignIn
        ? CUSTOMER_SIGN_IN_READINESS_ISSUE
        : null;
    const previewIssues = [
        ...flowIssues,
        ...readinessIssues,
        ...(prospectiveCustomerSignInIssue && !readinessIssues.includes(prospectiveCustomerSignInIssue)
            ? [prospectiveCustomerSignInIssue]
            : []),
    ];
    const readinessPending = !readiness && !checkoutReadinessError;
    const previewLoading = paymentMethodsPending || readinessPending;
    const readinessUnknown = !readiness && checkoutReadinessError;
    const readinessCheckUnavailable = readinessUnknown;
    const checkoutSettingsStale = isError && Boolean(checkoutSettings);
    const readinessErrorMessage = checkoutReadinessQueryError instanceof Error
        ? checkoutReadinessQueryError.message
        : null;
    const paymentMethodsErrorMessage = paymentMethodsQueryError instanceof Error
        ? paymentMethodsQueryError.message
        : null;
    const hasConfirmedPreviewIssue = previewIssues.length > 0 && !paymentMethodsUnavailable;
    const previewCardClass = previewLoading
        ? "border-border bg-card"
        : hasConfirmedPreviewIssue
        ? "border-destructive/40 bg-destructive/5"
        : paymentMethodsUnavailable || readinessCheckUnavailable
            ? "border-amber-500/30 bg-amber-500/5"
            : "border-emerald-500/30 bg-emerald-500/5";
    const customerSignInCheckBlocked = !guestCheckoutEnabled
        && (!readiness || !readiness.hasUsableCustomerSignIn);
    const saveBlocked = !isDirty
        || !editor
        || Boolean(conflict)
        || checkoutSettingsStale
        || paymentMethodsPending
        || flowIssues.length > 0
        || customerSignInCheckBlocked;

    const resetFlow = () => {
        setEditor((current) => {
            if (checkoutSettings && current?.revision !== checkoutSettings.revision) {
                return createEditorState(checkoutSettings);
            }
            return current ? { ...current, draft: current.saved } : current;
        });
        setConflict(null);
    };

    const handleSubmit = async (e?: React.SyntheticEvent) => {
        e?.preventDefault();
        if (!editor || !Number.isInteger(editor.revision) || editor.revision < 1) {
            toast.error("Checkout settings are not ready to save. Reload this page and try again.");
            return;
        }
        if (paymentMethodsPending) {
            toast.error("Wait for payment readiness to finish loading before saving checkout flow changes.");
            return;
        }
        if (checkoutSettingsStale) {
            toast.error("Refresh the saved checkout flow before saving these changes.");
            return;
        }
        if (flowIssues.length > 0) return;
        if (customerSignInCheckBlocked) {
            toast.error("Customer sign-in verification must be ready before requiring an account at checkout.");
            return;
        }
        setSaving(true);

        try {
            const saved = await updateCheckoutFlowSettings({
                data: {
                    ...editor.draft,
                    expectedRevision: editor.revision,
                },
            });
            setEditor(createEditorState(saved));
            setConflict(null);
            queryClient.setQueryData(queryKeys.settings.checkoutFlow(), saved);
            await queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutFlow() });
            await queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutReadiness() });
            toast.success("Checkout flow saved");
        } catch (err) {
            const revisionConflict = readCheckoutFlowRevisionConflict(err);
            if (!revisionConflict) {
                toast.error(getServerFnError(err, "Failed to save checkout flow settings"));
                return;
            }

            setConflict({
                currentRevision: revisionConflict.currentRevision,
                latest: null,
                loading: true,
                loadFailed: false,
            });
            toast.error("Checkout settings changed in another tab. Your unsaved values are still here.");
            try {
                const latest = await getCheckoutFlowSettings();
                setConflict({
                    currentRevision: latest.revision,
                    latest,
                    loading: false,
                    loadFailed: false,
                });
            } catch {
                setConflict((current) => current
                    ? { ...current, loading: false, loadFailed: true }
                    : current);
            }
        } finally {
            setSaving(false);
        }
    };

    const retryLatestCheckoutFlow = async () => {
        if (!conflict) return;
        setConflict((current) => current ? { ...current, loading: true, loadFailed: false } : current);
        try {
            const latest = await getCheckoutFlowSettings();
            setConflict({ currentRevision: latest.revision, latest, loading: false, loadFailed: false });
        } catch {
            setConflict((current) => current ? { ...current, loading: false, loadFailed: true } : current);
        }
    };

    const mergeConflict = () => {
        if (!editor || !conflict?.latest) return;
        const latestValues = readCheckoutFlowValues(conflict.latest);
        setEditor({
            saved: latestValues,
            draft: rebaseCheckoutFlowDraft({
                base: editor.saved,
                local: editor.draft,
                latest: latestValues,
            }),
            revision: conflict.latest.revision,
        });
        queryClient.setQueryData(queryKeys.settings.checkoutFlow(), conflict.latest);
        setConflict(null);
    };

    const useLatest = () => {
        if (!conflict?.latest) return;
        setEditor(createEditorState(conflict.latest));
        queryClient.setQueryData(queryKeys.settings.checkoutFlow(), conflict.latest);
        setConflict(null);
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground" role="status" aria-live="polite">
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                Loading checkout flow…
            </div>
        );
    }

    if (isError && !checkoutSettings) {
        return (
            <Alert className="max-w-2xl border-destructive/30 bg-destructive/5">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                <AlertDescription className="flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <span>Failed to load checkout flow settings.</span>
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void refetch()}
                    >
                        Retry
                    </Button>
                </AlertDescription>
            </Alert>
        );
    }

    return (
        <>
        <UnsavedChangesGuard isDirty={isDirty} isSubmitting={saving} />
        <form
            method="post"
            onSubmit={handleSubmit}
            className="grid max-w-5xl gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start"
            noValidate
        >
            {checkoutSettingsStale && (
                <Alert className="border-amber-500/30 bg-amber-500/5 lg:col-span-2">
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                    <AlertDescription className="flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                        <span>The last saved checkout flow is still shown, but its current revision could not be refreshed. Your draft is preserved and saving is locked.</span>
                        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => void refetch()} disabled={isFetching}>
                            {isFetching && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                            Refresh saved flow
                        </Button>
                    </AlertDescription>
                </Alert>
            )}
            <Card className="lg:col-start-1 lg:row-start-1">
                <CardHeader className="p-4 pb-3">
                    <CardTitle className="text-base">Customer access</CardTitle>
                    <CardDescription>
                        Decide whether an account is required. Every order still collects a valid delivery phone number.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 px-4 pb-4">
                    <div className="flex items-start justify-between gap-4 rounded-md border border-border/70 p-3">
                        <div className="min-w-0 space-y-0.5">
                            <Label htmlFor="guest-checkout">Allow checkout without an account</Label>
                            <p className="text-xs text-muted-foreground">
                                Guest buyers provide their name, phone, and delivery details without creating a password.
                            </p>
                        </div>
                        <Switch
                            id="guest-checkout"
                            className="shrink-0"
                            checked={guestCheckoutEnabled}
                            onCheckedChange={(value) => updateDraft("guestCheckoutEnabled", value)}
                        />
                    </div>
                    <div className="flex items-start gap-2.5 rounded-md bg-muted/45 px-3 py-2.5 text-xs text-muted-foreground">
                        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-foreground" aria-hidden="true" />
                        <p><span className="font-medium text-foreground">Phone number is always required.</span> Phone collection for checkout identity and delivery cannot be disabled.</p>
                    </div>
                </CardContent>
            </Card>

            <Card className={`${previewCardClass} lg:sticky lg:top-4 lg:col-start-2 lg:row-span-3 lg:row-start-1 lg:self-start`}>
                <CardHeader className="p-4 pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                        {previewLoading ? (
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        ) : hasConfirmedPreviewIssue ? (
                            <AlertTriangle className="h-4 w-4 text-destructive" />
                        ) : paymentMethodsUnavailable || readinessCheckUnavailable ? (
                            <AlertTriangle className="h-4 w-4 text-amber-500" />
                        ) : (
                            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                        )}
                        Customer flow preview
                    </CardTitle>
                    <CardDescription>{flowSummary}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 px-4 pb-4 pt-0">
                    <div className="grid gap-2">
                        <ReadinessRow
                            label="Payment flow"
                            ready={paymentMethodsUnavailable ? undefined : flowIssues.length === 0}
                            loading={paymentMethodsPending}
                            unknown={paymentMethodsUnavailable}
                            icon={CheckCircle2}
                        />
                        <ReadinessRow
                            label="Active shipping method"
                            ready={readiness?.hasActiveShippingMethod}
                            loading={readinessPending}
                            unknown={readinessUnknown}
                            icon={Truck}
                        />
                        <ReadinessRow
                            label="Active city and zone"
                            ready={readiness?.hasActiveDeliveryHierarchy}
                            loading={readinessPending}
                            unknown={readinessUnknown}
                            icon={MapPinned}
                        />
                        {!guestCheckoutEnabled && (
                            <ReadinessRow
                                label="Customer sign-in verification"
                                ready={readiness?.hasUsableCustomerSignIn}
                                loading={readinessPending}
                                unknown={readinessUnknown}
                                icon={ShieldCheck}
                            />
                        )}
                    </div>
                    {paymentMethodsUnavailable && (
                        <Alert className="border-amber-500/30 bg-amber-500/5">
                            <AlertTriangle className="h-4 w-4 text-amber-500" />
                            <AlertDescription className="flex flex-col gap-3 text-sm text-amber-700 dark:text-amber-400 sm:flex-row sm:items-center sm:justify-between">
                                <span className="min-w-0">
                                    <span className="block font-medium">Payment method readiness could not be checked. Reload payment settings before saving checkout flow changes.</span>
                                    {paymentMethodsError && paymentMethodsErrorMessage && (
                                        <span className="mt-1 block text-xs opacity-85">{paymentMethodsErrorMessage}</span>
                                    )}
                                    <span className="mt-1 block text-xs opacity-85">
                                        Checkout-flow saves are locked until Payment Gateways loads successfully.
                                    </span>
                                </span>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => void refetchPaymentMethods()}
                                    disabled={paymentMethodsFetching}
                                    className="shrink-0"
                                >
                                    {paymentMethodsFetching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                    Retry payment check
                                </Button>
                            </AlertDescription>
                        </Alert>
                    )}
                    {readinessCheckUnavailable && (
                        <Alert className="border-amber-500/30 bg-amber-500/5">
                            <AlertTriangle className="h-4 w-4 text-amber-500" />
                            <AlertDescription className="flex flex-col gap-3 text-sm text-amber-700 dark:text-amber-400 sm:flex-row sm:items-center sm:justify-between">
                                <span className="min-w-0">
                                    <span className="block font-medium">Checkout readiness status could not be refreshed.</span>
                                    {readinessErrorMessage && (
                                        <span className="mt-1 block text-xs opacity-85">{readinessErrorMessage}</span>
                                    )}
                                    <span className="mt-1 block text-xs opacity-85">
                                        This is an admin status check. Public checkout still fails closed if delivery setup is incomplete.
                                    </span>
                                </span>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => void refetchCheckoutReadiness()}
                                    disabled={checkoutReadinessFetching}
                                    className="shrink-0"
                                >
                                    {checkoutReadinessFetching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                    Retry check
                                </Button>
                            </AlertDescription>
                        </Alert>
                    )}
                    {(previewIssues.length > 0 || previewLoading) && (
                        <>
                            {previewLoading && (
                                <p className="text-xs text-muted-foreground">Checking checkout readiness...</p>
                            )}
                            {previewIssues.length > 0 && (
                                <ul
                                    className={`space-y-1 text-sm ${
                                        paymentMethodsUnavailable
                                            ? "text-amber-700 dark:text-amber-400"
                                            : "text-destructive"
                                    }`}
                                >
                                    {previewIssues.map((issue) => (
                                        <li key={issue}>{issue}</li>
                                    ))}
                                </ul>
                            )}
                        </>
                    )}
                </CardContent>
            </Card>

            <Card className="lg:col-start-1 lg:row-start-2">
                <CardHeader className="p-4 pb-3">
                    <CardTitle className="text-base">Payment flow</CardTitle>
                    <CardDescription>
                        Choose which configured payment methods buyers may use.
                    </CardDescription>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                    <div className="space-y-1.5">
                        <Label>Available methods</Label>
                        <RadioGroup
                            value={checkoutMode}
                            onValueChange={(value) => updateDraft("checkoutMode", normalizeCheckoutMode(value))}
                            className="grid gap-2 sm:grid-cols-3"
                            aria-label="Available payment methods"
                        >
                            {checkoutModes.map((option) => (
                                <Label
                                    key={option.value}
                                    htmlFor={`checkout-mode-${option.value}`}
                                    className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 transition-colors ${
                                        checkoutMode === option.value
                                            ? "border-primary bg-primary/5"
                                            : "border-border/70 hover:bg-muted/40"
                                    }`}
                                >
                                    <RadioGroupItem
                                        id={`checkout-mode-${option.value}`}
                                        value={option.value}
                                        className="mt-0.5"
                                    />
                                    <span className="min-w-0">
                                        <span className="block text-sm font-medium text-foreground">{option.label}</span>
                                        <span className="mt-0.5 block text-xs font-normal leading-4 text-muted-foreground">
                                            {option.value === "guest_cod_only" && !guestCheckoutEnabled
                                                ? "Require sign-in, then place a COD order directly."
                                                : option.description}
                                        </span>
                                    </span>
                                </Label>
                            ))}
                        </RadioGroup>
                    </div>
                </CardContent>
            </Card>

            <Card className="lg:col-start-1 lg:row-start-3">
                <CardHeader className="p-4 pb-3">
                    <CardTitle className="text-base">Advance collection</CardTitle>
                    <CardDescription>
                        Collect a fixed amount online and leave the remaining balance due on delivery.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 px-4 pb-4">
                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 space-y-0.5">
                            <Label htmlFor="advance-payment">Require an online advance</Label>
                            <p className="text-xs text-muted-foreground">
                                Buyers choose an online gateway. COD is hidden as a checkout method, while the balance remains due on delivery.
                            </p>
                        </div>
                        <Switch
                            id="advance-payment"
                            className="shrink-0"
                            checked={partialPaymentEnabled}
                            onCheckedChange={(value) => updateDraft("partialPaymentEnabled", value)}
                        />
                    </div>

                    {partialPaymentEnabled && (
                        <div className="space-y-3 pl-4 border-l-2 border-primary/20">
                            <div className="space-y-1.5">
                                <Label htmlFor="partial-payment-amount">Advance Amount Required</Label>
                                <Input
                                    id="partial-payment-amount"
                                    type="number"
                                    min={sslCommerzEnabled ? CHECKOUT_ADVANCE_PAYMENT_AMOUNT_LIMITS.min : 0.01}
                                    max={sslCommerzEnabled ? CHECKOUT_ADVANCE_PAYMENT_AMOUNT_LIMITS.max : undefined}
                                    step="0.01"
                                    className="w-full sm:max-w-xs"
                                    placeholder="e.g. 200"
                                    value={partialPaymentAmount}
                                    onChange={(e) => updateDraft("partialPaymentAmount", Number(e.target.value))}
                                    aria-invalid={Boolean(partialPaymentAmountIssue)}
                                    aria-describedby={partialPaymentAmountIssue
                                        ? "partial-payment-amount-help partial-payment-amount-error"
                                        : "partial-payment-amount-help"}
                                />
                                <p id="partial-payment-amount-help" className="text-xs text-muted-foreground mt-1">
                                    Carts at or below this amount are charged in full online. {sslCommerzEnabled
                                        ? `Because SSLCommerz is enabled, the amount must stay between ${CHECKOUT_ADVANCE_PAYMENT_AMOUNT_RANGE_LABEL}.`
                                        : "The amount uses your store currency."}
                                </p>
                            </div>

                            {partialPaymentAmountIssue && (
                                <Alert className="border-amber-500/30 bg-amber-500/5">
                                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                                    <AlertDescription
                                        id="partial-payment-amount-error"
                                        className="text-sm text-amber-700 dark:text-amber-400"
                                    >
                                        {partialPaymentAmountIssue}
                                    </AlertDescription>
                                </Alert>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>

            {conflict && (
                <Alert className="border-amber-500/40 bg-amber-500/5 lg:col-span-2">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    <AlertDescription className="space-y-3 text-sm text-amber-900 dark:text-amber-200">
                        <div>
                            <p className="font-medium">Checkout settings changed in another tab.</p>
                            <p className="mt-1 text-xs opacity-85">
                                Your unsaved values are still here. {conflict.currentRevision
                                    ? `The latest saved version is revision ${conflict.currentRevision}.`
                                    : "Load the latest version before deciding which changes to keep."}
                            </p>
                        </div>
                        {conflict.loadFailed && (
                            <p className="text-xs">The latest version could not be loaded. Retry without refreshing this page.</p>
                        )}
                        <div className="flex flex-col gap-2 sm:flex-row">
                            {conflict.latest ? (
                                <>
                                    <Button type="button" size="sm" onClick={mergeConflict}>
                                        Merge my changes
                                    </Button>
                                    <Button type="button" size="sm" variant="outline" onClick={useLatest}>
                                        Use latest saved version
                                    </Button>
                                </>
                            ) : (
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => void retryLatestCheckoutFlow()}
                                    disabled={conflict.loading}
                                >
                                    {conflict.loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                    Load latest version
                                </Button>
                            )}
                        </div>
                        {conflict.latest && (
                            <p className="text-xs opacity-85">
                                Merge keeps fields you changed here and adopts newer values for fields you did not change.
                            </p>
                        )}
                    </AlertDescription>
                </Alert>
            )}

            <div className="sticky bottom-3 z-10 flex flex-col-reverse gap-2 rounded-lg border bg-background/95 p-3 shadow-sm backdrop-blur sm:flex-row sm:items-center sm:justify-between lg:col-span-2">
                <p className="text-xs text-muted-foreground" aria-live="polite">
                    {conflict
                        ? "Resolve the newer saved version before saving"
                        : isDirty
                            ? `Unsaved checkout changes · based on revision ${editor?.revision ?? "—"}`
                            : `Checkout flow is saved · revision ${editor?.revision ?? "—"}`}
                </p>
                <div className="flex flex-col-reverse gap-2 sm:flex-row">
                    <Button
                        type="button"
                        variant="outline"
                        disabled={!isDirty || saving || Boolean(conflict)}
                        onClick={resetFlow}
                        className="w-full sm:w-auto"
                    >
                        <RotateCcw className="mr-2 h-4 w-4" />
                        Reset
                    </Button>
                    <Button
                        type="submit"
                        disabled={saving || saveBlocked}
                        className="w-full sm:w-auto sm:min-w-[164px]"
                    >
                        {saving ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                            <Save className="mr-2 h-4 w-4" />
                        )}
                        Save checkout flow
                    </Button>
                </div>
            </div>
        </form>
        </>
    );
}
