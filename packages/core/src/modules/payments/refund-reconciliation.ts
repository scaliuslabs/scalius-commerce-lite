import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  PaymentRecordStatus,
  notificationOutbox,
  refundAttempts,
  orderPayments,
  orders,
  webhookEvents,
  type RefundAttempt,
} from "@scalius/database/schema";
import { createOrderNotificationOutboxInsertValues } from "../notifications";
import { buildBatchGuard, isBatchGuardError, type Database } from "@scalius/database/client";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { sha256Hex } from "@scalius/shared/hash";
import { fromMinor } from "@scalius/shared/money";
import { presentedSettlement } from "@scalius/shared/money-chain";
import {
  assertOrderPaymentCurrency,
  resolveOrderCurrencySnapshot,
  type OrderCurrencySnapshot,
} from "./order-currency";
import {
  isManualSettlementMethod,
  paymentProvidersFor,
  type PaymentProviders,
  type PaymentProvidersSource,
} from "./gateways/registry";
import { providerErrorOf } from "@scalius/shared/plugins/providers/kinds";
import { canOperateExistingPayments, type GatewayProviderRefund, type GatewayRefundProbe } from "./gateways/port";
import { finalizeAcceptedRefundAttemptIds, isInternalRefundProviderStatus, refundNotificationOutboxId } from "./refund-service";
import {
  buildGiftCardClawbackSettlement,
  orderHasPurchasedGiftCardsSql,
  settleUnsettledGiftCardRefunds,
  type GiftCardClawbackSettlement,
} from "./refund-gift-card-clawback";
import {
  noActiveRefundAttemptForOrderIdCondition,
  REFUND_ATTEMPT_CLAIM_LOST,
  refundAttemptHeldCondition,
} from "../order-kernel";
import type { RefundNotificationFact } from "./refund-service";
import { ACTIVE_REFUND_ATTEMPT_STATUSES } from "../order-kernel";

const REFUND_RECONCILIATION_LEASE_SECONDS = 5 * 60;
const REFUND_RECONCILIATION_RETRY_SECONDS = 15 * 60;
const REFUND_RECONCILIATION_MANUAL_REVIEW_SECONDS = 6 * 60 * 60;
const MAX_REFUND_RECONCILIATION_ERROR_LENGTH = 500;
/** webhook_events.event_type of a provider-reported refund awaiting import. */
export const REFUND_OBSERVED_EVENT_TYPE = "refund.observed";
const EXTERNAL_REFUND_SOURCE = "external_refund_webhook";
/**
 * Why a provider-reported refund still waits: one of the order's own refunds
 * is in flight (its provider refund id not yet recorded). Not a merchant
 * issue: the next check matches it, and nothing is imported meanwhile.
 */
export const LOCAL_REFUND_IN_PROGRESS_REASON = "local_refund_in_progress";

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
  | "amountMinor"
  | "currency"
  | "status"
  | "sourcePaymentId"
  | "sourceTransactionId"
  | "providerRefundId"
  | "providerIdempotencyKey"
  | "refundReference"
> & { providerStatus?: string | null };

