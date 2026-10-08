import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { metaobjectDefinitionQueryOptions, metaobjectEntryQueryOptions } from "~/lib/api-query-options/metaobjects";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/metaobjects/$definitionId/entries/$entryId")({
  codeSplitGroupings: [["loader", "component", "errorComponent"]],
  loader: async ({ context: { queryClient }, params }) => {
    if (!/^mod_[A-Za-z0-9_-]{1,60}$/.test(params.definitionId)) throw new AdminApiResponseError("Content type not found", 404);
    if (!/^moe_[A-Za-z0-9_-]{1,60}$/.test(params.entryId)) throw new AdminApiResponseError("Entry not found", 404);
    await Promise.all([
      queryClient.ensureQueryData(metaobjectDefinitionQueryOptions(params.definitionId)),
      queryClient.ensureQueryData(metaobjectEntryQueryOptions(params.definitionId, params.entryId)),
    ]);
  },
  head: () => pageHead("metaobjectEntry"),
  errorComponent: RouteErrorComponent,
  component: lazyRouteComponent(() => import("~/components/admin/metaobjects/pages"), "EntryPage"),
});
