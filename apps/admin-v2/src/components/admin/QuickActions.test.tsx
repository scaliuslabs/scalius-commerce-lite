// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { PermissionProvider } from "@/contexts/PermissionContext";
import { QuickActions } from "./QuickActions";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const allActionLabels = [
  "Add product",
  "Products",
  "Categories",
  "Orders",
  "Customers",
  "Media",
  "Delivery",
  "Settings",
];

describe("QuickActions permissions", () => {
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

  function renderWithPermissions(
    permissions: string[],
    isSuperAdmin = false,
  ) {
    act(() => {
      root.render(
        <PermissionProvider permissions={permissions} isSuperAdmin={isSuperAdmin}>
          <QuickActions />
        </PermissionProvider>,
      );
    });
  }

  function actionLabels() {
    return [...host.querySelectorAll("a")].map((link) => link.textContent?.trim());
  }

  it("shows only route-permitted actions for a sales representative", () => {
    renderWithPermissions([
      PERMISSIONS.DASHBOARD_VIEW,
      PERMISSIONS.PRODUCTS_VIEW,
      PERMISSIONS.CATEGORIES_VIEW,
      PERMISSIONS.ORDERS_VIEW,
      PERMISSIONS.CUSTOMERS_VIEW,
    ]);

    expect(actionLabels()).toEqual([
      "Products",
      "Categories",
      "Orders",
      "Customers",
    ]);
  });

  it("tracks individual custom grants and revocations", () => {
    renderWithPermissions([PERMISSIONS.PRODUCTS_VIEW]);
    expect(actionLabels()).toEqual(["Products"]);

    renderWithPermissions([PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_CREATE]);
    expect(actionLabels()).toEqual(["Add product", "Products"]);

    renderWithPermissions([PERMISSIONS.PRODUCTS_VIEW]);
    expect(actionLabels()).toEqual(["Products"]);
  });

  it("retains every action for a superadmin", () => {
    renderWithPermissions([], true);

    expect(actionLabels()).toEqual(allActionLabels);
  });

  it("omits the card when permission context is empty or unavailable", () => {
    act(() => root.render(<QuickActions />));
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toBe("");

    renderWithPermissions([]);
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toBe("");
  });
});
