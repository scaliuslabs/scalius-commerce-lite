// tracking_health (audit spec §3.10): what the server tracking did in the
// last 24 hours, readable by staff and agents without the dashboard. Per
// destination: configuration, test mode, deliveries by event and status,
// purchases skipped by consent and the latest error; across orders: consent
// outcomes and match-signal coverage. It reads only counts and fixed or
// bounded error sentences: no identifier, contact or token leaves it.
// Five bounded statements in one batch, each walking a created_at index
// (Meta's browser-event logs: their own 30-day retention).

import type { Database } from "@scalius/database/client";
import { metaCapiPurchaseOutbox, metaConversionsLogs, orderTrackingSignals, orders, trackingDeliveries } from "@scalius/database/schema";
import { and, desc, eq, gte, inArray, SQL, sql } from "drizzle-orm";
import { NO_PHONE } from "@scalius/shared/customer-auth-policy";
import { metaConversionsDocument } from "../settings";
import { selectSettingsDocuments, type SettingsDocumentRow } from "../../settings-store";
import {
  ga4MeasurementDocument,
  ga4ServerEnabled,
  tiktokEventsDocument,
  tiktokServerEnabled,
  trackingConsentDocument,
} from "../../integrations/tracking/settings";

export const TRACKING_HEALTH_WINDOW_SECONDS = 24 * 60 * 60;

export interface DeliveryCounts {
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
}

export interface TrackingDestinationHealth {
  destination: "meta" | "ga4" | "tiktok";
  configured: boolean;
  /** Meta and TikTok: a test event code is set; GA4: debug mode (validation only, nothing recorded). */
  testMode: boolean;
  /** Server events by name: `Purchase`/`purchase`, `refund`, and Meta's relayed browser events. */
  events: Array<{ event: string } & DeliveryCounts>;
  /** Orders whose consent snapshot kept this destination's purchase from being sent. */
  skippedByConsent: number;
  /** Per match signal, how many sent events carried it (GA4 and TikTok). */
  matchSignals: Record<string, number>;
  lastError: { at: string; message: string } | null;
}

export interface TrackingHealth {
  windowHours: number;
  since: string;
  consent: {
    otherRegions: string;
    orders: number;
    analyticsGranted: number;
    marketingGranted: number;
    saleOfDataGranted: number;
    bySource: { banner: number; default: number; gpc: number };
  };
  /** Of the window's orders with a snapshot, the share (0-100) that carried each signal. */
  matchSignalCoverage: { orders: number; percent: Record<string, number> };
  destinations: TrackingDestinationHealth[];
}

const COVERAGE_SIGNALS = ["em", "ph", "fbp", "fbc", "ip", "ua", "ttp", "ttclid", "gaClientId", "gaSessionId", "gclid"] as const;
const DELIVERY_SIGNALS = ["client_id", "session_id", "user_id", "email", "phone", "external_id", "ttp", "ttclid", "ip", "user_agent"] as const;

const n = (value: unknown) => Number(value ?? 0) || 0;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const counted = (status: string, column: unknown) => sql<number>`sum(case when ${column} = ${status} then 1 else 0 end)`;

/**
 * Names every computed column: aggregates that differ only by a bound value
 * have the same SQL text, and D1 keys result columns by name (AGENTS.md).
 */
function aliased<T extends Record<string, unknown>>(fields: T): T {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [
    key,
    value instanceof SQL ? value.as(key) : value,
  ])) as T;
}

function emptyCounts(): DeliveryCounts {
  return { sent: 0, failed: 0, skipped: 0, pending: 0 };
}