interface RefundProviderReconciliationContext {
  currency: OrderCurrencySnapshot;
  /** The order bought gift cards that were issued: ending its refund settles their clawback. */
  hasPurchasedGiftCards: boolean;
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
  /** The gateways to ask (built-in and app providers); built-in ones alone by default. */
  providers?: PaymentProvidersSource;
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
  providers?: PaymentProvidersSource;
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

/**
 * A provider's id inside a local row id: as it is when it is already
 * key-safe (rows imported before keep their ids), else hashed, so two
 * provider ids that differ only in punctuation or past 96 characters never
 * share a row.
 */
async function idPart(value: string): Promise<string> {
  return /^[A-Za-z0-9_-]{1,96}$/.test(value) ? value : `h${(await sha256Hex(value)).slice(0, 40)}`;
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
    amount: fromMinor(attempt.amountMinor, getDecimalPlaces(attempt.currency)),
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
      hasPurchasedGiftCards: orderHasPurchasedGiftCardsSql(attempt.orderId),
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
  return { currency, hasPurchasedGiftCards: Boolean(order.hasPurchasedGiftCards) };
}

async function claimRefundAttempt(
  db: Database,
  attemptId: string,
  nowSeconds: number,
  options: { requireDue?: boolean } = {},
): Promise<string | null> {
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

  return rows.length > 0 ? claimId : null;
}

/** An attempt as reconciliation read it, under the claim it took. */
type ClaimedAttempt = RefundAttemptProbeRow & { claimId: string };

/** Every reconciliation write's WHERE: the attempt still has the status read and this run's claim. */
function stillClaimed(attempt: ClaimedAttempt) {
  return and(
    eq(refundAttempts.id, attempt.id),
    eq(refundAttempts.claimId, attempt.claimId),
    eq(refundAttempts.status, attempt.status),
  )!;
}

/** The same precondition as a batch guard: a write whose claim was lost commits nothing. */
function claimGuard(db: Database, attempt: ClaimedAttempt) {
  return buildBatchGuard(db, refundAttemptHeldCondition(attempt.id, attempt.claimId, [attempt.status]), REFUND_ATTEMPT_CLAIM_LOST);
}

/** Run a claimed write; false when the claim was lost (nothing was written). */
async function writeWhileClaimed(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (error: unknown) {
    if (isBatchGuardError(error, REFUND_ATTEMPT_CLAIM_LOST)) return false;
    throw error;
  }
}

async function markAttemptDeferred(
  db: Database,
  attempt: ClaimedAttempt,
  outcome: Extract<ProviderProbeOutcome, { outcome: "processing" | "unknown" }>,
  nowSeconds: number,
): Promise<boolean> {
  const nextProbeDelay = outcome.manualReview
    ? REFUND_RECONCILIATION_MANUAL_REVIEW_SECONDS
    : REFUND_RECONCILIATION_RETRY_SECONDS;
  // Moving into provider_unknown (from a request that never got there): the
  // buyer's "refund processing" notice is written with the move, whatever
  // the probe said; once there, a later probe writes nothing.
  const processing = attempt.status === "provider_unknown"
    ? null
    : buildRefundAttemptStateNotificationFact(attempt, "refund_processing", { providerRefundId: outcome.providerRefundId });
  const processingOutbox = processing
    ? db.insert(notificationOutbox).values({
      ...createOrderNotificationOutboxInsertValues({
        orderId: processing.orderId,
        notificationType: processing.notificationType,
        dedupeKey: processing.dedupeKey,
        source: "refund-provider-unknown",
        data: { amount: processing.amount },
      }),
      id: await refundNotificationOutboxId(processing.dedupeKey),
    }).onConflictDoNothing({ target: notificationOutbox.dedupeKey })
    : null;

  return writeWhileClaimed(() => db.batch([
    claimGuard(db, attempt),
    ...(processingOutbox ? [processingOutbox] : []),
    db.update(refundAttempts).set({
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
  }).where(stillClaimed(attempt)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
  ] as any));
}

async function markAttemptFailed(
  db: Database,
  attempt: ClaimedAttempt,
  outcome: Extract<ProviderProbeOutcome, { outcome: "rejected" }>,
  nowSeconds: number,
  context: RefundProviderReconciliationContext,
): Promise<boolean> {
  // An order that bought gift cards: when this failure ends its refund, the
  // clawback settles in the same batch, guarded on the refund's other
  // attempts still being as read (a sibling ending at once makes this lose,
  // read again and settle).
  for (let round = 0; ; round += 1) {
    const settlement = context.hasPurchasedGiftCards
      ? await buildGiftCardClawbackSettlement(db, {
        orderId: attempt.orderId,
        refundGroupId: attempt.refundGroupId,
        outcomes: new Map([[attempt.id, "failed" as const]]),
      })
      : null;
    try {
      return await writeWhileClaimed(() => writeAttemptFailed(db, attempt, outcome, nowSeconds, settlement));
    } catch (error: unknown) {
      if (!settlement || !isBatchGuardError(error, ATTEMPT_FAILED_CONFLICT) || round >= 2) throw error;
    }
  }
}

const ATTEMPT_FAILED_CONFLICT = "refund_attempt_failed_conflict";

async function writeAttemptFailed(
  db: Database,
  attempt: ClaimedAttempt,
  outcome: Extract<ProviderProbeOutcome, { outcome: "rejected" }>,
  nowSeconds: number,
  settlement: GiftCardClawbackSettlement | null,
): Promise<void> {
  await db.batch([
    claimGuard(db, attempt),
    ...(settlement ? [buildBatchGuard(db, settlement.guard, ATTEMPT_FAILED_CONFLICT)] : []),
    db.update(orderPayments).set({
      status: PaymentRecordStatus.FAILED,
      updatedAt: sql`unixepoch()`,
    }).where(and(
      eq(orderPayments.id, attempt.refundPaymentId),
      eq(orderPayments.status, PaymentRecordStatus.PENDING),
      refundAttemptHeldCondition(attempt.id, attempt.claimId, [attempt.status]),
    )),
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
    }).where(stillClaimed(attempt)),
    ...(settlement?.statements ?? []),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
  ] as any);
}

