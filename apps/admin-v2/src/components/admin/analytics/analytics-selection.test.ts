// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyticsSearchOf,
  defaultAnalyticsSelection,
  effectiveGranularity,
  readSavedSelection,
  resolveAnalyticsSelection,
  validateAnalyticsSearch,
  writeSavedSelection,
} from "./analytics-selection";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("analytics selection", () => {
  it("defaults to the last 30 days against the period before", () => {
    expect(defaultAnalyticsSelection("2026-08-14")).toEqual({
      from: "2026-07-16",
      to: "2026-08-14",
      comparison: "previous_period",
      granularity: null,
    });
  });

  it("keeps only valid search: real dates in order, known comparisons and groupings", () => {
    expect(validateAnalyticsSearch({ from: "2026-08-01", to: "2026-08-31", comparison: "previous_year", granularity: "week" }))
      .toEqual({ from: "2026-08-01", to: "2026-08-31", comparison: "previous_year", granularity: "week" });
    expect(validateAnalyticsSearch({ from: "2026-08-31", to: "2026-08-01", comparison: "yesterday", granularity: "hour" })).toEqual({});
    expect(validateAnalyticsSearch({ from: "2026-02-30", to: "2026-03-01" })).toEqual({});
  });

  it("saves a preset as the preset, so it rolls forward with the calendar", () => {
    writeSavedSelection("user_1", { from: "2026-08-08", to: "2026-08-14", comparison: "previous_year", granularity: null }, "2026-08-14");
    expect(readSavedSelection("user_1", "2026-09-02")).toEqual({
      from: "2026-08-27",
      to: "2026-09-02",
      comparison: "previous_year",
      granularity: null,
    });
    // Another staff member on the same browser has their own choice.
    expect(readSavedSelection("user_2", "2026-09-02")).toBeNull();
  });

  it("saves a custom range as its dates", () => {
    writeSavedSelection("user_1", { from: "2026-05-03", to: "2026-05-09", comparison: "none", granularity: "day" }, "2026-08-14");
    expect(readSavedSelection("user_1", "2026-09-02")).toEqual({ from: "2026-05-03", to: "2026-05-09", comparison: "none", granularity: "day" });
  });

  it("survives broken or blocked storage", () => {
    localStorage.setItem("scalius.analytics.selection.user_1", "{not json");
    expect(readSavedSelection("user_1", "2026-08-14")).toBeNull();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readSavedSelection("user_1", "2026-08-14")).toBeNull();
    expect(() => writeSavedSelection("user_1", defaultAnalyticsSelection("2026-08-14"), "2026-08-14")).not.toThrow();
  });

  it("lets the URL win, filling what it leaves out from the saved choice", () => {
    const saved = { from: "2026-05-03", to: "2026-05-09", comparison: "none" as const, granularity: "day" as const };
    expect(resolveAnalyticsSelection({ from: "2026-08-01", to: "2026-08-31" }, saved, "2026-09-02"))
      .toEqual({ from: "2026-08-01", to: "2026-08-31", comparison: "none", granularity: "day" });
    expect(resolveAnalyticsSelection({}, null, "2026-08-14")).toEqual(defaultAnalyticsSelection("2026-08-14"));
  });

  it("falls back to the range's own grouping when a chosen one isn't allowed", () => {
    expect(effectiveGranularity({ from: "2025-01-01", to: "2026-06-30", comparison: "none", granularity: "day" })).toBe("month");
    expect(effectiveGranularity({ from: "2026-08-01", to: "2026-08-31", comparison: "none", granularity: null })).toBe("day");
    expect(analyticsSearchOf({ from: "2026-08-01", to: "2026-08-31", comparison: "none", granularity: null }))
      .toEqual({ from: "2026-08-01", to: "2026-08-31", comparison: "none" });
  });
});
