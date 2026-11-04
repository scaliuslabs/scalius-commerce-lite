import { type JSX, type ReactNode } from "react";
import { createRouter, rootRouteId, useMatch, type ErrorComponentProps } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { createAdminQueryClient } from "./lib/admin-query-client";
import { RouteErrorComponent, RouteNotFoundComponent, RoutePendingComponent } from "./lib/route-error";
import { getDashboardBasePath } from "./lib/dashboard-base-path";
import { BootGate } from "./lib/boot-gate";
import { ROUTER_LOADING_OPTIONS } from "./lib/router-loading";
import { createDashboardHistory } from "./lib/popstate-before-router";

export { ROUTE_PENDING_MIN_MS, ROUTE_PENDING_MS } from "./lib/router-loading";

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
    // Back that only closes a dialog is heard before the router's own listener.
    history: createDashboardHistory(),
    context: { queryClient },
    // Runtime dashboard base path (Platform Dashboard URL), read from the
    // shell's meta tag; "" at a host root.
    basepath: getDashboardBasePath() || "/",
    // Positions are kept per history entry: Back restores, a new visit starts at the top.
    scrollRestoration: true,
    scrollToTopSelectors: ["#admin-main-scroll"],
    scrollRestorationBehavior: "instant",
    // Preloads on intent; every visit waits for its loader (CONTENT-004).
    ...ROUTER_LOADING_OPTIONS,
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
  router.preloadRoute = ((options) => (navigator.onLine !== false ? preloadRoute(options) : Promise.resolve(undefined))) as typeof preloadRoute;

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
