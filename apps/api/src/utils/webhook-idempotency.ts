import { and, asc, eq, isNotNull, lte, or, sql } from "drizzle-orm";
import { webhookEvents } from "@scalius/database/schema";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import { sha256Hex } from "@scalius/shared/hash";
import { duePaymentCommandProbes, onlinePaymentMethodCondition } from "@scalius/core/modules/payments";
import { SHIPMENT_CLAIM_PARKED_PAYMENT_EVENT, shipmentClaimLocksOrderSql } from "@scalius/core/modules/order-kernel";

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

/**
 * A provider event's claim key: the exact (provider, event type, event id)
 * tuple, hashed into a bounded key with no delimiter to confuse. Provider
 * event ids are opaque: `Pay-A` and `pay-a`, `a.b` and `a-b` are different
 * events. A provider id names one gateway or courier of this store (one
 * account each), so events dedupe only within it.
 */
export async function buildWebhookEventId(
  provider: string,
  eventType: string,
  sourceEventId: string,
): Promise<string> {
  return `whe2:${await sha256Hex(JSON.stringify([provider, eventType, sourceEventId]))}`;
}

/**
 * The key events were claimed under before exact keys: lower-cased with
 * punctuation collapsed, so distinct events could share it. Only read, so an
 * event claimed under it still finds its own row on a redelivery.
 */
export function legacyWebhookEventId(
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

function storedSourceEvent(row: { payload: string | null; result: string | null }): { eventType?: unknown; eventId?: unknown } | null {
  for (const text of [row.payload, row.result]) {
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as { event?: { eventType?: unknown; eventId?: unknown }; sourceEventId?: unknown };
      if (parsed.event && typeof parsed.event.eventId === "string") return parsed.event;
      if (typeof parsed.sourceEventId === "string") return { eventId: parsed.sourceEventId };
    } catch {
      // Not JSON: it names no event.
    }
  }
  return null;
}

const LEGACY_EVENT_GUARD = "webhook_event_legacy_key_held";

/**
 * Claim a provider event once, under its exact key (`buildWebhookEventId`),
 * in one round trip while no row holds its legacy key. When one does, that
 * row is this very event when its stored event id is exactly this one (a
 * row that stored none is taken as it, as before): the claim goes to that
 * row, so a redelivery of an event claimed before exact keys applies
 * nothing again. A distinct event that only shared the legacy key gets a row
 * of its own. The result names the row's id.
 */
export async function claimProviderEvent(
  db: Database,
  key: { provider: string; eventType: string; sourceEventId: string },
  claim: Omit<WebhookEventClaim, "id">,
  options: WebhookEventClaimOptions = {},
): Promise<WebhookEventClaimResult & { id: string }> {
  const id = await buildWebhookEventId(key.provider, key.eventType, key.sourceEventId);
  const legacyId = legacyWebhookEventId(key.provider, key.eventType, key.sourceEventId);
  try {
    await safeBatch(db, [
      buildBatchGuard(db, sql`NOT EXISTS (SELECT 1 FROM ${webhookEvents} WHERE ${webhookEvents.id} = ${legacyId})`, LEGACY_EVENT_GUARD),
      db.insert(webhookEvents).values(claimRow({ ...claim, id })),
    ]);
    return { id, claimed: true };
  } catch (error) {
    // The exact key is taken (a redelivery): the claim reads that row as usual.
    if (!isBatchGuardError(error, LEGACY_EVENT_GUARD)) return { id, ...await claimWebhookEvent(db, { ...claim, id }, options) };
  }
  const legacy = await db
    .select({ provider: webhookEvents.provider, payload: webhookEvents.payload, result: webhookEvents.result })
    .from(webhookEvents)
    .where(eq(webhookEvents.id, legacyId))
    .get();
  const stored = legacy ? storedSourceEvent(legacy) : null;
  const same = legacy?.provider === key.provider
    && (!stored || (stored.eventId === key.sourceEventId && (stored.eventType === undefined || stored.eventType === key.eventType)));
  const claimedId = same ? legacyId : id;
  return { id: claimedId, ...await claimWebhookEvent(db, { ...claim, id: claimedId }, options) };
}

