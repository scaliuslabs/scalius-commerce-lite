import { createFileRoute } from "@tanstack/react-router";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { ContentList } from "~/components/admin/pages/ContentList";
import { contentListQuery, validatePageSearch } from "~/components/admin/pages/page-list-state";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/articles/")({
  validateSearch: validatePageSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => warmRouteQuery(queryClient, contentListQuery("article", deps)),
  head: () => pageHead("blogPosts"),
  component: BlogPostsPage,
  errorComponent: RouteErrorComponent,
});

function BlogPostsPage() {
  return <ContentList type="article" search={Route.useSearch()} />;
}
