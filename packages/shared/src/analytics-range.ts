// Analytics ranges on the merchant calendar: inclusive YYYY-MM-DD date keys,
// the two-year limit, and the comparison, grouping and preset choices. The
// calendar arithmetic (presets, comparisons, buckets, the store's zone) is in
// ./analytics-period, which re-exports all of this.

/** Seconds in a calendar day (date keys are zone-free). */
export const DAY_SECONDS = 86_400;
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The longest range a report reads: two years and a day (a leap year pair). */
export const ANALYTICS_MAX_RANGE_DAYS = 731;
/**
 * Day buckets stop at about three months; longer ranges bucket by week (at
 * most 105 for two years) or month. This keeps a whole overview, both periods
 * and every bucket, inside one 64 KB agent response.
 */
export const ANALYTICS_MAX_DAY_BUCKETS = 92;

export const ANALYTICS_COMPARISONS = ["previous_period", "previous_year", "none"] as const;
export type AnalyticsComparison = (typeof ANALYTICS_COMPARISONS)[number];

export const ANALYTICS_GRANULARITIES = ["day", "week", "month"] as const;
export type AnalyticsGranularity = (typeof ANALYTICS_GRANULARITIES)[number];

export const ANALYTICS_PRESETS = [
  "today",
  "yesterday",
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "month_to_date",
  "last_month",
  "year_to_date",
  "last_365_days",
] as const;
export type AnalyticsPreset = (typeof ANALYTICS_PRESETS)[number];

/** An inclusive range of merchant calendar days. */
export interface AnalyticsRange {
  from: string;
  to: string;
}

/** A date key's parts, or null when it is not a real calendar day. */
export function parseDateKey(value: string): { year: number; month: number; day: number } | null {
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? { year, month, day }
    : null;
}

export function isAnalyticsDateKey(value: unknown): value is string {
  return typeof value === "string" && parseDateKey(value) !== null;
}

/** Days since 1970-01-01 of a merchant date key. */
export function analyticsEpochDay(dateKey: string): number {
  const parts = parseDateKey(dateKey);
  if (!parts) throw new RangeError("A valid YYYY-MM-DD date is required.");
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / (DAY_SECONDS * 1000));
}

/** The merchant date key of an epoch day. */
export function analyticsDateKeyFromEpochDay(epochDay: number): string {
  return new Date(epochDay * DAY_SECONDS * 1000).toISOString().slice(0, 10);
}

export function analyticsRangeDays(range: AnalyticsRange): number {
  return analyticsEpochDay(range.to) - analyticsEpochDay(range.from) + 1;
}

/**
 * A valid range: real dates, `from <= to`, at most two years. Throws a
 * RangeError naming the problem (the API turns it into a 400).
 */
export function validateAnalyticsRange(range: { from?: unknown; to?: unknown }): AnalyticsRange {
  if (!isAnalyticsDateKey(range.from) || !isAnalyticsDateKey(range.to)) {
    throw new RangeError("Dates must be real calendar days written YYYY-MM-DD.");
  }
  const days = analyticsEpochDay(range.to) - analyticsEpochDay(range.from) + 1;
  if (days < 1) throw new RangeError("The start date must be on or before the end date.");
  if (days > ANALYTICS_MAX_RANGE_DAYS) {
    throw new RangeError(`A report covers at most ${ANALYTICS_MAX_RANGE_DAYS} days.`);
  }
  return { from: range.from, to: range.to };
}
