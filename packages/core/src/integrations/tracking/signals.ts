// The tracking snapshot of a storefront order (audit spec §3.10): the consent
// that held when the buyer placed it and the first-party match signals the
// server senders need. Written in the checkout commit batch (one statement,
// plus one for the GA4/TikTok purchase deliveries when either is on) and
// purged after 8 days.

import type { Database } from "@scalius/database/client";
import { orderTrackingSignals, trackingDeliveries } from "@scalius/database/schema";
import { eq, lt, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
  consentRegimeFor,
  resolveConsent,
  signalsAllowedBy,
  type BrowserTrackingSignals,
  type ConsentState,
  type TrackingConsentSettings,
} from "@scalius/shared/tracking-consent";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** Meta accepts `event_time` up to 7 days old; one more day covers a late retry. */
export const TRACKING_SIGNALS_RETENTION_SECONDS = 8 * 24 * 60 * 60;

/** What the storefront's checkout proxy read from the buyer's request (no PII but IP and UA). */
export interface CheckoutTrackingRequest {
  /** The buyer's stored banner choice; null when they never chose. */
  consent: Pick<ConsentState, "analytics" | "marketing" | "saleOfData"> | null;
  gpc: boolean;
  signals: BrowserTrackingSignals;
  clientIp: string | null;
  userAgent: string | null;
}

export interface TrackingDestinations {
  meta: boolean;
  ga4: boolean;
  tiktok: boolean;
}

export interface OrderTrackingSnapshot {
  consent: ConsentState;
  signals: BrowserTrackingSignals;
  clientIp: string | null;
  userAgent: string | null;
  /** The server purchase deliveries this order owes (GA4 and TikTok; Meta has its outbox). */
  deliveries: Array<"ga4" | "tiktok">;
}

const EMPTY_SIGNALS: BrowserTrackingSignals = {
  fbp: null, fbc: null, ttp: null, ttclid: null, gaClientId: null, gaSessionId: null, gclid: null,
};

/**
 * The snapshot an order commits, or null when no server destination is on
 * (nothing is stored then). Consent is the buyer's choice, else the default
 * of the order's country (opt-in in the EEA, the UK and Switzerland); GPC
 * applies to both. Only the signals a granted category may use are kept:
 * advertising ids, IP and user agent with marketing, GA ids with analytics.
 */
export function resolveOrderTrackingSnapshot(options: {
  request: CheckoutTrackingRequest | null | undefined;
  orderCountry: string | null | undefined;
  consentSettings: TrackingConsentSettings;
  destinations: TrackingDestinations;
}): OrderTrackingSnapshot | null {
  const { destinations } = options;
  if (!destinations.meta && !destinations.ga4 && !destinations.tiktok) return null;
  const request = options.request;
  const consent = resolveConsent({
    stored: request?.consent ? { ...request.consent, source: "banner" } : null,
    regime: consentRegimeFor([options.orderCountry], options.consentSettings),
    gpc: request?.gpc === true,
  });
  const signals = signalsAllowedBy(consent, request?.signals ?? EMPTY_SIGNALS);
  return {
    consent,
    signals,
    clientIp: consent.marketing ? boundedText(request?.clientIp, 64) : null,
    userAgent: consent.marketing ? boundedText(request?.userAgent, 512) : null,
    deliveries: [
      ...(destinations.ga4 && consent.analytics ? ["ga4" as const] : []),
      ...(destinations.tiktok && consent.marketing ? ["tiktok" as const] : []),
    ],
  };
}

function boundedText(value: string | null | undefined, max: number): string | null {
  const text = value?.trim() ?? "";
  return text ? text.slice(0, max) : null;
}

export function trackingPurchaseDedupKey(orderId: string): string {
  return `purchase:${orderId}`;
}

/** An order awaiting a hosted payment is checked again after this long (the payment path sends it sooner). */
export const AWAITING_PAYMENT_RECHECK_SECONDS = 60 * 60;

