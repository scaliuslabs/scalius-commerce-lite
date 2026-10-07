import { useMemo, type ReactNode } from "react";
import {
  ANALYTICS_COMPARISONS,
  analyticsGranularities,
  analyticsToday,
  type AnalyticsGranularity,
  type AnalyticsRange,
} from "@scalius/shared/analytics-period";
import { getStoreTimeZone } from "~/lib/store-time-zone";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { analyticsMessages } from "~/i18n/analytics";
import { AnalyticsRangePicker } from "./AnalyticsRangePicker";
import {
  analyticsSearchOf,
  effectiveGranularity,
  readSavedSelection,
  resolveAnalyticsSelection,
  writeSavedSelection,
  type AnalyticsSearch,
  type AnalyticsSelection,
} from "./analytics-selection";

/**
 * The page's selection from its URL (else this staff member's last choice in
 * this browser, else the last 30 days). `choose` saves a change for next
 * time and returns the URL search to navigate to.
 */
export function useAnalyticsSelection(search: AnalyticsSearch, userId: string | null | undefined) {
  const today = useMemo(() => analyticsToday(getStoreTimeZone()), []);
  const saved = useMemo(() => readSavedSelection(userId, today), [userId, today]);
  const selection = resolveAnalyticsSelection(search, saved, today);
  return {
    selection,
    today,
    granularity: effectiveGranularity(selection),
    choose(patch: Partial<AnalyticsSelection>): AnalyticsSearch {
      const next = { ...selection, ...patch };
      writeSavedSelection(userId, next, today);
      return analyticsSearchOf(next);
    },
  };
}

/** Filters in one row above everything they scope: range first, then comparison and grouping. */
export function AnalyticsToolbar({
  selection,
  today,
  granularity,
  showComparison = true,
  showGranularity = false,
  showRange = true,
  onChange,
  actions,
}: {
  selection: AnalyticsSelection;
  today: string;
  granularity: AnalyticsGranularity;
  showComparison?: boolean;
  showGranularity?: boolean;
  showRange?: boolean;
  onChange: (patch: Partial<AnalyticsSelection>) => void;
  actions?: ReactNode;
}) {
  const t = useMessages(analyticsMessages);
  const range: AnalyticsRange = { from: selection.from, to: selection.to };
  const comparisonOptions = ANALYTICS_COMPARISONS.map((value) => ({ value, label: t(`comparison.${value}`) }));
  const granularityOptions = analyticsGranularities(range).map((value) => ({ value, label: t(`granularity.${value}`) }));
  return (
    <div data-slot="analytics-toolbar" className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
      {showRange ? (
        <AnalyticsRangePicker
          range={range}
          today={today}
          onChange={(next) => onChange({ ...next, granularity: null })}
        />
      ) : null}
      {showRange && showComparison ? (
        <SearchableSelect
          options={comparisonOptions}
          value={selection.comparison}
          onValueChange={(value) => onChange({ comparison: value as AnalyticsSelection["comparison"] })}
          ariaLabel={t("compareTo")}
          triggerClassName="h-8 w-auto min-w-40"
        />
      ) : null}
      {showRange && showGranularity ? (
        <SearchableSelect
          options={granularityOptions}
          value={granularity}
          onValueChange={(value) => onChange({ granularity: value as AnalyticsGranularity })}
          ariaLabel={t("groupBy")}
          triggerClassName="h-8 w-auto min-w-28"
        />
      ) : null}
      {actions ? <div className="ms-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
