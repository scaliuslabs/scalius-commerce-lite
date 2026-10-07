import { describe, expect, it } from "vitest";
import {
  analyticsBuckets,
  analyticsWeekStartEpochDay,
  analyticsChange,
  analyticsComparisonRange,
  analyticsGranularities,
  analyticsInstantRange,
  analyticsPresetFor,
  analyticsPresetRange,
  analyticsRangeDays,
  analyticsToday,
  defaultAnalyticsGranularity,
  resolveAnalyticsGranularity,
  validateAnalyticsRange,
} from "./analytics-period";
import { weekStartDay } from "./week-start";
import { ANALYTICS_ENUM_VALUES, ANALYTICS_REPORTS, isAnalyticsReportId } from "./analytics-reports";

describe("analytics periods on the merchant calendar", () => {
  it("bounds a range by Dhaka midnights, independent of the host timezone", () => {
    expect(analyticsInstantRange({ from: "2026-08-01", to: "2026-08-31" }, "Asia/Dhaka")).toEqual({
      start: Date.parse("2026-07-31T18:00:00.000Z") / 1000,
      endExclusive: Date.parse("2026-08-31T18:00:00.000Z") / 1000,
    });
    expect(analyticsToday("Asia/Dhaka", new Date("2026-08-13T18:00:00.000Z"))).toBe("2026-08-14");
  });

  it("bounds a range by the store's midnights across daylight saving time", () => {
    // London: GMT until 29 March 2026 01:00 UTC, then BST (UTC+1).
    expect(analyticsInstantRange({ from: "2026-03-01", to: "2026-03-31" }, "Europe/London")).toEqual({
      start: Date.parse("2026-03-01T00:00:00.000Z") / 1000,
      endExclusive: Date.parse("2026-03-31T23:00:00.000Z") / 1000,
    });
    // 03:30 UTC on 1 Nov is still 31 Oct in Los Angeles (PDT, UTC-7).
    expect(analyticsToday("America/Los_Angeles", new Date("2026-11-01T03:30:00.000Z"))).toBe("2026-10-31");
  });

  it("validates real dates, order and the two-year cap", () => {
    expect(validateAnalyticsRange({ from: "2026-01-01", to: "2026-01-31" })).toEqual({ from: "2026-01-01", to: "2026-01-31" });
    expect(() => validateAnalyticsRange({ from: "2026-02-30", to: "2026-03-01" })).toThrow(RangeError);
    expect(() => validateAnalyticsRange({ from: "2026-03-02", to: "2026-03-01" })).toThrow(/on or before/);
    expect(() => validateAnalyticsRange({ from: "2024-01-01", to: "2026-01-01" })).toThrow(/731/);
    expect(analyticsRangeDays({ from: "2024-01-01", to: "2025-12-31" })).toBe(731);
  });

  it("compares with the period before or the same days last year", () => {
    expect(analyticsComparisonRange({ from: "2026-08-01", to: "2026-08-31" }, "previous_period"))
      .toEqual({ from: "2026-07-01", to: "2026-07-31" });
    expect(analyticsComparisonRange({ from: "2026-03-01", to: "2026-03-07" }, "previous_period"))
      .toEqual({ from: "2026-02-22", to: "2026-02-28" });
    expect(analyticsComparisonRange({ from: "2028-02-29", to: "2028-03-01" }, "previous_year"))
      .toEqual({ from: "2027-02-28", to: "2027-03-01" });
    expect(analyticsComparisonRange({ from: "2026-08-01", to: "2026-08-31" }, "none")).toBeNull();
  });

  it("resolves presets from the store's today", () => {
    expect(analyticsPresetRange("last_30_days", "2026-08-14")).toEqual({ from: "2026-07-16", to: "2026-08-14" });
    expect(analyticsPresetRange("last_month", "2026-03-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(analyticsPresetRange("year_to_date", "2026-03-10")).toEqual({ from: "2026-01-01", to: "2026-03-10" });
    expect(analyticsPresetFor({ from: "2026-08-08", to: "2026-08-14" }, "2026-08-14")).toBe("last_7_days");
    expect(analyticsPresetFor({ from: "2026-08-02", to: "2026-08-14" }, "2026-08-14")).toBeNull();
  });

  it("buckets by day, Sunday weeks and months, clipped to the range", () => {
    const range = { from: "2026-08-01", to: "2026-08-12" };
    expect(analyticsBuckets(range, "week")).toEqual([
      { key: "2026-07-26", from: "2026-08-01", to: "2026-08-01" },
      { key: "2026-08-02", from: "2026-08-02", to: "2026-08-08" },
      { key: "2026-08-09", from: "2026-08-09", to: "2026-08-12" },
    ]);
    expect(analyticsBuckets({ from: "2026-07-30", to: "2026-08-02" }, "month").map((bucket) => bucket.key))
      .toEqual(["2026-07-01", "2026-08-01"]);
    expect(analyticsBuckets(range, "day")).toHaveLength(12);
  });

  it("starts weeks on the store country's first day (CLDR), Sunday by default", () => {
    const range = { from: "2026-08-01", to: "2026-08-12" };
    expect(analyticsBuckets(range, "week", weekStartDay("BD"))).toEqual(analyticsBuckets(range, "week"));
    // Monday weeks (Germany): 2026-08-03 and 2026-08-10 are Mondays.
    expect(analyticsBuckets(range, "week", weekStartDay("DE")).map((bucket) => bucket.key))
      .toEqual(["2026-07-27", "2026-08-03", "2026-08-10"]);
    // Saturday weeks (Egypt): 2026-08-01 and 2026-08-08 are Saturdays.
    expect(analyticsBuckets(range, "week", weekStartDay("EG")).map((bucket) => bucket.key))
      .toEqual(["2026-08-01", "2026-08-08"]);
    for (const weekStart of [0, 1, 5, 6] as const) {
      for (let day = 20_000; day < 20_014; day += 1) {
        const start = analyticsWeekStartEpochDay(day, weekStart);
        expect(day - start).toBeGreaterThanOrEqual(0);
        expect(day - start).toBeLessThan(7);
        // 1970-01-01 (epoch day 0) was a Thursday (4).
        expect((start + 4) % 7).toBe(weekStart);
      }
    }
  });

  it("keeps day buckets to three months and picks a sensible default", () => {
    const twoYears = { from: "2024-01-01", to: "2025-12-31" };
    expect(analyticsGranularities(twoYears)).toEqual(["week", "month"]);
    expect(analyticsGranularities({ from: "2026-01-01", to: "2026-04-02" })).toEqual(["day", "week", "month"]);
    expect(analyticsGranularities({ from: "2026-01-01", to: "2026-04-03" })).toEqual(["week", "month"]);
    expect(analyticsBuckets(twoYears, "week").length).toBeLessThanOrEqual(106);
    expect(resolveAnalyticsGranularity(twoYears, "day")).toBe("month");
    expect(defaultAnalyticsGranularity({ from: "2026-01-01", to: "2026-03-31" })).toBe("day");
    expect(defaultAnalyticsGranularity({ from: "2026-01-01", to: "2026-06-30" })).toBe("week");
  });

  it("only reports a change against a real baseline", () => {
    expect(analyticsChange(150, 100)).toBe(50);
    expect(analyticsChange(-50, -100)).toBe(50);
    expect(analyticsChange(0, 0)).toBe(0);
    expect(analyticsChange(10, 0)).toBeNull();
    expect(analyticsChange(10, null)).toBeNull();
  });
});

describe("analytics report catalog", () => {
  it("gives every report a unique id, a sortable default and known enum vocabularies", () => {
    const ids = ANALYTICS_REPORTS.map((report) => report.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const report of ANALYTICS_REPORTS) {
      expect(isAnalyticsReportId(report.id)).toBe(true);
      expect(report.columns.some((column) => column.key === report.defaultSort.key), report.id).toBe(true);
      for (const column of report.columns) {
        const vocabulary = (column as { enum?: keyof typeof ANALYTICS_ENUM_VALUES }).enum;
        if (column.type === "enum") expect(vocabulary && ANALYTICS_ENUM_VALUES[vocabulary], `${report.id}.${column.key}`).toBeDefined();
      }
    }
    expect(isAnalyticsReportId("orders")).toBe(false);
  });
});
