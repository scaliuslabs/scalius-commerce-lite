// One analytics request's context: the store currency and country, read once per request, and the store's
// time zone (resolved at Worker entry with the platform settings, so it costs no read). Nothing here outlives the
// request (no module state): a Worker isolate serves many stores' requests.
import type { Database } from "@scalius/database/client";
import { type StoreCurrency } from "../../settings";
import { readStoreCurrency } from "../../markets";
import { weekStartDay, type WeekDay } from "@scalius/shared/week-start";
import { readStoreCountry } from "../../../utils/store-country";
import { retryTransientD1 } from "../../../utils/transient-d1";

export interface AnalyticsContext {
  db: Database;
  /** Reports sum one currency: the store's. Orders in any other are counted, never added. */
  currency: StoreCurrency;
  /** The store's IANA zone: every merchant day, week and month is a day in it. */
  timeZone: string;
  /** The first day of a "week" bucket: the store country's (CLDR), Sunday in Bangladesh. */
  weekStart: WeekDay;
  now: Date;
  /**
   * A payment method's name from its provider (the request's gateways: an
   * app's), for exports. Absent: the
   * report's own words, else the stored id.
   */
  paymentMethodName?: (id: string) => string;
}

export async function createAnalyticsContext(db: Database, timeZone: string, now: Date = new Date()): Promise<AnalyticsContext> {
  const [currency, country] = await Promise.all([readStoreCurrency(db), readStoreCountry(db)]);
  return { db, currency, timeZone, weekStart: weekStartDay(country), now };
}

const ANALYTICS_RETRY_DELAYS_MS = [150, 350] as const;

/**
 * Runs one analytics read with transient-D1 retries and a duration log.
 * Logs carry the label and timing only, never figures or identities.
 */
export async function runAnalyticsQuery<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  let attempts = 0;
  try {
    const result = await retryTransientD1(() => {
      attempts += 1;
      return operation();
    }, { delaysMs: ANALYTICS_RETRY_DELAYS_MS });
    console.log("[analytics-query]", { event: "analytics_query_completed", query: label, attempts, durationMs: Date.now() - startedAt });
    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[analytics-query]", {
      event: "analytics_query_failed",
      query: label,
      attempts,
      durationMs: Date.now() - startedAt,
      error: message.length > 240 ? `${message.slice(0, 237)}...` : message,
    });
    throw error;
  }
}

/** A SQL number as a JavaScript number (PostgreSQL sums arrive as numeric strings only when unnormalized). */
export function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return 0;
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}
