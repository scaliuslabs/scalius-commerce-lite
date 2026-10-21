// Nightly catalogue maintenance, run from the cron once a day (the 02:00
// store-time minute: 20:00 UTC for Dhaka):
//
// 1. `product_sales_stats` from the last 30 days of real order lines (the
//    home page's "popular" list and the recommendation ranking's signal);
// 2. a drift check of the catalogue projections over a rotating window of
//    products (planLimits().background.catalogDriftCheckPerNight): drifted
//    products are repaired in place, and any drift requests a full rebuild
//    lap (background/catalog.ts), since it means some write skipped them;
// 3. recommendation refreshes for products sold in the last day. Every other
//    public product is visited by the recommendation rotation.
import type { Database } from "@scalius/database/client";
import { getDb } from "@scalius/database/client";
import { claimSystemKv, getSystemKv, putSystemKv } from "@scalius/core/utils/system-kv";
import {
  recentlySoldPublicProducts,
  refreshProductRecommendations,
  refreshProductSalesStats,
} from "@scalius/core/modules/catalog";
import { planLimits } from "@scalius/shared/plan-limits";
import { sha256Hex } from "@scalius/shared/hash";
import { commerceCalendarDateKey, commerceWallTimeToEpoch } from "@scalius/shared/commerce-time";
import { requestCatalogProjectionRebuild } from "../background/catalog";

/** The store-time hour whose first minute runs the nightly pass. */
export const NIGHTLY_CATALOG_STORE_HOUR = 2;
/** The cron fires every minute: exactly one tick falls in this window. */
const NIGHTLY_WINDOW_MINUTES = 1;

/** `system_kv` row: the Worker version whose post-deploy projection check ran. */
export const PROJECTIONS_REBUILT_FOR_VERSION_KEY = "catalog:projections:rebuilt-for-version";
/** `system_kv` row: the hash of the projection definition the stored projections were built with. */
export const PROJECTION_DEFINITION_KEY = "catalog:projections:definition";
/** `system_kv` row: the product id the nightly drift check continues after ("" = from the start). */
export const PROJECTION_DRIFT_CURSOR_KEY = "catalog:projections:drift-cursor";

/**
 * The first maintenance run of a new API version requests one full
 * projection rebuild when the projection's definition changed
 * (`catalogProjectionDefinition`): migrations apply before the new Worker
 * goes live, so a write the previous version committed in between wrote the
 * old definition. An unchanged definition requests nothing, so a store that
 * deploys often never keeps a whole-catalogue lap running. The version and
 * the definition are each claimed in the database first (compare-and-set),
 * so overlapping ticks request it once.
 */
export async function requestPostDeployProjectionRebuild(env: Env): Promise<boolean> {
  const version = env.CF_VERSION_METADATA?.id;
  if (!version) return false;
  const db = getDb(env);
  if (!(await claimSystemKv(db, PROJECTIONS_REBUILT_FOR_VERSION_KEY, version))) return false;
  const { catalogProjectionDefinition } = await import("@scalius/core/modules/products");
  const definition = await sha256Hex(catalogProjectionDefinition(db));
  if (!(await claimSystemKv(db, PROJECTION_DEFINITION_KEY, definition))) return false;
  await requestCatalogProjectionRebuild(db);
  return true;
}

/**
 * The nightly drift check: the next window of products after the stored
 * cursor (wrapping at the end), each compared with its sources and repaired
 * when it differs. Any drift requests a full rebuild lap. Returns the
 * products checked and repaired.
 */
export async function checkCatalogProjectionsNightly(db: Database): Promise<{ checked: number; repaired: number }> {
  const { checkCatalogProjectionDrift } = await import("@scalius/core/modules/products");
  const after = (await getSystemKv(db, PROJECTION_DRIFT_CURSOR_KEY)) || null;
  const result = await checkCatalogProjectionDrift(db, { afterProductId: after, limit: planLimits().background.catalogDriftCheckPerNight });
  await putSystemKv(db, PROJECTION_DRIFT_CURSOR_KEY, result.done ? "" : result.nextAfterProductId ?? "");
  if (result.repaired.length > 0) await requestCatalogProjectionRebuild(db);
  return { checked: result.checked, repaired: result.repaired.length };
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
): Promise<{ salesStatsProducts: number; soldRecommendations: number; projectionsChecked: number; projectionsRepaired: number }> {
  const salesStats = await refreshProductSalesStats(db);
  const drift = await checkCatalogProjectionsNightly(db);
  const sold = await recentlySoldPublicProducts(db, {
    soldSince: Math.floor(scheduledTime / 1000) - 86_400,
    limit: planLimits().background.nightlySoldRecommendationLimit,
  });
  await refreshProductRecommendations(db, sold);
  return {
    salesStatsProducts: salesStats.products,
    soldRecommendations: sold.length,
    projectionsChecked: drift.checked,
    projectionsRepaired: drift.repaired,
  };
}
