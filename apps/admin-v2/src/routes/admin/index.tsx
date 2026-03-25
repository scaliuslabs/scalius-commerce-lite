import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { DashboardStats } from "~/components/admin/DashboardStats";
import { RecentOrders } from "~/components/admin/RecentOrders";
import { QuickActions } from "~/components/admin/QuickActions";
import { WelcomeBanner } from "~/components/admin/WelcomeBanner";
import { dashboardQueryOptions } from "~/lib/api.queries";
import { RouteErrorComponent } from "~/lib/list-helpers";

export const Route = createFileRoute("/admin/")({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(dashboardQueryOptions());
  },
  head: () => ({ meta: [{ title: "Dashboard | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: DashboardPage,
});

function DashboardPage() {
  const { data } = useSuspenseQuery(dashboardQueryOptions());

  return (
    <div className="space-y-8">
      <WelcomeBanner />

      <div className="overflow-hidden rounded-2xl border border-gray-100/80 dark:border-gray-800/60 bg-white dark:bg-gray-900/50 shadow-[0_1px_3px_0_rgb(0,0,0,0.08)] dark:shadow-none transition-all duration-200 ease-out">
        <div className="p-5 md:p-6">
          <DashboardStats
            totalProducts={data.stats.totalProducts}
            totalCustomers={data.stats.totalCustomers}
            currentMonth={data.stats.currentMonth}
            initialDailyData={data.dailyActivityData}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RecentOrders orders={data.recentOrders} />
        </div>
        <div className="lg:col-span-1">
          <QuickActions />
        </div>
      </div>
    </div>
  );
}
