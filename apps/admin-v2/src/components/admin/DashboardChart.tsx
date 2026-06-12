import React from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../ui/card";
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
import { formatDateShort } from "@scalius/shared/timestamps";
import {
  getDailyActivityDataForRange,
  hasDailyActivityData,
  type DailyActivityDataPoint,
} from "./dashboard-chart-data";

interface DashboardChartProps {
  initialDailyData: DailyActivityDataPoint[];
  symbol: string;
  chartConfig: ChartConfig;
}

// Custom Tooltip Content Component
const CustomTooltipContent = ({
  active,
  payload,
  label,
  symbol = "\u09F3",
  chartConfig,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color?: string }>;
  label?: string;
  symbol?: string;
  chartConfig: ChartConfig;
}) => {
  if (active && payload && payload.length) {
    const formattedLabel = label ? formatDateShort(label) : String(label ?? "");

    return (
      <div className="rounded-lg border bg-background p-2 shadow-sm">
        <div className="grid grid-cols-1 gap-2">
          <div className="flex flex-col space-y-1">
            <span className="text-[0.7rem] uppercase text-muted-foreground">
              {formattedLabel}
            </span>
            <div className="space-y-1.5">
              {payload.map((item, index: number) => {
                const config = chartConfig[item.name as string];
                const value = item.value;
                const formattedValue =
                  item.name === "revenue"
                    ? `${symbol}${Number(value).toLocaleString()}`
                    : Number(value).toLocaleString();

                return (
                  <div
                    key={`${item.name}-${index}`}
                    className="flex items-center gap-1.5"
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-[0.2rem]"
                      style={{
                        backgroundColor:
                          item.color || (config as { color?: string })?.color,
                      }}
                    />
                    <div className="flex flex-1 justify-between leading-none">
                      <span className="text-muted-foreground text-xs">
                        {(config as { label?: string })?.label}
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

const DailyActivityEmptyState = () => (
  <div className="flex h-[250px] w-full items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 px-6 text-center">
    <div className="space-y-1">
      <p className="text-sm font-medium text-foreground">
        No daily activity yet
      </p>
      <p className="text-xs text-muted-foreground">
        Orders, revenue, and customer activity will appear here once recorded.
      </p>
    </div>
  </div>
);

export function DashboardChart({
  initialDailyData,
  symbol,
  chartConfig,
}: DashboardChartProps) {
  const [timeRange, setTimeRange] = React.useState("90d");
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const filteredData = React.useMemo(() => {
    return getDailyActivityDataForRange(initialDailyData, timeRange);
  }, [initialDailyData, timeRange]);
  const hasChartData = hasDailyActivityData(filteredData);

  return (
    <Card className="min-w-0">
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
        {!mounted ? (
          <div className="h-[250px] w-full animate-pulse rounded-lg bg-muted" />
        ) : !hasChartData ? (
          <DailyActivityEmptyState />
        ) : (
          <ChartContainer
            config={chartConfig}
            className="aspect-auto h-[250px] min-h-[250px] w-full min-w-[1px]"
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
                tickFormatter={(value) => `${symbol}${Number(value) / 1000}k`}
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
                content={
                  <CustomTooltipContent
                    symbol={symbol}
                    chartConfig={chartConfig}
                  />
                }
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
        )}
      </CardContent>
    </Card>
  );
}
