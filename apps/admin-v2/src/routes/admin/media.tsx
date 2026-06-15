import { lazy, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { RouteErrorComponent } from "~/lib/route-error";
import { PageLoadingSpinner } from "~/components/admin/shared/LoadingFallback";

const MediaManagerPage = lazy(() =>
  import("~/components/admin/media-manager/MediaManagerPage").then((module) => ({
    default: module.MediaManagerPage,
  })),
);

export const Route = createFileRoute("/admin/media")({
  head: () => ({ meta: [{ title: "Media | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: MediaPage,
});

function MediaPage() {
  return (
    <Suspense fallback={<PageLoadingSpinner />}>
      <MediaManagerPage />
    </Suspense>
  );
}
