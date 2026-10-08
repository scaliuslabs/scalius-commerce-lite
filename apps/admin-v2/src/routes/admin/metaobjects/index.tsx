import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { metaobjectDefinitionsQueryOptions } from "~/lib/api-query-options/metaobjects";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/metaobjects/")({
  // One chunk for the page's read and error screen; the screens of Content types share one lazy module.
  codeSplitGroupings: [["loader", "component", "errorComponent"]],
  loader: ({ context: { queryClient } }) => warmRouteQuery(queryClient, metaobjectDefinitionsQueryOptions()),
  head: () => pageHead("metaobjects"),
  errorComponent: RouteErrorComponent,
  component: lazyRouteComponent(() => import("~/components/admin/metaobjects/pages"), "TypesPage"),
});
