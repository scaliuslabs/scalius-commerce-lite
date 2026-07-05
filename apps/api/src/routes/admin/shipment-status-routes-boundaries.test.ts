import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ORDERS_STATUS_SOURCE = fileURLToPath(new URL("./orders-status.ts", import.meta.url));
const SHIPMENTS_SOURCE = fileURLToPath(new URL("./shipments.ts", import.meta.url));

describe("admin shipment status route boundaries", () => {
  it("keeps order-scoped status and refresh routes on the shared sync helper", () => {
    const source = readFileSync(ORDERS_STATUS_SOURCE, "utf8");

    expect(source).toContain("checkAndSyncShipmentStatus");
    expect(source).toContain('source: "orders-shipment-status"');
    expect(source).toContain('source: "orders-shipment-refresh"');
    expect(source).not.toContain("const updatedShipment = await checkShipmentStatus");
    expect(source).not.toContain("catch (e: unknown) {\n        throw new ValidationError");
  });

  it("keeps shipment reconciliation repair order-scoped and permission-safe", () => {
    const source = readFileSync(ORDERS_STATUS_SOURCE, "utf8");

    expect(source).toContain('path: "/{id}/shipments/{shipmentId}/reconcile"');
    expect(source).toContain('summary: "Repair a shipment reconciliation lock"');
    expect(source).toContain("reconcileShipmentResponseSchema");
    expect(source).toContain('new Set(["shipped", "delivered", "returned", "cancelled"])');
    expect(source).toContain("OrdersService.reconcileOrderShipment(db, orderId, shipmentId)");
    expect(source).toContain('source: "orders-shipment-reconcile"');
    expect(source).toContain("newStatus: result.orderStatus");
    expect(source).toContain("`shipment:${shipmentId}:order_${result.orderStatus}`");
    expect(source).toContain("409: conflictResponse");
    expect(source).toContain("503: serviceUnavailableResponse");
    expect(source).not.toContain("createShipment(db, orderId");
    expect(source).not.toContain("checkAndSyncShipmentStatus({\n        db,\n        shipment,\n        encryptionKey,\n        c,\n        source: \"orders-shipment-reconcile\"");
  });

  it("keeps direct fulfillment-status updates blocked during active refunds", () => {
    const source = readFileSync(ORDERS_STATUS_SOURCE, "utf8");

    expect(source).toContain("assertNoActiveRefundAttempt");
    expect(source).toContain("await assertNoActiveRefundAttempt(db, orderId)");
  });

  it("keeps direct fulfillment-status updates blocked during active hosted payment setup", () => {
    const source = readFileSync(ORDERS_STATUS_SOURCE, "utf8");

    expect(source).toContain("assertNoActivePaymentSessionAttempt");
    expect(source).toContain("await assertNoActivePaymentSessionAttempt(db, orderId)");
  });

  it("keeps standalone shipment checks on the same sync helper and boolean response contract", () => {
    const source = readFileSync(SHIPMENTS_SOURCE, "utf8");

    expect(source).toContain("checkAndSyncShipmentStatus");
    expect(source).toContain("orderStatusUpdate: z.boolean()");
    expect(source).toContain('source: "shipments"');
    expect(source).not.toContain("No change needed");
    expect(source).not.toContain("updateOrderStatusFromShipment");
  });
});
