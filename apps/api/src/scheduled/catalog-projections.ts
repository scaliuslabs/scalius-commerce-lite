// Nightly catalogue maintenance, run from the cron once a day (the 02:00
// store-time minute: 20:00 UTC for Dhaka):
//
// 1. `product_sales_stats` from the last 30 days of real order lines (the
//    home page's "popular" list and the recommendation ranking's signal);
// 2. a buyer-state/facet projection rebuild request (background/catalog.ts),
//    which heals any drift (for example a changed store low-stock level);
// 3. recommendation refreshes for products sold in the last day. Every other
//    public product is visited by the recommendation rotation.
import type { Database } from "@scalius/database/client";
import { getDb } from "@scalius/database/client";
import { claimSystemKv } from "@scalius/core/utils/system-kv";
import {
  recentlySoldPublicProducts,
  refreshProductRecommendations,
  refreshProductSalesStats,
} from "@scalius/core/modules/catalog";
import { planLimits } from "@scalius/shared/plan-limits";
import { commerceCalendarDateKey, commerceWallTimeToEpoch } from "@scalius/shared/commerce-time";
import { requestCatalogProjectionRebuild } from "../background/catalog";

/** The store-time hour whose first minute runs the nightly pass. */
export const NIGHTLY_CATALOG_STORE_HOUR = 2;
/** The cron fires every minute: exactly one tick falls in this window. */
const NIGHTLY_WINDOW_MINUTES = 1;

/** `system_kv` row: the Worker version whose post-deploy projection rebuild was requested. */
export const PROJECTIONS_REBUILT_FOR_VERSION_KEY = "catalog:projections:rebuilt-for-version";

/**
 * The first rotation run of a new API version requests one full projection
 * rebuild. Migrations apply before the new Worker goes live, so a write the
 * previous version committed in between (it does not know the projections)
 * is healed within minutes instead of at night. The version is claimed in the
 * database first (compare-and-set), so overlapping ticks request it once.
 */
export async function requestPostDeployProjectionRebuild(env: Env): Promise<boolean> {
  const version = env.CF_VERSION_METADATA?.id;
  if (!version) return false;
  const db = getDb(env);
  if (!(await claimSystemKv(db, PROJECTIONS_REBUILT_FOR_VERSION_KEY, version))) return false;
  await requestCatalogProjectionRebuild(db);
  return true;
}

/**
 * Whether a tick is the night's first: 02:00 in the store's zone, or just
 * after the gap on a night the clocks skip 02:00 (daylight saving).
 */
export function isNightlyCatalogTick(scheduledTime: number | undefined, timeZone: string): boolean {
  if (typeof scheduledTime !== "number" || !Number.isFinite(scheduledTime)) return false;
  const start = commerceWallTimeToEpoch(timeZone, commerceCalendarDateKey(timeZone, scheduledTime), NIGHTLY_CATALOG_STORE_HOUR, 0);
  return start !== null && scheduledTime >= start * 1000 && scheduledTime < (start + NIGHTLY_WINDOW_MINUTES * 60) * 1000;
}

export async function runNightlyCatalogMaintenance(
  db: Database,
  scheduledTime: number,
): Promise<{ salesStatsProducts: number; soldRecommendations: number }> {
  const salesStats = await refreshProductSalesStats(db);
  await requestCatalogProjectionRebuild(db);
  const sold = await recentlySoldPublicProducts(db, {
    soldSince: Math.floor(scheduledTime / 1000) - 86_400,
    limit: planLimits().background.nightlySoldRecommendationLimit,
  });
  await refreshProductRecommendations(db, sold);
  return { salesStatsProducts: salesStats.products, soldRecommendations: sold.length };
}
