export interface DailyActivityDataPoint {
  date: string;
  orders: number;
  revenue: number;
  newCustomers: number;
}

export type DashboardActivityLoadState = "pending" | "success" | "error";
export type DashboardActivityPanelState =
  | "loading"
  | "chart"
  | "empty"
  | "unavailable";

export function getDailyActivityDataForRange(
  initialDailyData: readonly DailyActivityDataPoint[] | null | undefined,
  timeRange: string,
) {
  const dailyData = Array.isArray(initialDailyData) ? initialDailyData : [];
  const days = Number.parseInt(timeRange.replace("d", ""), 10);

  if (!Number.isFinite(days) || days <= 0) {
    return [...dailyData];
  }

  return dailyData.slice(-days);
}

export function hasDailyActivityData(
  dailyData: readonly DailyActivityDataPoint[],
) {
  return dailyData.some(
    (item) => item.orders > 0 || item.revenue > 0 || item.newCustomers > 0,
  );
}

export function getDashboardActivityPanelState(
  dailyData: readonly DailyActivityDataPoint[],
  loadState: DashboardActivityLoadState,
): DashboardActivityPanelState {
  if (loadState === "pending") {
    return "loading";
  }

  if (loadState === "error") {
    return "unavailable";
  }

  return hasDailyActivityData(dailyData) ? "chart" : "empty";
}
