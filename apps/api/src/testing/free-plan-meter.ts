/**
 * Test-only meter for the Workers Free plan budget (scripts/free-plan-budget.mjs).
 *
 * It wraps the bindings a Worker invocation touches (D1, R2, the Cache API,
 * `fetch`) in counters and records the CPU the invocation spent, its
 * after-response work (`waitUntil`) included. The Free plan limits it
 * measures against:
 *
 * - 10 ms CPU per invocation (HTTP, cron);
 * - 50 external subrequests and 1,000 Cloudflare-service subrequests;
 * - 50 D1 queries (one `batch()` is one query).
 *
 * CPU is `process.cpuUsage()` around the operation minus the CPU the embedded
 * SQLite engine spent inside the D1 shim: on Workers the database runs
 * elsewhere and waiting for it is not CPU. The remainder is V8 work (JS, JSON,
 * crypto, schema validation) which workerd runs on the same engine, so it is a
 * good relative figure (not an absolute production number: see
 * docs/FREE-PLAN.md).
 */
import type { DatabaseSync } from "node:sqlite";

export interface FreePlanCounters {
  /** CPU of the invocation without the embedded database engine, milliseconds. */
  cpuMs: number;
  /** Wall time, milliseconds (includes awaited work). */
  wallMs: number;
  /** D1 round trips: each `all/run/first/raw` and each `batch()` is one. */
  d1Calls: number;
  /** D1 statements executed (every member of a batch counts). */
  d1Statements: number;
  /** Rows changed by writes, triggers' writes included (a lower bound of D1 "rows written": index entries are not counted). */
  d1RowsChanged: number;
  /**
   * Rows read, an estimate (SQLite reports none): the rows each statement returns plus, for every full scan
   * its query plan shows (triggers included), the scanned table's row count. It ignores LIMIT, so it can
   * overstate a capped scan; the scale proof (scripts/scale-proof.mjs) measures D1's own `rows_read`.
   */
  d1RowsRead: number;
  /** Rows the statements returned (exact). */
  d1RowsReturned: number;
  /** Full-table-scan steps in the plans of the executed statements: rows read that grow with the table. */
  d1FullScans: number;
  r2Ops: number;
  /** Cache API `match`/`put`/`delete` calls (each is a subrequest). */
  cacheOps: number;
  /** Calls on other service bindings (EMAIL). */
  serviceCalls: number;
  /** `fetch()` calls to a non-Cloudflare origin (Free: 50 per invocation). */
  externalFetches: number;
  /** `waitUntil` tasks the invocation scheduled (awaited inside the measurement). */
  waitUntilTasks: number;
}

export function emptyCounters(): FreePlanCounters {
  return {
    cpuMs: 0, wallMs: 0, d1Calls: 0, d1Statements: 0, d1RowsChanged: 0, d1RowsRead: 0, d1RowsReturned: 0, d1FullScans: 0,
    r2Ops: 0, cacheOps: 0, serviceCalls: 0, externalFetches: 0, waitUntilTasks: 0,
  };
}

/** Subrequests to Cloudflare services (Free: 1,000): D1, R2, Cache API and other service calls. */
export function internalSubrequests(counters: FreePlanCounters): number {
  return counters.d1Calls + counters.r2Ops + counters.cacheOps + counters.serviceCalls;
}

const cpuMicros = (usage: NodeJS.CpuUsage): number => usage.user + usage.system;

interface EngineClock {
  /** CPU microseconds the embedded SQLite engine spent inside the shim. */
  engineMicros: number;
}

type AnyFn = (...args: unknown[]) => unknown;

// ── D1 ──────────────────────────────────────────────────────────────────────

function timedEngine<T>(clock: EngineClock, run: () => T): T {
  const before = process.cpuUsage();
  try {
    return run();
  } finally {
    clock.engineMicros += cpuMicros(process.cpuUsage(before));
  }
}

function rowsChanged(value: unknown): number {
  const result = value as { meta?: { changes?: number } } | null | undefined;
  return typeof result?.meta?.changes === "number" ? result.meta.changes : 0;
}

/** Rows a result returned: `all/run` results, `raw` arrays, a `first` row. */
function rowsReturned(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const results = (value as { results?: unknown[] } | null | undefined)?.results;
  return Array.isArray(results) ? results.length : value ? 1 : 0;
}

export interface ScanEstimator {
  /** Full scans in the statement's plan and the rows they read (the scanned tables' row counts). */
  estimate(query: string): { scans: number; rows: number };
  /** Forget the row counts (they change as the operations write). */
  reset(): void;
}

