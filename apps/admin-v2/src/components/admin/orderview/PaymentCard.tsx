import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Alert } from "~/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { MoneyInput } from "~/components/admin/shared/MoneyInput";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { NativeSelect } from "~/components/ui/native-select";
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
import { formatNumber, useMessages } from "~/i18n";
import { orderDetailLabel, orderDetailMessages, refundStateCopy, type OrderDetailMessageKey } from "~/i18n/order-detail";
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
  orderErrorMessage,
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
import { orderBadgeVisibility, statusBadgeVariant } from "./status-badges";
import type { OrderActionRequest } from "./primary-action";
import type { Order, OrderRefundAttempt, OrderTimestamp } from "./types";

type CodAction = "collected" | "failed" | "returned";
type CodFailureReason = Extract<ApiBody<typeof postApiV1AdminOrdersByIdCod>, { action: "failed" }>["reason"];
type Payment = OrderPaymentsPayload["payments"][number];
type SessionAttempt = OrderPaymentsPayload["paymentSessionAttempts"][number];

const COD_FAILURE_REASONS: CodFailureReason[] = ["not_home", "refused", "no_cash", "wrong_address", "other"];
const REFUND_REASONS = ["requested_by_customer", "returned_items", "duplicate", "fraudulent", "out_of_stock"] as const;
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

function time(value: unknown): string | null {
  return formatOrderTimestamp(value as OrderTimestamp | null);
}

