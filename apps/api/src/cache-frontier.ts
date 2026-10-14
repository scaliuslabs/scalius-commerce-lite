/**
 * The API's reads of the dependency-validated cache (DVC) change clock
 * (CACHE-DESIGN §6.2, §6.6, §6.7, §6.10). Each function is one statement, so
 * the clock and the dependency rows come from one snapshot on every provider
 * (D1 and Turso run one statement atomically; PostgreSQL gives a statement
 * one snapshot under READ COMMITTED). Every statement goes through Drizzle's
 * SQLite dialect, which the PostgreSQL adapter compiles (`json_each` included).
 *
 * - `readValidationSnapshot`: the batch's one read (§6.6). The clock, the
 *   pruning floor, the Platform settings row, and every key of the hit
 *   entries whose seq is above the entries' smallest s0. Key lists travel as
 *   one bound JSON value, never as one parameter per key (D1's 100-parameter
 *   limit).
 * - `readFrontierDelta`: the storefront frontier (§6.7).
 * - `checkHashedDependencies`: the frontier slow path; the storefront holds
 *   only key hashes, so the API hashes the rows it scans.
 * - `readCommitSeq`: the clock after an admin write (§6.10).
 *
 * The clock S is the larger of `cache_clock.seq` and the newest `cache_dep`
 * seq. On D1 and Turso the clock row is raised with every change, so both
 * agree. On PostgreSQL `cache_dep` is an insert-only change log (a key may
 * have several rows until the compaction drain removes the older ones) and
 * the clock row is not written: seqs commit in order, so the newest
 * committed seq is the clock. Every reader takes a key's largest seq.
 */
import { sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import {
  CACHE_FRONTIER_KEY_HEADER,
  CACHE_FRONTIER_MAX_CHANGES,
  CACHE_FRONTIER_SECRET_PURPOSE,
  hashCacheDep,
  type CacheFrontierCheck,
  type CacheFrontierDelta,
} from "@scalius/shared/cache-frontier";
import { deriveRuntimeSecret, readMasterSecret } from "@scalius/shared/runtime-secrets";

/** The Platform settings row as stored (`settings` category `platform`, key `document`). */
export interface PlatformSettingsRow {
  readonly value: string;
  readonly revision: number;
}

export interface ValidationSnapshot {
  /** The clock: every commit with seq <= S is visible to any read that starts after this one. */
  readonly S: number;
  readonly floor: number;
  /** Keys of the asked set with seq > since, and their seq. */
  readonly changed: ReadonlyMap<string, number>;
  readonly platform: PlatformSettingsRow | null;
}

const toNumber = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));

/** Zero is a valid initial clock; a missing authority row is not. */
function authoritativeClock(value: unknown): number {
  const clock = Number(value);
  if (value === null || value === undefined || !Number.isSafeInteger(clock) || clock < 0) {
    throw new Error("Cache clock unavailable");
  }
  return clock;
}

/**
 * Rows of a raw `db.all` read as objects: D1 returns objects, the Turso and
 * PostgreSQL proxies may return value arrays in select-list order.
 */
async function namedRows<T extends Record<string, unknown>>(
  rows: Promise<unknown[]>,
  columns: ReadonlyArray<keyof T & string>,
): Promise<T[]> {
  return (await rows).map((row) => (Array.isArray(row)
    ? Object.fromEntries(columns.map((column, index) => [column, row[index]])) as T
    : row as T));
}

/**
 * The clock row as one source `clock` (columns `s`, `floor`): S is null
 * without the row, so a missing authority row never mints a zero proof.
 */
const CLOCK = sql`(
  SELECT CASE WHEN k."m" > c."seq" THEN k."m" ELSE c."seq" END AS s, COALESCE(c."floor", 0) AS floor
  FROM (SELECT 1 AS one) base
  LEFT JOIN "cache_clock" c ON c."id" = 1
  LEFT JOIN (SELECT MAX("seq") AS m FROM "cache_dep") k ON 1 = 1
) clock`;

