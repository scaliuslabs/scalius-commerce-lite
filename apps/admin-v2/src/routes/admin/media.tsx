import { createFileRoute } from "@tanstack/react-router";
import { MediaManagerPage } from "~/components/admin/media-manager";
import { RouteErrorComponent } from "~/lib/list-helpers";

export const Route = createFileRoute("/admin/media")({
  head: () => ({ meta: [{ title: "Media | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: MediaPage,
});

function MediaPage() {
  return <MediaManagerPage />;
}
