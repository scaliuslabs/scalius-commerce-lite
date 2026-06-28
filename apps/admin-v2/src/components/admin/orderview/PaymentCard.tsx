// src/components/admin/orderview/PaymentCard.tsx
// Shows payment status, transaction history, and COD management for an order.

import React from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { useCurrency } from "@/hooks/use-currency";
import {
  CreditCard,
  Banknote,
  CheckCircle2,
  AlertTriangle,
  Clock,
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronUp,
  ReceiptText,
} from "lucide-react";
import type { ActiveRefundOperation, Order, OrderRefundAttempt, OrderTimestamp } from "./types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  orderCodQueryOptions,
  orderPaymentsQueryOptions,
} from "@/lib/api-query-options/orders";
import { ORDER_DETAIL_PREFETCH_STALE_MS } from "@/lib/order-detail-prefetch";
import { queryKeys } from "@/lib/query-keys";
import { useUpdateOrderCod, useRefundOrder } from "@/lib/api-mutations/orders";
import type { UpdateOrderCodInput } from "@/lib/api-functions/orders";
import { useOrderActionPermissions } from "@/hooks/use-order-action-permissions";
import { formatOrderAmount, formatOrderTimestamp } from "./formatters";
import { useHydrated } from "@/hooks/use-hydrated";

type CodFailureReason = Extract<
  UpdateOrderCodInput,
  { action: "failed" }
>["reason"];

interface OrderPayment {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  paymentType: string;
  status: string;
  stripePaymentIntentId: string | null;
  stripeChargeId: string | null;
  sslcommerzTranId: string | null;
  sslcommerzValId: string | null;
  sslcommerzBankTranId: string | null;
  polarCheckoutId: string | null;
  codCollectedBy: string | null;
  codCollectedAt: number | null;
  codReceiptUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

interface PaymentPlan {
  id: string;
  totalAmount: number;
  depositAmount: number;
  balanceDue: number;
  depositPaidAt: number | null;
  balancePaidAt: number | null;
  balanceDueDate: string | null;
  status: string;
}

interface OrderPaymentsResult {
  payments: OrderPayment[];
  plan: PaymentPlan | null;
  refundAttempts?: OrderRefundAttempt[];
  activeRefundOperation?: ActiveRefundOperation | null;
  paymentWebhookIssues?: PaymentWebhookIssue[];
}

interface PaymentWebhookIssue {
  id: string;
  provider: string;
  eventType: string;
  status: "failed" | "manual_reconciliation";
  message: string;
  error: string | null;
  queueType: string | null;
  queueMessageId: string | null;
  processedAt: OrderTimestamp;
}

interface CODTracking {
  id: string;
  deliveryAttempts: number;
  lastAttemptAt: number | null;
  codStatus: string;
  failureReason: string | null;
  collectedBy: string | null;
  collectedAmount: number | null;
  collectedAt: number | null;
  receiptUrl: string | null;
}

const PAYMENT_STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ElementType }> = {
  unpaid: { label: "Unpaid", variant: "destructive", icon: AlertTriangle },
  partial: { label: "Partial", variant: "secondary", icon: Clock },
  paid: { label: "Paid", variant: "default", icon: CheckCircle2 },
  refunded: { label: "Refunded", variant: "outline", icon: RefreshCw },
  failed: { label: "Failed", variant: "destructive", icon: AlertTriangle },
};

const COD_STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "Pending", variant: "secondary" },
  collected: { label: "Collected", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
  returned: { label: "Returned", variant: "outline" },
};

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  stripe: "Stripe",
  sslcommerz: "SSLCommerz",
  cod: "Cash on Delivery",
  polar: "Polar",
};

const REFUND_SEVERITY_CLASS: Record<string, string> = {
  info: "border-sky-200 bg-sky-50 text-sky-950 dark:border-sky-900/40 dark:bg-sky-950/30 dark:text-sky-100",
  success: "border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-100",
  warning: "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100",
  danger: "border-red-200 bg-red-50 text-red-950 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-100",
};

function formatTimestamp(value: OrderTimestamp | null | undefined): string | null {
  return formatOrderTimestamp(value);
}

function formatRefundReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return reason
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function refundTimestampLabel(attempt: OrderRefundAttempt): string | null {
  const settledAt = formatTimestamp(attempt.refundedAt);
  if (settledAt) return `Settled ${settledAt}`;

  const failedAt = formatTimestamp(attempt.failedAt);
  if (failedAt) return `Failed ${failedAt}`;

  const nextProbeAt = formatTimestamp(attempt.nextProbeAt);
  if (nextProbeAt) return `Next check ${nextProbeAt}`;

  const lastProbeAt = formatTimestamp(attempt.lastProbeAt);
  if (lastProbeAt) return `Last checked ${lastProbeAt}`;

  return formatTimestamp(attempt.createdAt);
}

function paymentReferences(payment: OrderPayment): Array<{ label: string; value: string }> {
  return [
    { label: "Payment row", value: payment.id },
    { label: "Stripe intent", value: payment.stripePaymentIntentId ?? "" },
    { label: "Stripe charge", value: payment.stripeChargeId ?? "" },
    { label: "SSL tran", value: payment.sslcommerzTranId ?? "" },
    { label: "SSL val", value: payment.sslcommerzValId ?? "" },
    { label: "SSL bank tran", value: payment.sslcommerzBankTranId ?? "" },
    { label: "Polar checkout", value: payment.polarCheckoutId ?? "" },
  ].filter((entry) => entry.value);
}

interface PaymentCardProps {
  order: Order;
}

