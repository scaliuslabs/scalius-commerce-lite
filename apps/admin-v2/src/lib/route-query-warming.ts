import type { QueryClient } from "@tanstack/react-query";

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
