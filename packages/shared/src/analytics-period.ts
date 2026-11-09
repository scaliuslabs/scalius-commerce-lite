// Analytics periods on the merchant calendar (the store's time zone): inclusive
// YYYY-MM-DD ranges, comparison periods, presets and day/week/month buckets.
// Date keys are zone-free; only `analyticsInstantRange` and `analyticsToday`
// read the zone. Pure and host-timezone independent, shared by the API (which
// validates and queries) and the dashboard (which picks and labels ranges).
import {
  commerceCalendarDateKey,
  commerceDayStart,
  shiftCommerceCalendarDateKey,
} from "./commerce-time";
import type { WeekDay } from "./week-start";

// The range rules (date keys, the two-year limit, the choice lists) live in
// ./analytics-range, so a page that only validates a range in its URL does
// not load the calendar arithmetic below.
export {
  ANALYTICS_COMPARISONS,
  ANALYTICS_GRANULARITIES,
  ANALYTICS_MAX_DAY_BUCKETS,
  ANALYTICS_MAX_RANGE_DAYS,
  ANALYTICS_PRESETS,
  analyticsDateKeyFromEpochDay,
  analyticsEpochDay,
  analyticsRangeDays,
  isAnalyticsDateKey,
  validateAnalyticsRange,
  type AnalyticsComparison,
  type AnalyticsGranularity,
  type AnalyticsPreset,
  type AnalyticsRange,
} from "./analytics-range";
import {
  ANALYTICS_MAX_DAY_BUCKETS,
  ANALYTICS_PRESETS,
  DAY_SECONDS,
  analyticsDateKeyFromEpochDay,
  analyticsEpochDay,
  analyticsRangeDays,
  parseDateKey,
  type AnalyticsComparison,
  type AnalyticsGranularity,
  type AnalyticsPreset,
  type AnalyticsRange,
} from "./analytics-range";

/** A range as exact UTC epoch seconds: `[start, endExclusive)`. */
export interface AnalyticsInstantRange {
  start: number;
  endExclusive: number;
}

export interface AnalyticsBucket {
  /** Stable key: the bucket's first merchant day (YYYY-MM-DD). */
  key: string;
  /** First and last merchant day of the bucket inside the range. */
  from: string;
  to: string;
}

/** Exact UTC bounds of a merchant-day range in the store's zone (daylight saving included). */
export function analyticsInstantRange(range: AnalyticsRange, timeZone: string): AnalyticsInstantRange {
  return {
    start: commerceDayStart(timeZone, range.from),
    endExclusive: commerceDayStart(timeZone, shiftCommerceCalendarDateKey(range.to, 1)),
  };
}

