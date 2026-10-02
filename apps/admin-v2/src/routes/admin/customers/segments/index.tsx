import { createFileRoute } from "@tanstack/react-router";
import { SegmentList } from "~/components/admin/customers/SegmentList";
import { customerSegmentsQueryOptions } from "~/lib/api-query-options/customers";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/customers/segments/")({
  loader: ({ context: { queryClient } }) => warmRouteQuery(queryClient, customerSegmentsQueryOptions()),
  head: () => pageHead("segments"),
  errorComponent: RouteErrorComponent,
  component: SegmentList,
});
