import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderStatus } from "@scalius/database/schema";

const mocks = vi.hoisted(() => ({
  applyInventoryForStatusChange: vi.fn(),
  createShipment: vi.fn(),
  markShipmentReconciliationRequired: vi.fn(),
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
  markShipmentReconciliationRequired: mocks.markShipmentReconciliationRequired,
}));

vi.mock("../payments/cod", () => ({
  markCODReturned: mocks.markCODReturned,
  recordCODCollection: mocks.recordCODCollection,
  recordCODFailure: mocks.recordCODFailure,
  validateCODCollectionDetails: mocks.validateCODCollectionDetails,
}));

import { bulkShipOrders, createFulfillmentShipment, processCodAction, updateOrderStatus } from "./orders.fulfillment";

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
  const batches: unknown[][] = [];

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
    insert() {
      return {
        values(values: unknown) {
          return values;
        },
      };
    },
    batch: vi.fn(async (statements: unknown[]) => {
      batches.push(statements);
      return statements;
    }),
  };

  return { db, updates, batches };
}

describe("orders fulfillment side-effect ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyInventoryForStatusChange.mockResolvedValue("deducted");
    mocks.createShipment.mockResolvedValue({ success: true, data: { id: "provider_shipment" } });
    mocks.markShipmentReconciliationRequired.mockResolvedValue(undefined);
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

  it("does not call the delivery provider when another shipment claim is active", async () => {
    const { db } = createDbMock({
      selectedOrder: {
        status: OrderStatus.CONFIRMED,
        version: 7,
        shipmentClaimId: "shp_active",
        shipmentClaimExpiresAt: new Date(Date.now() + 60_000),
      },
      updateResults: [],
    });

    const result = await bulkShipOrders(db as never, ["order_1"], "provider_1", {});

    expect(result).toEqual([
      {
        orderId: "order_1",
        success: false,
        error: "Order has an active shipment creation in progress. Please retry shortly.",
      },
    ]);
    expect(mocks.createShipment).not.toHaveBeenCalled();
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("sets an order shipment claim before calling the delivery provider", async () => {
    const { db, updates } = createDbMock({
      selectedOrder: { status: OrderStatus.CONFIRMED, version: 7 },
      updateResults: [[{ id: "order_1" }], [{ id: "order_1" }]],
    });

    const result = await bulkShipOrders(db as never, ["order_1"], "provider_1", {});

    expect(result[0]).toMatchObject({ orderId: "order_1", success: true });
    expect(updates[0]).toMatchObject({
      version: 8,
      shipmentClaimId: expect.stringMatching(/^shp_/),
    });
    expect(mocks.createShipment).toHaveBeenCalledWith(
      db,
      "order_1",
      "provider_1",
      {},
      undefined,
      { shipmentId: updates[0]?.shipmentClaimId },
    );
  });

  it("marks reconciliation required when provider succeeds but final order CAS fails", async () => {
    mocks.createShipment.mockResolvedValue({
      success: true,
      shipmentId: "shp_claim",
      data: { externalId: "ext_1", trackingId: "track_1", status: "pending" },
      message: "created",
    });
    const { db } = createDbMock({
      selectedOrder: { status: OrderStatus.CONFIRMED, version: 7 },
      updateResults: [[{ id: "order_1" }], []],
    });

    const result = await bulkShipOrders(db as never, ["order_1"], "provider_1", {});

    expect(result).toEqual([
      {
        orderId: "order_1",
        success: false,
        shipmentId: expect.stringMatching(/^shp_/),
        reconciliationRequired: true,
        error: "Shipment was created but order finalization requires reconciliation",
      },
    ]);
    expect(mocks.markShipmentReconciliationRequired).toHaveBeenCalledWith(
      db,
      expect.stringMatching(/^shp_/),
      "order_final_cas_conflict",
      { externalId: "ext_1", trackingId: "track_1", status: "pending" },
      "Order was modified concurrently after provider shipment creation",
    );
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("clears the shipment claim when provider shipment creation is rejected", async () => {
    mocks.createShipment.mockResolvedValue({ success: false, shipmentId: "shp_claim", message: "provider rejected" });
    const { db, updates } = createDbMock({
      selectedOrder: { status: OrderStatus.CONFIRMED, version: 7 },
      updateResults: [[{ id: "order_1" }]],
    });

    const result = await bulkShipOrders(db as never, ["order_1"], "provider_1", {});

    expect(result).toEqual([
      { orderId: "order_1", success: false, shipment: undefined, error: "provider rejected" },
    ]);
    expect(updates.at(-1)).toMatchObject({
      shipmentClaimId: null,
      shipmentClaimExpiresAt: null,
    });
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("reconciles inventory instead of calling the provider when bulk ship is retried after status was already shipped", async () => {
    const { db, updates } = createDbMock({
      selectedOrder: { status: OrderStatus.SHIPPED, version: 9 },
      updateResults: [],
    });

    const result = await bulkShipOrders(db as never, ["order_1"], "provider_1", {});

    expect(result).toEqual([
      { orderId: "order_1", success: true, message: "Order already shipped; inventory reconciled" },
    ]);
    expect(mocks.createShipment).not.toHaveBeenCalled();
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "order_1", OrderStatus.SHIPPED);
    expect(updates[0]).toMatchObject({ inventoryAction: "deducted" });
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

  it("reconciles delivered inventory before recording COD collection", async () => {
    const { db, updates } = createDbMock({
      selectedOrder: {
        status: OrderStatus.SHIPPED,
        version: 3,
        totalAmount: 100,
        paidAmount: 0,
        balanceDue: 100,
      },
      updateResults: [[{ id: "order_1" }]],
    });

    await processCodAction(db as never, "order_1", {
      action: "collected",
      collectedBy: "Courier A",
      collectedAmount: 100,
    });

    expect(updates[0]).toMatchObject({ status: OrderStatus.DELIVERED });
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "order_1", OrderStatus.DELIVERED);
    expect(mocks.recordCODCollection).toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ inventoryAction: "deducted" });
  });

  it("retries COD collection inventory reconciliation when the order is already delivered", async () => {
    const { db, updates } = createDbMock({
      selectedOrder: {
        status: OrderStatus.DELIVERED,
        version: 4,
        totalAmount: 100,
        paidAmount: 0,
        balanceDue: 100,
      },
      updateResults: [],
    });

    await processCodAction(db as never, "order_1", {
      action: "collected",
      collectedBy: "Courier A",
      collectedAmount: 100,
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ inventoryAction: "deducted" });
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "order_1", OrderStatus.DELIVERED);
    expect(mocks.recordCODCollection).toHaveBeenCalled();
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

  it("reconciles inventory when a final fulfillment shipment is retried after the order was already marked shipped", async () => {
    const { db, updates, batches } = createDbMock({
      selectedOrder: {
        id: "order_1",
        status: OrderStatus.SHIPPED,
        fulfillmentStatus: "complete",
        version: 6,
      },
      selectedRows: [
        { id: "item_1", fulfillmentStatus: "pending" },
      ],
      updateResults: [[{ id: "order_1" }]],
    });

    const result = await createFulfillmentShipment(db as never, "order_1", {
      itemIds: ["item_1"],
      isFinalShipment: true,
    });

    expect(result).toMatchObject({
      isFinalShipment: true,
      fulfillmentStatus: "complete",
    });
    expect(batches).toHaveLength(1);
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "order_1", OrderStatus.SHIPPED);
    expect(updates.at(-1)).toMatchObject({ inventoryAction: "deducted" });
  });

  it("reconciles inventory when an admin retries the same status update", async () => {
    const { db, updates } = createDbMock({
      selectedOrder: {
        status: OrderStatus.SHIPPED,
        inventoryAction: "reserved",
        version: 8,
        customerName: "Customer",
        customerEmail: "customer@example.com",
        paymentMethod: "cod",
        paymentStatus: "unpaid",
      },
      updateResults: [],
    });

    const result = await updateOrderStatus(db as never, "order_1", OrderStatus.SHIPPED);

    expect(result).toEqual({ message: "Status unchanged; inventory reconciled" });
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "order_1", OrderStatus.SHIPPED);
    expect(updates[0]).toMatchObject({ inventoryAction: "deducted" });
  });

  it("rejects admin status updates while a shipment claim is active", async () => {
    const { db } = createDbMock({
      selectedOrder: {
        status: OrderStatus.CONFIRMED,
        inventoryAction: "reserved",
        version: 8,
        customerName: "Customer",
        customerEmail: "customer@example.com",
        paymentMethod: "cod",
        paymentStatus: "unpaid",
        shipmentClaimId: "shp_active",
        shipmentClaimExpiresAt: new Date(Date.now() + 60_000),
      },
      updateResults: [],
    });

    await expect(updateOrderStatus(db as never, "order_1", OrderStatus.SHIPPED))
      .rejects.toThrow("active shipment creation");

    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });
});