/** Change rows as (dep, seq), each key once at its largest seq, ascending. */
function latestPerKey(rows: ReadonlyArray<{ dep: unknown; seq: unknown }>): Array<readonly [string, number]> {
  const latest = new Map<string, number>();
  for (const row of rows) {
    if (row.dep === null || row.dep === undefined) continue;
    const dep = String(row.dep);
    const seq = toNumber(row.seq);
    if ((latest.get(dep) ?? -Infinity) < seq) latest.set(dep, seq);
  }
  return [...latest].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * One statement: the clock row, the Platform settings row, and the keys of
 * `deps` changed after `since`. With no keys it is the clock read a render
 * takes its s0 from.
 */
export async function readValidationSnapshot(
  db: Database,
  deps: readonly string[],
  since: number,
): Promise<ValidationSnapshot> {
  const rows = await namedRows<{ s: unknown; floor: unknown; pv: unknown; pr: unknown; dep: unknown; seq: unknown }>(db.all(sql`
    SELECT clock.s AS s, clock.floor AS floor,
      (SELECT st."value" FROM "settings" st WHERE st."category" = 'platform' AND st."key" = 'document') AS pv,
      (SELECT st."revision" FROM "settings" st WHERE st."category" = 'platform' AND st."key" = 'document') AS pr,
      d."dep" AS dep, d."seq" AS seq
    FROM ${CLOCK}
    LEFT JOIN "cache_dep" d
      ON d."seq" > ${since}
      AND d."dep" IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(deps)}))
  `), ["s", "floor", "pv", "pr", "dep", "seq"]);
  const changed = new Map(latestPerKey(rows));
  const first = rows[0]!;
  return {
    S: authoritativeClock(first?.s),
    floor: toNumber(first.floor),
    changed,
    platform: typeof first.pv === "string" ? { value: first.pv, revision: toNumber(first.pr) } : null,
  };
}

/**
 * The frontier answer for `since` (null: a cold frontier): every key changed
 * after the horizon, at its latest seq, up to the clock. It reads the newest
 * `limit + 1` change rows after `since`; when there are more, the oldest row
 * read sets the horizon and only rows above it are listed, so an entry from
 * before the horizon takes the slow path. A key's row is its latest change,
 * so an answer capped at an older seq could miss a key that changed again
 * later; the horizon form never does, and it always reaches the clock.
 */
export async function readFrontierDelta(
  db: Database,
  since: number | null,
  limit: number = CACHE_FRONTIER_MAX_CHANGES,
): Promise<Omit<CacheFrontierDelta, "apiVersion">> {
  const bounded = Math.max(1, Math.min(CACHE_FRONTIER_MAX_CHANGES, Math.floor(limit)));
  const rows = await namedRows<{ s: unknown; floor: unknown; dep: unknown; seq: unknown }>(db.all(sql`
    SELECT clock.s AS s, clock.floor AS floor, d."dep" AS dep, d."seq" AS seq
    FROM ${CLOCK}
    LEFT JOIN (
      SELECT "dep", "seq" FROM "cache_dep" WHERE "seq" > ${since ?? -1} ORDER BY "seq" DESC LIMIT ${bounded + 1}
    ) d ON d."seq" <= clock.s
  `), ["s", "floor", "dep", "seq"]);
  const clock = authoritativeClock(rows[0]?.s);
  const floor = toNumber(rows[0]!.floor);
  const read = rows.filter((row) => row.dep !== null && row.dep !== undefined);
  const base = Math.max(since ?? floor, floor);
  // More rows than the limit: the oldest one read is the first left out.
  const horizon = read.length > bounded
    ? Math.max(base, Math.min(...read.map((row) => toNumber(row.seq))))
    : base;
  const changes = latestPerKey(read)
    .filter(([, seq]) => seq > horizon)
    .map(([dep, seq]) => [hashCacheDep(dep), seq] as const);
  return { S: clock, horizon, floor, clock, changes };
}

/**
 * Rows one slow-path check may scan: one frontier window. An entry older than
 * that many changes is re-rendered instead. The scan is a D1 read of every
 * change since the entry's s0, whatever the entry depends on (the storefront
 * holds only key hashes, so the rows cannot be looked up by key); a render
 * reads a few hundred rows once and gives the page a fresh proof, while a
 * 20,000-row scan per stale page after a bulk write would burn Workers Free's
 * 5M-rows-read day on a handful of pages.
 */
export const FRONTIER_CHECK_MAX_ROWS = CACHE_FRONTIER_MAX_CHANGES;

/**
 * The slow path of a page hit whose s0 is below its frontier's horizon: did
 * any of these hashed keys change after `s0`? Scans the keys changed since
 * `s0` (bounded) and hashes them; beyond the bound the answer is "changed".
 */
export async function checkHashedDependencies(
  db: Database,
  s0: number,
  hashes: readonly string[],
): Promise<Omit<CacheFrontierCheck, "apiVersion">> {
  const rows = await namedRows<{ s: unknown; floor: unknown; dep: unknown }>(db.all(sql`
    SELECT clock.s AS s, clock.floor AS floor, d."dep" AS dep
    FROM ${CLOCK}
    LEFT JOIN (SELECT "dep", "seq" FROM "cache_dep" WHERE "seq" > ${s0} ORDER BY "seq" LIMIT ${FRONTIER_CHECK_MAX_ROWS + 1}) d
      ON d."seq" <= clock.s
  `), ["s", "floor", "dep"]);
  const S = authoritativeClock(rows[0]?.s);
  const floor = toNumber(rows[0]!.floor);
  const scanned = rows.filter((row) => row.dep !== null && row.dep !== undefined);
  if (s0 > S || s0 < floor || scanned.length > FRONTIER_CHECK_MAX_ROWS) return { S, floor, changed: true };
  const wanted = new Set(hashes);
  return { S, floor, changed: scanned.some((row) => wanted.has(hashCacheDep(String(row.dep)))) };
}

/** The clock now; after a committed write it is at least that write's seq. */
export async function readCommitSeq(db: Database): Promise<number> {
  const rows = await namedRows<{ s: unknown }>(db.all(sql`SELECT clock.s AS s FROM ${CLOCK}`), ["s"]);
  return authoritativeClock(rows[0]?.s);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

/**
 * Whether the request carries the storefront's frontier key (HKDF of the
 * master secret, purpose `cache-frontier`). Fails closed without a master
 * secret. Change times are not public.
 */
export async function hasFrontierKey(request: Request, env: { SCALIUS_SECRET?: unknown }): Promise<boolean> {
  const presented = request.headers.get(CACHE_FRONTIER_KEY_HEADER);
  const master = readMasterSecret(env);
  if (!presented || !master) return false;
  return constantTimeEqual(presented, await deriveRuntimeSecret(master, CACHE_FRONTIER_SECRET_PURPOSE));
}
