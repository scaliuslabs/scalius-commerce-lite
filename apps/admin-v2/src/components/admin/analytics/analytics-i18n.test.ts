import { describe, expect, it } from "vitest";
import { ANALYTICS_ENUM_VALUES, ANALYTICS_REPORT_CATEGORIES, ANALYTICS_REPORTS } from "@scalius/shared/analytics-reports";
import { ANALYTICS_PRESETS, ANALYTICS_COMPARISONS, ANALYTICS_GRANULARITIES } from "@scalius/shared/analytics-period";
import { analyticsMessages } from "~/i18n/analytics";
import { getLocale, setLocale } from "~/i18n";

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

  it("keeps localized report heads and rejects unknown reports after lazy metadata loads", async () => {
    const { Route } = await import("~/routes/admin/analytics/reports/$reportId");
    const loader = Route.options.loader;
    const head = Route.options.head!;
    if (typeof loader !== "function") throw new Error("Missing report loader.");
    const reportId = ANALYTICS_REPORTS[0].id;
    await expect(loader({ params: { reportId } } as never)).resolves.toBeUndefined();
    await expect(loader({ params: { reportId: "unknown" } } as never)).rejects.toMatchObject({ status: 404 });
    const locale = getLocale();
    try {
      for (const language of ["en", "bn"] as const) {
        setLocale(language);
        expect(await head({ params: { reportId } } as never)).toEqual({ meta: [{ title: `${analyticsMessages[language][`report.${reportId}`]} · Scalius` }] });
      }
    } finally { setLocale(locale); }
  });
});
