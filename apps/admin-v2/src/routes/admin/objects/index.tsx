import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { objectTypesQueryOptions } from "~/lib/api-query-options/objects";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/objects/")({
  // One chunk for the page's read and error screen; the screens of Content types share one lazy module.
  codeSplitGroupings: [["loader", "component", "errorComponent"]],
  loader: ({ context: { queryClient } }) => warmRouteQuery(queryClient, objectTypesQueryOptions()),
  head: () => pageHead("objects"),
  errorComponent: RouteErrorComponent,
  component: lazyRouteComponent(() => import("~/components/admin/objects/pages"), "TypesPage"),
});