function claimRow(claim: WebhookEventClaim) {
  return {
    id: claim.id,
    provider: claim.provider,
    eventType: claim.eventType,
    orderId: claim.orderId ?? null,
    status: claim.status ?? "processing",
    result: serializeResult(claim.result),
    payload: serializeResult(claim.payload),
    attempts: claim.payload === undefined ? 0 : 1,
    processedAt: sql`unixepoch()`,
  };
}

export async function claimWebhookEvent(
  db: Database,
  claim: WebhookEventClaim,
  options: WebhookEventClaimOptions = {},
): Promise<WebhookEventClaimResult> {
  const status = claim.status ?? "processing";
  const processingLeaseSeconds = options.processingLeaseSeconds ?? DEFAULT_WEBHOOK_PROCESSING_LEASE_SECONDS;

  try {
    await db.insert(webhookEvents).values(claimRow(claim));

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

/** A parked payment event looks again after this long, if nothing made it due sooner. */
export const PAYMENT_EVENT_PARKED_RECHECK_SECONDS = 60 * 60;

/**
 * Records an attempt refused only because a shipment claim locks the order
 * (a booking in flight, or a dead one waiting for the claim sweep or staff):
 * the event waits as `retrying` without spending the attempt, so it can never
 * run out of retries while money it carries is captured. While the kernel's
 * lock holds, a parked event is not due at all (`duePaymentEventBranches`):
 * it takes no drain slot from a real retry. Whatever ends the claim makes it
 * due at once (`requeueShipmentClaimParkedPaymentEvents`); it also looks
 * again hourly, and is due at once if the lock is already gone.
 */
export async function parkPaymentEventForShipmentClaim(
  db: Database,
  id: string,
  attempts: number,
  error: string,
): Promise<void> {
  const counted = Math.max(0, attempts - 1);
  await db
    .update(webhookEvents)
    .set({
      status: "retrying",
      attempts: counted,
      nextAttemptAt: sql`CASE WHEN ${parkedEventOrderLocked()} THEN unixepoch() + ${PAYMENT_EVENT_PARKED_RECHECK_SECONDS} ELSE unixepoch() END`,
      result: JSON.stringify({ reason: SHIPMENT_CLAIM_PARKED_PAYMENT_EVENT, attempts: counted, error }),
      processedAt: sql`unixepoch()`,
    })
    .where(eq(webhookEvents.id, id));
}

/** The event's order is locked by a shipment claim, by the kernel's own guard. */
function parkedEventOrderLocked() {
  // Qualified by hand: an update renders its own columns unqualified.
  return shipmentClaimLocksOrderSql(sql.raw(`"webhook_events"."order_id"`));
}

/** A parked event whose order a shipment claim still locks: never due until the lock ends. */
function stillParked() {
  return sql`(COALESCE(json_extract(${sql.raw(`"webhook_events"."result"`)}, '$.reason'), '') = ${SHIPMENT_CLAIM_PARKED_PAYMENT_EVENT}
    AND ${parkedEventOrderLocked()})`;
}

/** Payment events due again, or whose attempt died with its invocation (lease expired). */
/** The due states, each one index range: a retry past its time (not one still parked), or an attempt whose invocation died. */
function duePaymentEventBranches(leaseSeconds = DEFAULT_WEBHOOK_PROCESSING_LEASE_SECONDS) {
  return [
    and(eq(webhookEvents.status, "retrying"), lte(webhookEvents.nextAttemptAt, sql`unixepoch()`), sql`NOT ${stillParked()}`)!,
    and(eq(webhookEvents.status, "processing"), lte(webhookEvents.processedAt, sql`unixepoch() - ${leaseSeconds}`))!,
  ];
}

function duePaymentEventCondition(leaseSeconds = DEFAULT_WEBHOOK_PROCESSING_LEASE_SECONDS) {
  return and(isNotNull(webhookEvents.payload), or(...duePaymentEventBranches(leaseSeconds)));
}

/**
 * Whether `listDuePaymentEvents` (or the drain's open-command sweep,
 * `listDuePaymentCommands`) would find a row: one bounded index probe per
 * due state (the scheduled drain runs only when one finds a row).
 */
export function duePaymentEventProbes(db: Database) {
  return [
    ...duePaymentEventBranches().map((branch) =>
      db.select({ id: webhookEvents.id }).from(webhookEvents)
        .where(and(isNotNull(webhookEvents.payload), branch)).limit(1)),
    ...duePaymentCommandProbes(db),
  ];
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

