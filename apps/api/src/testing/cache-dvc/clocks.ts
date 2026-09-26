/**
 * The change clock the validator reads: `cache_clock` (one monotonic `seq`)
 * and `cache_dep` (the latest `seq` per dependency key).
 *
 * - `TriggerClock` reads the real tables S1's generated triggers maintain.
 *   This is the clock that ships.
 * - `ReferenceClock` derives the same state from the harness row log and the
 *   reference oracle, so the harness runs (and proves itself) before S1's
 *   triggers exist, and can cross-check them after.
 *
 * Both answer through `DvcClock`; the validator never knows which it has.
 */
import type { DatabaseSync } from "node:sqlite";
import { ReferenceOracle } from "./reference-oracle";
import type { LoggedChange, RowLog } from "./row-log";

export interface ClockDelta {
  /** Clock value the delta is complete up to. */
  readonly S: number;
  /** Every key with `since < seq <= S`, latest seq each (possibly capped: see `complete`). */
  readonly changes: ReadonlyArray<readonly [string, number]>;
  /** Oldest seq the store still remembers; entries rendered before it are invalid. */
  readonly floor: number;
}

export interface DvcClock {
  readonly name: "reference" | "triggers";
  /** Current clock value (every committed change has seq <= it). */
  current(): Promise<number>;
  /** Latest seq of each of `deps` whose seq is greater than `since`, read atomically with the clock. */
  changedSince(deps: readonly string[], since: number): Promise<{ S: number; changed: Map<string, number>; floor: number }>;
  /**
   * The frontier read (§6.7): keys changed after `since`, oldest first, at
   * most `limit`. When capped, `S` is lowered to the last complete seq, so
   * the delta never claims more than it holds; when one seq alone exceeds the
   * limit, the delta carries no changes and a horizon at that seq. With
   * `since === null` the newest `limit` keys and a matching horizon are
   * returned instead. The delta is complete for `(horizon, S]`.
   */
  frontierDelta(since: number | null, limit: number): Promise<ClockDelta & { horizon: number }>;
}

// ---------------------------------------------------------------------------

export class ReferenceClock implements DvcClock {
  readonly name = "reference" as const;
  private seq = 0;
  private readonly deps = new Map<string, number>();
  private readonly oracle: ReferenceOracle;
  /** Keys advanced per clock tick, for the trigger cross-check and reports. */
  readonly history: Array<{ seq: number; keys: string[]; changes: LoggedChange[] }> = [];
  historyLimit = 64;

  constructor(sqlite: DatabaseSync, private readonly log: RowLog) {
    this.oracle = new ReferenceOracle(sqlite);
  }

  /** Assign one new seq to everything committed since the last sync. */
  sync(): number {
    const changes = this.log.drain();
    if (changes.length === 0) return this.seq;
    const keys = new Set<string>();
    for (const change of changes) for (const key of this.oracle.keysFor(change)) keys.add(key);
    if (keys.size === 0) return this.seq;
    this.seq += 1;
    for (const key of keys) this.deps.set(key, this.seq);
    this.history.push({ seq: this.seq, keys: [...keys].sort(), changes });
    if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
    return this.seq;
  }

  /** Keys the oracle derives for these changes (no clock effect). */
  keysFor(changes: readonly LoggedChange[]): Set<string> {
    const keys = new Set<string>();
    for (const change of changes) for (const key of this.oracle.keysFor(change)) keys.add(key);
    return keys;
  }

  async current(): Promise<number> {
    return this.sync();
  }

  async changedSince(deps: readonly string[], since: number) {
    const S = this.sync();
    const changed = new Map<string, number>();
    for (const dep of deps) {
      const seq = this.deps.get(dep);
      if (seq !== undefined && seq > since) changed.set(dep, seq);
    }
    return { S, changed, floor: 0 };
  }

