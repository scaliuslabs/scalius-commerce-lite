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
import { normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { roundPrice } from "@scalius/shared/price-utils";
import {
  assertOrderPaymentCurrency,
  resolveOrderCurrencySnapshot,
  roundOrderMoney,
  type OrderCurrencySnapshot,
} from "./order-currency";
import {
  resolvePolarRefundProviderMoney,
  resolveStripeRefundProviderMoney,
} from "./refund-provider-money";
import {
  getPolarSettings,
  getSSLCommerzSettings,
  getStripeSettings,
} from "./gateway-settings";
import {
  retrieveStripeRefund,
  listStripeRefundsForCharge,
} from "./stripe";
import type { StripeRefundSnapshot } from "./stripe";
import {
  querySSLCommerzRefundStatus,
} from "./sslcommerz";
import {
  listPolarRefunds,
} from "./polar";
import { finalizeAcceptedRefundAttemptIds } from "./refund-service";
import type { RefundNotificationFact } from "./refund-service";

const REFUND_RECONCILIATION_LEASE_SECONDS = 5 * 60;
const REFUND_RECONCILIATION_RETRY_SECONDS = 15 * 60;
const REFUND_RECONCILIATION_MANUAL_REVIEW_SECONDS = 6 * 60 * 60;
const MAX_REFUND_RECONCILIATION_ERROR_LENGTH = 500;
const STRIPE_EXTERNAL_REFUND_WEBHOOK_EVENT = "charge.refunded";
const STRIPE_EXTERNAL_REFUND_SOURCE = "stripe_external_webhook";

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
  sourcePayment: {
    amount: number;
    metadata: string | null;
  } | null;
}

type ProviderProbeOutcome =
  | {
      outcome: "accepted";
      providerRefundId?: string | null;
      providerStatus: string;
      responsePayload?: Record<string, unknown>;
    }
  | {
      outcome: "processing" | "unknown";
      providerRefundId?: string | null;
      providerStatus?: string;
      error?: string;
      responsePayload?: Record<string, unknown>;
      manualReview?: boolean;
    }
  | {
      outcome: "rejected";
      providerRefundId?: string | null;
      providerStatus: string;
      error?: string;
      responsePayload?: Record<string, unknown>;
    };

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

export interface StripeExternalRefundWebhookReconciliationResult {
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

export interface StripeExternalRefundWebhookReconciliationOptions {
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
    stripeExternalRefundReconciliation: {
      ...patch,
      observedAt: nowSeconds,
    },
  };
}

