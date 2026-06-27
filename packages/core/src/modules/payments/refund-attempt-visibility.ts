import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { refundAttempts } from "@scalius/database/schema";
import { ACTIVE_REFUND_ATTEMPT_STATUSES } from "./refund-attempt-guard";

type RefundAttemptVisibilityAudience = "admin" | "customer";
type RefundAttemptSeverity = "info" | "success" | "warning" | "danger";

const ACTIVE_REFUND_STATUS_SET = new Set<string>(ACTIVE_REFUND_ATTEMPT_STATUSES);

export interface RefundAttemptVisibilityRow {
  id: string;
  orderId: string;
  sourcePaymentId: string;
  refundPaymentId: string;
  gateway: string;
  amount: number;
  currency: string;
  reason: string;
  refundReference: string;
  allocationIndex: number;
  allocationCount: number;
  sourceTransactionId: string | null;
  providerRefundId: string | null;
  providerCorrelationId: string | null;
  providerStatus: string | null;
  status: string;
  attempts: number;
  nextProbeAt: number | null;
  lastProbeAt: number | null;
  lastError: string | null;
  refundedAt: number | null;
  failedAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface OrderRefundAttemptView {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  gateway: string;
  status: string;
  providerStatus: string | null;
  active: boolean;
  severity: RefundAttemptSeverity;
  label: string;
  message: string;
  createdAt: string | null;
  updatedAt: string | null;
  nextProbeAt: string | null;
  lastProbeAt: string | null;
  refundedAt: string | null;
  failedAt: string | null;
  reason?: string;
  refundPaymentId?: string;
  sourcePaymentId?: string;
  sourceTransactionId?: string | null;
  refundReference?: string;
  providerRefundId?: string | null;
  providerCorrelationId?: string | null;
  allocationIndex?: number;
  allocationCount?: number;
  attempts?: number;
  lastError?: string | null;
}

export interface ActiveRefundOperationView {
  active: true;
  status: string;
  severity: RefundAttemptSeverity;
  label: string;
  message: string;
  amount: number;
  currency: string;
  gateway: string;
  attemptCount: number;
  nextProbeAt: string | null;
  lastProbeAt: string | null;
  providerStatus: string | null;
  reason?: string | null;
  sourceTransactionId?: string | null;
  providerRefundId?: string | null;
  providerCorrelationId?: string | null;
  refundReference?: string | null;
  lastError?: string | null;
}

function timestampToIso(timestamp: number | null | undefined): string | null {
  if (!timestamp) return null;
  return new Date(timestamp * 1000).toISOString();
}

function normalizeGateway(gateway: string): string {
  if (gateway === "sslcommerz") return "SSLCommerz";
  if (gateway === "cod") return "Cash on Delivery";
  return gateway.charAt(0).toUpperCase() + gateway.slice(1);
}

function copyForStatus(
  status: string,
  gateway: string,
  audience: RefundAttemptVisibilityAudience,
): { severity: RefundAttemptSeverity; label: string; message: string } {
  const gatewayLabel = normalizeGateway(gateway);

  switch (status) {
    case "pending":
      return {
        severity: "info",
        label: audience === "admin" ? "Refund queued" : "Refund request recorded",
        message: audience === "admin"
          ? "The refund was claimed locally and is waiting to be sent. New refunds are blocked until this settles."
          : "The merchant has started a refund. It will update here once processing begins.",
      };
    case "processing":
      return {
        severity: "info",
        label: "Refund processing",
        message: audience === "admin"
          ? `${gatewayLabel} has been contacted. Keep order, shipment, COD, and refund actions paused until the provider outcome is known.`
          : `The refund is being processed through ${gatewayLabel}.`,
      };
    case "provider_unknown":
      return {
        severity: "warning",
        label: audience === "admin" ? "Refund outcome being verified" : "Refund being verified",
        message: audience === "admin"
          ? `${gatewayLabel} did not return a final refund result. Do not retry this refund until reconciliation confirms the provider outcome.`
          : "The payment provider has not returned a final result yet. The merchant is verifying the refund.",
      };
    case "reconcile_required":
      return {
        severity: "warning",
        label: audience === "admin" ? "Refund accepted, local update pending" : "Refund accepted",
        message: audience === "admin"
          ? "The provider accepted the refund, but the local order still needs reconciliation. Scheduled recovery will retry automatically."
          : "The refund was accepted by the payment provider. The order status is being updated.",
      };
    case "refunded":
      return {
        severity: "success",
        label: "Refund completed",
        message: audience === "admin"
          ? "The refund is reconciled locally and no longer blocks order actions."
          : "The refund is complete.",
      };
    case "failed":
      return {
        severity: "danger",
        label: "Refund failed",
        message: audience === "admin"
          ? "The provider rejected the refund or the attempt failed before dispatch. Review the error before retrying."
          : "The refund could not be completed. Please contact support if you need help.",
      };
    default:
      return {
        severity: "info",
        label: "Refund update",
        message: audience === "admin"
          ? "Refund status is available for review."
          : "Refund status has changed.",
      };
  }
}

function customerSafeStatus(status: string): string {
  switch (status) {
    case "pending":
      return "queued";
    case "provider_unknown":
      return "checking";
    case "reconcile_required":
    case "processing":
      return "processing";
    case "refunded":
      return "settled";
    case "failed":
      return "failed";
    default:
      return "processing";
  }
}

export function formatRefundAttemptForVisibility(
  row: RefundAttemptVisibilityRow,
  audience: RefundAttemptVisibilityAudience,
): OrderRefundAttemptView {
  const copy = copyForStatus(row.status, row.gateway, audience);
  const base: OrderRefundAttemptView = {
    id: row.id,
    orderId: row.orderId,
    amount: row.amount,
    currency: row.currency,
    gateway: row.gateway,
    status: audience === "customer" ? customerSafeStatus(row.status) : row.status,
    providerStatus: audience === "customer" ? null : row.providerStatus,
    active: ACTIVE_REFUND_STATUS_SET.has(row.status),
    severity: copy.severity,
    label: copy.label,
    message: copy.message,
    createdAt: timestampToIso(row.createdAt),
    updatedAt: timestampToIso(row.updatedAt),
    nextProbeAt: timestampToIso(row.nextProbeAt),
    lastProbeAt: timestampToIso(row.lastProbeAt),
    refundedAt: timestampToIso(row.refundedAt),
    failedAt: timestampToIso(row.failedAt),
  };

  if (audience === "customer") {
    return base;
  }

  return {
    ...base,
    reason: row.reason,
    refundPaymentId: row.refundPaymentId,
    sourcePaymentId: row.sourcePaymentId,
    sourceTransactionId: row.sourceTransactionId,
    refundReference: row.refundReference,
    providerRefundId: row.providerRefundId,
    providerCorrelationId: row.providerCorrelationId,
    allocationIndex: row.allocationIndex,
    allocationCount: row.allocationCount,
    attempts: row.attempts,
    lastError: row.lastError,
  };
}

export function summarizeActiveRefundOperation(
  attempts: OrderRefundAttemptView[],
  audience: RefundAttemptVisibilityAudience,
): ActiveRefundOperationView | null {
  const activeAttempts = attempts.filter((attempt) => attempt.active);
  if (activeAttempts.length === 0) return null;

  const priority = ["reconcile_required", "provider_unknown", "checking", "processing", "queued", "pending"];
  const rank = (status: string) => {
    const index = priority.indexOf(status);
    return index >= 0 ? index : priority.length;
  };
  const primary = [...activeAttempts].sort((a, b) => rank(a.status) - rank(b.status))[0] ?? activeAttempts[0]!;
  const amount = activeAttempts.reduce((sum, attempt) => sum + attempt.amount, 0);

  return {
    active: true,
    status: primary.status,
    severity: primary.severity,
    label: primary.label,
    message: primary.message,
    amount,
    currency: primary.currency,
    gateway: primary.gateway,
    attemptCount: activeAttempts.length,
    nextProbeAt: primary.nextProbeAt,
    lastProbeAt: primary.lastProbeAt,
    providerStatus: primary.providerStatus,
    ...(audience === "admin" ? {
      reason: primary.reason ?? null,
      sourceTransactionId: primary.sourceTransactionId ?? null,
      providerRefundId: primary.providerRefundId ?? null,
      providerCorrelationId: primary.providerCorrelationId ?? null,
      refundReference: primary.refundReference ?? null,
      lastError: primary.lastError ?? null,
    } : {}),
  };
}

export async function listOrderRefundAttempts(
  db: Database,
  orderId: string,
  options: { audience?: RefundAttemptVisibilityAudience } = {},
): Promise<OrderRefundAttemptView[]> {
  const audience = options.audience ?? "admin";
  const rows = await db
    .select({
      id: refundAttempts.id,
      orderId: refundAttempts.orderId,
      sourcePaymentId: refundAttempts.sourcePaymentId,
      refundPaymentId: refundAttempts.refundPaymentId,
      gateway: refundAttempts.gateway,
      amount: refundAttempts.amount,
      currency: refundAttempts.currency,
      reason: refundAttempts.reason,
      refundReference: refundAttempts.refundReference,
      allocationIndex: refundAttempts.allocationIndex,
      allocationCount: refundAttempts.allocationCount,
      sourceTransactionId: refundAttempts.sourceTransactionId,
      providerRefundId: refundAttempts.providerRefundId,
      providerCorrelationId: refundAttempts.providerCorrelationId,
      providerStatus: refundAttempts.providerStatus,
      status: refundAttempts.status,
      attempts: refundAttempts.attempts,
      nextProbeAt: sql<number | null>`CAST(${refundAttempts.nextProbeAt} AS INTEGER)`,
      lastProbeAt: sql<number | null>`CAST(${refundAttempts.lastProbeAt} AS INTEGER)`,
      lastError: refundAttempts.lastError,
      refundedAt: sql<number | null>`CAST(${refundAttempts.refundedAt} AS INTEGER)`,
      failedAt: sql<number | null>`CAST(${refundAttempts.failedAt} AS INTEGER)`,
      createdAt: sql<number | null>`CAST(${refundAttempts.createdAt} AS INTEGER)`,
      updatedAt: sql<number | null>`CAST(${refundAttempts.updatedAt} AS INTEGER)`,
    })
    .from(refundAttempts)
    .where(eq(refundAttempts.orderId, orderId))
    .orderBy(desc(refundAttempts.createdAt));

  return rows.map((row) => formatRefundAttemptForVisibility(row, audience));
}
