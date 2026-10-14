import { useEffect, useState } from "react";
import { useBlocker, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { isOnline, useOnlineStatus } from "./online-status";

interface RouteNode {
  _componentsLoaded?: boolean;
  parentRoute?: RouteNode;
  options: { component?: { preload?: unknown } };
}

/**
 * Whether a route's page code (and its layouts') is already in this tab. The
 * router marks a route once it has fetched its split component chunks.
 */
export function routeCodeReady(routesById: object, routeId: string): boolean {
  let route = (routesById as Record<string, RouteNode | undefined>)[routeId];
  if (!route) return true;
  while (route) {
    if (route.options.component?.preload && !route._componentsLoaded) return false;
    route = route.parentRoute;
  }
  return true;
}

type Waiting = { pathname: string; search: unknown };

/**
 * Offline, the dashboard never blanks (polish bar R6). Pages whose code is in
 * the tab open as usual and show their cached data; a page whose code is not
 * here would fail to download, and the router would then reload into the
 * browser's offline page. So that click waits: the banner says the page opens
 * on reconnect, and it opens then. Back online, every read that failed is
 * read again. Nothing else is queued: a save made offline fails in its form
 * and stays there to send again.
 *
 * Returns whether a page is waiting for the connection.
 */
export function useOfflineNavigation(): { online: boolean; waiting: boolean } {
  const router = useRouter();
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  const [waiting, setWaiting] = useState<Waiting | null>(null);

  useBlocker({
    shouldBlockFn: ({ next }) => {
      if (isOnline() || routeCodeReady(router.routesById, next.routeId)) {
        setWaiting(null);
        return false;
      }
      setWaiting({ pathname: next.pathname, search: next.search });
      return true;
    },
    enableBeforeUnload: false,
  });

  useEffect(() => {
    if (!online) return;
    // Reads that failed while offline run again (a page-level ErrorState
    // re-runs its route's loaders itself).
    void queryClient.refetchQueries({ type: "active", predicate: (query) => query.state.status === "error" });
    if (waiting) {
      setWaiting(null);
      void router.navigate({ to: waiting.pathname as never, search: waiting.search as never });
    }
  }, [online]); // eslint-disable-line react-hooks/exhaustive-deps -- runs on each reconnect only

  return { online, waiting: waiting !== null };
}
