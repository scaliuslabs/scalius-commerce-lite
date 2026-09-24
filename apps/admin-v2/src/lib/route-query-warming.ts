import type { QueryClient } from "@tanstack/react-query";

/** A read that a link's hover or focus preloaded this recently counts as fresh when the page opens. */
export const INTENT_PREFETCH_MOUNT_GRACE_MS = 5_000;

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
