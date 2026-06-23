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

  it("keeps direct fulfillment-status updates blocked during active refunds", () => {
    const source = readFileSync(ORDERS_STATUS_SOURCE, "utf8");

    expect(source).toContain("assertNoActiveRefundAttempt");
    expect(source).toContain("await assertNoActiveRefundAttempt(db, orderId)");
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
