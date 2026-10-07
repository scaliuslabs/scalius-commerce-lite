import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Lock, Search } from "lucide-react";
import {
  ANALYTICS_REPORTS,
  ANALYTICS_REPORT_CATEGORIES,
  type AnalyticsReportCategory,
} from "@scalius/shared/analytics-reports";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { useMessages } from "~/i18n";
import { analyticsMessages, type AnalyticsMessageKey } from "~/i18n/analytics";
import { resourceMessages } from "~/i18n/resource";
import { analyticsReportCatalogQueryOptions } from "~/lib/api-query-options/analytics";
import type { AnalyticsSearch } from "./analytics-selection";

/**
 * Shopify's Reports list: every report by category, filtered as you type.
 * The catalog read says which ones this staff member can run now; the rest
 * stay listed (muted) with the reason, so nothing silently disappears.
 */
export function ReportsList({ search }: { search: AnalyticsSearch }) {
  const t = useMessages(analyticsMessages);
  const r = useMessages(resourceMessages);
  const [query, setQuery] = useState("");
  const catalog = useQuery(analyticsReportCatalogQueryOptions());
  const availability = new Map(catalog.data?.reports.map((report) => [report.id, report]) ?? []);
  const needle = query.trim().toLocaleLowerCase();
  const matches = ANALYTICS_REPORTS.filter((report) => {
    if (!needle) return true;
    const words = `${t(`report.${report.id}` as AnalyticsMessageKey)} ${t(`report.${report.id}.description` as AnalyticsMessageKey)}`;
    return words.toLocaleLowerCase().includes(needle);
  });

  return (
    <div className="space-y-4 pb-8">
      <PageHeader title={t("reports")} backTo="/admin/analytics" />
      <p className="-mt-2 text-body text-muted-foreground">{t("reportsIntro")}</p>
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute top-1/2 inset-s-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("searchReports")}
          aria-label={t("searchReports")}
          // eslint-disable-next-line shadcn/no-restyle -- room for the search icon inside the field
          className="ps-9"
        />
      </div>
      {matches.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("noReportsMatch")}</CardTitle>
            <p className="text-body text-muted-foreground">{r("noResultsHint")}</p>
          </CardHeader>
          <CardContent>
            <Button type="button" variant="outline" onClick={() => setQuery("")}>{r("clearSearch")}</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {ANALYTICS_REPORT_CATEGORIES.map((category: AnalyticsReportCategory) => {
            const reports = matches.filter((report) => report.category === category);
            if (reports.length === 0) return null;
            return (
              <Card key={category}>
                <CardHeader>
                  <CardTitle>{t(`category.${category}`)}</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <ul className="divide-y border-t">
                    {reports.map((report) => {
                      const entry = availability.get(report.id);
                      const blocked = entry && !entry.available ? entry.unavailableReason : null;
                      const name = t(`report.${report.id}` as AnalyticsMessageKey);
                      const description = t(`report.${report.id}.description` as AnalyticsMessageKey);
                      return (
                        <li key={report.id}>
                          {blocked ? (
                            <div className="flex min-h-11 items-start gap-3 px-4 py-2.5 text-body text-muted-foreground">
                              <span className="flex h-lh items-center"><Lock className="size-4" aria-hidden /></span>
                              <span className="min-w-0 flex-1">
                                <span className="block font-medium">{name}</span>
                                <span className="block">{t(`unavailable.${blocked}`)}</span>
                              </span>
                            </div>
                          ) : (
                            <Link
                              to="/admin/analytics/reports/$reportId"
                              params={{ reportId: report.id }}
                              search={(report.period === "range" ? { from: search.from, to: search.to } : {}) as never}
                              className="flex min-h-11 items-start gap-3 px-4 py-2.5 text-body hover:bg-muted"
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block font-medium">{name}</span>
                                <span className="block text-muted-foreground">{description}</span>
                              </span>
                              <span className="flex h-lh items-center"><ChevronRight className="size-4 text-muted-foreground" aria-hidden /></span>
                            </Link>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