/**
 * The checkout commit's tracking statements: the snapshot row and, when GA4
 * or TikTok is owed, their purchase deliveries (one multi-row insert). Both
 * commit with the order or not at all.
 */
export function buildOrderTrackingCommitStatements(
  db: Database,
  orderId: string,
  snapshot: OrderTrackingSnapshot,
  options: { awaitingPayment: boolean },
): SQLiteBatchItem[] {
  const statements: SQLiteBatchItem[] = [
    db.insert(orderTrackingSignals).values({
      orderId,
      consentAnalytics: snapshot.consent.analytics,
      consentMarketing: snapshot.consent.marketing,
      consentSaleOfData: snapshot.consent.saleOfData,
      consentSource: snapshot.consent.source,
      fbp: snapshot.signals.fbp,
      fbc: snapshot.signals.fbc,
      ttp: snapshot.signals.ttp,
      ttclid: snapshot.signals.ttclid,
      gaClientId: snapshot.signals.gaClientId,
      gaSessionId: snapshot.signals.gaSessionId,
      gclid: snapshot.signals.gclid,
      clientIp: snapshot.clientIp,
      userAgent: snapshot.userAgent,
      createdAt: sql`unixepoch()`,
    }).onConflictDoNothing() as SQLiteBatchItem,
  ];
  if (snapshot.deliveries.length > 0) {
    const due = options.awaitingPayment
      ? sql`unixepoch() + ${AWAITING_PAYMENT_RECHECK_SECONDS}`
      : sql`unixepoch() - 1`;
    statements.push(db.insert(trackingDeliveries).values(snapshot.deliveries.map((destination) => ({
      id: `trk_${randomId()}`,
      destination,
      eventName: "purchase",
      dedupKey: trackingPurchaseDedupKey(orderId),
      orderId,
      nextAttemptAt: due,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    }))).onConflictDoNothing() as SQLiteBatchItem);
  }
  return statements;
}

export type OrderTrackingSignalsRow = typeof orderTrackingSignals.$inferSelect;

export async function readOrderTrackingSignals(db: Database, orderId: string): Promise<OrderTrackingSignalsRow | undefined> {
  return await db.select().from(orderTrackingSignals).where(eq(orderTrackingSignals.orderId, orderId)).get();
}

/**
 * The consent a server sender honours for an order: its snapshot, else (an
 * order placed without one: an agent's, a staff order, one older than the
 * snapshot) the default of the order's country.
 */
export function orderConsent(
  row: Pick<OrderTrackingSignalsRow, "consentAnalytics" | "consentMarketing" | "consentSaleOfData" | "consentSource"> | undefined,
  orderCountry: string | null | undefined,
  consentSettings: TrackingConsentSettings,
): ConsentState {
  if (row) {
    const source = row.consentSource === "banner" || row.consentSource === "gpc" ? row.consentSource : "default";
    return {
      analytics: Boolean(row.consentAnalytics),
      marketing: Boolean(row.consentMarketing),
      saleOfData: Boolean(row.consentSaleOfData),
      source,
    };
  }
  return resolveConsent({ stored: null, regime: consentRegimeFor([orderCountry], consentSettings), gpc: false });
}

/** Deletes snapshots older than the retention, oldest first, at most `limit`. */
export async function purgeExpiredTrackingSignals(db: Database, options: { limit: number; nowSeconds?: number }): Promise<number> {
  const cutoff = (options.nowSeconds ?? Math.floor(Date.now() / 1000)) - TRACKING_SIGNALS_RETENTION_SECONDS;
  const rows = await db
    .delete(orderTrackingSignals)
    .where(sql`${orderTrackingSignals.orderId} IN (
      SELECT ${orderTrackingSignals.orderId} FROM ${orderTrackingSignals}
      WHERE ${lt(orderTrackingSignals.createdAt, cutoff)}
      ORDER BY ${orderTrackingSignals.createdAt} LIMIT ${Math.max(1, Math.floor(options.limit))}
    )`)
    .returning({ orderId: orderTrackingSignals.orderId });
  return rows.length;
}

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}
