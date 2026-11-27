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

/** How many runs try a version's private pages compile that throws before it is settled for the version. */
export const PRIVATE_PAGES_COMPILE_TRIES = 3;
/** `system_kv` row: the product id the nightly drift check continues after ("" = from the start). */
export const PROJECTION_DRIFT_CURSOR_KEY = "catalog:projections:drift-cursor";

/**
 * The post-deploy settle, one maintenance step for everything a new API
 * version must do once: a settled version costs a run one read of
 * `PROJECTIONS_REBUILT_FOR_VERSION_KEY` and nothing else.
 *
 * 1. The first run requests one full projection rebuild when the projection's
 *    definition changed (`catalogProjectionDefinition`): migrations apply
 *    before the new Worker goes live, so a write the previous version
 *    committed in between wrote the old definition. An unchanged definition
 *    requests nothing, so a store that deploys often never keeps a
 *    whole-catalogue lap running. The version and the definition are each
 *    claimed in the database first (compare-and-set), so overlapping ticks
 *    request it once.
 * 2. The published theme's private pages compiled with this version's checker
 *    (`recompilePublishedPrivatePages`), independent of the rebuild (the
 *    version's value `<version>:theme`, then `<version>:theme:<failed runs>`).
 * 3. Every installed app's buyer-page sheet checked by this version's checker
 *    (`recheckBuyerChromeAfterDeploy`, one parse a run: `<version>:chrome`).
 *
 * A run does at most one piece of heavy work: a run that compiled the pages
 * (or whose compile threw) leaves the sheets to the next run.
 */
export async function requestPostDeployProjectionRebuild(env: Env): Promise<boolean> {
  const version = env.CF_VERSION_METADATA?.id;
  if (!version) return false;
  const db = getDb(env);
  const current = await getSystemKv(db, PROJECTIONS_REBUILT_FOR_VERSION_KEY);
  if (current === version) return false;
  const chrome = `${version}:chrome`;
  if (current === chrome) {
    await recheckBuyerChromeStage(env, db, version, current);
    return false;
  }
  const pending = `${version}:theme`;
  const failed = current === pending ? 0 : current?.startsWith(`${pending}:`) ? Number(current.slice(pending.length + 1)) || 0 : null;
  let requested = false;
  let sheetsNow = false;
  if (failed === null) {
    // First tick of this version: claimed (compare-and-set) so overlapping ticks rebuild once.
    if (!(await claimSystemKv(db, PROJECTIONS_REBUILT_FOR_VERSION_KEY, pending))) return false;
    const { catalogProjectionDefinition } = await import("@scalius/core/modules/products");
    const definition = await sha256Hex(catalogProjectionDefinition(db));
    if (await claimSystemKv(db, PROJECTION_DEFINITION_KEY, definition)) {
      await requestCatalogProjectionRebuild(db);
      requested = true;
    }
  }
  // A transient failure is tried again next tick (the version stays pending); a theme that cannot be
  // read moves on with one log line for this version. A page this checker refuses is recorded in the
  // published document with why (`compiled.refused`), which the theme page shows the merchant; the log
  // line names only the pages and reason codes.
  try {
    const { recompilePublishedPrivatePages } = await import("@scalius/core/modules/settings");
    const result = await recompilePublishedPrivatePages(db);
    if (result.outcome === "refused") console.warn(`[scheduled] Private pages for this version: refused on ${result.pages.join(", ")} (${result.reasons.join(", ")}); each draws the store's default look until the merchant saves`);
    else if (result.outcome !== "none" && result.outcome !== "current") console.log(`[scheduled] Private pages for this version: ${result.outcome}`);
    // A compile a publish raced wrote nothing: the version stays pending and the next run compiles again.
    if (result.outcome === "raced") return requested;
    if (result.outcome === "recompiled" || result.outcome === "refused") await putSystemKv(db, PROJECTIONS_REBUILT_FOR_VERSION_KEY, chrome);
    else sheetsNow = true;
  } catch (error) {
    // A compile that keeps throwing (a theme that costs more than a run) is tried a bounded number of times, then
    // settled for the version: its pages keep serving the default look until the merchant saves.
    const tries = (failed ?? 0) + 1;
    const settle = tries >= PRIVATE_PAGES_COMPILE_TRIES;
    console.warn(`[scheduled] Private pages compile failed; ${settle ? "settled for this version" : "retried next run"}`, error instanceof Error ? error.name : "unknown");
    await putSystemKv(db, PROJECTIONS_REBUILT_FOR_VERSION_KEY, settle ? chrome : `${pending}:${tries}`);
  }
  if (sheetsNow) await recheckBuyerChromeStage(env, db, version, current);
  return requested;
}

/**
 * The sheets stage: the version settles once no release is left to check. A run that leaves the value as it
 * was writes nothing; one that fails leaves it too, and the next run tries again (each release counts its own
 * tries, `BUYER_CHROME_CHECK_TRIES`).
 */
async function recheckBuyerChromeStage(env: Env, db: Database, version: string, current: string | null): Promise<void> {
  try {
    const { recheckBuyerChromeAfterDeploy } = await import("../plugins/buyer-chrome-check");
    const result = await recheckBuyerChromeAfterDeploy(env, db);
    if (result.checked > 0) console.log(`[scheduled] Buyer-page sheets checked: ${result.checked}, refused=${result.refused}, remaining=${result.remaining}`);
    const next = result.remaining === 0 ? version : `${version}:chrome`;
    if (next !== current) await putSystemKv(db, PROJECTIONS_REBUILT_FOR_VERSION_KEY, next);
  } catch (error) {
    console.warn("[scheduled] Buyer-page sheet check failed; retried next run", error instanceof Error ? error.name : "unknown");
  }
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