/** Reads each statement's `EXPLAIN QUERY PLAN` (cached per SQL text) for `SCAN <table>` steps. */
export function createScanEstimator(sqlite: DatabaseSync): ScanEstimator {
  const plans = new Map<string, string[]>();
  const counts = new Map<string, number>();
  const tables = () => new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
  let known: Set<string> | undefined;
  const scannedTables = (query: string): string[] => {
    let plan = plans.get(query);
    if (plan) return plan;
    plan = [];
    try {
      known ??= tables();
      for (const row of sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as Array<{ detail: string }>) {
        const name = /^SCAN (\S+)/.exec(row.detail)?.[1];
        if (!name || name === "CONSTANT" || name.startsWith("(")) continue;
        // An alias names its table in the SQL (`FROM products p`); a CTE or subquery names none.
        const table = known.has(name) ? name : new RegExp(`\\b(?:from|join)\\s+"?(\\w+)"?\\s+(?:as\\s+)?"?${name}"?(?![\\w"])`, "i").exec(query)?.[1];
        if (table && known.has(table)) plan.push(table);
      }
    } catch {
      // Not plannable (a PRAGMA, a script): no scan to count.
    }
    plans.set(query, plan);
    return plan;
  };
  return {
    estimate(query) {
      const scanned = scannedTables(query);
      let rows = 0;
      for (const table of scanned) {
        let count = counts.get(table);
        if (count === undefined) {
          count = Number((sqlite.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number | bigint }).n);
          counts.set(table, count);
        }
        rows += count;
      }
      return { scans: scanned.length, rows };
    },
    reset: () => counts.clear(),
  };
}

export function meterD1(
  inner: D1Database,
  counters: () => FreePlanCounters,
  clock: EngineClock,
  scan?: ScanEstimator,
): D1Database {
  const read = (query: string | undefined, result: unknown): void => {
    const c = counters();
    const returned = rowsReturned(result);
    c.d1RowsReturned += returned;
    c.d1RowsRead += returned;
    if (!scan || !query) return;
    const { scans, rows } = timedEngine(clock, () => scan.estimate(query));
    c.d1FullScans += scans;
    c.d1RowsRead += rows;
  };
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === "bind") {
        return (...args: unknown[]) => wrapStatement((value as AnyFn).apply(target, args) as D1PreparedStatement);
      }
      if (property === "all" || property === "first" || property === "run" || property === "raw") {
        return (...args: unknown[]) => {
          const c = counters();
          c.d1Calls += 1;
          c.d1Statements += 1;
          const pending = timedEngine(clock, () => (value as AnyFn).apply(target, args)) as Promise<unknown>;
          const query = (target as { query?: string }).query;
          return pending.then((result) => {
            c.d1RowsChanged += rowsChanged(result);
            read(query, result);
            return result;
          });
        };
      }
      return typeof value === "function" ? (value as AnyFn).bind(target) : value;
    },
  });
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (query: string) => wrapStatement(target.prepare(query));
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          const c = counters();
          c.d1Calls += 1;
          c.d1Statements += statements.length;
          const pending = timedEngine(clock, () => target.batch(statements)) as Promise<unknown[]>;
          return pending.then((results) => {
            results.forEach((result, index) => {
              c.d1RowsChanged += rowsChanged(result);
              read((statements[index] as { query?: string } | undefined)?.query, result);
            });
            return results;
          });
        };
      }
      if (property === "exec") {
        return (query: string) => {
          const c = counters();
          c.d1Calls += 1;
          c.d1Statements += 1;
          return timedEngine(clock, () => target.exec(query));
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as AnyFn).bind(target) : value;
    },
  });
}

// ── R2 ──────────────────────────────────────────────────────────────────────

export function meterR2(counters: () => FreePlanCounters): R2Bucket {
  const objects = new Map<string, Uint8Array>();
  const bump = (): void => { counters().r2Ops += 1; };
  const bucket = {
    head: async (key: string) => { bump(); return objects.has(key) ? { key, size: objects.get(key)!.byteLength } : null; },
    get: async (key: string) => {
      bump();
      const bytes = objects.get(key);
      if (!bytes) return null;
      return { key, size: bytes.byteLength, body: new Blob([bytes as BlobPart]).stream(), arrayBuffer: async () => bytes.slice().buffer, httpEtag: '"stub"', writeHttpMetadata: () => undefined };
    },
    put: async (key: string, value: unknown) => {
      bump();
      const bytes = typeof value === "string"
        ? new TextEncoder().encode(value)
        : new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
      objects.set(key, bytes);
      return { key, size: bytes.byteLength };
    },
    delete: async (key: string | string[]) => { bump(); for (const name of Array.isArray(key) ? key : [key]) objects.delete(name); },
    list: async () => { bump(); return { objects: [], truncated: false }; },
    resumeMultipartUpload: (key: string, uploadId: string) => ({ key, uploadId, abort: async () => { bump(); } }),
  };
  return bucket as unknown as R2Bucket;
}

// ── Cache API ───────────────────────────────────────────────────────────────

export interface MeteredCache {
  readonly entries: Map<string, Response>;
  match(key: RequestInfo | URL): Promise<Response | undefined>;
  put(key: RequestInfo | URL, response: Response): Promise<void>;
  delete(key: RequestInfo | URL): Promise<boolean>;
}

