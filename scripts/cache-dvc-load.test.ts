/**
 * DVC load driver (CACHE-DESIGN §4 and §7 item 8), local only.
 *
 * An enterprise-shaped store (the catalogue-scale seed, 50k products) takes a
 * continuous mix of buyer-visible writes and Zipf-distributed reads through a
 * model of the DVC API part cache: every read validates its cached parts with
 * one indexed query (§6.6) and re-renders the parts whose keys moved. It
 * reports, per page type, the part hit ratio and the miss (render) latency,
 * the validation latency, the database rows each phase read and wrote, and
 * the trigger write amplification of each write kind (keys advanced and rows
 * written per buyer-visible write).
 *
 * D1 (Miniflare, real D1 row accounting):
 *   export STATE=/tmp/dvc-load/state
 *   SCALIUS_WRANGLER_STATE=$STATE node scripts/deploy.mjs --migrate-only --local
 *   node scripts/catalog-scale-seed.mjs --state $STATE --products 50000 --customers 2000 --orders 5000
 *   cp -R $STATE /tmp/dvc-load/run            # the driver writes; keep the seed pristine
 *   DVC_LOAD_STATE=/tmp/dvc-load/run DVC_LOAD_OUT=/tmp/dvc-load/d1.json \
 *     pnpm vitest run scripts/cache-dvc-load.test.ts --maxWorkers=1
 *
 * PostgreSQL (a local server only; never a hosted database):
 *   POSTGRES_DATABASE_URL=postgres://localhost:5432/dvc_load \
 *     pnpm --filter @scalius/database migrate:sqlite-to-postgres \
 *     --sqlite <the seeded D1 sqlite file> --checkpoint /tmp/dvc-load/pg.json --ack-target-host localhost
 *   DVC_LOAD_POSTGRES_URL=postgres://localhost:5432/dvc_load DVC_LOAD_OUT=/tmp/dvc-load/pg.json \
 *     pnpm vitest run scripts/cache-dvc-load.test.ts --maxWorkers=1
 *
 * Knobs: DVC_LOAD_READS (default 20000 page views), DVC_LOAD_READS_PER_WRITE
 * (default 10: 100 views/s against 10 writes/s), DVC_LOAD_SEED.
 * The driver refuses any Postgres host other than localhost/127.0.0.1 and
 * any D1 other than a local Miniflare state.
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import type { Database } from "../packages/database/src/types";

const STATE = process.env.DVC_LOAD_STATE;
const POSTGRES_URL = process.env.DVC_LOAD_POSTGRES_URL;
const READS = Number(process.env.DVC_LOAD_READS ?? 20_000);
const READS_PER_WRITE = Number(process.env.DVC_LOAD_READS_PER_WRITE ?? 10);

// The API resolves `@scalius/database/client` to this file; mock it by path.
vi.mock("../packages/database/src/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../packages/database/src/client")>();
  return {
    ...actual,
    getDb: (env?: Record<string, unknown>) => (env && env.__DVC_DB ? env.__DVC_DB : actual.getDb(env as never)) as ReturnType<typeof actual.getDb>,
    getDatabaseProviderForClient: (db: Database) => (loadProvider === "postgres" ? "postgres" : actual.getDatabaseProviderForClient(db)),
  };
});

let loadProvider: "d1" | "postgres" = "d1";

// ---------------------------------------------------------------------------
// Metering

interface PhaseMeter { statements: number; rowsRead: number; rowsWritten: number; ms: number }
const phases: Record<string, PhaseMeter> = {};
let phase = "setup";
const meter = () => (phases[phase] ??= { statements: 0, rowsRead: 0, rowsWritten: 0, ms: 0 });

/** D1 binding that attributes every statement's `meta.rows_read/rows_written` to the current phase. */
function meteredD1(inner: D1Database): D1Database {
  const record = (result: { meta?: { rows_read?: number; rows_written?: number } } | null) => {
    const current = meter();
    current.statements += 1;
    current.rowsRead += result?.meta?.rows_read ?? 0;
    current.rowsWritten += result?.meta?.rows_written ?? 0;
  };
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "bind") return (...args: unknown[]) => wrapStatement((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
      if (property === "all" || property === "run") {
        return async () => {
          const result = await (value as () => Promise<D1Result>).apply(target);
          record(result as never);
          return result;
        };
      }
      if (property === "raw" || property === "first") {
        // raw()/first() drop meta: count the statement; rows via the phase's all()/run() totals.
        return async (...args: unknown[]) => {
          meter().statements += 1;
          return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const wrapDatabase = <T extends object>(database: T): T => new Proxy(database, {
    get(target, property) {
      if (property === "prepare") return (query: string) => wrapStatement((target as unknown as D1Database).prepare(query));
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await (target as unknown as D1Database).batch(statements);
          for (const result of results) record(result as never);
          return results;
        };
      }
      if (property === "withSession") {
        return (...args: unknown[]) => wrapDatabase((target as unknown as { withSession: (...a: unknown[]) => object }).withSession(...args));
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return wrapDatabase(inner);
}

/** PostgreSQL row activity from pg_stat_user_tables (reads: seq + index tuples; writes: ins + upd + del). */
async function postgresActivity(client: pg.Client): Promise<{ read: number; written: number }> {
  await client.query("SELECT pg_stat_force_next_flush()").catch(() => undefined);
  const { rows } = await client.query(`SELECT coalesce(sum(seq_tup_read + coalesce(idx_tup_fetch, 0)), 0)::bigint AS read,
    coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::bigint AS written FROM pg_stat_user_tables`);
  return { read: Number(rows[0].read), written: Number(rows[0].written) };
}


describe.skipIf(!STATE && !POSTGRES_URL)("DVC load driver", () => {
  let dispose: () => Promise<void> = async () => undefined;
  let env: Env;
  let sql: (text: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;
  let db: Database;
  let pgClient: pg.Client | null = null;
  const report: Record<string, unknown> = {};

  beforeAll(async () => {
    if (POSTGRES_URL) {
      const host = new URL(POSTGRES_URL).hostname;
      if (host !== "localhost" && host !== "127.0.0.1") throw new Error("The load driver runs against a local PostgreSQL only.");
      loadProvider = "postgres";
      const { postgresDatabase } = await import("../apps/api/src/testing/cache-dvc/load-driver");
      db = postgresDatabase(POSTGRES_URL);
      pgClient = new pg.Client({ connectionString: POSTGRES_URL });
      await pgClient.connect();
      sql = async (text, params) => {
        let index = 0;
        return (await pgClient!.query(text.replace(/\?/g, () => `$${++index}`), params as unknown[])).rows;
      };
      env = { __DVC_DB: db, CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined } } as unknown as Env;
      dispose = async () => {
        await pgClient?.end();
      };
    } else {
      const { getPlatformProxy } = createRequire(resolve(__dirname, "../apps/api/package.json"))("wrangler") as typeof import("wrangler");
      const proxy = await getPlatformProxy({
        configPath: resolve(__dirname, "../apps/api/wrangler.local.jsonc"),
        persist: { path: resolve(STATE!, "v3") },
      });
      const binding = meteredD1(proxy.env.DB as D1Database);
      const { d1Database } = await import("../apps/api/src/testing/cache-dvc/load-driver");
      db = d1Database(binding);
      sql = async (text, params) => ((await binding.prepare(text).bind(...params).all()).results as Array<Record<string, unknown>>);
      env = { DB: binding, CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined } } as unknown as Env;
      dispose = () => proxy.dispose();
    }
    Object.assign(env as object, {
      JWT_SECRET: "dvc-load-secret-0123456789abcdef0123",
      CREDENTIAL_ENCRYPTION_KEY: "dvc-load-credential-key-0123456789abcdef",
    });
  }, 600_000);

  afterAll(async () => {
    await dispose();
    if (process.env.DVC_LOAD_OUT) writeFileSync(process.env.DVC_LOAD_OUT, JSON.stringify(report, null, 2));
  });

  it("measures hit ratio, miss latency, rows and trigger amplification under continuous writes", async () => {
    const { runDvcLoad } = await import("../apps/api/src/testing/cache-dvc/load-driver");
    const result = await runDvcLoad({
      provider: loadProvider,
      env,
      db,
      sql,
      setPhase: (name) => {
        phase = name;
      },
      meter,
      phases,
      ...(pgClient ? { postgresActivity: () => postgresActivity(pgClient!) } : {}),
    }, { reads: READS, readsPerWrite: READS_PER_WRITE, seed: Number(process.env.DVC_LOAD_SEED ?? 20260925) });
    Object.assign(report, result);
    console.info(`[DVC load] ${JSON.stringify(report, null, 2)}`);
    expect(Number(result.cacheDepRows)).toBeGreaterThan(0);
  }, 24 * 3600_000);
});
