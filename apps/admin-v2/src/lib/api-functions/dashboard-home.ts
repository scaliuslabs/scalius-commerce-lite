import { createServerFn } from "@tanstack/react-start";
import { apiGet } from "../api.server";

export interface DashboardHomeStatsPayload {
  totalProducts: number;
  totalCustomers: number;
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

export interface DashboardSummaryData {
  stats: DashboardHomeStatsPayload;
  recentOrders: DashboardRecentOrder[];
}

export interface DashboardActivityData {
  dailyActivityData: DashboardDailyActivity[];
}

export const getDashboardSummary = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<DashboardSummaryData>("/dashboard/home-summary");
  },
);

export const getDashboardActivity = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<DashboardActivityData>("/dashboard/activity");
  },
);
