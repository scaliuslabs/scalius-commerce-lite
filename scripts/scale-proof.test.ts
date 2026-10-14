/**
 * The scale proof (opt-in, local only; driven by scripts/scale-proof.mjs, which documents the whole flow).
 *
 * Runs the real API in-process against a catalogue-scale store (scripts/catalog-scale-seed.mjs --profile huge:
 * 1M orders, ~150k SKUs) on one engine and measures what a hosted platform pays for:
 *
 * - the main storefront reads: p50 and p95 over timed runs, plus one metered run (statements, dependent waves,
 *   and D1's own `meta.rows_read`);
 * - checkout throughput (tax quote + commit + after-response work) at 1 and 16 concurrent clients, spread over
 *   many SKUs and all on one hot SKU, with the PostgreSQL serialization retries counted;
 * - the rows one 3-line checkout reads and writes (D1: `meta.rows_read/rows_written`, index entries included;
 *   PostgreSQL: the server's tuple counters).
 *
 * D1 is a Miniflare state (the local SQLite engine of workerd) and PostgreSQL a local server; the run refuses
 * anything else. It writes: point it at a copy of the seeded state or a disposable database.
 *
 *   SCALE_PROOF_STATE=<copy of the seeded wrangler state>  or  SCALE_PROOF_POSTGRES_URL=postgres://localhost:.../db
 *   SCALE_PROOF_OUT=<result.json>   SCALE_PROOF_ORDERS=<orders per 1-client run, default 150>
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import type { Database } from "../packages/database/src/types";
import { metered, percentile } from "./catalog-scale-meter";

const STATE = process.env.SCALE_PROOF_STATE;
const POSTGRES_URL = process.env.SCALE_PROOF_POSTGRES_URL;
const ORDERS = Number(process.env.SCALE_PROOF_ORDERS ?? 150);
const CLIENTS = [1, 16] as const;

let provider: "d1" | "postgres" = "d1";
let serializationRetries = 0;
let transportRetries = 0;

const TRANSIENT_TRANSPORT = /fetch failed|ECONNRESET|socket hang up|other side closed/i;

/**
 * Miniflare's D1 binding reaches workerd over HTTP, and a kept-alive connection the server has closed fails the
 * next call with ECONNRESET before the request is sent. That is the harness, not D1: retry the call and count it.
 */
function retryingTransport<T extends object>(target: T): T {
  const transient = (error: unknown) => TRANSIENT_TRANSPORT.test(`${String(error)} ${String((error as { cause?: unknown })?.cause)}`);
  return new Proxy(target, {
    get(inner, property, receiver) {
      const value = Reflect.get(inner, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const invoke = () => (value as (...a: unknown[]) => unknown).apply(inner, args);
        const first = invoke();
        if (first && typeof (first as PromiseLike<unknown>).then === "function") {
          const settle = async (left: number, pending: unknown): Promise<unknown> => {
            try {
              return await pending;
            } catch (error) {
              if (left === 0 || !transient(error)) throw error;
              transportRetries += 1;
              await new Promise((done) => setTimeout(done, 25));
              return settle(left - 1, invoke());
            }
          };
          return settle(4, first);
        }
        return first && typeof first === "object" ? retryingTransport(first) : first;
      };
    },
  });
}

// The API resolves `@scalius/database/client` to this file; mock it by path (as scripts/cache-dvc-load.test.ts does).
vi.mock("../packages/database/src/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../packages/database/src/client")>();
  return {
    ...actual,
    getDb: (env?: Record<string, unknown>) => (env && env.__SCALE_DB ? env.__SCALE_DB : actual.getDb(env as never)) as ReturnType<typeof actual.getDb>,
    getDatabaseProviderForClient: (db: Database) => (provider === "postgres" ? "postgres" : actual.getDatabaseProviderForClient(db)),
  };
});

const summarize = (values: number[]) => ({ p50: Math.round(percentile(values, 50)), p95: Math.round(percentile(values, 95)) });

