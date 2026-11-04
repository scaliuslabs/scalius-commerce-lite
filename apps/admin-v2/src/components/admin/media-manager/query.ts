import type { QueryClient } from "@tanstack/react-query";
import { MediaApiClient } from "./api";
import { capabilityKind, type MediaCapability, type MediaFilterOptions, type MediaWorkspaceRouteState } from "./types";

/** Rows per library page: one number for the first read the route starts and the one the hook makes. */
export const MEDIA_PAGE_SIZE = 50;

export const DEFAULT_MEDIA_FILTERS: MediaFilterOptions = {
  search: "",
  sortBy: "createdAt",
  sortOrder: "desc",
  view: "ready",
};

/** A read this recent, started by the route's loader, counts as the page's first read. */
export const MEDIA_FIRST_PAGE_GRACE_MS = 5_000;

/** The library filters a route-controlled workspace reads its first page with. */
export function mediaWorkspaceFilters(
  state: MediaWorkspaceRouteState,
  capability: MediaCapability = "both",
): MediaFilterOptions {
  return {
    search: state.search,
    sortBy: state.sortBy,
    sortOrder: state.sortOrder,
    kind: capabilityKind(capability) ?? state.kind,
    folderId: state.folderId === "all" ? undefined : state.folderId,
    view: state.view,
  };
}

/** The one key and read of a library's first page (no cursor); the route loader and the hook share it. */
export function mediaFirstPageQueryOptions(filters: Partial<MediaFilterOptions>) {
  const merged: MediaFilterOptions = { ...DEFAULT_MEDIA_FILTERS, ...filters };
  return {
    queryKey: ["admin", "media", "first-page", MEDIA_PAGE_SIZE, merged] as const,
    queryFn: () => MediaApiClient.fetchFiles(undefined, MEDIA_PAGE_SIZE, merged),
    staleTime: MEDIA_FIRST_PAGE_GRACE_MS,
  };
}

/** Starts the first page's read before the page's code has loaded; a failure is left for the page to show. */
export function prefetchMediaFirstPage(queryClient: QueryClient, filters: Partial<MediaFilterOptions>): Promise<void> {
  return queryClient.prefetchQuery(mediaFirstPageQueryOptions(filters));
}
