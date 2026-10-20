// Which bulk runs a drain may take: running, with no live lease. Apart from
// the engine so the every-minute cron can ask without loading it.
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { bulkRuns } from "@scalius/database/schema";

export function dueBulkRunCondition(nowSeconds: number) {
  return and(eq(bulkRuns.status, "running"), or(isNull(bulkRuns.leaseUntil), lt(bulkRuns.leaseUntil, nowSeconds)));
}

/** Whether the drain would claim a run (the scheduled drain runs only then). */
export function dueBulkRunProbes(db: Database) {
  return [
    db.select({ id: bulkRuns.id }).from(bulkRuns)
      .where(dueBulkRunCondition(Math.floor(Date.now() / 1000))).limit(1),
  ];
}
