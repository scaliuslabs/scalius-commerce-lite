// tests/unit/core/orders/update-order-atomicity.test.ts
// Focused regression coverage for updateOrder() inventory pre-write atomicity.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedOrder, seedOrderItem } from "../../../setup";

const inventoryMocks = vi.hoisted(() => ({
  reserveStockBatch: vi.fn(),
  releaseReservedStockBatch: vi.fn(),
  validateStockBatchAvailability: vi.fn(),
  applyClaimedInventoryEntryBatch: vi.fn(),
  applyInventoryForStatusChange: vi.fn(),
}));

vi.mock("../../../../packages/core/src/modules/inventory", () => ({
  reserveStockBatch: inventoryMocks.reserveStockBatch,
  releaseReservedStockBatch: inventoryMocks.releaseReservedStockBatch,
  validateStockBatchAvailability: inventoryMocks.validateStockBatchAvailability,
}));

vi.mock("../../../../packages/core/src/modules/inventory/inventory-transitions", () => ({
  applyInventoryForStatusChange: inventoryMocks.applyInventoryForStatusChange,
  applyClaimedInventoryEntryBatch: inventoryMocks.applyClaimedInventoryEntryBatch,
  isStockRestoreStatus: (status: string) => ["cancelled", "returned", "refunded"].includes(status),
  isStockDeductStatus: (status: string) => ["shipped", "delivered"].includes(status),
  isStockReservableStatus: (status: string) => ["incomplete", "pending", "processing", "confirmed"].includes(status),
}));

type UpdateOrder = typeof import("../../../../packages/core/src/modules/orders/orders.admin").updateOrder;
type RestoreOrder = typeof import("../../../../packages/core/src/modules/orders/orders.admin").restoreOrder;

type MockChain = {
  __kind?: string;
  from: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  leftJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
  then: (resolve: (value: unknown) => void, reject?: (reason: unknown) => void) => Promise<void>;
};

const ORDER_ID = "ord_atomicity";
const EXISTING_VARIANT_ID = "var_existing";
const NEW_VARIANT_ID = "var_new";

const successResult = { success: true, results: [] };
const validationFailure = {
  success: false,
  results: [
    {
      success: false,
      variantId: EXISTING_VARIANT_ID,
      previousStock: 5,
      newStock: 5,
      error: "Insufficient stock for variant var_existing. Available: 1, Requested: 2",
    },
  ],
  error: "Insufficient stock for variant var_existing. Available: 1, Requested: 2",
};
const releaseFailure = {
  success: false,
  results: [
    {
      success: false,
      variantId: EXISTING_VARIANT_ID,
      previousStock: 5,
      newStock: 5,
      error: "release failed",
    },
  ],
  error: "release failed",
};
function activeLocationRows() {
  return [
    {
      id: "dhaka",
      name: "Dhaka",
      type: "city",
      parentId: null,
      isActive: true,
      deletedAt: null,
    },
    {
      id: "zone1",
      name: "Mirpur",
      type: "zone",
      parentId: "dhaka",
      isActive: true,
      deletedAt: null,
    },
    {
      id: "area1",
      name: "Section 10",
      type: "area",
      parentId: "zone1",
      isActive: true,
      deletedAt: null,
    },
  ];
}

let updateOrder: UpdateOrder;
let restoreOrder: RestoreOrder;
let events: string[];

beforeEach(async () => {
  vi.resetAllMocks();
  events = [];

  inventoryMocks.validateStockBatchAvailability.mockImplementation(async () => {
    events.push("validate");
    return successResult;
  });
  inventoryMocks.reserveStockBatch.mockImplementation(async () => {
    events.push("reserve");
    return successResult;
  });
  inventoryMocks.applyClaimedInventoryEntryBatch.mockImplementation(async (_db, input) => {
    events.push(input.operation === "deduct" ? "deduct" : "restore-deducted");
  });
  inventoryMocks.releaseReservedStockBatch.mockImplementation(async () => {
    events.push("release");
    return successResult;
  });
  inventoryMocks.applyInventoryForStatusChange.mockResolvedValue("reserved");

  ({ updateOrder, restoreOrder } = await import("../../../../packages/core/src/modules/orders/orders.admin"));
});

