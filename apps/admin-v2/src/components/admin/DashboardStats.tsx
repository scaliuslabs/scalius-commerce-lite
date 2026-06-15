//src/components/admin/DashboardStats.tsx
import React, { memo, Suspense } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { LoadingFallback } from "./shared/LoadingFallback";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "../ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ShoppingCart,
  Package,
  DollarSign,
  TrendingUpIcon,
  TrendingDownIcon,
  Users,
  CheckCircle,
} from "lucide-react";
import type { ChartConfig } from "@/components/ui/chart";
import { useCurrency } from "@/hooks/use-currency";
import { hasDailyActivityData } from "./dashboard-chart-data";

const DashboardChart = React.lazy(() =>
  import("./DashboardChart").then((m) => ({ default: m.DashboardChart }))
);

interface StatsCardProps {
  title: string;
  value: string | number;
  description: string;
  icon?: React.ReactNode;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  isStaticBadge?: boolean;
  staticBadgeContent?: React.ReactNode;
}

const StatsCard = ({
  title,
  value,
  description,
  icon,
  trend,
  isStaticBadge,
  staticBadgeContent,
}: StatsCardProps) => (
  <Card className="@container/card shadow-xs bg-gradient-to-t from-primary/5 to-card dark:bg-card h-full">
    <CardHeader className="pb-2">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5 min-w-0">
          <CardDescription>{title}</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums">
            {value}
          </CardTitle>
        </div>
        <div className="flex items-center gap-2">
          {icon && <div className="text-muted-foreground/80">{icon}</div>}
          {trend && !isStaticBadge && (
            <Badge
              variant="outline"
              className={`flex gap-1 rounded-lg text-xs ${trend.isPositive ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-500"}`}
            >
              {trend.isPositive ? (
                <TrendingUpIcon className="size-3" />
              ) : (
                <TrendingDownIcon className="size-3" />
              )}
              {trend.isPositive ? "+" : ""}
              {trend.value}%
            </Badge>
          )}
          {isStaticBadge && staticBadgeContent && (
            <Badge
              variant="outline"
              className="flex gap-1 rounded-lg text-xs bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-900/30 dark:border-emerald-800/50 dark:text-emerald-400"
            >
              {staticBadgeContent}
            </Badge>
          )}
        </div>
      </div>
    </CardHeader>
    <CardFooter className="flex-col items-start gap-0.5 text-sm pt-3">
      <div className="text-muted-foreground">{description}</div>
      {trend && !isStaticBadge && (
        <div
          className={`line-clamp-1 flex gap-1 font-medium text-xs ${trend.isPositive ? "text-emerald-600 dark:text-emerald-500" : "text-amber-600 dark:text-amber-500"}`}
        >
          {trend.isPositive ? (
            <TrendingUpIcon className="size-3" />
          ) : (
            <TrendingDownIcon className="size-3" />
          )}
          {trend.isPositive ? "Trending up" : "Trending down"} this month
        </div>
      )}
    </CardFooter>
  </Card>
);

interface DailyActivityDataPoint {
  date: string;
  orders: number;
  revenue: number;
  newCustomers: number;
}

interface DashboardStatsProps {
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
  initialDailyData: DailyActivityDataPoint[];
}

const getChartConfig = (symbol: string): ChartConfig => ({
  orders: {
    label: "Orders",
    color: "var(--chart-2)",
  },
  revenue: {
    label: `Revenue (${symbol})`,
    color: "var(--chart-1)",
  },
  newCustomers: {
    label: "New Customers",
    color: "var(--chart-3)",
  },
});

const statsCardEntryClassName = "animate-fade-in-up [animation-fill-mode:both]";
const statsCardEntryDelays = ["0ms", "60ms", "120ms", "180ms"] as const;

export const DashboardStats = memo(function DashboardStats({
  totalProducts,
  totalCustomers,
  currentMonth,
  initialDailyData,
}: DashboardStatsProps & { currentMonth: { customerGrowth?: number } }) {

  const { symbol } = useCurrency();
  const [shouldLoadChart, setShouldLoadChart] = React.useState(false);
  const chartConfig = React.useMemo(() => getChartConfig(symbol), [symbol]);
  const hasRenderableChartData = React.useMemo(
    () => hasDailyActivityData(initialDailyData),
    [initialDailyData],
  );

  React.useEffect(() => {
    if (!hasRenderableChartData) {
      setShouldLoadChart(false);
      return;
    }

    const win = window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };

    if (win.requestIdleCallback) {
      const idleId = win.requestIdleCallback(() => setShouldLoadChart(true), {
        timeout: 1200,
      });
      return () => win.cancelIdleCallback?.(idleId);
    }

    const timeoutId = window.setTimeout(() => setShouldLoadChart(true), 800);
    return () => window.clearTimeout(timeoutId);
  }, [hasRenderableChartData]);

  return (
    <ErrorBoundary fallback={<div className="p-4 text-center text-muted-foreground">Something went wrong loading the dashboard. <button onClick={() => window.location.reload()} className="underline">Reload</button></div>}>
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-6">
        <div
          className={statsCardEntryClassName}
          style={{ animationDelay: statsCardEntryDelays[0] }}
        >
          <StatsCard
            title="Monthly Orders"
            value={currentMonth.orders}
            description="Total orders this month"
            icon={<ShoppingCart className="h-5 w-5" />}
            trend={{
              value: currentMonth.orderGrowth,
              isPositive: currentMonth.orderGrowth >= 0,
            }}
          />
        </div>
        <div
          className={statsCardEntryClassName}
          style={{ animationDelay: statsCardEntryDelays[1] }}
        >
          <StatsCard
            title="Monthly Revenue"
            value={`${symbol}${currentMonth.revenue.toLocaleString()}`}
            description="Revenue this month"
            icon={<DollarSign className="h-5 w-5" />}
            trend={{
              value: currentMonth.revenueGrowth,
              isPositive: currentMonth.revenueGrowth >= 0,
            }}
          />
        </div>
        <div
          className={statsCardEntryClassName}
          style={{ animationDelay: statsCardEntryDelays[2] }}
        >
          <StatsCard
            title="Total Customers"
            value={totalCustomers}
            description="Registered customers count"
            icon={<Users className="h-5 w-5" />}
            trend={
              typeof currentMonth.customerGrowth === "number"
                ? {
                    value: currentMonth.customerGrowth,
                    isPositive: currentMonth.customerGrowth >= 0,
                  }
                : undefined
            }
          />
        </div>
        <div
          className={statsCardEntryClassName}
          style={{ animationDelay: statsCardEntryDelays[3] }}
        >
          <StatsCard
            title="Active Products"
            value={totalProducts}
            description="Products currently in store"
            icon={<Package className="h-5 w-5" />}
            isStaticBadge={true}
            staticBadgeContent={
              <>
                <CheckCircle className="size-3" />
                Active
              </>
            }
          />
        </div>
      </div>

      {hasRenderableChartData && shouldLoadChart ? (
        <Suspense fallback={<LoadingFallback height="h-[340px]" />}>
          <DashboardChart
            initialDailyData={initialDailyData}
            symbol={symbol}
            chartConfig={chartConfig}
          />
        </Suspense>
      ) : (
        <LoadingFallback height="h-[340px]" />
      )}
    </div>
    </ErrorBoundary>
  );
});
