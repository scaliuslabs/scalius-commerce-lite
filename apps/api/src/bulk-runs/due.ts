// Which bulk runs a drain may take: running, with no live lease. Apart from
// the engine so the every-minute cron can ask without loading it.
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { bulkRuns } from "@scalius/database/schema";

export function dueBulkRunCondition(nowSeconds: number) {
  return and(eq(bulkRuns.status, "running"), or(isNull(bulkRuns.leaseUntil), lt(bulkRuns.leaseUntil, nowSeconds)));
}

/**
 * Claims in a row that made no progress (no chunk or step committed) and were
 * never handed back: the next claim fails the run instead of taking it again.
 * A committed chunk or step resets the count, and so does `handBack` (a live
 * drain releasing the run or holding it for a retry).
 */
export const BULK_RUN_MAX_STALLS = 3;

/** A live drain's lease write: the run is handed back (`leaseUntil` null) or held until then, and its stalls start over. */
export function handBack(leaseUntil: number | null): { leaseUntil: number | null; stalls: 0 } {
  return { leaseUntil, stalls: 0 };
}

/** Whether the drain would claim a run (the scheduled drain runs only then). */
export function dueBulkRunProbes(db: Database) {
  return [
    db.select({ id: bulkRuns.id }).from(bulkRuns)
      .where(dueBulkRunCondition(Math.floor(Date.now() / 1000))).limit(1),
  ];
}