async function markAttemptReconcileRequired(
  db: Database,
  attempt: ClaimedAttempt,
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
  // An attempt another run settled meanwhile (or took over) stays as it is.
  }).where(stillClaimed(attempt));
}

async function markAcceptedBeforeFinalize(
  db: Database,
  attempt: ClaimedAttempt,
  outcome: Extract<ProviderProbeOutcome, { outcome: "accepted" }>,
  nowSeconds: number,
): Promise<boolean> {
  const written = await db.update(refundAttempts).set({
    providerStatus: outcome.providerStatus,
    providerRefundId: outcome.providerRefundId ?? attempt.providerRefundId ?? null,
    responsePayload: responsePayload(outcome.responsePayload),
    lastProbeAt: nowSeconds,
    lastError: null,
    updatedAt: sql`unixepoch()`,
  }).where(stillClaimed(attempt)).returning({ id: refundAttempts.id });
  return written.length > 0;
}

async function probeProviderRefund(
  db: Database,
  attempt: RefundAttemptProbeRow,
  context: RefundProviderReconciliationContext,
  encryptionKey: string | undefined,
  providers: PaymentProviders,
): Promise<ProviderProbeOutcome> {
  // A gift-card credit or store-credit card committed with the refund claim:
  // the money already moved, so recovery only finalizes the order.
  if (isInternalRefundProviderStatus(attempt.providerStatus)) {
    return { outcome: "accepted", providerRefundId: attempt.providerRefundId, providerStatus: attempt.providerStatus! };
  }
  if (isManualSettlementMethod(attempt.gateway)) {
    return { outcome: "accepted", providerRefundId: attempt.providerRefundId, providerStatus: "accepted" };
  }
  const gateway = providers.get(attempt.gateway);
  if (!gateway?.refundStatus) {
    return { outcome: "unknown", error: `Unsupported refund gateway '${attempt.gateway}'`, manualReview: true };
  }
  const settings = await gateway.loadSettings(db, encryptionKey);
  if (!canOperateExistingPayments(gateway, settings)) {
    return { outcome: "unknown", error: `${gateway.label} is not configured for refund reconciliation`, manualReview: true };
  }
  if (!Number.isSafeInteger(attempt.amountMinor) || attempt.amountMinor <= 0) {
    return { outcome: "unknown", error: `${gateway.label} refund must resolve to a positive provider amount.`, manualReview: true };
  }
  try {
    return await gateway.refundStatus({
      providerRefundId: attempt.providerRefundId,
      sourceRef: attempt.sourceTransactionId,
      amountMinor: attempt.amountMinor,
      currency: context.currency.code,
      reference: attempt.refundReference,
      idempotencyKey: attempt.providerIdempotencyKey,
    }, { settings, signal: new AbortController().signal });
  } catch (error) {
    // A port error is an unanswered probe: the attempt stays pending and is asked again.
    const failure = providerErrorOf(error);
    if (!failure) throw error;
    return { outcome: "unknown", error: failure.message, manualReview: failure.category === "misconfigured" };
  }
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
  amountMinor: number;
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
      amountMinor: orderPayments.amountMinor,
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
    .select({ amountMinor: orderPayments.amountMinor, currency: orderPayments.currency })
    .from(refundAttempts)
    .innerJoin(orderPayments, eq(orderPayments.id, refundAttempts.refundPaymentId))
    .where(and(
      eq(refundAttempts.sourcePaymentId, sourcePaymentId),
      eq(orderPayments.status, PaymentRecordStatus.REFUNDED),
    ));
  for (const row of rows) {
    assertOrderPaymentCurrency(row.currency, currency, "Prior refund payment");
  }
  return rows.reduce((sum, row) => sum + row.amountMinor, 0);
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
    amountMinor: number;
    nowSeconds: number;
  },
): Promise<string | null> {
  const provider = params.sourcePayment.paymentMethod;
  const refundIdPart = await idPart(params.refund.id);
  const refundPaymentId = `refund_${provider}_external_${refundIdPart}`;
  const attemptId = `rfa_${provider}_external_${refundIdPart}`;
  const refundGroupId = `${provider}_external_${await idPart(params.sourcePayment.orderId)}_${refundIdPart}`;
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
    amountMinor: params.amountMinor,
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
      // A refund of the order that started since the checks owns its capacity: import it later.
      buildBatchGuard(db, noActiveRefundAttemptForOrderIdCondition(params.sourcePayment.orderId), EXTERNAL_REFUND_LOCAL_ACTIVE),
      // The refund row never copies the source provider_ref: UNIQUE(provider,
      // provider_ref) belongs to the captured payment.
      db.insert(orderPayments).values({
        id: refundPaymentId,
        orderId: params.sourcePayment.orderId,
        amountMinor: params.amountMinor,
        currency: params.sourcePayment.currency || params.refund.currency,
        // A refund made outside Scalius, recorded in its presentment currency.
        ...presentedSettlement(params.amountMinor, params.sourcePayment.currency || params.refund.currency),
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
        amountMinor: params.amountMinor,
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
    if (isBatchGuardError(error, EXTERNAL_REFUND_LOCAL_ACTIVE)) return null;
    if (!isConstraintError(error)) throw error;
    const existing = await getExistingRefundAttemptByProviderRefundId(db, provider, params.refund.id);
    if (existing) return existing.id;
    throw error;
  }

  return attemptId;
}

const EXTERNAL_REFUND_LOCAL_ACTIVE = "external_refund_local_refund_active";

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
  const gateway = (await paymentProvidersFor(options.providers, row.provider)).get(row.provider);
  if (!gateway?.listRefunds) return defer({ reason: "external_refund_import_unsupported" });
  if (!evidence.secondaryRef) return defer({ reason: "source_reference_missing" });

  const settings = await gateway.loadSettings(db, options.encryptionKey);
  if (!canOperateExistingPayments(gateway, settings)) {
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
    providerRefunds = (await gateway.listRefunds({ sourceRef: evidence.secondaryRef }, { settings, signal: new AbortController().signal }))
      .filter((refund) => refund.sourceRef === evidence.secondaryRef);
  } catch (error: unknown) {
    return defer({ reason: "provider_refund_list_failed", error: serializeError(error) });
  }
  const succeededRefunds = providerRefunds.filter((refund) => refund.succeeded && refund.amountMinor > 0);
  if (succeededRefunds.length === 0) {
    return defer({ reason: "no_succeeded_provider_refunds", providerRefundCount: providerRefunds.length });
  }
  // A refund this order sent is still settling: the provider already lists
  // it, but its id is not recorded here yet. Importing now would count it twice.
  if (await unrecordedProviderRefunds(db, row.provider, succeededRefunds).then((unrecorded) => unrecorded.length > 0)
    && await hasActiveLocalRefundAttempt(db, sourcePayment.orderId)) {
    return defer({ reason: LOCAL_REFUND_IN_PROGRESS_REASON });
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

    const amountMinor = refund.amountMinor;
    const alreadyRefunded = await getRefundedAmountForSourcePayment(db, sourcePayment.id, currency);
    const remaining = sourcePayment.amountMinor - alreadyRefunded;
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > remaining) {
      deferred += 1;
      continue;
    }

    const attemptId = await insertExternalRefundAttempt(db, {
      webhookEventId: row.id,
      sourcePayment,
      refund,
      amountMinor,
      nowSeconds,
    });
    if (!attemptId) {
      deferred += 1;
      continue;
    }
    imported += 1;
    importedRefundIds.push(refund.id);

    try {
      const result = await finalizeAcceptedRefundAttemptIds(db, [attemptId]);
      finalized += result.finalizedAttemptIds.length;
      result.orderIds.forEach((orderId) => finalizedOrderIds.add(orderId));
      refundNotifications.push(...result.refundNotifications);
    } catch (error: unknown) {
      deferred += 1;
      // The import's own attempt, unclaimed and not settled: reconciliation finishes it.
      await db.update(refundAttempts).set({
        lastError: serializeError(error),
        nextProbeAt: nowSeconds + REFUND_RECONCILIATION_RETRY_SECONDS,
        updatedAt: sql`unixepoch()`,
      }).where(and(eq(refundAttempts.id, attemptId), isNull(refundAttempts.claimId), eq(refundAttempts.status, "reconcile_required")));
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

/** The provider refunds no local attempt records yet, or records but has not finished. */
async function unrecordedProviderRefunds(
  db: Database,
  provider: string,
  refunds: readonly GatewayProviderRefund[],
): Promise<GatewayProviderRefund[]> {
  const unrecorded: GatewayProviderRefund[] = [];
  for (const refund of refunds) {
    const existing = await getExistingRefundAttemptByProviderRefundId(db, provider, refund.id);
    if (existing?.status !== "refunded") unrecorded.push(refund);
  }
  return unrecorded;
}

async function hasActiveLocalRefundAttempt(db: Database, orderId: string): Promise<boolean> {
  const active = await db.select({ id: refundAttempts.id }).from(refundAttempts)
    .where(and(eq(refundAttempts.orderId, orderId), inArray(refundAttempts.status, [...ACTIVE_REFUND_ATTEMPT_STATUSES])))
    .limit(1)
    .get();
  return Boolean(active);
}

/**
 * What a provider-reported refund (`refund_observed`) is, checked the moment
 * it arrives: `represented` when every refund the provider lists for the
 * transaction is already recorded here (the merchant's own refund from the
 * dashboard), `own_refund_in_progress` while one of the order's refunds is
 * still settling, `unrepresented` for a refund made outside Scalius (the
 * scheduled reconciliation imports it), `unverified` when the provider could
 * not be asked. Reads only: it never imports or changes money.
 */
export type ObservedRefundVerdict = "represented" | "own_refund_in_progress" | "unrepresented" | "unverified";

export async function verifyObservedRefund(
  db: Database,
  observed: { provider: string; orderId: string; providerRef?: string; secondaryRef?: string },
  options: Pick<ExternalRefundWebhookReconciliationOptions, "encryptionKey" | "providers"> = {},
): Promise<ObservedRefundVerdict> {
  try {
    const gateway = (await paymentProvidersFor(options.providers, observed.provider)).get(observed.provider);
    if (!gateway?.listRefunds || !observed.secondaryRef) return "unverified";
    const sourcePayment = await findSourcePayment(db, observed.provider, {
      providerRef: observed.providerRef,
      secondaryRef: observed.secondaryRef,
      eventOrderId: observed.orderId,
    });
    if (!sourcePayment) return "unverified";
    const settings = await gateway.loadSettings(db, options.encryptionKey);
    if (!canOperateExistingPayments(gateway, settings)) return "unverified";
    const succeeded = (await gateway.listRefunds({ sourceRef: observed.secondaryRef }, { settings, signal: new AbortController().signal }))
      .filter((refund) => refund.sourceRef === observed.secondaryRef && refund.succeeded && refund.amountMinor > 0);
    if (succeeded.length === 0) return "unverified";
    if ((await unrecordedProviderRefunds(db, observed.provider, succeeded)).length === 0) return "represented";
    return await hasActiveLocalRefundAttempt(db, sourcePayment.orderId) ? "own_refund_in_progress" : "unrepresented";
  } catch {
    return "unverified";
  }
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
  options: Omit<RefundReconciliationOptions, "limit"> & {
    /** The claim the caller took (`claimRefundAttempt`); without one, this takes its own. */
    claimId?: string;
  } = {},
): Promise<{
  status: "finalized" | "failed" | "deferred";
  orderIds: string[];
  refundNotifications: RefundNotificationFact[];
}> {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const claimId = options.claimId ?? await claimRefundAttempt(db, attemptId, nowSeconds, { requireDue: false });
  if (!claimId) return { status: "deferred", orderIds: [], refundNotifications: [] };
  const read = await db
    .select({
      id: refundAttempts.id,
      refundGroupId: refundAttempts.refundGroupId,
      orderId: refundAttempts.orderId,
      refundPaymentId: refundAttempts.refundPaymentId,
      gateway: refundAttempts.gateway,
      amountMinor: refundAttempts.amountMinor,
      currency: refundAttempts.currency,
      status: refundAttempts.status,
      sourcePaymentId: refundAttempts.sourcePaymentId,
      sourceTransactionId: refundAttempts.sourceTransactionId,
      providerRefundId: refundAttempts.providerRefundId,
      providerIdempotencyKey: refundAttempts.providerIdempotencyKey,
      refundReference: refundAttempts.refundReference,
      providerStatus: refundAttempts.providerStatus,
    })
    .from(refundAttempts)
    .where(and(eq(refundAttempts.id, attemptId), eq(refundAttempts.claimId, claimId)))
    .get() as RefundAttemptProbeRow | undefined;

  if (!read || !RECOVERABLE_REFUND_ATTEMPT_STATUSES.includes(read.status as RecoverableRefundAttemptStatus)) {
    return { status: "deferred", orderIds: [], refundNotifications: [] };
  }
  const attempt: ClaimedAttempt = { ...read, claimId };

  const context = await assertRefundAttemptOrderCurrency(db, attempt);

  if (attempt.status === "pending") {
    const released = await markAttemptFailed(db, attempt, {
      outcome: "rejected",
      providerStatus: "not_dispatched",
      error: "Refund attempt expired before provider dispatch and was released for retry.",
    }, nowSeconds, context);
    return { status: released ? "failed" : "deferred", orderIds: [], refundNotifications: [] };
  }

  const outcome = attempt.status === "reconcile_required"
    ? {
        outcome: "accepted",
        providerRefundId: attempt.providerRefundId,
        providerStatus: isInternalRefundProviderStatus(attempt.providerStatus)
          ? attempt.providerStatus!
          : isManualSettlementMethod(attempt.gateway) ? "manual_confirmed" : "accepted",
      } satisfies ProviderProbeOutcome
    : await probeProviderRefund(db, attempt, context, options.encryptionKey, await paymentProvidersFor(options.providers, attempt.gateway));

  if (outcome.outcome === "accepted") {
    // Another run took the attempt over (or settled it): it finishes the attempt.
    if (!await markAcceptedBeforeFinalize(db, attempt, outcome, nowSeconds)) {
      return { status: "deferred", orderIds: [], refundNotifications: [] };
    }
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
    if (!await markAttemptFailed(db, attempt, outcome, nowSeconds, context)) {
      return { status: "deferred", orderIds: [], refundNotifications: [] };
    }
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

  if (!await markAttemptDeferred(db, attempt, outcome, nowSeconds)) {
    return { status: "deferred", orderIds: [], refundNotifications: [] };
  }
  // "Your refund is processing" is said once, on the way into provider_unknown
  // (the request that left it unknown wrote it with that transition): a probe
  // that finds it still processing says nothing again, even after the outbox
  // row was pruned.
  return {
    status: "deferred",
    orderIds: [],
    // Its row was just written with the move (markAttemptDeferred): hand it to the sender now.
    refundNotifications: attempt.status !== "provider_unknown"
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

  const claimId = await claimRefundAttempt(db, attemptId, nowSeconds, {
    requireDue: attempt.status === "pending",
  });
  if (!claimId) {
    return { found: true, status: "deferred", reason: "claim_unavailable", orderIds: [], refundNotifications: [] };
  }

  try {
    const result = await reconcileRefundAttemptById(db, attemptId, {
      ...options,
      nowSeconds,
      claimId,
    });
    return { found: true, ...result };
  } catch (error: unknown) {
    await releaseFailedClaim(db, attemptId, claimId, nowSeconds, serializeError(error));
    return { found: true, status: "deferred", reason: "reconciliation_error", orderIds: [], refundNotifications: [] };
  }
}

/** A reconciliation that threw gives its claim back for the next tick, if it still holds it. */
async function releaseFailedClaim(db: Database, attemptId: string, claimId: string, nowSeconds: number, message: string): Promise<void> {
  await db.update(refundAttempts).set({
    claimId: null,
    claimExpiresAt: null,
    lastProbeAt: nowSeconds,
    nextProbeAt: nowSeconds + REFUND_RECONCILIATION_RETRY_SECONDS,
    lastError: message,
    updatedAt: sql`unixepoch()`,
  }).where(and(eq(refundAttempts.id, attemptId), eq(refundAttempts.claimId, claimId)));
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
    const claimId = await claimRefundAttempt(db, candidate.id, nowSeconds);
    if (!claimId) continue;
    result.claimed += 1;

    try {
      const reconciliation = await reconcileRefundAttemptById(db, candidate.id, {
        ...options,
        nowSeconds,
        claimId,
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
      await releaseFailedClaim(db, candidate.id, claimId, nowSeconds, message);
    }
  }

  // A refund whose attempts all ended without settling its gift cards, because
  // the settlement could not be planned or written then, settles here.
  try {
    await settleUnsettledGiftCardRefunds(db, { nowSeconds });
  } catch (error: unknown) {
    result.errors.push({ attemptId: "gift_card_settlement", message: serializeError(error) });
  }

  result.finalizedOrderIds = [...new Set(result.finalizedOrderIds)];
  return result;
}
