import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  PaymentRecordStatus,
  refundAttempts,
  orderPayments,
  type RefundAttempt,
} from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { roundPrice } from "@scalius/shared/price-utils";
import {
  FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
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

const REFUND_RECONCILIATION_LEASE_SECONDS = 5 * 60;
const REFUND_RECONCILIATION_RETRY_SECONDS = 15 * 60;
const REFUND_RECONCILIATION_MANUAL_REVIEW_SECONDS = 6 * 60 * 60;
const MAX_REFUND_RECONCILIATION_ERROR_LENGTH = 500;

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
  | "orderId"
  | "refundPaymentId"
  | "gateway"
  | "amount"
  | "currency"
  | "status"
  | "sourceTransactionId"
  | "providerRefundId"
  | "providerIdempotencyKey"
  | "refundReference"
>;

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
  limit: number;
  hasMore: boolean;
}

export interface RefundReconciliationOptions {
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

function expectedSmallestUnitAmount(attempt: RefundAttemptProbeRow): number {
  return Math.round(roundPrice(attempt.amount) * Math.pow(10, getDecimalPlaces(attempt.currency)));
}

async function claimRefundAttempt(
  db: Database,
  attemptId: string,
  nowSeconds: number,
): Promise<boolean> {
  const claimId = `refund_reconcile:${attemptId}:${nowSeconds}`;
  const rows = await db.update(refundAttempts).set({
    claimId,
    claimExpiresAt: nowSeconds + REFUND_RECONCILIATION_LEASE_SECONDS,
    attempts: sql`${refundAttempts.attempts} + 1`,
    updatedAt: sql`unixepoch()`,
  }).where(and(
    eq(refundAttempts.id, attemptId),
    inArray(refundAttempts.status, [...RECOVERABLE_REFUND_ATTEMPT_STATUSES]),
    lte(refundAttempts.nextProbeAt, nowSeconds),
    or(isNull(refundAttempts.claimExpiresAt), lte(refundAttempts.claimExpiresAt, nowSeconds)),
  )).returning({ id: refundAttempts.id });

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
  kv: KVNamespace | undefined,
  attempt: RefundAttemptProbeRow,
  encryptionKey?: string,
): Promise<ProviderProbeOutcome> {
  const settings = await getStripeSettings(db, kv, encryptionKey, FRESH_GATEWAY_SETTINGS_READ_OPTIONS);
  if (!settings?.secretKey) {
    return { outcome: "unknown", error: "Stripe is not configured for refund reconciliation", manualReview: true };
  }

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
      candidate.amount === expectedSmallestUnitAmount(attempt)
    );
  }

  if (!refund) {
    return {
      outcome: "unknown",
      error: "No Stripe refund matched this attempt. Manual review required before retrying.",
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
  kv: KVNamespace | undefined,
  attempt: RefundAttemptProbeRow,
  encryptionKey?: string,
): Promise<ProviderProbeOutcome> {
  const settings = await getSSLCommerzSettings(db, kv, encryptionKey, FRESH_GATEWAY_SETTINGS_READ_OPTIONS);
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
  kv: KVNamespace | undefined,
  attempt: RefundAttemptProbeRow,
  encryptionKey?: string,
): Promise<ProviderProbeOutcome> {
  const settings = await getPolarSettings(db, kv, encryptionKey, FRESH_GATEWAY_SETTINGS_READ_OPTIONS);
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
  encryptionKey?: string,
): Promise<ProviderProbeOutcome> {
  switch (attempt.gateway) {
    case "stripe":
      return probeStripeRefund(db, kv, attempt, encryptionKey);
    case "sslcommerz":
      return probeSSLCommerzRefund(db, kv, attempt, encryptionKey);
    case "polar":
      return probePolarRefund(db, kv, attempt, encryptionKey);
    case "cod":
      return { outcome: "accepted", providerRefundId: attempt.providerRefundId, providerStatus: "accepted" };
    default:
      return { outcome: "unknown", error: `Unsupported refund gateway '${attempt.gateway}'`, manualReview: true };
  }
}

export async function reconcileRefundAttemptById(
  db: Database,
  kv: KVNamespace | undefined,
  attemptId: string,
  options: Omit<RefundReconciliationOptions, "limit"> = {},
): Promise<{ status: "finalized" | "failed" | "deferred"; orderIds: string[] }> {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const attempt = await db
    .select({
      id: refundAttempts.id,
      orderId: refundAttempts.orderId,
      refundPaymentId: refundAttempts.refundPaymentId,
      gateway: refundAttempts.gateway,
      amount: refundAttempts.amount,
      currency: refundAttempts.currency,
      status: refundAttempts.status,
      sourceTransactionId: refundAttempts.sourceTransactionId,
      providerRefundId: refundAttempts.providerRefundId,
      providerIdempotencyKey: refundAttempts.providerIdempotencyKey,
      refundReference: refundAttempts.refundReference,
    })
    .from(refundAttempts)
    .where(eq(refundAttempts.id, attemptId))
    .get() as RefundAttemptProbeRow | undefined;

  if (!attempt || !RECOVERABLE_REFUND_ATTEMPT_STATUSES.includes(attempt.status as RecoverableRefundAttemptStatus)) {
    return { status: "deferred", orderIds: [] };
  }

  if (attempt.status === "pending") {
    await markAttemptFailed(db, attempt, {
      outcome: "rejected",
      providerStatus: "not_dispatched",
      error: "Refund attempt expired before provider dispatch and was released for retry.",
    }, nowSeconds);
    return { status: "failed", orderIds: [] };
  }

  const outcome = attempt.status === "reconcile_required"
    ? { outcome: "accepted", providerRefundId: attempt.providerRefundId, providerStatus: "accepted" } satisfies ProviderProbeOutcome
    : await probeProviderRefund(db, kv, attempt, options.encryptionKey);

  if (outcome.outcome === "accepted") {
    await markAcceptedBeforeFinalize(db, attempt, outcome, nowSeconds);
    try {
      const result = await finalizeAcceptedRefundAttemptIds(db, [attempt.id]);
      return { status: "finalized", orderIds: result.orderIds };
    } catch (error: unknown) {
      await markAttemptReconcileRequired(db, attempt, error, nowSeconds);
      return { status: "deferred", orderIds: [] };
    }
  }

  if (outcome.outcome === "rejected") {
    await markAttemptFailed(db, attempt, outcome, nowSeconds);
    return { status: "failed", orderIds: [] };
  }

  await markAttemptDeferred(db, attempt, outcome, nowSeconds);
  return { status: "deferred", orderIds: [] };
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
