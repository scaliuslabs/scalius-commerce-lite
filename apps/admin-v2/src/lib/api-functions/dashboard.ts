import { createServerFn } from "@tanstack/react-start";
import { apiGet } from "../api.server";

export interface DashboardStatsPayload {
  totalProducts: number;
  totalCustomers: number;
  totalRevenue: number;
  currentMonth: {
    orders: number;
    revenue: number;
    orderGrowth: number;
    revenueGrowth: number;
    orderStatus: {
      delivered: number;
      processing: number;
      shipping: number;
      cancelled: number;
    };
    customerGrowth?: number;
  };
  lastMonth: {
    orders: number;
    revenue: number;
  };
}

export interface DashboardRecentOrder {
  id: string;
  customerName: string;
  totalAmount: number;
  status: string;
  createdAt: string | number;
}

export interface DashboardDailyActivity {
  date: string;
  orders: number;
  revenue: number;
  newCustomers: number;
}

export interface DashboardData {
  stats: DashboardStatsPayload;
  recentOrders: DashboardRecentOrder[];
  dailyActivityData: DashboardDailyActivity[];
}

export const getDashboardData = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<DashboardData>("/dashboard");
  },
);
