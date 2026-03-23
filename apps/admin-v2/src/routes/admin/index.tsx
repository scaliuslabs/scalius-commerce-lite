import { createFileRoute } from "@tanstack/react-router";
import { DashboardStats } from "~/components/admin/DashboardStats";
import { RecentOrders } from "~/components/admin/RecentOrders";
import { QuickActions } from "~/components/admin/QuickActions";
import { WelcomeBanner } from "~/components/admin/WelcomeBanner";
import { getDashboardData } from "~/lib/api.functions";

export const Route = createFileRoute("/admin/")({
  loader: async () => {
    const data = await getDashboardData() as any;
    return {
      stats: data.stats as { totalProducts: number; totalCustomers: number; currentMonth: any },
      recentOrders: data.recentOrders as any[],
      dailyActivityData: data.dailyActivityData as any[],
    };
  },
  head: () => ({ meta: [{ title: "Dashboard | Scalius Admin" }] }),
  component: DashboardPage,
});

function DashboardPage() {
  const { stats, recentOrders, dailyActivityData } = Route.useLoaderData();

  return (
    <div className="space-y-8">
      <WelcomeBanner />

      <div className="overflow-hidden rounded-2xl border border-gray-100/80 dark:border-gray-800/60 bg-white dark:bg-gray-900/50 shadow-[0_1px_3px_0_rgb(0,0,0,0.08)] dark:shadow-none transition-all duration-200 ease-out">
        <div className="p-5 md:p-6">
          <DashboardStats
            totalProducts={stats.totalProducts}
            totalCustomers={stats.totalCustomers}
            currentMonth={stats.currentMonth}
            initialDailyData={dailyActivityData}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RecentOrders orders={recentOrders} />
        </div>
        <div className="lg:col-span-1">
          <QuickActions />
        </div>
      </div>
    </div>
  );
}
