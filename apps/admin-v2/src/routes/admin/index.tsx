import { lazy, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { QuickActions } from "~/components/admin/QuickActions";
import {
  dashboardActivityQueryOptions,
  dashboardSummaryQueryOptions,
} from "~/lib/api-query-options/dashboard-home";
import { RouteErrorComponent } from "~/lib/route-error";
import type { DashboardSummaryData } from "~/lib/api-functions/dashboard-home";
import { isTransientD1Error } from "@scalius/core/utils/transient-d1";
import { Skeleton } from "@/components/ui/skeleton";

const DashboardStats = lazy(() =>
  import("~/components/admin/DashboardStats").then((mod) => ({
    default: mod.DashboardStats,
  })),
);
const RecentOrders = lazy(() =>
  import("~/components/admin/RecentOrders").then((mod) => ({
    default: mod.RecentOrders,
  })),
);
const WelcomeBanner = lazy(() =>
  import("~/components/admin/WelcomeBanner").then((mod) => ({
    default: mod.WelcomeBanner,
  })),
);

const EMPTY_DASHBOARD_SUMMARY: DashboardSummaryData = {
  stats: {
    totalProducts: 0,
    totalCustomers: 0,
    currentMonth: {
      orders: 0,
      revenue: 0,
      orderGrowth: 0,
      revenueGrowth: 0,
      orderStatus: {
        delivered: 0,
        processing: 0,
        shipping: 0,
        cancelled: 0,
      },
    },
    lastMonth: {
      orders: 0,
      revenue: 0,
    },
  },
  recentOrders: [],
};

export const Route = createFileRoute("/admin/")({
  loader: async ({ context: { queryClient } }) => {
    if (typeof window === "undefined") {
      return;
    }

    void queryClient.prefetchQuery(dashboardSummaryQueryOptions()).catch((error) => {
      if (!isTransientD1Error(error)) {
        console.warn("Dashboard summary prefetch skipped", error);
      }
    });
    void queryClient.prefetchQuery(dashboardActivityQueryOptions()).catch((error) => {
      if (!isTransientD1Error(error)) {
        console.warn("Dashboard activity prefetch skipped", error);
      }
    });
  },
  head: () => ({ meta: [{ title: "Dashboard | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: DashboardPage,
});

function DashboardPage() {
  const summaryQuery = useQuery({
    ...dashboardSummaryQueryOptions(),
    retry: (failureCount, error) => failureCount < 3 && isTransientD1Error(error),
  });
  const activityQuery = useQuery({
    ...dashboardActivityQueryOptions(),
    retry: (failureCount, error) => failureCount < 3 && isTransientD1Error(error),
  });
  const data = summaryQuery.data ?? EMPTY_DASHBOARD_SUMMARY;
  const dailyActivityData = activityQuery.data?.dailyActivityData ?? [];
  const activityLoadState = activityQuery.isPending
    ? "pending"
    : activityQuery.isError && !activityQuery.data
      ? "error"
      : "success";
  const isSummaryInitialLoading = summaryQuery.isPending && !summaryQuery.data;

  return (
    <div className="space-y-8">
      <Suspense fallback={<WelcomeBannerLoading />}>
        <WelcomeBanner />
      </Suspense>

      {summaryQuery.isError && (
        <div
          role="alert"
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100"
        >
          Dashboard metrics are temporarily unavailable. You can keep using the admin while the data refreshes.
        </div>
      )}

      {activityQuery.isError && !summaryQuery.isError && (
        <div
          role="alert"
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100"
        >
          Dashboard activity chart data is temporarily unavailable. Summary metrics are still current.
        </div>
      )}

      {isSummaryInitialLoading ? (
        <DashboardSummaryLoading />
      ) : (
        <>
          <div className="overflow-hidden rounded-2xl border border-gray-100/80 dark:border-gray-800/60 bg-white dark:bg-gray-900/50 shadow-[0_1px_3px_0_rgb(0,0,0,0.08)] dark:shadow-none transition-all duration-200 ease-out">
            <div className="p-5 md:p-6">
              <Suspense fallback={<DashboardStatsPanelLoading />}>
                <DashboardStats
                  totalProducts={data.stats.totalProducts}
                  totalCustomers={data.stats.totalCustomers}
                  currentMonth={data.stats.currentMonth}
                  initialDailyData={dailyActivityData}
                  activityLoadState={activityLoadState}
                />
              </Suspense>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Suspense fallback={<RecentOrdersPanelLoading />}>
                <RecentOrders orders={data.recentOrders} />
              </Suspense>
            </div>
            <div className="lg:col-span-1">
              <QuickActions />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function DashboardStatsPanelLoading() {
  return (
    <div className="space-y-6">
      <DashboardMetricsLoading />
      <Skeleton className="h-[340px] w-full rounded-lg" />
    </div>
  );
}

function DashboardMetricsLoading() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
      {Array.from({ length: 4 }).map((_, index) => (
        <div
          key={`metric-skeleton-${index}`}
          className="h-[142px] rounded-xl border border-gray-100 bg-gray-50/70 p-5 dark:border-gray-800 dark:bg-gray-950/20"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-3">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-8 w-20" />
            </div>
            <Skeleton className="h-5 w-5 rounded-full" />
          </div>
          <div className="mt-6 space-y-2">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-28" />
          </div>
        </div>
      ))}
    </div>
  );
}

function WelcomeBannerLoading() {
  return (
    <div
      className="mb-4 min-h-[76px] overflow-hidden rounded-2xl border border-gray-100 bg-white p-4 dark:border-gray-800 dark:bg-gray-900/50"
      aria-hidden="true"
    >
      <div className="flex items-center gap-3">
        <Skeleton className="h-7 w-7 rounded-full" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </div>
      </div>
    </div>
  );
}

function RecentOrdersPanelLoading() {
  return (
    <div className="overflow-hidden rounded-2xl bg-white dark:bg-gray-900/50">
      <div className="border-b border-gray-100 px-6 py-5 dark:border-gray-800/50">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="mt-3 h-3 w-56" />
      </div>
      <div className="space-y-4 p-6">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={`recent-order-skeleton-${index}`}
            className="grid grid-cols-[minmax(90px,1fr)_2fr_1fr] gap-4"
          >
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

function DashboardSummaryLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading dashboard summary">
      <div className="overflow-hidden rounded-2xl border border-gray-100/80 bg-white shadow-[0_1px_3px_0_rgb(0,0,0,0.08)] dark:border-gray-800/60 dark:bg-gray-900/50 dark:shadow-none">
        <div className="space-y-6 p-5 md:p-6">
          <DashboardMetricsLoading />
          <Skeleton className="h-[340px] w-full rounded-lg" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RecentOrdersPanelLoading />
        </div>
        <div>
          <QuickActions />
        </div>
      </div>
    </div>
  );
}
