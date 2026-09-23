import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { useCurrency } from "~/hooks/use-currency";
import { useHydrated } from "~/hooks/use-hydrated";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { orderDetailLabel, orderDetailMessages, type OrderDetailMessageKey } from "~/i18n/order-detail";
import {
  orderMessages,
  paymentMethodLabel,
  paymentStatusLabel,
} from "~/i18n/orders";
import { resourceMessages } from "~/i18n/resource";
import {
  orderCodQueryOptions,
  orderPaymentsQueryOptions,
  type OrderPaymentsPayload,
} from "~/lib/api-query-options/orders";
import {
  useIssueOrderPaymentRecoveryLink,
  useReconcileRefundAttempt,
  useRefundOrder,
  useUpdateOrderCod,
} from "~/lib/api-mutations/orders";
import type { postApiV1AdminOrdersByIdCod } from "@scalius/api-client/sdk";
import type { ApiBody } from "~/lib/api";
import { ORDER_DETAIL_PREFETCH_STALE_MS } from "~/lib/order-detail-prefetch";
import { resolveOrderOperationalReadState } from "~/lib/order-operational-read-state";
import {
  formatSavedMajorAmount,
  formatSavedMinorAmount,
  resolveSavedOrderMoneySummary,
} from "~/lib/order-tax-presentation";
import { buildOrderPaymentPresentation } from "~/lib/order-payment-presentation";
import { canProcessOrderCodAction } from "@scalius/shared/order-state";
import { formatCurrencyAmount, formatOrderTimestamp } from "./formatters";
import { OperationalReadNotice } from "./OperationalReadNotice";
import { statusBadgeVariant } from "./status-badges";
import type { Order, OrderRefundAttempt, OrderTimestamp } from "./types";

type CodAction = "collected" | "failed" | "returned";
type CodFailureReason = Extract<ApiBody<typeof postApiV1AdminOrdersByIdCod>, { action: "failed" }>["reason"];
type Payment = OrderPaymentsPayload["payments"][number];
type SessionAttempt = OrderPaymentsPayload["paymentSessionAttempts"][number];

const COD_FAILURE_REASONS: CodFailureReason[] = ["not_home", "refused", "no_cash", "wrong_address", "other"];
const REFUND_REASONS = ["requested_by_customer", "duplicate", "fraudulent", "out_of_stock"] as const;
const MANUAL_REFUND_CHECK_STATUSES = new Set(["processing", "provider_unknown", "reconcile_required", "pending"]);
const RECOVERY_LINK_GATEWAYS = new Set(["sslcommerz"]);

function isRecoveryLinkGateway(value: string | null | undefined): boolean {
  return typeof value === "string" && RECOVERY_LINK_GATEWAYS.has(value.trim().toLowerCase());
}

/** Fallback when the server did not decide: only unpaid, failed hosted payments. */
function inferRecoveryLinkEligibility(order: Order, attempts: SessionAttempt[], payments: Payment[]): boolean {
  if (!isRecoveryLinkGateway(order.paymentRecovery?.gateway ?? order.paymentMethod)) return false;
  if (order.status !== "incomplete" || Number(order.paidAmount ?? 0) > 0) return false;
  if (payments.some((payment) => ["pending", "confirmed", "succeeded"].includes(payment.status))) return false;
  const hasFailedEvidence = payments.some((payment) => payment.status === "failed")
    || attempts.some((attempt) => attempt.status === "failed" || attempt.staleProcessing);
  const recoveryState = order.paymentRecovery?.state;
  if (recoveryState) {
    return recoveryState === "awaiting_payment" || (recoveryState === "needs_attention" && hasFailedEvidence);
  }
  if (order.paymentStatus === "unpaid") return true;
  if (order.paymentStatus === "failed" && hasFailedEvidence) return true;
  return attempts.some((attempt) =>
    isRecoveryLinkGateway(attempt.gateway)
    && !attempt.activeProcessing
    && (attempt.status === "failed" || attempt.staleProcessing));
}

function sessionAttemptLabel(attempt: SessionAttempt): OrderDetailMessageKey | null {
  if (attempt.activeProcessing) return "session.processing";
  if (attempt.staleProcessing) return "session.unfinished";
  if (attempt.status === "created") return attempt.gateway === "stripe" ? "session.cardStarted" : "session.pageOpened";
  if (attempt.status === "failed") return "session.failed";
  return null;
}

