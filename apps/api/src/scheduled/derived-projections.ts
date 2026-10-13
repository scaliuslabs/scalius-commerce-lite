// One drift check and repair for the projections triggers keep in step with
// their sources and the catalogue rebuild does not cover: the analytics
// facts and sealed days, recommendation order/product pairs, and the inbox
// counters. Run nightly by maintenance and on demand by the
// `dashboard.derived_projections.maintain` operation.
import { sql } from "drizzle-orm";
import { safeBatch, type Database } from "@scalius/database/client";
import {
  conversationInboxCountsDriftSql, conversationInboxCountsRebuild,
  recommendationPairsDriftSql, recommendationPairsRepairStatements,
} from "@scalius/database/derived-projections";
import { sqlText } from "@scalius/database/analytics-rollup";
import { checkAnalyticsRollup, rebuildAnalyticsRollup, sealAnalyticsDays } from "@scalius/core/modules/analytics";

/** Orders a check samples (newest) or a rebuild call covers (id order). */
const ORDERS_PER_CALL = 500;

export interface DerivedProjectionReport {
  sealedDays: number;
  analytics: { drift: number; repaired: boolean };
  recommendations: { drift: number; repaired: boolean };
  inbox: { drift: number; repaired: boolean };
  /** Rebuild only: the cursor to pass back until `done`. */
  nextAfterOrderId?: string | null;
  done?: boolean;
}

const statement = (db: Database, text: string) => db.run(sql.raw(text.replace(/;\s*$/, "")));
const drift = async (db: Database, text: string) => Number((await db.all<{ drift: number }>(sql.raw(text)))[0]?.drift ?? 0);

/** Rewrites the recommendation pairs of `orderIds`, advancing the ranking dependency once. */
async function repairRecommendationPairs(db: Database, orderIds: string): Promise<void> {
  await safeBatch(db, [
    ...recommendationPairsRepairStatements(orderIds).map((text) => statement(db, text)),
    // The projection is not a dependency source: a repair invalidates its readers itself.
    statement(db, "UPDATE cache_clock SET seq = seq + 1 WHERE id = 1"),
    statement(db, `INSERT INTO cache_dep (dep, seq) VALUES ('recommendation-signals', (SELECT seq FROM cache_clock WHERE id = 1))
      ON CONFLICT (dep) DO UPDATE SET seq = excluded.seq`),
  ]);
}

/**
 * Checks a sample (the newest orders, the last week's sealed days, every
 * inbox counter) and, with `repair`, rewrites what differs. With `rebuild`,
 * recomputes the next ORDERS_PER_CALL orders after `afterOrderId` instead of
 * the sample; call again with the returned cursor until `done`.
 */
export async function maintainDerivedProjections(
  db: Database,
  options: { repair?: boolean; rebuild?: boolean; afterOrderId?: string | null; now?: Date } = {},
): Promise<DerivedProjectionReport> {
  const repair = options.repair ?? true;
  const sealedDays = await sealAnalyticsDays(db, options.now);
  let analytics: DerivedProjectionReport["analytics"];
  let orderIds = `SELECT id FROM orders ORDER BY created_at DESC, id DESC LIMIT ${ORDERS_PER_CALL}`;
  let cursor: Pick<DerivedProjectionReport, "nextAfterOrderId" | "done"> = {};
  if (options.rebuild) {
    const after = options.afterOrderId ?? null;
    const page = await rebuildAnalyticsRollup(db, { afterOrderId: after });
    analytics = { drift: 0, repaired: true };
    orderIds = `SELECT id FROM orders WHERE ${after === null ? "1 = 1" : `id > ${sqlText(after)}`} ORDER BY id LIMIT ${ORDERS_PER_CALL}`;
    cursor = { nextAfterOrderId: page.nextAfterOrderId, done: page.done };
  } else {
    analytics = await checkAnalyticsRollup(db, { repair, now: options.now });
  }
  const recommendationDrift = await drift(db, recommendationPairsDriftSql(orderIds));
  if ((repair || options.rebuild) && recommendationDrift > 0) await repairRecommendationPairs(db, orderIds);
  const inboxDrift = await drift(db, conversationInboxCountsDriftSql);
  if ((repair || options.rebuild) && inboxDrift > 0) {
    await safeBatch(db, conversationInboxCountsRebuild.map((text) => statement(db, text)));
  }
  return {
    sealedDays,
    analytics,
    recommendations: { drift: recommendationDrift, repaired: (repair || Boolean(options.rebuild)) && recommendationDrift > 0 },
    inbox: { drift: inboxDrift, repaired: (repair || Boolean(options.rebuild)) && inboxDrift > 0 },
    ...cursor,
  };
}