export function PaymentCard({ order }: PaymentCardProps) {
  const queryClient = useQueryClient();
  const { symbol } = useCurrency();
  const isHydrated = useHydrated();
  const orderActions = useOrderActionPermissions();
  const canRefund = orderActions.canRefundOrders;
  const canUpdateCod = orderActions.canUpdateOrderCod;
  const [historyExpanded, setHistoryExpanded] = React.useState(false);

  // Refund state
  const [isRefundDialogOpen, setIsRefundDialogOpen] = React.useState(false);
  const [refundAmount, setRefundAmount] = React.useState("");
  const [refundReason, setRefundReason] = React.useState("requested_by_customer");

  // COD modal state
  const [codAction, setCodAction] = React.useState<"collected" | "failed" | "returned" | null>(null);
  const [collectedBy, setCollectedBy] = React.useState("");
  const [collectedAmount, setCollectedAmount] = React.useState("");
  const [failReason, setFailReason] =
    React.useState<CodFailureReason>("not_home");
  const [failNotes, setFailNotes] = React.useState("");

  // totalAmount already includes shipping and discount (computed server-side)
  const grandTotal = order.totalAmount;
  const isCOD = order.paymentMethod === "cod";

  // Payment history is optional secondary data. Keep it local so failures do
  // not replace the rest of the order workspace with the page error boundary.
  const {
    data: paymentsData,
    isLoading: paymentsLoading,
    isError: paymentsError,
    isFetching: paymentsFetching,
    refetch: refetchPayments,
  } = useQuery({
    ...orderPaymentsQueryOptions(order.id),
    enabled: isHydrated,
    staleTime: ORDER_DETAIL_PREFETCH_STALE_MS,
  });
  const paymentsResult = paymentsData as OrderPaymentsResult | null;
  const payments = paymentsResult?.payments ?? [];
  const plan = paymentsResult?.plan ?? null;
  const refundAttempts = paymentsResult?.refundAttempts ?? order.refundAttempts ?? [];
  const activeRefundOperation = paymentsResult?.activeRefundOperation ?? order.activeRefundOperation ?? null;
  const paymentWebhookIssues = paymentsResult?.paymentWebhookIssues ?? [];
  const paymentWebhookIssueViews = paymentWebhookIssues.map((issue) => ({
    ...issue,
    label: issue.status === "manual_reconciliation" ? "manual review" : "failed",
    title: issue.status === "manual_reconciliation" ? "Payment webhook needs review" : "Payment webhook failed",
    processedLabel: formatTimestamp(issue.processedAt),
  }));
  const latestPaymentWebhookIssue = paymentWebhookIssueViews[0];
  const olderPaymentWebhookIssues = paymentWebhookIssueViews.slice(1);
  const isRefundLocked = Boolean(activeRefundOperation?.active);

  // COD data — conditionally fetch (useQuery, not suspense, since it's optional)
  const { data: codData } = useQuery({
    ...orderCodQueryOptions(order.id),
    enabled: isHydrated && isCOD,
    staleTime: ORDER_DETAIL_PREFETCH_STALE_MS,
  });
  const codTracking = isCOD ? ((codData as { tracking: CODTracking | null } | null)?.tracking ?? null) : null;

  // Mutations
  const codMutation = useUpdateOrderCod();
  const refundMutation = useRefundOrder();

  function submitCODAction() {
    if (!codAction) return;
    if (!canUpdateCod) {
      toast.error("COD update unavailable", {
        description: "Your role can view orders but cannot update COD status.",
      });
      return;
    }
    if (isRefundLocked) {
      toast.error("Order locked", { description: "Complete or reconcile the active refund before changing COD status." });
      return;
    }

    if (codAction === "collected") {
      if (!collectedBy.trim()) {
        toast.error("Error", { description: "Collector name is required." });
        return;
      }
      const amount = parseFloat(collectedAmount);
      if (isNaN(amount) || amount <= 0) {
        toast.error("Error", { description: "Valid amount is required." });
        return;
      }
    }

    let body: UpdateOrderCodInput;
    if (codAction === "collected") {
      body = {
        orderId: order.id,
        action: "collected",
        collectedBy: collectedBy.trim(),
        collectedAmount: parseFloat(collectedAmount),
      };
    } else if (codAction === "failed") {
      body = {
        orderId: order.id,
        action: "failed",
        reason: failReason,
        ...(failNotes.trim() ? { notes: failNotes.trim() } : {}),
      };
    } else {
      body = { orderId: order.id, action: "returned" };
    }

    codMutation.mutate(body, {
      onSuccess: () => {
        const messages: Record<string, string> = {
          collected: "COD collection recorded.",
          failed: "Delivery failure recorded.",
          returned: "Order marked as returned.",
        };
        toast.success("Success", { description: messages[codAction!] });
        setCodAction(null);
      },
    });
  }

  function handleIssueRefund() {
    if (isRefundLocked) {
      toast.error("Refund locked", { description: "Complete or reconcile the active refund before starting another refund." });
      return;
    }
    const amount = parseFloat(refundAmount);
    if (isNaN(amount) || amount <= 0 || amount > (order.paidAmount ?? 0)) {
      toast.error("Error", { description: "Valid refund amount up to the paid amount is required." });
      return;
    }
    if (!refundReason.trim()) {
      toast.error("Error", { description: "Refund reason is required." });
      return;
    }

    refundMutation.mutate(
      { orderId: order.id, amount, reason: refundReason },
      {
        onSuccess: () => {
          toast.success("Refund Issued", { description: `Successfully initiated refund of ${symbol}${amount}.` });
          setIsRefundDialogOpen(false);
          // Invalidate order detail to refresh payment status
          queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(order.id) });
        },
      },
    );
  }

  const paymentStatusCfg = PAYMENT_STATUS_CONFIG[order.paymentStatus ?? "unpaid"] ?? PAYMENT_STATUS_CONFIG.unpaid;
  const PaymentStatusIcon = paymentStatusCfg.icon;

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader className="border-b border-border bg-muted/5 px-4 py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard className="h-4 w-4" />
            Payment
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 space-y-4">
          {activeRefundOperation && (
            <div
              role="status"
              className={`rounded-lg border p-3 text-sm ${REFUND_SEVERITY_CLASS[activeRefundOperation.severity] ?? REFUND_SEVERITY_CLASS.info}`}
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
	                  <p className="font-semibold">{activeRefundOperation.label}</p>
	                  <p className="mt-1 opacity-90">{activeRefundOperation.message}</p>
	                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs opacity-80">
	                    <span>{activeRefundOperation.currency} {formatOrderAmount(activeRefundOperation.amount)}</span>
	                    <span>{activeRefundOperation.attemptCount} allocation{activeRefundOperation.attemptCount === 1 ? "" : "s"}</span>
	                    {activeRefundOperation.reason && <span>Reason: {formatRefundReason(activeRefundOperation.reason)}</span>}
	                    {activeRefundOperation.refundReference && <span className="font-mono">Ref {activeRefundOperation.refundReference}</span>}
	                    {activeRefundOperation.providerRefundId && <span className="font-mono">Provider {activeRefundOperation.providerRefundId}</span>}
	                    {activeRefundOperation.providerCorrelationId && <span className="font-mono">Correlation {activeRefundOperation.providerCorrelationId}</span>}
	                    {activeRefundOperation.nextProbeAt && <span>Next check {formatTimestamp(activeRefundOperation.nextProbeAt)}</span>}
	                  </div>
	                </div>
              </div>
            </div>
          )}

          {/* Payment method + status */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              {isCOD ? (
                <Banknote className="h-4 w-4 text-muted-foreground" />
              ) : (
                <CreditCard className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="font-medium">
                {PAYMENT_METHOD_LABELS[order.paymentMethod ?? "cod"] ?? order.paymentMethod}
              </span>
            </div>
            <Badge variant={paymentStatusCfg.variant} className="gap-1 text-xs">
              <PaymentStatusIcon className="h-3 w-3" />
              {paymentStatusCfg.label}
            </Badge>
          </div>

          {/* Amount breakdown */}
          <div className="space-y-1.5 text-sm rounded-lg bg-muted/30 p-3">
            {(order.shippingCharge > 0 || (order.discountAmount ?? 0) > 0) && (
              <div className="flex justify-between text-muted-foreground">
                <span>Subtotal</span>
                <span>{symbol}{formatOrderAmount(order.totalAmount - order.shippingCharge + (order.discountAmount ?? 0))}</span>
              </div>
            )}
            {order.shippingCharge > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>Shipping</span>
                <span>{symbol}{formatOrderAmount(order.shippingCharge)}</span>
              </div>
            )}
            {(order.discountAmount ?? 0) > 0 && (
              <div className="flex justify-between text-green-600">
                <span>Discount</span>
                <span>-{symbol}{formatOrderAmount(order.discountAmount ?? 0)}</span>
              </div>
            )}
            <div className="flex justify-between font-semibold border-t border-border pt-1.5 mt-1.5">
              <span>Total</span>
              <span>{symbol}{formatOrderAmount(grandTotal)}</span>
            </div>
            {(order.paidAmount ?? 0) > 0 && (
              <div className="flex justify-between text-green-600">
                <span>Paid</span>
                <span>{symbol}{formatOrderAmount(order.paidAmount ?? 0)}</span>
              </div>
            )}
            {(order.balanceDue ?? 0) > 0 && (
              <div className="flex justify-between text-amber-600 font-medium">
                <span>Balance due</span>
                <span>{symbol}{formatOrderAmount(order.balanceDue ?? 0)}</span>
              </div>
            )}
          </div>

          {/* Payment plan */}
          {plan && (
            <div className="text-sm space-y-1 rounded-lg border border-border p-3">
              <div className="font-medium text-xs text-muted-foreground uppercase tracking-wide mb-2">Payment Plan</div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Deposit</span>
                <span className={plan.depositPaidAt ? "text-green-600" : "text-amber-600"}>
                  {symbol}{formatOrderAmount(plan.depositAmount)} {plan.depositPaidAt ? "✓" : "(pending)"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Balance</span>
                <span className={plan.balancePaidAt ? "text-green-600" : "text-amber-600"}>
                  {symbol}{formatOrderAmount(plan.balanceDue)} {plan.balancePaidAt ? "✓" : plan.balanceDueDate ? `due ${plan.balanceDueDate}` : "(pending)"}
                </span>
              </div>
            </div>
          )}

          {(!isHydrated || paymentsLoading) && (
            <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
              Loading payment history...
            </div>
          )}

          {isHydrated && paymentsError && (
            <div
              role="status"
              className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">Payment history unavailable</p>
                  <p className="mt-1 text-amber-800 dark:text-amber-300">
                    The order summary is still usable. Retry before reviewing
                    transaction records or provider references.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={() => void refetchPayments()}
                  disabled={paymentsFetching}
                >
                  {paymentsFetching && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                  Retry
                </Button>
              </div>
            </div>
          )}

          {latestPaymentWebhookIssue && (
            <div
              role="status"
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-950 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-100"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold">{latestPaymentWebhookIssue.title}</p>
                      <p className="mt-1 opacity-90">
                        Check the gateway dashboard before changing payment-sensitive order state.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 border-red-300 bg-white/60 px-2 text-xs text-red-950 hover:bg-red-100 dark:border-red-900/50 dark:bg-black/10 dark:text-red-100"
                      onClick={() => void refetchPayments()}
                      disabled={paymentsFetching}
                    >
                      {paymentsFetching && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                      Refresh
                    </Button>
                  </div>
                  <div className="rounded-md border border-red-200/70 bg-white/50 p-2 dark:border-red-900/40 dark:bg-black/10">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {PAYMENT_METHOD_LABELS[latestPaymentWebhookIssue.provider] ?? latestPaymentWebhookIssue.provider}
                      </span>
                      <Badge variant="destructive" className="text-[10px]">
                        {latestPaymentWebhookIssue.label}
                      </Badge>
                      <span className="font-mono text-[11px] opacity-80">{latestPaymentWebhookIssue.eventType}</span>
                    </div>
                    <p className="mt-1 opacity-90">{latestPaymentWebhookIssue.message}</p>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 opacity-75">
                      {latestPaymentWebhookIssue.processedLabel && <span>{latestPaymentWebhookIssue.processedLabel}</span>}
                      {latestPaymentWebhookIssue.queueType && <span className="font-mono">{latestPaymentWebhookIssue.queueType}</span>}
                      {latestPaymentWebhookIssue.queueMessageId && <span className="font-mono">{latestPaymentWebhookIssue.queueMessageId}</span>}
                    </div>
                  </div>
                  {olderPaymentWebhookIssues.length > 0 && (
                    <div className="space-y-1">
                      {olderPaymentWebhookIssues.map((issue) => (
                        <div key={issue.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-red-200/60 bg-white/30 px-2 py-1 dark:border-red-900/30 dark:bg-black/10">
                          <span className="font-medium">
                            {PAYMENT_METHOD_LABELS[issue.provider] ?? issue.provider}
                          </span>
                          <Badge variant="destructive" className="text-[10px]">{issue.label}</Badge>
                          <span className="font-mono text-[11px] opacity-80">{issue.eventType}</span>
                          {issue.processedLabel && <span className="opacity-70">{issue.processedLabel}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* COD tracking */}
          {isHydrated && isCOD && (
            <div className="space-y-2">
              {codTracking && (
                <div className="text-sm space-y-1 rounded-lg bg-muted/30 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">COD Status</span>
                    <Badge variant={COD_STATUS_CONFIG[codTracking.codStatus]?.variant ?? "secondary"} className="text-xs">
                      {COD_STATUS_CONFIG[codTracking.codStatus]?.label ?? codTracking.codStatus}
                    </Badge>
                  </div>
                  {codTracking.deliveryAttempts > 0 && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>Delivery attempts</span>
                      <span>{codTracking.deliveryAttempts}</span>
                    </div>
                  )}
                  {codTracking.collectedBy && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>Collected by</span>
                      <span>{codTracking.collectedBy}</span>
                    </div>
                  )}
                  {codTracking.collectedAmount && (
                    <div className="flex justify-between text-green-600">
                      <span>Collected amount</span>
                      <span>{symbol}{formatOrderAmount(codTracking.collectedAmount)}</span>
                    </div>
                  )}
                  {codTracking.failureReason && (
                    <div className="flex justify-between text-destructive">
                      <span>Failure reason</span>
                      <span>{codTracking.failureReason.replace(/_/g, " ")}</span>
                    </div>
                  )}
                </div>
              )}

              {/* COD action buttons -- only when not yet collected/returned */}
              {canUpdateCod && (!codTracking || !["collected", "returned"].includes(codTracking.codStatus)) && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    disabled={isRefundLocked}
                    onClick={() => {
                      setCollectedBy("");
                      setCollectedAmount(String(grandTotal));
                      setCodAction("collected");
                    }}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                    Mark Collected
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isRefundLocked}
                    onClick={() => {
                      setFailReason("not_home");
                      setFailNotes("");
                      setCodAction("failed");
                    }}
                  >
                    <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                    Record Failure
                  </Button>
                  {codTracking && codTracking.deliveryAttempts > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={isRefundLocked}
                      onClick={() => setCodAction("returned")}
                    >
                      Return
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Refund action button */}
          {canRefund && (order.paidAmount ?? 0) > 0 && order.paymentStatus !== "refunded" && (
            <div className="flex justify-end pt-2">
              <Button
                variant="outline"
                size="sm"
                disabled={isRefundLocked}
                onClick={() => {
                  if (isRefundLocked) return;
                  setRefundAmount(String(order.paidAmount));
                  setRefundReason("requested_by_customer");
                  setIsRefundDialogOpen(true);
                }}
              >
                <RefreshCw className="h-3.5 w-3.5 mr-2" />
                {isRefundLocked ? "Refund locked" : "Issue Refund"}
              </Button>
            </div>
          )}

          {refundAttempts.length > 0 && (
            <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Refund operations</div>
              {refundAttempts.map((attempt) => {
                const timestampLabel = refundTimestampLabel(attempt);
                return (
                  <div key={attempt.id} className="flex items-start justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">{attempt.label}</span>
                        <Badge variant={attempt.severity === "danger" ? "destructive" : attempt.severity === "success" ? "default" : "secondary"} className="text-[10px]">
                          {attempt.status}
                        </Badge>
                      </div>
                      <p className="mt-1 text-muted-foreground">{attempt.message}</p>
                      {attempt.lastError && <p className="mt-1 truncate text-destructive">{attempt.lastError}</p>}
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                        {attempt.reason && <span>Reason: {formatRefundReason(attempt.reason)}</span>}
                        {attempt.refundReference && <span className="font-mono">Internal ref: {attempt.refundReference}</span>}
                        {attempt.providerRefundId && <span className="font-mono">Provider refund: {attempt.providerRefundId}</span>}
                        {attempt.providerCorrelationId && <span className="font-mono">Correlation: {attempt.providerCorrelationId}</span>}
                        {attempt.providerStatus && <span>Provider status: {attempt.providerStatus}</span>}
                        {attempt.sourcePaymentId && <span className="font-mono">Source: {attempt.sourcePaymentId}</span>}
                        {attempt.sourceTransactionId && <span className="font-mono">Source txn: {attempt.sourceTransactionId}</span>}
                        {attempt.refundPaymentId && <span className="font-mono">Refund row: {attempt.refundPaymentId}</span>}
                        {attempt.allocationCount && attempt.allocationCount > 1 && (
                          <span>Allocation {(attempt.allocationIndex ?? 0) + 1} of {attempt.allocationCount}</span>
                        )}
                        {attempt.attempts != null && attempt.attempts > 0 && <span>{attempt.attempts} probe attempt{attempt.attempts === 1 ? "" : "s"}</span>}
                        {timestampLabel && <span>{timestampLabel}</span>}
                      </div>
                    </div>
                    <span className="shrink-0 font-medium text-foreground">
                      {attempt.currency} {formatOrderAmount(attempt.amount)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Transaction history toggle */}
          {payments.length > 0 && (
            <button
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground w-full"
              onClick={() => setHistoryExpanded((v) => !v)}
            >
              <ReceiptText className="h-3.5 w-3.5" />
              {historyExpanded ? "Hide" : "Show"} transaction history ({payments.length})
              {historyExpanded ? <ChevronUp className="h-3 w-3 ml-auto" /> : <ChevronDown className="h-3 w-3 ml-auto" />}
            </button>
          )}

          {historyExpanded && (
            <div className="space-y-2">
              {payments.map((p) => (
                <div key={p.id} className="text-xs rounded-lg border border-border p-2.5 space-y-1">
                  <div className="flex justify-between items-center">
                    <span className="font-medium capitalize">{p.paymentType} payment</span>
                    <Badge
                      variant={p.status === "succeeded" ? "default" : p.status === "failed" ? "destructive" : "secondary"}
                      className="text-xs"
                    >
                      {p.status}
                    </Badge>
                  </div>
	                  <div className="flex justify-between text-muted-foreground">
	                    <span>{PAYMENT_METHOD_LABELS[p.paymentMethod] ?? p.paymentMethod}</span>
	                    <span className="font-medium text-foreground">
	                      {p.currency} {formatOrderAmount(p.amount)}
	                    </span>
	                  </div>
	                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
	                    {paymentReferences(p).map((reference) => (
	                      <span key={`${p.id}-${reference.label}`} className="min-w-0 truncate font-mono">
	                        {reference.label}: {reference.value}
	                      </span>
	                    ))}
	                    {p.codCollectedBy && <span>COD collector: {p.codCollectedBy}</span>}
	                    {formatTimestamp(p.codCollectedAt) && <span>COD collected: {formatTimestamp(p.codCollectedAt)}</span>}
	                  </div>
	                  {p.codReceiptUrl && (
	                    <a
	                      href={p.codReceiptUrl}
	                      target="_blank"
	                      rel="noreferrer"
	                      className="inline-flex text-muted-foreground underline underline-offset-2 hover:text-foreground"
	                    >
	                      COD receipt
	                    </a>
	                  )}
	                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* COD Collection Modal */}
      <Dialog open={codAction === "collected"} onOpenChange={(open) => !open && setCodAction(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Record COD Collection</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="collectedBy">Collected by</Label>
              <Input
                id="collectedBy"
                placeholder="Courier / agent name"
                value={collectedBy}
                onChange={(e) => setCollectedBy(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="collectedAmount">Amount collected ({symbol})</Label>
              <Input
                id="collectedAmount"
                type="number"
                value={collectedAmount}
                onChange={(e) => setCollectedAmount(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCodAction(null)}>Cancel</Button>
            <Button onClick={submitCODAction} disabled={codMutation.isPending || !canUpdateCod}>
              {codMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Confirm Collection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* COD Failure Modal */}
      <Dialog open={codAction === "failed"} onOpenChange={(open) => !open && setCodAction(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Record Delivery Failure</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="failReason">Reason</Label>
              <Select
                value={failReason}
                onValueChange={(value) =>
                  setFailReason(value as CodFailureReason)
                }
              >
                <SelectTrigger id="failReason">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="not_home">Customer not home</SelectItem>
                  <SelectItem value="refused">Customer refused</SelectItem>
                  <SelectItem value="no_cash">No cash available</SelectItem>
                  <SelectItem value="wrong_address">Wrong address</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="failNotes">Notes (optional)</Label>
              <Input
                id="failNotes"
                placeholder="Additional details..."
                value={failNotes}
                onChange={(e) => setFailNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCodAction(null)}>Cancel</Button>
            <Button variant="destructive" onClick={submitCODAction} disabled={codMutation.isPending || !canUpdateCod}>
              {codMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Record Failure
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* COD Return Confirmation */}
      <Dialog open={codAction === "returned"} onOpenChange={(open) => !open && setCodAction(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Mark as Returned</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            This will mark the order as returned to the merchant. This action cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCodAction(null)}>Cancel</Button>
            <Button variant="destructive" onClick={submitCODAction} disabled={codMutation.isPending || !canUpdateCod}>
              {codMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Mark Returned
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Refund Dialog */}
      <Dialog open={isRefundDialogOpen} onOpenChange={setIsRefundDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Issue Refund</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="text-sm text-muted-foreground p-3 bg-muted/50 rounded-md">
              {isRefundLocked ? (
                <span>Refund amount is locked while refund recovery is active.</span>
              ) : (
                <div className="flex justify-between">
                  <span>Maximum refundable:</span>
                  <span className="font-medium text-foreground">{symbol}{formatOrderAmount(order.paidAmount ?? 0)}</span>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="refundAmount">Refund Amount ({symbol})</Label>
              <Input
                id="refundAmount"
                type="number"
                step="0.01"
                min="0.01"
                max={order.paidAmount ?? 0}
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="refundReason">Reason</Label>
              <Select value={refundReason} onValueChange={setRefundReason}>
                <SelectTrigger id="refundReason">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="requested_by_customer">Customer Request</SelectItem>
                  <SelectItem value="duplicate">Duplicate Order</SelectItem>
                  <SelectItem value="fraudulent">Fraudulent</SelectItem>
                  <SelectItem value="out_of_stock">Out of Stock</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsRefundDialogOpen(false)} disabled={refundMutation.isPending}>
              Cancel
            </Button>
            <Button onClick={handleIssueRefund} disabled={refundMutation.isPending || isRefundLocked}>
              {refundMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Submit Refund
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
