// Opt-in only. Reuses ANALYTICS_SCALE_ORDERS/RUNS/OUT; never touches huge-state.
// Fresh SQLite connections empty the SQLite page cache, not the OS file cache.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { analyticsFactsBackfillStatement } from "@scalius/database/analytics-rollup";
import { applyD1Limits, createMigratedSqlite, createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { NO_PHONE } from "@scalius/shared/customer-auth-policy";
import { createAnalyticsContext } from "./context";
import { getAnalyticsOverviewForRequest } from "./service";
import { seedScaleStore } from "./reports.scale-store";
import { createAnalyticsFixture } from "./reports.fixture";
import { sourceOverviewPeriod } from "./overview.source-oracle";

const OUT = process.env.ANALYTICS_SCALE_OUT;
const ORDERS = Number(process.env.ANALYTICS_SCALE_ORDERS ?? 1_000_000);
const RUNS = Math.max(1, Number(process.env.ANALYTICS_SCALE_RUNS ?? 1));
const NOW = new Date("2026-09-01T06:00:00+06:00");
const PERIODS = [
  { name: "month", from: "2026-08-03", to: "2026-09-01" },
  { name: "year", from: "2025-09-02", to: "2026-09-01" },
  { name: "shifted-year", from: "2025-12-01", to: "2026-11-30" },
  { name: "interior-broad", from: "2025-11-01", to: "2026-06-30" },
  { name: "one-day", from: "2026-08-15", to: "2026-08-15" },
  { name: "empty", from: "2020-01-01", to: "2020-01-01" },
];
const projectionTables = ["analytics_sales_buckets", "analytics_sealed_days", "analytics_order_facts"];
afterEach(() => vi.restoreAllMocks());

function usedBytes(sqlite: DatabaseSync) {
  const pragma = (name: string) => Number(Object.values(sqlite.prepare(`PRAGMA ${name}`).get()!)[0]);
  return (pragma("page_count") - pragma("freelist_count")) * pragma("page_size");
}

function writeCost(lines: number) {
  const fixture = createAnalyticsFixture();
  const { sqlite } = fixture;
  try {
    sqlite.exec("CREATE TEMP TABLE projection_writes (name TEXT)");
    for (const table of projectionTables) {
      for (const action of ["INSERT", "UPDATE", "DELETE"]) {
        sqlite.exec(`CREATE TEMP TRIGGER bench_${table}_${action} AFTER ${action} ON ${table} BEGIN INSERT INTO projection_writes VALUES ('${table}'); END`);
      }
    }
    const count = () => Number(sqlite.prepare("SELECT count(*) AS n FROM projection_writes").get()!.n);
    let started = performance.now();
    fixture.order({ id: "bench", createdAt: NOW.getTime() / 1000, requiresShipping: false, customerPhone: NO_PHONE,
      lines: Array.from({ length: lines }, (_, i) => ({ id: `bench_${i}`, productId: "p_bench", quantity: 1, unitMinor: 101, fulfillmentType: "digital" })) });
    const createMs = performance.now() - started;
    const createProjectionWrites = count();
    sqlite.exec("DELETE FROM projection_writes");
    started = performance.now();
    sqlite.exec("BEGIN");
    sqlite.exec("UPDATE order_items SET line_subtotal_minor = line_subtotal_minor + 1 WHERE order_id = 'bench'");
    sqlite.exec("COMMIT");
    const amendMs = performance.now() - started;
    const amendProjectionWrites = count();
    expect(sqlite.prepare("SELECT order_count, gross, net_units FROM analytics_order_facts WHERE order_id = 'bench'").get())
      .toEqual({ order_count: 1, gross: lines * 102, net_units: lines });
    // Linear: one fact insert and one fact update per line; no shared row.
    expect(createProjectionWrites).toBe(lines + 1);
    expect(amendProjectionWrites).toBe(lines);
    return { lines, supported: lines <= 99, createMs, amendMs, createProjectionWrites, amendProjectionWrites, instrumentation: "temporary triggers count projection writes; source validation/API time excluded" };
  } finally { fixture.close(); }
}

it.runIf(Boolean(OUT))("measures one-million-order backfill, fresh-connection reads and supported/stress writes", async () => {
  expect(Number.isSafeInteger(ORDERS) && ORDERS > 0 && ORDERS <= 1_000_000).toBe(true);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const directory = mkdtempSync(join(tmpdir(), "scalius-rollup-benchmark-"));
  const path = join(directory, "store.sqlite");
  const report: Record<string, unknown> = { orders: ORDERS, cache: "new SQLite connection per first read; mmap disabled; 16 MiB page cache; OS cache uncontrolled", targetMs: 300 };
  const reads: Array<{ name: string; attempt: number; firstMs: number; warmMs: number }> = [];
  let sqlite: DatabaseSync | undefined;
  try {
    const blank = createMigratedSqlite();
    try { blank.prepare("VACUUM INTO ?").run(path); } finally { blank.close(); }
    sqlite = new DatabaseSync(path);
    // Disposable fixture only: faster bulk loading, with bounded memory usage.
    sqlite.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -262144");
    applyD1Limits(sqlite);
    process.stdout.write(`analytics benchmark: seeding ${ORDERS} orders\n`);
    // Time the seeder's actual backfill, avoiding a second million-row rebuild.
    const backfill = [analyticsFactsBackfillStatement()];
    const execute = sqlite.exec.bind(sqlite);
    const steps: Array<{ name: string | undefined; ms: number; rows: number }> = [];
    let beforeBytes = 0;
    let afterBytes = 0;
    const trace = vi.spyOn(sqlite, "exec").mockImplementation((statement) => {
      const index = backfill.indexOf(statement);
      if (index < 0) return execute(statement);
      if (index === 0) beforeBytes = usedBytes(sqlite!);
      const stepStarted = performance.now();
      const result = execute(statement);
      const name = statement.match(/^insert into (\w+)/i)?.[1];
      expect(name).toBeDefined();
      steps.push({ name, ms: performance.now() - stepStarted, rows: Number(sqlite!.prepare("SELECT changes() AS n").get()!.n) });
      if (index === backfill.length - 1) afterBytes = usedBytes(sqlite!);
      return result;
    });
    let started = performance.now();
    try { seedScaleStore(createSqliteD1Database({ sqlite }), ORDERS, NOW); }
    finally { trace.mockRestore(); }
    report.seedIncludingFirstBackfillMs = performance.now() - started;
    expect(Number(sqlite.prepare("SELECT count(*) AS n FROM orders").get()!.n)).toBe(ORDERS);
    expect(steps.map(({ name }) => name)).toEqual(["analytics_order_facts"]);
    report.backfill = { ms: steps.reduce((sum, step) => sum + step.ms, 0), addedUsedBytes: afterBytes - beforeBytes, beforeUsedBytes: beforeBytes, afterUsedBytes: afterBytes, steps, cache: "source pages may be warm from seed; commit/fsync excluded" };
    // Production D1 has no ANALYZE statistics; do not let the fixture hide a scan.
    for (const table of ["sqlite_stat1", "sqlite_stat4"]) {
      if (sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(table)) sqlite.exec(`DELETE FROM ${table}`);
    }
    sqlite.exec("ANALYZE sqlite_schema");
    sqlite.close();
    sqlite = undefined;
    for (const period of PERIODS) {
      for (let attempt = 1; attempt <= RUNS; attempt++) {
        process.stdout.write(`analytics benchmark: ${period.name} fresh connection ${attempt}\n`);
        sqlite = new DatabaseSync(path, { readOnly: true });
        sqlite.exec("PRAGMA cache_size = -16384; PRAGMA mmap_size = 0; PRAGMA query_only = ON");
        applyD1Limits(sqlite);
        const queries: Array<{ query: string; values: readonly SQLInputValue[] }> = [];
        const db = createSqliteD1Database({ sqlite, onQuery: (query, values) => queries.push({ query, values }) }).db;
        started = performance.now();
        const ctx = await createAnalyticsContext(db, "Asia/Dhaka", NOW);
        queries.length = 0;
        const request = { from: period.from, to: period.to, comparison: "previous_period" as const };
        const first = await getAnalyticsOverviewForRequest(ctx, request);
        const firstMs = performance.now() - started;
        const overviewQueries = [...queries];
        started = performance.now();
        const warm = await getAnalyticsOverviewForRequest(ctx, request);
        const warmMs = performance.now() - started;
        expect(warm).toEqual(first);
        // The range's sealed days, then one statement per period.
        expect(overviewQueries).toHaveLength(3);
        const statements = overviewQueries.map(({ query, values }) => {
          expect(values.length).toBeLessThanOrEqual(100);
          expect(sqlite!.prepare(query).columns().length).toBeLessThanOrEqual(100);
          expect(query).not.toMatch(/\b(?:from|join)\s+(?:orders|order_items|order_payments|cod_tracking|order_returns|order_return_lines)\b/i);
          const plan = sqlite!.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...values).map((row) => String(row.detail));
          expect(plan.filter((line) => /^SCAN (f|b|p|analytics_order_facts|analytics_sales_buckets)( |$)/.test(line))).toEqual([]);
          const sqlStarted = performance.now();
          sqlite!.prepare(query).all(...values);
          return { binds: values.length, warmSqlMs: performance.now() - sqlStarted, plan };
        });
        const sourceStarted = performance.now();
        expect(first.current).toEqual(await sourceOverviewPeriod(ctx, first.current.range));
        expect(first.previous).toEqual(await sourceOverviewPeriod(ctx, first.previous!.range));
        if (period.name === "shifted-year" && ORDERS === 1_000_000) expect(first.current.customers.returningCustomers).toBeGreaterThan(100_000);
        const measurement = { name: period.name, attempt, firstMs, warmMs, sourceParityMs: performance.now() - sourceStarted, currentOrders: first.current.totals.orders, statements };
        reads.push(measurement);
        process.stdout.write(`${JSON.stringify({ analyticsOverviewRead: { name: period.name, attempt, firstMs, warmMs } })}\n`);
        sqlite.close();
        sqlite = undefined;
      }
    }
    report.reads = reads;
    report.writes = [writeCost(99), writeCost(500)];
    report.passesLocalReadTarget = reads.every((read) => read.firstMs <= 300);
    expect(reads.every((read) => read.firstMs <= 300), JSON.stringify(reads.map(({ name, firstMs }) => ({ name, firstMs })))).toBe(true);
  } finally {
    report.reads = reads;
    if (OUT) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    sqlite?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 900_000);