function shiftYear(dateKey: string, years: number): string {
  const parts = parseDateKey(dateKey)!;
  const year = parts.year + years;
  // 29 February in a year without one is 28 February.
  const lastDay = new Date(Date.UTC(year, parts.month, 0)).getUTCDate();
  const day = Math.min(parts.day, lastDay);
  return `${String(year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The period a range is compared with: the same number of days immediately
 * before it, or the same calendar days a year earlier. `none` compares nothing.
 */
export function analyticsComparisonRange(
  range: AnalyticsRange,
  comparison: AnalyticsComparison,
): AnalyticsRange | null {
  if (comparison === "none") return null;
  if (comparison === "previous_year") {
    return { from: shiftYear(range.from, -1), to: shiftYear(range.to, -1) };
  }
  const days = analyticsRangeDays(range);
  const to = shiftCommerceCalendarDateKey(range.from, -1);
  return { from: shiftCommerceCalendarDateKey(to, -(days - 1)), to };
}

/** Today in the merchant calendar. */
export function analyticsToday(timeZone: string, now: Date | number = new Date()): string {
  return commerceCalendarDateKey(timeZone, now);
}

export function analyticsPresetRange(preset: AnalyticsPreset, today: string): AnalyticsRange {
  const parts = parseDateKey(today);
  if (!parts) throw new RangeError("A valid YYYY-MM-DD date is required.");
  const shift = (days: number) => shiftCommerceCalendarDateKey(today, days);
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: shift(-1), to: shift(-1) };
    case "last_7_days":
      return { from: shift(-6), to: today };
    case "last_30_days":
      return { from: shift(-29), to: today };
    case "last_90_days":
      return { from: shift(-89), to: today };
    case "month_to_date":
      return { from: monthStart, to: today };
    case "last_month": {
      const to = shiftCommerceCalendarDateKey(monthStart, -1);
      return { from: `${to.slice(0, 7)}-01`, to };
    }
    case "year_to_date":
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case "last_365_days":
      return { from: shift(-364), to: today };
  }
}

/** The preset a range equals today, if any (labels "Last 30 days" instead of dates). */
export function analyticsPresetFor(range: AnalyticsRange, today: string): AnalyticsPreset | null {
  for (const preset of ANALYTICS_PRESETS) {
    const candidate = analyticsPresetRange(preset, today);
    if (candidate.from === range.from && candidate.to === range.to) return preset;
  }
  return null;
}

/** Granularities a range can be bucketed by (day buckets stop at three months). */
export function analyticsGranularities(range: AnalyticsRange): AnalyticsGranularity[] {
  return analyticsRangeDays(range) <= ANALYTICS_MAX_DAY_BUCKETS
    ? ["day", "week", "month"]
    : ["week", "month"];
}

/** Days up to three months, weeks up to a year, then months. */
export function defaultAnalyticsGranularity(range: AnalyticsRange): AnalyticsGranularity {
  const days = analyticsRangeDays(range);
  if (days <= ANALYTICS_MAX_DAY_BUCKETS) return "day";
  if (days <= 366) return "week";
  return "month";
}

/** A requested granularity, or the default when it is missing or not allowed. */
export function resolveAnalyticsGranularity(
  range: AnalyticsRange,
  requested?: string | null,
): AnalyticsGranularity {
  const allowed = analyticsGranularities(range);
  return requested && (allowed as string[]).includes(requested)
    ? requested as AnalyticsGranularity
    : defaultAnalyticsGranularity(range);
}

/**
 * What a week's first day adds to an epoch day before `% 7`: 1970-01-01 was a
 * Thursday, so `(day + offset) % 7` counts days since the week began. Sunday
 * (0, Bangladesh's and the US's first day) is 4.
 */
export function analyticsWeekOffset(weekStart: WeekDay): number {
  return (11 - weekStart) % 7;
}

/**
 * The first day of the week containing an epoch day. Weeks start on the
 * store country's CLDR first day (`weekStartDay`): Sunday by default.
 */
export function analyticsWeekStartEpochDay(epochDay: number, weekStart: WeekDay = 0): number {
  return epochDay - ((epochDay + analyticsWeekOffset(weekStart)) % 7);
}

/** The first merchant day of the bucket containing a merchant day. */
export function analyticsBucketKey(dateKey: string, granularity: AnalyticsGranularity, weekStart: WeekDay = 0): string {
  if (granularity === "day") return dateKey;
  if (granularity === "month") return `${dateKey.slice(0, 7)}-01`;
  return analyticsDateKeyFromEpochDay(analyticsWeekStartEpochDay(analyticsEpochDay(dateKey), weekStart));
}

/** Every bucket of a range in order, each clipped to the range. */
export function analyticsBuckets(range: AnalyticsRange, granularity: AnalyticsGranularity, weekStart: WeekDay = 0): AnalyticsBucket[] {
  const first = analyticsEpochDay(range.from);
  const last = analyticsEpochDay(range.to);
  const buckets: AnalyticsBucket[] = [];
  let current: AnalyticsBucket | null = null;
  for (let day = first; day <= last; day += 1) {
    const dateKey = analyticsDateKeyFromEpochDay(day);
    const key = analyticsBucketKey(dateKey, granularity, weekStart);
    if (!current || current.key !== key) {
      current = { key, from: dateKey, to: dateKey };
      buckets.push(current);
    } else {
      current.to = dateKey;
    }
  }
  return buckets;
}

/** Percentage change, or null when there is no baseline to compare with. */
export function analyticsChange(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}