function createChain(result: unknown): MockChain {
  const chain = {} as MockChain;
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.select = vi.fn((callback?: unknown) => {
    if (typeof callback === "function") {
      const qbSelect = vi.fn(() => chain);
      callback({ select: qbSelect });
    }
    return chain;
  });
  chain.set = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => result);
  chain.get = vi.fn(async () => result ?? null);
  chain.all = vi.fn(async () => Array.isArray(result) ? result : result ? [result] : []);
  chain.then = (resolve, reject) => {
    const value = Array.isArray(result) ? result : result ? [result] : [];
    return Promise.resolve(value).then(resolve, reject);
  };
  return chain;
}

function createUpdateOrderDb(options: {
  existingOrder: ReturnType<typeof seedOrder>;
  existingItems: ReturnType<typeof seedOrderItem>[];
  activeRefundAttempt?: Record<string, unknown> | null;
  legacyPendingRefund?: Record<string, unknown> | null;
  activePaymentSessionAttemptRows?: Array<Record<string, unknown>>;
  orderUpdateResult?: unknown[];
  itemReplacementError?: Error;
  locationRows?: ReturnType<typeof activeLocationRows>;
}) {
  let selectIndex = 0;
  const liveSkuRows = [
    {
      id: EXISTING_VARIANT_ID,
      productId: `prod_${EXISTING_VARIANT_ID}`,
      trackInventory: true,
      variantDeletedAt: null,
      productActive: true,
      productDeletedAt: null,
    },
    {
      id: NEW_VARIANT_ID,
      productId: `prod_${NEW_VARIANT_ID}`,
      trackInventory: true,
      variantDeletedAt: null,
      productActive: true,
      productDeletedAt: null,
    },
  ];
  const selectResults = [
    options.existingOrder,
    {
      status: options.existingOrder.status,
      paymentStatus: options.existingOrder.paymentStatus,
      paidAmount: options.existingOrder.paidAmount,
      fulfillmentStatus: options.existingOrder.fulfillmentStatus,
      shipmentClaimId: options.existingOrder.shipmentClaimId ?? null,
      shipmentClaimExpiresAt:
        options.existingOrder.shipmentClaimExpiresAt ?? null,
      hasTaxSnapshot: 0,
      hasPaymentHistory: 0,
      hasShipmentHistory: 0,
      hasRefundHistory: 0,
      hasReturnHistory: 0,
      hasInvoiceHistory: 0,
    },
    options.locationRows ?? activeLocationRows(),
    options.activeRefundAttempt ?? null,
    options.legacyPendingRefund ?? null,
    options.activePaymentSessionAttemptRows ?? [],
    null, // no item-level return history
    null, // no issued invoice
    options.existingItems,
    liveSkuRows,
    [], // no product media for order-item snapshots
  ];

  return {
    select: vi.fn(() => createChain(selectResults[selectIndex++])),
    update: vi.fn(() => {
      events.push("order-cas-update");
      const chain = createChain(options.orderUpdateResult ?? [{ id: ORDER_ID }]);
      chain.__kind = "order-update";
      chain.returning = vi.fn(() => chain);
      return chain;
    }),
    insert: vi.fn(() => createChain([{ id: "inserted" }])),
    delete: vi.fn(() => createChain(undefined)),
    batch: vi.fn(async (statements: unknown[]) => {
      events.push("atomic-order-edit-batch");
      if (options.itemReplacementError) {
        throw options.itemReplacementError;
      }
      return statements.map((statement) =>
        (statement as MockChain).__kind === "order-update"
          ? options.orderUpdateResult ?? [{ id: ORDER_ID }]
          : [],
      );
    }),
  };
}

