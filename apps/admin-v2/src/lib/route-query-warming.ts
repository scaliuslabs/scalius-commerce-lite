import type { FetchQueryOptions, QueryClient, QueryKey } from "@tanstack/react-query";

/** A read that a link's hover or focus preloaded this recently counts as fresh when the page opens. */
export const INTENT_PREFETCH_MOUNT_GRACE_MS = 5_000;

/**
 * The record an edit page opens on: read fresh, unless a read this recent (the
 * link's hover) is cached and nothing invalidated it since. An edit form takes
 * its saved values and revision once, when it mounts, so opening it on an
 * older cached copy (from before a trash and restore, say) made its first
 * save fail as if someone else had saved. This holds only because the router
 * waits for the loader on every visit (`ROUTER_LOADING_OPTIONS`).
 */
export function loadEditorRecord<TQueryFnData, TError, TData, TQueryKey extends QueryKey>(
  queryClient: QueryClient,
  options: FetchQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
): Promise<TData> {
  return queryClient.fetchQuery({ ...options, staleTime: INTENT_PREFETCH_MOUNT_GRACE_MS });
}

type RouteQueryOptions = {
  queryKey: readonly unknown[];
  queryFn?: unknown;
};

export async function warmRouteQuery<TOptions extends RouteQueryOptions>(
  queryClient: QueryClient,
  options: TOptions,
): Promise<void> {
  const queryOptions =
    options as unknown as Parameters<QueryClient["ensureQueryData"]>[0];

  if (typeof window === "undefined") {
    await queryClient.ensureQueryData(queryOptions);
    return;
  }

  if (queryClient.getQueryData(options.queryKey) !== undefined) {
    await queryClient.ensureQueryData(queryOptions);
    return;
  }

  void queryClient.prefetchQuery(queryOptions);
}

/** Who a loader reads for: the admin route context's permissions. */
export interface LoaderViewer {
  permissions: readonly string[];
  isSuperAdmin: boolean;
}

/**
 * Whether the viewer holds one of these permissions. A loader reads only what
 * this viewer's role may read (the permission the read's API route asks, the
 * same one its card checks before it shows), so opening a page never sends a
 * read the API refuses (routes/-page-route-permissions.test.ts).
 */
export function viewerHolds(viewer: LoaderViewer, ...permissions: string[]): boolean {
  return viewer.isSuperAdmin || permissions.some((permission) => viewer.permissions.includes(permission));
}
