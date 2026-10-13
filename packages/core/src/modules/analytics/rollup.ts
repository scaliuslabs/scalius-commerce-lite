// Maintenance of the analytics projection (@scalius/database/analytics-rollup):
// seal finished days, check a sample against the sources, repair by chunks.
// Triggers keep facts exact on every write; these paths heal a definition
// change or a defect, and turn finished days into buckets.
import { sql } from "drizzle-orm";
import { safeBatch, type Database } from "@scalius/database/client";
import {
  analyticsBucketDriftSql, analyticsFactsDriftSql, analyticsFactsRepairStatement,
  analyticsSealStatements, analyticsUnsealedDaysSql, sqlText,
} from "@scalius/database/analytics-rollup";

const DAY = 86_400;
/** Days sealed per call: about two months, one batch. */
export const ANALYTICS_SEAL_DAYS_PER_RUN = 62;
/** Orders recomputed per repair statement. */
export const ANALYTICS_REPAIR_ORDERS = 500;

const statement = (db: Database, text: string) => db.run(sql.raw(text));
const count = async (db: Database, text: string) =>
  Number((await db.all<{ drift: number }>(sql.raw(text)))[0]?.drift ?? 0);

/** Builds the buckets of finished UTC days (before `now`'s day) that are not sealed, oldest first. */
export async function sealAnalyticsDays(db: Database, now: Date = new Date()): Promise<number> {
  const through = Math.floor(now.getTime() / 1000 / DAY) * DAY;
  const days = (await db.all<{ day: number | null }>(sql.raw(analyticsUnsealedDaysSql(through, ANALYTICS_SEAL_DAYS_PER_RUN))))
    .map((row) => Number(row.day)).filter(Number.isSafeInteger);
  if (days.length > 0) await safeBatch(db, analyticsSealStatements(days).map((text) => statement(db, text)));
  return days.length;
}

export interface ProjectionCheck {
  /** Rows (facts, bucket rows, pairs or counters) that differ from their sources. */
  drift: number;
  repaired: boolean;
}

/**
 * Compares the newest orders' facts and the newest sealed days' buckets with
 * their sources. With `repair`, rewrites the differing facts (their days
 * unseal) and unseals drifted days for the next seal.
 */
export async function checkAnalyticsRollup(db: Database, options: { repair?: boolean; now?: Date } = {}): Promise<ProjectionCheck> {
  const scope = `1 = 1 order by o.created_at desc, o.id desc limit ${ANALYTICS_REPAIR_ORDERS}`;
  const through = Math.floor((options.now ?? new Date()).getTime() / 1000 / DAY) * DAY;
  // The sealed days of the sampled orders, and at least the last week.
  const [oldest] = await db.all<{ at: number | null }>(sql.raw(`select min(created_at) as at from (
    select created_at from orders order by created_at desc, id desc limit ${ANALYTICS_REPAIR_ORDERS}) as sample`));
  const from = Math.min(through - 7 * DAY, Math.floor(Number(oldest?.at ?? through) / DAY) * DAY);
  const facts = await count(db, analyticsFactsDriftSql(scope));
  const buckets = await count(db, analyticsBucketDriftSql(from, through));
  if (options.repair && facts > 0) await statement(db, analyticsFactsRepairStatement(scope));
  if (options.repair && buckets > 0) await statement(db, `delete from analytics_sealed_days where day >= ${from} and day < ${through}`);
  return { drift: facts + buckets, repaired: Boolean(options.repair) && facts + buckets > 0 };
}

/**
 * Recomputes the facts of the next orders after `afterOrderId` (id order),
 * writing only differing rows. The last call unseals every day, so the seal
 * sweep rebuilds all buckets from the repaired facts.
 */
export async function rebuildAnalyticsRollup(
  db: Database,
  input: { afterOrderId?: string | null } = {},
): Promise<{ nextAfterOrderId: string | null; done: boolean }> {
  const after = input.afterOrderId ?? null;
  const ids = await db.all<{ id: string }>(sql`select id from orders
    where ${after === null ? sql`1 = 1` : sql`id > ${after}`} order by id limit ${ANALYTICS_REPAIR_ORDERS}`);
  const last = ids.at(-1)?.id ?? null;
  if (last !== null) {
    await statement(db, analyticsFactsRepairStatement(
      `${after === null ? "1 = 1" : `o.id > ${sqlText(after)}`} and o.id <= ${sqlText(last)}`));
  }
  if (ids.length < ANALYTICS_REPAIR_ORDERS) {
    await db.run(sql`delete from analytics_sealed_days`);
    return { nextAfterOrderId: null, done: true };
  }
  return { nextAfterOrderId: last, done: false };
}
