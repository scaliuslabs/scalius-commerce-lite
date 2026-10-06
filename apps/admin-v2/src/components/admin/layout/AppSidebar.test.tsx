// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppSidebar } from "./AppSidebar";
import { visibleNav } from "./AdminNav";
import { ShellProvider, useShell } from "./shell";

vi.mock("~/components/admin/inbox/InboxNavBadge", () => ({ InboxNavBadge: () => null }));
vi.mock("~/components/admin/reviews/ReviewsNavBadge", () => ({ ReviewsNavBadge: () => null }));
vi.mock("~/hooks/use-storefront-url", () => ({
  useStorefrontUrl: () => ({ storefrontUrl: null, buildStorefrontPath: () => null }),
}));
vi.mock("@/components/auth/UserMenu", () => ({ UserMenu: () => null, UserAvatar: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scrolled: string[] = [];

function setViewport(desktop: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: desktop,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

function OpenDrawer() {
  const { setDrawerOpen } = useShell();
  useEffect(() => setDrawerOpen(true), [setDrawerOpen]);
  return null;
}

const NAV = visibleNav(() => true, [{ placement: "apps", title: "Greeter", to: "/admin/apps/acme.hello/pages/home" }]);
const USER = { id: "owner", name: "Owner", email: "owner@example.com", image: null };

async function renderAt(root: Root, path: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <ShellProvider>
        <OpenDrawer />
        <AppSidebar nav={NAV} user={USER} showSettings />
        <Outlet />
      </ShellProvider>
    ),
  });
  const paths = new Set(["/admin", path, ...NAV.flatMap((item) => [item.to, ...item.children.map((child) => child.to)])]);
  const routes = [...paths].map((to) => createRoute({ getParentRoute: () => rootRoute, path: to, component: () => null }));
  const router = createRouter({ routeTree: rootRoute.addChildren(routes), history: createMemoryHistory({ initialEntries: [path] }) });
  await act(async () => root.render(<RouterProvider router={router} />));
  // The drawer's code loads lazily.
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  return router;
}

describe("phone navigation drawer", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    scrolled.length = 0;
    HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
      scrolled.push(this.textContent ?? "");
    };
    setViewport(false);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("lists every section with its sub-pages open, highlights the page and scrolls to it", async () => {
    await renderAt(root, "/admin/inventory/transfers");

    const drawer = document.querySelector("[role=dialog]")!;
    const labels = [...drawer.querySelectorAll("a")].map((link) => link.textContent);
    // Sub-pages of sections other than the current one are reachable in one tap.
    expect(labels).toEqual(expect.arrayContaining(["Inventory", "Segments", "Pages", "Reports", "Greeter", "Theme"]));
    expect(drawer.querySelectorAll("[data-nav-sub]").length).toBe(NAV.filter((item) => item.children.length > 0).length);
    expect(drawer.querySelector("button[aria-expanded]")).toBeNull();
    const current = [...drawer.querySelectorAll("[aria-current=page]")].map((link) => link.textContent);
    expect(current).toEqual(["Transfers"]);
    expect(scrolled).toEqual(["Transfers"]);
  });

  it("closes when a page is chosen", async () => {
    const router = await renderAt(root, "/admin/orders");
    const segments = [...document.querySelectorAll<HTMLAnchorElement>("[role=dialog] a")].find((link) => link.textContent === "Segments")!;

    await act(async () => segments.click());

    expect(router.state.location.pathname).toBe("/admin/customers/segments");
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("keeps the desktop panel showing only the open section's sub-pages", async () => {
    setViewport(true);
    await renderAt(root, "/admin/inventory");

    const subLists = [...host.querySelectorAll("[data-nav-sub]")];
    expect(subLists).toHaveLength(1);
    expect(subLists[0]!.textContent).toContain("Inventory");
    expect(scrolled).toEqual([]);
  });
});