function humanize(value: string): string {
  const text = value.replace(/[_-]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function time(value: unknown): string | null {
  return formatOrderTimestamp(value as OrderTimestamp | null);
}

export function PaymentCard({ order, collectRequest }: { order: Order; collectRequest?: number }) {
  const t = useMessages(orderDetailMessages);
  const o = useMessages(orderMessages);
  const r = useMessages(resourceMessages);
  const { fmt, symbol } = useCurrency();
  const isHydrated = useHydrated();
  const cardRef = useRef<HTMLDivElement>(null);
  const orderActions = useOrderActionPermissions();
  const canIssueRecoveryLink = orderActions.canEditOrders;
  const canRefund = orderActions.canRefundOrders;
  const canUpdateCod = orderActions.canUpdateOrderCod;
  const savedSummary = resolveSavedOrderMoneySummary(order);
  const money = (major: number) => (savedSummary ? formatSavedMajorAmount(major, savedSummary) : fmt(major));
  const isCOD = order.paymentMethod === "cod";

  const [historyOpen, setHistoryOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState<string>("requested_by_customer");
  const [manualSettlementConfirmed, setManualSettlementConfirmed] = useState(false);
  const [codAction, setCodAction] = useState<CodAction | null>(null);
  const [collectedBy, setCollectedBy] = useState("");
  const [collectedAmount, setCollectedAmount] = useState("");
  const [failReason, setFailReason] = useState<CodFailureReason>("not_home");
  const [failNotes, setFailNotes] = useState("");

  // Payment history is optional: a failed read stays inside this card.
  const paymentsQuery = useQuery({
    ...orderPaymentsQueryOptions(order.id),
    enabled: isHydrated,
    staleTime: ORDER_DETAIL_PREFETCH_STALE_MS,
    refetchInterval: (query) => {
      const data = query.state.data;
      const busy = data?.paymentSessionAttempts?.some((attempt) => attempt.activeProcessing)
        || Boolean(data?.activeRefundOperation?.active)
        || data?.refundAttempts?.some((attempt) => attempt.active);
      return busy ? 30_000 : false;
    },
  });
  // Ignore warm cache until hydration so server and first client render agree.
  const paymentsResult = isHydrated ? paymentsQuery.data ?? null : null;
  const historyFetching = isHydrated && paymentsQuery.isFetching;
  const refetchPayments = () => void paymentsQuery.refetch();
  const payments = paymentsResult?.payments ?? [];
  const sessionAttempts = paymentsResult?.paymentSessionAttempts ?? [];
  const webhookIssues = paymentsResult?.paymentWebhookIssues ?? [];
  const refundAttempts: OrderRefundAttempt[] = paymentsResult?.refundAttempts ?? order.refundAttempts ?? [];
  const activeRefund = paymentsResult?.activeRefundOperation ?? order.activeRefundOperation ?? null;
  const isRefundLocked = Boolean(activeRefund?.active);
  const plan = paymentsResult?.plan ?? null;
  // paidAmount is net of refunds; refunded refund rows give back the gross.
  const refundedAmount = payments
    .filter((payment) => payment.paymentType === "refund" && payment.status === "refunded")
    .reduce((sum, payment) => sum + Math.abs(Number(payment.amount) || 0), 0);
  const grossPaid = Number(order.paidAmount ?? 0) + refundedAmount;

  const requiresManualSettlementConfirmation = isCOD || payments.some((payment) =>
    payment.paymentMethod === "cod" && payment.paymentType !== "refund" && payment.status === "succeeded");
  const hasCashBalanceDueOnDelivery = plan?.status === "deposit_paid"
    && order.paymentStatus === "partial"
    && Number(order.balanceDue ?? 0) > 0;
  const usesCashCollection = isCOD || hasCashBalanceDueOnDelivery;
  const cashCollectionAmount = Number(order.balanceDue ?? 0) > 0 ? Number(order.balanceDue) : order.totalAmount;

  const recovery = order.paymentRecovery ?? null;
  const canShowRecoveryLink = canIssueRecoveryLink
    && isRecoveryLinkGateway(recovery?.gateway ?? order.paymentMethod)
    && (typeof recovery?.canIssueRecoveryLink === "boolean"
      ? recovery?.canIssueRecoveryLink === true
      : inferRecoveryLinkEligibility(order, sessionAttempts, payments));

  const canRecordCodCollection = canUpdateCod && canProcessOrderCodAction(order.status, "collected");
  const canRecordCodFailure = canUpdateCod && canProcessOrderCodAction(order.status, "failed");
  const canRecordCodReturn = canUpdateCod && canProcessOrderCodAction(order.status, "returned");

  const codQuery = useQuery({
    ...orderCodQueryOptions(order.id),
    enabled: isHydrated && usesCashCollection,
    staleTime: ORDER_DETAIL_PREFETCH_STALE_MS,
  });
  const codTracking = usesCashCollection ? codQuery.data?.tracking ?? null : null;
  const codRead = resolveOrderOperationalReadState({
    hydrated: isHydrated,
    loading: codQuery.isLoading,
    error: codQuery.isError,
    fetching: codQuery.isFetching,
    hasData: codQuery.data !== undefined,
  });
  const codOpen = !codTracking || !["collected", "returned"].includes(codTracking.codStatus);
  const canOpenCollect = codRead.status === "ready" && codOpen && canRecordCodCollection && !isRefundLocked;

  const codMutation = useUpdateOrderCod();
  const refundMutation = useRefundOrder();
  const refundCheckMutation = useReconcileRefundAttempt();
  const recoveryLinkMutation = useIssueOrderPaymentRecoveryLink();
  const presentation = buildOrderPaymentPresentation({ orderStatus: order.status, balanceDue: order.balanceDue });

  const openCollect = () => {
    setCollectedBy("");
    setCollectedAmount(String(cashCollectionAmount));
    setCodAction("collected");
  };

  // The phone action bar asks this card to open its own collect flow.
  useEffect(() => {
    if (!collectRequest) return;
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (canOpenCollect) openCollect();
    // Only a new request should open the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectRequest]);

  function submitCodAction() {
    if (!codAction) return;
    if (!canUpdateCod) return void toast.error(r("readOnly"));
    if (!canProcessOrderCodAction(order.status, codAction)) {
      toast.error(t("cod.unavailable"));
      return setCodAction(null);
    }
    if (isRefundLocked) return void toast.error(t("locked.refund"));
    let body: { orderId: string } & ApiBody<typeof postApiV1AdminOrdersByIdCod>;
    if (codAction === "collected") {
      const amount = parseFloat(collectedAmount);
      if (!collectedBy.trim()) return void toast.error(t("cod.collectorRequired"));
      if (isNaN(amount) || amount <= 0) return void toast.error(t("cod.amountRequired"));
      body = { orderId: order.id, action: "collected", collectedBy: collectedBy.trim(), collectedAmount: amount };
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
    codMutation.mutate(body, { onSuccess: () => setCodAction(null) });
  }

  function handleIssueRefund() {
    if (isRefundLocked) return void toast.error(t("locked.refund"));
    const amount = parseFloat(refundAmount);
    if (isNaN(amount) || amount <= 0 || amount > (order.paidAmount ?? 0)) {
      return void toast.error(t("refund.amountInvalid", { amount: money(order.paidAmount ?? 0) }));
    }
    if (!refundReason.trim()) return void toast.error(t("refund.reasonRequired"));
    if (requiresManualSettlementConfirmation && !manualSettlementConfirmed) {
      return void toast.error(t("refund.confirmFirst"));
    }
    refundMutation.mutate(
      {
        orderId: order.id,
        amount,
        reason: refundReason,
        manualSettlementConfirmed: requiresManualSettlementConfirmation ? true : undefined,
      },
      {
        onSuccess: async () => {
          setRefundOpen(false);
          await paymentsQuery.refetch();
        },
      },
    );
  }

  function handleCheckRefund(attempt: OrderRefundAttempt) {
    if (!canRefund) return void toast.error(r("readOnly"));
    refundCheckMutation.mutate(
      { orderId: order.id, attemptId: attempt.id },
      { onSettled: refetchPayments },
    );
  }

  async function handleCopyRecoveryLink() {
    if (!canIssueRecoveryLink) return void toast.error(r("readOnly"));
    if (!canShowRecoveryLink) {
      return void toast.error(recovery?.recoveryLinkBlockedReason ?? t("recovery.unavailable"));
    }
    let link: Awaited<ReturnType<typeof recoveryLinkMutation.mutateAsync>>;
    try {
      link = await recoveryLinkMutation.mutateAsync({ orderId: order.id });
    } catch {
      return;
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(link.url);
    } catch {
      return void toast.error(t("recovery.copyFailed"));
    }
    toast.success(t("recovery.copied"), { description: link.note || undefined });
  }

  // Confirm buttons echo the live amount, e.g. "Record ৳500 cash refund".
  const refundValue = parseFloat(refundAmount);
  const refundConfirmLabel = Number.isFinite(refundValue) && refundValue > 0
    ? t(requiresManualSettlementConfirmation ? "refund.recordCashAmount" : "refund.issueAmount", { amount: money(refundValue) })
    : t(requiresManualSettlementConfirmation ? "refund.recordCash" : "refund.issue");
  const collectValue = parseFloat(collectedAmount);
  const collectConfirmLabel = Number.isFinite(collectValue) && collectValue > 0
    ? t("cod.collectAmount", { amount: money(collectValue) })
    : t(hasCashBalanceDueOnDelivery ? "cod.recordBalance" : "cod.markCollected");

  const refreshButton = (
    <Button type="button" variant="ghost" size="sm" onClick={refetchPayments} disabled={historyFetching}>
      {t("refresh")}
    </Button>
  );

  return (
    <Card ref={cardRef} id="order-payment" className="scroll-mt-4">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>{t("payment.title")}</CardTitle>
        {order.paymentStatus ? (
          <Badge variant={statusBadgeVariant(order.paymentStatus, "payment")}>{paymentStatusLabel(o, order.paymentStatus)}</Badge>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {activeRefund ? (
          <div role="status" className="space-y-1">
            <p className="font-medium">{activeRefund.label} · {formatCurrencyAmount(activeRefund.amount, activeRefund.currency)}</p>
            <p className="text-muted-foreground">{activeRefund.message}</p>
          </div>
        ) : null}

        <dl className="space-y-1">
          <Row label={t("summary.total")} value={savedSummary ? formatSavedMinorAmount(savedSummary.totalMinor, savedSummary) : fmt(order.totalAmount)} />
          {grossPaid > 0 ? (
            <Row label={t("payment.paidWith", { method: paymentMethodLabel(o, order.paymentMethod ?? "cod") })} value={money(grossPaid)} />
          ) : (
            <Row label={t("payment.method")} value={paymentMethodLabel(o, order.paymentMethod ?? "cod")} />
          )}
          {refundedAmount > 0 ? (
            <>
              <Row label={t("payment.refunded")} value={`−${money(refundedAmount)}`} />
              <div className="flex justify-between gap-4 border-t pt-1 font-medium">
                <dt>{t("payment.net")}</dt>
                <dd>{money(order.paidAmount ?? 0)}</dd>
              </div>
            </>
          ) : null}
          {!presentation.collectionClosed && presentation.amountDue > 0 ? (
            <div className="flex justify-between gap-4 border-t pt-1 font-medium">
              <dt>{t("payment.balanceDue")}</dt>
              <dd>{money(presentation.amountDue)}</dd>
            </div>
          ) : null}
          {plan ? (
            <>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t("plan.deposit")}</dt>
                <dd>{fmt(plan.depositAmount)} · {plan.depositPaidAt ? t("plan.paid") : presentation.collectionClosed ? t("plan.closed") : t("plan.pending")}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t("plan.balance")}</dt>
                <dd>
                  {fmt(plan.balanceDue)} · {plan.balancePaidAt
                    ? t("plan.paid")
                    : presentation.collectionClosed
                      ? t("plan.closed")
                      : plan.balanceDueDate ? t("plan.due", { date: plan.balanceDueDate }) : t("plan.pending")}
                </dd>
              </div>
            </>
          ) : null}
        </dl>

        {isHydrated && paymentsQuery.isError ? (
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground">{t("history.failed")}</p>
            <Button type="button" variant="outline" size="sm" onClick={refetchPayments} disabled={historyFetching}>
              {r("retry")}
            </Button>
          </div>
        ) : null}

        {canShowRecoveryLink ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground">{recovery?.message ?? t("recovery.help")}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void handleCopyRecoveryLink()} disabled={recoveryLinkMutation.isPending}>
              {t("recovery.copy")}
            </Button>
          </div>
        ) : null}

        {webhookIssues.length > 0 ? (
          <section role="status" className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-medium text-destructive">{t("webhook.title")}</p>
                <p className="text-muted-foreground">{t("webhook.help")}</p>
              </div>
              {refreshButton}
            </div>
            <ul className="divide-y text-muted-foreground">
              {webhookIssues.map((issue) => (
                <li key={issue.id} className="py-2">
                  {paymentMethodLabel(o, issue.provider)} · {time(issue.processedAt)} — {issue.message}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {sessionAttempts.length > 0 ? (
          <section className="space-y-2" aria-label={t("session.title")}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium">{t("session.title")}</h3>
              {refreshButton}
            </div>
            <ul className="divide-y">
            {sessionAttempts.map((attempt) => {
              const label = sessionAttemptLabel(attempt);
              return (
                <li key={attempt.id} className="space-y-1 py-2" data-testid="session-attempt">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{label ? t(label) : humanize(attempt.status)}</span>
                    <span>{formatCurrencyAmount(attempt.amount, attempt.currency)}</span>
                  </div>
                  {attempt.activeProcessing ? <p className="text-muted-foreground">{t("session.processingHelp")}</p> : null}
                  <p className="text-muted-foreground">
                    {paymentMethodLabel(o, attempt.gateway)} · {time(attempt.createdAt)}
                  </p>
                  {attempt.lastError ? <p className="break-words text-destructive">{attempt.lastError}</p> : null}
                  {attempt.claimExpiresAt || attempt.providerSessionId || attempt.providerCorrelationId ? (
                    <details className="text-muted-foreground">
                      <summary className="cursor-pointer">{t("technicalDetails")}</summary>
                      <p className="break-all">
                        {[
                          attempt.claimExpiresAt ? t("session.expires", { date: time(attempt.claimExpiresAt) ?? "" }) : null,
                          attempt.providerSessionId,
                          attempt.providerCorrelationId,
                        ].filter(Boolean).join(" · ")}
                      </p>
                    </details>
                  ) : null}
                </li>
              );
            })}
            </ul>
          </section>
        ) : null}

        {isHydrated && usesCashCollection ? (
          <section className="space-y-2" aria-label={t(hasCashBalanceDueOnDelivery ? "cod.balanceTitle" : "cod.title")}>
            <OperationalReadNotice read={codRead} label={t("cod.loadFailed")} onRetry={() => void codQuery.refetch()} />
            {codTracking && codRead.status !== "unavailable" ? (
              <dl className="space-y-1.5">
                <div className="flex items-center justify-between gap-4">
                  <dt className="font-medium">{t(hasCashBalanceDueOnDelivery ? "cod.balanceTitle" : "cod.title")}</dt>
                  <dd>
                    <Badge variant={statusBadgeVariant(codTracking.codStatus)}>
                      {presentation.collectionClosed ? t("cod.closed") : codStatusLabel(t, codTracking.codStatus)}
                    </Badge>
                  </dd>
                </div>
                {presentation.collectionClosed ? (
                  <Row label={t("cod.lastStatus")} value={codStatusLabel(t, codTracking.codStatus)} />
                ) : null}
                {codTracking.deliveryAttempts > 0 ? <Row label={t("cod.attempts")} value={String(codTracking.deliveryAttempts)} /> : null}
                {codTracking.collectedBy ? <Row label={t("cod.collectedBy")} value={codTracking.collectedBy} /> : null}
                {codTracking.collectedAmount ? <Row label={t("cod.collectedAmount")} value={fmt(codTracking.collectedAmount)} /> : null}
                {codTracking.failureReason ? <Row label={t("cod.failureReason")} value={codFailureLabel(t, codTracking.failureReason)} /> : null}
              </dl>
            ) : null}
            {codRead.status === "ready" && codOpen && (canRecordCodCollection || (isCOD && (canRecordCodFailure || canRecordCodReturn))) ? (
              <div className="flex flex-wrap gap-2">
                {canRecordCodCollection ? (
                  <Button size="sm" disabled={isRefundLocked} onClick={openCollect}>
                    {t(hasCashBalanceDueOnDelivery ? "cod.recordBalance" : "cod.markCollected")}
                  </Button>
                ) : null}
                {isCOD && canRecordCodFailure ? (
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
                    {t("cod.recordFailure")}
                  </Button>
                ) : null}
                {isCOD && canRecordCodReturn && codTracking && codTracking.deliveryAttempts > 0 ? (
                  <Button size="sm" variant="ghost" disabled={isRefundLocked} onClick={() => setCodAction("returned")}>
                    {t("cod.markReturned")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        {refundAttempts.length > 0 ? (
          <section className="space-y-2" aria-label={t("refund.history")}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium">{t("refund.history")}</h3>
              {refreshButton}
            </div>
            <ul className="divide-y">
            {refundAttempts.map((attempt) => {
              const checking = refundCheckMutation.isPending && refundCheckMutation.variables?.attemptId === attempt.id;
              const when = time(attempt.refundedAt ?? attempt.failedAt ?? attempt.nextProbeAt ?? attempt.createdAt);
              const refs = [
                attempt.allocationCount && attempt.allocationCount > 1
                  ? t("refund.allocation", { index: (attempt.allocationIndex ?? 0) + 1, count: attempt.allocationCount })
                  : null,
                attempt.refundReference,
                attempt.providerRefundId,
                attempt.providerCorrelationId,
                attempt.providerStatus,
                attempt.sourceTransactionId,
              ].filter(Boolean);
              return (
                <li key={attempt.id} className="space-y-1 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{attempt.label}</span>
                    <span>{formatCurrencyAmount(attempt.amount, attempt.currency)}</span>
                  </div>
                  {attempt.refundedAt ? null : <p className="text-muted-foreground">{attempt.message}</p>}
                  {attempt.lastError ? <p className="break-words text-destructive">{attempt.lastError}</p> : null}
                  <p className="text-muted-foreground">
                    {[attempt.reason ? refundReasonLabel(t, attempt.reason) : null, when].filter(Boolean).join(" · ")}
                  </p>
                  {refs.length > 0 ? (
                    <details className="text-muted-foreground">
                      <summary className="cursor-pointer">{t("technicalDetails")}</summary>
                      <p className="break-all">{refs.join(" · ")}</p>
                    </details>
                  ) : null}
                  {canRefund && attempt.active && MANUAL_REFUND_CHECK_STATUSES.has(attempt.status) ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => handleCheckRefund(attempt)} disabled={refundCheckMutation.isPending} aria-busy={checking || undefined}>
                      {t("refund.checkNow")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
            </ul>
          </section>
        ) : null}

        {payments.length > 0 ? (
          <section className="space-y-2">
            <Button type="button" variant="link" size="sm" onClick={() => setHistoryOpen((open) => !open)} aria-expanded={historyOpen}>
              {historyOpen ? t("history.hide") : t("history.show", { count: payments.length })}
            </Button>
            {historyOpen ? (
              <ul className="divide-y">
                {payments.map((payment) => (
                  <li key={payment.id} className="space-y-1 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{humanize(payment.paymentType)} · {paymentMethodLabel(o, payment.paymentMethod)}</span>
                      <span>{formatCurrencyAmount(payment.amount, payment.currency)}</span>
                    </div>
                    <p className="break-all text-muted-foreground">
                      {[
                        humanize(payment.status),
                        time(payment.createdAt),
                        payment.providerRef,
                        payment.providerSecondaryRef,
                        payment.codCollectedBy ? t("cod.collectedByName", { name: payment.codCollectedBy }) : null,
                      ].filter(Boolean).join(" · ")}
                    </p>
                    {payment.codReceiptUrl ? (
                      <a href={payment.codReceiptUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        {t("cod.receipt")}
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {canRefund && (order.paidAmount ?? 0) > 0 && order.paymentStatus !== "refunded" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={isRefundLocked}
            onClick={() => {
              setRefundAmount(String(order.paidAmount));
              setRefundReason("requested_by_customer");
              setManualSettlementConfirmed(false);
              setRefundOpen(true);
            }}
          >
            {t(requiresManualSettlementConfirmation ? "refund.recordCash" : "refund.issue")}
          </Button>
        ) : null}
      </CardContent>

      <Dialog open={codAction === "collected"} onOpenChange={(open) => !open && setCodAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(hasCashBalanceDueOnDelivery ? "cod.recordBalance" : "cod.markCollected")}</DialogTitle>
            <DialogDescription>{t(hasCashBalanceDueOnDelivery ? "cod.balanceHelp" : "cod.collectHelp")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="collectedBy">{t("cod.collectedBy")}</Label>
              <Input id="collectedBy" placeholder={t("cod.collectorPlaceholder")} value={collectedBy} onChange={(e) => setCollectedBy(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="collectedAmount">{t("cod.amountLabel", { symbol })}</Label>
              <Input id="collectedAmount" type="number" inputMode="decimal" value={collectedAmount} onChange={(e) => setCollectedAmount(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCodAction(null)}>{r("cancel")}</Button>
            <Button onClick={submitCodAction} disabled={codMutation.isPending || !canRecordCodCollection}>
              {collectConfirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={codAction === "failed"} onOpenChange={(open) => !open && setCodAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("cod.recordFailure")}</DialogTitle>
            <DialogDescription>{t("cod.failureHelp")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="failReason">{t("cod.failureReason")}</Label>
              <Select value={failReason} onValueChange={(value) => setFailReason(value as CodFailureReason)}>
                <SelectTrigger id="failReason"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COD_FAILURE_REASONS.map((reason) => (
                    <SelectItem key={reason} value={reason}>{codFailureLabel(t, reason)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="failNotes">{t("cod.notes")}</Label>
              <Input id="failNotes" value={failNotes} onChange={(e) => setFailNotes(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCodAction(null)}>{r("cancel")}</Button>
            <Button variant="destructive" onClick={submitCodAction} disabled={codMutation.isPending || !canRecordCodFailure}>
              {t("cod.recordFailure")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={codAction === "returned"} onOpenChange={(open) => !open && setCodAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("cod.returnTitle")}</DialogTitle>
            <DialogDescription>{t("cod.returnHelp")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCodAction(null)}>{r("cancel")}</Button>
            <Button variant="destructive" onClick={submitCodAction} disabled={codMutation.isPending || !canRecordCodReturn}>
              {t("cod.markReturned")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={refundOpen}
        onOpenChange={(open) => {
          setRefundOpen(open);
          if (!open) setManualSettlementConfirmed(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(requiresManualSettlementConfirmation ? "refund.recordCash" : "refund.issue")}</DialogTitle>
            <DialogDescription>{t(requiresManualSettlementConfirmation ? "refund.manualHelp" : "refund.help")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="refundAmount">{t("refund.amount", { symbol })}</Label>
              <Input
                id="refundAmount"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0.01"
                max={order.paidAmount ?? 0}
                value={refundAmount}
                disabled={isRefundLocked}
                onChange={(e) => setRefundAmount(e.target.value)}
              />
              <p className="text-body text-muted-foreground">{t("refund.max", { amount: money(order.paidAmount ?? 0) })}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="refundReason">{t("refund.reason")}</Label>
              <Select value={refundReason} onValueChange={setRefundReason}>
                <SelectTrigger id="refundReason"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REFUND_REASONS.map((reason) => (
                    <SelectItem key={reason} value={reason}>{refundReasonLabel(t, reason)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {requiresManualSettlementConfirmation ? (
              <div className="flex items-start gap-3">
                <span className="flex h-5 items-center">
                  <Checkbox
                    id="manualSettlementConfirmed"
                    checked={manualSettlementConfirmed}
                    onCheckedChange={(checked) => setManualSettlementConfirmed(checked === true)}
                  />
                </span>
                <Label htmlFor="manualSettlementConfirmed">{t("refund.manualConfirm")}</Label>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRefundOpen(false)} disabled={refundMutation.isPending}>
              {r("cancel")}
            </Button>
            <Button
              onClick={handleIssueRefund}
              disabled={refundMutation.isPending || isRefundLocked || (requiresManualSettlementConfirmation && !manualSettlementConfirmed)}
            >
              {refundConfirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

const codStatusLabel = (t: Parameters<typeof orderDetailLabel>[0], status: string) => orderDetailLabel(t, "cod.status.", status);
const codFailureLabel = (t: Parameters<typeof orderDetailLabel>[0], reason: string) => orderDetailLabel(t, "cod.reason.", reason);
const refundReasonLabel = (t: Parameters<typeof orderDetailLabel>[0], reason: string) => orderDetailLabel(t, "refund.reason.", reason);

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
