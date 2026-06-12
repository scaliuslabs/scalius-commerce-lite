export interface DailyActivityDataPoint {
  date: string;
  orders: number;
  revenue: number;
  newCustomers: number;
}

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
  return dailyData.length > 0;
}
