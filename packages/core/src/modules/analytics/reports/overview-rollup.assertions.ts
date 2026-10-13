// Test-only: the projection equals a recomputation from its sources (any provider).
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import type { Database } from "@scalius/database/client";
import { analyticsBucketDriftSql, analyticsFactsDriftSql } from "@scalius/database/analytics-rollup";
import { sealAnalyticsDays } from "../rollup";

const DAY = 86_400;

async function span(db: Database): Promise<[number, number] | null> {
  const [row] = await db.all<{ lo: number | null; hi: number | null }>(sql`select min(created_at) as lo, max(created_at) as hi from analytics_order_facts`);
  return row?.lo == null || row.hi == null ? null : [Math.floor(Number(row.lo) / DAY) * DAY, Math.floor(Number(row.hi) / DAY) * DAY + DAY];
}

/** Incremental facts equal a rebuild, and every sealed day's buckets equal its facts. */
export async function assertRollupProjection(db: Database): Promise<void> {
  const drift = async (text: string) => Number((await db.all<{ drift: number }>(sql.raw(text)))[0]?.drift);
  expect(await drift(analyticsFactsDriftSql("1 = 1"))).toBe(0);
  const days = await span(db);
  if (days) expect(await drift(analyticsBucketDriftSql(days[0], days[1]))).toBe(0);
}

/** Seals every day that has facts, as the maintenance sweep does once they are finished. */
export async function sealEveryFactDay(db: Database): Promise<void> {
  const days = await span(db);
  if (!days) return;
  while (await sealAnalyticsDays(db, new Date(days[1] * 1000)) > 0) { /* oldest first, bounded per call */ }
}
