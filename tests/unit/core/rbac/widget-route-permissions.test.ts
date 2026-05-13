import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "../../../../packages/core/src/auth/rbac/permissions";
import { getRoutePermission } from "../../../../packages/core/src/auth/rbac/route-permissions";

describe("widget route permissions", () => {
  it("protects status toggles with the dedicated toggle permission", () => {
    expect(
      getRoutePermission("/api/v1/admin/widgets/widget_123/toggle-status", "PATCH"),
    ).toEqual({ permission: PERMISSIONS.WIDGETS_TOGGLE_STATUS });
  });

  it("protects manual history snapshots with widget edit permission", () => {
    expect(
      getRoutePermission("/api/v1/admin/widgets/widget_123/history", "POST"),
    ).toEqual({ permission: PERMISSIONS.WIDGETS_EDIT });
  });
});

describe("admin route permissions", () => {
  it("maps the current admin product routes instead of legacy product paths only", () => {
    expect(getRoutePermission("/api/v1/admin/products", "GET")).toEqual({
      permission: PERMISSIONS.PRODUCTS_VIEW,
    });
    expect(
      getRoutePermission("/api/v1/admin/products/product_123/variants/bulk-update", "PATCH"),
    ).toEqual({ permission: PERMISSIONS.PRODUCTS_EDIT });
  });

  it("maps sensitive settings and cache routes under their current API prefixes", () => {
    expect(
      getRoutePermission("/api/v1/admin/settings/delivery-providers/provider_123", "DELETE"),
    ).toEqual({ permission: PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_EDIT });
    expect(getRoutePermission("/api/v1/cache/clear-group", "POST")).toEqual({
      permission: PERMISSIONS.SETTINGS_CACHE_MANAGE,
    });
  });

  it("normalizes trailing slashes and leaves unknown admin routes unmapped for fail-closed middleware", () => {
    expect(getRoutePermission("/api/v1/admin/dashboard/", "GET")).toEqual({
      permission: PERMISSIONS.DASHBOARD_VIEW,
    });
    expect(getRoutePermission("/api/v1/admin/not-a-real-route", "GET")).toBeNull();
  });
});
