import { describe, expect, it } from "vitest";
import { ANALYTICS_ENUM_VALUES, ANALYTICS_REPORT_CATEGORIES, ANALYTICS_REPORTS } from "@scalius/shared/analytics-reports";
import { ANALYTICS_PRESETS, ANALYTICS_COMPARISONS, ANALYTICS_GRANULARITIES } from "@scalius/shared/analytics-period";
import { analyticsMessages } from "~/i18n/analytics";

describe("analytics words", () => {
  it("names every report, column, category, preset and enum value in English and Bangla", () => {
    const keys = new Set<string>();
    for (const report of ANALYTICS_REPORTS) {
      keys.add(`report.${report.id}`);
      keys.add(`report.${report.id}.description`);
      for (const column of report.columns) keys.add(`column.${column.key}`);
    }
    for (const category of ANALYTICS_REPORT_CATEGORIES) keys.add(`category.${category}`);
    for (const preset of ANALYTICS_PRESETS) keys.add(`preset.${preset}`);
    for (const comparison of ANALYTICS_COMPARISONS) keys.add(`comparison.${comparison}`);
    for (const granularity of ANALYTICS_GRANULARITIES) keys.add(`granularity.${granularity}`);
    for (const [vocabulary, values] of Object.entries(ANALYTICS_ENUM_VALUES)) {
      for (const value of values) keys.add(`enum.${vocabulary}.${value}`);
    }
    const missing = [...keys].filter((key) => !Object.hasOwn(analyticsMessages.en, key) || !Object.hasOwn(analyticsMessages.bn, key));
    expect(missing).toEqual([]);
  });
});
