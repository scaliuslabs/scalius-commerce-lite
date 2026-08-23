import { lazy, Suspense, useCallback, useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RouteErrorComponent } from "~/lib/route-error";
import { PageLoadingSkeleton } from "~/components/admin/shared/LoadingFallback";
import {
  mediaRouteSearchToWorkspaceState,
  mediaWorkspaceStateToRouteSearch,
  validateMediaSearch,
} from "~/components/admin/media-manager/route-state";
import type {
  MediaWorkspaceRouteState,
  MediaWorkspaceRouteUpdateOptions,
} from "~/components/admin/media-manager/types";

export { validateMediaSearch } from "~/components/admin/media-manager/route-state";

const MediaManagerPage = lazy(() =>
  import("~/components/admin/media-manager/MediaManagerPage").then((module) => ({
    default: module.MediaManagerPage,
  })),
);

export const Route = createFileRoute("/admin/media")({
  validateSearch: validateMediaSearch,
  head: () => ({ meta: [{ title: "Media | Scalius Admin" }] }),
  errorComponent: RouteErrorComponent,
  component: MediaPage,
});

function MediaPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const workspaceState = useMemo(
    () => mediaRouteSearchToWorkspaceState(search),
    [search],
  );
  const handleWorkspaceStateChange = useCallback((
    updates: Partial<MediaWorkspaceRouteState>,
    options?: MediaWorkspaceRouteUpdateOptions,
  ) => {
    const nextState = { ...workspaceState, ...updates };
    void navigate({
      resetScroll: false,
      search: mediaWorkspaceStateToRouteSearch(nextState) as never,
      replace: options?.replace,
    });
  }, [navigate, workspaceState]);

  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <MediaManagerPage
        workspaceState={workspaceState}
        onWorkspaceStateChange={handleWorkspaceStateChange}
      />
    </Suspense>
  );
}
