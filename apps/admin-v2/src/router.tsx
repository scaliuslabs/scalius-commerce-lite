import { type JSX, type ReactNode } from "react";
import { createRouter, rootRouteId, useMatch, type ErrorComponentProps } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { createAdminQueryClient } from "./lib/admin-query-client";
import { RouteErrorComponent, RouteNotFoundComponent, RoutePendingComponent } from "./lib/route-error";
import { getDashboardBasePath } from "./lib/dashboard-base-path";
import { isOnline } from "./components/admin/states/failure";
import { BootGate } from "./lib/boot-gate";

/**
 * A page whose data takes longer than this shows its skeleton (polish bar
 * L3: nothing flashes for a fast page), and once shown the skeleton stays at
 * least as long, so it never blinks. Until then the current page stays.
 */
export const ROUTE_PENDING_MS = 300;
export const ROUTE_PENDING_MIN_MS = 300;

// Errors render where the failure happened: inside the admin shell or the
// sign-in card while those layouts stand, full page when the root, or the
// shell's own session guard, is what failed.
function DefaultErrorComponent(props: ErrorComponentProps): JSX.Element {
  const routeId = useMatch({ strict: false, select: (match) => match.routeId });
  return <RouteErrorComponent {...props} fullPage={routeId === rootRouteId || routeId === "/admin"} />;
}

export function getRouter() {
  const queryClient = createAdminQueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    // Runtime dashboard base path (Platform Dashboard URL), read from the
    // shell's meta tag; "" at a host root.
    basepath: getDashboardBasePath() || "/",
    // Positions are kept per history entry: Back restores, a new visit starts at the top.
    scrollRestoration: true,
    scrollToTopSelectors: ["#admin-main-scroll"],
    scrollRestorationBehavior: "instant",
    // Hovering or focusing a link fetches the page's code and runs its loader,
    // so the click lands on data already in flight. React Query owns caching
    // and freshness, so the router re-runs loaders on every preload.
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    // A link to a page whose read is slow (a detail page opened from a push,
    // an email or a list) shows that page's skeleton inside the shell after
    // 300 ms instead of holding the old page or a blank one.
    defaultPendingMs: ROUTE_PENDING_MS,
    defaultPendingMinMs: ROUTE_PENDING_MIN_MS,
    defaultPendingComponent: RoutePendingComponent,
    defaultNotFoundComponent: RouteNotFoundComponent,
    defaultErrorComponent: DefaultErrorComponent,
    InnerWrap: BootGate,
    Wrap: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });

  // Offline, a hover never starts fetching a page's code: a failed chunk
  // download stays failed in the router until the tab reloads. The click
  // itself is handled by the shell's offline guard.
  const preloadRoute = router.preloadRoute;
  router.preloadRoute = ((options) => (isOnline() ? preloadRoute(options) : Promise.resolve(undefined))) as typeof preloadRoute;

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
