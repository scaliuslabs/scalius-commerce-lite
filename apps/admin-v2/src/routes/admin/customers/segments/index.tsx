import { createFileRoute } from "@tanstack/react-router";
import { SegmentList } from "~/components/admin/customers/SegmentList";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/customers/segments/")({
  // The read's module comes with the page's own code, not the dashboard's first download.
  loader: async ({ context: { queryClient } }) => {
    const { customerSegmentsQueryOptions } = await import("~/lib/api-query-options/customers");
    return warmRouteQuery(queryClient, customerSegmentsQueryOptions());
  },
  head: () => pageHead("segments"),
  errorComponent: RouteErrorComponent,
  component: SegmentList,
});
