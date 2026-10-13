import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { webhookEvents } from "@scalius/database/schema";
import { paymentWebhookEventCondition, type WebhookEventStatus } from "./webhook-idempotency";

const PAYMENT_WEBHOOK_ISSUE_STATUSES = ["failed", "manual_reconciliation"] as const satisfies readonly WebhookEventStatus[];
const MAX_PAYMENT_WEBHOOK_ISSUES_PER_ORDER = 10;
/** Why a payment update needs attention, as a stable code the dashboard words in its own language. */
export const PAYMENT_WEBHOOK_ISSUE_REASONS = ["manual_reconciliation", "dead_letter", "failed"] as const;
export type PaymentWebhookIssueReason = (typeof PAYMENT_WEBHOOK_ISSUE_REASONS)[number];

export interface PaymentWebhookIssue {
  id: string;
  provider: string;
  eventType: string;
  status: (typeof PAYMENT_WEBHOOK_ISSUE_STATUSES)[number];
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
      inArray(webhookEvents.status, PAYMENT_WEBHOOK_ISSUE_STATUSES),
    ))
    .orderBy(desc(webhookEvents.processedAt))
    .limit(MAX_PAYMENT_WEBHOOK_ISSUES_PER_ORDER);

  return rows.map(formatPaymentWebhookIssue);
}

export function formatPaymentWebhookIssue(row: PaymentWebhookIssueRow): PaymentWebhookIssue {
  const parsed = parseWebhookResult(row.result);
  return {
    id: row.id,
    provider: row.provider,
    eventType: row.eventType,
    status: row.status === "manual_reconciliation" ? "manual_reconciliation" : "failed",
    reason: paymentWebhookIssueReason(row.status, parsed),
    message: buildPaymentWebhookIssueMessage(row.status, parsed),
    error: parsed.error ?? null,
    processedAt: row.processedAt,
  };
}

function parseWebhookResult(result: string | null): ParsedWebhookResult {
  if (!result) return {};

  try {
    const value = JSON.parse(result) as Record<string, unknown>;
    return {
      reason: readString(value.reason),
      error: readString(value.error),
      outcome: readString(value.outcome),
    };
  } catch {
    return { error: result };
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function paymentWebhookIssueReason(status: string, result: ParsedWebhookResult): PaymentWebhookIssueReason {
  if (status === "manual_reconciliation") return "manual_reconciliation";
  if (result.reason === "retries_exhausted") return "dead_letter";
  return "failed";
}

function buildPaymentWebhookIssueMessage(status: string, result: ParsedWebhookResult): string {
  if (status === "manual_reconciliation") {
    return result.error
      ? `Payment webhook needs manual reconciliation: ${result.error}`
      : "Payment webhook needs manual reconciliation before this order can be trusted as settled.";
  }

  if (result.reason === "retries_exhausted") {
    return "Payment webhook failed after every retry. Review the gateway dashboard and reconcile the payment before changing payment-sensitive order state.";
  }

  if (result.error) {
    return `Payment webhook processing failed: ${result.error}`;
  }

  return "Payment webhook processing failed. Review the provider dashboard and order payment history before taking payment-sensitive actions.";
}
