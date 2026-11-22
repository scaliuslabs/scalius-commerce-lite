// The one machine of every leased-work table (rules/platform/one-outbox-kernel.md).
// A row waits, runs under a claim and a lease, and ends done, retries after
// a backoff, is given up, or is cancelled. A queue declares only how it
// differs (its names for these states, lease, attempt cap, backoff, error
// bound, and which optional moves it has); every statement that moves a row
// is built here from that declaration, so two queues cannot claim, finish,
// fail or prune differently. Domain rules (an endpoint's lane, an app's
// in-flight cap, Retry-After) stay with the queue's caller, as row conditions
// and extra columns of these statements.
import type { Database } from "@scalius/database/client";
import { and, eq, gte, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable, SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { defineMachine, type Machine } from "@scalius/shared/machine";
import { claimedUnder, leasedQueueClaimSet, type LeasedQueueColumns } from "./queue-claim";

/** When a row that is never tried again is next due (9999-12-31). */
export const NEVER_DUE = 253_402_300_799;

/** What a queued row can be, whatever its table calls it. */
export type QueueRole = "waiting" | "running" | "retrying" | "done" | "givenUp" | "cancelled";

/**
 * The moves of every queue, on its roles. A move a queue does not declare
 * (no `cancelled` state, no staff retry) is not in its machine.
 */
export const QUEUE_MOVES = {
  /** A due row, or one whose lease lapsed, is taken under a new claim. */
  claim: { from: ["waiting", "retrying", "running"], to: "running" },
  /** The claim of a lapsed row that died alone with its attempts used gives it up instead (queue-claim.ts). */
  abandon: { from: ["running"], to: "givenUp" },
  /** The claim's attempt worked; also the late success of the attempt an `abandon` overtook (it kept its claim). */
  finish: { from: ["running", "givenUp"], to: "done" },
  /** The claim's attempt failed with attempts left: due again after the backoff. */
  fail: { from: ["running"], to: "retrying" },
  /** The claim's last attempt failed, or a failure no retry can fix. */
  giveUp: { from: ["running"], to: "givenUp" },
  /** The work is moot (its subscriber is gone): by its claim, or while it waits. */
  cancel: { from: ["running", "waiting", "retrying"], to: "cancelled" },
  /** The platform, not the work, was not ready: the attempt is given back and it retries. */
  release: { from: ["running"], to: "retrying" },
  /** The attempt is given back and the row waits with no next attempt until released. */
  hold: { from: ["running"], to: "waiting" },
  /** A producer records the same work again before it runs: due again, its attempts kept. */
  requeue: { from: ["waiting", "retrying"], to: "waiting" },
  /** Staff start a stopped row's retries over. */
  retry: { from: ["retrying", "givenUp", "cancelled"], to: "waiting" },
} as const satisfies Record<string, { from: readonly QueueRole[]; to: QueueRole }>;

export type QueueMove = keyof typeof QUEUE_MOVES;

/** The moves that need a declared option, and the option. */
const OPTIONAL_MOVES: Partial<Record<QueueMove, keyof QueueOptions>> = {
  cancel: "cancels",
  release: "releases",
  hold: "holds",
  requeue: "requeues",
  retry: "staffRetry",
};

interface QueueOptions {
  /** Moot work is cancelled (needs a `cancelled` state). */
  cancels?: boolean;
  /** A claimed row can be given back to retry without using an attempt. */
  releases?: boolean;
  /** A claimed row can be given back to wait with no next attempt. */
  holds?: boolean;
  /** A producer may record a waiting row again. */
  requeues?: boolean;
  /** Staff may start a stopped row over. */
  staffRetry?: boolean;
}

export interface QueueDeclaration<S extends string> extends QueueOptions {
  /** What a refusal calls the row. */
  name: string;
  /** The table's stored name for each role. */
  states: { waiting: S; running: S; retrying: S; done: S; givenUp: S; cancelled?: S };
  /** The claim id prefix (queue-claim.ts `claimIdsOf`). */
  base: string;
  leaseSeconds: number;
  /** Attempts a row may use; the claim counts one when it takes the row. */
  maxAttempts: number;
  /** The wait after attempt n (1-based) fails; the last repeats. */
  backoff: readonly number[];
  /** The set key of the column a done row records its time in. */
  doneAt: string;
  /** Longest stored error. */
  errorLength: number;
  /** Rewrites an error before it is stored (masking). */
  describeError?: (text: string) => string;
  /** What a row that used its last attempt gives up with, before its error. */
  capReason?: string;
  /** A claim clears the row's last error; otherwise it keeps it. */
  clearErrorOnClaim?: boolean;
}

type QueueTable = SQLiteTable & LeasedQueueColumns & { updatedAt: SQLiteColumn };
type Columns = Record<string, unknown>;

const NOW = sql`unixepoch()`;

export function leasedQueue<T extends QueueTable, S extends string>(table: T, declaration: QueueDeclaration<S>) {
  const { states } = declaration;
  const moves = Object.fromEntries(Object.entries(QUEUE_MOVES).flatMap(([move, { from, to }]) => {
    const option = OPTIONAL_MOVES[move as QueueMove];
    if (option && !declaration[option]) return [];
    // A role the queue does not have (no `cancelled`) is no source; a move to one is no move.
    const sources = from.flatMap((role) => states[role] ?? []);
    return states[to] && sources.length > 0 ? [[move, { from: sources, to: states[to] }]] : [];
  })) as Partial<Record<QueueMove, { from: S[]; to: S }>>;
  const declared = Object.values(states).filter((state): state is S => state !== undefined);
  const machine: Machine<S> = defineMachine<S, typeof moves>({
    name: declaration.name,
    states: declared,
    initial: [states.waiting],
    // A state no declared move leaves: `done`, and `cancelled` when staff cannot retry it.
    final: declared.filter((state) => !Object.values(moves).some((move) => move!.to !== state && move!.from.includes(state))),
    moves,
  });

  const move = (name: QueueMove) => {
    const found = moves[name];
    if (!found) throw new Error(`The ${declaration.name} queue has no "${name}" move.`);
    return found;
  };
  /** The update of one move: it changes only rows still in one of its source states. */
  const write = (db: Database, name: QueueMove, where: SQL | undefined, set: Columns) => {
    const { from, to } = move(name);
    return db.update(table)
      // A claim's own status decides between running and given up.
      .set({ status: to, ...set, updatedAt: NOW } as SQLiteUpdateSetSource<T>)
      // A claim's due test names its states inside a CASE (see `claim`).
      .where(name === "claim" ? where : and(inArray(table.status, from), where));
  };
  const error = (value: unknown): string => {
    const text = value instanceof Error ? value.message : String(value);
    const described = declaration.describeError ? declaration.describeError(text) : text;
    return described.length > declaration.errorLength ? `${described.slice(0, declaration.errorLength - 1)}…` : described;
  };
  const retryDelaySeconds = (attempts: number) =>
    declaration.backoff[Math.max(1, Math.min(attempts, declaration.backoff.length)) - 1]!;
  const ended = { claimId: null, claimExpiresAt: null };
  /** The row while the claim `claim` still holds it (a claim condition: `heldBy`, `heldByToken`). */
  const held = (row: SQL | undefined, claim: SQL) => and(row, claim);
  const dueBranches = (): [SQL, SQL] => [
    and(inArray(table.status, [states.waiting, states.retrying]), lte(table.nextAttemptAt, NOW))!,
    and(eq(table.status, states.running), lte(table.claimExpiresAt, NOW))!,
  ];

  return {
    ...declaration,
    table,
    machine,
    retryDelaySeconds,
    error,
    /** The stored names of `roles`. */
    statuses: (...roles: QueueRole[]) => roles.map((role) => states[role]).filter((state): state is S => state !== undefined),
    /** A row the claim `claimId` holds. */
    heldBy: (claimId: string) => eq(table.claimId, claimId),
    /** A row one of a batch claim's ids holds. */
    heldByToken: (token: string) => claimedUnder(table.claimId, declaration.base, token),
    /** The due rows, each one index range: waiting or retrying past its time, and a lapsed lease. */
    dueBranches,
    /**
     * Claims the due rows `which` selects. As a CASE the due test is no
     * index's range, so SQLite seeks the chosen rows by key. A row whose
     * runner died alone with its attempts used comes back `givenUp` instead
     * (`RUNNER_NEVER_FINISHED`); its claim id is in the returned row.
     */
    claim(db: Database, which: SQL, options: { token: string; alone: boolean }) {
      const [due, lapsed] = dueBranches();
      return write(db, "claim", and(which, sql`(CASE WHEN ${or(due, lapsed)} THEN 1 ELSE 0 END) = 1`), leasedQueueClaimSet(table, {
        base: declaration.base,
        token: options.token,
        alone: options.alone,
        leaseSeconds: declaration.leaseSeconds,
        maxAttempts: declaration.maxAttempts,
        giveUp: states.givenUp,
        never: NEVER_DUE,
        clearError: declaration.clearErrorOnClaim,
      }));
    },
    finish: (db: Database, row: SQL | undefined, claim: SQL, set: Columns = {}) =>
      write(db, "finish", held(row, claim), { ...ended, lastError: null, [declaration.doneAt]: NOW, ...set }),
    /**
     * Records a failed attempt: retried after the backoff (or `notBefore`
     * seconds, when longer), or given up when it was the last attempt or
     * `terminal`.
     */
    fail(db: Database, row: SQL | undefined, claim: SQL, attempts: number, failure: unknown, options: { notBefore?: number | null; terminal?: boolean; set?: Columns } = {}) {
      const gaveUp = options.terminal === true || attempts >= declaration.maxAttempts;
      const retryInSeconds = gaveUp ? null : Math.max(retryDelaySeconds(attempts), options.notBefore ?? 0);
      const message = failure === null ? null : failure instanceof Error ? failure.message : String(failure);
      const cap = gaveUp && !options.terminal ? declaration.capReason : undefined;
      const statement = write(db, gaveUp ? "giveUp" : "fail", held(row, claim), {
        ...ended,
        lastError: message === null ? null : error(cap ? (message.trim() ? `${cap}: ${message}` : cap) : message),
        nextAttemptAt: gaveUp ? NEVER_DUE : sql`unixepoch() + ${retryInSeconds}`,
        ...options.set,
      });
      return { statement, gaveUp, retryInSeconds };
    },
    giveUp: (db: Database, row: SQL | undefined, claim: SQL, reason: unknown) =>
      write(db, "giveUp", held(row, claim), { ...ended, lastError: error(reason), nextAttemptAt: NEVER_DUE }),
    /** Cancels a row by its claim, or (no claim) rows still waiting. */
    cancel(db: Database, row: SQL | undefined, reason: unknown, claim?: SQL) {
      const where = claim ? and(held(row, claim), eq(table.status, states.running)) : and(row, inArray(table.status, [states.waiting, states.retrying]));
      return write(db, "cancel", where, { ...ended, lastError: error(reason), nextAttemptAt: NEVER_DUE });
    },
    /** Gives the claim's attempt back: due again in `delaySeconds`, or held with no next attempt (`null`). */
    release(db: Database, row: SQL | undefined, claim: SQL, reason: unknown, delaySeconds: number | null) {
      return write(db, delaySeconds === null ? "hold" : "release", held(row, claim), {
        ...ended,
        attempts: sql`CASE WHEN ${table.attempts} > 0 THEN ${table.attempts} - 1 ELSE 0 END`,
        lastError: error(reason),
        nextAttemptAt: delaySeconds === null ? NEVER_DUE : sql`unixepoch() + ${Math.max(1, Math.round(delaySeconds))}`,
      });
    },
    requeue: (db: Database, row: SQL | undefined, set: Columns) => write(db, "requeue", row, { lastError: null, ...set }),
    /** Staff start a stopped row over: no attempts used, due now. */
    retry: (db: Database, row: SQL | undefined) =>
      write(db, "retry", row, { ...ended, attempts: 0, nextAttemptAt: NOW, lastError: null }),
    /**
     * Rows a prune may delete: settled ones only (done, given up, cancelled,
     * or failed with no next attempt), never one that is still retried.
     */
    settled: () => or(
      inArray(table.status, [states.done, states.givenUp, ...(states.cancelled ? [states.cancelled] : [])]),
      and(eq(table.status, states.retrying), gte(table.nextAttemptAt, NEVER_DUE)),
    )!,
  };
}

export type LeasedQueue = ReturnType<typeof leasedQueue>;
