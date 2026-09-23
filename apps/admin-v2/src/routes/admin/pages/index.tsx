import { createFileRoute } from "@tanstack/react-router";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { ContentList, contentListQuery } from "~/components/admin/pages/ContentList";
import { validatePageSearch } from "~/components/admin/pages/page-list-state";
import { translate } from "~/i18n";
import { contentMessages } from "~/i18n/content";

export const Route = createFileRoute("/admin/pages/")({
  validateSearch: validatePageSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => warmRouteQuery(queryClient, contentListQuery("page", deps)),
  head: () => ({ meta: [{ title: translate(contentMessages, "pages") }] }),
  component: () => <ContentList type="page" search={Route.useSearch()} />,
  errorComponent: RouteErrorComponent,
});
