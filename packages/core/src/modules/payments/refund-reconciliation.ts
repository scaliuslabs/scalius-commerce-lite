import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  PaymentRecordStatus,
  refundAttempts,
  orderPayments,
  orders,
  webhookEvents,
  type RefundAttempt,
} from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { roundPrice } from "@scalius/shared/price-utils";
import {
  assertOrderPaymentCurrency,
  resolveOrderCurrencySnapshot,
  roundOrderMoney,
  type OrderCurrencySnapshot,
} from "./order-currency";
import { resolveRefundProviderMoney } from "./refund-provider-money";
import { COD_PAYMENT_METHOD, getPaymentGateway } from "./gateways/registry";
import type { GatewayProviderRefund, GatewayRefundProbe } from "./gateways/port";
import { finalizeAcceptedRefundAttemptIds } from "./refund-service";
import type { RefundNotificationFact } from "./refund-service";

const REFUND_RECONCILIATION_LEASE_SECONDS = 5 * 60;
const REFUND_RECONCILIATION_RETRY_SECONDS = 15 * 60;
const REFUND_RECONCILIATION_MANUAL_REVIEW_SECONDS = 6 * 60 * 60;
const MAX_REFUND_RECONCILIATION_ERROR_LENGTH = 500;
/** webhook_events.event_type of a provider-reported refund awaiting import. */
export const REFUND_OBSERVED_EVENT_TYPE = "refund.observed";
const EXTERNAL_REFUND_SOURCE = "external_refund_webhook";

const RECOVERABLE_REFUND_ATTEMPT_STATUSES = [
  "pending",
  "processing",
  "provider_unknown",
  "reconcile_required",
] as const;

type RecoverableRefundAttemptStatus = (typeof RECOVERABLE_REFUND_ATTEMPT_STATUSES)[number];

type RefundAttemptProbeRow = Pick<
  RefundAttempt,
  | "id"
  | "refundGroupId"
  | "orderId"
  | "refundPaymentId"
  | "gateway"
  | "amount"
  | "currency"
  | "status"
  | "sourcePaymentId"
  | "sourceTransactionId"
  | "providerRefundId"
  | "providerIdempotencyKey"
  | "refundReference"
>;

interface RefundProviderReconciliationContext {
  currency: OrderCurrencySnapshot;
}

type ProviderProbeOutcome = GatewayRefundProbe;

export interface RefundReconciliationResult {
  scanned: number;
  claimed: number;
  finalized: number;
  failed: number;
  deferred: number;
  errors: Array<{ attemptId: string; message: string }>;
  finalizedOrderIds: string[];
  refundNotifications: RefundNotificationFact[];
  limit: number;
  hasMore: boolean;
}

export interface ExternalRefundWebhookReconciliationResult {
  scanned: number;
  imported: number;
  finalized: number;
  skipped: number;
  deferred: number;
  errors: Array<{ webhookEventId: string; message: string }>;
  finalizedOrderIds: string[];
  refundNotifications: RefundNotificationFact[];
  limit: number;
  hasMore: boolean;
}

export interface RefundReconciliationOptions {
  encryptionKey?: string;
  limit?: number;
  nowSeconds?: number;
}

export type ManualRefundAttemptReconciliationReason =
  | "not_found"
  | "not_recoverable"
  | "leased"
  | "pending_not_due"
  | "claim_unavailable"
  | "reconciliation_error";

export interface ManualRefundAttemptReconciliationResult {
  found: boolean;
  status: "finalized" | "failed" | "deferred";
  reason?: ManualRefundAttemptReconciliationReason;
  orderIds: string[];
  refundNotifications: RefundNotificationFact[];
}

export interface ExternalRefundWebhookReconciliationOptions {
  encryptionKey?: string;
  limit?: number;
  nowSeconds?: number;
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) return 5;
  return Math.max(1, Math.min(25, Math.floor(limit)));
}

function serializeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown refund reconciliation error");
  return message.slice(0, MAX_REFUND_RECONCILIATION_ERROR_LENGTH);
}

function responsePayload(value: Record<string, unknown> | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}

function isConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /constraint|unique|primary key/i.test(message);
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 96);
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function externalRefundWebhookResult(
  previousResult: string | null,
  patch: Record<string, unknown>,
  nowSeconds: number,
): Record<string, unknown> {
  return {
    ...parseJsonObject(previousResult),
    externalRefundReconciliation: {
      ...patch,
      observedAt: nowSeconds,
    },
  };
}

