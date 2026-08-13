import { describe, expect, it } from "vitest";
import { getPagePermission, hasPageAccess } from "./page-permissions";
import { getRoutePermission } from "./route-permissions";
import { PERMISSIONS } from "./permissions";

describe("agent-access RBAC boundaries", () => {
  it("uses dedicated permissions for settings and consent pages", () => {
    expect(getPagePermission("/admin/settings/agent-access")).toEqual({
      permission: PERMISSIONS.AGENT_ACCESS_VIEW,
    });
    expect(
      getPagePermission("/admin/settings/agent-access/authorize/request-123"),
    ).toEqual({ permission: PERMISSIONS.AGENT_ACCESS_MANAGE });

    expect(
      hasPageAccess(
        new Set([PERMISSIONS.AGENT_ACCESS_VIEW]),
        false,
        "/admin/settings/agent-access/authorize/request-123",
      ),
    ).toBe(false);
  });

  it("separates connection reads from management mutations", () => {
    expect(
      getRoutePermission("/api/v1/admin/agent-access/connections", "GET"),
    ).toEqual({ permission: PERMISSIONS.AGENT_ACCESS_VIEW });
    expect(
      getRoutePermission("/api/v1/admin/agent-access/tokens", "POST"),
    ).toEqual({ permission: PERMISSIONS.AGENT_ACCESS_MANAGE });
    expect(
      getRoutePermission(
        "/api/v1/admin/agent-access/device-authorizations/device-1/approve",
        "POST",
      ),
    ).toEqual({ permission: PERMISSIONS.AGENT_ACCESS_MANAGE });
  });

  it("maps bounded export, invoice print, and inventory label artifacts to read authority", () => {
    expect(getRoutePermission("/api/v1/admin/orders/export", "GET")).toEqual({
      permission: PERMISSIONS.ORDERS_VIEW,
    });
    expect(
      getRoutePermission("/api/v1/admin/orders/order-1/invoice/print", "GET"),
    ).toEqual({ permission: PERMISSIONS.ORDERS_VIEW });
    expect(
      getRoutePermission("/api/v1/admin/inventory/labels/artifact", "POST"),
    ).toEqual({ permission: PERMISSIONS.PRODUCTS_VIEW });
    expect(
      getRoutePermission("/api/v1/admin/inventory/movements/export", "POST"),
    ).toEqual({ permission: PERMISSIONS.PRODUCTS_VIEW });
  });
});
