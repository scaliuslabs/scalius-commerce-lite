import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDashboardActivity: vi.fn(),
  getDashboardSummary: vi.fn(),
}));

vi.mock("../api-functions/dashboard-home", () => ({
  getDashboardActivity: mocks.getDashboardActivity,
  getDashboardSummary: mocks.getDashboardSummary,
}));

import { dashboardActivityQueryOptions } from "./dashboard-home";

function requireQueryFn(options: ReturnType<typeof dashboardActivityQueryOptions>) {
  if (typeof options.queryFn !== "function") {
    throw new Error("Expected dashboard activity queryFn to be configured");
  }
  return options.queryFn;
}

describe("dashboardActivityQueryOptions", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns activity data from the dashboard server function", async () => {
    const activityData = {
      dailyActivityData: [
        {
          date: "2026-07-05",
          orders: 2,
          revenue: 1200,
          newCustomers: 1,
        },
      ],
    };
    mocks.getDashboardActivity.mockResolvedValue(activityData);

    const result = await requireQueryFn(dashboardActivityQueryOptions())({} as never);

    expect(result).toEqual(activityData);
  });

  it("normalizes a missing local server-function result so React Query never caches undefined", async () => {
    mocks.getDashboardActivity.mockResolvedValue(undefined);

    const result = await requireQueryFn(dashboardActivityQueryOptions())({} as never);

    expect(result).toEqual({ dailyActivityData: [] });
  });

  it("normalizes malformed activity payloads to the empty chart state", async () => {
    mocks.getDashboardActivity.mockResolvedValue({} as never);

    const result = await requireQueryFn(dashboardActivityQueryOptions())({} as never);

    expect(result).toEqual({ dailyActivityData: [] });
  });
});
