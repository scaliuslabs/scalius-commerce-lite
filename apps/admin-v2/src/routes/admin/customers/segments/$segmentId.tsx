import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { SegmentEditor } from "~/components/admin/customers/SegmentEditor";
import { isCustomerSegmentId } from "~/components/admin/customers/customer-list-search";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { customerSegmentQueryOptions } from "~/lib/api-query-options/customers";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/customers/segments/$segmentId")({
  loader: ({ context: { queryClient }, params }) => {
    // Only `seg_…` ids exist; anything else is a page that doesn't exist (no request).
    if (!isCustomerSegmentId(params.segmentId)) throw new AdminApiResponseError("Segment not found", 404);
    return queryClient.ensureQueryData(customerSegmentQueryOptions(params.segmentId));
  },
  head: () => pageHead("segment"),
  errorComponent: RouteErrorComponent,
  component: SegmentPage,
});

function SegmentPage() {
  const { segmentId } = Route.useParams();
  const { data } = useSuspenseQuery(customerSegmentQueryOptions(segmentId));
  return <SegmentEditor key={data.id} segment={data} />;
}
