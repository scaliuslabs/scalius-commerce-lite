import { describe, expect, it } from "vitest";
import {
  getDashboardActivityPanelState,
  getDailyActivityDataForRange,
  hasDailyActivityData,
  type DailyActivityDataPoint,
} from "./dashboard-chart-data";

const dailyActivityData = Array.from({ length: 10 }, (_, index) => ({
  date: `2026-06-${String(index + 1).padStart(2, "0")}`,
  orders: index + 1,
  revenue: (index + 1) * 100,
  newCustomers: index,
})) satisfies DailyActivityDataPoint[];

describe("dashboard chart data", () => {
  it("treats empty or missing daily activity as non-renderable", () => {
    expect(getDailyActivityDataForRange([], "7d")).toEqual([]);
    expect(getDailyActivityDataForRange(null, "7d")).toEqual([]);
    expect(hasDailyActivityData([])).toBe(false);
  });

  it("treats all-zero daily activity as non-renderable", () => {
    const zeroData = Array.from({ length: 90 }, (_, index) => ({
      date: `2026-03-${String(index + 1).padStart(2, "0")}`,
      orders: 0,
      revenue: 0,
      newCustomers: 0,
    })) satisfies DailyActivityDataPoint[];

    expect(hasDailyActivityData(zeroData)).toBe(false);
  });

  it("keeps only the selected time range when data is available", () => {
    const result = getDailyActivityDataForRange(dailyActivityData, "7d");

    expect(result).toHaveLength(7);
    expect(result[0]?.date).toBe("2026-06-04");
    expect(hasDailyActivityData(result)).toBe(true);
  });

  it("separates loading, empty, unavailable, and chart states", () => {
    expect(getDashboardActivityPanelState([], "pending")).toBe("loading");
    expect(getDashboardActivityPanelState([], "success")).toBe("empty");
    expect(getDashboardActivityPanelState([], "error")).toBe("unavailable");
    expect(getDashboardActivityPanelState(dailyActivityData, "success")).toBe("chart");
  });
});
