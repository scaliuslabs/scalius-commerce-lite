import { lazy, Suspense, useCallback, useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RouteErrorComponent } from "~/lib/route-error";
import { readListSearch, useListSearch } from "~/lib/list-search";
import { PageSkeleton } from "~/components/admin/states/PageSkeleton";
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
  // The first page's read starts with the navigation, beside the page's code,
  // not after it; the page's opening read joins it (a failure shows on the
  // page). Once the page is open ("stay": a filter or folder change) the
  // page reads for itself, so no second read is started here.
  loader: ({ context: { queryClient }, location, cause }) => {
    if (cause === "stay") return;
    const search = validateMediaSearch(location.search as Record<string, unknown>);
    import("~/components/admin/media-manager/query")
      .then(({ mediaWorkspaceFilters, prefetchMediaFirstPage }) =>
        prefetchMediaFirstPage(
          queryClient,
          mediaWorkspaceFilters(mediaRouteSearchToWorkspaceState(search, readListSearch("media"))),
        ))
      .catch(() => undefined);
  },
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
    <Suspense fallback={<PageSkeleton kind="index" rows={6} />}>
      <MediaManagerPage
        workspaceState={workspaceState}
        onWorkspaceStateChange={handleWorkspaceStateChange}
      />
    </Suspense>
  );
}
