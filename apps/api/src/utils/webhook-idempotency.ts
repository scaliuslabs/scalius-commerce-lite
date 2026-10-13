import { and, asc, eq, isNotNull, lte, or, sql } from "drizzle-orm";
import { webhookEvents } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { onlinePaymentMethodCondition } from "@scalius/core/modules/payments";

/**
 * `retrying`: a payment event whose last attempt failed, due again at
 * `next_attempt_at`. `failed` is terminal (retries exhausted, or a courier
 * event that failed); a provider re-sending the same event reclaims it.
 */
export type WebhookEventStatus = "processing" | "retrying" | "processed" | "failed" | "manual_reconciliation";
export const DEFAULT_WEBHOOK_PROCESSING_LEASE_SECONDS = 5 * 60;
/** Attempts a payment event gets (the first plus five retries) before it is `failed`. */
export const PAYMENT_EVENT_MAX_ATTEMPTS = 6;

/** Backoff after attempt n fails: 1, 2, 4, 8, 16 minutes. */
export function paymentEventRetryDelaySeconds(attempts: number): number {
  return 60 * 2 ** (Math.max(1, Math.min(attempts, PAYMENT_EVENT_MAX_ATTEMPTS)) - 1);
}
/**
 * Webhook events of payment gateways (built-in and app providers): an app
 * courier's tracking events share the provider id shape, never the
 * `courier.` event type.
 */
export function paymentWebhookEventCondition() {
  return and(
    onlinePaymentMethodCondition(webhookEvents.provider),
    sql`${webhookEvents.eventType} NOT LIKE 'courier.%'`,
  )!;
}

export interface WebhookEventClaim {
  id: string;
  provider: string;
  eventType: string;
  orderId?: string | null;
  status?: WebhookEventStatus;
  result?: unknown;
  /** Payment events: what a retry applies (the normalized provider event; ids, refs and amounts only). */
  payload?: unknown;
}

export interface WebhookEventClaimResult {
  claimed: boolean;
  retryingFailedEvent?: boolean;
  reclaimingStaleProcessingEvent?: boolean;
  existing?: {
    id: string;
    provider: string;
    eventType: string;
    orderId: string | null;
    status: string;
    result: string | null;
    processedAt: Date | number | string | null;
  } | null;
}

export interface WebhookEventClaimOptions {
  processingLeaseSeconds?: number;
}

function serializeResult(result: unknown): string | null {
  if (result === undefined || result === null) return null;
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

export function buildWebhookEventId(
  provider: string,
  eventType: string,
  sourceEventId: string,
): string {
  return `${provider}:${eventType}:${sourceEventId}`
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function claimWebhookEvent(
  db: Database,
  claim: WebhookEventClaim,
  options: WebhookEventClaimOptions = {},
): Promise<WebhookEventClaimResult> {
  const status = claim.status ?? "processing";
  const processingLeaseSeconds = options.processingLeaseSeconds ?? DEFAULT_WEBHOOK_PROCESSING_LEASE_SECONDS;

  try {
    await db.insert(webhookEvents).values({
      id: claim.id,
      provider: claim.provider,
      eventType: claim.eventType,
      orderId: claim.orderId ?? null,
      status,
      result: serializeResult(claim.result),
      payload: serializeResult(claim.payload),
      attempts: claim.payload === undefined ? 0 : 1,
      processedAt: sql`unixepoch()`,
    });

    return { claimed: true };
  } catch (insertError) {
    const existing = await db
      .select({
        id: webhookEvents.id,
        provider: webhookEvents.provider,
        eventType: webhookEvents.eventType,
        orderId: webhookEvents.orderId,
        status: webhookEvents.status,
        result: webhookEvents.result,
        processedAt: webhookEvents.processedAt,
      })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, claim.id))
      .get();

    if (!existing) throw insertError;

    if (existing?.status === "failed") {
      const reclaimed = await db
        .update(webhookEvents)
        .set({
          status,
          orderId: claim.orderId ?? existing.orderId,
          result: serializeResult(claim.result),
          payload: serializeResult(claim.payload),
          attempts: claim.payload === undefined ? 0 : 1,
          nextAttemptAt: null,
          processedAt: sql`unixepoch()`,
        })
        .where(and(
          eq(webhookEvents.id, claim.id),
          eq(webhookEvents.status, "failed"),
        ))
        .returning({ id: webhookEvents.id });

      if (reclaimed.length > 0) {
        return { claimed: true, retryingFailedEvent: true, existing };
      }

      return { claimed: false, existing };
    }

    if (existing?.status === "processing") {
      const reclaimed = await db
        .update(webhookEvents)
        .set({
          status,
          orderId: claim.orderId ?? existing.orderId,
          result: serializeResult(claim.result),
          payload: serializeResult(claim.payload),
          attempts: claim.payload === undefined ? 0 : 1,
          nextAttemptAt: null,
          processedAt: sql`unixepoch()`,
        })
        .where(and(
          eq(webhookEvents.id, claim.id),
          eq(webhookEvents.status, "processing"),
          lte(webhookEvents.processedAt, sql`unixepoch() - ${processingLeaseSeconds}`),
        ))
        .returning({ id: webhookEvents.id });

      if (reclaimed.length > 0) {
        return { claimed: true, reclaimingStaleProcessingEvent: true, existing };
      }
    }

    return { claimed: false, existing: existing ?? null };
  }
}