async function markStripeExternalRefundWebhook(
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

function metadataMatchesAttempt(
  metadata: Record<string, unknown> | undefined,
  attempt: RefundAttemptProbeRow,
): boolean {
  if (!metadata) return false;
  return (
    String(metadata.refundReference ?? "") === attempt.refundReference ||
    String(metadata.providerIdempotencyKey ?? "") === attempt.providerIdempotencyKey ||
    String(metadata.idempotencyKey ?? "") === attempt.providerIdempotencyKey
  );
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
      amount: orderPayments.amount,
      currency: orderPayments.currency,
      metadata: orderPayments.metadata,
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
  const sourcePayment = ledgerRows.find((payment) => payment.id === attempt.sourcePaymentId);
  if (attempt.gateway === "polar" && !sourcePayment) {
    throw new Error(`Polar source payment ${attempt.sourcePaymentId} was not found for reconciliation.`);
  }
  return {
    currency,
    sourcePayment: sourcePayment
      ? { amount: sourcePayment.amount, metadata: sourcePayment.metadata }
      : null,
  };
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

function mapStripeStatus(status: string | null | undefined): "accepted" | "processing" | "rejected" | "unknown" {
  if (status === "succeeded") return "accepted";
  if (status === "failed" || status === "canceled") return "rejected";
  if (status === "pending" || status === "requires_action") return "processing";
  return "unknown";
}

async function probeStripeRefund(
  db: Database,
  attempt: RefundAttemptProbeRow,
  context: RefundProviderReconciliationContext,
  encryptionKey?: string,
): Promise<ProviderProbeOutcome> {
  const settings = await getStripeSettings(db, encryptionKey);
  if (!settings?.secretKey) {
    return { outcome: "unknown", error: "Stripe is not configured for refund reconciliation", manualReview: true };
  }
  const expectedMoney = resolveStripeRefundProviderMoney(
    attempt.amount,
    context.currency,
  );

  let refund: StripeRefundSnapshot | undefined;
  if (attempt.providerRefundId) {
    const result = await retrieveStripeRefund(settings.secretKey, attempt.providerRefundId);
    if (!result.success) {
      return { outcome: "unknown", error: result.error ?? "Stripe refund probe failed" };
    }
    refund = result.refund;
  } else if (attempt.sourceTransactionId) {
    const result = await listStripeRefundsForCharge(settings.secretKey, attempt.sourceTransactionId, 20);
    if (!result.success) {
      return { outcome: "unknown", error: result.error ?? "Stripe refund probe failed" };
    }
    refund = result.refunds?.find((candidate) =>
      metadataMatchesAttempt(candidate.metadata, attempt) &&
      normalizeSupportedCurrencyCode(candidate.currency) === expectedMoney.currency &&
      candidate.amount === expectedMoney.amountMinor
    );
  }

  if (!refund) {
    return {
      outcome: "unknown",
      error: "No Stripe refund matched this attempt. Manual review required before retrying.",
      manualReview: true,
    };
  }
  if (
    attempt.sourceTransactionId &&
    refund.charge !== attempt.sourceTransactionId
  ) {
    return {
      outcome: "unknown",
      providerRefundId: refund.id,
      providerStatus: refund.status ?? "unknown",
      error: "Stripe refund source charge does not match the local refund attempt.",
      manualReview: true,
    };
  }
  if (
    normalizeSupportedCurrencyCode(refund.currency) !==
    context.currency.code
  ) {
    return {
      outcome: "unknown",
      error: "Stripe refund currency does not match the immutable order currency.",
      manualReview: true,
    };
  }
  if (refund.amount !== expectedMoney.amountMinor) {
    return {
      outcome: "unknown",
      providerRefundId: refund.id,
      providerStatus: refund.status ?? "unknown",
      error: "Stripe refund amount does not match the immutable local refund attempt.",
      responsePayload: {
        id: refund.id,
        status: refund.status,
        amount: refund.amount,
        currency: refund.currency,
        charge: refund.charge,
      },
      manualReview: true,
    };
  }

  const mapped = mapStripeStatus(refund.status);
  const payload = {
    id: refund.id,
    status: refund.status,
    amount: refund.amount,
    currency: refund.currency,
    charge: refund.charge,
  };

  if (mapped === "accepted") {
    return { outcome: "accepted", providerRefundId: refund.id, providerStatus: refund.status ?? "succeeded", responsePayload: payload };
  }
  if (mapped === "rejected") {
    return { outcome: "rejected", providerRefundId: refund.id, providerStatus: refund.status ?? "failed", responsePayload: payload };
  }
  return { outcome: mapped, providerRefundId: refund.id, providerStatus: refund.status ?? mapped, responsePayload: payload };
}

async function probeSSLCommerzRefund(
  db: Database,
  attempt: RefundAttemptProbeRow,
  encryptionKey?: string,
): Promise<ProviderProbeOutcome> {
  const settings = await getSSLCommerzSettings(db, encryptionKey);
  if (!settings?.storeId || !settings.storePassword) {
    return { outcome: "unknown", error: "SSLCommerz is not configured for refund reconciliation", manualReview: true };
  }
  if (!attempt.providerRefundId) {
    return {
      outcome: "unknown",
      error: "SSLCommerz refund reference is missing. Manual provider review required before retrying.",
      manualReview: true,
    };
  }

  const status = await querySSLCommerzRefundStatus(
    settings.storeId,
    settings.storePassword,
    settings.sandbox,
    attempt.providerRefundId,
  );
  const payload = {
    status: status.status,
    refundRefId: status.refundRefId,
    bankTranId: status.bankTranId,
    tranId: status.tranId,
    refundedOn: status.refundedOn,
  };

  if (status.error) {
    return { outcome: "unknown", providerRefundId: attempt.providerRefundId, providerStatus: status.status, error: status.error, responsePayload: payload };
  }
  if (status.status === "refunded") {
    return { outcome: "accepted", providerRefundId: status.refundRefId, providerStatus: status.status, responsePayload: payload };
  }
  if (status.status === "cancelled") {
    return { outcome: "rejected", providerRefundId: status.refundRefId, providerStatus: status.status, responsePayload: payload };
  }
  return { outcome: "processing", providerRefundId: status.refundRefId, providerStatus: status.status, responsePayload: payload };
}

async function probePolarRefund(
  db: Database,
  attempt: RefundAttemptProbeRow,
  context: RefundProviderReconciliationContext,
  encryptionKey?: string,
): Promise<ProviderProbeOutcome> {
  const settings = await getPolarSettings(db, encryptionKey);
  if (!settings?.accessToken) {
    return { outcome: "unknown", error: "Polar is not configured for refund reconciliation", manualReview: true };
  }

  const result = await listPolarRefunds(settings, {
    ...(attempt.providerRefundId ? { id: attempt.providerRefundId } : {}),
    ...(!attempt.providerRefundId && attempt.sourceTransactionId ? { orderId: attempt.sourceTransactionId } : {}),
    limit: 20,
  });
  if (!result.success) {
    return { outcome: "unknown", error: result.error ?? "Polar refund probe failed" };
  }

  const refund = attempt.providerRefundId
    ? result.refunds?.find((candidate) => candidate.id === attempt.providerRefundId)
    : result.refunds?.find((candidate) => metadataMatchesAttempt(candidate.metadata, attempt));

  if (!refund) {
    return {
      outcome: "unknown",
      error: "No Polar refund matched this attempt. Manual review required before retrying.",
      manualReview: true,
    };
  }
  if (
    attempt.sourceTransactionId &&
    refund.orderId !== attempt.sourceTransactionId
  ) {
    return {
      outcome: "unknown",
      providerRefundId: refund.id,
      providerStatus: refund.status,
      error: "Polar refund source order does not match the local refund attempt.",
      manualReview: true,
    };
  }

  const expectedMoney = resolvePolarRefundProviderMoney(
    attempt.amount,
    context.currency,
    context.sourcePayment!,
  );
  if (normalizeSupportedCurrencyCode(refund.currency) !== expectedMoney.currency) {
    return {
      outcome: "unknown",
      providerRefundId: refund.id,
      providerStatus: refund.status,
      error: "Polar refund currency does not match the source payment currency.",
      responsePayload: {
        id: refund.id,
        status: refund.status,
        amount: refund.amount,
        currency: refund.currency,
        orderId: refund.orderId,
      },
      manualReview: true,
    };
  }
  if (refund.amount !== expectedMoney.amountMinor) {
    return {
      outcome: "unknown",
      providerRefundId: refund.id,
      providerStatus: refund.status,
      error: "Polar refund amount does not match the immutable local refund attempt.",
      responsePayload: {
        id: refund.id,
        status: refund.status,
        amount: refund.amount,
        currency: refund.currency,
        orderId: refund.orderId,
      },
      manualReview: true,
    };
  }

  const payload = {
    id: refund.id,
    status: refund.status,
    amount: refund.amount,
    currency: refund.currency,
    orderId: refund.orderId,
  };

  if (refund.status === "succeeded") {
    return { outcome: "accepted", providerRefundId: refund.id, providerStatus: refund.status, responsePayload: payload };
  }
  if (refund.status === "failed" || refund.status === "canceled") {
    return { outcome: "rejected", providerRefundId: refund.id, providerStatus: refund.status, responsePayload: payload };
  }
  return { outcome: "processing", providerRefundId: refund.id, providerStatus: refund.status, responsePayload: payload };
}

async function probeProviderRefund(
  db: Database,
  kv: KVNamespace | undefined,
  attempt: RefundAttemptProbeRow,
  context: RefundProviderReconciliationContext,
  encryptionKey?: string,
): Promise<ProviderProbeOutcome> {
  switch (attempt.gateway) {
    case "stripe":
      return probeStripeRefund(db, attempt, context, encryptionKey);
    case "sslcommerz":
      return probeSSLCommerzRefund(db, attempt, encryptionKey);
    case "polar":
      return probePolarRefund(db, attempt, context, encryptionKey);
    case "cod":
      return { outcome: "accepted", providerRefundId: attempt.providerRefundId, providerStatus: "accepted" };
    default:
      return { outcome: "unknown", error: `Unsupported refund gateway '${attempt.gateway}'`, manualReview: true };
  }
}

type StripeExternalRefundWebhookRow = {
  id: string;
  orderId: string | null;
  result: string | null;
};

type StripeSourcePaymentRow = {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  stripePaymentIntentId: string | null;
  stripeChargeId: string | null;
};

function getStripeExternalRefundEvidence(row: StripeExternalRefundWebhookRow): {
  chargeId?: string;
  paymentIntentId?: string;
  eventOrderId?: string;
} {
  const result = parseJsonObject(row.result);
  return {
    chargeId: optionalString(result.chargeId),
    paymentIntentId: optionalString(result.paymentIntentId),
    eventOrderId: row.orderId ?? optionalString(result.orderId),
  };
}

async function findStripeSourcePayment(
  db: Database,
  evidence: ReturnType<typeof getStripeExternalRefundEvidence>,
): Promise<StripeSourcePaymentRow | undefined> {
  const matchers = [
    evidence.chargeId ? eq(orderPayments.stripeChargeId, evidence.chargeId) : undefined,
    evidence.paymentIntentId ? eq(orderPayments.stripePaymentIntentId, evidence.paymentIntentId) : undefined,
  ].filter(Boolean);
  if (matchers.length === 0) return undefined;

  const sourcePayment = await db
    .select({
      id: orderPayments.id,
      orderId: orderPayments.orderId,
      amount: orderPayments.amount,
      currency: orderPayments.currency,
      stripePaymentIntentId: orderPayments.stripePaymentIntentId,
      stripeChargeId: orderPayments.stripeChargeId,
    })
    .from(orderPayments)
    .where(and(
      eq(orderPayments.paymentMethod, "stripe"),
      eq(orderPayments.status, PaymentRecordStatus.SUCCEEDED),
      matchers.length === 1 ? matchers[0] : or(...matchers),
    ))
    .get() as StripeSourcePaymentRow | undefined;
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
  refundId: string,
): Promise<{ id: string; status: string } | undefined> {
  return await db
    .select({ id: refundAttempts.id, status: refundAttempts.status })
    .from(refundAttempts)
    .where(and(
      eq(refundAttempts.gateway, "stripe"),
      eq(refundAttempts.providerRefundId, refundId),
    ))
    .get() as { id: string; status: string } | undefined;
}

function buildExternalStripeRefundMetadata(params: {
  webhookEventId: string;
  sourcePayment: StripeSourcePaymentRow;
  refund: StripeRefundSnapshot;
  amount: number;
}): string {
  return JSON.stringify({
    source: STRIPE_EXTERNAL_REFUND_SOURCE,
    webhookEventId: params.webhookEventId,
    gateway: "stripe",
    sourcePaymentId: params.sourcePayment.id,
    sourceTransactionId: params.sourcePayment.stripeChargeId,
    paymentIntentId: params.sourcePayment.stripePaymentIntentId,
    providerRefundId: params.refund.id,
    providerStatus: params.refund.status,
    providerAmount: params.refund.amount,
    providerCurrency: params.refund.currency,
    amount: params.amount,
  });
}

async function insertExternalStripeRefundAttempt(
  db: Database,
  params: {
    webhookEventId: string;
    sourcePayment: StripeSourcePaymentRow;
    refund: StripeRefundSnapshot;
    amount: number;
    nowSeconds: number;
  },
): Promise<string> {
  const refundIdPart = sanitizeIdPart(params.refund.id);
  const refundPaymentId = `refund_stripe_external_${refundIdPart}`;
  const attemptId = `rfa_stripe_external_${refundIdPart}`;
  const refundGroupId = `stripe_external_${sanitizeIdPart(params.sourcePayment.orderId)}_${refundIdPart}`;
  const metadata = buildExternalStripeRefundMetadata(params);
  const payload = JSON.stringify({
    source: STRIPE_EXTERNAL_REFUND_SOURCE,
    webhookEventId: params.webhookEventId,
    providerRefundId: params.refund.id,
    providerStatus: params.refund.status,
    amount: params.refund.amount,
    currency: params.refund.currency,
    charge: params.refund.charge,
  });

  try {
    await db.batch([
      db.insert(orderPayments).values({
        id: refundPaymentId,
        orderId: params.sourcePayment.orderId,
        amount: params.amount,
        currency: params.sourcePayment.currency || params.refund.currency.toUpperCase(),
        paymentMethod: "stripe",
        paymentType: "refund",
        status: PaymentRecordStatus.PENDING,
        stripePaymentIntentId: params.sourcePayment.stripePaymentIntentId,
        stripeChargeId: params.sourcePayment.stripeChargeId,
        metadata,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      }),
      db.insert(refundAttempts).values({
        id: attemptId,
        attemptKey: `external:stripe:${params.refund.id}`,
        refundGroupId,
        orderId: params.sourcePayment.orderId,
        sourcePaymentId: params.sourcePayment.id,
        refundPaymentId,
        gateway: "stripe",
        amount: params.amount,
        currency: params.sourcePayment.currency || params.refund.currency.toUpperCase(),
        reason: "External Stripe refund",
        requestHash: `external:stripe:${params.refund.id}:${params.refund.amount}:${params.refund.currency}`,
        providerIdempotencyKey: `external:stripe:${params.refund.id}`,
        refundReference: `stripe-external:${params.refund.id}`,
        allocationIndex: 0,
        allocationCount: 1,
        sourceTransactionId: params.sourcePayment.stripeChargeId,
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
    const existing = await getExistingRefundAttemptByProviderRefundId(db, params.refund.id);
    if (existing) return existing.id;
    throw error;
  }

  return attemptId;
}

async function reconcileStripeExternalRefundWebhookEvent(
  db: Database,
  kv: KVNamespace | undefined,
  row: StripeExternalRefundWebhookRow,
  options: StripeExternalRefundWebhookReconciliationOptions,
): Promise<{
  imported: number;
  finalized: number;
  skipped: number;
  deferred: number;
  finalizedOrderIds: string[];
  refundNotifications: RefundNotificationFact[];
}> {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const evidence = getStripeExternalRefundEvidence(row);
  if (!evidence.chargeId) {
    await markStripeExternalRefundWebhook(db, row.id, "manual_reconciliation", row.result, {
      outcome: "deferred",
      reason: "stripe_charge_id_missing",
    }, nowSeconds);
    return { imported: 0, finalized: 0, skipped: 0, deferred: 1, finalizedOrderIds: [], refundNotifications: [] };
  }

  const settings = await getStripeSettings(db, options.encryptionKey);
  if (!settings?.secretKey) {
    await markStripeExternalRefundWebhook(db, row.id, "manual_reconciliation", row.result, {
      outcome: "deferred",
      reason: "stripe_settings_unavailable",
    }, nowSeconds);
    return { imported: 0, finalized: 0, skipped: 0, deferred: 1, finalizedOrderIds: [], refundNotifications: [] };
  }

  const sourcePayment = await findStripeSourcePayment(db, evidence);
  if (!sourcePayment) {
    await markStripeExternalRefundWebhook(db, row.id, "manual_reconciliation", row.result, {
      outcome: "deferred",
      reason: "local_source_payment_not_found",
      chargeId: evidence.chargeId,
      paymentIntentId: evidence.paymentIntentId ?? null,
    }, nowSeconds);
    return { imported: 0, finalized: 0, skipped: 0, deferred: 1, finalizedOrderIds: [], refundNotifications: [] };
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
    throw new Error(`Order ${sourcePayment.orderId} was not found for Stripe refund reconciliation.`);
  }
  const currency = resolveOrderCurrencySnapshot(order);
  assertOrderPaymentCurrency(sourcePayment.currency, currency, "Stripe source payment");

  const listed = await listStripeRefundsForCharge(settings.secretKey, evidence.chargeId, 100);
  if (!listed.success) {
    await markStripeExternalRefundWebhook(db, row.id, "manual_reconciliation", row.result, {
      outcome: "deferred",
      reason: "stripe_refund_list_failed",
      error: listed.error ?? "Stripe refund lookup failed",
    }, nowSeconds);
    return { imported: 0, finalized: 0, skipped: 0, deferred: 1, finalizedOrderIds: [], refundNotifications: [] };
  }

  const providerRefunds = (listed.refunds ?? []).filter((refund) => refund.charge === evidence.chargeId);
  const succeededRefunds = providerRefunds.filter((refund) => refund.status === "succeeded" && refund.amount > 0);
  if (succeededRefunds.length === 0) {
    await markStripeExternalRefundWebhook(db, row.id, "manual_reconciliation", row.result, {
      outcome: "deferred",
      reason: "no_succeeded_provider_refunds",
      providerRefundCount: providerRefunds.length,
    }, nowSeconds);
    return { imported: 0, finalized: 0, skipped: 0, deferred: 1, finalizedOrderIds: [], refundNotifications: [] };
  }

  let imported = 0;
  let finalized = 0;
  let skipped = 0;
  let deferred = 0;
  const importedRefundIds: string[] = [];
  const finalizedOrderIds = new Set<string>();
  const refundNotifications: RefundNotificationFact[] = [];

  for (const refund of succeededRefunds) {
    assertOrderPaymentCurrency(refund.currency, currency, "Stripe provider refund");
    const existing = await getExistingRefundAttemptByProviderRefundId(db, refund.id);
    if (existing) {
      skipped += 1;
      if (existing.status !== "refunded") {
        deferred += 1;
      }
      continue;
    }

    const amount = roundOrderMoney(
      refund.amount / Math.pow(10, currency.decimalPlaces),
      currency,
    );
    const alreadyRefunded = await getRefundedAmountForSourcePayment(db, sourcePayment.id, currency);
    const remaining = roundOrderMoney(Number(sourcePayment.amount ?? 0) - alreadyRefunded, currency);
    if (amount <= 0 || amount > remaining + 0.000001) {
      deferred += 1;
      continue;
    }

    const attemptId = await insertExternalStripeRefundAttempt(db, {
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
  await markStripeExternalRefundWebhook(db, row.id, allRepresented ? "processed" : "manual_reconciliation", row.result, {
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

export async function reconcileStripeExternalRefundWebhooks(
  db: Database,
  kv: KVNamespace | undefined,
  options: StripeExternalRefundWebhookReconciliationOptions = {},
): Promise<StripeExternalRefundWebhookReconciliationResult> {
  const limit = normalizeLimit(options.limit);
  const rows = await db
    .select({
      id: webhookEvents.id,
      orderId: webhookEvents.orderId,
      result: webhookEvents.result,
    })
    .from(webhookEvents)
    .where(and(
      eq(webhookEvents.provider, "stripe"),
      eq(webhookEvents.eventType, STRIPE_EXTERNAL_REFUND_WEBHOOK_EVENT),
      eq(webhookEvents.status, "manual_reconciliation"),
    ))
    .orderBy(asc(webhookEvents.processedAt))
    .limit(limit + 1) as StripeExternalRefundWebhookRow[];

  const targetRows = rows.slice(0, limit);
  const result: StripeExternalRefundWebhookReconciliationResult = {
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
      const eventResult = await reconcileStripeExternalRefundWebhookEvent(db, kv, row, options);
      result.imported += eventResult.imported;
      result.finalized += eventResult.finalized;
      result.skipped += eventResult.skipped;
      result.deferred += eventResult.deferred;
      eventResult.finalizedOrderIds.forEach((orderId) => finalizedOrderIds.add(orderId));
      result.refundNotifications.push(...eventResult.refundNotifications);
    } catch (error: unknown) {
      const message = serializeError(error);
      result.errors.push({ webhookEventId: row.id, message });
      await markStripeExternalRefundWebhook(db, row.id, "manual_reconciliation", row.result, {
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
  kv: KVNamespace | undefined,
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
    ? { outcome: "accepted", providerRefundId: attempt.providerRefundId, providerStatus: "accepted" } satisfies ProviderProbeOutcome
    : await probeProviderRefund(db, kv, attempt, context, options.encryptionKey);

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
  kv: KVNamespace | undefined,
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
    const result = await reconcileRefundAttemptById(db, kv, attemptId, {
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
  kv: KVNamespace | undefined,
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
      const reconciliation = await reconcileRefundAttemptById(db, kv, candidate.id, {
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
