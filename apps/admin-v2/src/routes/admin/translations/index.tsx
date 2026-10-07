import { createFileRoute } from "@tanstack/react-router";
import { TranslationsWorkspace } from "~/components/admin/translations/TranslationsWorkspace";
import type { TranslationsSearch } from "~/lib/translation-types";
import { storeLanguagesQueryOptions } from "~/lib/api-query-options/translations";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { pageHead } from "~/i18n/page-titles";

// Translate & adapt (docs/MARKETS-DESIGN.md D9): the language, market, kind
// of resource, search, page and open item live in the URL. The workspace
// (its own download) checks them; the first download only names them.
export const Route = createFileRoute("/admin/translations/")({
  codeSplitGroupings: [["loader", "component", "errorComponent"]],
  validateSearch: (search: Record<string, unknown>) => search as TranslationsSearch,
  loader: ({ context: { queryClient } }) => warmRouteQuery(queryClient, storeLanguagesQueryOptions()),
  head: () => pageHead("translations"),
  errorComponent: RouteErrorComponent,
  component: TranslationsPage,
});

function TranslationsPage() {
  return <TranslationsWorkspace search={Route.useSearch()} />;
}
