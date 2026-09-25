// Nightly catalogue maintenance, run from the 15-minute cron once a day
// (the first tick at or after 20:00 UTC, 02:00 in Dhaka):
//
// 1. `product_sales_stats` from the last 30 days of real order lines (the
//    home page's "popular" list and the recommendation ranking's signal);
// 2. the buyer-state/facet projection rebuild, queued in keyset chunks, which
//    heals any drift (for example a changed store low-stock level) and bumps
//    the cache generation once when it ends;
// 3. recommendation refreshes for products sold in the last day and the
//    longest-unrefreshed public products, 20 per queue message.
import type { Database } from "@scalius/database/client";
import {
  nightlyRecommendationRefreshCandidates,
  refreshProductSalesStats,
} from "@scalius/core/modules/catalog";
import { enqueueCatalogProjectionRebuild, enqueueRecommendationRefresh } from "../utils/catalog-jobs";

/** UTC hour whose first cron tick runs the nightly pass. */
export const NIGHTLY_CATALOG_UTC_HOUR = 20;
/** The cron fires every 15 minutes: exactly one tick falls in this window. */
const NIGHTLY_WINDOW_MINUTES = 15;
/**
 * Recommendation lists refreshed per night, never-computed and oldest first:
 * about 0.1 s of D1 time each at 30k products (about 5 minutes a night),
 * so a whole 30k catalogue rolls over in ten nights.
 */
export const NIGHTLY_RECOMMENDATION_REFRESH_LIMIT = 3_000;

/** KV hint: the Worker version whose post-deploy projection rebuild was queued. */
export const PROJECTIONS_REBUILT_FOR_VERSION_KEY = "catalog:projections:rebuilt-for-version";

/**
 * The first cron tick of a new API version queues one full projection
 * rebuild. Migrations apply before the new Worker goes live, so a write the
 * previous version committed in between (it does not know the projections)
 * is healed within one tick instead of at night. The KV key is a hint: if it
 * is lost, one more rebuild runs.
 */
export async function queuePostDeployProjectionRebuild(env: Env): Promise<boolean> {
  const version = env.CF_VERSION_METADATA?.id;
  if (!version || !env.CACHE || !env.JOBS_QUEUE) return false;
  if (await env.CACHE.get(PROJECTIONS_REBUILT_FOR_VERSION_KEY) === version) return false;
  await enqueueCatalogProjectionRebuild(env.JOBS_QUEUE, null);
  await env.CACHE.put(PROJECTIONS_REBUILT_FOR_VERSION_KEY, version);
  return true;
}

export function isNightlyCatalogTick(scheduledTime: number | undefined): boolean {
  if (typeof scheduledTime !== "number" || !Number.isFinite(scheduledTime)) return false;
  const at = new Date(scheduledTime);
  return at.getUTCHours() === NIGHTLY_CATALOG_UTC_HOUR && at.getUTCMinutes() < NIGHTLY_WINDOW_MINUTES;
}

export async function runNightlyCatalogMaintenance(
  db: Database,
  env: Env,
  scheduledTime: number,
): Promise<{ salesStatsProducts: number; recommendationMessages: number; rebuildQueued: boolean }> {
  const salesStats = await refreshProductSalesStats(db);
  const rebuildQueued = await enqueueCatalogProjectionRebuild(env.JOBS_QUEUE, null);
  const candidates = await nightlyRecommendationRefreshCandidates(db, {
    soldSince: Math.floor(scheduledTime / 1000) - 86_400,
    limit: NIGHTLY_RECOMMENDATION_REFRESH_LIMIT,
  });
  const recommendationMessages = await enqueueRecommendationRefresh(env.JOBS_QUEUE, candidates);
  return { salesStatsProducts: salesStats.products, recommendationMessages, rebuildQueued };
}
