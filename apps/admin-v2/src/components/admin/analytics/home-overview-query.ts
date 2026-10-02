// Home's sales strip read, apart from the strip itself: the Home route's
// loader starts it, and the loader is part of the dashboard's first download,
// so it must not pull the chart, the tiles or the analytics copy in with it.
import {
  analyticsPresetRange,
  analyticsToday,
  defaultAnalyticsGranularity,
  type AnalyticsPreset,
} from "@scalius/shared/analytics-period";
import { analyticsOverviewQueryOptions } from "~/lib/api-query-options/analytics";

/** Home's overview read for a preset: the same numbers the Analytics page shows. */
export function homeOverviewQuery(preset: AnalyticsPreset, today: string = analyticsToday()) {
  const range = analyticsPresetRange(preset, today);
  return analyticsOverviewQueryOptions({
    ...range,
    comparison: "previous_period",
    granularity: defaultAnalyticsGranularity(range),
  });
}
