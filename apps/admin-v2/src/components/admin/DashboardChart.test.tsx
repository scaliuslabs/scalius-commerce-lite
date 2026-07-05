import { describe, expect, it } from "vitest";
import {
  buildDashboardChartModel,
  buildSmoothPath,
  formatDashboardChartPointLabel,
  type DashboardChartConfig,
} from "./DashboardChart";
import type { DailyActivityDataPoint } from "./dashboard-chart-data";

const chartConfig = {
  orders: {
    label: "Orders",
    color: "var(--chart-2)",
  },
  revenue: {
    label: "Revenue (\u09F3)",
    color: "var(--chart-1)",
  },
  newCustomers: {
    label: "New Customers",
    color: "var(--chart-3)",
  },
} satisfies DashboardChartConfig;

const dailyActivityData = [
  {
    date: "2026-06-01",
    orders: 2,
    revenue: 1200,
    newCustomers: 1,
  },
  {
    date: "2026-06-02",
    orders: 4,
    revenue: 2400,
    newCustomers: 3,
  },
  {
    date: "2026-06-03",
    orders: 1,
    revenue: 600,
    newCustomers: 2,
  },
] satisfies DailyActivityDataPoint[];

describe("DashboardChart SVG model", () => {
  it("builds finite path coordinates for the three dashboard series", () => {
    const model = buildDashboardChartModel(dailyActivityData);

    expect(model.seriesPoints.revenue).toHaveLength(dailyActivityData.length);
    expect(model.seriesPoints.orders).toHaveLength(dailyActivityData.length);
    expect(model.seriesPoints.newCustomers).toHaveLength(
      dailyActivityData.length,
    );

    const allPoints = Object.values(model.seriesPoints).flat();

    expect(allPoints.length).toBe(dailyActivityData.length * 3);
    expect(
      allPoints.every(
        (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
      ),
    ).toBe(true);
    expect(model.seriesPoints.revenue[1]!.y).toBeLessThan(
      model.seriesPoints.revenue[0]!.y,
    );
    expect(model.seriesPoints.orders[1]!.y).toBeLessThan(
      model.seriesPoints.orders[0]!.y,
    );
  });

  it("creates a smooth SVG path without leaking invalid coordinates", () => {
    const model = buildDashboardChartModel(dailyActivityData);
    const path = buildSmoothPath(model.seriesPoints.revenue);

    expect(path).toMatch(/^M /);
    expect(path).toContain(" C ");
    expect(path).not.toMatch(/NaN|Infinity/);
  });

  it("uses the provided render width without scaling chart coordinates", () => {
    const narrowModel = buildDashboardChartModel(dailyActivityData, 420);
    const wideModel = buildDashboardChartModel(dailyActivityData, 1180);

    expect(wideModel.seriesPoints.revenue.at(-1)!.x).toBeGreaterThan(
      narrowModel.seriesPoints.revenue.at(-1)!.x,
    );
    expect(wideModel.xTicks.at(-1)!.x).toBeGreaterThan(
      narrowModel.xTicks.at(-1)!.x,
    );
  });

  it("normalizes non-finite API values before generating paths and labels", () => {
    const unsafeData = [
      {
        date: "2026-06-04",
        orders: Number.NaN,
        revenue: Number.POSITIVE_INFINITY,
        newCustomers: Number.NEGATIVE_INFINITY,
      },
    ] satisfies DailyActivityDataPoint[];
    const model = buildDashboardChartModel(unsafeData);
    const path = buildSmoothPath(model.seriesPoints.revenue);

    expect(path).not.toMatch(/NaN|Infinity/);
    expect(
      formatDashboardChartPointLabel(unsafeData[0]!, "\u09F3", chartConfig),
    ).toContain("Revenue (\u09F3): \u09F30, Orders: 0, New Customers: 0");
  });

  it("formats focus labels with every visible metric", () => {
    expect(
      formatDashboardChartPointLabel(
        dailyActivityData[1]!,
        "\u09F3",
        chartConfig,
      ),
    ).toContain(
      "Revenue (\u09F3): \u09F32,400, Orders: 4, New Customers: 3",
    );
  });
});
