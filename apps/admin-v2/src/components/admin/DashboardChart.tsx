import React from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { formatDateShort } from "@scalius/shared/timestamps";
import {
  getDailyActivityDataForRange,
  hasDailyActivityData,
  type DailyActivityDataPoint,
} from "./dashboard-chart-data";

type DashboardChartSeriesKey = "revenue" | "orders" | "newCustomers";

export type DashboardChartConfig = Record<
  DashboardChartSeriesKey,
  {
    label: string;
    color: string;
  }
>;

interface DashboardChartProps {
  initialDailyData: DailyActivityDataPoint[];
  symbol: string;
  chartConfig: DashboardChartConfig;
}

type ChartPoint = {
  x: number;
  y: number;
};

type ChartSeries = {
  key: DashboardChartSeriesKey;
  axis: "revenue" | "count";
};

type DashboardChartModel = {
  gridTicks: Array<{
    y: number;
    revenueValue: number;
    countValue: number;
  }>;
  seriesPoints: Record<DashboardChartSeriesKey, ChartPoint[]>;
  xTicks: Array<{
    index: number;
    x: number;
    label: string;
  }>;
};

type ActivePoint = {
  index: number;
  point: DailyActivityDataPoint;
  x: number;
  y: number;
};

type ChartKeyboardKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

const chartSeries = [
  { key: "revenue", axis: "revenue" },
  { key: "orders", axis: "count" },
  { key: "newCustomers", axis: "count" },
] as const satisfies readonly ChartSeries[];

const fallbackChartWidth = 800;
const minChartWidth = 320;
const chartHeight = 214;
const plotLeft = 62;
const plotRight = 54;
const plotTop = 12;
const plotBottom = 174;
const plotHeight = plotBottom - plotTop;
const xAxisLabelY = 204;
const gridTickCount = 4;
const chartKeyboardKeys = new Set<ChartKeyboardKey>([
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);

function normalizeChartWidth(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return fallbackChartWidth;
  }

  return Math.max(minChartWidth, Math.round(value));
}

function getPlotWidth(chartWidth: number) {
  return Math.max(80, chartWidth - plotLeft - plotRight);
}

function getPlotRightX(chartWidth: number) {
  return plotLeft + getPlotWidth(chartWidth);
}

