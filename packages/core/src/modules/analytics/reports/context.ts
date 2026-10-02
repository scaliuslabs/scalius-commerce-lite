// One analytics request's context: the store currency and the unit-cost
// capability, each read at most once per request. Nothing here outlives the
// request (no module state): a Worker isolate serves many stores' requests.
import { sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { readStoreCurrency, type StoreCurrency } from "../../settings/store-money";
import { retryTransientD1 } from "../../../utils/transient-d1";

export interface AnalyticsContext {
  db: Database;
  /** Reports sum one currency: the store's. Orders in any other are counted, never added. */
  currency: StoreCurrency;
  now: Date;
  /** Whether order lines record their unit cost at the time of sale (`order_items.unit_cost_minor`). */
  hasUnitCost(): Promise<boolean>;
}

const MISSING_COLUMN = /no such column|does not exist|unknown column/i;

/**
 * The margin report lights up when `order_items.unit_cost_minor` exists.
 * A zero-row read of the column answers on D1, TursoDB and PostgreSQL alike;
 * only a missing-column error means "not yet", anything else propagates.
 */
export async function probeOrderLineUnitCost(db: Database): Promise<boolean> {
  try {
    await db.select({ unitCost: sql`unit_cost_minor` }).from(sql`order_items`).limit(0);
    return true;
  } catch (error: unknown) {
    const message = collectMessages(error);
    if (MISSING_COLUMN.test(message) && message.includes("unit_cost_minor")) return false;
    throw error;
  }
}

function collectMessages(error: unknown, depth = 0): string {
  if (depth > 4 || error === null || error === undefined) return "";
  if (typeof error !== "object") return String(error);
  const candidate = error as { message?: unknown; cause?: unknown };
  return `${typeof candidate.message === "string" ? candidate.message : ""} ${collectMessages(candidate.cause, depth + 1)}`;
}

export async function createAnalyticsContext(db: Database, now: Date = new Date()): Promise<AnalyticsContext> {
  const currency = await readStoreCurrency(db);
  let unitCost: Promise<boolean> | null = null;
  return {
    db,
    currency,
    now,
    hasUnitCost() {
      unitCost ??= probeOrderLineUnitCost(db);
      return unitCost;
    },
  };
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

export function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}
