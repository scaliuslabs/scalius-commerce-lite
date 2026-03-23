import { createFileRoute } from "@tanstack/react-router";
import { MediaManagerPage } from "~/components/admin/media-manager";
import { mediaFoldersQueryOptions, mediaListQueryOptions } from "~/lib/api.queries";

export const Route = createFileRoute("/admin/media")({
  loader: async ({ context: { queryClient } }) => {
    // Ensure folder list and initial media files are ready
    await Promise.all([
      queryClient.ensureQueryData(mediaFoldersQueryOptions()),
      queryClient.ensureQueryData(mediaListQueryOptions({ page: 1, limit: 12 })),
    ]);
  },
  head: () => ({ meta: [{ title: "Media | Scalius Admin" }] }),
  component: MediaPage,
});

function MediaPage() {
  return <MediaManagerPage />;
}
