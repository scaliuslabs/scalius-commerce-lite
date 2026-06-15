import type { QueryClient } from "@tanstack/react-query";
import { getServerFnError } from "../api-helpers";
import { queryKeys } from "../query-keys";

export { getServerFnError, queryKeys };

export function invalidateDashboardQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
}

export function invalidateProductStatsQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: queryKeys.products.stats() });
}

export function invalidateProductLookupQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: queryKeys.products.byIds() });
}

export function invalidateCollectionLookupQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: queryKeys.collections.byIds() });
}
