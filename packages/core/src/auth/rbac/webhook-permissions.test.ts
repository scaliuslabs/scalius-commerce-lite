import { describe, expect, it } from "vitest";
import { getPagePermission, hasPageAccess } from "./page-permissions";
import { getRoutePermission } from "./route-permissions";
import { PERMISSIONS, getAllPermissions, isSensitivePermission } from "./permissions";

describe("webhook RBAC boundaries", () => {
  it("separates reads (webhooks.view) from every mutation and send (webhooks.manage)", () => {
    const view = { permission: PERMISSIONS.WEBHOOKS_VIEW };
    const manage = { permission: PERMISSIONS.WEBHOOKS_MANAGE };
    expect(getRoutePermission("/api/v1/admin/webhooks", "GET")).toEqual(view);
    expect(getRoutePermission("/api/v1/admin/webhooks", "POST")).toEqual(manage);
    expect(getRoutePermission("/api/v1/admin/webhooks/whs_1", "GET")).toEqual(view);
    expect(getRoutePermission("/api/v1/admin/webhooks/whs_1", "PATCH")).toEqual(manage);
    expect(getRoutePermission("/api/v1/admin/webhooks/whs_1", "DELETE")).toEqual(manage);
    expect(getRoutePermission("/api/v1/admin/webhooks/whs_1/rotate-secret", "POST")).toEqual(manage);
    expect(getRoutePermission("/api/v1/admin/webhooks/whs_1/test", "POST")).toEqual(manage);
    expect(getRoutePermission("/api/v1/admin/webhooks/whs_1/deliveries", "GET")).toEqual(view);
    expect(getRoutePermission("/api/v1/admin/webhooks/whs_1/deliveries/whd_1/retry", "POST")).toEqual(manage);
    expect(getRoutePermission("/api/v1/admin/events", "GET")).toEqual(view);
    // Unmapped methods stay denied.
    expect(getRoutePermission("/api/v1/admin/webhooks/whs_1/test", "GET")).toBeNull();
    expect(getRoutePermission("/api/v1/admin/events", "POST")).toBeNull();
  });

  it("marks both permissions sensitive and gates the settings page on the view", () => {
    expect(isSensitivePermission(PERMISSIONS.WEBHOOKS_VIEW)).toBe(true);
    expect(isSensitivePermission(PERMISSIONS.WEBHOOKS_MANAGE)).toBe(true);
    expect(getAllPermissions().filter((meta) => meta.resource === "webhooks").map((meta) => meta.name).sort())
      .toEqual(["webhooks.manage", "webhooks.view"]);
    expect(getPagePermission("/admin/settings/webhooks")).toEqual({ permission: PERMISSIONS.WEBHOOKS_VIEW });
    expect(hasPageAccess(new Set([PERMISSIONS.WEBHOOKS_VIEW]), false, "/admin/settings/webhooks")).toBe(true);
    expect(hasPageAccess(new Set([PERMISSIONS.SETTINGS_GENERAL_VIEW]), false, "/admin/settings/webhooks")).toBe(false);
  });
});
