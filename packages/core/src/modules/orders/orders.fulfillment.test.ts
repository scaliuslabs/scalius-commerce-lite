import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  codTracking,
  deliveryShipments,
  orderPayments,
  paymentSessionAttempts,
  refundAttempts,
  CodStatus,
  ItemFulfillmentStatus,
  OrderStatus,
  PaymentMethod,
  PaymentRecordStatus,
  PaymentStatus,
  ShipmentStatus,
} from "@scalius/database/schema";

const mocks = vi.hoisted(() => ({
  applyInventoryForStatusChange: vi.fn(),
  createShipment: vi.fn(),
  getDeliveryProviderActionReadiness: vi.fn(),
  markShipmentReconciliationRequired: vi.fn(),
  markCODReturned: vi.fn(),
  recordCODCollection: vi.fn(),
  recordCODFailure: vi.fn(),
  validateCODCollectionDetails: vi.fn(),
  listOrderReturns: vi.fn(),
  createOrderReturn: vi.fn(),
  getOrderReturn: vi.fn(),
  approveOrderReturn: vi.fn(),
}));

vi.mock("../inventory/inventory-transitions", () => ({
  applyInventoryForStatusChangeWithImpact: mocks.applyInventoryForStatusChange,
}));

vi.mock("../delivery/delivery.service", () => ({
  createShipment: mocks.createShipment,
  getDeliveryProviderActionReadiness: mocks.getDeliveryProviderActionReadiness,
  markShipmentReconciliationRequired: mocks.markShipmentReconciliationRequired,
}));

vi.mock("../payments/cod", () => ({
  markCODReturned: mocks.markCODReturned,
  recordCODCollection: mocks.recordCODCollection,
  recordCODFailure: mocks.recordCODFailure,
  validateCODCollectionDetails: mocks.validateCODCollectionDetails,
}));

vi.mock("./order-returns", () => ({
  listOrderReturns: mocks.listOrderReturns,
  createOrderReturn: mocks.createOrderReturn,
  getOrderReturn: mocks.getOrderReturn,
  approveOrderReturn: mocks.approveOrderReturn,
}));

import { bulkShipOrders, createFulfillmentShipment, processCodAction, updateOrderStatus } from "./orders.fulfillment";

function createDbMock({
  selectedOrder,
  selectedRows,
  selectedPayment,
  selectedLegacyPendingRefund,
  selectedCodTracking,
  selectedShipment,
  selectedRefundAttempt,
  selectedPaymentSessionAttemptRows,
  updateResults,
  batchError,
}: {
  selectedOrder: Record<string, unknown> | null;
  selectedRows?: Array<Record<string, unknown>>;
  selectedPayment?: Record<string, unknown> | null;
  selectedLegacyPendingRefund?: Record<string, unknown> | null;
  selectedCodTracking?: Record<string, unknown> | null;
  selectedShipment?: Record<string, unknown> | null;
  selectedRefundAttempt?: Record<string, unknown> | null;
  selectedPaymentSessionAttemptRows?: Array<Record<string, unknown>>;
  updateResults: Array<Array<{ id: string }>>;
  batchError?: Error;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const batches: unknown[][] = [];
  let orderPaymentSelectCount = 0;

  const db = {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              const chain = {
                groupBy: () => chain,
                get: async () => {
                  if (table === orderPayments) {
                    orderPaymentSelectCount += 1;
                    return orderPaymentSelectCount === 1
                      ? selectedLegacyPendingRefund ?? null
                      : selectedPayment ?? null;
                  }
                  if (table === paymentSessionAttempts) return selectedPaymentSessionAttemptRows?.[0] ?? null;
                  if (table === codTracking) return selectedCodTracking ?? null;
                  if (table === deliveryShipments) return selectedShipment ?? null;
                  if (table === refundAttempts) return selectedRefundAttempt ?? null;
                  return selectedOrder;
                },
                all: async () => {
                  if (table === paymentSessionAttempts) return selectedPaymentSessionAttemptRows ?? [];
                  return selectedRows ?? [];
                },
              };
              return chain;
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
      if (batchError) throw batchError;
      return statements;
    }),
  };

  return { db, updates, batches };
}

