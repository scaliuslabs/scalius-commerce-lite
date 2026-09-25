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
/** Recommendation lists refreshed per night (about 3 s of D1 time per 100 at 30k products). */
export const NIGHTLY_RECOMMENDATION_REFRESH_LIMIT = 2_000;

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
