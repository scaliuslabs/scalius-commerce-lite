// The claim of a leased queue row (the event outbox, webhook and app event
// deliveries, the notification outbox). A row whose runner dies alone with
// its attempts at the cap is not run again: the next claim moves it to its
// give-up state, so work that dies every time stops after as many attempts
// as work that fails cleanly, and a row that only shared a dying runner never
// pays for it. Payment events and bulk runs keep their own claims and give up
// with the same reason.
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
 * A claim's id says how the row was taken, so the next claim knows how its
 * runner died without a column of its own (and without touching
 * `last_error`, which keeps the row's real last error): `<base>c_` with other
 * rows (a batch, or a concurrent pass), `<base>r_` with other rows after a
 * lapse, `<base>l_` alone. Finishing writes match the claim's own id.
 */
export function claimIdsOf(base: string, token: string) {
  return { shared: `${base}c_${token}`, retaken: `${base}r_${token}`, lone: `${base}l_${token}` };
}

export function newClaimToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** The row's claim is one of `token`'s ids (the rows of one batch claim carry two of them). */
export function claimedUnder(column: SQLiteColumn, base: string, token: string): SQL {
  const ids = claimIdsOf(base, token);
  return sql`${column} IN (${ids.shared}, ${ids.retaken}, ${ids.lone})`;
}

/** The claim kind letter of a row's claim id (`c`, `r`, `l`), or '' for none. */
function claimKind(column: SQLiteColumn | SQL, base: string): SQL {
  return sql`COALESCE(substr(${column}, ${base.length + 1}, 1), '')`;
}

/**
 * A lapsed row (still `processing`, its lease run out) that keeps dying: it
 * died alone, or died again with other rows after a claim took it back. Only
 * such a row is claimed alone; a first lapse goes back with the rest.
 */
export function keepsDying(column: SQLiteColumn | SQL, base: string): SQL {
  return sql`${claimKind(column, base)} IN ('r', 'l')`;
}

/** `keepsDying` for a claim id already read. */
export function claimKeepsDying(claimId: string | null, base: string): boolean {
  const kind = claimId?.slice(base.length, base.length + 1);
  return kind === "r" || kind === "l";
}

/**
 * The SET of a claim over rows its WHERE already found claimable. The claim
 * counts the attempt when it takes the row, so a runner that dies still used
 * one up, but only its own: a row taken back after a claim with other rows
 * died (`c`, `r`) is given that attempt back, since the death may have been a
 * neighbour's. Only a row whose last claim ran alone (`l`) and died with
 * `maxAttempts` used is not run again: it moves to `giveUp` with
 * `RUNNER_NEVER_FINISHED`, keeping the claim of the attempt it gave up, so
 * that attempt, if it was only slow, can still record its success
 * (`heldOrGivenUp`). The caller tells claimed and given-up rows apart by the
 * status the statement returns, and reads each row's claim id from it.
 * Column references render unqualified, as an UPDATE's own.
 */
export function leasedQueueClaimSet(
  columns: LeasedQueueColumns,
  options: {
    /** The table's claim id prefix (`ev`, `wh`, `pd`, `ono`). */
    base: string;
    token: string;
    /** This claim takes the row by itself: no other row's runner shares its fate. */
    alone: boolean;
    leaseSeconds: number;
    maxAttempts: number;
    giveUp: string;
    /** When the given-up row is next due: never. */
    never: number;
    /** A claimed row's last error is cleared (the notification outbox), else kept. */
    clearError?: boolean;
  },
): Record<keyof LeasedQueueColumns, SQL> {
  const ids = claimIdsOf(options.base, options.token);
  const lapsed = sql`${columns.status} = 'processing'`;
  const diedAlone = sql`(${lapsed} AND ${claimKind(columns.claimId, options.base)} = 'l')`;
  const spent = sql`(${diedAlone} AND ${columns.attempts} >= ${options.maxAttempts})`;
  const either = (gaveUp: SQL, claimed: SQL) => sql`CASE WHEN ${spent} THEN ${gaveUp} ELSE ${claimed} END`;
  return {
    status: either(sql`${options.giveUp}`, sql`'processing'`),
    // A lapse under a shared claim is given back: this attempt replaces it.
    attempts: sql`CASE WHEN ${spent} THEN ${columns.attempts} WHEN ${lapsed} AND NOT ${diedAlone} THEN ${columns.attempts} ELSE ${columns.attempts} + 1 END`,
    claimId: options.alone
      ? either(sql`${columns.claimId}`, sql`${ids.lone}`)
      : sql`CASE WHEN ${spent} THEN ${columns.claimId} WHEN ${lapsed} THEN ${ids.retaken} ELSE ${ids.shared} END`,
    claimExpiresAt: either(sql`NULL`, sql`unixepoch() + ${options.leaseSeconds}`),
    lastError: either(sql`${RUNNER_NEVER_FINISHED}`, options.clearError ? sql`NULL` : sql`${columns.lastError}`),
    nextAttemptAt: either(sql`${options.never}`, sql`${columns.nextAttemptAt}`),
  };
}

/**
 * The row a success write may finish: still held by its claim (`claimed`),
 * or given up while that very attempt was running (the give-up kept its
 * claim). Every other outcome write needs the row still `processing` under
 * its claim.
 */
export function heldOrGivenUp(columns: Pick<LeasedQueueColumns, "status">, claimed: SQL, giveUp: string): SQL {
  return sql`(${claimed} AND ${columns.status} IN ('processing', ${giveUp}))`;
}