export async function getTrackingHealth(
  db: Database,
  options: { encryptionKey?: string; nowSeconds?: number } = {},
): Promise<TrackingHealth> {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const since = now - TRACKING_HEALTH_WINDOW_SECONDS;
  const present = (column: unknown) => sql<number>`sum(case when ${column} is not null then 1 else 0 end)`;
  const deliverySignal = (name: string) => sql<number>`sum(case when instr(',' || coalesce(${trackingDeliveries.matchSignals}, '') || ',', ${`,${name},`}) > 0 then 1 else 0 end)`;

  const [settingRows, signalRows, deliveryRows, metaRows, metaLogRows, errorRows] = await db.batch([
    selectSettingsDocuments(db, [metaConversionsDocument, ga4MeasurementDocument, tiktokEventsDocument, trackingConsentDocument]),
    db.select(aliased({
      orders: sql<number>`count(*)`,
      analytics: sql<number>`sum(${orderTrackingSignals.consentAnalytics})`,
      marketing: sql<number>`sum(${orderTrackingSignals.consentMarketing})`,
      saleOfData: sql<number>`sum(${orderTrackingSignals.consentSaleOfData})`,
      banner: counted("banner", orderTrackingSignals.consentSource),
      gpc: counted("gpc", orderTrackingSignals.consentSource),
      default: counted("default", orderTrackingSignals.consentSource),
      em: sql<number>`sum(case when ${orders.customerEmail} is not null and ${orders.customerEmail} <> '' then 1 else 0 end)`,
      ph: sql<number>`sum(case when ${orders.customerPhone} is not null and ${orders.customerPhone} <> ${NO_PHONE} then 1 else 0 end)`,
      fbp: present(orderTrackingSignals.fbp),
      fbc: present(orderTrackingSignals.fbc),
      ip: present(orderTrackingSignals.clientIp),
      ua: present(orderTrackingSignals.userAgent),
      ttp: present(orderTrackingSignals.ttp),
      ttclid: present(orderTrackingSignals.ttclid),
      gaClientId: present(orderTrackingSignals.gaClientId),
      gaSessionId: present(orderTrackingSignals.gaSessionId),
      gclid: present(orderTrackingSignals.gclid),
    })).from(orderTrackingSignals)
      .leftJoin(orders, eq(orders.id, orderTrackingSignals.orderId))
      .where(gte(orderTrackingSignals.createdAt, since)),
    db.select(aliased({
      destination: trackingDeliveries.destination,
      event: trackingDeliveries.eventName,
      sent: counted("sent", trackingDeliveries.status),
      failed: counted("failed", trackingDeliveries.status),
      skipped: counted("skipped", trackingDeliveries.status),
      pending: sql<number>`sum(case when ${trackingDeliveries.status} in ('pending', 'processing') then 1 else 0 end)`,
      consentSkipped: sql<number>`sum(case when ${trackingDeliveries.status} = 'skipped' and substr(${trackingDeliveries.lastError}, 1, 14) = 'consent_denied' then 1 else 0 end)`,
      ...Object.fromEntries(DELIVERY_SIGNALS.map((name) => [`sig_${name}`, deliverySignal(name)])),
    })).from(trackingDeliveries)
      .where(gte(trackingDeliveries.createdAt, since))
      .groupBy(trackingDeliveries.destination, trackingDeliveries.eventName),
    db.select(aliased({
      sent: counted("sent", metaCapiPurchaseOutbox.status),
      failed: counted("failed", metaCapiPurchaseOutbox.status),
      skipped: counted("skipped", metaCapiPurchaseOutbox.status),
      pending: sql<number>`sum(case when ${metaCapiPurchaseOutbox.status} in ('pending', 'processing') then 1 else 0 end)`,
      consentSkipped: sql<number>`sum(case when ${metaCapiPurchaseOutbox.status} = 'skipped' and substr(${metaCapiPurchaseOutbox.lastError}, 1, 14) = 'consent_denied' then 1 else 0 end)`,
      lastError: sql<string | null>`(select ${metaCapiPurchaseOutbox.lastError} from ${metaCapiPurchaseOutbox} where ${metaCapiPurchaseOutbox.status} in ('failed', 'skipped') and ${metaCapiPurchaseOutbox.createdAt} >= ${since} order by ${metaCapiPurchaseOutbox.updatedAt} desc limit 1)`,
      lastErrorAt: sql<number | null>`(select ${metaCapiPurchaseOutbox.updatedAt} from ${metaCapiPurchaseOutbox} where ${metaCapiPurchaseOutbox.status} in ('failed', 'skipped') and ${metaCapiPurchaseOutbox.createdAt} >= ${since} order by ${metaCapiPurchaseOutbox.updatedAt} desc limit 1)`,
    })).from(metaCapiPurchaseOutbox).where(gte(metaCapiPurchaseOutbox.createdAt, since)),
    db.select(aliased({
      event: metaConversionsLogs.eventName,
      sent: counted("success", metaConversionsLogs.status),
      failed: counted("failed", metaConversionsLogs.status),
    })).from(metaConversionsLogs)
      .where(gte(metaConversionsLogs.createdAt, new Date(since * 1000)))
      .groupBy(metaConversionsLogs.eventName),
    db.select(aliased({
      destination: trackingDeliveries.destination,
      lastError: trackingDeliveries.lastError,
      updatedAt: trackingDeliveries.updatedAt,
    })).from(trackingDeliveries)
      .where(and(gte(trackingDeliveries.createdAt, since), inArray(trackingDeliveries.status, ["failed", "skipped"])))
      .orderBy(desc(trackingDeliveries.updatedAt))
      .limit(20),
  ] as const);

  const rows = settingRows as SettingsDocumentRow[];
  const ctx = { encryptionKey: options.encryptionKey };
  const [meta, ga4, tiktok, consentSettings] = await Promise.all([
    metaConversionsDocument.fromRows(rows, ctx),
    ga4MeasurementDocument.fromRows(rows, ctx),
    tiktokEventsDocument.fromRows(rows, ctx),
    trackingConsentDocument.fromRows(rows, ctx),
  ]);

  const signals = (signalRows as Array<Record<string, unknown>>)[0] ?? {};
  const orderCount = n(signals.orders);
  const percent = Object.fromEntries(COVERAGE_SIGNALS.map((name) => [
    name,
    orderCount === 0 ? 0 : Math.round((n(signals[name]) / orderCount) * 1000) / 10,
  ]));

  const destinationHealth = (destination: "ga4" | "tiktok", configured: boolean, testMode: boolean, consentDenied: number): TrackingDestinationHealth => {
    const own = (deliveryRows as Array<Record<string, unknown>>).filter((row) => row.destination === destination);
    const matchSignals: Record<string, number> = {};
    for (const name of DELIVERY_SIGNALS) {
      const total = own.reduce((sum, row) => sum + n(row[`sig_${name}`]), 0);
      if (total > 0) matchSignals[name] = total;
    }
    const error = (errorRows as Array<{ destination: string; lastError: string | null; updatedAt: number }>)
      .find((row) => row.destination === destination && row.lastError);
    return {
      destination,
      configured,
      testMode,
      events: own.map((row) => ({ event: String(row.event), sent: n(row.sent), failed: n(row.failed), skipped: n(row.skipped), pending: n(row.pending) })),
      skippedByConsent: consentDenied + own.reduce((sum, row) => sum + n(row.consentSkipped), 0),
      matchSignals,
      lastError: error?.lastError ? { at: iso(Number(error.updatedAt)), message: error.lastError } : null,
    };
  };

  const metaRow = (metaRows as Array<Record<string, unknown>>)[0] ?? {};
  const metaPurchase = { ...emptyCounts(), sent: n(metaRow.sent), failed: n(metaRow.failed), skipped: n(metaRow.skipped), pending: n(metaRow.pending) };
  const metaHealth: TrackingDestinationHealth = {
    destination: "meta",
    configured: meta.value.isEnabled && Boolean(meta.value.pixelId) && Boolean(meta.secretsConfigured.accessToken),
    testMode: Boolean(meta.value.testEventCode),
    events: [
      { event: "Purchase", ...metaPurchase },
      ...(metaLogRows as Array<{ event: string; sent: unknown; failed: unknown }>)
        .filter((row) => row.event !== "Purchase")
        .map((row) => ({ event: row.event, sent: n(row.sent), failed: n(row.failed), skipped: 0, pending: 0 })),
    ],
    skippedByConsent: n(metaRow.consentSkipped),
    matchSignals: {
      ...(orderCount > 0 ? {
        em: n(signals.em), ph: n(signals.ph), fbp: n(signals.fbp), fbc: n(signals.fbc), ip: n(signals.ip), ua: n(signals.ua),
      } : {}),
    },
    lastError: typeof metaRow.lastError === "string" && metaRow.lastError
      ? { at: iso(n(metaRow.lastErrorAt)), message: metaRow.lastError }
      : null,
  };

  return {
    windowHours: TRACKING_HEALTH_WINDOW_SECONDS / 3600,
    since: iso(since),
    consent: {
      otherRegions: consentSettings.value.otherRegions,
      orders: orderCount,
      analyticsGranted: n(signals.analytics),
      marketingGranted: n(signals.marketing),
      saleOfDataGranted: n(signals.saleOfData),
      bySource: { banner: n(signals.banner), default: n(signals.default), gpc: n(signals.gpc) },
    },
    matchSignalCoverage: { orders: orderCount, percent },
    destinations: [
      metaHealth,
      // No delivery row is written when the snapshot denies the category: count those orders.
      destinationHealth("ga4", ga4ServerEnabled(ga4) && !ga4.secretErrors.apiSecret, ga4.value.debugMode, ga4ServerEnabled(ga4) ? orderCount - n(signals.analytics) : 0),
      destinationHealth("tiktok", tiktokServerEnabled(tiktok) && !tiktok.secretErrors.accessToken, Boolean(tiktok.value.testEventCode), tiktokServerEnabled(tiktok) ? orderCount - n(signals.marketing) : 0),
    ],
  };
}
