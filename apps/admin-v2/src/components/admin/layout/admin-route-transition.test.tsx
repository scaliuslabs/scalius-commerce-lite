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
import { ROUTE_PENDING_MIN_MS, ROUTE_PENDING_MS } from "~/router";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("admin route transition presentation (polish bar L1, L3)", () => {
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

  function setup(loader: () => Promise<void>) {
    const rootRoute = createRootRoute({ component: Outlet });
    // The admin shell: a layout with a guard, like routes/admin.tsx.
    const shellRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/admin",
      beforeLoad: async () => ({ user: "staff" }),
      pendingMs: Number.POSITIVE_INFINITY,
      component: () => <><nav>Shell</nav><Outlet /></>,
    });
    const currentRoute = createRoute({
      getParentRoute: () => shellRoute,
      path: "/",
      component: () => <main>Useful current page</main>,
    });
    const slowRoute = createRoute({
      getParentRoute: () => shellRoute,
      path: "/slow",
      loader,
      component: () => <main>Ready next page</main>,
    });
    return createRouter({
      routeTree: rootRoute.addChildren([shellRoute.addChildren([currentRoute, slowRoute])]),
      history: createMemoryHistory({ initialEntries: ["/admin/"] }),
      defaultPendingMs: ROUTE_PENDING_MS,
      defaultPendingMinMs: ROUTE_PENDING_MIN_MS,
      defaultPendingComponent: () => <main>Page skeleton</main>,
    });
  }

  it("keeps the current page for a fast read: no skeleton flashes", async () => {
    const router = setup(() => wait(ROUTE_PENDING_MS / 3));
    await router.load();
    await act(async () => root.render(<RouterProvider router={router} />));

    let navigation: Promise<unknown> | undefined;
    await act(async () => {
      navigation = router.navigate({ to: "/admin/slow" as never });
      await Promise.resolve();
    });
    expect(host.textContent).toBe("ShellUseful current page");
    await act(async () => navigation);
    expect(host.textContent).toBe("ShellReady next page");
  });

  it("shows the next page's skeleton once its read is slow, then the page", async () => {
    let resolveSlowRoute: (() => void) | undefined;
    const slowRouteData = new Promise<void>((resolve) => {
      resolveSlowRoute = resolve;
    });
    const router = setup(() => slowRouteData);
    await router.load();
    await act(async () => root.render(<RouterProvider router={router} />));

    let navigation: Promise<unknown> | undefined;
    await act(async () => {
      navigation = router.navigate({ to: "/admin/slow" as never });
      await Promise.resolve();
    });
    expect(host.textContent).toBe("ShellUseful current page");

    await act(async () => wait(ROUTE_PENDING_MS + 50));
    // The shell stays; only the page area shows the skeleton.
    const visible = [...host.querySelectorAll("nav, main")].filter((node) => !(node as HTMLElement).style.display).map((node) => node.textContent);
    expect(visible).toEqual(["Shell", "Page skeleton"]);

    resolveSlowRoute?.();
    await act(async () => navigation);
    await act(async () => wait(ROUTE_PENDING_MIN_MS));
    expect(host.textContent).toBe("ShellReady next page");
  });
});
