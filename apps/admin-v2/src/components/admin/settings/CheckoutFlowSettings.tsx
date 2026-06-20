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
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { CheckCircle2, Loader2, MapPinned, Save, Truck, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getServerFnError } from "@/lib/api-helpers";
import {
    updateAuthSettings,
    type CheckoutReadinessPayload,
    type PaymentMethodsPayload,
} from "@/lib/api-functions/settings";
import {
    checkoutFlowSettingsQueryOptions,
    checkoutReadinessQueryOptions,
    paymentMethodsQueryOptions,
} from "@/lib/api-query-options/settings";
import { queryKeys } from "@/lib/query-keys";

function buildCheckoutFlowSummary(options: {
    guestCheckoutEnabled: boolean;
    checkoutMode: string;
    partialPaymentEnabled: boolean;
    partialPaymentAmount: number;
}): string {
    if (options.partialPaymentEnabled) {
        return `Customers pay ৳${options.partialPaymentAmount || 0} online first. COD is hidden at checkout while this is on.`;
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
    return (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2 text-sm">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{label}</span>
            </div>
            {loading ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            ) : ready ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
            ) : unknown ? (
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
            ) : (
                <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
            )}
        </div>
    );
}

export default function CheckoutFlowSettings() {
    const queryClient = useQueryClient();
    const {
        data: authSettings,
        isLoading,
        isError,
        refetch,
    } = useQuery(checkoutFlowSettingsQueryOptions());
    const { data: paymentMethods, isLoading: paymentMethodsLoading } = useQuery(paymentMethodsQueryOptions());
    const {
        data: checkoutReadiness,
        isLoading: checkoutReadinessLoading,
        isFetching: checkoutReadinessFetching,
        isError: checkoutReadinessError,
        error: checkoutReadinessQueryError,
        refetch: refetchCheckoutReadiness,
    } = useQuery(checkoutReadinessQueryOptions());
    const [saving, setSaving] = useState(false);

    const [guestCheckoutEnabled, setGuestCheckoutEnabled] = useState(true);
    const [checkoutMode, setCheckoutMode] = useState<string>("all");
    const [partialPaymentEnabled, setPartialPaymentEnabled] = useState(false);
    const [partialPaymentAmount, setPartialPaymentAmount] = useState<number>(0);

    useEffect(() => {
        if (!authSettings) return;
        setGuestCheckoutEnabled(authSettings.guestCheckoutEnabled !== false);
        setCheckoutMode(authSettings.checkoutMode || "all");
        setPartialPaymentEnabled(!!authSettings.partialPaymentEnabled);
        setPartialPaymentAmount(authSettings.partialPaymentAmount || 0);
    }, [authSettings]);

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

    const flowIssues = useMemo(() => {
        const issues: string[] = [];
        if (paymentMethods && checkoutMode === "guest_cod_only" && !codEnabled) {
            issues.push("Enable Cash on Delivery in Payment Gateways before using Fast COD Only.");
        }
        if (paymentMethods && checkoutMode === "gateways_only" && activeOnlineMethods.length === 0) {
            issues.push("Enable and configure at least one online gateway in Payment Gateways.");
        }
        if (!partialPaymentEnabled) return issues;
        if (!Number.isFinite(partialPaymentAmount) || partialPaymentAmount <= 0) {
            issues.push("Set an advance amount greater than 0.");
        }
        if (checkoutMode === "guest_cod_only") {
            issues.push("Fast COD Only cannot be used with advance payments.");
        }
        if (paymentMethods && activeOnlineMethods.length === 0) {
            issues.push("Advance payments need at least one enabled and configured online gateway.");
        }
        return issues;
    }, [activeOnlineMethods.length, checkoutMode, codEnabled, partialPaymentAmount, partialPaymentEnabled, paymentMethods]);

    const flowSummary = buildCheckoutFlowSummary({
        guestCheckoutEnabled,
        checkoutMode,
        partialPaymentEnabled,
        partialPaymentAmount,
    });
    const readiness = checkoutReadiness as CheckoutReadinessPayload | undefined;
    const readinessIssues = readiness?.issues ?? [];
    const previewIssues = [...flowIssues, ...readinessIssues];
    const readinessPending = checkoutReadinessLoading || (checkoutReadinessFetching && !readiness);
    const previewLoading = paymentMethodsLoading || readinessPending;
    const readinessUnknown = !readiness && !readinessPending;
    const readinessCheckUnavailable = !readinessPending && (checkoutReadinessError || readinessUnknown);
    const readinessErrorMessage = checkoutReadinessQueryError instanceof Error
        ? checkoutReadinessQueryError.message
        : null;
    const previewCardClass = previewIssues.length > 0
        ? "border-destructive/40 bg-destructive/5"
        : readinessCheckUnavailable
            ? "border-amber-500/30 bg-amber-500/5"
            : "border-emerald-500/30 bg-emerald-500/5";

    const handleSubmit = async (e?: React.SyntheticEvent) => {
        e?.preventDefault();
        if (flowIssues.length > 0) return;
        setSaving(true);

        const nextSettings = {
            guestCheckoutEnabled,
            checkoutMode,
            partialPaymentEnabled,
            partialPaymentAmount,
        };

        try {
            await updateAuthSettings({
                data: nextSettings,
            });
            queryClient.setQueryData(
                queryKeys.settings.checkoutFlow(),
                (current: Record<string, unknown> | undefined) => ({
                    ...(current ?? {}),
                    ...nextSettings,
                }),
            );
            await queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutFlow() });
            await queryClient.invalidateQueries({ queryKey: queryKeys.settings.checkoutReadiness() });
            toast.success("Checkout flow settings saved successfully!");
        } catch (err) {
            toast.error(getServerFnError(err, "Failed to save checkout flow settings"));
        } finally {
            setSaving(false);
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (isError && !authSettings) {
        return (
            <Alert className="max-w-2xl border-destructive/30 bg-destructive/5">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                <AlertDescription className="flex items-center justify-between gap-4 text-sm">
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
        <div className="space-y-5 max-w-2xl">
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Guest Checkout</CardTitle>
                    <CardDescription>
                        Allow customers to place orders without creating an account.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label>Enable Guest Checkout</Label>
                            <p className="text-xs text-muted-foreground">
                                When enabled, customers can checkout without logging in (subject to the Checkout Mode below).
                            </p>
                        </div>
                        <Switch
                            checked={guestCheckoutEnabled}
                            onCheckedChange={setGuestCheckoutEnabled}
                        />
                    </div>
                </CardContent>
            </Card>

            <Card className={previewCardClass}>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                        {previewIssues.length > 0 ? (
                            <AlertTriangle className="h-4 w-4 text-destructive" />
                        ) : readinessCheckUnavailable ? (
                            <AlertTriangle className="h-4 w-4 text-amber-500" />
                        ) : (
                            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                        )}
                        Customer flow preview
                    </CardTitle>
                    <CardDescription>{flowSummary}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pt-0">
                    <div className="grid gap-2">
                        <ReadinessRow
                            label="Payment flow"
                            ready={flowIssues.length === 0}
                            loading={paymentMethodsLoading}
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
                    </div>
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
                            <ul className="space-y-1 text-sm text-destructive">
                                {previewIssues.map((issue) => (
                                    <li key={issue}>{issue}</li>
                                ))}
                            </ul>
                            )}
                        </>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Checkout Mode</CardTitle>
                    <CardDescription>
                        Determine which payment flows and methods are available to customers at checkout.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="space-y-1.5">
                        <Label>Available Payment Flows</Label>
                        <p className="text-xs text-muted-foreground mb-1.5">
                            Controls which payment options customers see during checkout.
                        </p>
                        <Select
                            value={checkoutMode}
                            onValueChange={(val) => setCheckoutMode(val)}
                        >
                            <SelectTrigger className="w-full max-w-xs">
                                <SelectValue placeholder="Select checkout mode" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">Standard (COD and online methods allowed)</SelectItem>
                                <SelectItem value="guest_cod_only">
                                    {guestCheckoutEnabled ? "Fast COD Only (Direct from Cart)" : "Authenticated COD Only (No online payment)"}
                                </SelectItem>
                                <SelectItem value="gateways_only">Online Gateways Only (No COD)</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Partial Payment / Advance Deposit</CardTitle>
                    <CardDescription>
                        Collect a fixed online advance payment before order confirmation. COD is hidden at checkout while this is on.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label>Enable Partial Payment</Label>
                            <p className="text-xs text-muted-foreground">
                                When enabled, customers must pay a flat advance amount via an online gateway before their order is confirmed.
                            </p>
                        </div>
                        <Switch
                            checked={partialPaymentEnabled}
                            onCheckedChange={setPartialPaymentEnabled}
                        />
                    </div>

                    {partialPaymentEnabled && (
                        <div className="space-y-3 pl-4 border-l-2 border-primary/20">
                            <div className="space-y-1.5">
                                <Label htmlFor="partial-payment-amount">Advance Amount Required</Label>
                                <Input
                                    id="partial-payment-amount"
                                    type="number"
                                    min="0"
                                    className="max-w-xs"
                                    placeholder="e.g. 200"
                                    value={partialPaymentAmount}
                                    onChange={(e) => setPartialPaymentAmount(Number(e.target.value))}
                                />
                                <p className="text-xs text-muted-foreground mt-1">
                                    Must be greater than 0 and charged through an online gateway. Carts at or below this amount pay the full total online.
                                </p>
                            </div>

                            {partialPaymentAmount === 0 && (
                                <Alert className="border-amber-500/30 bg-amber-500/5">
                                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                                    <AlertDescription className="text-sm text-amber-700 dark:text-amber-400">
                                        Partial payment is enabled but the amount is set to 0. Customers will not be charged any advance deposit.
                                    </AlertDescription>
                                </Alert>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>

            <div className="flex justify-end pt-4 border-t border-border">
                <Button
                    onClick={() => handleSubmit()}
                    disabled={saving || flowIssues.length > 0}
                    className="min-w-[140px]"
                >
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    <Save className="mr-2 h-4 w-4" />
                    Save Settings
                </Button>
            </div>
        </div>
    );
}
