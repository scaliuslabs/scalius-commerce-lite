import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { metaobjectDefinitionQueryOptions } from "~/lib/api-query-options/metaobjects";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/metaobjects/$definitionId/settings")({
  codeSplitGroupings: [["loader", "component", "errorComponent"]],
  loader: ({ context: { queryClient }, params }) => {
    if (!/^mod_[A-Za-z0-9_-]{1,60}$/.test(params.definitionId)) throw new AdminApiResponseError("Content type not found", 404);
    return queryClient.ensureQueryData(metaobjectDefinitionQueryOptions(params.definitionId));
  },
  head: () => pageHead("metaobject"),
  errorComponent: RouteErrorComponent,
  component: lazyRouteComponent(() => import("~/components/admin/metaobjects/pages"), "TypePage"),
});
