import { type ReactNode } from "react";
import { createRouter, rootRouteId, useMatch, type ErrorComponentProps } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { createAdminQueryClient } from "./lib/admin-query-client";
import { NotFoundState, RouteErrorComponent } from "./lib/route-error";
import { getAdminScrollRestorationKey } from "./lib/admin-scroll-restoration";
import { getDashboardBasePath } from "./lib/dashboard-base-path";

// Not-found and error states render where the failure happened: inside the
// admin shell or the sign-in card while those layouts stand, full page when
// the root, or the shell's own session guard, is what failed.
function DefaultNotFoundComponent() {
  const routeId = useMatch({ strict: false, select: (match) => match.routeId });
  return <NotFoundState fullPage={routeId === rootRouteId} />;
}

function DefaultErrorComponent(props: ErrorComponentProps) {
  const routeId = useMatch({ strict: false, select: (match) => match.routeId });
  return <RouteErrorComponent {...props} fullPage={routeId === rootRouteId || routeId === "/admin"} />;
}

export function getRouter() {
  const queryClient = createAdminQueryClient();

  return createRouter({
    routeTree,
    context: { queryClient },
    // Runtime dashboard base path (Platform Dashboard URL), read from the
    // shell's meta tag; "" at a host root.
    basepath: getDashboardBasePath() || "/",
    scrollRestoration: true,
    getScrollRestorationKey: getAdminScrollRestorationKey,
    scrollToTopSelectors: ["#admin-main-scroll"],
    scrollRestorationBehavior: "instant",
    defaultPreload: false,
    // Never replace useful admin content with a route-level loading screen.
    // The persistent admin shell exposes delayed navigation progress without
    // blocking the transition or forcing a minimum pending-screen duration.
    defaultPendingMs: Number.POSITIVE_INFINITY,
    defaultNotFoundComponent: DefaultNotFoundComponent,
    defaultErrorComponent: DefaultErrorComponent,
    Wrap: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
