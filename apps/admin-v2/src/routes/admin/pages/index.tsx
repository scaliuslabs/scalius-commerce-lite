import { createFileRoute } from "@tanstack/react-router";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { ContentList } from "~/components/admin/pages/ContentList";
import { contentListQuery, validatePageSearch } from "~/components/admin/pages/page-list-state";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/pages/")({
  validateSearch: validatePageSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => warmRouteQuery(queryClient, contentListQuery("page", deps)),
  head: () => pageHead("pages"),
  component: PagesPage,
  errorComponent: RouteErrorComponent,
});

function PagesPage() {
  return <ContentList type="page" search={Route.useSearch()} />;
}
