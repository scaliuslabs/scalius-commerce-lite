import { createFileRoute } from "@tanstack/react-router";
import { MediaManagerPage } from "~/components/admin/media-manager";
import { mediaFoldersQueryOptions, mediaListQueryOptions } from "~/lib/api.queries";

export const Route = createFileRoute("/admin/media")({
  loader: async ({ context: { queryClient } }) => {
    // Prefetch folder list and initial media files
    void queryClient.prefetchQuery(mediaFoldersQueryOptions());
    void queryClient.prefetchQuery(mediaListQueryOptions({ page: 1, limit: 12 }));
  },
  head: () => ({ meta: [{ title: "Media | Scalius Admin" }] }),
  component: MediaPage,
});

function MediaPage() {
  return <MediaManagerPage />;
}
