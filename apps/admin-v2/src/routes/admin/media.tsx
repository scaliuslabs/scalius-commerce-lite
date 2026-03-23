import { createFileRoute } from "@tanstack/react-router";
import { MediaManagerPage } from "~/components/admin/media-manager";

export const Route = createFileRoute("/admin/media")({
  head: () => ({ meta: [{ title: "Media | Scalius Admin" }] }),
  component: MediaPage,
});

function MediaPage() {
  return <MediaManagerPage />;
}