async function markExternalRefundWebhook(
  db: Database,
  eventId: string,
  status: "processed" | "manual_reconciliation",
  previousResult: string | null,
  patch: Record<string, unknown>,
  nowSeconds: number,
): Promise<void> {
  await db.update(webhookEvents).set({
    status,
    result: JSON.stringify(externalRefundWebhookResult(previousResult, patch, nowSeconds)),
    processedAt: sql`unixepoch()`,
  }).where(eq(webhookEvents.id, eventId));
}

function buildRefundAttemptStateNotificationFact(
  attempt: RefundAttemptProbeRow,
  notificationType: Extract<RefundNotificationFact["notificationType"], "refund_processing" | "refund_failed">,
  options: { providerRefundId?: string | null } = {},
): RefundNotificationFact {
  const state = notificationType === "refund_processing" ? "processing" : "failed";
  return {
    orderId: attempt.orderId,
    notificationType,
    dedupeKey: `refund:${attempt.orderId}:${attempt.refundGroupId}:${state}`,
    amount: roundPrice(attempt.amount, attempt.currency),
    refundId: options.providerRefundId ?? attempt.providerRefundId ?? undefined,
  };
}

async function assertRefundAttemptOrderCurrency(
  db: Database,
  attempt: RefundAttemptProbeRow,
): Promise<RefundProviderReconciliationContext> {
  const order = await db
    .select({
      currencyCode: orders.currencyCode,
      currencyDecimalPlaces: orders.currencyDecimalPlaces,
    })
    .from(orders)
    .where(eq(orders.id, attempt.orderId))
    .get();
  if (!order) {
    throw new Error(`Order ${attempt.orderId} was not found for refund reconciliation.`);
  }
  const currency = resolveOrderCurrencySnapshot(order);
  assertOrderPaymentCurrency(attempt.currency, currency, "Refund attempt");

  const ledgerRows = await db
    .select({
      id: orderPayments.id,
      currency: orderPayments.currency,
    })
    .from(orderPayments)
    .where(eq(orderPayments.orderId, attempt.orderId))
    .all();
  for (const payment of ledgerRows) {
    assertOrderPaymentCurrency(payment.currency, currency, "Order payment ledger");
  }
  if (!ledgerRows.some((payment) => payment.id === attempt.refundPaymentId)) {
    throw new Error(`Refund payment ${attempt.refundPaymentId} was not found for reconciliation.`);
  }
  return { currency };
}

async function claimRefundAttempt(
  db: Database,
  attemptId: string,
  nowSeconds: number,
  options: { requireDue?: boolean } = {},
): Promise<boolean> {
  const claimId = `refund_reconcile:${attemptId}:${nowSeconds}`;
  const conditions = [
    eq(refundAttempts.id, attemptId),
    inArray(refundAttempts.status, [...RECOVERABLE_REFUND_ATTEMPT_STATUSES]),
    or(isNull(refundAttempts.claimExpiresAt), lte(refundAttempts.claimExpiresAt, nowSeconds)),
  ];
  if (options.requireDue !== false) {
    conditions.push(lte(refundAttempts.nextProbeAt, nowSeconds));
  }

  const rows = await db.update(refundAttempts).set({
    claimId,
    claimExpiresAt: nowSeconds + REFUND_RECONCILIATION_LEASE_SECONDS,
    attempts: sql`${refundAttempts.attempts} + 1`,
    updatedAt: sql`unixepoch()`,
  }).where(and(...conditions)).returning({ id: refundAttempts.id });

  return rows.length > 0;
}

async function markAttemptDeferred(
  db: Database,
  attempt: RefundAttemptProbeRow,
  outcome: Extract<ProviderProbeOutcome, { outcome: "processing" | "unknown" }>,
  nowSeconds: number,
): Promise<void> {
  const nextProbeDelay = outcome.manualReview
    ? REFUND_RECONCILIATION_MANUAL_REVIEW_SECONDS
    : REFUND_RECONCILIATION_RETRY_SECONDS;

  await db.update(refundAttempts).set({
    status: "provider_unknown",
    providerStatus: outcome.providerStatus ?? outcome.outcome,
    providerRefundId: outcome.providerRefundId ?? attempt.providerRefundId ?? null,
    responsePayload: responsePayload(outcome.responsePayload),
    claimId: null,
    claimExpiresAt: null,
    lastProbeAt: nowSeconds,
    nextProbeAt: nowSeconds + nextProbeDelay,
    lastError: outcome.error?.slice(0, MAX_REFUND_RECONCILIATION_ERROR_LENGTH) ?? null,
    updatedAt: sql`unixepoch()`,
  }).where(eq(refundAttempts.id, attempt.id));
}