function createRestoreOrderDb(options: {
  order: {
    id: string;
    archivedAt: number | Date | null;
    deletedAt: number | Date | null;
    version: number;
  };
  orderUpdateResult?: unknown[];
}) {
  const updateSets: unknown[] = [];

  const db = {
    select: vi.fn(() => createChain(options.order)),
    update: vi.fn(() => {
      const chain = createChain(options.orderUpdateResult ?? [{ id: ORDER_ID }]);
      chain.set = vi.fn((value) => {
        updateSets.push(value);
        return chain;
      });
      return chain;
    }),
  };

  return { db, updateSets };
}

type SeedOrderWithVersion = ReturnType<typeof seedOrder> & { version: number };

function existingOrder(overrides: Partial<SeedOrderWithVersion> = {}): SeedOrderWithVersion {
  const { version = 1, ...seedOverrides } = overrides;
  return {
    ...seedOrder({
    id: ORDER_ID,
    customerId: "cust_atomicity",
    customerName: "Atomic Customer",
    customerPhone: "+8801700000000",
    status: "pending",
    inventoryAction: "reserved",
    inventoryPool: "regular",
      ...seedOverrides,
    }),
    version,
  };
}

function archivedOrder(overrides: Partial<{
  id: string;
  archivedAt: number | Date | null;
  deletedAt: number | Date | null;
  version: number;
}> = {}) {
  return {
    id: ORDER_ID,
    archivedAt: 1_800_000,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function item(quantity: number, variantId = EXISTING_VARIANT_ID) {
  return seedOrderItem({
    id: `item_${variantId}_${quantity}`,
    orderId: ORDER_ID,
    productId: `prod_${variantId}`,
    variantId,
    quantity,
    price: 100,
  });
}

function updateData(overrides: Partial<Parameters<UpdateOrder>[2]> = {}): Parameters<UpdateOrder>[2] {
  return {
    expectedVersion: 1,
    customerName: "Atomic Customer",
    customerPhone: "+8801700000000",
    customerEmail: null,
    shippingAddress: "123 Test Street",
    city: "dhaka",
    zone: "zone1",
    area: null,
    notes: null,
    items: [item(3)],
    shippingCharge: 60,
    discountAmount: 0,
    status: "pending",
    ...overrides,
  };
}

describe("updateOrder inventory atomicity", () => {
  it("rejects invalid delivery-location hierarchy before order, refund, or inventory reads", async () => {
    const db = createUpdateOrderDb({
      existingOrder: existingOrder({ inventoryAction: "reserved" }),
      existingItems: [item(1)],
      locationRows: [
        {
          id: "dhaka",
          name: "Dhaka",
          type: "city",
          parentId: null,
          isActive: true,
          deletedAt: null,
        },
        {
          id: "zone1",
          name: "Mirpur",
          type: "zone",
          parentId: "other_city",
          isActive: true,
          deletedAt: null,
        },
      ],
    });

    await expect(updateOrder(db as never, ORDER_ID, updateData()))
      .rejects.toMatchObject({
        name: "ValidationError",
        code: "VALIDATION_ERROR",
        message: "Selected zone is no longer available for the chosen city.",
      });

    expect(inventoryMocks.validateStockBatchAvailability).not.toHaveBeenCalled();
    expect(inventoryMocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(inventoryMocks.applyClaimedInventoryEntryBatch).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("rejects active shipment claims before inventory pre-writes", async () => {
    const db = createUpdateOrderDb({
      existingOrder: {
        ...existingOrder({ inventoryAction: "reserved" }),
        shipmentClaimId: "shp_active",
        shipmentClaimExpiresAt: new Date(Date.now() + 60_000),
      } as ReturnType<typeof seedOrder>,
      existingItems: [item(1)],
    });

    await expect(updateOrder(db as never, ORDER_ID, updateData())).rejects.toMatchObject({
      name: "ConflictError",
      code: "CONFLICT",
      message: "Fulfillment or shipment evidence already exists. Use the shipment, return, or replacement-order workflows instead.",
    });

    expect(inventoryMocks.validateStockBatchAvailability).not.toHaveBeenCalled();
    expect(inventoryMocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(inventoryMocks.applyClaimedInventoryEntryBatch).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("rejects active refund attempts before inventory pre-writes", async () => {
    const db = createUpdateOrderDb({
      existingOrder: existingOrder({ inventoryAction: "reserved" }),
      existingItems: [item(1)],
      activeRefundAttempt: { id: "rfa_active", orderId: ORDER_ID, status: "provider_unknown" },
    });

    await expect(updateOrder(db as never, ORDER_ID, updateData())).rejects.toMatchObject({
      name: "ConflictError",
      code: "CONFLICT",
      message: "Order has an active refund operation. Complete or reconcile the refund before changing this order.",
    });

    expect(inventoryMocks.validateStockBatchAvailability).not.toHaveBeenCalled();
    expect(inventoryMocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(inventoryMocks.applyClaimedInventoryEntryBatch).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("fails reserved quantity increases before order/customer/item writes when stock validation fails", async () => {
    const db = createUpdateOrderDb({
      existingOrder: existingOrder({ inventoryAction: "reserved" }),
      existingItems: [item(1)],
    });
    inventoryMocks.validateStockBatchAvailability.mockImplementation(async () => {
      events.push("validate");
      return validationFailure;
    });

    await expect(updateOrder(db as never, ORDER_ID, updateData())).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      message: validationFailure.error,
    });

    expect(inventoryMocks.validateStockBatchAvailability).toHaveBeenCalledWith(
      db,
      [{ variantId: EXISTING_VARIANT_ID, quantity: 2, orderId: ORDER_ID }],
      "regular",
    );
    expect(inventoryMocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(events).toEqual(["validate"]);
  });

  it("compensates an acquired extra reservation when the reserved order CAS update fails", async () => {
    const db = createUpdateOrderDb({
      existingOrder: existingOrder({ inventoryAction: "reserved", version: 7 }),
      existingItems: [item(1)],
      orderUpdateResult: [],
    });

    await expect(updateOrder(db as never, ORDER_ID, updateData({ expectedVersion: 7 }))).rejects.toMatchObject({
      name: "ConflictError",
      code: "CONFLICT",
      message: "Order was modified by another request. Please reload and try again.",
    });

    const positiveEntries = [{ variantId: EXISTING_VARIANT_ID, quantity: 2, pool: "regular" }];
    expect(inventoryMocks.reserveStockBatch).toHaveBeenCalledWith(
      db,
      [{ variantId: EXISTING_VARIANT_ID, quantity: 2, orderId: ORDER_ID }],
      "regular",
      { reservationKey: "admin-order-edit:v1:ord_atomicity:v7:reserve-positive" },
    );
    expect(inventoryMocks.releaseReservedStockBatch).toHaveBeenCalledWith(
      db,
      positiveEntries,
      ORDER_ID,
      { releaseKey: "admin-order-edit:v1:ord_atomicity:v7:compensate-acquired" },
    );
    expect(inventoryMocks.applyClaimedInventoryEntryBatch).not.toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["validate", "reserve", "order-cas-update", "atomic-order-edit-batch", "release"]);
  });

  it.each([
    { status: "shipped", inventoryAction: "deducted", version: 3 },
    { status: "cancelled", inventoryAction: "restored", version: 4 },
  ])("blocks full-editor inventory rewrites after an order reaches $status", async ({ status, inventoryAction, version }) => {
    const db = createUpdateOrderDb({
      existingOrder: existingOrder({ status, inventoryAction, version }),
      existingItems: [item(1)],
    });

    await expect(
      updateOrder(
        db as never,
        ORDER_ID,
        updateData({ expectedVersion: version, status, items: [item(4)] }),
      ),
    ).rejects.toMatchObject({
      name: "ConflictError",
      code: "CONFLICT",
      message: "The full editor is available only before shipment, cancellation, completion, return, or refund. Use the dedicated order actions instead.",
    });

    expect(inventoryMocks.validateStockBatchAvailability).not.toHaveBeenCalled();
    expect(inventoryMocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(inventoryMocks.releaseReservedStockBatch).not.toHaveBeenCalled();
    expect(inventoryMocks.applyClaimedInventoryEntryBatch).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("fails reserved quantity decreases before item replacement when reservation release fails", async () => {
    const db = createUpdateOrderDb({
      existingOrder: existingOrder({ inventoryAction: "reserved" }),
      existingItems: [item(3)],
    });
    inventoryMocks.releaseReservedStockBatch.mockImplementation(async () => {
      events.push("release");
      return releaseFailure;
    });

    await expect(
      updateOrder(db as never, ORDER_ID, updateData({ items: [item(1)] })),
    ).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      message: releaseFailure.error,
    });

    expect(inventoryMocks.releaseReservedStockBatch).toHaveBeenCalledWith(
      db,
      [{ variantId: EXISTING_VARIANT_ID, quantity: 2, pool: "regular" }],
      ORDER_ID,
      { releaseKey: "admin-order-edit:v1:ord_atomicity:v1:release-negative" },
    );
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(events).toEqual(["release"]);
  });

  it("compensates released reserved deltas when the order CAS fails", async () => {
    const db = createUpdateOrderDb({
      existingOrder: existingOrder({ inventoryAction: "reserved", version: 11 }),
      existingItems: [item(3)],
      orderUpdateResult: [],
    });

    await expect(
      updateOrder(db as never, ORDER_ID, updateData({ expectedVersion: 11, items: [item(1)] })),
    ).rejects.toMatchObject({
      name: "ConflictError",
      code: "CONFLICT",
    });

    const releasedEntries = [{ variantId: EXISTING_VARIANT_ID, quantity: 2, pool: "regular" }];
    expect(inventoryMocks.releaseReservedStockBatch).toHaveBeenCalledWith(
      db,
      releasedEntries,
      ORDER_ID,
      { releaseKey: "admin-order-edit:v1:ord_atomicity:v11:release-negative" },
    );
    expect(inventoryMocks.reserveStockBatch).toHaveBeenCalledWith(
      db,
      [{ variantId: EXISTING_VARIANT_ID, quantity: 2, orderId: ORDER_ID }],
      "regular",
      { reservationKey: "admin-order-edit:v1:ord_atomicity:v11:compensate-released:reserve:regular" },
    );
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["release", "order-cas-update", "atomic-order-edit-batch", "reserve"]);
  });

  it("rejects lifecycle changes in the full editor before inventory writes", async () => {
    const db = createUpdateOrderDb({
      existingOrder: existingOrder({ inventoryAction: "reserved", version: 13 }),
      existingItems: [item(2)],
    });

    await expect(
      updateOrder(
        db as never,
        ORDER_ID,
        updateData({ expectedVersion: 13, status: "cancelled", items: [] }),
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      message: "Use the order status action for operational progress. The full editor only changes customer, item, shipping-charge, and discount details.",
    });

    expect(inventoryMocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(inventoryMocks.releaseReservedStockBatch).not.toHaveBeenCalled();
    expect(inventoryMocks.applyClaimedInventoryEntryBatch).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("compensates inventory if atomic item replacement fails after the order CAS", async () => {
    const db = createUpdateOrderDb({
      existingOrder: existingOrder({ inventoryAction: "reserved", version: 14 }),
      existingItems: [item(3)],
      itemReplacementError: new Error("item batch failed"),
    });

    await expect(
      updateOrder(db as never, ORDER_ID, updateData({ expectedVersion: 14, items: [item(1)] })),
    ).rejects.toThrow("item batch failed");

    const releasedEntries = [{ variantId: EXISTING_VARIANT_ID, quantity: 2, pool: "regular" }];
    expect(inventoryMocks.releaseReservedStockBatch).toHaveBeenCalledWith(
      db,
      releasedEntries,
      ORDER_ID,
      { releaseKey: "admin-order-edit:v1:ord_atomicity:v14:release-negative" },
    );
    expect(inventoryMocks.reserveStockBatch).toHaveBeenCalledWith(
      db,
      [{ variantId: EXISTING_VARIANT_ID, quantity: 2, orderId: ORDER_ID }],
      "regular",
      { reservationKey: "admin-order-edit:v1:ord_atomicity:v14:compensate-released:reserve:regular" },
    );
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["release", "order-cas-update", "atomic-order-edit-batch", "reserve"]);
  });

  it("does not use the full editor as a shipped-order inventory reconciliation command", async () => {
    const db = createUpdateOrderDb({
      existingOrder: existingOrder({
        status: "shipped",
        inventoryAction: "reserved",
        version: 8,
      }),
      existingItems: [item(2)],
    });

    await expect(
      updateOrder(
        db as never,
        ORDER_ID,
        updateData({ expectedVersion: 8, status: "shipped", items: [item(2)] }),
      ),
    ).rejects.toMatchObject({
      name: "ConflictError",
      code: "CONFLICT",
      message: "The full editor is available only before shipment, cancellation, completion, return, or refund. Use the dedicated order actions instead.",
    });

    expect(inventoryMocks.applyInventoryForStatusChange).not.toHaveBeenCalled();
    expect(inventoryMocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(inventoryMocks.releaseReservedStockBatch).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("restoreOrder archive safety", () => {
  it("restores only the archive marker without rewriting order or inventory facts", async () => {
    const { db, updateSets } = createRestoreOrderDb({
      order: archivedOrder(),
    });

    await expect(restoreOrder(db as never, ORDER_ID, 1)).resolves.toBeUndefined();

    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]).toMatchObject({ archivedAt: null });
    expect(inventoryMocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(inventoryMocks.releaseReservedStockBatch).not.toHaveBeenCalled();
    expect(inventoryMocks.applyClaimedInventoryEntryBatch).not.toHaveBeenCalled();
  });

  it("rejects legacy soft-deleted orders instead of guessing how to restore evidence", async () => {
    const { db } = createRestoreOrderDb({
      order: archivedOrder({ deletedAt: 1_700_000 }),
    });

    await expect(restoreOrder(db as never, ORDER_ID, 1)).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      message: "This legacy-deleted order cannot be restored from the archive.",
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("rejects a live order that is not archived", async () => {
    const { db } = createRestoreOrderDb({
      order: archivedOrder({ archivedAt: null }),
    });

    await expect(restoreOrder(db as never, ORDER_ID, 1)).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      message: "Order is not archived",
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("rejects a stale restore version before the archive marker changes", async () => {
    const { db } = createRestoreOrderDb({
      order: archivedOrder({ version: 4 }),
    });

    await expect(restoreOrder(db as never, ORDER_ID, 3)).rejects.toMatchObject({
      name: "ConflictError",
      code: "CONFLICT",
      message: "Order was modified by another request. Reload and try again.",
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("reports a CAS race without any inventory compensation side effects", async () => {
    const { db } = createRestoreOrderDb({
      order: archivedOrder({ version: 5 }),
      orderUpdateResult: [],
    });

    await expect(restoreOrder(db as never, ORDER_ID, 5)).rejects.toMatchObject({
      name: "ConflictError",
      code: "CONFLICT",
    });
    expect(inventoryMocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(inventoryMocks.releaseReservedStockBatch).not.toHaveBeenCalled();
  });
});
