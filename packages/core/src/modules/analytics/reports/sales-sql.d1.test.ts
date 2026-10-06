import { sql } from "drizzle-orm";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { analyticsDateKeyFromEpochDay, analyticsInstantRange } from "@scalius/shared/analytics-period";
import { commerceCalendarDateKey } from "@scalius/shared/commerce-time";
import { describe, expect, it } from "vitest";
import { merchantDaySql, scopeOffsets } from "./sales-sql";

/** The merchant day SQL gives each instant, as a date key. */
async function sqlDays(timeZone: string, range: { from: string; to: string }, instants: number[]): Promise<string[]> {
  const { sqlite, db } = createSqliteD1Database();
  try {
    const offsets = scopeOffsets(timeZone, analyticsInstantRange(range, timeZone));
    const rows = await db.all<{ day: number }>(sql`select ${merchantDaySql("t.at", offsets)} as day
      from (select cast(value as integer) as at, key from json_each(${JSON.stringify(instants)})) t order by t.key`);
    return rows.map((row) => analyticsDateKeyFromEpochDay(Number(row.day)));
  } finally {
    sqlite.close();
  }
}

const at = (iso: string) => Date.parse(iso) / 1000;

describe("merchant day SQL", () => {
  it("is one integer expression for a zone without daylight saving (Dhaka)", () => {
    const offsets = scopeOffsets("Asia/Dhaka", analyticsInstantRange({ from: "2024-01-01", to: "2025-12-31" }, "Asia/Dhaka"));
    expect(offsets).toEqual({ initialOffset: 21_600, changes: [] });
    const chunks = (merchantDaySql("om.created_at", offsets) as unknown as { queryChunks: Array<{ value: string[] }> }).queryChunks;
    expect(chunks.flatMap((chunk) => chunk.value).join("")).toBe("cast((om.created_at + 21600) / 86400 as integer)");
  });

  it("puts every instant on the store's day across both New York changes", async () => {
    const range = { from: "2026-03-01", to: "2026-11-30" };
    const instants = [
      at("2026-03-08T04:59:59Z"), // 7 March 23:59:59 EST
      at("2026-03-08T05:00:00Z"), // 8 March 00:00 EST
      at("2026-03-09T03:59:59Z"), // 8 March 23:59:59 EDT (a 23-hour day)
      at("2026-03-09T04:00:00Z"), // 9 March 00:00 EDT
      at("2026-11-01T03:59:59Z"), // 31 October 23:59:59 EDT
      at("2026-11-01T04:00:00Z"), // 1 November 00:00 EDT
      at("2026-11-02T04:59:59Z"), // 1 November 23:59:59 EST (a 25-hour day)
      at("2026-11-02T05:00:00Z"), // 2 November 00:00 EST
    ];
    const days = await sqlDays("America/New_York", range, instants);
    expect(days).toEqual([
      "2026-03-07", "2026-03-08", "2026-03-08", "2026-03-09",
      "2026-10-31", "2026-11-01", "2026-11-01", "2026-11-02",
    ]);
    expect(days).toEqual(instants.map((instant) => commerceCalendarDateKey("America/New_York", instant * 1000)));
  });

  it("matches Intl on every hour of a European year", async () => {
    const range = { from: "2026-01-01", to: "2026-12-31" };
    const { start, endExclusive } = analyticsInstantRange(range, "Europe/Berlin");
    const instants: number[] = [];
    for (let instant = start; instant < endExclusive; instant += 3_600 * 7) instants.push(instant);
    expect(await sqlDays("Europe/Berlin", range, instants))
      .toEqual(instants.map((instant) => commerceCalendarDateKey("Europe/Berlin", instant * 1000)));
  });
});
