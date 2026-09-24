import { QueryClient } from "@tanstack/react-query";

export const ADMIN_QUERY_STALE_TIME_MS = 1000 * 10;
export const ADMIN_QUERY_GC_TIME_MS = 1000 * 60 * 30;
export const ADMIN_QUERY_RETRY = false;

/**
 * Requests always go to the network. TanStack's default (`"online"`) pauses a
 * request while the browser reports offline and silently replays it on
 * reconnect: a save the merchant already discarded, or made on a page they
 * left, would still be written. Offline instead fails at once, so the page
 * shows "Couldn't reach the server" and Save can be pressed again.
 */
export function createAdminQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: ADMIN_QUERY_STALE_TIME_MS,
        gcTime: ADMIN_QUERY_GC_TIME_MS,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        retry: ADMIN_QUERY_RETRY,
        networkMode: "always",
      },
      mutations: {
        networkMode: "always",
      },
    },
  });
}