export async function markWebhookEventProcessed(
  db: Database,
  id: string,
  result?: unknown,
): Promise<void> {
  await markWebhookEvent(db, id, "processed", result);
}

export async function markWebhookEventFailed(
  db: Database,
  id: string,
  result?: unknown,
): Promise<void> {
  await markWebhookEvent(db, id, "failed", result);
}

export async function markWebhookEventManualReconciliation(
  db: Database,
  id: string,
  result?: unknown,
): Promise<void> {
  await markWebhookEvent(db, id, "manual_reconciliation", result);
}

/**
 * Records a failed payment-event attempt: due again after the backoff, or
 * `failed` once its attempts are spent (the dead-letter state the order page
 * shows as "failed after every retry").
 */
export async function markPaymentEventAttemptFailed(
  db: Database,
  id: string,
  attempts: number,
  error: string,
): Promise<"retrying" | "failed"> {
  const exhausted = attempts >= PAYMENT_EVENT_MAX_ATTEMPTS;
  await db
    .update(webhookEvents)
    .set(exhausted
      ? { status: "failed", nextAttemptAt: null, result: JSON.stringify({ reason: "retries_exhausted", attempts, error }), processedAt: sql`unixepoch()` }
      : { status: "retrying", nextAttemptAt: sql`unixepoch() + ${paymentEventRetryDelaySeconds(attempts)}`, result: JSON.stringify({ attempts, error }), processedAt: sql`unixepoch()` })
    .where(eq(webhookEvents.id, id));
  return exhausted ? "failed" : "retrying";
}

/** Payment events due again, or whose attempt died with its invocation (lease expired). */
function duePaymentEventCondition(leaseSeconds = DEFAULT_WEBHOOK_PROCESSING_LEASE_SECONDS) {
  return and(
    isNotNull(webhookEvents.payload),
    or(
      and(eq(webhookEvents.status, "retrying"), lte(webhookEvents.nextAttemptAt, sql`unixepoch()`)),
      and(eq(webhookEvents.status, "processing"), lte(webhookEvents.processedAt, sql`unixepoch() - ${leaseSeconds}`)),
    ),
  );
}

export async function listDuePaymentEvents(db: Database, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(duePaymentEventCondition())
    .orderBy(asc(webhookEvents.processedAt))
    .limit(Math.max(1, Math.min(limit, 100)))
    .all();
  return rows.map((row) => row.id);
}

/** Claims one due payment event for an attempt (counted at claim); null when another drain has it. */
export async function claimDuePaymentEvent(
  db: Database,
  id: string,
): Promise<{ id: string; provider: string; payload: string; attempts: number } | null> {
  const rows = await db
    .update(webhookEvents)
    .set({ status: "processing", attempts: sql`${webhookEvents.attempts} + 1`, processedAt: sql`unixepoch()` })
    .where(and(eq(webhookEvents.id, id), duePaymentEventCondition()))
    .returning({ id: webhookEvents.id, provider: webhookEvents.provider, payload: webhookEvents.payload, attempts: webhookEvents.attempts });
  const row = rows[0];
  return row?.payload ? { id: row.id, provider: row.provider, payload: row.payload, attempts: Number(row.attempts) } : null;
}

async function markWebhookEvent(
  db: Database,
  id: string,
  status: WebhookEventStatus,
  result?: unknown,
): Promise<void> {
  await db
    .update(webhookEvents)
    .set({
      status,
      result: serializeResult(result),
      processedAt: sql`unixepoch()`,
    })
    .where(eq(webhookEvents.id, id));
}

