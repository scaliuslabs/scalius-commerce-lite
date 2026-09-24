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

import { ShellLink } from "./ShellLink";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Shell() {
  return (
    <nav>
      <ShellLink to="/admin" current={false}>Scalius</ShellLink>
      <ShellLink to="/admin/products" current>Products</ShellLink>
      <ShellLink to="/admin/customers" current={false}>Customers</ShellLink>
      <Outlet />
    </nav>
  );
}

describe("ShellLink", () => {
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

  it("marks only the item the shell says is current, never the logo, and keeps its label", async () => {
    const rootRoute = createRootRoute({ component: Shell });
    const routes = ["/admin", "/admin/products", "/admin/customers"].map((path) =>
      createRoute({ getParentRoute: () => rootRoute, path, component: () => null }));
    const router = createRouter({
      routeTree: rootRoute.addChildren(routes),
      // A list URL with search params: the router alone wouldn't call Products current here.
      history: createMemoryHistory({ initialEntries: ["/admin/products?page=2&sort=name"] }),
    });
    await act(async () => root.render(<RouterProvider router={router} />));

    const links = [...host.querySelectorAll("a")];
    expect(links.map((link) => link.textContent)).toEqual(["Scalius", "Products", "Customers"]);
    expect(links.map((link) => link.getAttribute("aria-current"))).toEqual([null, "page", null]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/admin", "/admin/products", "/admin/customers"]);
  });
});