  async frontierDelta(since: number | null, limit: number) {
    const S = this.sync();
    const all = [...this.deps.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    return frontierSlice(all, S, since, limit, 0);
  }
}

/** Shared frontier slicing over (dep, seq) rows sorted by seq ascending. */
export function frontierSlice(
  sortedAscending: ReadonlyArray<readonly [string, number]>,
  S: number,
  since: number | null,
  limit: number,
  floor: number,
): ClockDelta & { horizon: number } {
  if (since === null) {
    const newest = sortedAscending.slice(-limit);
    const dropped = sortedAscending.length - newest.length;
    // Everything with seq > horizon is included; ties at the cut move the horizon up.
    let horizon = dropped > 0 ? sortedAscending[dropped - 1]![1] : floor;
    const kept = newest.filter(([, seq]) => seq > horizon);
    horizon = Math.max(horizon, floor);
    return { S, changes: kept, floor, horizon };
  }
  const after = sortedAscending.filter(([, seq]) => seq > since);
  if (after.length <= limit) return { S, changes: after, floor, horizon: since };
  // Capped: complete only up to the last seq fully inside the limit.
  const cutSeq = after[limit]![1];
  const complete = after.filter(([, seq]) => seq < cutSeq);
  if (complete.length === 0) {
    // One seq holds more keys than the limit (a bulk write): the delta cannot
    // enumerate it, so it advances by declaring a horizon instead. Entries
    // rendered before it take the slow path; progress is never blocked.
    return { S: cutSeq, changes: [], floor, horizon: cutSeq };
  }
  return { S: cutSeq - 1, changes: complete, floor, horizon: since };
}

// ---------------------------------------------------------------------------

/** Minimal async SQL surface so one TriggerClock serves SQLite and PostgreSQL. */
export interface ClockSql {
  all<T>(sql: string, params: readonly unknown[]): Promise<T[]>;
  readonly dialect: "sqlite" | "postgres";
}

export function sqliteClockSql(sqlite: DatabaseSync): ClockSql {
  return {
    dialect: "sqlite",
    async all<T>(sql: string, params: readonly unknown[]) {
      return sqlite.prepare(sql).all(...(params as never[])) as T[];
    },
  };
}

/** Whether S1's clock tables exist in this SQLite database. */
export function hasTriggerClock(sqlite: DatabaseSync): boolean {
  const rows = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('cache_clock', 'cache_dep')",
  ).all() as Array<{ name: string }>;
  return rows.length === 2;
}

export class TriggerClock implements DvcClock {
  readonly name = "triggers" as const;
  private floorColumn: string | null | undefined;

  constructor(private readonly sql: ClockSql) {}

  private param(index: number): string {
    return this.sql.dialect === "postgres" ? `$${index}` : "?";
  }

  private async floorExpression(): Promise<string> {
    if (this.floorColumn === undefined) {
      const columns = this.sql.dialect === "postgres"
        ? await this.sql.all<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'cache_clock'", [])
        : await this.sql.all<{ name: string }>("SELECT name FROM pragma_table_info('cache_clock')", []);
      const names = new Set(columns.map((column) => column.name));
      this.floorColumn = names.has("floor") ? "floor" : names.has("floor_seq") ? "floor_seq" : null;
    }
    return this.floorColumn ? `"${this.floorColumn}"` : "0";
  }

  async current(): Promise<number> {
    const rows = await this.sql.all<{ seq: number | string }>("SELECT seq FROM cache_clock WHERE id = 1", []);
    return Number(rows[0]?.seq ?? 0);
  }

  async changedSince(deps: readonly string[], since: number) {
    const floor = await this.floorExpression();
    const json = this.sql.dialect === "postgres"
      ? `SELECT jsonb_array_elements_text(${this.param(2)}::jsonb)`
      : `SELECT value FROM json_each(${this.param(2)})`;
    // One statement: the clock and the key seqs come from one snapshot.
    const rows = await this.sql.all<{ dep: string | null; seq: number | string; s: number | string; floor: number | string }>(
      `SELECT d.dep AS dep, d.seq AS seq, c.seq AS s, ${floor === "0" ? "0" : `c.${floor}`} AS floor
         FROM cache_clock c LEFT JOIN cache_dep d ON d.seq > ${this.param(1)} AND d.dep IN (${json})
        WHERE c.id = 1`,
      [since, JSON.stringify(deps)],
    );
    const changed = new Map<string, number>();
    let S = 0;
    let floorValue = 0;
    for (const row of rows) {
      S = Number(row.s);
      floorValue = Number(row.floor);
      if (row.dep !== null) changed.set(row.dep, Number(row.seq));
    }
    return { S, changed, floor: floorValue };
  }

  async frontierDelta(since: number | null, limit: number) {
    const S = await this.current();
    const rows = since === null
      ? await this.sql.all<{ dep: string; seq: number | string }>(
        `SELECT dep, seq FROM cache_dep WHERE seq <= ${this.param(1)} ORDER BY seq DESC LIMIT ${this.param(2)}`, [S, limit + 1])
      : await this.sql.all<{ dep: string; seq: number | string }>(
        `SELECT dep, seq FROM cache_dep WHERE seq > ${this.param(1)} AND seq <= ${this.param(2)} ORDER BY seq LIMIT ${this.param(3)}`, [since, S, limit + 1]);
    const ascending = rows.map((row) => [row.dep, Number(row.seq)] as const).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    if (since === null) {
      // `limit + 1` newest rows: the extra one sets the horizon.
      const dropped = ascending.length > limit ? [ascending[0]!] : [];
      return frontierSlice([...dropped, ...ascending.slice(dropped.length)], S, null, limit, 0);
    }
    return frontierSlice(ascending, S, since, limit, 0);
  }
}
