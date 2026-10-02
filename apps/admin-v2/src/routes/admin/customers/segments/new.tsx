import { createFileRoute } from "@tanstack/react-router";
import { SegmentEditor } from "~/components/admin/customers/SegmentEditor";
import { RouteErrorComponent } from "~/lib/route-error";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/admin/customers/segments/new")({
  head: () => pageHead("newSegment"),
  errorComponent: RouteErrorComponent,
  component: () => <SegmentEditor segment={null} />,
});
