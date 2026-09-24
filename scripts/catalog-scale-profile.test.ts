/**
 * Catalogue-scale profiler (opt-in, local only). Runs real API routes
 * in-process against a Miniflare D1 state seeded by
 * `scripts/catalog-scale-seed.mjs`, and reports per route: wall time
 * (p50/p95), D1 statements, dependent waves, rows read (D1 `meta.rows_read`)
 * and the heaviest statements.
 *
 *   CATALOG_SCALE_STATE=/tmp/catalog-scale/profile-state \
 *   CATALOG_SCALE_TARGETS=/path/targets.json \
 *   CATALOG_SCALE_OUT=/tmp/catalog-scale/profile.json \
 *   pnpm vitest run scripts/catalog-scale-profile.test.ts --maxWorkers=1
 *
 * targets.json: [{ "name": "...", "path": "/api/v1/...", "method"?: "POST",
 * "body"?: {...}, "admin"?: true, "runs"?: 5 }]. Admin targets send the
 * cookie header stored in the file CATALOG_SCALE_COOKIE_FILE (a local
 * dashboard session). CATALOG_SCALE_RUNS sets the default timed runs and
 * CATALOG_SCALE_FULL_SQL=1 keeps every statement's SQL and bound values in
 * the report for EXPLAIN QUERY PLAN. Each route runs once to warm modules,
 * `runs` times timed, then once metered (raw()/first() reads are re-run
 * through all() for their meta, so the metered run is not timed).
 *
 * Point it at a copy of the seeded state, never at a shared or remote one:
 * the Miniflare state is opened read-write, and a route that writes changes it.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

const STATE = process.env.CATALOG_SCALE_STATE;

interface Target {
  name: string;
  path: string;
  method?: string;
  body?: unknown;
  admin?: boolean;
  runs?: number;
}

interface StatementSample {
  sql: string;
  fullSql?: string;
  args?: unknown[];
  ms: number;
  rowsRead: number;
  rows: number;
}

interface Meter {
  binding: D1Database;
  statements: StatementSample[];
  waves: number;
  metering: boolean;
}

function metered(inner: D1Database): Meter {
  const meter: Meter = { binding: inner, statements: [], waves: 0, metering: false };
  let queued: Array<() => void> = [];
  const wave = <T>(work: () => Promise<T>): Promise<T> => new Promise<T>((resolveWork, reject) => {
    queued.push(() => void work().then(resolveWork, (error: unknown) => {
      console.error(`[d1] ${error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error)}`);
      reject(error);
    }));
    if (queued.length === 1) {
      setTimeout(() => {
        meter.waves += 1;
        const run = queued;
        queued = [];
        for (const start of run) start();
      }, 0);
    }
  });
  const record = (sql: string, result: { meta?: { rows_read?: number; duration?: number }; results?: unknown[] } | null, args?: unknown[]) => {
    meter.statements.push({
      sql: sql.replace(/\s+/g, " ").slice(0, 400),
      ...(process.env.CATALOG_SCALE_FULL_SQL ? { fullSql: sql, args } : {}),
      ms: result?.meta?.duration ?? 0,
      rowsRead: result?.meta?.rows_read ?? 0,
      rows: result?.results?.length ?? 0,
    });
  };
  const sqlOf = new WeakMap<object, { sql: string; args?: unknown[] }>();
  const wrap = (statement: D1PreparedStatement, sql: string, args?: unknown[]): D1PreparedStatement => {
    const wrapped = wrapStatement(statement, sql, args);
    sqlOf.set(wrapped, { sql, args });
    return wrapped;
  };
  const wrapStatement = (statement: D1PreparedStatement, sql: string, args?: unknown[]): D1PreparedStatement => new Proxy(statement, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "bind") {
        return (...bound: unknown[]) => wrap((value as (...a: unknown[]) => D1PreparedStatement).apply(target, bound), sql, bound);
      }
      if (property === "all" || property === "run") {
        return () => wave(async () => {
          const result = await (value as () => Promise<D1Result>).apply(target);
          record(sql, result as never, args);
          return result;
        });
      }
      if (property === "raw" || property === "first") {
        return (...callArgs: unknown[]) => wave(async () => {
          if (meter.metering) {
            // raw()/first() drop meta: re-run once through all() to meter it.
            try {
              record(sql, await target.all() as never, args);
            } catch (error) {
              meter.statements.push({ sql: `[failed: ${error instanceof Error ? error.message : String(error)}] ${sql.replace(/\s+/g, " ").slice(0, 300)}`, fullSql: sql, args, ms: -1, rowsRead: -1, rows: 0 });
              throw error;
            }
          } else {
            meter.statements.push({ sql: sql.replace(/\s+/g, " ").slice(0, 400), ms: 0, rowsRead: 0, rows: 0 });
          }
          return (value as (...a: unknown[]) => Promise<unknown>).apply(target, callArgs);
        });
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // getDb() opens a D1 session per request (withSession), so the session is
  // metered too, not only the bare binding.
  const wrapDatabase = <T extends object>(database: T): T => new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          return wrap((target as unknown as D1Database).prepare(query), query);
        };
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => wave(async () => {
          const results = await (target as unknown as D1Database).batch(statements);
          results.forEach((result, index) => {
            const source = sqlOf.get(statements[index]);
            record(`[batch ${index + 1}/${statements.length}] ${source?.sql ?? "?"}`, result as never, source?.args);
          });
          return results;
        });
      }
      if (property === "withSession") {
        return (...args: unknown[]) => wrapDatabase((target as unknown as { withSession: (...a: unknown[]) => object }).withSession(...args));
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  meter.binding = wrapDatabase(inner);
  return meter;
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

describe.skipIf(!STATE)("catalog-scale profile", () => {
  let proxy: Awaited<ReturnType<typeof import("wrangler").getPlatformProxy>>;
  let fetchRuntimeApiApp: typeof import("../apps/api/src/runtime/fetch-runtime-app").fetchRuntimeApiApp;
  let composeApiRuntimeEnv: typeof import("../apps/api/src/runtime/runtime-env").composeApiRuntimeEnv;
  const report: unknown[] = [];

  beforeAll(async () => {
    // wrangler is an apps/api dependency, not a root one.
    const { getPlatformProxy } = createRequire(resolve(__dirname, "../apps/api/package.json"))("wrangler") as typeof import("wrangler");
    proxy = await getPlatformProxy({
      configPath: resolve(__dirname, "../apps/api/wrangler.local.jsonc"),
      persist: { path: resolve(STATE!, "v3") },
    });
    ({ fetchRuntimeApiApp } = await import("../apps/api/src/runtime/fetch-runtime-app"));
    ({ composeApiRuntimeEnv } = await import("../apps/api/src/runtime/runtime-env"));
  }, 120_000);

  afterAll(async () => {
    await proxy?.dispose();
    if (process.env.CATALOG_SCALE_OUT) writeFileSync(process.env.CATALOG_SCALE_OUT, JSON.stringify(report, null, 2));
  });

  it("profiles every target", async () => {
    const targets: Target[] = JSON.parse(readFileSync(process.env.CATALOG_SCALE_TARGETS!, "utf8"));
    const cookieFile = process.env.CATALOG_SCALE_COOKIE_FILE;
    const cookie = cookieFile ? readFileSync(cookieFile, "utf8").trim() : "";
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((arg) => arg instanceof Error ? `${arg.message}\n${arg.stack}` : typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ").slice(0, 1500));
    };
    for (const target of targets) {
      logs.length = 0;
      const wall: number[] = [];
      let sample: { statements: StatementSample[]; waves: number } | null = null;
      let status = 0;
      let bytes = 0;
      let error: string | undefined;
      const runs = target.runs ?? Number(process.env.CATALOG_SCALE_RUNS ?? 5);
      // Run 0 warms modules; runs 1..n are timed; the last run is metered.
      for (let run = 0; run <= runs + 1; run += 1) {
        const meter = metered(proxy.env.DB as D1Database);
        meter.metering = run === runs + 1;
        const env = await composeApiRuntimeEnv({ ...(proxy.env as unknown as Env), DB: meter.binding }, { requestUrl: "http://localhost:8821/" });
        const headers = new Headers({ origin: "http://localhost:4323" });
        if (target.admin) headers.set("cookie", cookie);
        if (target.body !== undefined) headers.set("content-type", "application/json");
        const request = new Request(`http://localhost:8821${target.path}`, {
          method: target.method ?? "GET",
          headers,
          body: target.body === undefined ? undefined : JSON.stringify(target.body),
        });
        const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
        const started = performance.now();
        const response = await fetchRuntimeApiApp(request, env, ctx);
        const text = await response.text();
        const elapsed = performance.now() - started;
        status = response.status;
        bytes = text.length;
        if (run >= 1 && run <= runs) wall.push(elapsed);
        if (meter.metering) sample = { statements: meter.statements, waves: meter.waves };
        if (status >= 400) error = text.slice(0, 300);
      }
      const statements = sample?.statements ?? [];
      const entry = {
        name: target.name,
        path: target.path,
        status,
        ...(error ? { error, logs: logs.slice(0, 3) } : {}),
        bytes,
        p50: Math.round(percentile(wall, 50)),
        p95: Math.round(percentile(wall, 95)),
        statements: statements.length,
        waves: sample?.waves ?? 0,
        rowsRead: statements.reduce((sum, statement) => sum + statement.rowsRead, 0),
        sqlMs: Math.round(statements.reduce((sum, statement) => sum + statement.ms, 0)),
        top: [...statements].sort((a, b) => b.rowsRead - a.rowsRead).slice(0, 4).map(({ fullSql: _sql, args: _args, ...rest }) => rest),
        ...(process.env.CATALOG_SCALE_FULL_SQL ? { all: statements } : {}),
      };
      report.push(entry);
    }
    console.error = originalError;
  }, 3_600_000);
});
