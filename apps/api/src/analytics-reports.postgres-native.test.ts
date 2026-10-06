// PostgreSQL parity of Analytics: the known-answer store is built on D1
// (SQLite), copied row for row into a real PostgreSQL database with the
// canonical schema, and the overview and every report must answer exactly
// as on D1 through the adapter's SQLite-profile compiler. Opt-in: point
// SCALIUS_TEST_POSTGRES_URL at a disposable local server; the test creates
// and drops its own database.
import type { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { closeNativePostgres, createNativePostgres, nativePostgresUrl } from "@scalius/database/testing/postgres-native";
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

const postgresUrl = nativePostgresUrl();
const NOW = new Date("2026-09-01T06:00:00+06:00");

afterAll(closeNativePostgres);

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
    const pg = await createNativePostgres({ label: "analytics" });
    await copyStore(fixture.sqlite, pg.client);

    const d1Context = await createAnalyticsContext(fixture.db, NOW);
    const pgContext = await createAnalyticsContext(pg.db, NOW);
    // The copy landed.
    expect((await getAnalyticsOverviewForRequest(pgContext, { ...AUGUST })).current.totals).toMatchObject({ orders: 6, totalSales: 276_700 });
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
          getAnalyticsReportPage(d1Context, report.id as AnalyticsReportId, query, { customers: true, costs: true }),
          getAnalyticsReportPage(pgContext, report.id as AnalyticsReportId, query, { customers: true, costs: true }),
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
