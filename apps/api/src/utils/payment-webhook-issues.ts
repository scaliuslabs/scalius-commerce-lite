import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { webhookEvents } from "@scalius/database/schema";
import { PAYMENT_WEBHOOK_PROVIDERS, type WebhookEventStatus } from "./webhook-idempotency";

const PAYMENT_WEBHOOK_ISSUE_STATUSES = ["failed", "manual_reconciliation"] as const satisfies readonly WebhookEventStatus[];
const MAX_PAYMENT_WEBHOOK_ISSUES_PER_ORDER = 10;

export interface PaymentWebhookIssue {
  id: string;
  provider: string;
  eventType: string;
  status: (typeof PAYMENT_WEBHOOK_ISSUE_STATUSES)[number];
  message: string;
  error: string | null;
  queueType: string | null;
  queueMessageId: string | null;
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
  queueType?: string;
  queueMessageId?: string;
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
      inArray(webhookEvents.provider, PAYMENT_WEBHOOK_PROVIDERS),
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
    message: buildPaymentWebhookIssueMessage(row.status, parsed),
    error: parsed.error ?? null,
    queueType: parsed.queueType ?? null,
    queueMessageId: parsed.queueMessageId ?? null,
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
      queueType: readString(value.queueType),
      queueMessageId: readString(value.queueMessageId),
      outcome: readString(value.outcome),
    };
  } catch {
    return { error: result };
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function buildPaymentWebhookIssueMessage(status: string, result: ParsedWebhookResult): string {
  if (status === "manual_reconciliation") {
    return result.error
      ? `Payment webhook needs manual reconciliation: ${result.error}`
      : "Payment webhook needs manual reconciliation before this order can be trusted as settled.";
  }

  if (result.reason === "stale_queued_payment_webhook") {
    return "Payment webhook was queued but did not finish within six hours. Gateway retry can reclaim it, or the payment should be reconciled manually.";
  }

  if (result.reason === "payment_events_dlq") {
    return "Payment webhook reached the dead-letter queue after exhausting delivery retries. Review the gateway dashboard and reconcile the payment before changing payment-sensitive order state.";
  }

  if (result.error) {
    return `Payment webhook processing failed: ${result.error}`;
  }

  return "Payment webhook processing failed. Review the provider dashboard and order payment history before taking payment-sensitive actions.";
}