export function PaymentCard({ order, request }: { order: Order; request?: OrderActionRequest | null }) {
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
  const paid = Number(order.paidAmount ?? 0);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundAmount, setRefundAmount] = useState<number | null>(null);
  const [refundAmountError, setRefundAmountError] = useState<string | null>(null);
  const [refundReason, setRefundReason] = useState<string>("requested_by_customer");
  const [manualSettlementConfirmed, setManualSettlementConfirmed] = useState(false);
  // One key per opened refund dialog: a repeated submit replays the first refund.
  const refundRequestKey = useRef("");
  const [codAction, setCodAction] = useState<CodAction | null>(null);
  const [collectedBy, setCollectedBy] = useState("");
  const [collectorError, setCollectorError] = useState<string | null>(null);
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
  const activeRefundCopy = activeRefund
    ? refundStateCopy(t, activeRefund.status, activeRefund.gateway, paymentMethodLabel(o, activeRefund.gateway))
    : null;
  const isRefundLocked = Boolean(activeRefund?.active);
  const plan = paymentsResult?.plan ?? null;
  // paidAmount is net of refunds; the gross is what came in.
  const refundedAmount = Number(order.refundedAmount ?? 0);
  const grossPaid = paid + refundedAmount;

  const requiresManualSettlementConfirmation = isCOD || payments.some((payment) =>
    payment.paymentMethod === "cod" && payment.paymentType !== "refund" && payment.status === "succeeded");
  const hasCashBalanceDueOnDelivery = plan?.status === "deposit_paid"
    && order.paymentStatus === "partial"
    && Number(order.balanceDue ?? 0) > 0;
  const usesCashCollection = isCOD || hasCashBalanceDueOnDelivery;
  const cashCollectionAmount = Number(order.balanceDue ?? 0) > 0 ? Number(order.balanceDue) : order.totalAmount;
  const sentUnits = order.items.reduce((sum, item) => sum + (item.shippedQuantity ?? item.quantity), 0);

  const recovery = order.paymentRecovery ?? null;
  const canShowRecoveryLink = canIssueRecoveryLink
    && isRecoveryLinkGateway(recovery?.gateway ?? order.paymentMethod)
    && (typeof recovery?.canIssueRecoveryLink === "boolean"
      ? recovery?.canIssueRecoveryLink === true
      : inferRecoveryLinkEligibility(order, sessionAttempts, payments));

  // Cash changes hands at the door: collection opens once the order is out.
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
  const showBadge = orderBadgeVisibility(order).payment;

  const openCod = (action: CodAction) => {
    codMutation.reset();
    setCollectedBy("");
    setCollectorError(null);
    setFailReason("not_home");
    setFailNotes("");
    setCodAction(action);
  };
  const openRefund = () => {
    refundMutation.reset();
    const owed = initialRefundAmount(order);
    setRefundAmount(owed);
    setRefundAmountError(null);
    setRefundReason(owed === null ? "requested_by_customer" : "returned_items");
    refundRequestKey.current = crypto.randomUUID();
    setManualSettlementConfirmed(false);
    setRefundOpen(true);
  };

  // The next-step button and the Returns card ask this card to open its own flows.
  useEffect(() => {
    if (request?.action !== "collectCod" && request?.action !== "refund") return;
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (request.action === "collectCod" && canOpenCollect) openCod("collected");
    if (request.action === "refund" && canRefund && !isRefundLocked) openRefund();
    // Only a new request should open a dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id]);

  function submitCodAction() {
    if (!codAction) return;
    let body: { orderId: string } & ApiBody<typeof postApiV1AdminOrdersByIdCod>;
    if (codAction === "collected") {
      if (!collectedBy.trim()) {
        setCollectorError(t("cod.collectorRequired"));
        document.getElementById("collectedBy")?.focus();
        return;
      }
      body = { orderId: order.id, action: "collected", collectedBy: collectedBy.trim(), collectedAmount: cashCollectionAmount };
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

  const refundValue = refundAmount ?? Number.NaN;
  const refundAmountProblem = (): string | null =>
    Number.isFinite(refundValue) && refundValue > 0 && refundValue <= paid
      ? null
      : t("refund.amountInvalid", { amount: money(paid) });

  function handleIssueRefund(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (refundMutation.isPending || isRefundLocked || (requiresManualSettlementConfirmation && !manualSettlementConfirmed)) return;
    const problem = refundAmountProblem();
    setRefundAmountError(problem);
    if (problem) {
      document.getElementById("refundAmount")?.focus();
      return;
    }
    refundMutation.mutate(
      {
        orderId: order.id,
        requestKey: refundRequestKey.current,
        amount: refundValue,
        reason: refundReason,
        manualSettlementConfirmed: requiresManualSettlementConfirmation ? true : undefined,
      },
      { onSuccess: () => setRefundOpen(false) },
    );
  }

  async function handleCopyRecoveryLink() {
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
  const refundConfirmLabel = Number.isFinite(refundValue) && refundValue > 0
    ? t(requiresManualSettlementConfirmation ? "refund.recordCashAmount" : "refund.issueAmount", { amount: money(refundValue) })
    : t(requiresManualSettlementConfirmation ? "refund.recordCash" : "refund.issue");
  const collectTitle = t(hasCashBalanceDueOnDelivery ? "cod.recordBalance" : "cod.markCollected");

  const refreshButton = (
    <Button type="button" variant="ghost" size="sm" onClick={refetchPayments} disabled={historyFetching}>
      {t("refresh")}
    </Button>
  );

  return (
    <Card ref={cardRef} id="order-payment" className="scroll-mt-4">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>{t("payment.title")}</CardTitle>
        {showBadge && order.paymentStatus ? (
          <Badge variant={statusBadgeVariant(order.paymentStatus, "payment")}>{paymentStatusLabel(o, order.paymentStatus)}</Badge>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {activeRefundCopy && activeRefund ? (
          <div role="status" className="space-y-1">
            <p className="font-medium">{activeRefundCopy.label} · {formatCurrencyAmount(activeRefund.amount, activeRefund.currency)}</p>
            {activeRefundCopy.help ? <p className="text-muted-foreground">{activeRefundCopy.help}</p> : null}
          </div>
        ) : null}

        <dl className="space-y-1 tabular-nums">
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
                <dd>{money(paid)}</dd>
              </div>
            </>
          ) : null}
          {!presentation.collectionClosed && presentation.amountDue > 0 ? (
            <div className="flex justify-between gap-4 border-t pt-1 font-medium">
              <dt>{t("payment.balanceDue")}</dt>
              <dd>{money(presentation.amountDue)}</dd>
            </div>
          ) : null}
          {order.refundDue > 0 ? (
            <div className="flex justify-between gap-4 border-t pt-1 font-medium">
              <dt>{o("refundOwed")}</dt>
              <dd>{money(order.refundDue)}</dd>
            </div>
          ) : null}
          {plan ? (
            <>
              <Row
                label={t("plan.deposit")}
                value={`${fmt(plan.depositAmount)} · ${plan.depositPaidAt ? t("plan.paid") : presentation.collectionClosed ? t("plan.closed") : t("plan.pending")}`}
              />
              <Row
                label={t("plan.balance")}
                value={`${fmt(plan.balanceDue)} · ${plan.balancePaidAt
                  ? t("plan.paid")
                  : presentation.collectionClosed
                    ? t("plan.closed")
                    : plan.balanceDueDate ? t("plan.due", { date: plan.balanceDueDate }) : t("plan.pending")}`}
              />
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
            <p className="text-muted-foreground">{t("recovery.help")}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void handleCopyRecoveryLink()} loading={recoveryLinkMutation.isPending}>
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
                  <p>{[paymentMethodLabel(o, issue.provider), time(issue.processedAt)].filter(Boolean).join(" · ")}</p>
                  <p>{t(`webhook.reason.${issue.reason}`, { gateway: paymentMethodLabel(o, issue.provider) })}</p>
                  {issue.error ? <p className="break-words">{issue.error}</p> : null}
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
                      <span className="font-medium">{label ? t(label) : orderDetailLabel(t, "payment.status.", attempt.status)}</span>
                      <span className="tabular-nums">{formatCurrencyAmount(attempt.amount, attempt.currency)}</span>
                    </div>
                    {attempt.activeProcessing ? <p className="text-muted-foreground">{t("session.processingHelp")}</p> : null}
                    <p className="text-muted-foreground">
                      {[
                        paymentMethodLabel(o, attempt.gateway),
                        time(attempt.createdAt),
                        attempt.claimExpiresAt && !attempt.activeProcessing ? t("session.expires", { date: time(attempt.claimExpiresAt) ?? "" }) : null,
                      ].filter(Boolean).join(" · ")}
                    </p>
                    {attempt.lastError ? <p className="break-words text-destructive">{attempt.lastError}</p> : null}
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
                      {presentation.collectionClosed ? t("cod.closed") : orderDetailLabel(t, "cod.status.", codTracking.codStatus)}
                    </Badge>
                  </dd>
                </div>
                {presentation.collectionClosed ? (
                  <Row label={t("cod.lastStatus")} value={orderDetailLabel(t, "cod.status.", codTracking.codStatus)} />
                ) : null}
                {codTracking.deliveryAttempts > 0 ? <Row label={t("cod.attempts")} value={formatNumber(codTracking.deliveryAttempts)} /> : null}
                {codTracking.collectedBy ? <Row label={t("cod.collectedBy")} value={codTracking.collectedBy} /> : null}
                {codTracking.collectedAmount ? <Row label={t("cod.collectedAmount")} value={money(codTracking.collectedAmount)} /> : null}
                {codTracking.codStatus === "failed" && codTracking.failureReason ? <Row label={t("cod.failureReason")} value={orderDetailLabel(t, "cod.reason.", codTracking.failureReason)} /> : null}
                {codTracking.codStatus === "failed" && codTracking.failureNote ? <Row label={t("cod.notes")} value={codTracking.failureNote} /> : null}
              </dl>
            ) : null}
            {codRead.status === "ready" && codOpen && (canRecordCodCollection || (isCOD && (canRecordCodFailure || canRecordCodReturn))) ? (
              <div className="flex flex-wrap gap-2">
                {canRecordCodCollection ? (
                  <Button size="sm" disabled={isRefundLocked} onClick={() => openCod("collected")}>{collectTitle}</Button>
                ) : null}
                {isCOD && canRecordCodFailure ? (
                  <Button size="sm" variant="outline" disabled={isRefundLocked} onClick={() => openCod("failed")}>
                    {t("cod.recordFailure")}
                  </Button>
                ) : null}
                {isCOD && canRecordCodReturn ? (
                  <Button size="sm" variant="outline" disabled={isRefundLocked} onClick={() => openCod("returned")}>
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
                const copy = refundStateCopy(t, attempt.status, attempt.gateway, paymentMethodLabel(o, attempt.gateway));
                return (
                  <li key={attempt.id} className="space-y-1 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{copy.label}</span>
                      <span className="tabular-nums">{formatCurrencyAmount(attempt.amount, attempt.currency)}</span>
                    </div>
                    {attempt.refundedAt || !copy.help ? null : <p className="text-muted-foreground">{copy.help}</p>}
                    {attempt.lastError ? <p className="break-words text-destructive">{attempt.lastError}</p> : null}
                    <p className="text-muted-foreground">
                      {[attempt.reason ? orderDetailLabel(t, "refund.reason.", attempt.reason) : null, when].filter(Boolean).join(" · ")}
                    </p>
                    {canRefund && attempt.active && MANUAL_REFUND_CHECK_STATUSES.has(attempt.status) ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => refundCheckMutation.mutate({ orderId: order.id, attemptId: attempt.id }, { onSettled: refetchPayments })}
                        disabled={refundCheckMutation.isPending && !checking}
                        loading={checking}
                      >
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
                      <span className="font-medium">
                        {orderDetailLabel(t, "payment.type.", payment.paymentType)} · {paymentMethodLabel(o, payment.paymentMethod)}
                      </span>
                      <span className="tabular-nums">{formatCurrencyAmount(payment.amount, payment.currency)}</span>
                    </div>
                    <p className="break-all text-muted-foreground">
                      {[
                        orderDetailLabel(t, "payment.status.", payment.status),
                        time(payment.createdAt),
                        payment.providerRef,
                        payment.codCollectedBy ? t("cod.collectedByName", { name: payment.codCollectedBy }) : null,
                      ].filter(Boolean).join(" · ")}
                    </p>
                    {payment.codReceiptUrl ? (
                      <a href={payment.codReceiptUrl} target="_blank" rel="noreferrer" className="text-link hover:underline">
                        {t("cod.receipt")}
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {canRefund && paid > 0 && order.paymentStatus !== "refunded" ? (
          <Button variant="outline" size="sm" disabled={isRefundLocked} onClick={openRefund}>
            {t(requiresManualSettlementConfirmation ? "refund.recordCash" : "refund.issue")}
          </Button>
        ) : null}
      </CardContent>

      <Dialog open={codAction === "collected"} onOpenChange={(open) => !open && !codMutation.isPending && setCodAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{collectTitle}</DialogTitle>
            <DialogDescription>{t(hasCashBalanceDueOnDelivery ? "cod.balanceHelp" : "cod.collectHelp")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {codMutation.isError ? <Alert variant="destructive">{orderErrorMessage(codMutation.error)}</Alert> : null}
            <div className="flex items-baseline justify-between gap-4">
              <p className="text-muted-foreground">{t("cod.amountToCollect")}</p>
              <p className="text-heading-md font-semibold tabular-nums">{money(cashCollectionAmount)}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="collectedBy">{t("cod.collectedBy")}</Label>
              <Input
                id="collectedBy"
                placeholder={t("cod.collectorPlaceholder")}
                value={collectedBy}
                required
                maxLength={120}
                aria-invalid={Boolean(collectorError) || undefined}
                aria-describedby={collectorError ? "collectedBy-error" : undefined}
                onChange={(e) => setCollectedBy(e.target.value)}
                onBlur={() => setCollectorError(collectedBy.trim() ? null : t("cod.collectorRequired"))}
              />
              {collectorError ? <p id="collectedBy-error" className="text-destructive">{collectorError}</p> : null}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCodAction(null)} disabled={codMutation.isPending}>{r("cancel")}</Button>
            <Button onClick={submitCodAction} loading={codMutation.isPending} disabled={!canRecordCodCollection}>
              {t("cod.collectAmount", { amount: money(cashCollectionAmount) })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={codAction === "failed"} onOpenChange={(open) => !open && !codMutation.isPending && setCodAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("cod.recordFailure")}</DialogTitle>
            <DialogDescription>{t("cod.failureHelp")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {codMutation.isError ? <Alert variant="destructive">{orderErrorMessage(codMutation.error)}</Alert> : null}
            <div className="space-y-2">
              <Label htmlFor="failReason">{t("cod.failureReason")}</Label>
              <NativeSelect id="failReason" value={failReason} onValueChange={(value) => setFailReason(value as CodFailureReason)}>
                {COD_FAILURE_REASONS.map((reason) => (
                  <option key={reason} value={reason}>{orderDetailLabel(t, "cod.reason.", reason)}</option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <Label htmlFor="failNotes">{t("cod.notes")}</Label>
              <Textarea id="failNotes" value={failNotes} maxLength={500} onChange={(e) => setFailNotes(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCodAction(null)} disabled={codMutation.isPending}>{r("cancel")}</Button>
            <Button variant="destructive" onClick={submitCodAction} loading={codMutation.isPending} disabled={!canRecordCodFailure}>
              {t("cod.recordFailure")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={codAction === "returned"} onOpenChange={(open) => !open && !codMutation.isPending && setCodAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{sentUnits === 1 ? t("cod.returnTitleOne") : t("cod.returnTitle", { count: sentUnits })}</DialogTitle>
            <DialogDescription>
              {[
                presentation.amountDue > 0 ? t("cod.returnBalance", { amount: money(presentation.amountDue) }) : null,
                t("cod.returnHelp"),
              ].filter(Boolean).join(" ")}
            </DialogDescription>
          </DialogHeader>
          {codMutation.isError ? <Alert variant="destructive">{orderErrorMessage(codMutation.error)}</Alert> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCodAction(null)} disabled={codMutation.isPending}>{r("cancel")}</Button>
            <Button variant="destructive" onClick={submitCodAction} loading={codMutation.isPending} disabled={!canRecordCodReturn}>
              {t("cod.markReturned")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={refundOpen} onOpenChange={(open) => !refundMutation.isPending && setRefundOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(requiresManualSettlementConfirmation ? "refund.recordCash" : "refund.issue")}</DialogTitle>
            <DialogDescription>{t(requiresManualSettlementConfirmation ? "refund.manualHelp" : "refund.help")}</DialogDescription>
          </DialogHeader>
          <form id="order-refund" method="post" className="space-y-4" onSubmit={handleIssueRefund} noValidate>
            {refundMutation.isError ? <Alert variant="destructive">{orderErrorMessage(refundMutation.error)}</Alert> : null}
            <div className="space-y-2">
              <Label htmlFor="refundAmount">{t("refund.amount", { symbol })}</Label>
              <MoneyInput
                currencyCode={order.currencyCode ?? ""}
                id="refundAmount"
                value={refundAmount}
                disabled={isRefundLocked}
                aria-invalid={Boolean(refundAmountError) || undefined}
                aria-describedby="refundAmount-help"
                onValueChange={(value) => {
                  setRefundAmount(value);
                  if (refundAmountError) setRefundAmountError(null);
                }}
                onBlur={() => setRefundAmountError(refundAmount === null ? null : refundAmountProblem())}
              />
              <p id="refundAmount-help" className={refundAmountError ? "text-destructive" : "text-muted-foreground"}>
                {refundAmountError ?? (order.refundDue > 0
                  ? t("refund.maxOwed", { owed: money(order.refundDue), amount: money(paid) })
                  : t("refund.max", { amount: money(paid) }))}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="refundReason">{t("refund.reason")}</Label>
              <NativeSelect id="refundReason" value={refundReason} onValueChange={setRefundReason}>
                {REFUND_REASONS.map((reason) => (
                  <option key={reason} value={reason}>{orderDetailLabel(t, "refund.reason.", reason)}</option>
                ))}
              </NativeSelect>
            </div>
            {requiresManualSettlementConfirmation ? (
              <div className="flex items-start gap-3">
                <span className="flex h-lh items-center">
                  <Checkbox
                    id="manualSettlementConfirmed"
                    checked={manualSettlementConfirmed}
                    onCheckedChange={(checked) => setManualSettlementConfirmed(checked === true)}
                  />
                </span>
                <Label htmlFor="manualSettlementConfirmed">{t("refund.manualConfirm")}</Label>
              </div>
            ) : null}
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRefundOpen(false)} disabled={refundMutation.isPending}>
              {r("cancel")}
            </Button>
            <Button
              type="submit"
              form="order-refund"
              loading={refundMutation.isPending}
              disabled={isRefundLocked || (requiresManualSettlementConfirmation && !manualSettlementConfirmed)}
            >
              {refundConfirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Only what came back is owed; the rest of a refund is the merchant's call. */
export function initialRefundAmount(order: Pick<Order, "refundDue" | "paidAmount">): number | null {
  const owed = Math.min(Number(order.refundDue ?? 0), Number(order.paidAmount ?? 0));
  return owed > 0 ? owed : null;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right">{value}</dd>
    </div>
  );
}
