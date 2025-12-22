//src/components/admin/DashboardStats.tsx
import React from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  Card,
  CardContent,
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
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
} from "@/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { motion } from "framer-motion";

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

const chartConfig = {
  orders: {
    label: "Orders",
    color: "var(--chart-2)",
  },
  revenue: {
    label: "Revenue (৳)",
    color: "var(--chart-1)",
  },
  newCustomers: {
    label: "New Customers",
    color: "var(--chart-3)",
  },
} satisfies ChartConfig;

// Define animation variants
const containerVariants = {
  hidden: { opacity: 1 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
};

const cardVariants = {
  hidden: { opacity: 0, y: 30, scale: 0.95 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      duration: 0.4,
      ease: [0, 0, 0.2, 1] as const,
    },
  },
};

// Custom Tooltip Content Component
const CustomTooltipContent = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    const formattedLabel = new Date(label).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

    return (
      <div className="rounded-lg border bg-background p-2 shadow-sm">
        <div className="grid grid-cols-1 gap-2">
          <div className="flex flex-col space-y-1">
            <span className="text-[0.7rem] uppercase text-muted-foreground">
              {formattedLabel}
            </span>
            <div className="space-y-1.5">
              {payload.map((item: any, index: number) => {
                const config =
                  chartConfig[item.name as keyof typeof chartConfig];
                const value = item.value;
                const formattedValue =
                  item.name === "revenue"
                    ? `৳${Number(value).toLocaleString()}`
                    : Number(value).toLocaleString();

                return (
                  <div
                    key={`${item.name}-${index}`}
                    className="flex items-center gap-1.5"
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-[0.2rem]"
                      style={{ backgroundColor: item.color || config.color }}
                    />
                    <div className="flex flex-1 justify-between leading-none">
                      <span className="text-muted-foreground text-xs">
                        {config.label}
                      </span>
                      <span className="font-bold text-foreground text-xs tabular-nums">
                        {formattedValue}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
};

export function DashboardStats({
  totalProducts,
  totalCustomers,
  currentMonth,
  initialDailyData,
}: DashboardStatsProps & { currentMonth: { customerGrowth?: number } }) {

  const [timeRange, setTimeRange] = React.useState("90d");
  const [isMounted, setIsMounted] = React.useState(false);

  const filteredData = React.useMemo(() => {
    const days = parseInt(timeRange.replace("d", ""), 10);
    return initialDailyData.slice(-days);
  }, [initialDailyData, timeRange]);

  React.useEffect(() => {
    setIsMounted(true);
  }, [filteredData, timeRange]);

  return (
    <div className="space-y-6">
      <motion.div
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-6"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        <motion.div variants={cardVariants}>
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
        </motion.div>
        <motion.div variants={cardVariants}>
          <StatsCard
            title="Monthly Revenue"
            value={`৳${currentMonth.revenue.toLocaleString()}`}
            description="Revenue this month"
            icon={<DollarSign className="h-5 w-5" />}
            trend={{
              value: currentMonth.revenueGrowth,
              isPositive: currentMonth.revenueGrowth >= 0,
            }}
          />
        </motion.div>
        <motion.div variants={cardVariants}>
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
        </motion.div>
        <motion.div variants={cardVariants}>
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
        </motion.div>
      </motion.div>

      <Card>
        <CardHeader className="flex flex-col items-start gap-2 space-y-0 border-b py-5 sm:flex-row sm:items-center sm:gap-4">
          <div className="grid flex-1 gap-1 text-left">
            <CardTitle>Daily Activity</CardTitle>
            <CardDescription>Showing daily orders and revenue</CardDescription>
          </div>
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger
              className="w-[160px] rounded-lg sm:ml-auto"
              aria-label="Select time range"
            >
              <SelectValue placeholder="Select range" />
            </SelectTrigger>
            <SelectContent className="rounded-xl bg-background">
              <SelectItem value="90d" className="rounded-lg">
                Last 90 days
              </SelectItem>
              <SelectItem value="30d" className="rounded-lg">
                Last 30 days
              </SelectItem>
              <SelectItem value="7d" className="rounded-lg">
                Last 7 days
              </SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
          {isMounted ? (
            <ChartContainer
              config={chartConfig}
              className="aspect-auto h-[250px] w-full"
            >
              <AreaChart
                accessibilityLayer
                data={filteredData}
                margin={{
                  left: 12,
                  right: 12,
                }}
              >
                <defs>
                  <linearGradient id="fillOrders" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="5%"
                      stopColor="var(--color-orders)"
                      stopOpacity={0.8}
                    />
                    <stop
                      offset="95%"
                      stopColor="var(--color-orders)"
                      stopOpacity={0.1}
                    />
                  </linearGradient>
                  <linearGradient id="fillRevenue" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="5%"
                      stopColor="var(--color-revenue)"
                      stopOpacity={0.8}
                    />
                    <stop
                      offset="95%"
                      stopColor="var(--color-revenue)"
                      stopOpacity={0.1}
                    />
                  </linearGradient>
                  <linearGradient
                    id="fillNewCustomers"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop
                      offset="5%"
                      stopColor="var(--color-newCustomers)"
                      stopOpacity={0.8}
                    />
                    <stop
                      offset="95%"
                      stopColor="var(--color-newCustomers)"
                      stopOpacity={0.1}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={32}
                  tickFormatter={(value) => {
                    const date = new Date(value);
                    return date.toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    });
                  }}
                />
                <YAxis
                  yAxisId="left"
                  dataKey="revenue"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tickFormatter={(value) => `৳${Number(value) / 1000}k`}
                  domain={["auto", "auto"]}
                />
                <YAxis
                  yAxisId="right"
                  dataKey="orders"
                  orientation="right"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  domain={["auto", "auto"]}
                />
                <ChartTooltip
                  cursor={false}
                  content={<CustomTooltipContent />}
                />
                <Area
                  dataKey="revenue"
                  type="natural"
                  fill="url(#fillRevenue)"
                  stroke="var(--color-revenue)"
                  yAxisId="left"
                />
                <Area
                  dataKey="orders"
                  type="natural"
                  fill="url(#fillOrders)"
                  stroke="var(--color-orders)"
                  yAxisId="right"
                />
                <Area
                  dataKey="newCustomers"
                  type="natural"
                  fill="url(#fillNewCustomers)"
                  stroke="var(--color-newCustomers)"
                  yAxisId="right"
                />
                <ChartLegend content={<ChartLegendContent />} />
              </AreaChart>
            </ChartContainer>
          ) : (
            <div className="aspect-auto h-[250px] w-full flex items-center justify-center text-sm text-muted-foreground">
              Loading Chart...
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
