// An analytics page's URL search, validated as the route tree reads it (the
// route tree is always loaded, so this stays apart from the saved choice and
// calendar arithmetic in ./analytics-selection).
import {
  ANALYTICS_COMPARISONS,
  ANALYTICS_GRANULARITIES,
  isAnalyticsDateKey,
  validateAnalyticsRange,
  type AnalyticsComparison,
  type AnalyticsGranularity,
} from "@scalius/shared/analytics-range";

/** The URL search of an analytics page (all optional). */
export interface AnalyticsSearch {
  from?: string;
  to?: string;
  comparison?: AnalyticsComparison;
  granularity?: AnalyticsGranularity;
}

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

export function validateAnalyticsSearch(search: Record<string, unknown>): AnalyticsSearch {
  const result: AnalyticsSearch = {};
  if (isAnalyticsDateKey(search.from) && isAnalyticsDateKey(search.to)) {
    try {
      const range = validateAnalyticsRange({ from: search.from, to: search.to });
      result.from = range.from;
      result.to = range.to;
    } catch {
      // An impossible range in a shared link falls back to the saved one.
    }
  }
  if (isOneOf(ANALYTICS_COMPARISONS, search.comparison)) result.comparison = search.comparison;
  if (isOneOf(ANALYTICS_GRANULARITIES, search.granularity)) result.granularity = search.granularity;
  return result;
}
