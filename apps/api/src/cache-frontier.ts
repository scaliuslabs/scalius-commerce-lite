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
    SELECT c."seq" AS s, c."floor" AS floor,
      (SELECT st."value" FROM "settings" st WHERE st."category" = 'platform' AND st."key" = 'document') AS pv,
      (SELECT st."revision" FROM "settings" st WHERE st."category" = 'platform' AND st."key" = 'document') AS pr,
      d."dep" AS dep, d."seq" AS seq
    FROM "cache_clock" c
    LEFT JOIN "cache_dep" d
      ON d."seq" > ${since}
      AND d."dep" IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(deps)}))
    WHERE c."id" = 1
  `), ["s", "floor", "pv", "pr", "dep", "seq"]);
  if (rows.length === 0) throw new Error("cache_clock row is missing");
  const changed = new Map<string, number>();
  for (const row of rows) {
    if (row.dep !== null && row.dep !== undefined) changed.set(String(row.dep), toNumber(row.seq));
  }
  const first = rows[0]!;
  return {
    S: toNumber(first.s),
    floor: toNumber(first.floor),
    changed,
    platform: typeof first.pv === "string" ? { value: first.pv, revision: toNumber(first.pr) } : null,
  };
}

/**
 * The frontier answer for `since` (null: a cold frontier, newest `limit`
 * keys). At most `limit` changes; a capped answer is complete only up to the
 * last seq it holds in full, and a seq holding more keys than `limit` is
 * skipped by declaring a horizon at it, so progress never stalls.
 */
export async function readFrontierDelta(
  db: Database,
  since: number | null,
  limit: number = CACHE_FRONTIER_MAX_CHANGES,
): Promise<CacheFrontierDelta> {
  const bounded = Math.max(1, Math.min(CACHE_FRONTIER_MAX_CHANGES, Math.floor(limit)));
  const window = since === null
    ? sql`SELECT "dep", "seq" FROM "cache_dep" ORDER BY "seq" DESC LIMIT ${bounded + 1}`
    : sql`SELECT "dep", "seq" FROM "cache_dep" WHERE "seq" > ${since} ORDER BY "seq" LIMIT ${bounded + 1}`;
  const rows = await namedRows<{ s: unknown; floor: unknown; dep: unknown; seq: unknown }>(db.all(sql`
    SELECT c."seq" AS s, c."floor" AS floor, d."dep" AS dep, d."seq" AS seq
    FROM "cache_clock" c
    LEFT JOIN (${window}) d ON d."seq" <= c."seq"
    WHERE c."id" = 1
  `), ["s", "floor", "dep", "seq"]);
  if (rows.length === 0) throw new Error("cache_clock row is missing");
  const clock = toNumber(rows[0]!.s);
  const floor = toNumber(rows[0]!.floor);
  const ascending = rows
    .filter((row) => row.dep !== null && row.dep !== undefined)
    .map((row) => [String(row.dep), toNumber(row.seq)] as const)
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const hashed = (list: ReadonlyArray<readonly [string, number]>) =>
    list.map(([dep, seq]) => [hashCacheDep(dep), seq] as const);

  if (since === null) {
    if (ascending.length <= bounded) {
      return { S: clock, horizon: floor, floor, clock, changes: hashed(ascending) };
    }
    // The oldest row fetched is the first one left out: everything above it is included.
    const horizon = Math.max(ascending[0]![1], floor);
    return { S: clock, horizon, floor, clock, changes: hashed(ascending.slice(1).filter(([, seq]) => seq > horizon)) };
  }
  const base = Math.max(since, floor);
  if (ascending.length <= bounded) {
    return { S: clock, horizon: base, floor, clock, changes: hashed(ascending) };
  }
  // Capped: rows at the cut seq may continue past the limit.
  const cutSeq = ascending[bounded]![1];
  const complete = ascending.filter(([, seq]) => seq < cutSeq);
  if (complete.length === 0) {
    return { S: cutSeq, horizon: cutSeq, floor, clock, changes: [] };
  }
  return { S: cutSeq - 1, horizon: base, floor, clock, changes: hashed(complete) };
}

/** Rows one slow-path check may scan; an entry older than this many changes is re-rendered. */
export const FRONTIER_CHECK_MAX_ROWS = 20_000;

/**
 * The slow path of a page hit whose s0 is below its frontier's horizon: did
 * any of these hashed keys change after `s0`? Scans the keys changed since
 * `s0` (bounded) and hashes them; beyond the bound the answer is "changed".
 */
export async function checkHashedDependencies(
  db: Database,
  s0: number,
  hashes: readonly string[],
): Promise<CacheFrontierCheck> {
  const rows = await namedRows<{ s: unknown; floor: unknown; dep: unknown }>(db.all(sql`
    SELECT c."seq" AS s, c."floor" AS floor, d."dep" AS dep
    FROM "cache_clock" c
    LEFT JOIN (SELECT "dep", "seq" FROM "cache_dep" WHERE "seq" > ${s0} ORDER BY "seq" LIMIT ${FRONTIER_CHECK_MAX_ROWS + 1}) d
      ON d."seq" <= c."seq"
    WHERE c."id" = 1
  `), ["s", "floor", "dep"]);
  if (rows.length === 0) throw new Error("cache_clock row is missing");
  const S = toNumber(rows[0]!.s);
  const floor = toNumber(rows[0]!.floor);
  const scanned = rows.filter((row) => row.dep !== null && row.dep !== undefined);
  if (s0 < floor || scanned.length > FRONTIER_CHECK_MAX_ROWS) return { S, floor, changed: true };
  const wanted = new Set(hashes);
  return { S, floor, changed: scanned.some((row) => wanted.has(hashCacheDep(String(row.dep)))) };
}

/** The clock now; after a committed write it is at least that write's seq. */
export async function readCommitSeq(db: Database): Promise<number> {
  const rows = await namedRows<{ s: unknown }>(db.all(sql`SELECT "seq" AS s FROM "cache_clock" WHERE "id" = 1`), ["s"]);
  return toNumber(rows[0]?.s);
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
