import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { providerLabel } from "~/i18n/provider-copy";
import { useOpenedOnce } from "~/hooks/use-opened-once";
import { InlineError } from "~/components/admin/states/InlineError";
import { pollWhileOffline } from "~/lib/admin-query-client";
import { useQuery } from "@tanstack/react-query";
import { toast } from "~/lib/toast";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { hasAppPaymentMethod, useAppPaymentMethodNames, useOrderPaymentProvider } from "~/hooks/use-app-payment-method-names";
import { BANGLADESH_PACK_ID } from "~/lib/bangladesh-pack";
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
import {
  orderCodQueryOptions,
  orderPaymentsQueryOptions,
  type OrderPaymentsPayload,
} from "~/lib/api-query-options/orders";
import {
  useIssueOrderPaymentRecoveryLink,
  useReconcileRefundAttempt,
} from "~/lib/api-mutations/orders";
import { ORDER_DETAIL_PREFETCH_STALE_MS } from "~/lib/order-detail-prefetch";
import { resolveOrderOperationalReadState } from "~/lib/order-operational-read-state";
import {
  formatSavedMajorAmount,
  resolveSavedOrderMoneySummary,
} from "~/lib/order-tax-presentation";
import { buildOrderPaymentPresentation } from "~/lib/order-payment-presentation";
import { canProcessOrderCodAction } from "@scalius/shared/order-state";
import { formatCurrencyAmount, formatOrderDate, formatOrderTimestamp } from "./formatters";
import type { CodAction } from "./CodDialogs";
import { OperationalReadNotice } from "./OperationalReadNotice";
import { orderBadgeVisibility, statusBadgeVariant } from "./status-badges";
import { isPartSent, type OrderActionRequest } from "./primary-action";
import { GiftCardTenderRows, giftCardTenderLines } from "./GiftCardTenderRows";
import { OrderSummaryRows } from "./OrderItemsCard";
import type { Order, OrderRefundAttempt, OrderTimestamp } from "./types";

// The refund form loads the first time it opens.
const RefundDialog = lazy(() => import("./RefundDialog"));
// So do the cash-on-delivery dialogs (collected, failed, returned).
const CodDialogs = lazy(() => import("./CodDialogs").then((module) => ({ default: module.CodDialogs })));
// And the invoice's record-a-payment dialog.
const RecordPaymentDialog = lazy(() => import("./RecordPaymentDialog").then((module) => ({ default: module.RecordPaymentDialog })));

type Payment = OrderPaymentsPayload["payments"][number];
type SessionAttempt = OrderPaymentsPayload["paymentSessionAttempts"][number];

