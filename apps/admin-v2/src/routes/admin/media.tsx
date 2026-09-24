import { lazy, Suspense, useCallback, useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RouteErrorComponent } from "~/lib/route-error";
import { useListSearch } from "~/lib/list-search";
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
import { pageHead } from "~/i18n/page-titles";

export { validateMediaSearch } from "~/components/admin/media-manager/route-state";

const MediaManagerPage = lazy(() =>
  import("~/components/admin/media-manager/MediaManagerPage").then((module) => ({
    default: module.MediaManagerPage,
  })),
);

export const Route = createFileRoute("/admin/media")({
  validateSearch: validateMediaSearch,
  head: () => pageHead("files"),
  errorComponent: RouteErrorComponent,
  component: MediaPage,
});

function MediaPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [term, setTerm] = useListSearch("media");
  const workspaceState = useMemo(
    () => mediaRouteSearchToWorkspaceState(search, term),
    [search, term],
  );
  const handleWorkspaceStateChange = useCallback((
    { search: nextTerm, ...updates }: Partial<MediaWorkspaceRouteState>,
    options?: MediaWorkspaceRouteUpdateOptions,
  ) => {
    if (nextTerm !== undefined) setTerm(nextTerm);
    if (!Object.keys(updates).length) return;
    void navigate({
      resetScroll: false,
      search: mediaWorkspaceStateToRouteSearch({ ...workspaceState, ...updates }) as never,
      replace: options?.replace,
    });
  }, [navigate, setTerm, workspaceState]);

  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <MediaManagerPage
        workspaceState={workspaceState}
        onWorkspaceStateChange={handleWorkspaceStateChange}
      />
    </Suspense>
  );
}