describe("orders fulfillment side-effect ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyInventoryForStatusChange.mockResolvedValue({
      inventoryAction: "deducted",
      availabilityTransitionVariantIds: [],
    });
    mocks.createShipment.mockResolvedValue({ success: true, data: { id: "provider_shipment" } });
    mocks.getDeliveryProviderActionReadiness.mockResolvedValue({
      ready: true,
      provider: { id: "provider_1" },
      summary: { active: true },
    });
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
    mocks.listOrderReturns.mockResolvedValue([]);
    mocks.createOrderReturn.mockResolvedValue({ returnId: "ret_1" });
    mocks.getOrderReturn.mockResolvedValue({
      id: "ret_1",
      status: "requested",
      version: 1,
      lines: [{ id: "rtl_1", requestedQuantity: 1 }],
    });
    mocks.approveOrderReturn.mockResolvedValue({ returnId: "ret_1", status: "approved" });
  });

  it("rejects duplicate and oversized bulk jobs before provider readiness work", async () => {
    const { db } = createDbMock({
      selectedOrder: { status: OrderStatus.CONFIRMED, version: 7 },
      updateResults: [[{ id: "order_1" }]],
    });

    await expect(
      bulkShipOrders(db as never, ["order_1", "order_1"], "provider_1", {}),
    ).rejects.toThrow("Each order can appear only once");
    await expect(
      bulkShipOrders(
        db as never,
        Array.from({ length: 91 }, (_, index) => `order_${index}`),
        "provider_1",
        {},
      ),
    ).rejects.toThrow("Ship at most 90 orders at a time");

    expect(mocks.getDeliveryProviderActionReadiness).not.toHaveBeenCalled();
    expect(mocks.createShipment).not.toHaveBeenCalled();
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

  it("does not claim orders or create shipments when the provider is not action-ready", async () => {
    mocks.getDeliveryProviderActionReadiness.mockResolvedValueOnce({
      ready: false,
      provider: { id: "provider_1" },
      message: "Delivery provider provider_1 is not ready for shipment creation: Delivery provider must pass a live connection test for the current setup.",
    });
    const { db, updates } = createDbMock({
      selectedOrder: { status: OrderStatus.CONFIRMED, version: 7 },
      updateResults: [[{ id: "order_1" }]],
    });

    const result = await bulkShipOrders(db as never, ["order_1", "order_2"], "provider_1", {});

    expect(result).toEqual([
      {
        orderId: "order_1",
        success: false,
        error: "Delivery provider provider_1 is not ready for shipment creation: Delivery provider must pass a live connection test for the current setup.",
      },
      {
        orderId: "order_2",
        success: false,
        error: "Delivery provider provider_1 is not ready for shipment creation: Delivery provider must pass a live connection test for the current setup.",
      },
    ]);
    expect(updates).toHaveLength(0);
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

  it("does not call the delivery provider when a refund attempt is active", async () => {
    const { db } = createDbMock({
      selectedOrder: { status: OrderStatus.CONFIRMED, version: 7 },
      selectedRefundAttempt: { id: "rfa_1", orderId: "order_1", status: "provider_unknown" },
      updateResults: [],
    });

    const result = await bulkShipOrders(db as never, ["order_1"], "provider_1", {});

    expect(result).toEqual([
      {
        orderId: "order_1",
        success: false,
        error: "Order has an active refund operation. Complete or reconcile the refund before shipping this order.",
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

  it("keeps the shipment claim and records repair state when final shipment inventory fails", async () => {
    const inventoryError = new Error("inventory failed");
    mocks.applyInventoryForStatusChange.mockRejectedValueOnce(inventoryError);
    mocks.createShipment.mockResolvedValue({
      success: true,
      shipmentId: "shp_claim",
      data: {
        externalId: "ext_1",
        trackingId: "track_1",
        status: "pending",
        metadata: { provider: "steadfast" },
      },
      message: "created",
    });
    const { db, updates } = createDbMock({
      selectedOrder: { status: OrderStatus.CONFIRMED, version: 7 },
      updateResults: [[{ id: "order_1" }], [{ id: "order_1" }]],
    });

    const result = await bulkShipOrders(db as never, ["order_1"], "provider_1", {});

    expect(result).toEqual([
      {
        orderId: "order_1",
        success: false,
        shipmentId: expect.stringMatching(/^shp_/),
        reconciliationRequired: true,
        error: "Shipment was created but inventory reconciliation requires repair",
      },
    ]);
    expect(updates).toContainEqual(expect.objectContaining({
      shipmentClaimExpiresAt: null,
    }));
    expect(updates).not.toContainEqual(expect.objectContaining({
      shipmentClaimId: null,
    }));
    expect(mocks.markShipmentReconciliationRequired).toHaveBeenCalledWith(
      db,
      expect.stringMatching(/^shp_/),
      "order_status_inventory_reconcile_failed",
      expect.objectContaining({
        externalId: "ext_1",
        trackingId: "track_1",
        status: "pending",
        metadata: expect.objectContaining({
          provider: "steadfast",
          orderStatusSync: {
            shipmentStatus: "pending",
            orderStatus: OrderStatus.SHIPPED,
            failedStep: "inventory_reconciliation",
          },
        }),
      }),
      inventoryError,
    );
  });

  it("repairs a reconcile-required provider shipment without calling the provider again", async () => {
    const { db, updates } = createDbMock({
      selectedOrder: {
        status: OrderStatus.CONFIRMED,
        version: 7,
        fulfillmentStatus: "pending",
        shipmentClaimId: "shp_claim",
      },
      selectedShipment: {
        id: "shp_claim",
        orderId: "order_1",
        status: "reconcile_required",
        rawStatus: "order_final_cas_conflict",
        externalId: "ext_1",
        trackingId: "track_1",
        metadata: JSON.stringify({
          reconciliation: { required: true, providerStatus: "pending" },
          provider: "steadfast",
        }),
      },
      updateResults: [[{ id: "order_1" }]],
    });

    const { reconcileOrderShipment } = await import("./orders.fulfillment");
    const result = await reconcileOrderShipment(db as never, "order_1", "shp_claim");

    expect(result).toMatchObject({
      status: "repaired",
      orderId: "order_1",
      shipmentId: "shp_claim",
      orderStatus: OrderStatus.SHIPPED,
      shipmentStatus: "pending",
      orderStatusChanged: true,
      inventoryReconciled: true,
      claimCleared: true,
      trackingId: "track_1",
    });
    expect(mocks.createShipment).not.toHaveBeenCalled();
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "order_1", OrderStatus.SHIPPED);
    expect(updates).toEqual([
      expect.objectContaining({ status: OrderStatus.SHIPPED, fulfillmentStatus: "complete" }),
      expect.objectContaining({ inventoryAction: "deducted" }),
      expect.objectContaining({ status: "pending", rawStatus: "pending" }),
      expect.objectContaining({ shipmentClaimId: null, shipmentClaimExpiresAt: null }),
    ]);
  });

  it("clears the shipment claim when provider shipment creation is rejected", async () => {
    mocks.createShipment.mockResolvedValue({ success: false, shipmentId: "shp_claim", message: "provider rejected" });
    const { db, updates } = createDbMock({
      selectedOrder: { status: OrderStatus.CONFIRMED, version: 7 },
      updateResults: [[{ id: "order_1" }]],
    });

    const result = await bulkShipOrders(db as never, ["order_1"], "provider_1", {});

    expect(result).toEqual([
      {
        orderId: "order_1",
        success: false,
        shipment: undefined,
        error: "provider rejected",
        availabilityTransitionVariantIds: [],
      },
    ]);
    expect(updates.at(-1)).toMatchObject({
      shipmentClaimId: null,
      shipmentClaimExpiresAt: null,
    });
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("reconciles inventory instead of calling the provider when bulk ship is retried after status was already shipped", async () => {
    const { db, updates } = createDbMock({
      selectedOrder: { status: OrderStatus.SHIPPED, version: 9, shipmentClaimId: "shp_claim" },
      updateResults: [],
    });

    const result = await bulkShipOrders(db as never, ["order_1"], "provider_1", {});

    expect(result).toEqual([
      {
        orderId: "order_1",
        success: true,
        message: "Order already shipped; inventory reconciled",
        availabilityTransitionVariantIds: [],
      },
    ]);
    expect(mocks.createShipment).not.toHaveBeenCalled();
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "order_1", OrderStatus.SHIPPED);
    expect(updates[0]).toMatchObject({ inventoryAction: "deducted" });
    expect(updates[1]).toMatchObject({ shipmentClaimId: null, shipmentClaimExpiresAt: null });
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

  it("rejects COD collection before confirmation and after cancellation", async () => {
    for (const status of [OrderStatus.PENDING, OrderStatus.CANCELLED]) {
      const { db } = createDbMock({
        selectedOrder: {
          status,
          version: 3,
          totalAmount: 100,
          paidAmount: 0,
          balanceDue: 100,
        },
        updateResults: [],
      });

      await expect(
        processCodAction(db as never, "order_1", {
          action: "collected",
          collectedBy: "Courier A",
          collectedAmount: 100,
        }),
      ).rejects.toThrow(`order is ${status}`);
    }

    expect(mocks.recordCODCollection).not.toHaveBeenCalled();
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("rejects COD failure evidence after the order is cancelled", async () => {
    const { db } = createDbMock({
      selectedOrder: {
        status: OrderStatus.CANCELLED,
        version: 4,
        totalAmount: 100,
        paidAmount: 0,
        balanceDue: 100,
      },
      updateResults: [],
    });

    await expect(processCodAction(db as never, "order_1", {
      action: "failed",
      reason: "not_home",
    })).rejects.toThrow("order is cancelled");

    expect(mocks.recordCODFailure).not.toHaveBeenCalled();
  });

  it("does not record COD collection while a refund attempt is active", async () => {
    const { db } = createDbMock({
      selectedOrder: {
        status: OrderStatus.SHIPPED,
        version: 3,
        totalAmount: 100,
        paidAmount: 0,
        balanceDue: 100,
      },
      selectedRefundAttempt: { id: "rfa_1", orderId: "order_1", status: "processing" },
      updateResults: [],
    });

    await expect(
      processCodAction(db as never, "order_1", {
        action: "collected",
        collectedBy: "Courier A",
        collectedAmount: 100,
      }),
    ).rejects.toThrow("active refund operation");

    expect(mocks.recordCODCollection).not.toHaveBeenCalled();
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("does not record COD failure notes while a refund attempt is active", async () => {
    const { db } = createDbMock({
      selectedOrder: {
        status: OrderStatus.SHIPPED,
        version: 3,
        totalAmount: 100,
        paidAmount: 0,
        balanceDue: 100,
      },
      selectedRefundAttempt: { id: "rfa_1", orderId: "order_1", status: "processing" },
      updateResults: [],
    });

    await expect(processCodAction(db as never, "order_1", {
      action: "failed",
      reason: "not_home",
    })).rejects.toThrow("active refund operation");

    expect(mocks.recordCODFailure).not.toHaveBeenCalled();
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("records COD collection before reconciling delivered inventory", async () => {
    const { db, updates, batches } = createDbMock({
      selectedOrder: {
        status: OrderStatus.SHIPPED,
        version: 3,
        totalAmount: 100,
        paidAmount: 0,
        balanceDue: 100,
        inventoryAction: "reserved",
      },
      updateResults: [[{ id: "order_1" }]],
    });

    await processCodAction(db as never, "order_1", {
      action: "collected",
      collectedBy: "Courier A",
      collectedAmount: 100,
    });

    expect(updates[0]).toMatchObject({ status: OrderStatus.DELIVERED });
    expect(mocks.recordCODCollection).toHaveBeenCalled();
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "order_1", OrderStatus.DELIVERED);
    expect(mocks.recordCODCollection.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.applyInventoryForStatusChange.mock.invocationCallOrder[0]!,
    );
    expect(updates).toContainEqual(expect.objectContaining({ inventoryAction: "deducted" }));
    expect(updates).toContainEqual(expect.objectContaining({
      fulfillmentStatus: ItemFulfillmentStatus.DELIVERED,
    }));
    expect(updates).toContainEqual(expect.objectContaining({
      status: ShipmentStatus.DELIVERED,
      rawStatus: ShipmentStatus.DELIVERED,
    }));
    expect(batches).toHaveLength(1);
  });

  it("rolls back the delivered claim when COD collection recording fails", async () => {
    mocks.recordCODCollection.mockResolvedValueOnce({ success: false, error: "ledger write failed" });
    const { db, updates } = createDbMock({
      selectedOrder: {
        status: OrderStatus.SHIPPED,
        version: 3,
        totalAmount: 100,
        paidAmount: 0,
        balanceDue: 100,
        inventoryAction: "reserved",
      },
      updateResults: [[{ id: "order_1" }]],
    });

    await expect(
      processCodAction(db as never, "order_1", {
        action: "collected",
        collectedBy: "Courier A",
        collectedAmount: 100,
      }),
    ).rejects.toThrow("ledger write failed");

    expect(updates[0]).toMatchObject({ status: OrderStatus.DELIVERED, version: 4 });
    expect(updates[1]).toMatchObject({ status: OrderStatus.SHIPPED });
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("rolls the full confirmed-to-delivered COD path back to confirmed when collection recording fails", async () => {
    mocks.recordCODCollection.mockResolvedValueOnce({ success: false, error: "ledger write failed" });
    const { db, updates } = createDbMock({
      selectedOrder: {
        status: OrderStatus.CONFIRMED,
        version: 3,
        totalAmount: 100,
        paidAmount: 0,
        balanceDue: 100,
        inventoryAction: "reserved",
      },
      updateResults: [[{ id: "order_1" }], [{ id: "order_1" }]],
    });

    await expect(
      processCodAction(db as never, "order_1", {
        action: "collected",
        collectedBy: "Courier A",
        collectedAmount: 100,
      }),
    ).rejects.toThrow("ledger write failed");

    expect(updates[0]).toMatchObject({ status: OrderStatus.SHIPPED, version: 4 });
    expect(updates[1]).toMatchObject({ status: OrderStatus.DELIVERED, version: 5 });
    expect(updates[2]).toMatchObject({ status: OrderStatus.CONFIRMED });
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("rolls back the delivered claim when COD inventory reconciliation fails after collection", async () => {
    mocks.applyInventoryForStatusChange.mockRejectedValueOnce(new Error("inventory transition failed"));
    const { db, updates } = createDbMock({
      selectedOrder: {
        status: OrderStatus.SHIPPED,
        version: 3,
        totalAmount: 100,
        paidAmount: 0,
        balanceDue: 100,
        inventoryAction: "reserved",
      },
      updateResults: [[{ id: "order_1" }]],
    });

    await expect(
      processCodAction(db as never, "order_1", {
        action: "collected",
        collectedBy: "Courier A",
        collectedAmount: 100,
      }),
    ).rejects.toThrow("inventory transition failed");

    expect(mocks.recordCODCollection).toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: OrderStatus.DELIVERED, version: 4 });
    expect(updates[1]).toMatchObject({ status: OrderStatus.SHIPPED });
  });

  it("rolls confirmed COD retry back to confirmed when delivered inventory reconciliation fails after existing collection evidence", async () => {
    mocks.applyInventoryForStatusChange.mockRejectedValueOnce(new Error("inventory transition failed"));
    const { db, updates } = createDbMock({
      selectedOrder: {
        status: OrderStatus.CONFIRMED,
        version: 3,
        totalAmount: 100,
        paidAmount: 100,
        balanceDue: 0,
        inventoryAction: "reserved",
      },
      selectedPayment: {
        id: "pay_1",
        amount: 100,
        paymentMethod: PaymentMethod.COD,
        status: PaymentRecordStatus.SUCCEEDED,
      },
      selectedCodTracking: {
        id: "cod_1",
        codStatus: CodStatus.COLLECTED,
      },
      updateResults: [[{ id: "order_1" }], [{ id: "order_1" }]],
    });

    await expect(
      processCodAction(db as never, "order_1", {
        action: "collected",
        collectedBy: "Courier A",
        collectedAmount: 100,
      }),
    ).rejects.toThrow("inventory transition failed");

    expect(mocks.validateCODCollectionDetails).not.toHaveBeenCalled();
    expect(mocks.recordCODCollection).not.toHaveBeenCalled();
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "order_1", OrderStatus.DELIVERED);
    expect(updates[0]).toMatchObject({ status: OrderStatus.SHIPPED, version: 4 });
    expect(updates[1]).toMatchObject({ status: OrderStatus.DELIVERED, version: 5 });
    expect(updates[2]).toMatchObject({ status: OrderStatus.CONFIRMED });
  });

  it("retries COD delivered inventory reconciliation when collection evidence already exists", async () => {
    const { db, updates } = createDbMock({
      selectedOrder: {
        status: OrderStatus.SHIPPED,
        version: 3,
        totalAmount: 100,
        paidAmount: 100,
        balanceDue: 0,
        inventoryAction: "reserved",
      },
      selectedPayment: {
        id: "pay_1",
        amount: 100,
        paymentMethod: PaymentMethod.COD,
        status: PaymentRecordStatus.SUCCEEDED,
      },
      selectedCodTracking: {
        id: "cod_1",
        codStatus: CodStatus.COLLECTED,
      },
      updateResults: [[{ id: "order_1" }]],
    });

    await processCodAction(db as never, "order_1", {
      action: "collected",
      collectedBy: "Courier A",
      collectedAmount: 100,
    });

    expect(mocks.validateCODCollectionDetails).not.toHaveBeenCalled();
    expect(mocks.recordCODCollection).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: OrderStatus.DELIVERED });
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "order_1", OrderStatus.DELIVERED);
  });

  it("compares a duplicate KWD COD collection at the order's immutable precision", async () => {
    const { db } = createDbMock({
      selectedOrder: {
        status: OrderStatus.DELIVERED,
        version: 4,
        totalAmount: 1.235,
        paidAmount: 1.235,
        balanceDue: 0,
        inventoryAction: "deducted",
        currencyCode: "KWD",
        currencyDecimalPlaces: 3,
      },
      selectedPayment: {
        id: "pay_kwd",
        amount: 1.235,
        currency: "KWD",
        paymentMethod: PaymentMethod.COD,
        status: PaymentRecordStatus.SUCCEEDED,
      },
      selectedCodTracking: { id: "cod_kwd", codStatus: CodStatus.COLLECTED },
      updateResults: [],
    });

    await expect(processCodAction(db as never, "order_1", {
      action: "collected",
      collectedBy: "Courier A",
      collectedAmount: 1.2346,
    })).resolves.toEqual({
      message: "COD collection recorded",
      availabilityTransitionVariantIds: [],
    });

    expect(mocks.validateCODCollectionDetails).not.toHaveBeenCalled();
    expect(mocks.recordCODCollection).not.toHaveBeenCalled();
  });

  it("retries COD collection inventory reconciliation when the order is already delivered", async () => {
    const { db, updates, batches } = createDbMock({
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

    expect(updates).toHaveLength(3);
    expect(updates).toContainEqual(expect.objectContaining({ inventoryAction: "deducted" }));
    expect(updates).toContainEqual(expect.objectContaining({
      fulfillmentStatus: ItemFulfillmentStatus.DELIVERED,
    }));
    expect(updates).toContainEqual(expect.objectContaining({
      status: ShipmentStatus.DELIVERED,
      rawStatus: ShipmentStatus.DELIVERED,
    }));
    expect(batches).toHaveLength(1);
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "order_1", OrderStatus.DELIVERED);
    expect(mocks.recordCODCollection).toHaveBeenCalled();
  });

  it("records COD return-to-sender as an approved non-restocking item return", async () => {
    const { db, updates } = createDbMock({
      selectedOrder: {
        status: OrderStatus.SHIPPED,
        version: 4,
        totalAmount: 100,
        paidAmount: 0,
        balanceDue: 100,
        inventoryAction: "deducted",
      },
      selectedRows: [{ id: "item_1", quantity: 1 }],
      updateResults: [],
    });

    const result = await processCodAction(db as never, "order_1", { action: "returned" });

    expect(result).toMatchObject({ returnId: "ret_1" });
    expect(mocks.createOrderReturn).toHaveBeenCalledWith(
      db,
      "order_1",
      expect.objectContaining({
        expectedOrderVersion: 4,
        lines: [{ orderItemId: "item_1", quantity: 1, reason: "return_to_sender" }],
      }),
      { type: "system", id: "cod" },
      { source: "cod_return_to_sender", sourceReferenceId: "cod-rts:order_1" },
    );
    expect(mocks.approveOrderReturn).toHaveBeenCalled();
    expect(mocks.markCODReturned).toHaveBeenCalledWith(db, "order_1");
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
    expect(updates).not.toContainEqual(expect.objectContaining({ status: OrderStatus.RETURNED }));
  });

  it("does not apply inventory or write shipment rows when manual fulfillment claim fails", async () => {
    const { db, batches } = createDbMock({
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
    expect(batches).toHaveLength(0);
  });

  it("does not create manual fulfillment while a refund attempt is active", async () => {
    const { db, batches } = createDbMock({
      selectedOrder: {
        id: "order_1",
        status: OrderStatus.CONFIRMED,
        fulfillmentStatus: "pending",
        version: 5,
      },
      selectedRefundAttempt: { id: "rfa_1", orderId: "order_1", status: "reconcile_required" },
      selectedRows: [
        { id: "item_1", fulfillmentStatus: "pending" },
      ],
      updateResults: [[{ id: "order_1" }]],
    });

    await expect(
      createFulfillmentShipment(db as never, "order_1", {
        itemIds: ["item_1"],
        isFinalShipment: true,
      }),
    ).rejects.toThrow("active refund operation");

    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
    expect(batches).toHaveLength(0);
  });

  it("rejects manual fulfillment item IDs that do not belong to the order before claiming", async () => {
    const { db, updates, batches } = createDbMock({
      selectedOrder: {
        id: "order_1",
        status: OrderStatus.CONFIRMED,
        fulfillmentStatus: "pending",
        version: 5,
      },
      selectedRows: [
        { id: "item_1", fulfillmentStatus: "pending" },
      ],
      updateResults: [[{ id: "order_1" }]],
    });

    await expect(
      createFulfillmentShipment(db as never, "order_1", {
        itemIds: ["foreign_item"],
        isFinalShipment: true,
      }),
    ).rejects.toThrow("do not belong to this order");

    expect(updates).toHaveLength(0);
    expect(batches).toHaveLength(0);
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("rejects duplicate manual fulfillment item IDs before claiming", async () => {
    const { db, updates, batches } = createDbMock({
      selectedOrder: {
        id: "order_1",
        status: OrderStatus.CONFIRMED,
        fulfillmentStatus: "pending",
        version: 5,
      },
      selectedRows: [
        { id: "item_1", fulfillmentStatus: "pending" },
      ],
      updateResults: [[{ id: "order_1" }]],
    });

    await expect(
      createFulfillmentShipment(db as never, "order_1", {
        itemIds: ["item_1", "item_1"],
        isFinalShipment: true,
      }),
    ).rejects.toThrow("must be unique");

    expect(updates).toHaveLength(0);
    expect(batches).toHaveLength(0);
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("rejects manual fulfillment without items before claiming", async () => {
    const { db, updates, batches } = createDbMock({
      selectedOrder: {
        id: "order_1",
        status: OrderStatus.CONFIRMED,
        fulfillmentStatus: "pending",
        version: 5,
      },
      selectedRows: [],
      updateResults: [[{ id: "order_1" }]],
    });

    await expect(
      createFulfillmentShipment(db as never, "order_1", {
        isFinalShipment: true,
      }),
    ).rejects.toThrow("At least one order item");

    expect(updates).toHaveLength(0);
    expect(batches).toHaveLength(0);
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("keeps manual fulfillment status out of the visible order row until the shipment batch", async () => {
    const { db, updates, batches } = createDbMock({
      selectedOrder: {
        id: "order_1",
        status: OrderStatus.CONFIRMED,
        fulfillmentStatus: "pending",
        version: 5,
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

    expect(result.statusChange).toEqual({
      orderId: "order_1",
      previousStatus: OrderStatus.CONFIRMED,
      newStatus: OrderStatus.SHIPPED,
      version: 7,
    });
    expect(updates[0]).toMatchObject({
      shipmentClaimId: expect.stringMatching(/^shp_/),
      version: 6,
    });
    expect(updates[0]).not.toHaveProperty("status");
    expect(updates[0]).not.toHaveProperty("fulfillmentStatus");
    expect(batches).toHaveLength(1);
    expect(batches[0]?.[0]).toMatchObject({
      status: ShipmentStatus.IN_TRANSIT,
      rawStatus: ShipmentStatus.IN_TRANSIT,
      isFinalShipment: true,
    });
    expect(updates.some((entry) =>
      entry.status === OrderStatus.SHIPPED && entry.fulfillmentStatus === "complete"
    )).toBe(true);
  });

  it("clears the private manual fulfillment claim when the shipment batch fails before insert", async () => {
    const { db, updates, batches } = createDbMock({
      selectedOrder: {
        id: "order_1",
        status: OrderStatus.CONFIRMED,
        fulfillmentStatus: "pending",
        version: 5,
      },
      selectedRows: [
        { id: "item_1", fulfillmentStatus: "pending" },
      ],
      selectedShipment: null,
      updateResults: [[{ id: "order_1" }]],
      batchError: new Error("shipment batch failed"),
    });

    await expect(
      createFulfillmentShipment(db as never, "order_1", {
        itemIds: ["item_1"],
        isFinalShipment: true,
      }),
    ).rejects.toThrow("shipment batch failed");

    expect(batches).toHaveLength(1);
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({
      shipmentClaimId: expect.stringMatching(/^shp_/),
    });
    expect(updates.filter((entry) => entry.shipmentClaimId === null)).toHaveLength(2);
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
    expect(result.statusChange).toBeUndefined();
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

    expect(result).toEqual({
      message: "Status unchanged; inventory reconciled",
      availabilityTransitionVariantIds: [],
    });
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "order_1", OrderStatus.SHIPPED);
    expect(updates[0]).toMatchObject({ inventoryAction: "deducted" });
  });

  it("rejects generic COD delivery status updates before COD collection is recorded", async () => {
    const { db, updates } = createDbMock({
      selectedOrder: {
        status: OrderStatus.SHIPPED,
        inventoryAction: "reserved",
        version: 8,
        customerName: "Customer",
        customerEmail: "customer@example.com",
        paymentMethod: PaymentMethod.COD,
        paymentStatus: PaymentStatus.UNPAID,
      },
      selectedPayment: null,
      updateResults: [[{ id: "order_1" }]],
    });

    await expect(updateOrderStatus(db as never, "order_1", OrderStatus.DELIVERED))
      .rejects.toThrow("Record COD collection");

    expect(updates).toHaveLength(0);
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("rejects generic COD completion when paid status has no successful COD ledger", async () => {
    const { db, updates } = createDbMock({
      selectedOrder: {
        status: OrderStatus.DELIVERED,
        inventoryAction: "deducted",
        version: 8,
        customerName: "Customer",
        customerEmail: "customer@example.com",
        paymentMethod: PaymentMethod.COD,
        paymentStatus: PaymentStatus.PAID,
        paidAmount: 100,
        balanceDue: 0,
      },
      selectedPayment: null,
      updateResults: [[{ id: "order_1" }]],
    });

    await expect(updateOrderStatus(db as never, "order_1", OrderStatus.COMPLETED))
      .rejects.toThrow("Record COD collection");

    expect(updates).toHaveLength(0);
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("rejects generic COD delivery when the payment ledger lacks collected tracking", async () => {
    const { db, updates } = createDbMock({
      selectedOrder: {
        status: OrderStatus.SHIPPED,
        inventoryAction: "reserved",
        version: 8,
        customerName: "Customer",
        customerEmail: "customer@example.com",
        paymentMethod: PaymentMethod.COD,
        paymentStatus: PaymentStatus.PAID,
        paidAmount: 100,
        balanceDue: 0,
      },
      selectedPayment: {
        id: "pay_1",
        amount: 100,
        paymentMethod: PaymentMethod.COD,
        status: PaymentRecordStatus.SUCCEEDED,
      },
      selectedCodTracking: null,
      updateResults: [[{ id: "order_1" }]],
    });

    await expect(updateOrderStatus(db as never, "order_1", OrderStatus.DELIVERED))
      .rejects.toThrow("Record COD collection");

    expect(updates).toHaveLength(0);
    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("allows generic COD delivery after a successful COD collection ledger exists", async () => {
    const { db, updates } = createDbMock({
      selectedOrder: {
        status: OrderStatus.SHIPPED,
        inventoryAction: "reserved",
        version: 8,
        customerName: "Customer",
        customerEmail: "customer@example.com",
        paymentMethod: PaymentMethod.COD,
        paymentStatus: PaymentStatus.PAID,
        paidAmount: 100,
        balanceDue: 0,
      },
      selectedPayment: {
        id: "pay_1",
        amount: 100,
        paymentMethod: PaymentMethod.COD,
        status: PaymentRecordStatus.SUCCEEDED,
      },
      selectedCodTracking: {
        id: "cod_1",
        codStatus: CodStatus.COLLECTED,
      },
      updateResults: [[{ id: "order_1" }]],
    });

    const result = await updateOrderStatus(db as never, "order_1", OrderStatus.DELIVERED);

    expect(result).toMatchObject({ message: "Order status updated successfully" });
    expect(updates[0]).toMatchObject({ status: OrderStatus.DELIVERED });
    expect(updates[0]).not.toHaveProperty("paymentStatus");
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "order_1", OrderStatus.DELIVERED);
  });

  it("allows non-COD delivery status updates without COD collection evidence", async () => {
    const { db, updates } = createDbMock({
      selectedOrder: {
        status: OrderStatus.SHIPPED,
        inventoryAction: "reserved",
        version: 8,
        customerName: "Customer",
        customerEmail: "customer@example.com",
        paymentMethod: PaymentMethod.STRIPE,
        paymentStatus: PaymentStatus.PAID,
      },
      selectedPayment: null,
      selectedCodTracking: null,
      updateResults: [[{ id: "order_1" }]],
    });

    const result = await updateOrderStatus(db as never, "order_1", OrderStatus.DELIVERED);

    expect(result).toMatchObject({ message: "Order status updated successfully" });
    expect(updates[0]).toMatchObject({ status: OrderStatus.DELIVERED });
    expect(updates[0]).not.toHaveProperty("paymentStatus");
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "order_1", OrderStatus.DELIVERED);
  });

  it("canonicalizes direct admin status updates before persistence and notifications", async () => {
    const { db, updates } = createDbMock({
      selectedOrder: {
        status: OrderStatus.CONFIRMED,
        inventoryAction: "reserved",
        version: 8,
        customerName: "Customer",
        customerEmail: "customer@example.com",
        paymentMethod: PaymentMethod.STRIPE,
        paymentStatus: PaymentStatus.PAID,
      },
      updateResults: [[{ id: "order_1" }]],
    });

    const result = await updateOrderStatus(db as never, "order_1", " SHIPPED ", { trackingId: "TRK-1" });

    expect(result.notification).toMatchObject({
      notificationType: "order_shipped",
      previousStatus: OrderStatus.CONFIRMED,
      newStatus: OrderStatus.SHIPPED,
      trackingId: "TRK-1",
    });
    expect(updates[0]).toMatchObject({ status: OrderStatus.SHIPPED, version: 9 });
    expect(mocks.applyInventoryForStatusChange).toHaveBeenCalledWith(db, "order_1", OrderStatus.SHIPPED);
  });

  it("rejects unknown direct admin status updates before database work", async () => {
    await expect(updateOrderStatus({} as never, "order_1", "DELIVERED_NOW"))
      .rejects.toThrow("Unknown order status.");

    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("rolls back the visible admin status when inventory reconciliation fails before inventoryAction changes", async () => {
    const inventoryError = new Error("inventory transition failed");
    mocks.applyInventoryForStatusChange.mockRejectedValueOnce(inventoryError);
    const { db, updates } = createDbMock({
      selectedOrder: {
        status: OrderStatus.CONFIRMED,
        inventoryAction: "reserved",
        version: 8,
        customerName: "Customer",
        customerEmail: "customer@example.com",
        paymentMethod: PaymentMethod.STRIPE,
        paymentStatus: PaymentStatus.PAID,
      },
      updateResults: [[{ id: "order_1" }]],
    });

    await expect(updateOrderStatus(db as never, "order_1", OrderStatus.SHIPPED))
      .rejects.toThrow("inventory transition failed");

    expect(updates[0]).toMatchObject({ status: OrderStatus.SHIPPED, version: 9 });
    expect(updates[1]).toMatchObject({ status: OrderStatus.CONFIRMED });
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

  it("rejects admin status updates while a refund attempt is active", async () => {
    const { db } = createDbMock({
      selectedOrder: {
        status: OrderStatus.CONFIRMED,
        inventoryAction: "reserved",
        version: 8,
        customerName: "Customer",
        customerEmail: "customer@example.com",
        paymentMethod: "cod",
        paymentStatus: "unpaid",
      },
      selectedRefundAttempt: { id: "rfa_1", orderId: "order_1", status: "provider_unknown" },
      updateResults: [],
    });

    await expect(updateOrderStatus(db as never, "order_1", OrderStatus.SHIPPED))
      .rejects.toThrow("active refund operation");

    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });

  it("rejects admin status updates while hosted payment setup is active", async () => {
    const { db } = createDbMock({
      selectedOrder: {
        status: OrderStatus.CONFIRMED,
        inventoryAction: "reserved",
        version: 8,
        customerName: "Customer",
        customerEmail: "customer@example.com",
        paymentMethod: PaymentMethod.STRIPE,
        paymentStatus: PaymentStatus.UNPAID,
      },
      selectedPaymentSessionAttemptRows: [{ orderId: "order_1" }],
      updateResults: [],
    });

    await expect(updateOrderStatus(db as never, "order_1", OrderStatus.SHIPPED))
      .rejects.toThrow("active hosted payment setup");

    expect(mocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
  });
});