const MANUAL_REFUND_CHECK_STATUSES = new Set(["processing", "provider_unknown", "reconcile_required", "pending"]);
/** A hosted gateway the buyer can be sent back to: any app's (apps are hosted only). */
function isRecoveryLinkGateway(value: string | null | undefined): boolean {
  return typeof value === "string" && isQualifiedProviderId(value.trim());
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
  const { fmt } = useCurrency();
  const isHydrated = useHydrated();
  const cardRef = useRef<HTMLDivElement>(null);
  const orderActions = useOrderActionPermissions();
  const canIssueRecoveryLink = orderActions.canEditOrders;
  const canRefund = orderActions.canRefundOrders;
  const canUpdateCod = orderActions.canUpdateOrderCod;
  const canRecordPayment = orderActions.canRecordPayments;
  const savedSummary = resolveSavedOrderMoneySummary(order);
  const money = (major: number) => (savedSummary ? formatSavedMajorAmount(major, savedSummary) : fmt(major));
  const isCOD = order.paymentMethod === "cod";
  const paid = Number(order.paidAmount ?? 0);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  // Each opening mounts a fresh refund dialog (its own amount and request key).
  const [refundSession, setRefundSession] = useState(0);
  const refundLoaded = useOpenedOnce(refundOpen);
  const [codAction, setCodAction] = useState<CodAction | null>(null);
  // Each opening mounts fresh cash dialogs (their own fields), loaded the first time one opens.
  const [codSession, setCodSession] = useState(0);
  const [codCollector, setCodCollector] = useState("");
  const codLoaded = useOpenedOnce(codAction !== null);
  // Each opening mounts a fresh record-a-payment dialog (its own amount and request key).
  const [recordOpen, setRecordOpen] = useState(false);
  const [recordSession, setRecordSession] = useState(0);
  const recordLoaded = useOpenedOnce(recordOpen);
  const terms = order.paymentTerms ?? null;

  // Payment history is optional: a failed read stays inside this card.
  const paymentsQuery = useQuery({
    ...orderPaymentsQueryOptions(order.id),
    enabled: isHydrated,
    staleTime: ORDER_DETAIL_PREFETCH_STALE_MS,
    // Live through the realtime hub; polls only while it is unreachable.
    refetchInterval: (query) => {
      if (pollWhileOffline(30_000)() === false) return false;
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
  // An app's method reads as its provider's name (orders store `<plugin id>:<provider id>`).
  const appNames = useAppPaymentMethodNames(isHydrated && hasAppPaymentMethod([
    order.paymentMethod,
    order.paymentRecovery?.gateway,
    activeRefund?.gateway,
    ...payments.map((payment) => payment.paymentMethod),
    ...sessionAttempts.map((attempt) => attempt.gateway),
    ...webhookIssues.map((issue) => issue.provider),
    ...refundAttempts.map((attempt) => attempt.gateway),
  ]));
  const methodLabel = (method: string) => paymentMethodLabel(o, method, isHydrated ? appNames : undefined);
  // An app's method whose app is not active (or removed) can't refund, check or take a payment.
  const orderProvider = useOrderPaymentProvider(order.paymentMethod, isHydrated && hasAppPaymentMethod([order.paymentMethod]));
  const inactiveApp = orderProvider === undefined || (orderProvider !== null && orderProvider.readiness?.enabled !== false)
    ? null
    : orderProvider?.appName ?? (order.paymentMethod?.startsWith(`${BANGLADESH_PACK_ID}:`)
      ? t("payment.bangladeshPack")
      : methodLabel(order.paymentMethod ?? ""));
  const activeRefundCopy = activeRefund
    ? refundStateCopy(t, activeRefund.status, activeRefund.gateway, methodLabel(activeRefund.gateway))
    : null;
  const isRefundLocked = Boolean(activeRefund?.active);
  const plan = paymentsResult?.plan ?? null;
  // paidAmount is net of refunds; the gross is what came in.
  const refundedAmount = Number(order.refundedAmount ?? 0);
  const grossPaid = paid + refundedAmount;
  // Gift-card tender shows as its own rows: "Paid · <method>" counts only
  // the money the order's own method took (never the card's share).
  const paidDecimalPlaces = order.currencyDecimalPlaces ?? 2;
  const giftCardHeldMinor = giftCardTenderLines(payments)
    .filter((line) => line.kind === "tender" && line.state !== "released")
    .reduce((total, line) => total + line.amountMinor, 0);
  const methodPaidMinor = Math.max(0, Math.round(grossPaid * 10 ** paidDecimalPlaces) - giftCardHeldMinor);
  const methodPaid = methodPaidMinor / 10 ** paidDecimalPlaces;

  const hasCashPayment = isCOD || payments.some((payment) =>
    payment.paymentMethod === "cod" && payment.paymentType !== "refund" && payment.status === "succeeded");
  const hasCashBalanceDueOnDelivery = plan?.status === "deposit_paid"
    && order.paymentStatus === "partial"
    && Number(order.balanceDue ?? 0) > 0;
  const usesCashCollection = isCOD || hasCashBalanceDueOnDelivery;
  const cashCollectionAmount = Number(order.balanceDue ?? 0) > 0 ? Number(order.balanceDue) : order.totalAmount;
  const sentUnits = order.items.reduce((sum, item) => sum + item.fulfilledQuantity, 0);

  const recovery = order.paymentRecovery ?? null;
  const canShowRecoveryLink = canIssueRecoveryLink
    && isRecoveryLinkGateway(recovery?.gateway ?? order.paymentMethod)
    && (typeof recovery?.canIssueRecoveryLink === "boolean"
      ? recovery?.canIssueRecoveryLink === true
      : inferRecoveryLinkEligibility(order, sessionAttempts, payments));

  // Cash changes hands at the door: collection opens once the order is out.
  // Pickup and service orders take their cash at the counter or the visit, from confirmed on.
  const canRecordCodCollection = canUpdateCod
    && canProcessOrderCodAction(order.status, "collected", { requiresShipping: order.requiresShipping });
  // A rider can also fail to deliver the first parcel of a part-sent order (R3-ORD-04).
  const canRecordCodFailure = canUpdateCod && (canProcessOrderCodAction(order.status, "failed") || isPartSent(order));
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

  const refundCheckMutation = useReconcileRefundAttempt();
  const recoveryLinkMutation = useIssueOrderPaymentRecoveryLink();
  const presentation = buildOrderPaymentPresentation({ orderStatus: order.status, balanceDue: order.balanceDue });
  const showBadge = orderBadgeVisibility(order).payment;

  const openCod = (action: CodAction) => {
    // Usually the rider who took the parcel collected the cash (R3-ORD-08); still editable.
    setCodCollector(latestCourierName(order));
    setCodSession((session) => session + 1);
    setCodAction(action);
  };
  const openRefund = () => {
    setRefundSession((session) => session + 1);
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
          <Badge variant={statusBadgeVariant(order.paymentStatus, "payment")}>{paymentStatusLabel(o, order.paymentStatus, order.paymentMethod)}</Badge>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {inactiveApp ? (
          <Alert>
            <AlertDescription>{t("payment.appInactive", { app: providerLabel(inactiveApp), method: methodLabel(order.paymentMethod ?? "") })}</AlertDescription>
          </Alert>
        ) : null}
        {activeRefundCopy && activeRefund ? (
          <div role="status" className="space-y-1">
            <p className="font-medium">{activeRefundCopy.label} · {formatCurrencyAmount(activeRefund.amount, activeRefund.currency)}</p>
            {activeRefundCopy.help ? <p className="text-muted-foreground">{activeRefundCopy.help}</p> : null}
          </div>
        ) : null}

        <dl className="space-y-1 tabular-nums">
          <OrderSummaryRows order={order} />
          {methodPaidMinor > 0 ? (
            <Row label={t("payment.paidWith", { method: methodLabel(order.paymentMethod ?? "cod") })} value={money(methodPaid)} />
          ) : order.paymentMethod === "gift_card" && giftCardHeldMinor > 0 ? null : (
            <Row label={t("payment.method")} value={methodLabel(order.paymentMethod ?? "cod")} />
          )}
          <GiftCardTenderRows order={order} payments={payments} />
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

        {/* An invoice paid in full has no due date left to show. */}
        {terms && presentation.amountDue > 0 ? (
          <section className="space-y-2" aria-label={t("netTerms.title")} data-invoice-terms>
            <dl className="space-y-1">
              <Row label={t("netTerms.terms")} value={t("netTerms.netDays", { days: formatNumber(terms.days) })} />
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">{t("netTerms.due")}</dt>
                <dd className="flex items-center gap-2">
                  {formatOrderDate(terms.dueAt)}
                  {terms.overdue && !presentation.collectionClosed ? <Badge variant="destructive">{t("netTerms.overdue")}</Badge> : null}
                </dd>
              </div>
            </dl>
            {canRecordPayment && !presentation.collectionClosed && presentation.amountDue > 0 ? (
              <Button
                size="sm"
                variant="outline"
                disabled={isRefundLocked}
                onClick={() => {
                  setRecordSession((session) => session + 1);
                  setRecordOpen(true);
                }}
              >
                {t("netTerms.recordPayment")}
              </Button>
            ) : null}
          </section>
        ) : null}

        {isHydrated && paymentsQuery.isError ? (
          <InlineError title={t("history.failed")} error={paymentsQuery.error} onRetry={refetchPayments} />
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
                  <p>{[methodLabel(issue.provider), time(issue.processedAt)].filter(Boolean).join(" · ")}</p>
                  <p>{t(`webhook.reason.${issue.reason}`, { gateway: methodLabel(issue.provider) })}</p>
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
                        methodLabel(attempt.gateway),
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
                  <Button size="sm" variant="outline" disabled={isRefundLocked} onClick={() => openCod("collected")}>{collectTitle}</Button>
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
                const copy = refundStateCopy(t, attempt.status, attempt.gateway, methodLabel(attempt.gateway));
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
                        {orderDetailLabel(t, "payment.type.", payment.paymentType)} · {methodLabel(payment.paymentMethod)}
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
            {t(hasCashPayment ? "refund.recordCash" : "refund.issue")}
          </Button>
        ) : null}
      </CardContent>

      {codLoaded ? (
        <Suspense fallback={null}>
          <CodDialogs
            key={codSession}
            orderId={order.id}
            action={codAction}
            onClose={() => setCodAction(null)}
            initialCollector={codCollector}
            hasBalanceDue={hasCashBalanceDueOnDelivery}
            delivered={["delivered", "completed"].includes(order.status.toLowerCase())}
            collectTitle={collectTitle}
            cashAmount={cashCollectionAmount}
            amountDue={presentation.amountDue}
            sentUnits={sentUnits}
            money={money}
            canCollect={canRecordCodCollection}
            canFail={canRecordCodFailure}
            canReturn={canRecordCodReturn}
          />
        </Suspense>
      ) : null}

      {recordLoaded && terms ? (
        <Suspense fallback={null}>
          <RecordPaymentDialog
            key={recordSession}
            open={recordOpen}
            onClose={() => setRecordOpen(false)}
            orderId={order.id}
            orderVersion={order.version}
            currencyCode={order.currencyCode ?? ""}
            decimalPlaces={order.currencyDecimalPlaces ?? 2}
            balanceDue={presentation.amountDue}
            money={money}
          />
        </Suspense>
      ) : null}
      {refundLoaded ? (
        <Suspense fallback={null}>
          <RefundDialog
            key={refundSession}
            order={order}
            open={refundOpen}
            onOpenChange={setRefundOpen}
            paid={paid}
            money={money}
            locked={isRefundLocked}
            hasCashPayment={hasCashPayment}
          />
        </Suspense>
      ) : null}
    </Card>
  );
}

/** Who took the most recent parcel: your rider's name, or the courier service. */
export function latestCourierName(order: Pick<Order, "shipments">): string {
  const when = (value: OrderTimestamp) => (value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value));
  const latest = [...(order.shipments ?? [])]
    .filter((shipment) => shipment.status.toLowerCase() !== "cancelled")
    .sort((a, b) => when(b.createdAt) - when(a.createdAt))[0];
  if (!latest) return "";
  const name = latest.providerType === "manual" ? latest.courierName : latest.providerName ?? latest.courierName;
  return name?.trim() ?? "";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-end">{value}</dd>
    </div>
  );
}