export function meterCache(counters: () => FreePlanCounters): MeteredCache {
  const entries = new Map<string, Response>();
  return {
    entries,
    async match(key) { counters().cacheOps += 1; return entries.get(String(key))?.clone(); },
    async put(key, response) { counters().cacheOps += 1; entries.set(String(key), response); },
    async delete(key) { counters().cacheOps += 1; return entries.delete(String(key)); },
  };
}

/** A service binding whose every method call is one subrequest. */
export function meterService<T extends object>(binding: T, counters: () => FreePlanCounters): T {
  return new Proxy(binding, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        counters().serviceCalls += 1;
        return (value as AnyFn).apply(target, args);
      };
    },
  });
}

// ── The meter ───────────────────────────────────────────────────────────────

export interface FreePlanMeter {
  /** Spread into an `Env`: DB, BUCKET and the two rate limiters. */
  readonly bindings: Pick<Env, "DB" | "BUCKET" | "RL_STRICT" | "RL_STANDARD">;
  /** `caches.default` for the duration of every measurement. */
  readonly cache: MeteredCache;
  /**
   * The metered Cache API (`caches.default` and named `caches.open()` caches,
   * such as the settings mirror), installed as `caches` during every
   * measurement. Install it around setup that should warm the same caches.
   */
  readonly caches: { default: MeteredCache; open(name: string): Promise<MeteredCache> };
  /** Wrap a service binding (EMAIL) so each call counts as a subrequest. */
  service<T extends object>(binding: T): T;
  /** An `ExecutionContext` whose `waitUntil` tasks the measurement awaits. */
  readonly ctx: ExecutionContext;
  /** Await the `waitUntil` work of unmetered setup, so it does not run into the next measurement. */
  settle(): Promise<void>;
  /**
   * Run `operation`, await everything it scheduled with `waitUntil`, and
   * return the counters it produced (counters restart for every call).
   */
  measure<T>(operation: () => Promise<T>): Promise<{ value: T; counters: FreePlanCounters }>;
}

export interface CreateFreePlanMeterOptions {
  /** The D1 binding to meter (an in-memory SQLite shim). */
  d1: D1Database;
  /** The database behind `d1`, to count rows changed (`total_changes()`). */
  sqlite?: DatabaseSync;
  /** Answers `fetch()` calls to external origins; defaults to an empty 200 JSON response. */
  fetchImpl?: (input: Request) => Promise<Response> | Response;
}

export function createFreePlanMeter(options: CreateFreePlanMeterOptions): FreePlanMeter {
  let current = emptyCounters();
  const counters = () => current;
  const clock: EngineClock = { engineMicros: 0 };
  const pending: Promise<unknown>[] = [];
  const limiter = { limit: async () => ({ success: true }) };
  const cache = meterCache(counters);
  const named = new Map<string, MeteredCache>();
  const caches = {
    default: cache,
    async open(name: string) {
      let opened = named.get(name);
      if (!opened) named.set(name, opened = meterCache(counters));
      return opened;
    },
  };
  const totalChanges = (): number => {
    if (!options.sqlite) return 0;
    return Number((options.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number | bigint }).n);
  };
  const scan = options.sqlite ? createScanEstimator(options.sqlite) : undefined;
  const bindings = {
    DB: meterD1(options.d1, counters, clock, scan),
    BUCKET: meterR2(counters),
    RL_STRICT: limiter,
    RL_STANDARD: limiter,
  } as unknown as FreePlanMeter["bindings"];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      current.waitUntilTasks += 1;
      pending.push(Promise.resolve(promise).catch(() => undefined));
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;

  return {
    bindings,
    cache,
    caches,
    service: (binding) => meterService(binding, counters),
    ctx,
    async settle() {
      for (let index = 0; index < pending.length; index += 1) await pending[index];
      pending.length = 0;
    },
    async measure<T>(operation: () => Promise<T>) {
      current = emptyCounters();
      clock.engineMicros = 0;
      scan?.reset();
      pending.length = 0;
      const originalFetch = globalThis.fetch;
      const originalCaches = (globalThis as { caches?: unknown }).caches;
      (globalThis as { caches?: unknown }).caches = caches;
      const answer = options.fetchImpl ?? (() => Response.json({}));
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        current.externalFetches += 1;
        return answer(new Request(input, init));
      }) as typeof fetch;
      const changesBefore = totalChanges();
      const cpuStart = process.cpuUsage();
      const wallStart = performance.now();
      try {
        const value = await operation();
        // Post-response work (`waitUntil`) belongs to the same invocation.
        for (let index = 0; index < pending.length; index += 1) await pending[index];
        const cpuTotal = cpuMicros(process.cpuUsage(cpuStart));
        current.cpuMs = Math.max(0, (cpuTotal - clock.engineMicros) / 1000);
        current.wallMs = performance.now() - wallStart;
        current.d1RowsChanged = totalChanges() - changesBefore;
        return { value, counters: current };
      } finally {
        globalThis.fetch = originalFetch;
        (globalThis as { caches?: unknown }).caches = originalCaches;
      }
    },
  };
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
