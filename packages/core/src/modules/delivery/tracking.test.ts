import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderStatus } from "@scalius/database/schema";

const mocks = vi.hoisted(() => ({
  applyInventoryForStatusChange: vi.fn(),
}));

vi.mock("../inventory/inventory-transitions", () => ({
  applyInventoryForStatusChange: mocks.applyInventoryForStatusChange,
}));

import { updateOrderStatusFromShipment } from "./tracking";

function createDbMock({
  shipmentStatus,
  orderStatus,
  orderOverrides = {},
  updateRows = [{ id: "order_1" }],
}: {
  shipmentStatus: string;
  orderStatus: string;
  orderOverrides?: Record<string, unknown>;
  updateRows?: Array<{ id: string }>;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const selectResults = [
    [{ id: "shipment_1", orderId: "order_1", status: shipmentStatus }],
    [{
      id: "order_1",
      status: orderStatus,
      version: 5,
      customerPhone: "01700000000",
      customerEmail: "customer@example.com",
      ...orderOverrides,
    }],
  ];

  const db = {
    select() {
      return {
        from() {
          return {
            where: async () => selectResults.shift() ?? [],
          };
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push(values);
          return {
            where() {
              return {
                returning: async () => updateRows,
              };
            },
          };
        },
      };
    },
  };

  return { db, updates };
}

describe("delivery shipment to order status mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.applyInventoryForStatusChange.mockResolvedValue("deducted");
  });

  it("maps out_for_delivery to shipped", async () => {
    const { db, updates } = createDbMock({
      shipmentStatus: "out_for_delivery",
      orderStatus: OrderStatus.CONFIRMED,
    });

    const result = await updateOrderStatusFromShipment(db as never, "shipment_1", "out_for_delivery");

    expect(result).toMatchObject({
      orderId: "order_1",
      previousStatus: OrderStatus.CONFIRMED,
      newStatus: OrderStatus.SHIPPED,
    });
    expect(updates[0]).toMatchObject({ status: OrderStatus.SHIPPED, version: 6 });
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(
      db,
      "order_1",
      OrderStatus.SHIPPED,
    );
  });

  it("maps delivery_failed to confirmed for retryable shipped orders", async () => {
    const { db, updates } = createDbMock({
      shipmentStatus: "delivery_failed",
      orderStatus: OrderStatus.SHIPPED,
    });

    const result = await updateOrderStatusFromShipment(db as never, "shipment_1", "delivery_failed");

    expect(result).toMatchObject({
      previousStatus: OrderStatus.SHIPPED,
      newStatus: OrderStatus.CONFIRMED,
    });
    expect(updates[0]).toMatchObject({ status: OrderStatus.CONFIRMED });
  });

  it("maps partial_delivered to delivered", async () => {
    const { db, updates } = createDbMock({
      shipmentStatus: "partial_delivered",
      orderStatus: OrderStatus.SHIPPED,
    });

    const result = await updateOrderStatusFromShipment(db as never, "shipment_1", "partial_delivered");

    expect(result).toMatchObject({
      previousStatus: OrderStatus.SHIPPED,
      newStatus: OrderStatus.DELIVERED,
    });
    expect(updates[0]).toMatchObject({ status: OrderStatus.DELIVERED });
  });

  it("allows delivered webhooks to move confirmed orders directly to delivered", async () => {
    const { db, updates } = createDbMock({
      shipmentStatus: "delivered",
      orderStatus: OrderStatus.CONFIRMED,
    });

    const result = await updateOrderStatusFromShipment(db as never, "shipment_1", "delivered");

    expect(result).toMatchObject({
      previousStatus: OrderStatus.CONFIRMED,
      newStatus: OrderStatus.DELIVERED,
    });
    expect(updates[0]).toMatchObject({ status: OrderStatus.DELIVERED });
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(
      db,
      "order_1",
      OrderStatus.DELIVERED,
    );
  });

  it("does not apply inventory when the order status CAS loses", async () => {
    const { db } = createDbMock({
      shipmentStatus: "out_for_delivery",
      orderStatus: OrderStatus.CONFIRMED,
      updateRows: [],
    });

    const result = await updateOrderStatusFromShipment(db as never, "shipment_1", "out_for_delivery");

    expect(result).toBeNull();
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("throws during an active shipment claim so delivery webhooks can retry", async () => {
    const { db } = createDbMock({
      shipmentStatus: "out_for_delivery",
      orderStatus: OrderStatus.CONFIRMED,
      orderOverrides: {
        shipmentClaimId: "shp_active",
        shipmentClaimExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    await expect(updateOrderStatusFromShipment(db as never, "shipment_1", "out_for_delivery"))
      .rejects.toThrow("active shipment creation");

    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("reconciles inventory when shipment status maps to the current order status", async () => {
    const { db, updates } = createDbMock({
      shipmentStatus: "out_for_delivery",
      orderStatus: OrderStatus.SHIPPED,
    });

    const result = await updateOrderStatusFromShipment(db as never, "shipment_1", "out_for_delivery");

    expect(result).toBeNull();
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(
      db,
      "order_1",
      OrderStatus.SHIPPED,
    );
    expect(updates[0]).toMatchObject({ inventoryAction: "deducted" });
  });
});
