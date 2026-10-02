// PostgreSQL parity of Analytics: the known-answer store is built on D1
// (SQLite), copied row for row into a real PostgreSQL database with the
// canonical schema, and the overview and every report must answer exactly
// as on D1 through the adapter's SQLite-profile compiler. Opt-in: point
// SCALIUS_TEST_POSTGRES_URL at a disposable local server; the test creates
// and drops its own database.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, types } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { connectPostgres, createPostgresDatabase } from "@scalius/database/postgres-adapter";
import type { Database } from "@scalius/database/client";
import { ANALYTICS_REPORTS, type AnalyticsReportId } from "@scalius/shared/analytics-reports";
import {
  createAnalyticsContext,
  getAnalyticsOverviewForRequest,
  getAnalyticsReportPage,
} from "@scalius/core/modules/analytics";
import { createAnalyticsFixture } from "../../../packages/core/src/modules/analytics/reports/reports.fixture";
import {
  AUGUST,
  seedKnownAnswerExtras,
  seedKnownAnswerStore,
} from "../../../packages/core/src/modules/analytics/reports/metrics.fixture-store";

const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
const NOW = new Date("2026-09-01T06:00:00+06:00");

function canonicalPostgresSchemaSql(): string {
  const databaseDir = fileURLToPath(new URL("../../../packages/database/", import.meta.url));
  const out = join(mkdtempSync(join(tmpdir(), "scalius-analytics-pg-schema-")), "schema.sql");
  const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
  execFileSync(tsx, ["scripts/postgres-schema.ts", "--out", out], { cwd: databaseDir });
  return readFileSync(out, "utf8");
}

const parseBigint = ((oid: number, format?: "text" | "binary") =>
  oid === 20 ? Number : types.getTypeParser(oid, format)) as typeof types.getTypeParser;

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Every SQLite table with rows, copied into PostgreSQL with triggers off (the rows already passed them on D1). */
async function copyStore(sqlite: import("node:sqlite").DatabaseSync, client: Client) {
  const tables = sqlite.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'
  `).all() as Array<{ name: string }>;
  const existing = new Set((await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((row) => row.table_name as string));
  await client.query("SET session_replication_role = replica");
  for (const { name } of tables) {
    if (!existing.has(name)) continue;
    const rows = sqlite.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
    if (rows.length === 0) continue;
    await client.query(`DELETE FROM "${name}"`);
    for (const row of rows) {
      const columns = Object.keys(row);
      await client.query(
        `INSERT INTO "${name}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
        columns.map((column) => row[column]),
      );
    }
  }
  await client.query("SET session_replication_role = DEFAULT");
}

async function postgres(): Promise<{ db: Database; client: Client }> {
  const name = `scalius_analytics_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(postgresUrl!);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString(), types: { getTypeParser: parseBigint } });
  await client.connect();
  await client.query(canonicalPostgresSchemaSql());
  cleanups.push(async () => {
    await client.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  return { db: createPostgresDatabase(url.toString(), { connect: connectPostgres }), client };
}

/** Floats rounded so numeric and REAL division agree; everything else exact. */
function normalize(value: unknown): unknown {
  if (typeof value === "number" && !Number.isInteger(value)) return Math.round(value * 1e6) / 1e6;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]));
  }
  return value;
}

describe.runIf(postgresUrl)("analytics: PostgreSQL parity with D1", () => {
  it("answers the overview and every report exactly as D1", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fixture = createAnalyticsFixture();
    seedKnownAnswerStore(fixture);
    seedKnownAnswerExtras(fixture);
    const pg = await postgres();
    await copyStore(fixture.sqlite, pg.client);

    const d1Context = await createAnalyticsContext(fixture.db, NOW);
    const pgContext = await createAnalyticsContext(pg.db, NOW);
    // The copy landed, and the unit-cost probe reads PostgreSQL's missing-column error as "not yet".
    expect((await getAnalyticsOverviewForRequest(pgContext, { ...AUGUST })).current.totals).toMatchObject({ orders: 6, totalSales: 276_700 });
    expect(await pgContext.hasUnitCost()).toBe(false);
    for (const comparison of ["previous_period", "previous_year"] as const) {
      for (const granularity of ["day", "week", "month"] as const) {
        const query = { ...AUGUST, comparison, granularity };
        expect(normalize(await getAnalyticsOverviewForRequest(pgContext, query)), `${comparison} ${granularity}`)
          .toEqual(normalize(await getAnalyticsOverviewForRequest(d1Context, query)));
      }
    }
    for (const report of ANALYTICS_REPORTS) {
      if (report.id === "profit_by_product") continue;
      for (const sort of report.columns.slice(0, 3)) {
        const query = { ...AUGUST, sort: sort.key, direction: "asc" as const, page: 1, pageSize: 100 };
        const [onD1, onPg] = await Promise.all([
          getAnalyticsReportPage(d1Context, report.id as AnalyticsReportId, query, { customers: true }),
          getAnalyticsReportPage(pgContext, report.id as AnalyticsReportId, query, { customers: true }),
        ]);
        // Text order may differ by collation; compare the row sets and totals.
        const byId = (page: typeof onD1) => [...page.rows].sort((left, right) => left.id.localeCompare(right.id));
        expect(normalize(byId(onPg)), `${report.id} by ${sort.key}`).toEqual(normalize(byId(onD1)));
        expect(normalize(onPg.totals), `${report.id} totals`).toEqual(normalize(onD1.totals));
        expect(onPg.totalRows, report.id).toBe(onD1.totalRows);
      }
    }
    fixture.close();
  }, 300_000);
});
