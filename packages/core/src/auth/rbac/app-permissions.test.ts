import { describe, expect, it } from "vitest";
import { isPluginGrantablePermission } from "../../modules/plugins/grants";
import { getPagePermission, hasPageAccess } from "./page-permissions";
import { PERMISSIONS, getAllPermissions, isSensitivePermission, permissionPrerequisites } from "./permissions";
import { getRoutePermission } from "./route-permissions";

describe("app (plugin) RBAC boundaries", () => {
  const view = { permission: PERMISSIONS.APPS_VIEW };
  const manage = { permission: PERMISSIONS.APPS_MANAGE };
  const use = { allOf: [PERMISSIONS.APPS_VIEW, PERMISSIONS.APPS_USE] };

  it("reads with apps.view and changes installations with apps.manage", () => {
    expect(getRoutePermission("/api/v1/admin/apps", "GET")).toEqual(view);
    expect(getRoutePermission("/api/v1/admin/apps/acme.loyalty", "GET")).toEqual(view);
    expect(getRoutePermission("/api/v1/admin/apps/acme.loyalty/logs", "GET")).toEqual(view);
    expect(getRoutePermission("/api/v1/admin/apps/acme.loyalty/deliveries", "GET")).toEqual(view);
    for (const path of ["activate", "deactivate", "uninstall"]) {
      expect(getRoutePermission(`/api/v1/admin/apps/acme.loyalty/${path}`, "POST")).toEqual(manage);
    }
    expect(getRoutePermission("/api/v1/admin/apps/acme.loyalty/settings", "PUT")).toEqual(manage);
    expect(getRoutePermission("/api/v1/admin/apps/acme.loyalty/deliveries/pld_1/retry", "POST")).toEqual(manage);
    // Unmapped methods stay denied.
    expect(getRoutePermission("/api/v1/admin/apps", "POST")).toBeNull();
    expect(getRoutePermission("/api/v1/admin/apps/acme.loyalty", "DELETE")).toBeNull();
  });

  it("guards an app's own dashboard routes at any depth: apps.view to read, apps.use as well to change", () => {
    expect(getRoutePermission("/api/v1/plugins/acme.loyalty/admin/dashboard", "GET")).toEqual(view);
    expect(getRoutePermission("/api/v1/plugins/acme.loyalty/admin/customers/c_1/points", "GET")).toEqual(view);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      expect(getRoutePermission("/api/v1/plugins/acme.loyalty/admin/adjust/c_1", method)).toEqual(use);
    }
    // No route name, no rule.
    expect(getRoutePermission("/api/v1/plugins/acme.loyalty/admin", "GET")).toBeNull();
    expect(getRoutePermission("/api/v1/plugins/acme.loyalty/public/greet", "GET")).toBeNull();
  });

  it("keeps the three permissions in the catalog, apps.manage sensitive, and closes them over apps.view", () => {
    expect(getAllPermissions().filter((meta) => meta.resource === "apps").map((meta) => meta.name).sort())
      .toEqual(["apps.manage", "apps.use", "apps.view"]);
    expect(isSensitivePermission(PERMISSIONS.APPS_MANAGE)).toBe(true);
    expect(isSensitivePermission(PERMISSIONS.APPS_VIEW)).toBe(false);
    expect(permissionPrerequisites(PERMISSIONS.APPS_USE)).toEqual([PERMISSIONS.APPS_VIEW]);
    expect(permissionPrerequisites(PERMISSIONS.APPS_MANAGE)).toEqual([PERMISSIONS.APPS_VIEW]);
  });

  it("never lets a plugin hold an app permission", () => {
    for (const permission of [PERMISSIONS.APPS_VIEW, PERMISSIONS.APPS_USE, PERMISSIONS.APPS_MANAGE]) {
      expect(isPluginGrantablePermission(permission)).toBe(false);
    }
    expect(isPluginGrantablePermission(PERMISSIONS.ORDERS_VIEW)).toBe(true);
  });

  it("opens the Apps pages with apps.view", () => {
    expect(getPagePermission("/admin/apps")).toEqual(view);
    expect(getPagePermission("/admin/apps/acme.loyalty")).toEqual(view);
    expect(hasPageAccess(new Set([PERMISSIONS.APPS_VIEW]), false, "/admin/apps/acme.loyalty")).toBe(true);
    expect(hasPageAccess(new Set([PERMISSIONS.ORDERS_VIEW]), false, "/admin/apps")).toBe(false);
  });
});
