// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/hooks/use-currency", () => ({
  useCurrency: () => ({ symbol: "৳" }),
}));

import { DashboardStats } from "./DashboardStats";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseProps = {
  totalProducts: 4,
  totalCustomers: 8,
  initialDailyData: [],
  activityLoadState: "success" as const,
  currentMonth: {
    orders: 2,
    revenue: 100,
    orderStatus: { delivered: 1, processing: 1, shipping: 0, cancelled: 0 },
  },
};

describe("DashboardStats monthly comparisons", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("renders neutral and unavailable comparisons without trending-up copy", async () => {
    await act(async () => root.render(
      <DashboardStats
        {...baseProps}
        currentMonth={{ ...baseProps.currentMonth, orderGrowth: 0, revenueGrowth: null }}
      />,
    ));

    expect(host.textContent).toContain("0%");
    expect(host.textContent).toContain("No change from previous month");
    expect(host.textContent).toContain("Unavailable");
    expect(host.textContent).toContain("No previous-month baseline");
    expect(host.textContent).not.toContain("Trending up");
  });

  it("keeps a small decline visibly negative", async () => {
    await act(async () => root.render(
      <DashboardStats
        {...baseProps}
        currentMonth={{ ...baseProps.currentMonth, orderGrowth: -1, revenueGrowth: -1 }}
      />,
    ));

    expect(host.textContent).toContain("-1%");
    expect(host.textContent).toContain("Down vs previous month");
  });

  it("preserves tiny signed changes without fabricating a full percent", async () => {
    await act(async () => root.render(
      <DashboardStats
        {...baseProps}
        currentMonth={{ ...baseProps.currentMonth, orderGrowth: 0.01, revenueGrowth: -0.01 }}
      />,
    ));

    expect(host.textContent).toContain("+<0.1%");
    expect(host.textContent).toContain("-<0.1%");
    expect(host.textContent).toContain("Up vs previous month");
    expect(host.textContent).toContain("Down vs previous month");
  });
});