describe.skipIf(!STATE && !POSTGRES_URL)("scale proof", () => {
  let dispose: () => Promise<void> = async () => undefined;
  let db: Database;
  let baseEnv: Record<string, unknown>;
  let d1: D1Database | undefined;
  let pgClient: pg.Client | undefined;
  let newPostgresDatabase: (pool: pg.Pool) => Database;
  let fetchRuntimeApiApp: typeof import("../apps/api/src/runtime/fetch-runtime-app").fetchRuntimeApiApp;
  let composeApiRuntimeEnv: typeof import("../apps/api/src/runtime/runtime-env").composeApiRuntimeEnv;
  const result: Record<string, unknown> = {};

  /** One request through the real app: runtime env composed as the Worker entry does, after-response work awaited. */
  async function call(path: string, init: { method?: string; body?: unknown; binding?: D1Database; database?: Database } = {}): Promise<{ status: number; text: string; ms: number }> {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(Promise.resolve(promise).catch(() => undefined)); }, passThroughOnException: () => undefined } as unknown as ExecutionContext;
    const started = performance.now();
    const env = await composeApiRuntimeEnv({ ...baseEnv, ...(init.binding ? { DB: init.binding } : {}), ...(init.database ? { __SCALE_DB: init.database } : {}) } as unknown as Env, { requestUrl: "http://localhost:8821/" });
    const headers = new Headers({ origin: "http://localhost:4323" });
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const response = await fetchRuntimeApiApp(new Request(`http://localhost:8821${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }), env, ctx);
    const text = await response.text();
    for (let index = 0; index < pending.length; index += 1) await pending[index];
    return { status: response.status, text, ms: performance.now() - started };
  }

  beforeAll(async () => {
    ({ fetchRuntimeApiApp } = await import("../apps/api/src/runtime/fetch-runtime-app"));
    ({ composeApiRuntimeEnv } = await import("../apps/api/src/runtime/runtime-env"));
    const secrets = { SCALIUS_SECRET: "scale-proof-master-secret-with-more-than-32-chars", CREDENTIAL_ENCRYPTION_KEY: btoa("0123456789abcdef0123456789abcdef"), CF_VERSION_METADATA: { id: "scale-proof", tag: "", timestamp: "" } };
    const limiter = { limit: async () => ({ success: true }) };
    if (POSTGRES_URL) {
      const host = new URL(POSTGRES_URL).hostname;
      if (host !== "localhost" && host !== "127.0.0.1") throw new Error("The scale proof runs against a local PostgreSQL only.");
      provider = "postgres";
      const { createPostgresDatabase, connectNativePostgres } = await import("../packages/database/src/postgres-adapter");
      // Hyperdrive pools connections in production; a pool stands in for it, so a request does not pay a connect.
      // Idle clients close quickly so the server's tuple counters flush before they are read.
      newPostgresDatabase = (pool) => {
        const createClient = () => {
          let client: pg.PoolClient | undefined;
          return {
            connect: async () => { client = await pool.connect(); },
            query: (query: unknown) => client!.query(query as never),
            end: async () => { client?.release(); },
          };
        };
        return createPostgresDatabase(POSTGRES_URL, {
          connect: (url) => connectNativePostgres(url, { createClient: createClient as never }),
          onSerializationRetry: () => { serializationRetries += 1; },
        });
      };
      const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 32, idleTimeoutMillis: 100 });
      db = newPostgresDatabase(pool);
      pgClient = new pg.Client({ connectionString: POSTGRES_URL });
      await pgClient.connect();
      baseEnv = { __SCALE_DB: db, ...secrets, RL_STRICT: limiter, RL_STANDARD: limiter, BUCKET: {} };
      dispose = async () => { await pgClient?.end(); await pool.end(); };
    } else {
      // wrangler is an apps/api dependency, not a root one.
      const { getPlatformProxy } = createRequire(resolve(__dirname, "../apps/api/package.json"))("wrangler") as typeof import("wrangler");
      const proxy = await getPlatformProxy({ configPath: resolve(__dirname, "../apps/api/wrangler.local.jsonc"), persist: { path: resolve(STATE!, "v3") } });
      d1 = retryingTransport(proxy.env.DB as D1Database);
      const { getDb } = await vi.importActual<typeof import("../packages/database/src/client")>("../packages/database/src/client");
      db = getDb({ DB: d1 } as never);
      baseEnv = { ...(proxy.env as unknown as Record<string, unknown>), ...secrets, DB: d1, RL_STRICT: limiter, RL_STANDARD: limiter, REALTIME_HUB: undefined };
      dispose = () => proxy.dispose();
    }
  }, 600_000);

  afterAll(async () => {
    await dispose();
    if (process.env.SCALE_PROOF_OUT) writeFileSync(process.env.SCALE_PROOF_OUT, `${JSON.stringify(result, null, 2)}\n`);
  });

  /** PostgreSQL row activity: tuples fetched and tuples inserted, updated or deleted, from the server's counters. */
  async function postgresRows(): Promise<{ read: number; written: number }> {
    await pgClient!.query("SELECT pg_stat_force_next_flush()").catch(() => undefined);
    const { rows } = await pgClient!.query(`SELECT coalesce(sum(seq_tup_read + coalesce(idx_tup_fetch, 0)), 0)::bigint AS read,
      coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::bigint AS written FROM pg_stat_user_tables`);
    return { read: Number(rows[0].read), written: Number(rows[0].written) };
  }

  /**
   * The tuples PostgreSQL read and wrote while `work` ran on a connection of its own: the server flushes a
   * backend's counters when it exits, so the pool is closed before they are read.
   */
  async function postgresMetered(work: (database: Database) => Promise<void>): Promise<{ read: number; written: number }> {
    await new Promise((done) => setTimeout(done, 600)); // the main pool's idle backends exit and flush
    const before = await postgresRows();
    const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 4 });
    await work(newPostgresDatabase(pool));
    await pool.end();
    await new Promise((done) => setTimeout(done, 300));
    const after = await postgresRows();
    return { read: after.read - before.read, written: after.written - before.written };
  }

  it("measures the size of the store", async () => {
    const { storeSize } = await import("../apps/api/src/testing/scale-proof-store");
    result.engine = provider === "postgres" ? `PostgreSQL ${(await pgClient!.query("SHOW server_version")).rows[0].server_version}` : "D1 (Miniflare, workerd SQLite)";
    result.provider = provider;
    result.store = await storeSize(db);
    console.info(`[scale] ${JSON.stringify(result.store)}`);
  }, 600_000);

  it("times the main storefront reads", async () => {
    const { readTargets } = await import("../apps/api/src/testing/scale-proof-store");
    const { productSlug, categorySlug, term } = await readTargets(db);
    const targets = [
      { name: "home page (storefront homepage)", path: "/api/v1/storefront/homepage" },
      { name: "product page", path: `/api/v1/products/${productSlug}` },
      { name: "category listing, page 1", path: `/api/v1/categories/${categorySlug}/products?page=1&limit=20&sort=newest` },
      { name: "category listing, page 40", path: `/api/v1/categories/${categorySlug}/products?page=40&limit=20&sort=newest` },
      { name: "all products, newest, page 1", path: "/api/v1/products?page=1&limit=20&sort=newest" },
      { name: "search", path: `/api/v1/products?page=1&limit=20&sort=relevance&search=${encodeURIComponent(term)}` },
      { name: "product feed page", path: "/api/v1/products/feed?limit=100" },
    ];
    const reads: unknown[] = [];
    for (const target of targets) {
      const wall: number[] = [];
      let status = 0;
      for (let run = 0; run < 22; run += 1) {
        const response = await call(target.path);
        status = response.status;
        if (run >= 2) wall.push(response.ms);
      }
      const entry: Record<string, unknown> = { name: target.name, path: target.path, status, ...summarize(wall) };
      if (d1) {
        const meter = metered(d1);
        meter.metering = true;
        await call(target.path, { binding: meter.binding });
        entry.statements = meter.statements.length;
        entry.waves = meter.waves;
        entry.rowsRead = meter.statements.reduce((sum, statement) => sum + statement.rowsRead, 0);
      } else {
        entry.rowsRead = (await postgresMetered(async (database) => { await call(target.path, { database }); })).read;
      }
      reads.push(entry);
      console.info(`[scale] read ${JSON.stringify(entry)}`);
    }
    result.reads = reads;
  }, 1_800_000);

  let phoneCounter = 0;
  async function checkout(lines: Array<{ productId: string; variantId: string; price: number }>, binding?: D1Database, database?: Database): Promise<{ ok: boolean; status: number; ms: number; text: string }> {
    const items = lines.map((line) => ({ ...line, quantity: 1 }));
    const started = performance.now();
    const quote = await call("/api/v1/orders/tax-quote", {
      method: "POST", binding, database,
      body: { items: items.map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })), city: "scale_city", zone: "scale_zone", shippingMethodId: "scale_std", discountCodes: [] },
    });
    if (quote.status !== 200) return { ok: false, status: quote.status, ms: performance.now() - started, text: quote.text };
    phoneCounter += 1;
    const commit = await call("/api/v1/orders", {
      method: "POST", binding, database,
      body: {
        checkoutRequestId: `scale_${crypto.randomUUID()}`,
        expectedQuoteFingerprint: (JSON.parse(quote.text) as { data: { quoteFingerprint: string } }).data.quoteFingerprint,
        customerName: "Scale Buyer", customerPhone: `+88016${String(10_000_000 + phoneCounter).slice(-8)}`, customerEmail: null,
        shippingAddress: "House 1, Road 2, Scale Zone", city: "scale_city", zone: "scale_zone", notes: null,
        items, discountCodes: [], shippingCharge: 60, shippingMethodId: "scale_std", paymentMethod: "cod",
      },
    });
    return { ok: commit.status === 201, status: commit.status, ms: performance.now() - started, text: commit.text };
  }

  it("measures checkout throughput, spread over SKUs and on one hot SKU", async () => {
    const store = await import("../apps/api/src/testing/scale-proof-store");
    await store.ensureDelivery(db);
    const pool = await store.checkoutLines(db, Math.max(ORDERS * 8, 2400) * 3);
    expect(pool.length, "in-stock whole-taka SKUs to buy").toBeGreaterThan(100);
    const hot = pool[0]!;
    await store.stockUp(db, hot.variantId);
    let cursor = 1;
    const scenarios: unknown[] = [];
    for (const kind of ["spread", "hot"] as const) {
      for (const clients of CLIENTS) {
        const total = clients === 1 ? ORDERS : ORDERS * 4;
        const latencies: number[] = [];
        const failures: Record<number, number> = {};
        let next = 0;
        const retriesBefore = serializationRetries;
        const transportBefore = transportRetries;
        const started = performance.now();
        await Promise.all(Array.from({ length: clients }, async () => {
          while (next < total) {
            next += 1;
            const lines = kind === "hot" ? [hot] : Array.from({ length: 3 }, () => pool[cursor++ % pool.length]!);
            const outcome = await checkout(lines);
            if (outcome.ok) latencies.push(outcome.ms);
            else {
              failures[outcome.status] = (failures[outcome.status] ?? 0) + 1;
              if (failures[outcome.status] === 1) console.info(`[scale] first ${outcome.status}: ${outcome.text.slice(0, 300)}`);
            }
          }
        }));
        const seconds = (performance.now() - started) / 1000;
        const entry = {
          scenario: kind === "hot" ? "1 hot SKU" : "3 lines over many SKUs",
          clients, orders: latencies.length, seconds: Number(seconds.toFixed(1)),
          ordersPerSecond: Number((latencies.length / seconds).toFixed(2)),
          ...summarize(latencies), failures, retries: provider === "postgres" ? serializationRetries - retriesBefore : null,
          ...(provider === "d1" ? { transportRetries: transportRetries - transportBefore } : {}),
        };
        scenarios.push(entry);
        console.info(`[scale] checkout ${JSON.stringify(entry)}`);
      }
    }
    result.checkout = scenarios;
  }, 3_600_000);

  it("counts the rows one 3-line checkout reads and writes", async () => {
    const store = await import("../apps/api/src/testing/scale-proof-store");
    await store.ensureDelivery(db);
    const lines = (await store.checkoutLines(db, 30)).slice(0, 3);
    await checkout(lines); // warm
    if (d1) {
      const meter = metered(d1);
      meter.metering = true;
      const outcome = await checkout(lines, meter.binding);
      expect(outcome.ok).toBe(true);
      const sum = (key: "rowsRead" | "rowsWritten") => meter.statements.reduce((total, statement) => total + Math.max(0, statement[key]), 0);
      const heaviest = [...meter.statements].sort((a, b) => b.rowsRead - a.rowsRead).slice(0, 5).map((statement) => ({ rowsRead: statement.rowsRead, sql: (statement.fullSql ?? statement.sql).replace(/\s+/g, " ").slice(0, 900) }));
      result.perOrder = { statements: meter.statements.length, rowsRead: sum("rowsRead"), rowsWritten: sum("rowsWritten"), heaviest, note: "D1 meta, index entries included; quote + commit + after-response work" };
    } else {
      const rows = await postgresMetered(async (database) => { expect((await checkout(lines, undefined, database)).ok).toBe(true); });
      result.perOrder = { rowsRead: rows.read, rowsWritten: rows.written, note: "PostgreSQL tuple counters: heap tuples, index entries not counted; quote + commit + after-response work" };
    }
    console.info(`[scale] per order ${JSON.stringify(result.perOrder)}`);
  }, 600_000);
});
