import { describe, expect, it } from "vitest";

import { PERMISSIONS } from "./permissions";
import { getRoutePermission } from "./route-permissions";

describe("route permissions", () => {
  it("keeps hosted-payment recovery queue and export read-only", () => {
    expect(getRoutePermission("/api/v1/admin/orders/payment-recovery", "GET"))
      .toEqual({ permission: PERMISSIONS.ORDERS_VIEW });

    expect(getRoutePermission("/api/v1/admin/orders/payment-recovery/export", "GET"))
      .toEqual({ permission: PERMISSIONS.ORDERS_VIEW });
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
