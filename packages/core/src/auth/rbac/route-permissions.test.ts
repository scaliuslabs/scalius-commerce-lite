import { describe, expect, it } from "vitest";

import { PERMISSIONS } from "./permissions";
import { getRoutePermission } from "./route-permissions";

describe("route permissions", () => {
  it("gates the atomic normalized option matrix behind product edit permission", () => {
    expect(getRoutePermission(
      "/api/v1/admin/products/prod_1/options/matrix",
      "PUT",
    )).toEqual({ permission: PERMISSIONS.PRODUCTS_EDIT });
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

  it("separates tax reads and previews from tax mutations", () => {
    expect(getRoutePermission("/api/v1/admin/taxes", "GET"))
      .toEqual({ permission: PERMISSIONS.TAXES_VIEW });
    expect(getRoutePermission("/api/v1/admin/taxes/preview", "POST"))
      .toEqual({ permission: PERMISSIONS.TAXES_VIEW });
    expect(getRoutePermission("/api/v1/admin/taxes/settings", "PUT"))
      .toEqual({ permission: PERMISSIONS.TAXES_MANAGE });
    expect(getRoutePermission("/api/v1/admin/taxes/classes/taxc_1", "DELETE"))
      .toEqual({ permission: PERMISSIONS.TAXES_MANAGE });
    expect(getRoutePermission("/api/v1/admin/taxes/rates/taxr_1", "PUT"))
      .toEqual({ permission: PERMISSIONS.TAXES_MANAGE });
    expect(getRoutePermission(
      "/api/v1/admin/taxes/classifications/variant/sku_1",
      "PUT",
    )).toEqual({ permission: PERMISSIONS.TAXES_MANAGE });
  });

});
