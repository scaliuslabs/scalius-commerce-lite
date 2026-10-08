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
  const client = new QueryClient({
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
  pollingClients.add(client);
  return client;
}

// Whether the realtime hub is reachable now (set by lib/realtime/store.ts),
// for query options that poll only without it. Kept here, with the query
// defaults the shell loads anyway, so the shell's badges add no chunk.
let realtimeOpen = false;
/** This tab's query clients: their polls follow the hub at once. */
const pollingClients = new Set<QueryClient>();

export function setRealtimeOpen(next: boolean): void {
  if (realtimeOpen === next) return;
  realtimeOpen = next;
  // A poll is scheduled when its query last fetched: ask every mounted query
  // for its interval again, so a poll set before the hub opened never fires
  // and one stopped while it was open starts as soon as it closes.
  for (const client of pollingClients) {
    for (const query of client.getQueryCache().getAll()) {
      for (const observer of query.observers) observer.setOptions(observer.options);
    }
  }
}

/**
 * A refetch interval that applies only while the hub is unreachable (a proxy
 * that blocks WebSockets, a hub outage): live notices replace polling, and
 * the screen still catches up without them.
 */
export function pollWhileOffline(ms: number): () => number | false {
  return () => (realtimeOpen ? false : ms);
}
