// The claim of a leased queue row (the event outbox, webhook and app event
// deliveries, the notification outbox). A claim counts the attempt when it
// takes the row, so an attempt whose runner dies (a Worker killed for CPU or
// subrequests) still used one up. A row whose lease ran out with its
// attempts already at the cap is not run again: the same claim statement
// moves it to its give-up state, so work that dies every time stops after
// as many attempts as work that fails cleanly. Payment events and bulk runs
// keep their own claims and give up with the same reason.
import { sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

/** Why a row gave up when no attempt of it ever recorded an outcome. */
export const RUNNER_NEVER_FINISHED = "runner_never_finished";

/** The leased-queue columns every such table names the same way. */
export interface LeasedQueueColumns {
  status: SQLiteColumn;
  attempts: SQLiteColumn;
  claimId: SQLiteColumn;
  claimExpiresAt: SQLiteColumn;
  lastError: SQLiteColumn;
  nextAttemptAt: SQLiteColumn;
}

/**
 * The SET of a claim over rows its WHERE already found claimable: each row
 * is claimed for one more attempt, or, when it is still `processing` (its
 * lease ran out) with `maxAttempts` used, moved to `giveUp` with
 * `RUNNER_NEVER_FINISHED`. The caller tells them apart by the status the
 * statement returns. Column references render unqualified, as an UPDATE's own.
 */
export function leasedQueueClaimSet(
  columns: LeasedQueueColumns,
  options: {
    claimId: string;
    leaseSeconds: number;
    maxAttempts: number;
    giveUp: string;
    /** When the given-up row is next due: never. */
    never: number;
    /** A claimed row's last error is cleared (the notification outbox), else kept. */
    clearError?: boolean;
  },
): Record<keyof LeasedQueueColumns, SQL> {
  const spent = sql`(${columns.status} = 'processing' AND ${columns.attempts} >= ${options.maxAttempts})`;
  const either = (gaveUp: SQL, claimed: SQL) => sql`CASE WHEN ${spent} THEN ${gaveUp} ELSE ${claimed} END`;
  return {
    status: either(sql`${options.giveUp}`, sql`'processing'`),
    attempts: either(sql`${columns.attempts}`, sql`${columns.attempts} + 1`),
    claimId: either(sql`NULL`, sql`${options.claimId}`),
    claimExpiresAt: either(sql`NULL`, sql`unixepoch() + ${options.leaseSeconds}`),
    lastError: either(sql`${RUNNER_NEVER_FINISHED}`, options.clearError ? sql`NULL` : sql`${columns.lastError}`),
    nextAttemptAt: either(sql`${options.never}`, sql`${columns.nextAttemptAt}`),
  };
}
