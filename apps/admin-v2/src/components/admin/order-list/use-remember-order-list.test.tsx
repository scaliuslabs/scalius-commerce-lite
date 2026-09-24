// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vitest";
import { orderListReturnHref } from "~/lib/order-list-return";
import { useRememberOrderListHref } from "./use-remember-order-list";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function List() {
  useRememberOrderListHref();
  return null;
}

describe("order list Back target", () => {
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    window.sessionStorage.clear();
  });

  it("remembers the list tab, filters and page as they change, including the abandoned tab", async () => {
    const rootRoute = createRootRoute();
    const orders = createRoute({ getParentRoute: () => rootRoute, path: "/admin/orders", component: List });
    const abandoned = createRoute({ getParentRoute: () => rootRoute, path: "/admin/orders/abandoned", component: List });
    const router = createRouter({
      routeTree: rootRoute.addChildren([orders, abandoned]),
      history: createMemoryHistory({ initialEntries: ["/admin/orders?view=returned&page=2"] }),
    });
    await router.load();
    root = createRoot(document.createElement("div"));
    await act(async () => root!.render(<RouterProvider router={router} />));
    expect(orderListReturnHref()).toBe("/admin/orders?view=returned&page=2");

    await act(async () => {
      await router.navigate({ to: "/admin/orders", search: { view: "delivery_failed" } });
    });
    expect(orderListReturnHref()).toBe("/admin/orders?view=delivery_failed");

    await act(async () => {
      await router.navigate({ to: "/admin/orders/abandoned" });
    });
    expect(orderListReturnHref()).toBe("/admin/orders/abandoned");
  });

  it("keeps the list when the location already shows an order (the list is still mounted mid-navigation)", async () => {
    // The hook lives in a component that stays mounted while the URL moves to an order and on to the next one.
    const rootRoute = createRootRoute({ component: List });
    const orders = createRoute({ getParentRoute: () => rootRoute, path: "/admin/orders" });
    const order = createRoute({ getParentRoute: () => rootRoute, path: "/admin/orders/$orderId" });
    const router = createRouter({
      routeTree: rootRoute.addChildren([orders, order]),
      history: createMemoryHistory({ initialEntries: ["/admin/orders?view=unpaid"] }),
    });
    await router.load();
    root = createRoot(document.createElement("div"));
    await act(async () => root!.render(<RouterProvider router={router} />));
    expect(orderListReturnHref()).toBe("/admin/orders?view=unpaid");

    for (const orderId of ["AGD5658QQXD0S0HA", "BQX1234ZZ"]) {
      await act(async () => {
        await router.navigate({ to: "/admin/orders/$orderId", params: { orderId } });
      });
      expect(router.state.location.pathname).toBe(`/admin/orders/${orderId}`);
      expect(orderListReturnHref()).toBe("/admin/orders?view=unpaid");
    }
  });
});
