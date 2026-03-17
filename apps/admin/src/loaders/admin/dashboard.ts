import { apiGet } from "@/lib/api-fetch";

export async function getDashboardData() {
  return apiGet<{
    stats: any;
    recentOrders: any[];
    dailyActivityData: any[];
  }>("/dashboard");
}
