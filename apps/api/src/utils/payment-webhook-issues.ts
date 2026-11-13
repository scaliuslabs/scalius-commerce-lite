import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { webhookEvents } from "@scalius/database/schema";
import { LOCAL_REFUND_IN_PROGRESS_REASON, REFUND_OBSERVED_EVENT_TYPE } from "@scalius/core/modules/payments";
import { SHIPMENT_CLAIM_PARKED_PAYMENT_EVENT } from "@scalius/core/modules/order-kernel";
import { paymentWebhookEventCondition, REFUND_IN_FLIGHT_PARKED_PAYMENT_EVENT, type WebhookEventStatus } from "./webhook-idempotency";

const PAYMENT_WEBHOOK_ISSUE_STATUSES = ["failed", "manual_reconciliation"] as const satisfies readonly WebhookEventStatus[];
const MAX_PAYMENT_WEBHOOK_ISSUES_PER_ORDER = 10;
/** Why a payment update needs attention, as a stable code the dashboard words in its own language. */
/**
 * `external_refund`: the provider reports a refund not on the order yet (made
 * in its dashboard); the scheduled reconciliation records it, and it stays
 * listed while it cannot. `shipment_claim`: a provider payment waits, uncounted,
 * for the order's courier booking to be resolved, and is recorded then.
 * `refund_in_flight`: a dispute waits, uncounted, for a refund on the order to
 * settle (at most three days, then manual reconciliation).
 */
export const PAYMENT_WEBHOOK_ISSUE_REASONS = ["manual_reconciliation", "dead_letter", "failed", "external_refund", "shipment_claim", "refund_in_flight"] as const;
export type PaymentWebhookIssueReason = (typeof PAYMENT_WEBHOOK_ISSUE_REASONS)[number];

/** `waiting`: parked for a shipment claim or a refund in flight, not failed (reason `shipment_claim`, `refund_in_flight`). */
export const PAYMENT_WEBHOOK_ISSUE_STATES = ["failed", "manual_reconciliation", "waiting"] as const;

export interface PaymentWebhookIssue {
  id: string;
  provider: string;
  eventType: string;
  status: (typeof PAYMENT_WEBHOOK_ISSUE_STATES)[number];
  reason: PaymentWebhookIssueReason;
  message: string;
  error: string | null;
  processedAt: Date | string | number;
}

type PaymentWebhookIssueRow = {
  id: string;
  provider: string;
  eventType: string;
  status: string;
  result: string | null;
  processedAt: Date | string | number;
};

type ParsedWebhookResult = {
  reason?: string;
  error?: string;
  outcome?: string;
  /** The scheduled reconciliation's latest word on a reported refund. */
  reconciliationReason?: string;
};

export async function listPaymentWebhookIssuesForOrder(
  db: Database,
  orderId: string,
): Promise<PaymentWebhookIssue[]> {
  const rows = await db
    .select({
      id: webhookEvents.id,
      provider: webhookEvents.provider,
      eventType: webhookEvents.eventType,
      status: webhookEvents.status,
      result: webhookEvents.result,
      processedAt: webhookEvents.processedAt,
    })
    .from(webhookEvents)
    .where(and(
      eq(webhookEvents.orderId, orderId),
      paymentWebhookEventCondition(),
      or(
        inArray(webhookEvents.status, PAYMENT_WEBHOOK_ISSUE_STATUSES),
        // A payment waiting for the order's courier booking (parked, uncounted).
        and(
          eq(webhookEvents.status, "retrying"),
          sql`json_extract(${webhookEvents.result}, '$.reason') IN (${SHIPMENT_CLAIM_PARKED_PAYMENT_EVENT}, ${REFUND_IN_FLIGHT_PARKED_PAYMENT_EVENT})`,
        ),
      ),
    ))
    .orderBy(desc(webhookEvents.processedAt))
    .limit(MAX_PAYMENT_WEBHOOK_ISSUES_PER_ORDER);

  return rows.filter((row) => !isOwnRefundSettling(row)).map(formatPaymentWebhookIssue);
}

