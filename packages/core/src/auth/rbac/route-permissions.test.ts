import { describe, expect, it } from "vitest";

import { PERMISSIONS } from "./permissions";
import { getRoutePermission } from "./route-permissions";

describe("route permissions", () => {
  it("gates read-only admin chat behind dashboard view instead of widget editing", () => {
    expect(getRoutePermission("/api/v1/admin/ai/chat", "POST")).toEqual({
      permission: PERMISSIONS.DASHBOARD_VIEW,
    });
  });

  it("gates redacted Admin MCP notification settings summary behind settings.general.view", () => {
    expect(
      getRoutePermission(
        "/api/v1/admin/settings/notification-channels/mcp-summary",
        "GET",
      ),
    ).toEqual({ permission: PERMISSIONS.SETTINGS_GENERAL_VIEW });
  });

  it("gates redacted Admin MCP customer search behind customers.view", () => {
    expect(getRoutePermission("/api/v1/admin/customers/mcp-search", "POST"))
      .toEqual({ permission: PERMISSIONS.CUSTOMERS_VIEW });
  });

  it("keeps hosted-payment recovery queue and export read-only", () => {
    expect(getRoutePermission("/api/v1/admin/orders/payment-recovery", "GET"))
      .toEqual({ permission: PERMISSIONS.ORDERS_VIEW });

    expect(getRoutePermission("/api/v1/admin/orders/payment-recovery/export", "GET"))
      .toEqual({ permission: PERMISSIONS.ORDERS_VIEW });
  });

  it("gates buyer payment recovery link issuance behind order edit permission", () => {
    expect(getRoutePermission(
      "/api/v1/admin/orders/order_1/payment-recovery-link",
      "POST",
    )).toEqual({ permission: PERMISSIONS.ORDERS_EDIT });
  });

  it("keeps order notification history read-only and retry mutation gated", () => {
    expect(getRoutePermission("/api/v1/admin/orders/order_1/notifications", "GET"))
      .toEqual({ permission: PERMISSIONS.ORDERS_VIEW });

    expect(
      getRoutePermission(
        "/api/v1/admin/orders/order_1/notifications/outbox_1/retry",
        "POST",
      ),
    ).toEqual({ permission: PERMISSIONS.ORDERS_EDIT });

    expect(
      getRoutePermission(
        "/api/v1/admin/orders/order_1/notifications/outbox_1/resend",
        "POST",
      ),
    ).toEqual({ permission: PERMISSIONS.ORDERS_EDIT });
  });

  it("gates manual refund recovery behind refund permission", () => {
    expect(
      getRoutePermission(
        "/api/v1/admin/orders/order_1/refund-attempts/rfa_1/reconcile",
        "POST",
      ),
    ).toEqual({ permission: PERMISSIONS.ORDERS_REFUND });
  });

  it("gates shipment recovery repair behind shipment management permission", () => {
    expect(
      getRoutePermission(
        "/api/v1/admin/orders/order_1/shipments/shp_1/reconcile",
        "POST",
      ),
    ).toEqual({ permission: PERMISSIONS.ORDERS_MANAGE_SHIPMENTS });
  });

  it("gates order support request resolution behind order edit permission", () => {
    expect(
      getRoutePermission(
        "/api/v1/admin/orders/order_1/support-requests/osr_1/status",
        "PUT",
      ),
    ).toEqual({ permission: PERMISSIONS.ORDERS_EDIT });

    expect(
      getRoutePermission(
        "/api/v1/admin/orders/order_1/support-requests/osr_1/status",
        "POST",
      ),
    ).toEqual({ permission: PERMISSIONS.ORDERS_EDIT });
  });
});
