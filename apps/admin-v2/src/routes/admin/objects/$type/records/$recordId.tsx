import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { objectTypeQueryOptions, objectRecordQueryOptions } from "~/lib/api-query-options/objects";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/objects/$type/records/$recordId")({
  codeSplitGroupings: [["loader", "component", "errorComponent"]],
  loader: async ({ context: { queryClient }, params }) => {
    if (!/^[a-z][a-z0-9_.-]{1,150}$/.test(params.type)) throw new AdminApiResponseError("Content type not found", 404);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(params.recordId)) throw new AdminApiResponseError("Entry not found", 404);
    await Promise.all([
      queryClient.ensureQueryData(objectTypeQueryOptions(params.type)),
      queryClient.ensureQueryData(objectRecordQueryOptions(params.type, params.recordId)),
    ]);
  },
  head: () => pageHead("objectRecord"),
  errorComponent: RouteErrorComponent,
  component: lazyRouteComponent(() => import("~/components/admin/objects/pages"), "EntryPage"),
});