/**
 * A reported refund that is the order's own, still settling (its provider
 * refund id not recorded yet): routine, not an issue. The next check matches it.
 */
function isOwnRefundSettling(row: PaymentWebhookIssueRow): boolean {
  if (row.eventType !== REFUND_OBSERVED_EVENT_TYPE || row.status !== "manual_reconciliation") return false;
  const parsed = parseWebhookResult(row.result);
  return (parsed.reconciliationReason ?? parsed.reason) === LOCAL_REFUND_IN_PROGRESS_REASON;
}

export function formatPaymentWebhookIssue(row: PaymentWebhookIssueRow): PaymentWebhookIssue {
  const parsed = parseWebhookResult(row.result);
  return {
    id: row.id,
    provider: row.provider,
    eventType: row.eventType,
    status: row.status === "manual_reconciliation"
      ? "manual_reconciliation"
      : row.status === "retrying" ? "waiting" : "failed",
    reason: paymentWebhookIssueReason(row, parsed),
    message: buildPaymentWebhookIssueMessage(row, parsed),
    error: parsed.error ?? null,
    processedAt: row.processedAt,
  };
}

function parseWebhookResult(result: string | null): ParsedWebhookResult {
  if (!result) return {};

  try {
    const value = JSON.parse(result) as Record<string, unknown>;
    const reconciliation = value.externalRefundReconciliation;
    return {
      reason: readString(value.reason),
      error: readString(value.error),
      outcome: readString(value.outcome),
      reconciliationReason: reconciliation && typeof reconciliation === "object"
        ? readString((reconciliation as Record<string, unknown>).reason)
        : undefined,
    };
  } catch {
    return { error: result };
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function paymentWebhookIssueReason(row: PaymentWebhookIssueRow, result: ParsedWebhookResult): PaymentWebhookIssueReason {
  const status = row.status;
  if (status === "manual_reconciliation" && row.eventType === REFUND_OBSERVED_EVENT_TYPE) return "external_refund";
  if (status === "manual_reconciliation") return "manual_reconciliation";
  if (status === "retrying" && result.reason === SHIPMENT_CLAIM_PARKED_PAYMENT_EVENT) return "shipment_claim";
  if (status === "retrying" && result.reason === REFUND_IN_FLIGHT_PARKED_PAYMENT_EVENT) return "refund_in_flight";
  if (result.reason === "retries_exhausted") return "dead_letter";
  return "failed";
}

function buildPaymentWebhookIssueMessage(row: PaymentWebhookIssueRow, result: ParsedWebhookResult): string {
  const status = row.status;
  if (status === "manual_reconciliation" && row.eventType === REFUND_OBSERVED_EVENT_TYPE) {
    return "The provider reports a refund this order does not record yet. Scheduled reconciliation records refunds made in the provider dashboard; check the provider if it stays.";
  }
  if (status === "manual_reconciliation") {
    return result.error
      ? `Payment webhook needs manual reconciliation: ${result.error}`
      : "Payment webhook needs manual reconciliation before this order can be trusted as settled.";
  }

  if (status === "retrying" && result.reason === SHIPMENT_CLAIM_PARKED_PAYMENT_EVENT) {
    return "A provider payment waits for this order's courier booking to be resolved; it is recorded automatically once the booking is finished or released.";
  }

  if (status === "retrying" && result.reason === REFUND_IN_FLIGHT_PARKED_PAYMENT_EVENT) {
    return "A provider dispute waits for a refund on this order to settle; it is recorded automatically once the refund does.";
  }

  if (result.reason === "retries_exhausted") {
    return "Payment webhook failed after every retry. Review the gateway dashboard and reconcile the payment before changing payment-sensitive order state.";
  }

  if (result.error) {
    return `Payment webhook processing failed: ${result.error}`;
  }

  return "Payment webhook processing failed. Review the provider dashboard and order payment history before taking payment-sensitive actions.";
}
