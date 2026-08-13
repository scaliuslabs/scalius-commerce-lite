import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { adminCustomerRoutes } from "./customers";
import { adminDiscountRoutes } from "./discounts";
import { adminOrdersRoutes } from "./orders";
import { adminPromotionRoutes } from "./promotions";
import { adminShipmentRoutes } from "./shipments";
import { adminSystemUtilsRoutes } from "./system-utils";

const EXPECTED_OPERATIONS = {
  "GET /api/v1/admin/orders/catalog-products": "dashboard.orders.catalog_products",
  "GET /api/v1/admin/orders": "dashboard.orders.list",
  "GET /api/v1/admin/orders/export": "dashboard.orders.export",
  "GET /api/v1/admin/orders/payment-recovery": "dashboard.orders.payment_recovery_list",
  "GET /api/v1/admin/orders/payment-recovery/export": "dashboard.orders.payment_recovery_export",
  "POST /api/v1/admin/orders/quote": "dashboard.orders.quote",
  "POST /api/v1/admin/orders": "dashboard.orders.create",
  "POST /api/v1/admin/orders/archive": "dashboard.orders.archive",
  "POST /api/v1/admin/orders/bulk-ship": "dashboard.orders.bulk_ship",
  "POST /api/v1/admin/orders/{id}/payment-recovery-link": "dashboard.orders.payment_recovery_link",
  "GET /api/v1/admin/orders/{id}": "dashboard.orders.get",
  "PUT /api/v1/admin/orders/{id}": "dashboard.orders.update",
  "POST /api/v1/admin/orders/{id}/restore": "dashboard.orders.restore",
  "GET /api/v1/admin/orders/{id}/items": "dashboard.orders.items",
  "GET /api/v1/admin/orders/{id}/payments": "dashboard.orders.payments",
  "GET /api/v1/admin/orders/{id}/notifications": "dashboard.orders.notifications",
  "POST /api/v1/admin/orders/{id}/notifications/{outboxId}/retry": "dashboard.orders.notification_retry",
  "POST /api/v1/admin/orders/{id}/notifications/{outboxId}/resend": "dashboard.orders.notification_resend",
  "GET /api/v1/admin/orders/{id}/form-data": "dashboard.orders.form_data",
  "PUT /api/v1/admin/orders/{id}/status": "dashboard.orders.update_status",
  "GET /api/v1/admin/orders/{id}/cod": "dashboard.orders.cod_get",
  "POST /api/v1/admin/orders/{id}/cod": "dashboard.orders.cod_update",
  "GET /api/v1/admin/orders/{id}/fulfill": "dashboard.orders.fulfillment_get",
  "POST /api/v1/admin/orders/{id}/fulfill": "dashboard.orders.fulfill",
  "GET /api/v1/admin/orders/{id}/shipments": "dashboard.orders.shipments",
  "POST /api/v1/admin/orders/{id}/shipments": "dashboard.orders.create_shipment",
  "GET /api/v1/admin/orders/{id}/shipments/{shipmentId}": "dashboard.orders.shipment_get",
  "DELETE /api/v1/admin/orders/{id}/shipments/{shipmentId}": "dashboard.orders.shipment_delete",
  "POST /api/v1/admin/orders/{id}/shipments/{shipmentId}/status": "dashboard.orders.shipment_status_sync",
  "POST /api/v1/admin/orders/{id}/shipments/{shipmentId}/refresh": "dashboard.orders.shipment_refresh",
  "POST /api/v1/admin/orders/{id}/shipments/{shipmentId}/reconcile": "dashboard.orders.shipment_reconcile",
  "POST /api/v1/admin/orders/{id}/refund": "dashboard.orders.refund",
  "POST /api/v1/admin/orders/{id}/refund-attempts/{attemptId}/reconcile": "dashboard.orders.refund_reconcile",
  "GET /api/v1/admin/orders/{id}/invoice": "dashboard.orders.invoice_get",
  "POST /api/v1/admin/orders/{id}/invoice": "dashboard.orders.invoice_issue",
  "GET /api/v1/admin/orders/{id}/invoice/print": "dashboard.orders.invoice_print",
  "PUT /api/v1/admin/orders/{id}/support-requests/{requestId}/status": "dashboard.orders.support_request_update",
  "GET /api/v1/admin/orders/{id}/returns": "dashboard.orders.returns",
  "GET /api/v1/admin/orders/{id}/returns/{returnId}": "dashboard.orders.return_get",
  "POST /api/v1/admin/orders/{id}/returns": "dashboard.orders.return_create",
  "POST /api/v1/admin/orders/{id}/returns/{returnId}/approve": "dashboard.orders.return_approve",
  "POST /api/v1/admin/orders/{id}/returns/{returnId}/receive": "dashboard.orders.return_receive",
  "POST /api/v1/admin/orders/{id}/returns/{returnId}/cancel": "dashboard.orders.return_cancel",
  "POST /api/v1/admin/orders/{id}/returns/{returnId}/reconcile": "dashboard.orders.return_reconcile",
  "GET /api/v1/admin/customers": "dashboard.customers.list",
  "POST /api/v1/admin/customers": "dashboard.customers.create",
  "POST /api/v1/admin/customers/bulk-delete": "dashboard.customers.bulk_delete",
  "GET /api/v1/admin/customers/{id}": "dashboard.customers.get",
  "PUT /api/v1/admin/customers/{id}": "dashboard.customers.update",
  "DELETE /api/v1/admin/customers/{id}": "dashboard.customers.delete",
  "DELETE /api/v1/admin/customers/{id}/permanent": "dashboard.customers.delete_permanently",
  "POST /api/v1/admin/customers/{id}/restore": "dashboard.customers.restore",
  "GET /api/v1/admin/customers/{id}/history": "dashboard.customers.history",
  "GET /api/v1/admin/discounts": "dashboard.discounts.list",
  "POST /api/v1/admin/discounts": "dashboard.discounts.create",
  "POST /api/v1/admin/discounts/bulk-delete": "dashboard.discounts.bulk_delete",
  "POST /api/v1/admin/discounts/bulk-restore": "dashboard.discounts.bulk_restore",
  "GET /api/v1/admin/discounts/{id}": "dashboard.discounts.get",
  "PUT /api/v1/admin/discounts/{id}": "dashboard.discounts.update",
  "DELETE /api/v1/admin/discounts/{id}": "dashboard.discounts.delete",
  "DELETE /api/v1/admin/discounts/{id}/permanent": "dashboard.discounts.delete_permanently",
  "POST /api/v1/admin/discounts/{id}/toggle-status": "dashboard.discounts.set_active",
  "POST /api/v1/admin/discounts/{id}/restore": "dashboard.discounts.restore",
  "GET /api/v1/admin/promotions": "dashboard.promotions.list",
  "POST /api/v1/admin/promotions": "dashboard.promotions.create",
  "GET /api/v1/admin/promotions/{id}": "dashboard.promotions.get",
  "PUT /api/v1/admin/promotions/{id}": "dashboard.promotions.update",
  "POST /api/v1/admin/promotions/{id}/preview": "dashboard.promotions.preview",
  "POST /api/v1/admin/promotions/{id}/activate": "dashboard.promotions.activate",
  "POST /api/v1/admin/promotions/{id}/pause": "dashboard.promotions.pause",
  "DELETE /api/v1/admin/promotions/{id}": "dashboard.promotions.archive",
  "GET /api/v1/admin/abandoned-checkouts": "dashboard.abandoned_checkouts.list",
  "GET /api/v1/admin/abandoned-checkouts/summaries": "dashboard.abandoned_checkouts.summaries_list",
  "POST /api/v1/admin/abandoned-checkouts/bulk-delete": "dashboard.abandoned_checkouts.bulk_delete_legacy",
  "DELETE /api/v1/admin/abandoned-checkouts": "dashboard.abandoned_checkouts.delete",
  "GET /api/v1/admin/shipments/{id}": "dashboard.shipments.get",
  "DELETE /api/v1/admin/shipments/{id}": "dashboard.shipments.delete",
  "POST /api/v1/admin/shipments/{id}/check-status": "dashboard.shipments.status_sync",
} as const;

