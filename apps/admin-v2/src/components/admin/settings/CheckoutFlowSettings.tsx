import React, { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import {
    RadioGroup,
    RadioGroupItem,
} from "~/components/ui/radio-group";
import { toast } from "sonner";
import { AlertTriangle, Loader2, MapPinned, ShieldCheck, Truck, Wallet } from "lucide-react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import {
    ContextualSaveBar,
    FieldError,
    InlineHelp,
    SettingsSection,
    SkeletonPage,
    StatusBadge,
    type StatusTone,
} from "~/components/admin/shell";
import { getServerFnError } from "~/lib/api-helpers";
import {
    getCheckoutFlowSettings,
    updateCheckoutFlowSettings,
    type CheckoutFlowSettingsPayload,
    type CheckoutReadinessPayload,
    type PaymentMethodsPayload,
} from "~/lib/api-functions/settings";
import { readCheckoutFlowRevisionConflict } from "~/lib/admin-api-error";
import {
    checkoutFlowSettingsQueryOptions,
    checkoutReadinessQueryOptions,
    paymentMethodsQueryOptions,
} from "~/lib/api-query-options/settings";
import { queryKeys } from "~/lib/query-keys";
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
/**
 * Stable issue code from `CHECKOUT_READINESS_CODES.customerSignIn`
 * (packages/core/src/modules/settings/checkout-readiness.ts). Matching on the
 * code instead of the sentence keeps this component off the API's copy.
 */
const CUSTOMER_SIGN_IN_READINESS_CODE = "unusable_customer_sign_in";
/** Preview-only copy: the API reports this issue once accounts are required. */
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
    submitted: CheckoutFlowValues;
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

