/**
 * Test-only meter for the Workers Free plan budget (scripts/free-plan-budget.mjs).
 *
 * It wraps the bindings a Worker invocation touches (D1, R2, the jobs
 * queue, `fetch`) in counters and records the CPU the invocation spent. The
 * Free plan limits it measures against:
 *
 * - 10 ms CPU per invocation (HTTP, queue consumer, cron);
 * - 50 external subrequests and 1,000 Cloudflare-service subrequests;
 * - 50 D1 queries (one `batch()` is one query);
 * - 10,000 Queues operations per day (a message is a write, a read and a delete).
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
  /** Rows changed by writes (a lower bound of D1 "rows written": index writes are not counted). */
  d1RowsChanged: number;
  r2Ops: number;
  /** Cache API `match`/`put`/`delete` calls (each is a subrequest). */
  cacheOps: number;
  /** Calls on other service bindings (EMAIL, IMAGES, Queue `metrics()`). */
  serviceCalls: number;
  /** `JOBS_QUEUE.send/sendBatch` calls and the messages they carried. */
  queueCalls: number;
  queueMessages: number;
  queueTypes: Record<string, number>;
  /** `fetch()` calls to a non-Cloudflare origin (Free: 50 per invocation). */
  externalFetches: number;
  /** `waitUntil` tasks the invocation scheduled (awaited inside the measurement). */
  waitUntilTasks: number;
}

export function emptyCounters(): FreePlanCounters {
  return {
    cpuMs: 0, wallMs: 0, d1Calls: 0, d1Statements: 0, d1RowsChanged: 0,
    r2Ops: 0, cacheOps: 0, serviceCalls: 0,
    queueCalls: 0, queueMessages: 0, queueTypes: {}, externalFetches: 0, waitUntilTasks: 0,
  };
}

/** Subrequests to Cloudflare services (Free: 1,000): D1, R2, Cache API and Queues calls. */
export function internalSubrequests(counters: FreePlanCounters): number {
  return counters.d1Calls + counters.r2Ops + counters.cacheOps + counters.serviceCalls + counters.queueCalls;
}

/** Queues operations (Free: 10,000 per day): write, read and delete of every message. */
export function queueOperations(counters: FreePlanCounters): number {
  return counters.queueMessages * 3;
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

export function meterD1(
  inner: D1Database,
  counters: () => FreePlanCounters,
  clock: EngineClock,
): D1Database {
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
          return pending.then((result) => {
            c.d1RowsChanged += rowsChanged(result);
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
            for (const result of results) c.d1RowsChanged += rowsChanged(result);
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

// ── Queue ───────────────────────────────────────────────────────────────────

export interface MeteredQueue {
  readonly sent: Array<{ body: unknown; delaySeconds?: number }>;
  /** What `metrics()` reports as `backlogCount`; tests set it to model a busy queue. */
  backlogCount: number;
  metrics(): Promise<{ backlogCount: number; backlogBytes: number; oldestMessageTimestamp: number }>;
  send(body: unknown, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(messages: Iterable<{ body: unknown; delaySeconds?: number }>, options?: { delaySeconds?: number }): Promise<void>;
}

export function meterQueue(counters: () => FreePlanCounters): MeteredQueue {
  const sent: MeteredQueue["sent"] = [];
  const record = (body: unknown, delaySeconds?: number): void => {
    const c = counters();
    c.queueMessages += 1;
    const type = String((body as { type?: unknown } | null)?.type ?? "unknown");
    c.queueTypes[type] = (c.queueTypes[type] ?? 0) + 1;
    sent.push({ body, delaySeconds });
  };
  const queue: MeteredQueue = {
    sent,
    backlogCount: 0,
    async metrics() {
      counters().serviceCalls += 1;
      return { backlogCount: queue.backlogCount, backlogBytes: queue.backlogCount * 200, oldestMessageTimestamp: 0 };
    },
    async send(body, options) {
      counters().queueCalls += 1;
      record(body, options?.delaySeconds);
    },
    async sendBatch(messages, options) {
      counters().queueCalls += 1;
      for (const message of messages) record(message.body, message.delaySeconds ?? options?.delaySeconds);
    },
  };
  return queue;
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
  /** Spread into an `Env`: DB, BUCKET, JOBS_QUEUE and the two rate limiters. */
  readonly bindings: Pick<Env, "DB" | "BUCKET" | "JOBS_QUEUE" | "RL_STRICT" | "RL_STANDARD">;
  readonly queue: MeteredQueue;
  /** `caches.default` for the duration of every measurement. */
  readonly cache: MeteredCache;
  /**
   * The metered Cache API (`caches.default` and named `caches.open()` caches,
   * such as the settings mirror), installed as `caches` during every
   * measurement. Install it around setup that should warm the same caches.
   */
  readonly caches: { default: MeteredCache; open(name: string): Promise<MeteredCache> };
  /** Wrap a service binding (EMAIL, IMAGES) so each call counts as a subrequest. */
  service<T extends object>(binding: T): T;
  /** An `ExecutionContext` whose `waitUntil` tasks the measurement awaits. */
  readonly ctx: ExecutionContext;
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
  const queue = meterQueue(counters);
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
  const bindings = {
    DB: meterD1(options.d1, counters, clock),
    BUCKET: meterR2(counters),
    JOBS_QUEUE: queue,
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
    queue,
    cache,
    caches,
    service: (binding) => meterService(binding, counters),
    ctx,
    async measure<T>(operation: () => Promise<T>) {
      current = emptyCounters();
      clock.engineMicros = 0;
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
