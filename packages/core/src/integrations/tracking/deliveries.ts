// GA4 and TikTok server deliveries (audit spec §3.10), one durable row per
// destination and dedup key:
//
//   checkout commit ─▶ purchase rows (pending) ──claim──▶ processing ──▶ sent
//   refund confirmed ─▶ GA4 refund row (trigger,           │         ├──▶ failed (backoff, retried)
//                       only after its purchase was sent)  │         └──▶ skipped (consent, ineligible, config)
//
// The row is the idempotency key: a purchase is sent at most once per
// `transaction_id`, a refund once per refund payment. The cron's tracking
// sweep retries due rows; the commit and the payment confirmation send at
// once. A delivery stores which match signals it carried, never their values.

import type { Database } from "@scalius/database/client";
import { orderItems, orderPayments, orders, orderTrackingSignals, trackingDeliveries } from "@scalius/database/schema";
import { and, asc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { ConsentState } from "@scalius/shared/tracking-consent";
import { selectSettingsDocuments } from "../../settings-store";
import { createMetaPurchaseEventId, isOrderEligibleForMetaPurchase } from "../meta/purchase-outbox";
import {
  buildGa4PurchasePayload,
  buildGa4RefundPayload,
  ga4MatchSignals,
  sendGa4Payload,
  type Ga4Identity,
  type Ga4OrderFacts,
} from "../ga4/measurement-protocol";
import {
  buildTikTokPurchaseEvent,
  sendTikTokPayload,
  tiktokMatchSignals,
  tiktokUser,
} from "../tiktok/events-api";
import {
  ga4MeasurementDocument,
  tiktokEventsDocument,
  trackingConsentDocument,
} from "./settings";
import { orderConsent, TRACKING_SIGNALS_RETENTION_SECONDS, type OrderTrackingSignalsRow } from "./signals";

export type TrackingDestination = "ga4" | "tiktok";
export type TrackingDeliveryStatus = "pending" | "processing" | "sent" | "failed" | "skipped";

const LEASE_SECONDS = 5 * 60;
const MAX_FLUSH_LIMIT = 25;
const MAX_ERROR_LENGTH = 300;
/** A delivery that keeps failing gives up after this many attempts (about 8 hours of backoff). */
const MAX_ATTEMPTS = 12;
/** Sent and skipped rows are kept this long for tracking_health and refund matching. */
export const TRACKING_DELIVERY_RETENTION_SECONDS = 90 * 24 * 60 * 60;
export const CONSENT_DENIED = "consent_denied";
export const AWAITING_PAYMENT = "awaiting_payment";

type DeliveryRow = typeof trackingDeliveries.$inferSelect;

export interface TrackingRuntime {
  storefrontUrl?: string | null;
  encryptionKey?: string;
  fetcher?: typeof fetch;
  nowSeconds?: () => number;
}

export interface TrackingFlushResult {
  scanned: number;
  sent: number;
  failed: number;
  skipped: number;
  deferred: number;
  busy: number;
}

type Outcome = "sent" | "failed" | "skipped" | "deferred" | "busy";

/** Due rows, oldest first, through the due and claim indexes (bounded walks). */
export async function flushTrackingDeliveries(db: Database, runtime: TrackingRuntime & { limit?: number }): Promise<TrackingFlushResult> {
  const limit = Math.max(1, Math.min(runtime.limit ?? 10, MAX_FLUSH_LIMIT));
  const rows = await db
    .select({ id: trackingDeliveries.id })
    .from(trackingDeliveries)
    .where(or(
      and(inArray(trackingDeliveries.status, ["pending", "failed"]), lte(trackingDeliveries.nextAttemptAt, sql`unixepoch()`)),
      and(eq(trackingDeliveries.status, "processing"), lte(trackingDeliveries.claimExpiresAt, sql`unixepoch()`)),
    ))
    .orderBy(asc(trackingDeliveries.nextAttemptAt))
    .limit(limit)
    .all();
  const result: TrackingFlushResult = { scanned: rows.length, sent: 0, failed: 0, skipped: 0, deferred: 0, busy: 0 };
  for (const row of rows) {
    result[await processTrackingDelivery(db, row.id, runtime)] += 1;
  }
  return result;
}

/**
 * Sends an order's open deliveries now: after its commit, and when its hosted
 * payment is confirmed (a row waiting for payment is made due first).
 */
export async function processTrackingDeliveriesForOrder(
  db: Database,
  orderId: string,
  runtime: TrackingRuntime & { paymentConfirmed?: boolean },
): Promise<Outcome[]> {
  if (runtime.paymentConfirmed) await db
    .update(trackingDeliveries)
    .set({ nextAttemptAt: sql`unixepoch() - 1`, updatedAt: sql`unixepoch()` })
    .where(and(eq(trackingDeliveries.orderId, orderId), eq(trackingDeliveries.status, "pending")));
  const rows = await db
    .select({ id: trackingDeliveries.id })
    .from(trackingDeliveries)
    .where(and(eq(trackingDeliveries.orderId, orderId), inArray(trackingDeliveries.status, ["pending", "failed"])))
    .all();
  const outcomes: Outcome[] = [];
  for (const row of rows) outcomes.push(await processTrackingDelivery(db, row.id, runtime));
  return outcomes;
}

export async function processTrackingDelivery(db: Database, deliveryId: string, runtime: TrackingRuntime): Promise<Outcome> {
  const claimId = `trkc_${crypto.randomUUID().replace(/-/g, "")}`;
  const claimed = await db
    .update(trackingDeliveries)
    .set({
      status: "processing",
      claimId,
      claimExpiresAt: sql`unixepoch() + ${LEASE_SECONDS}`,
      attempts: sql`${trackingDeliveries.attempts} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(
      eq(trackingDeliveries.id, deliveryId),
      or(
        and(inArray(trackingDeliveries.status, ["pending", "failed"]), lte(trackingDeliveries.nextAttemptAt, sql`unixepoch()`)),
        and(eq(trackingDeliveries.status, "processing"), lte(trackingDeliveries.claimExpiresAt, sql`unixepoch()`)),
      ),
    ))
    .returning();
  const row = claimed[0];
  if (!row) return "busy";

  try {
    const attempt = await attemptDelivery(db, row, runtime);
    await settle(db, row, claimId, attempt);
    return attempt.outcome;
  } catch (error) {
    await settle(db, row, claimId, { outcome: "failed", error: error instanceof Error ? error.message : String(error) });
    return "failed";
  }
}

type Attempt =
  | { outcome: "sent"; matchSignals: string[] }
  | { outcome: "skipped"; error: string }
  | { outcome: "deferred"; error: string; delaySeconds: number }
  | { outcome: "failed"; error: string };

async function settle(db: Database, row: DeliveryRow, claimId: string, attempt: Attempt): Promise<void> {
  const owned = and(eq(trackingDeliveries.id, row.id), eq(trackingDeliveries.claimId, claimId));
  const base = { claimId: null, claimExpiresAt: null, updatedAt: sql`unixepoch()` };
  if (attempt.outcome === "sent") {
    await db.update(trackingDeliveries).set({
      ...base, status: "sent", sentAt: sql`unixepoch()`, lastError: null, matchSignals: attempt.matchSignals.join(","),
    }).where(owned);
  } else if (attempt.outcome === "skipped") {
    await db.update(trackingDeliveries).set({ ...base, status: "skipped", lastError: bounded(attempt.error) }).where(owned);
  } else if (attempt.outcome === "deferred") {
    await db.update(trackingDeliveries).set({
      ...base, status: "pending", attempts: 0, lastError: bounded(attempt.error),
      nextAttemptAt: sql`unixepoch() + ${attempt.delaySeconds}`,
    }).where(owned);
  } else if (row.attempts >= MAX_ATTEMPTS) {
    await db.update(trackingDeliveries).set({ ...base, status: "skipped", lastError: bounded(`attempt_limit: ${attempt.error}`) }).where(owned);
  } else {
    await db.update(trackingDeliveries).set({
      ...base, status: "failed", lastError: bounded(attempt.error),
      nextAttemptAt: sql`unixepoch() + ${retryDelaySeconds(row.attempts)}`,
    }).where(owned);
  }
}

async function attemptDelivery(db: Database, row: DeliveryRow, runtime: TrackingRuntime): Promise<Attempt> {
  const now = runtime.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
  // One round trip: the order, its lines, its snapshot, the settings and the refund.
  const [orderRows, lineRows, signalRows, settingRows, refundRows] = await db.batch([
    db.select().from(orders).where(eq(orders.id, row.orderId)).limit(1),
    db.select().from(orderItems).where(and(eq(orderItems.orderId, row.orderId), sql`${row.eventName === "purchase" ? 1 : 0} = 1`)),
    db.select().from(orderTrackingSignals).where(eq(orderTrackingSignals.orderId, row.orderId)).limit(1),
    selectSettingsDocuments(db, [trackingConsentDocument, row.destination === "ga4" ? ga4MeasurementDocument : tiktokEventsDocument]),
    db.select({ amountMinor: orderPayments.amountMinor, status: orderPayments.status, paymentType: orderPayments.paymentType })
      .from(orderPayments).where(eq(orderPayments.id, row.paymentId ?? "")).limit(1),
  ]);
  const order = orderRows[0];
  const lines = lineRows;
  const signals = signalRows[0];
  const refund = row.eventName === "refund" ? refundRows[0] : undefined;
  if (!order || order.deletedAt) return { outcome: "skipped", error: "order_missing: the order no longer exists." };

  const committedAt = signals?.createdAt ?? Math.floor(order.createdAt.getTime() / 1000);
  if (row.eventName === "purchase") {
    if (order.status === "incomplete" && now - committedAt < TRACKING_SIGNALS_RETENTION_SECONDS) {
      return { outcome: "deferred", error: `${AWAITING_PAYMENT}: the hosted payment is not confirmed yet.`, delaySeconds: 60 * 60 };
    }
    if (!isOrderEligibleForMetaPurchase(order)) {
      return { outcome: "skipped", error: `not_eligible: order is ${order.status}/${order.paymentStatus}.` };
    }
    if (lines.length === 0) return { outcome: "skipped", error: "not_eligible: the order has no lines." };
  } else if (!refund || refund.paymentType !== "refund" || refund.status !== "refunded" || refund.amountMinor <= 0) {
    return { outcome: "skipped", error: "not_eligible: the refund is not confirmed." };
  }

  const consentSettings = await trackingConsentDocument.fromRows(settingRows);
  const consent = orderConsent(signals, order.shippingCountryCode ?? order.billingCountryCode ?? null, consentSettings.value);
  const facts: Ga4OrderFacts = {
    id: order.id,
    customerId: order.customerId,
    currencyCode: order.currencyCode,
    currencyDecimalPlaces: order.currencyDecimalPlaces,
    totalAmountMinor: order.totalAmountMinor,
    taxAmountMinor: order.taxAmountMinor,
    shippingAmountMinor: order.shippingAmountMinor,
    committedAt,
  };

  if (row.destination === "ga4") {
    if (!consent.analytics) return { outcome: "skipped", error: `${CONSENT_DENIED}: the buyer did not grant analytics consent.` };
    const read = await ga4MeasurementDocument.fromRows(settingRows, { encryptionKey: runtime.encryptionKey });
    const settings = read.value;
    if (!settings.isEnabled || !settings.measurementId || !settings.apiSecret) {
      return { outcome: "skipped", error: "not_configured: GA4 Measurement Protocol is off or has no readable API secret." };
    }
    const identity = ga4Identity(signals, consent);
    const payload = row.eventName === "purchase"
      ? await buildGa4PurchasePayload(facts, lines, identity, now)
      : await buildGa4RefundPayload(facts, refund!.amountMinor, identity, now);
    const sent = await sendGa4Payload(payload, settings, runtime.fetcher);
    if (sent.ok) return { outcome: "sent", matchSignals: ga4MatchSignals(identity, order.customerId) };
    return sent.retryable ? { outcome: "failed", error: sent.error ?? "GA4 send failed." } : { outcome: "skipped", error: sent.error ?? "GA4 refused the event." };
  }

  if (!consent.marketing) return { outcome: "skipped", error: `${CONSENT_DENIED}: the buyer did not grant marketing consent.` };
  const read = await tiktokEventsDocument.fromRows(settingRows, { encryptionKey: runtime.encryptionKey });
  const settings = read.value;
  if (!settings.isEnabled || !settings.pixelCode || !settings.accessToken) {
    return { outcome: "skipped", error: "not_configured: TikTok Events API is off or has no readable access token." };
  }
  const origin = storefrontOrigin(runtime.storefrontUrl);
  if (!origin) return { outcome: "skipped", error: "not_configured: the Store URL is not set." };
  const user = await tiktokUser({
    email: order.customerEmail,
    phone: order.customerPhone,
    externalId: order.customerId,
    ttp: signals?.ttp,
    ttclid: signals?.ttclid,
    ip: signals?.clientIp,
    userAgent: signals?.userAgent,
  });
  const pageUrl = new URL("/order-success", origin);
  pageUrl.searchParams.set("orderId", order.id);
  const sent = await sendTikTokPayload({
    event_source: "web",
    event_source_id: settings.pixelCode,
    ...(settings.testEventCode ? { test_event_code: settings.testEventCode } : {}),
    data: [buildTikTokPurchaseEvent({
      order: facts,
      lines,
      user,
      pageUrl: pageUrl.toString(),
      eventId: createMetaPurchaseEventId(order.id),
      limitedDataUse: !consent.saleOfData,
    })],
  }, settings.accessToken, runtime.fetcher);
  if (sent.ok) return { outcome: "sent", matchSignals: tiktokMatchSignals(user) };
  return sent.retryable ? { outcome: "failed", error: sent.error ?? "TikTok send failed." } : { outcome: "skipped", error: sent.error ?? "TikTok refused the event." };
}

function ga4Identity(signals: OrderTrackingSignalsRow | undefined, consent: ConsentState): Ga4Identity {
  return {
    clientId: signals?.gaClientId ?? null,
    sessionId: signals?.gaSessionId ?? null,
    adsConsent: consent.marketing,
  };
}

function storefrontOrigin(value: string | null | undefined): string | null {
  try {
    return value?.trim() ? new URL(value).origin : null;
  } catch {
    return null;
  }
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(60 * 60, 60 * 2 ** (Math.max(1, Math.min(attempts, 8)) - 1));
}

function bounded(message: string): string {
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}...` : message;
}

/** Deletes finished deliveries past the retention, at most `limit`. */
export async function purgeFinishedTrackingDeliveries(db: Database, options: { limit: number; nowSeconds?: number }): Promise<number> {
  const cutoff = (options.nowSeconds ?? Math.floor(Date.now() / 1000)) - TRACKING_DELIVERY_RETENTION_SECONDS;
  const rows = await db
    .delete(trackingDeliveries)
    .where(sql`${trackingDeliveries.id} IN (
      SELECT ${trackingDeliveries.id} FROM ${trackingDeliveries}
      WHERE ${lt(trackingDeliveries.createdAt, cutoff)} AND ${inArray(trackingDeliveries.status, ["sent", "skipped"])}
      ORDER BY ${trackingDeliveries.createdAt} LIMIT ${Math.max(1, Math.floor(options.limit))}
    )`)
    .returning({ id: trackingDeliveries.id });
  return rows.length;
}
