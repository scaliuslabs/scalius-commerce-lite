import { QueryClient } from "@tanstack/react-query";

export const ADMIN_QUERY_STALE_TIME_MS = 1000 * 10;
export const ADMIN_QUERY_GC_TIME_MS = 1000 * 60 * 30;

export function createAdminQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: ADMIN_QUERY_STALE_TIME_MS,
        gcTime: ADMIN_QUERY_GC_TIME_MS,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
}
