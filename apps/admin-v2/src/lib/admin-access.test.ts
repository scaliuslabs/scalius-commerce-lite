import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import {
  canAccessAdminPath,
  getDefaultAdminPath,
  hasRbacAdminAccess,
  shouldAllowAdminPath,
} from "./admin-access";

describe("admin shell access", () => {
  it("does not grant shell access from legacy role alone", () => {
    expect(
      hasRbacAdminAccess({ isSuperAdmin: false, permissions: new Set() }),
    ).toBe(false);
  });

  it("grants shell access to super admins and permission-bearing users", () => {
    expect(
      hasRbacAdminAccess({ isSuperAdmin: true, permissions: new Set() }),
    ).toBe(true);
    expect(
      hasRbacAdminAccess({
        isSuperAdmin: false,
        permissions: new Set(["products.view"]),
      }),
    ).toBe(true);
  });

  it("keeps the access-denied page reachable without opening the shell", () => {
    expect(shouldAllowAdminPath("/admin", false)).toBe(false);
    expect(shouldAllowAdminPath("/admin/products", false)).toBe(false);
    expect(shouldAllowAdminPath("/admin/access-denied", false)).toBe(true);
  });

  it("requires route-specific permissions for deep links", () => {
    const productViewer = {
      isSuperAdmin: false,
      hasAdminAccess: true,
      permissions: new Set([PERMISSIONS.PRODUCTS_VIEW]),
    };

    expect(canAccessAdminPath("/admin/products", productViewer)).toBe(true);
    expect(canAccessAdminPath("/admin/products/abc", productViewer)).toBe(true);
    expect(canAccessAdminPath("/admin/products/abc/edit", productViewer)).toBe(false);
    expect(canAccessAdminPath("/admin/products/new", productViewer)).toBe(false);
  });

  it("allows the account page to any authenticated user with admin access", () => {
    expect(
      canAccessAdminPath("/admin/settings/account", {
        isSuperAdmin: false,
        hasAdminAccess: true,
        permissions: new Set([PERMISSIONS.PRODUCTS_VIEW]),
      }),
    ).toBe(true);
  });

  it("redirects /admin to the first allowed section when dashboard is unavailable", () => {
    const productViewer = {
      isSuperAdmin: false,
      hasAdminAccess: true,
      permissions: new Set([PERMISSIONS.PRODUCTS_VIEW]),
    };

    expect(canAccessAdminPath("/admin", productViewer)).toBe(false);
    expect(getDefaultAdminPath(productViewer)).toBe("/admin/products");
  });

  it("fails closed for unmapped admin paths", () => {
    expect(
      canAccessAdminPath("/admin/experimental", {
        isSuperAdmin: false,
        hasAdminAccess: true,
        permissions: new Set([PERMISSIONS.DASHBOARD_VIEW]),
      }),
    ).toBe(false);
  });

  it("allows super admins through mapped routes", () => {
    expect(
      canAccessAdminPath("/admin/settings/cache", {
        isSuperAdmin: true,
        hasAdminAccess: true,
        permissions: new Set(),
      }),
    ).toBe(true);
  });
});
