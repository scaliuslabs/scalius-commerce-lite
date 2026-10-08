import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { metaobjectEntriesQueryOptions } from "~/lib/api-query-options/metaobjects";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/metaobjects/$definitionId/")({
  codeSplitGroupings: [["loader", "component", "errorComponent"]],
  loader: ({ context: { queryClient }, params }) => {
    // Only `mod_…` ids exist; anything else is a page that doesn't exist (no request).
    if (!/^mod_[A-Za-z0-9_-]{1,60}$/.test(params.definitionId)) throw new AdminApiResponseError("Content type not found", 404);
    return queryClient.ensureQueryData(metaobjectEntriesQueryOptions(params.definitionId, 1));
  },
  head: () => pageHead("metaobjectEntries"),
  errorComponent: RouteErrorComponent,
  component: lazyRouteComponent(() => import("~/components/admin/metaobjects/pages"), "EntriesPage"),
});