function getPointValue(
  point: DailyActivityDataPoint,
  key: DashboardChartSeriesKey,
) {
  const value = point[key];

  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function toPathNumber(value: number) {
  const safeValue = Number.isFinite(value) ? value : 0;

  return Number.isInteger(safeValue) ? String(safeValue) : safeValue.toFixed(2);
}

function formatAxisDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatCompactNumber(value: number) {
  const absValue = Math.abs(value);

  if (absValue >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(1)).toLocaleString()}m`;
  }

  if (absValue >= 1_000) {
    return `${Number((value / 1_000).toFixed(1)).toLocaleString()}k`;
  }

  return Number(value.toFixed(1)).toLocaleString();
}

function formatCurrencyTick(value: number, symbol: string) {
  return `${symbol}${formatCompactNumber(value)}`;
}

function formatTooltipValue(
  key: DashboardChartSeriesKey,
  value: number,
  symbol: string,
) {
  const safeValue = Number.isFinite(value) ? value : 0;

  return key === "revenue"
    ? `${symbol}${Number(safeValue).toLocaleString()}`
    : Number(safeValue).toLocaleString();
}

function getNiceMax(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }

  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const niceNormalized =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;

  return niceNormalized * magnitude;
}

function getXForIndex(
  index: number,
  total: number,
  chartWidth = fallbackChartWidth,
) {
  const plotWidth = getPlotWidth(chartWidth);

  if (total <= 1) {
    return plotLeft + plotWidth / 2;
  }

  return plotLeft + (index / (total - 1)) * plotWidth;
}

function getYForValue(value: number, max: number) {
  const safeMax = max > 0 ? max : 1;
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  const ratio = Math.max(0, Math.min(1, safeValue / safeMax));

  return plotBottom - ratio * plotHeight;
}

function getXAxisTickIndexes(total: number) {
  if (total <= 0) {
    return [];
  }

  const maxTicks = total <= 7 ? total : 6;

  if (total <= maxTicks) {
    return Array.from({ length: total }, (_, index) => index);
  }

  return Array.from(
    new Set(
      Array.from({ length: maxTicks }, (_, index) =>
        Math.round((index / (maxTicks - 1)) * (total - 1)),
      ),
    ),
  );
}

function getHitArea(
  index: number,
  total: number,
  chartWidth = fallbackChartWidth,
) {
  const x = getXForIndex(index, total, chartWidth);
  const plotWidth = getPlotWidth(chartWidth);

  if (total <= 1) {
    return {
      x: plotLeft,
      width: plotWidth,
    };
  }

  const step = plotWidth / (total - 1);
  const start = index === 0 ? plotLeft : x - step / 2;
  const end = index === total - 1 ? plotLeft + plotWidth : x + step / 2;

  return {
    x: start,
    width: end - start,
  };
}

export function buildSmoothPath(points: readonly ChartPoint[]) {
  if (points.length === 0) {
    return "";
  }

  const [firstPoint] = points;
  if (!firstPoint) {
    return "";
  }

  let path = `M ${toPathNumber(firstPoint.x)} ${toPathNumber(firstPoint.y)}`;

  if (points.length === 1) {
    return path;
  }

  for (let index = 1; index < points.length; index += 1) {
    const currentPoint = points[index - 1];
    const nextPoint = points[index];

    if (!currentPoint || !nextPoint) {
      continue;
    }

    const previousPoint = points[index - 2] ?? currentPoint;
    const followingPoint = points[index + 1] ?? nextPoint;
    const controlPointOne = {
      x: currentPoint.x + (nextPoint.x - previousPoint.x) / 6,
      y: currentPoint.y + (nextPoint.y - previousPoint.y) / 6,
    };
    const controlPointTwo = {
      x: nextPoint.x - (followingPoint.x - currentPoint.x) / 6,
      y: nextPoint.y - (followingPoint.y - currentPoint.y) / 6,
    };

    path += ` C ${toPathNumber(controlPointOne.x)} ${toPathNumber(controlPointOne.y)}, ${toPathNumber(controlPointTwo.x)} ${toPathNumber(controlPointTwo.y)}, ${toPathNumber(nextPoint.x)} ${toPathNumber(nextPoint.y)}`;
  }

  return path;
}

function buildAreaPath(points: readonly ChartPoint[]) {
  const linePath = buildSmoothPath(points);

  if (!linePath) {
    return "";
  }

  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];

  if (!firstPoint || !lastPoint) {
    return "";
  }

  return `${linePath} L ${toPathNumber(lastPoint.x)} ${plotBottom} L ${toPathNumber(firstPoint.x)} ${plotBottom} Z`;
}

export function buildDashboardChartModel(
  dailyData: readonly DailyActivityDataPoint[],
  chartWidth = fallbackChartWidth,
): DashboardChartModel {
  const revenueMax = getNiceMax(
    Math.max(0, ...dailyData.map((item) => getPointValue(item, "revenue"))),
  );
  const countMax = getNiceMax(
    Math.max(
      0,
      ...dailyData.flatMap((item) => [
        getPointValue(item, "orders"),
        getPointValue(item, "newCustomers"),
      ]),
    ),
  );
  const seriesPoints = chartSeries.reduce(
    (accumulator, series) => {
      const max = series.axis === "revenue" ? revenueMax : countMax;

      accumulator[series.key] = dailyData.map((item, index) => ({
        x: getXForIndex(index, dailyData.length, chartWidth),
        y: getYForValue(getPointValue(item, series.key), max),
      }));

      return accumulator;
    },
    {
      revenue: [],
      orders: [],
      newCustomers: [],
    } as Record<DashboardChartSeriesKey, ChartPoint[]>,
  );

  return {
    gridTicks: Array.from({ length: gridTickCount + 1 }, (_, index) => {
      const ratio = index / gridTickCount;

      return {
        y: plotBottom - ratio * plotHeight,
        revenueValue: revenueMax * ratio,
        countValue: countMax * ratio,
      };
    }),
    seriesPoints,
    xTicks: getXAxisTickIndexes(dailyData.length).map((index) => ({
      index,
      x: getXForIndex(index, dailyData.length, chartWidth),
      label: formatAxisDate(dailyData[index]?.date ?? ""),
    })),
  };
}

export function formatDashboardChartPointLabel(
  point: DailyActivityDataPoint,
  symbol: string,
  chartConfig: DashboardChartConfig,
) {
  const values = chartSeries
    .map((series) => {
      const label = chartConfig[series.key].label;
      const value = formatTooltipValue(
        series.key,
        getPointValue(point, series.key),
        symbol,
      );

      return `${label}: ${value}`;
    })
    .join(", ");

  return `${formatDateShort(point.date)}. ${values}`;
}

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

function DailyActivityTooltip({
  activePoint,
  chartConfig,
  chartWidth,
  symbol,
}: {
  activePoint: ActivePoint;
  chartConfig: DashboardChartConfig;
  chartWidth: number;
  symbol: string;
}) {
  const tooltipX = Math.min(Math.max(activePoint.x, 112), chartWidth - 112);
  const isNearTop = activePoint.y < 72;
  const tooltipY = isNearTop
    ? Math.min(activePoint.y + 10, chartHeight - 18)
    : Math.max(activePoint.y - 12, 18);

  return (
    <div
      className={`pointer-events-none absolute z-10 min-w-[11rem] -translate-x-1/2 rounded-lg border bg-background p-2 shadow-sm ${
        isNearTop ? "translate-y-2" : "-translate-y-full"
      }`}
      style={{
        left: tooltipX,
        top: tooltipY,
      }}
    >
      <div className="flex flex-col space-y-1">
        <span className="text-[0.7rem] uppercase text-muted-foreground">
          {formatDateShort(activePoint.point.date)}
        </span>
        <div className="space-y-1.5">
          {chartSeries.map((series) => {
            const config = chartConfig[series.key];

            return (
              <div key={series.key} className="flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-[0.2rem]"
                  style={{ backgroundColor: config.color }}
                />
                <div className="flex flex-1 justify-between gap-3 leading-none">
                  <span className="text-xs text-muted-foreground">
                    {config.label}
                  </span>
                  <span className="text-xs font-bold tabular-nums text-foreground">
                    {formatTooltipValue(
                      series.key,
                      getPointValue(activePoint.point, series.key),
                      symbol,
                    )}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DailyActivitySvgChart({
  data,
  chartConfig,
  symbol,
}: {
  data: DailyActivityDataPoint[];
  chartConfig: DashboardChartConfig;
  symbol: string;
}) {
  const titleId = React.useId();
  const descriptionId = React.useId();
  const gradientRootId = React.useId().replace(/:/g, "");
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [chartWidth, setChartWidth] = React.useState(fallbackChartWidth);
  const [activePoint, setActivePoint] = React.useState<ActivePoint | null>(
    null,
  );
  const model = React.useMemo(
    () => buildDashboardChartModel(data, chartWidth),
    [chartWidth, data],
  );
  const plotWidth = getPlotWidth(chartWidth);
  const plotRightX = getPlotRightX(chartWidth);

  React.useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const updateWidth = () => {
      setChartWidth(normalizeChartWidth(container.getBoundingClientRect().width));
    };

    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }

    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);

    return () => observer.disconnect();
  }, []);

  const showTooltip = React.useCallback(
    (index: number) => {
      const point = data[index];

      if (!point) {
        return;
      }

      const activeSeriesPoints = chartSeries
        .map((series) => model.seriesPoints[series.key][index])
        .filter((seriesPoint): seriesPoint is ChartPoint => Boolean(seriesPoint));

      if (!activeSeriesPoints.length) {
        return;
      }

      const y = Math.min(...activeSeriesPoints.map((seriesPoint) => seriesPoint.y));

      setActivePoint({
        index,
        point,
        x: getXForIndex(index, data.length, chartWidth),
        y,
      });
    },
    [chartWidth, data, model],
  );
  const handleKeyboardNavigation = React.useCallback(
    (event: React.KeyboardEvent<SVGRectElement>) => {
      if (!chartKeyboardKeys.has(event.key as ChartKeyboardKey) || !data.length) {
        return;
      }

      event.preventDefault();

      const currentIndex = activePoint?.index ?? 0;
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? data.length - 1
            : event.key === "ArrowLeft"
              ? Math.max(0, currentIndex - 1)
              : Math.min(data.length - 1, currentIndex + 1);

      showTooltip(nextIndex);
    },
    [activePoint?.index, data.length, showTooltip],
  );
  const activePointLabel = activePoint
    ? `${formatDashboardChartPointLabel(activePoint.point, symbol, chartConfig)} Use left and right arrows to inspect nearby dates.`
    : "Daily activity chart. Use left and right arrows to inspect dates.";

  return (
    <div ref={containerRef} className="relative h-[250px] w-full min-w-[1px]">
      {activePoint ? (
        <DailyActivityTooltip
          activePoint={activePoint}
          chartConfig={chartConfig}
          chartWidth={chartWidth}
          symbol={symbol}
        />
      ) : null}
      <svg
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        className="h-[214px] w-full overflow-visible text-xs"
        height={chartHeight}
        role="img"
        width="100%"
      >
        <title id={titleId}>Daily activity chart</title>
        <desc id={descriptionId}>
          Daily revenue, orders, and new customers for the selected date range.
          Focus the plot area and use arrow keys to hear exact values.
        </desc>
        <defs>
          {chartSeries.map((series) => (
            <linearGradient
              key={series.key}
              id={`${gradientRootId}-${series.key}`}
              x1="0"
              x2="0"
              y1="0"
              y2="1"
            >
              <stop
                offset="5%"
                stopColor={chartConfig[series.key].color}
                stopOpacity={0.22}
              />
              <stop
                offset="95%"
                stopColor={chartConfig[series.key].color}
                stopOpacity={0.04}
              />
            </linearGradient>
          ))}
        </defs>

        {model.gridTicks.map((tick, index) => (
          <g key={index}>
            <line
              stroke="var(--border)"
              strokeOpacity={0.7}
              strokeWidth={1}
              x1={plotLeft}
              x2={plotRightX}
              y1={tick.y}
              y2={tick.y}
            />
            <text
              dominantBaseline="middle"
              fill="var(--muted-foreground)"
              fontSize={11}
              textAnchor="end"
              x={plotLeft - 10}
              y={tick.y}
            >
              {formatCurrencyTick(tick.revenueValue, symbol)}
            </text>
            <text
              dominantBaseline="middle"
              fill="var(--muted-foreground)"
              fontSize={11}
              textAnchor="start"
              x={plotRightX + 10}
              y={tick.y}
            >
              {formatCompactNumber(tick.countValue)}
            </text>
          </g>
        ))}

        {model.xTicks.map((tick) => (
          <text
            key={`${tick.index}-${tick.label}`}
            fill="var(--muted-foreground)"
            fontSize={11}
            textAnchor="middle"
            x={tick.x}
            y={xAxisLabelY}
          >
            {tick.label}
          </text>
        ))}

        {chartSeries.map((series) => (
          <path
            key={`${series.key}-area`}
            d={buildAreaPath(model.seriesPoints[series.key])}
            fill={`url(#${gradientRootId}-${series.key})`}
            stroke="none"
          />
        ))}
        {chartSeries.map((series) => (
          <path
            key={`${series.key}-line`}
            d={buildSmoothPath(model.seriesPoints[series.key])}
            fill="none"
            stroke={chartConfig[series.key].color}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
          />
        ))}

        {activePoint ? (
          <g pointerEvents="none">
            <line
              stroke="var(--border)"
              strokeDasharray="4 4"
              strokeWidth={1}
              x1={activePoint.x}
              x2={activePoint.x}
              y1={plotTop}
              y2={plotBottom}
            />
            {chartSeries.map((series) => {
              const point = model.seriesPoints[series.key][activePoint.index];

              if (!point) {
                return null;
              }

              return (
                <circle
                  key={series.key}
                  cx={point.x}
                  cy={point.y}
                  fill="var(--background)"
                  r={3.5}
                  stroke={chartConfig[series.key].color}
                  strokeWidth={2}
                />
              );
            })}
          </g>
        ) : null}

        <rect
          aria-label={activePointLabel}
          fill="transparent"
          height={plotHeight}
          onBlur={() => setActivePoint(null)}
          onFocus={() => showTooltip(activePoint?.index ?? 0)}
          onKeyDown={handleKeyboardNavigation}
          tabIndex={0}
          width={plotWidth}
          x={plotLeft}
          y={plotTop}
          style={{ outline: "none" }}
        />

        {data.map((point, index) => {
          const hitArea = getHitArea(index, data.length, chartWidth);

          return (
            <rect
              key={`${point.date}-${index}`}
              aria-hidden="true"
              fill="transparent"
              focusable="false"
              height={plotHeight}
              onPointerEnter={() => showTooltip(index)}
              onPointerLeave={() => setActivePoint(null)}
              onPointerMove={() => showTooltip(index)}
              width={hitArea.width}
              x={hitArea.x}
              y={plotTop}
            />
          );
        })}
      </svg>
      <div className="flex flex-wrap items-center justify-center gap-4 pt-3 text-xs">
        {chartSeries.map((series) => (
          <div key={series.key} className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 shrink-0 rounded-[2px]"
              style={{ backgroundColor: chartConfig[series.key].color }}
            />
            <span className="text-muted-foreground">
              {chartConfig[series.key].label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

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
            aria-label="Select time range"
            className="w-[160px] rounded-lg sm:ml-auto"
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
          <DailyActivitySvgChart
            chartConfig={chartConfig}
            data={filteredData}
            symbol={symbol}
          />
        )}
      </CardContent>
    </Card>
  );
}
