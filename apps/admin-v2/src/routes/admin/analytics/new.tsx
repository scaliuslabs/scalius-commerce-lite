import { useEffect } from "react";
import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { AnalyticsForm } from "~/components/admin/AnalyticsForm";
import {
  buildAnalyticsCreateSearch,
  buildAnalyticsCreateHref,
  getAnalyticsCreateTypeFromHref,
  normalizeAnalyticsCreateType,
} from "~/components/admin/analytics-create-route-state";

export function validateAnalyticsCreateSearch(search: Record<string, unknown>) {
  return buildAnalyticsCreateSearch(normalizeAnalyticsCreateType(search.type));
}

export const Route = createFileRoute("/admin/analytics/new")({
  validateSearch: validateAnalyticsCreateSearch,
  head: () => ({ meta: [{ title: "New Analytics Integration | Scalius Admin" }] }),
  component: NewAnalyticsPage,
});

function NewAnalyticsPage() {
  const selectedType = normalizeAnalyticsCreateType(Route.useSearch().type);
  const navigate = useNavigate();
  const currentHref = useLocation({ select: (location) => location.href });

  useEffect(() => {
    const browserHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const hrefType = getAnalyticsCreateTypeFromHref(browserHref);
    const canonicalHref = buildAnalyticsCreateHref(hrefType);
    if (browserHref === canonicalHref) return;

    // validateSearch has already normalized the router state. Replace only the
    // raw browser URL here; asking the router to navigate to its current
    // normalized location is a no-op and can leave invalid query text visible.
    window.history.replaceState(window.history.state, "", canonicalHref);
  }, [currentHref]);

  return (
    <AnalyticsForm
      selectedType={selectedType}
      onSelectedTypeChange={(type) => {
        void navigate({
          to: Route.fullPath,
          search: buildAnalyticsCreateSearch(type),
          ignoreBlocker: true,
        });
      }}
    />
  );
}
