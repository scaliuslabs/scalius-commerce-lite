import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderStatus } from "@scalius/database/schema";

const mocks = vi.hoisted(() => ({
  applyInventoryForStatusChange: vi.fn(),
  createShipment: vi.fn(),
  markCODReturned: vi.fn(),
  recordCODCollection: vi.fn(),
  recordCODFailure: vi.fn(),
  validateCODCollectionDetails: vi.fn(),
}));

vi.mock("../inventory/inventory-transitions", () => ({
  applyInventoryForStatusChange: mocks.applyInventoryForStatusChange,
}));

vi.mock("../delivery/delivery.service", () => ({
  createShipment: mocks.createShipment,
}));

vi.mock("../payments/cod", () => ({
  markCODReturned: mocks.markCODReturned,
  recordCODCollection: mocks.recordCODCollection,
  recordCODFailure: mocks.recordCODFailure,
  validateCODCollectionDetails: mocks.validateCODCollectionDetails,
}));

import { bulkShipOrders, createFulfillmentShipment, processCodAction } from "./orders.fulfillment";

function createDbMock({
  selectedOrder,
  selectedRows,
  updateResults,
}: {
  selectedOrder: Record<string, unknown> | null;
  selectedRows?: Array<Record<string, unknown>>;
  updateResults: Array<Array<{ id: string }>>;
}) {
  const updates: Array<Record<string, unknown>> = [];

  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                get: async () => selectedOrder,
                all: async () => selectedRows ?? [],
              };
            },
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
                returning: async () => updateResults.shift() ?? [],
              };
            },
          };
        },
      };
    },
  };

  return { db, updates };
}

describe("orders fulfillment side-effect ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyInventoryForStatusChange.mockResolvedValue("deducted");
    mocks.createShipment.mockResolvedValue({ success: true, data: { id: "provider_shipment" } });
    mocks.markCODReturned.mockResolvedValue({ success: true });
    mocks.recordCODCollection.mockResolvedValue({ success: true });
    mocks.recordCODFailure.mockResolvedValue({ success: true });
    mocks.validateCODCollectionDetails.mockReturnValue({
      collectedBy: "Courier A",
      collectedAmount: 100,
      expectedAmount: 100,
      newPaidAmount: 100,
      newBalanceDue: 0,
    });
  });

  it("does not call the delivery provider when a bulk ship order claim loses CAS", async () => {
    const { db } = createDbMock({
      selectedOrder: { status: OrderStatus.CONFIRMED, version: 7 },
      updateResults: [[]],
    });

    const result = await bulkShipOrders(db as never, ["order_1"], "provider_1", {});

    expect(result).toEqual([
      { orderId: "order_1", success: false, error: "Order was modified concurrently" },
    ]);
    expect(mocks.createShipment).not.toHaveBeenCalled();
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("does not record COD collection when the delivered status CAS fails", async () => {
    const { db } = createDbMock({
      selectedOrder: {
        status: OrderStatus.SHIPPED,
        version: 3,
        totalAmount: 100,
        paidAmount: 0,
        balanceDue: 100,
      },
      updateResults: [[]],
    });

    await expect(
      processCodAction(db as never, "order_1", {
        action: "collected",
        collectedBy: "Courier A",
        collectedAmount: 100,
      }),
    ).rejects.toThrow("Order was modified by another request");

    expect(mocks.recordCODCollection).not.toHaveBeenCalled();
  });

  it("does not mark COD returned or apply inventory when the return CAS fails", async () => {
    const { db } = createDbMock({
      selectedOrder: {
        status: OrderStatus.SHIPPED,
        version: 4,
        totalAmount: 100,
        paidAmount: 0,
        balanceDue: 100,
      },
      updateResults: [[]],
    });

    await expect(
      processCodAction(db as never, "order_1", { action: "returned" }),
    ).rejects.toThrow("Order was modified by another request");

    expect(mocks.markCODReturned).not.toHaveBeenCalled();
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("does not apply inventory or write shipment rows when manual fulfillment claim fails", async () => {
    const { db } = createDbMock({
      selectedOrder: {
        id: "order_1",
        status: OrderStatus.CONFIRMED,
        fulfillmentStatus: "pending",
        version: 5,
      },
      selectedRows: [
        { id: "item_1", fulfillmentStatus: "pending" },
      ],
      updateResults: [[]],
    });

    await expect(
      createFulfillmentShipment(db as never, "order_1", {
        itemIds: ["item_1"],
        isFinalShipment: true,
      }),
    ).rejects.toThrow("Order was modified by another request");

    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });
});
