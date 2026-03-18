import { apiGet } from "@/lib/api-fetch";
import type {
  DashboardStats,
  DashboardRecentOrder,
  DashboardDailyActivity,
} from "@/types/api-responses";

export async function getDashboardData() {
  return apiGet<{
    stats: DashboardStats;
    recentOrders: DashboardRecentOrder[];
    dailyActivityData: DashboardDailyActivity[];
  }>("/dashboard");
}