type OpenApiOperation = { operationId?: string };

function buildSpec() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.route("/orders", adminOrdersRoutes);
  app.route("/customers", adminCustomerRoutes);
  app.route("/discounts", adminDiscountRoutes);
  app.route("/promotions", adminPromotionRoutes);
  app.route("/shipments", adminShipmentRoutes);
  app.route("/", adminSystemUtilsRoutes);
  return app.getOpenAPIDocument({
    openapi: "3.0.0",
    info: { title: "Commerce operation IDs", version: "1.0.0" },
  });
}

describe("commerce and CRM agent operation IDs", () => {
  it("publishes the exact stable reviewed operation ID for every semantic route", () => {
    const spec = buildSpec();
    const seen = new Set<string>();
    for (const [key, expectedOperationId] of Object.entries(EXPECTED_OPERATIONS)) {
      const [method, path] = key.split(" ", 2) as [string, string];
      const operation = spec.paths?.[path]?.[
        method.toLowerCase() as keyof (typeof spec.paths)[string]
      ] as OpenApiOperation | undefined;
      expect(operation, `missing ${key}`).toBeDefined();
      expect(operation?.operationId, key).toBe(expectedOperationId);
      expect(seen.has(expectedOperationId), `${expectedOperationId} must be unique`).toBe(false);
      seen.add(expectedOperationId);
    }
  });
});