async function markAttemptFailed(
  db: Database,
  attempt: RefundAttemptProbeRow,
  outcome: Extract<ProviderProbeOutcome, { outcome: "rejected" }>,
  nowSeconds: number,
): Promise<void> {
  await db.batch([
    db.update(orderPayments).set({
      status: PaymentRecordStatus.FAILED,
      updatedAt: sql`unixepoch()`,
    }).where(eq(orderPayments.id, attempt.refundPaymentId)),
    db.update(refundAttempts).set({
      status: "failed",
      providerStatus: outcome.providerStatus,
      providerRefundId: outcome.providerRefundId ?? attempt.providerRefundId ?? null,
      responsePayload: responsePayload(outcome.responsePayload),
      claimId: null,
      claimExpiresAt: null,
      lastProbeAt: nowSeconds,
      lastError: outcome.error?.slice(0, MAX_REFUND_RECONCILIATION_ERROR_LENGTH) ?? null,
      failedAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    }).where(eq(refundAttempts.id, attempt.id)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
  ] as any);
}

async function markAttemptReconcileRequired(
  db: Database,
  attempt: RefundAttemptProbeRow,
  error: unknown,
  nowSeconds: number,
): Promise<void> {
  await db.update(refundAttempts).set({
    status: "reconcile_required",
    providerStatus: "accepted",
    claimId: null,
    claimExpiresAt: null,
    lastProbeAt: nowSeconds,
    nextProbeAt: nowSeconds + REFUND_RECONCILIATION_RETRY_SECONDS,
    lastError: serializeError(error),
    updatedAt: sql`unixepoch()`,
  }).where(eq(refundAttempts.id, attempt.id));
}

async function markAcceptedBeforeFinalize(
  db: Database,
  attempt: RefundAttemptProbeRow,
  outcome: Extract<ProviderProbeOutcome, { outcome: "accepted" }>,
  nowSeconds: number,
): Promise<void> {
  await db.update(refundAttempts).set({
    providerStatus: outcome.providerStatus,
    providerRefundId: outcome.providerRefundId ?? attempt.providerRefundId ?? null,
    responsePayload: responsePayload(outcome.responsePayload),
    lastProbeAt: nowSeconds,
    lastError: null,
    updatedAt: sql`unixepoch()`,
  }).where(eq(refundAttempts.id, attempt.id));
}

async function probeProviderRefund(
  db: Database,
  attempt: RefundAttemptProbeRow,
  context: RefundProviderReconciliationContext,
  encryptionKey?: string,
): Promise<ProviderProbeOutcome> {
  if (attempt.gateway === COD_PAYMENT_METHOD) {
    return { outcome: "accepted", providerRefundId: attempt.providerRefundId, providerStatus: "accepted" };
  }
  const gateway = getPaymentGateway(attempt.gateway);
  if (!gateway?.refundStatus) {
    return { outcome: "unknown", error: `Unsupported refund gateway '${attempt.gateway}'`, manualReview: true };
  }
  const settings = await gateway.loadSettings(db, encryptionKey);
  if (!settings || settings.credentialErrors?.length || !gateway.canVerify(settings)) {
    return { outcome: "unknown", error: `${gateway.label} is not configured for refund reconciliation`, manualReview: true };
  }
  const money = resolveRefundProviderMoney(attempt.amount, context.currency, `${gateway.label} refund`);
  return gateway.refundStatus(settings, {
    providerRefundId: attempt.providerRefundId,
    sourceRef: attempt.sourceTransactionId,
    amountMinor: money.amountMinor,
    currency: money.currency,
    reference: attempt.refundReference,
    idempotencyKey: attempt.providerIdempotencyKey,
  });
}

type ExternalRefundWebhookRow = {
  id: string;
  provider: string;
  orderId: string | null;
  result: string | null;
};

type SourcePaymentRow = {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  providerRef: string | null;
  providerSecondaryRef: string | null;
};

function getExternalRefundEvidence(row: ExternalRefundWebhookRow): {
  providerRef?: string;
  secondaryRef?: string;
  eventOrderId?: string;
} {
  const result = parseJsonObject(row.result);
  return {
    providerRef: optionalString(result.providerRef),
    secondaryRef: optionalString(result.secondaryRef),
    eventOrderId: row.orderId ?? optionalString(result.orderId),
  };
}

async function findSourcePayment(
  db: Database,
  provider: string,
  evidence: ReturnType<typeof getExternalRefundEvidence>,
): Promise<SourcePaymentRow | undefined> {
  const matchers = [
    evidence.secondaryRef ? eq(orderPayments.providerSecondaryRef, evidence.secondaryRef) : undefined,
    evidence.providerRef ? eq(orderPayments.providerRef, evidence.providerRef) : undefined,
  ].filter(Boolean);
  if (matchers.length === 0) return undefined;

  const sourcePayment = await db
    .select({
      id: orderPayments.id,
      orderId: orderPayments.orderId,
      amount: orderPayments.amount,
      currency: orderPayments.currency,
      paymentMethod: orderPayments.paymentMethod,
      providerRef: orderPayments.providerRef,
      providerSecondaryRef: orderPayments.providerSecondaryRef,
    })
    .from(orderPayments)
    .where(and(
      eq(orderPayments.paymentMethod, provider),
      eq(orderPayments.status, PaymentRecordStatus.SUCCEEDED),
      sql`${orderPayments.paymentType} <> 'refund'`,
      matchers.length === 1 ? matchers[0] : or(...matchers),
    ))
    .get() as SourcePaymentRow | undefined;
  if (sourcePayment && evidence.eventOrderId && sourcePayment.orderId !== evidence.eventOrderId) {
    return undefined;
  }
  return sourcePayment;
}

async function getRefundedAmountForSourcePayment(
  db: Database,
  sourcePaymentId: string,
  currency: OrderCurrencySnapshot,
): Promise<number> {
  const rows = await db
    .select({ amount: orderPayments.amount, currency: orderPayments.currency })
    .from(refundAttempts)
    .innerJoin(orderPayments, eq(orderPayments.id, refundAttempts.refundPaymentId))
    .where(and(
      eq(refundAttempts.sourcePaymentId, sourcePaymentId),
      eq(orderPayments.status, PaymentRecordStatus.REFUNDED),
    ));
  for (const row of rows) {
    assertOrderPaymentCurrency(row.currency, currency, "Prior refund payment");
  }
  return roundOrderMoney(
    rows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
    currency,
  );
}

async function getExistingRefundAttemptByProviderRefundId(
  db: Database,
  provider: string,
  refundId: string,
): Promise<{ id: string; status: string } | undefined> {
  return await db
    .select({ id: refundAttempts.id, status: refundAttempts.status })
    .from(refundAttempts)
    .where(and(
      eq(refundAttempts.gateway, provider),
      eq(refundAttempts.providerRefundId, refundId),
    ))
    .get() as { id: string; status: string } | undefined;
}

async function insertExternalRefundAttempt(
  db: Database,
  params: {
    webhookEventId: string;
    sourcePayment: SourcePaymentRow;
    refund: GatewayProviderRefund;
    amount: number;
    nowSeconds: number;
  },
): Promise<string> {
  const provider = params.sourcePayment.paymentMethod;
  const refundIdPart = sanitizeIdPart(params.refund.id);
  const refundPaymentId = `refund_${provider}_external_${refundIdPart}`;
  const attemptId = `rfa_${provider}_external_${refundIdPart}`;
  const refundGroupId = `${provider}_external_${sanitizeIdPart(params.sourcePayment.orderId)}_${refundIdPart}`;
  const sourceTransactionId = params.sourcePayment.providerSecondaryRef ?? params.sourcePayment.providerRef;
  const metadata = JSON.stringify({
    source: EXTERNAL_REFUND_SOURCE,
    webhookEventId: params.webhookEventId,
    gateway: provider,
    sourcePaymentId: params.sourcePayment.id,
    sourceTransactionId,
    providerRef: params.sourcePayment.providerRef,
    providerRefundId: params.refund.id,
    providerStatus: params.refund.status,
    providerAmount: params.refund.amountMinor,
    providerCurrency: params.refund.currency,
    amount: params.amount,
  });
  const payload = JSON.stringify({
    source: EXTERNAL_REFUND_SOURCE,
    webhookEventId: params.webhookEventId,
    providerRefundId: params.refund.id,
    providerStatus: params.refund.status,
    amount: params.refund.amountMinor,
    currency: params.refund.currency,
    sourceRef: params.refund.sourceRef,
  });

  try {
    await db.batch([
      // The refund row never copies the source provider_ref: UNIQUE(provider,
      // provider_ref) belongs to the captured payment.
      db.insert(orderPayments).values({
        id: refundPaymentId,
        orderId: params.sourcePayment.orderId,
        amount: params.amount,
        currency: params.sourcePayment.currency || params.refund.currency,
        paymentMethod: provider,
        paymentType: "refund",
        status: PaymentRecordStatus.PENDING,
        metadata,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      }),
      db.insert(refundAttempts).values({
        id: attemptId,
        attemptKey: `external:${provider}:${params.refund.id}`,
        refundGroupId,
        orderId: params.sourcePayment.orderId,
        sourcePaymentId: params.sourcePayment.id,
        refundPaymentId,
        gateway: provider,
        amount: params.amount,
        currency: params.sourcePayment.currency || params.refund.currency,
        reason: "External provider refund",
        requestHash: `external:${provider}:${params.refund.id}:${params.refund.amountMinor}:${params.refund.currency}`,
        providerIdempotencyKey: `external:${provider}:${params.refund.id}`,
        refundReference: `${provider}-external:${params.refund.id}`,
        allocationIndex: 0,
        allocationCount: 1,
        sourceTransactionId,
        providerRefundId: params.refund.id,
        providerStatus: params.refund.status ?? "succeeded",
        requestPayload: payload,
        responsePayload: payload,
        status: "reconcile_required",
        attempts: 0,
        nextProbeAt: params.nowSeconds,
        metadata,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    ] as any);
  } catch (error: unknown) {
    if (!isConstraintError(error)) throw error;
    const existing = await getExistingRefundAttemptByProviderRefundId(db, provider, params.refund.id);
    if (existing) return existing.id;
    throw error;
  }

  return attemptId;
}

type ExternalRefundEventResult = {
  imported: number;
  finalized: number;
  skipped: number;
  deferred: number;
  finalizedOrderIds: string[];
  refundNotifications: RefundNotificationFact[];
};

const DEFERRED_EVENT: ExternalRefundEventResult = {
  imported: 0, finalized: 0, skipped: 0, deferred: 1, finalizedOrderIds: [], refundNotifications: [],
};

/**
 * Import refunds a merchant issued in the provider dashboard. The observed
 * webhook is only a hint: the refunds imported are the ones the provider lists
 * for the captured transaction, each at most once by provider refund id.
 */
async function reconcileExternalRefundWebhookEvent(
  db: Database,
  row: ExternalRefundWebhookRow,
  options: ExternalRefundWebhookReconciliationOptions,
): Promise<ExternalRefundEventResult> {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const defer = async (patch: Record<string, unknown>): Promise<ExternalRefundEventResult> => {
    await markExternalRefundWebhook(db, row.id, "manual_reconciliation", row.result, { outcome: "deferred", ...patch }, nowSeconds);
    return DEFERRED_EVENT;
  };
  const evidence = getExternalRefundEvidence(row);
  const gateway = getPaymentGateway(row.provider);
  if (!gateway?.listRefunds) return defer({ reason: "external_refund_import_unsupported" });
  if (!evidence.secondaryRef) return defer({ reason: "source_reference_missing" });

  const settings = await gateway.loadSettings(db, options.encryptionKey);
  if (!settings || settings.credentialErrors?.length || !gateway.canVerify(settings)) {
    return defer({ reason: "provider_settings_unavailable" });
  }

  const sourcePayment = await findSourcePayment(db, row.provider, evidence);
  if (!sourcePayment) {
    return defer({
      reason: "local_source_payment_not_found",
      providerRef: evidence.providerRef ?? null,
      secondaryRef: evidence.secondaryRef,
    });
  }
  const order = await db
    .select({
      currencyCode: orders.currencyCode,
      currencyDecimalPlaces: orders.currencyDecimalPlaces,
    })
    .from(orders)
    .where(eq(orders.id, sourcePayment.orderId))
    .get();
  if (!order) {
    throw new Error(`Order ${sourcePayment.orderId} was not found for external refund reconciliation.`);
  }
  const currency = resolveOrderCurrencySnapshot(order);
  assertOrderPaymentCurrency(sourcePayment.currency, currency, `${gateway.label} source payment`);

  let providerRefunds: GatewayProviderRefund[];
  try {
    providerRefunds = (await gateway.listRefunds(settings, evidence.secondaryRef))
      .filter((refund) => refund.sourceRef === evidence.secondaryRef);
  } catch (error: unknown) {
    return defer({ reason: "provider_refund_list_failed", error: serializeError(error) });
  }
  const succeededRefunds = providerRefunds.filter((refund) => refund.succeeded && refund.amountMinor > 0);
  if (succeededRefunds.length === 0) {
    return defer({ reason: "no_succeeded_provider_refunds", providerRefundCount: providerRefunds.length });
  }

  let imported = 0;
  let finalized = 0;
  let skipped = 0;
  let deferred = 0;
  const importedRefundIds: string[] = [];
  const finalizedOrderIds = new Set<string>();
  const refundNotifications: RefundNotificationFact[] = [];

  for (const refund of succeededRefunds) {
    assertOrderPaymentCurrency(refund.currency, currency, `${gateway.label} provider refund`);
    const existing = await getExistingRefundAttemptByProviderRefundId(db, row.provider, refund.id);
    if (existing) {
      skipped += 1;
      if (existing.status !== "refunded") {
        deferred += 1;
      }
      continue;
    }

    const amount = roundOrderMoney(
      refund.amountMinor / Math.pow(10, currency.decimalPlaces),
      currency,
    );
    const alreadyRefunded = await getRefundedAmountForSourcePayment(db, sourcePayment.id, currency);
    const remaining = roundOrderMoney(Number(sourcePayment.amount ?? 0) - alreadyRefunded, currency);
    if (amount <= 0 || amount > remaining + 0.000001) {
      deferred += 1;
      continue;
    }

    const attemptId = await insertExternalRefundAttempt(db, {
      webhookEventId: row.id,
      sourcePayment,
      refund,
      amount,
      nowSeconds,
    });
    imported += 1;
    importedRefundIds.push(refund.id);

    try {
      const result = await finalizeAcceptedRefundAttemptIds(db, [attemptId]);
      finalized += result.finalizedAttemptIds.length;
      result.orderIds.forEach((orderId) => finalizedOrderIds.add(orderId));
      refundNotifications.push(...result.refundNotifications);
    } catch (error: unknown) {
      deferred += 1;
      await db.update(refundAttempts).set({
        lastError: serializeError(error),
        nextProbeAt: nowSeconds + REFUND_RECONCILIATION_RETRY_SECONDS,
        updatedAt: sql`unixepoch()`,
      }).where(eq(refundAttempts.id, attemptId));
    }
  }

  const allRepresented = deferred === 0;
  await markExternalRefundWebhook(db, row.id, allRepresented ? "processed" : "manual_reconciliation", row.result, {
    outcome: allRepresented ? "external_refund_reconciled" : "deferred",
    importedRefundIds,
    providerRefundIds: succeededRefunds.map((refund) => refund.id),
    imported,
    finalized,
    skipped,
    deferred,
  }, nowSeconds);

  return {
    imported,
    finalized,
    skipped,
    deferred,
    finalizedOrderIds: [...finalizedOrderIds],
    refundNotifications,
  };
}

export async function reconcileExternalRefundWebhooks(
  db: Database,
  options: ExternalRefundWebhookReconciliationOptions = {},
): Promise<ExternalRefundWebhookReconciliationResult> {
  const limit = normalizeLimit(options.limit);
  const rows = await db
    .select({
      id: webhookEvents.id,
      provider: webhookEvents.provider,
      orderId: webhookEvents.orderId,
      result: webhookEvents.result,
    })
    .from(webhookEvents)
    .where(and(
      eq(webhookEvents.eventType, REFUND_OBSERVED_EVENT_TYPE),
      eq(webhookEvents.status, "manual_reconciliation"),
    ))
    .orderBy(asc(webhookEvents.processedAt))
    .limit(limit + 1) as ExternalRefundWebhookRow[];

  const targetRows = rows.slice(0, limit);
  const result: ExternalRefundWebhookReconciliationResult = {
    scanned: targetRows.length,
    imported: 0,
    finalized: 0,
    skipped: 0,
    deferred: 0,
    errors: [],
    finalizedOrderIds: [],
    refundNotifications: [],
    limit,
    hasMore: rows.length > limit,
  };

  const finalizedOrderIds = new Set<string>();
  for (const row of targetRows) {
    try {
      const eventResult = await reconcileExternalRefundWebhookEvent(db, row, options);
      result.imported += eventResult.imported;
      result.finalized += eventResult.finalized;
      result.skipped += eventResult.skipped;
      result.deferred += eventResult.deferred;
      eventResult.finalizedOrderIds.forEach((orderId) => finalizedOrderIds.add(orderId));
      result.refundNotifications.push(...eventResult.refundNotifications);
    } catch (error: unknown) {
      const message = serializeError(error);
      result.errors.push({ webhookEventId: row.id, message });
      await markExternalRefundWebhook(db, row.id, "manual_reconciliation", row.result, {
        outcome: "deferred",
        reason: "external_refund_reconciliation_error",
        error: message,
      }, options.nowSeconds ?? Math.floor(Date.now() / 1000));
    }
  }

  result.finalizedOrderIds = [...finalizedOrderIds];
  return result;
}

export async function reconcileRefundAttemptById(
  db: Database,
  attemptId: string,
  options: Omit<RefundReconciliationOptions, "limit"> = {},
): Promise<{
  status: "finalized" | "failed" | "deferred";
  orderIds: string[];
  refundNotifications: RefundNotificationFact[];
}> {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const attempt = await db
    .select({
      id: refundAttempts.id,
      refundGroupId: refundAttempts.refundGroupId,
      orderId: refundAttempts.orderId,
      refundPaymentId: refundAttempts.refundPaymentId,
      gateway: refundAttempts.gateway,
      amount: refundAttempts.amount,
      currency: refundAttempts.currency,
      status: refundAttempts.status,
      sourcePaymentId: refundAttempts.sourcePaymentId,
      sourceTransactionId: refundAttempts.sourceTransactionId,
      providerRefundId: refundAttempts.providerRefundId,
      providerIdempotencyKey: refundAttempts.providerIdempotencyKey,
      refundReference: refundAttempts.refundReference,
    })
    .from(refundAttempts)
    .where(eq(refundAttempts.id, attemptId))
    .get() as RefundAttemptProbeRow | undefined;

  if (!attempt || !RECOVERABLE_REFUND_ATTEMPT_STATUSES.includes(attempt.status as RecoverableRefundAttemptStatus)) {
    return { status: "deferred", orderIds: [], refundNotifications: [] };
  }

  const context = await assertRefundAttemptOrderCurrency(db, attempt);

  if (attempt.status === "pending") {
    await markAttemptFailed(db, attempt, {
      outcome: "rejected",
      providerStatus: "not_dispatched",
      error: "Refund attempt expired before provider dispatch and was released for retry.",
    }, nowSeconds);
    return { status: "failed", orderIds: [], refundNotifications: [] };
  }

  const outcome = attempt.status === "reconcile_required"
    ? {
        outcome: "accepted",
        providerRefundId: attempt.providerRefundId,
        providerStatus: attempt.gateway === COD_PAYMENT_METHOD ? "manual_confirmed" : "accepted",
      } satisfies ProviderProbeOutcome
    : await probeProviderRefund(db, attempt, context, options.encryptionKey);

  if (outcome.outcome === "accepted") {
    await markAcceptedBeforeFinalize(db, attempt, outcome, nowSeconds);
    try {
      const result = await finalizeAcceptedRefundAttemptIds(db, [attempt.id]);
      return {
        status: "finalized",
        orderIds: result.orderIds,
        refundNotifications: result.refundNotifications,
      };
    } catch (error: unknown) {
      await markAttemptReconcileRequired(db, attempt, error, nowSeconds);
      return { status: "deferred", orderIds: [], refundNotifications: [] };
    }
  }

  if (outcome.outcome === "rejected") {
    await markAttemptFailed(db, attempt, outcome, nowSeconds);
    return {
      status: "failed",
      orderIds: [],
      refundNotifications: [
        buildRefundAttemptStateNotificationFact(attempt, "refund_failed", {
          providerRefundId: outcome.providerRefundId,
        }),
      ],
    };
  }

  await markAttemptDeferred(db, attempt, outcome, nowSeconds);
  return {
    status: "deferred",
    orderIds: [],
    refundNotifications: outcome.outcome === "processing"
      ? [
          buildRefundAttemptStateNotificationFact(attempt, "refund_processing", {
            providerRefundId: outcome.providerRefundId,
          }),
        ]
      : [],
  };
}

export async function reconcileRefundAttemptForOrder(
  db: Database,
  orderId: string,
  attemptId: string,
  options: Omit<RefundReconciliationOptions, "limit"> = {},
): Promise<ManualRefundAttemptReconciliationResult> {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const attempt = await db
    .select({
      id: refundAttempts.id,
      orderId: refundAttempts.orderId,
      status: refundAttempts.status,
      claimExpiresAt: refundAttempts.claimExpiresAt,
      nextProbeAt: refundAttempts.nextProbeAt,
    })
    .from(refundAttempts)
    .where(and(
      eq(refundAttempts.id, attemptId),
      eq(refundAttempts.orderId, orderId),
    ))
    .get() as Pick<RefundAttempt, "id" | "orderId" | "status" | "claimExpiresAt" | "nextProbeAt"> | undefined;

  if (!attempt) {
    return { found: false, status: "deferred", reason: "not_found", orderIds: [], refundNotifications: [] };
  }
  if (!RECOVERABLE_REFUND_ATTEMPT_STATUSES.includes(attempt.status as RecoverableRefundAttemptStatus)) {
    return { found: true, status: "deferred", reason: "not_recoverable", orderIds: [], refundNotifications: [] };
  }
  if (attempt.claimExpiresAt && attempt.claimExpiresAt > nowSeconds) {
    return { found: true, status: "deferred", reason: "leased", orderIds: [], refundNotifications: [] };
  }
  if (attempt.status === "pending" && (!attempt.nextProbeAt || attempt.nextProbeAt > nowSeconds)) {
    return { found: true, status: "deferred", reason: "pending_not_due", orderIds: [], refundNotifications: [] };
  }

  const claimed = await claimRefundAttempt(db, attemptId, nowSeconds, {
    requireDue: attempt.status === "pending",
  });
  if (!claimed) {
    return { found: true, status: "deferred", reason: "claim_unavailable", orderIds: [], refundNotifications: [] };
  }

  try {
    const result = await reconcileRefundAttemptById(db, attemptId, {
      ...options,
      nowSeconds,
    });
    return { found: true, ...result };
  } catch (error: unknown) {
    const message = serializeError(error);
    await db.update(refundAttempts).set({
      claimId: null,
      claimExpiresAt: null,
      lastProbeAt: nowSeconds,
      nextProbeAt: nowSeconds + REFUND_RECONCILIATION_RETRY_SECONDS,
      lastError: message,
      updatedAt: sql`unixepoch()`,
    }).where(eq(refundAttempts.id, attemptId));
    return { found: true, status: "deferred", reason: "reconciliation_error", orderIds: [], refundNotifications: [] };
  }
}

export async function reconcileDueRefundAttempts(
  db: Database,
  options: RefundReconciliationOptions = {},
): Promise<RefundReconciliationResult> {
  const limit = normalizeLimit(options.limit);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const candidates = await db
    .select({ id: refundAttempts.id })
    .from(refundAttempts)
    .where(and(
      inArray(refundAttempts.status, [...RECOVERABLE_REFUND_ATTEMPT_STATUSES]),
      lte(refundAttempts.nextProbeAt, nowSeconds),
      or(isNull(refundAttempts.claimExpiresAt), lte(refundAttempts.claimExpiresAt, nowSeconds)),
    ))
    .orderBy(asc(refundAttempts.createdAt))
    .limit(limit + 1);

  const result: RefundReconciliationResult = {
    scanned: Math.min(candidates.length, limit),
    claimed: 0,
    finalized: 0,
    failed: 0,
    deferred: 0,
    errors: [],
    finalizedOrderIds: [],
    refundNotifications: [],
    limit,
    hasMore: candidates.length > limit,
  };

  for (const candidate of candidates.slice(0, limit)) {
    const claimed = await claimRefundAttempt(db, candidate.id, nowSeconds);
    if (!claimed) continue;
    result.claimed += 1;

    try {
      const reconciliation = await reconcileRefundAttemptById(db, candidate.id, {
        ...options,
        nowSeconds,
      });
      if (reconciliation.status === "finalized") {
        result.finalized += 1;
        result.finalizedOrderIds.push(...reconciliation.orderIds);
      } else if (reconciliation.status === "failed") {
        result.failed += 1;
      } else {
        result.deferred += 1;
      }
      result.refundNotifications.push(...reconciliation.refundNotifications);
    } catch (error: unknown) {
      const message = serializeError(error);
      result.errors.push({ attemptId: candidate.id, message });
      result.deferred += 1;
      await db.update(refundAttempts).set({
        claimId: null,
        claimExpiresAt: null,
        lastProbeAt: nowSeconds,
        nextProbeAt: nowSeconds + REFUND_RECONCILIATION_RETRY_SECONDS,
        lastError: message,
        updatedAt: sql`unixepoch()`,
      }).where(eq(refundAttempts.id, candidate.id));
    }
  }

  result.finalizedOrderIds = [...new Set(result.finalizedOrderIds)];
  return result;
}
