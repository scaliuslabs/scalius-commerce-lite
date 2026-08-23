// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("admin route transition presentation", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("retains the current page while the next route is unresolved", async () => {
    let resolveSlowRoute: (() => void) | undefined;
    const slowRouteData = new Promise<void>((resolve) => {
      resolveSlowRoute = resolve;
    });

    const rootRoute = createRootRoute({ component: Outlet });
    const currentRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <main>Useful current page</main>,
    });
    const slowRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/slow",
      loader: () => slowRouteData,
      pendingComponent: () => <main>Route loading screen</main>,
      component: () => <main>Ready next page</main>,
    });
    const routeTree = rootRoute.addChildren([currentRoute, slowRoute]);
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/"] }),
      defaultPendingMs: Number.POSITIVE_INFINITY,
    });

    await router.load();
    await act(async () => root.render(<RouterProvider router={router} />));
    expect(host.textContent).toBe("Useful current page");

    let navigation: Promise<void> | undefined;
    await act(async () => {
      navigation = router.navigate({ to: "/slow" as never });
      await Promise.resolve();
    });

    expect(host.textContent).toBe("Useful current page");
    expect(host.textContent).not.toContain("Route loading screen");

    resolveSlowRoute?.();
    await act(async () => navigation);
    expect(host.textContent).toBe("Ready next page");
  });
});