/**
 * One readiness fact. The tone never carries the meaning on its own: the badge
 * always names the state ("Checking", "Ready", "Unavailable", "Needs setup").
 */
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
    const status: { label: string; tone: StatusTone } = loading
        ? { label: "Checking", tone: "neutral" }
        : ready
            ? { label: "Ready", tone: "success" }
            : unknown
                ? { label: "Unavailable", tone: "attention" }
                : { label: "Needs setup", tone: "critical" };

    return (
        <div className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2 text-sm">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{label}</span>
            </div>
            <StatusBadge tone={status.tone} srLabel={`${label}:`} className="shrink-0">
                {status.label}
            </StatusBadge>
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
        if (!checkoutSettings || saving || conflict) return;
        setEditor((current) => {
            if (current && !checkoutFlowValuesEqual(current.draft, current.saved)) {
                return current;
            }
            return createEditorState(checkoutSettings);
        });
    }, [checkoutSettings, saving, conflict]);

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
    const readinessIssues = (readiness?.issues ?? [])
        .filter((issue) => !guestCheckoutEnabled || issue.code !== CUSTOMER_SIGN_IN_READINESS_CODE)
        .map((issue) => issue.message);
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
    /**
     * A check that has not answered yet is never shown as a failure: loading is
     * neutral, an unreachable check is "Unavailable", and only a confirmed
     * issue is critical.
     */
    const previewSummary: { label: string; tone: StatusTone } = previewLoading
        ? { label: "Checking", tone: "neutral" }
        : hasConfirmedPreviewIssue
            ? { label: "Needs setup", tone: "critical" }
            : paymentMethodsUnavailable || readinessCheckUnavailable
                ? { label: "Unavailable", tone: "attention" }
                : { label: "Ready", tone: "success" };
    const customerSignInCheckBlocked = !guestCheckoutEnabled
        && (!readiness || !readiness.hasUsableCustomerSignIn);
    const saveBlocked = !isDirty
        || !editor
        || Boolean(conflict)
        || checkoutSettingsStale
        || paymentMethodsPending
        || flowIssues.length > 0
        || customerSignInCheckBlocked;
    const saveDisabledReason = conflict
        ? "Resolve the newer saved version before saving."
        : checkoutSettingsStale
            ? "Refresh the saved checkout flow before saving."
            : paymentMethodsPending
                ? "Wait for the payment readiness check to finish."
                : flowIssues.length > 0
                    ? "Fix the highlighted fields before saving."
                    : customerSignInCheckBlocked
                        ? "Customer sign-in verification must be ready before requiring an account at checkout."
                        : !isDirty
                            ? "There are no checkout flow changes to save."
                            : undefined;

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
        if (saving) return;
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
        const submitted = editor.draft;
        setSaving(true);

        try {
            const saved = await updateCheckoutFlowSettings({
                data: {
                    ...submitted,
                    expectedRevision: editor.revision,
                },
            });
            const savedValues = readCheckoutFlowValues(saved);
            setEditor((current) => ({
                saved: savedValues,
                draft: rebaseCheckoutFlowDraft({
                    base: submitted,
                    local: current?.draft ?? submitted,
                    latest: savedValues,
                }),
                revision: saved.revision,
            }));
            setConflict(null);
            queryClient.setQueryData(queryKeys.settings.checkoutFlow(), saved);
            await queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutFlow() });
            await queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutReadiness() });
            toast.success("Checkout flow saved");
        } catch (err) {
            const revisionConflict = readCheckoutFlowRevisionConflict(err);
            if (!revisionConflict) {
                const latest = queryClient.getQueryData<CheckoutFlowSettingsPayload>(queryKeys.settings.checkoutFlow());
                if (latest && latest.revision > editor.revision) {
                    const latestValues = readCheckoutFlowValues(latest);
                    const mergedSubmitted = rebaseCheckoutFlowDraft({
                        base: editor.saved,
                        local: submitted,
                        latest: latestValues,
                    });
                    setEditor((current) => ({
                        saved: latestValues,
                        draft: rebaseCheckoutFlowDraft({
                            base: submitted,
                            local: current?.draft ?? submitted,
                            latest: mergedSubmitted,
                        }),
                        revision: latest.revision,
                    }));
                }
                toast.error(getServerFnError(err, "Failed to save checkout flow settings"));
                return;
            }

            setConflict({
                submitted,
                currentRevision: revisionConflict.currentRevision,
                latest: null,
                loading: true,
                loadFailed: false,
            });
            toast.error("Checkout settings changed in another tab. Your unsaved values are still here.");
            try {
                const latest = await getCheckoutFlowSettings();
                setConflict({
                    submitted,
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
            setConflict({ ...conflict, currentRevision: latest.revision, latest, loading: false, loadFailed: false });
        } catch {
            setConflict((current) => current ? { ...current, loading: false, loadFailed: true } : current);
        }
    };

    const mergeConflict = () => {
        if (!editor || !conflict?.latest) return;
        const latestValues = readCheckoutFlowValues(conflict.latest);
        const mergedSubmitted = rebaseCheckoutFlowDraft({
            base: editor.saved,
            local: conflict.submitted,
            latest: latestValues,
        });
        setEditor({
            saved: latestValues,
            draft: rebaseCheckoutFlowDraft({
                base: conflict.submitted,
                local: editor.draft,
                latest: mergedSubmitted,
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
            <SkeletonPage
                showHeader={false}
                sections={3}
                rowsPerSection={2}
                label="Loading checkout flow"
            />
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
                        className="min-h-11 sm:min-h-9"
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
        <ContextualSaveBar
            isDirty={isDirty || saving || Boolean(conflict)}
            saving={saving}
            saveDisabled={saveBlocked}
            saveDisabledReason={saveDisabledReason}
            saveLabel="Save checkout flow"
            allowSamePathNavigation
            // The settings section picker is sticky on narrow widths.
            stickyClassName="sticky top-15 z-30 lg:top-0"
            onDiscard={resetFlow}
            onSave={() => void handleSubmit()}
        />
        <form
            method="post"
            onSubmit={handleSubmit}
            className="max-w-5xl space-y-6"
            noValidate
        >
            {checkoutSettingsStale && (
                <Alert className="border-amber-500/30 bg-amber-500/5">
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                    <AlertDescription className="flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                        <span>The last saved checkout flow is still shown, but its current revision could not be refreshed. Your draft is preserved and saving is locked.</span>
                        <Button type="button" variant="outline" size="sm" className="min-h-11 shrink-0 sm:min-h-9" onClick={() => void refetch()} disabled={isFetching}>
                            {isFetching && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                            Refresh saved flow
                        </Button>
                    </AlertDescription>
                </Alert>
            )}

            <SettingsSection
                title="Customer access"
                description="Decides whether a buyer needs a store account before they can place an order."
            >
                <div className="space-y-3">
                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 space-y-0.5">
                            <Label htmlFor="guest-checkout">Allow checkout without an account</Label>
                            <InlineHelp id="guest-checkout-help">
                                Customers enter contact and delivery details without a password.
                            </InlineHelp>
                        </div>
                        <label htmlFor="guest-checkout" className="flex min-h-11 min-w-11 shrink-0 items-center justify-end">
                            <Switch
                                id="guest-checkout"
                                aria-describedby="guest-checkout-help"
                                checked={guestCheckoutEnabled}
                                onCheckedChange={(value) => updateDraft("guestCheckoutEnabled", value)}
                            />
                        </label>
                    </div>
                    <div className="flex items-start gap-2.5 rounded-md bg-muted/45 px-3 py-2.5">
                        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-foreground" aria-hidden="true" />
                        <InlineHelp>
                            <span className="font-medium text-foreground">Phone number is always required.</span>
                        </InlineHelp>
                    </div>
                </div>
            </SettingsSection>

            <SettingsSection
                title="Payment flow"
                description="Sets which payment methods buyers can reach at checkout."
            >
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
                                className={`flex min-h-11 cursor-pointer items-start gap-2 rounded-md border p-3 transition-colors ${
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
            </SettingsSection>

            <SettingsSection
                title="Advance collection"
                description="Collects a fixed amount online and leaves the remaining balance due on delivery."
            >
                <div className="space-y-4">
                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 space-y-0.5">
                            <Label htmlFor="advance-payment">Require an online advance</Label>
                            <InlineHelp id="advance-payment-help">
                                Buyers choose an online gateway. COD is hidden as a checkout method, while the balance remains due on delivery.
                            </InlineHelp>
                        </div>
                        <label htmlFor="advance-payment" className="flex min-h-11 min-w-11 shrink-0 items-center justify-end">
                            <Switch
                                id="advance-payment"
                                aria-describedby="advance-payment-help"
                                checked={partialPaymentEnabled}
                                onCheckedChange={(value) => updateDraft("partialPaymentEnabled", value)}
                            />
                        </label>
                    </div>

                    {partialPaymentEnabled && (
                        <div className="space-y-3 border-l-2 border-primary/20 pl-4">
                            <div className="space-y-1.5">
                                <Label htmlFor="partial-payment-amount">Advance amount required</Label>
                                <Input
                                    id="partial-payment-amount"
                                    type="number"
                                    min={sslCommerzEnabled ? CHECKOUT_ADVANCE_PAYMENT_AMOUNT_LIMITS.min : 0.01}
                                    max={sslCommerzEnabled ? CHECKOUT_ADVANCE_PAYMENT_AMOUNT_LIMITS.max : undefined}
                                    step="0.01"
                                    className="min-h-11 w-full sm:min-h-9 sm:max-w-xs"
                                    placeholder="e.g. 200"
                                    value={partialPaymentAmount}
                                    onChange={(e) => updateDraft("partialPaymentAmount", Number(e.target.value))}
                                    aria-invalid={Boolean(partialPaymentAmountIssue)}
                                    aria-describedby={partialPaymentAmountIssue
                                        ? "partial-payment-amount-help partial-payment-amount-error"
                                        : "partial-payment-amount-help"}
                                />
                                <InlineHelp id="partial-payment-amount-help">
                                    Carts at or below this amount are charged in full online. {sslCommerzEnabled
                                        ? `Because SSLCommerz is enabled, the amount must stay between ${CHECKOUT_ADVANCE_PAYMENT_AMOUNT_RANGE_LABEL}.`
                                        : "The amount uses your store currency."}
                                </InlineHelp>
                                <FieldError id="partial-payment-amount-error">
                                    {partialPaymentAmountIssue}
                                </FieldError>
                            </div>
                        </div>
                    )}
                </div>
            </SettingsSection>

            <SettingsSection
                title="Checkout readiness"
                description={flowSummary}
                actions={
                    <StatusBadge tone={previewSummary.tone} srLabel="Checkout readiness:">
                        {previewSummary.label}
                    </StatusBadge>
                }
            >
                <div className="space-y-3">
                    <div className="grid gap-2">
                        <ReadinessRow
                            label="Payment flow"
                            ready={paymentMethodsUnavailable ? undefined : flowIssues.length === 0}
                            loading={paymentMethodsPending}
                            unknown={paymentMethodsUnavailable}
                            icon={Wallet}
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
                                    className="min-h-11 shrink-0 sm:min-h-9"
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
                                    className="min-h-11 shrink-0 sm:min-h-9"
                                >
                                    {checkoutReadinessFetching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                    Retry check
                                </Button>
                            </AlertDescription>
                        </Alert>
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
                </div>
            </SettingsSection>

            {conflict && (
                <Alert className="border-amber-500/40 bg-amber-500/5">
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
                                    <Button type="button" size="sm" className="min-h-11 sm:min-h-9" onClick={mergeConflict}>
                                        Merge my changes
                                    </Button>
                                    <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={useLatest}>
                                        Use latest saved version
                                    </Button>
                                </>
                            ) : (
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="min-h-11 sm:min-h-9"
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

            <p className="text-xs text-muted-foreground" aria-live="polite" data-testid="checkout-flow-revision-status">
                {conflict
                    ? "Resolve the newer saved version before saving"
                    : isDirty
                        ? `Unsaved checkout changes · based on revision ${editor?.revision ?? "—"}`
                        : `Checkout flow is saved · revision ${editor?.revision ?? "—"}`}
            </p>
        </form>
        </>
    );
}
