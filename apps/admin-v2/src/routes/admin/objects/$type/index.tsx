import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { objectRecordsQueryOptions } from "~/lib/api-query-options/objects";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/objects/$type/")({
  codeSplitGroupings: [["loader", "component", "errorComponent"]],
  loader: ({ context: { queryClient }, params }) => {
    if (!/^[a-z][a-z0-9_.-]{1,150}$/.test(params.type)) throw new AdminApiResponseError("Content type not found", 404);
    return queryClient.ensureQueryData(objectRecordsQueryOptions(params.type));
  },
  head: () => pageHead("objectRecords"),
  errorComponent: RouteErrorComponent,
  component: lazyRouteComponent(() => import("~/components/admin/objects/pages"), "EntriesPage"),
});
