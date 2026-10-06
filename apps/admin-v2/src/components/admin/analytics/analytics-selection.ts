// The date range, comparison and grouping an analytics page shows: read from
// the page URL (shareable), else from this browser's last choice for this
// staff member, else the last 30 days against the period before. A preset is
// saved as the preset, so "Last 30 days" still means the last 30 days
// tomorrow; a custom range is saved as its dates.
import {
  ANALYTICS_COMPARISONS,
  ANALYTICS_GRANULARITIES,
  ANALYTICS_PRESETS,
  analyticsPresetFor,
  analyticsPresetRange,
  analyticsToday,
  isAnalyticsDateKey,
  resolveAnalyticsGranularity,
  validateAnalyticsRange,
  type AnalyticsComparison,
  type AnalyticsGranularity,
  type AnalyticsPreset,
  type AnalyticsRange,
} from "@scalius/shared/analytics-period";
import { getStoreTimeZone } from "~/lib/store-time-zone";

export interface AnalyticsSelection extends AnalyticsRange {
  comparison: AnalyticsComparison;
  /** A chosen grouping; null groups by the range's default. */
  granularity: AnalyticsGranularity | null;
}

/** The URL search of an analytics page (all optional). */
export interface AnalyticsSearch {
  from?: string;
  to?: string;
  comparison?: AnalyticsComparison;
  granularity?: AnalyticsGranularity;
}

interface SavedSelection {
  preset: AnalyticsPreset | null;
  from: string;
  to: string;
  comparison: AnalyticsComparison;
  granularity: AnalyticsGranularity | null;
}

const STORAGE_PREFIX = "scalius.analytics.selection.";
export const DEFAULT_ANALYTICS_PRESET: AnalyticsPreset = "last_30_days";

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

function storageKey(userId: string | null | undefined): string {
  return `${STORAGE_PREFIX}${userId || "anonymous"}`;
}

export function readSavedSelection(userId: string | null | undefined, today: string): AnalyticsSelection | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(userId)) ?? "null");
    if (!value || typeof value !== "object") return null;
    const saved = value as Partial<SavedSelection>;
    const comparison = isOneOf(ANALYTICS_COMPARISONS, saved.comparison) ? saved.comparison : "previous_period";
    const granularity = isOneOf(ANALYTICS_GRANULARITIES, saved.granularity) ? saved.granularity : null;
    if (isOneOf(ANALYTICS_PRESETS, saved.preset)) {
      return { ...analyticsPresetRange(saved.preset, today), comparison, granularity };
    }
    const range = validateAnalyticsRange({ from: saved.from, to: saved.to });
    return { ...range, comparison, granularity };
  } catch {
    // Storage blocked or a stale shape: the default applies.
    return null;
  }
}

export function writeSavedSelection(userId: string | null | undefined, selection: AnalyticsSelection, today: string): void {
  const saved: SavedSelection = {
    preset: analyticsPresetFor(selection, today),
    from: selection.from,
    to: selection.to,
    comparison: selection.comparison,
    granularity: selection.granularity,
  };
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(saved));
  } catch {
    // Storage blocked: the choice lasts while the page is open.
  }
}

export function defaultAnalyticsSelection(today: string): AnalyticsSelection {
  return { ...analyticsPresetRange(DEFAULT_ANALYTICS_PRESET, today), comparison: "previous_period", granularity: null };
}

/** The URL wins, then the saved choice, then the default; parts missing from the URL come from the saved choice. */
export function resolveAnalyticsSelection(
  search: AnalyticsSearch,
  saved: AnalyticsSelection | null,
  today: string = analyticsToday(getStoreTimeZone()),
): AnalyticsSelection {
  const base = saved ?? defaultAnalyticsSelection(today);
  return {
    from: search.from ?? base.from,
    to: search.to ?? base.to,
    comparison: search.comparison ?? base.comparison,
    granularity: search.granularity ?? base.granularity,
  };
}

/** The grouping the page will show (a choice the range doesn't allow falls back to its default). */
export function effectiveGranularity(selection: AnalyticsSelection): AnalyticsGranularity {
  return resolveAnalyticsGranularity(selection, selection.granularity);
}

/** The URL search for a selection: only what differs from the default stays out of the URL. */
export function analyticsSearchOf(selection: AnalyticsSelection): AnalyticsSearch {
  return {
    from: selection.from,
    to: selection.to,
    comparison: selection.comparison,
    ...(selection.granularity ? { granularity: selection.granularity } : {}),
  };
}
