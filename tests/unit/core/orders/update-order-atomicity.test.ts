// tests/unit/core/orders/update-order-atomicity.test.ts
// Focused regression coverage for updateOrder() inventory pre-write atomicity.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedOrder, seedOrderItem } from "../../../setup";

const inventoryMocks = vi.hoisted(() => ({
  reserveStockBatch: vi.fn(),
  validateStockBatchAvailability: vi.fn(),
  deductMultiple: vi.fn(),
  releaseMultiple: vi.fn(),
  restoreDeductedMultiple: vi.fn(),
  applyInventoryForStatusChange: vi.fn(),
}));

vi.mock("../../../../packages/core/src/modules/inventory", () => ({
  reserveStockBatch: inventoryMocks.reserveStockBatch,
  validateStockBatchAvailability: inventoryMocks.validateStockBatchAvailability,
  deductMultiple: inventoryMocks.deductMultiple,
  releaseMultiple: inventoryMocks.releaseMultiple,
  restoreDeductedMultiple: inventoryMocks.restoreDeductedMultiple,
}));

vi.mock("../../../../packages/core/src/modules/inventory/inventory-transitions", () => ({
  applyInventoryForStatusChange: inventoryMocks.applyInventoryForStatusChange,
  isStockRestoreStatus: (status: string) => ["cancelled", "returned", "refunded"].includes(status),
  isStockDeductStatus: (status: string) => ["shipped", "delivered"].includes(status),
  isStockReservableStatus: (status: string) => ["incomplete", "pending", "processing", "confirmed"].includes(status),
}));

type UpdateOrder = typeof import("../../../../packages/core/src/modules/orders/orders.admin").updateOrder;
type RestoreOrder = typeof import("../../../../packages/core/src/modules/orders/orders.admin").restoreOrder;

type MockChain = {
  from: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
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
const restoreFailure = {
  success: false,
  results: [
    {
      success: false,
      variantId: EXISTING_VARIANT_ID,
      previousStock: 5,
      newStock: 5,
      error: "restore failed",
    },
  ],
  error: "restore failed",
};

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
  inventoryMocks.deductMultiple.mockImplementation(async () => {
    events.push("deduct");
    return successResult;
  });
  inventoryMocks.releaseMultiple.mockImplementation(async () => {
    events.push("release");
    return successResult;
  });
  inventoryMocks.restoreDeductedMultiple.mockImplementation(async () => {
    events.push("restore-deducted");
    return successResult;
  });
  inventoryMocks.applyInventoryForStatusChange.mockResolvedValue("reserved");

  ({ updateOrder, restoreOrder } = await import("../../../../packages/core/src/modules/orders/orders.admin"));
});

function createChain(result: unknown): MockChain {
  const chain = {} as MockChain;
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.set = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => result);
  chain.get = vi.fn(async () => result ?? null);
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
  orderUpdateResult?: unknown[];
  itemReplacementError?: Error;
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
    [],
    options.existingOrder,
    options.activeRefundAttempt ?? null,
    options.legacyPendingRefund ?? null,
    options.existingItems,
    liveSkuRows,
  ];

  return {
    select: vi.fn(() => createChain(selectResults[selectIndex++])),
    update: vi.fn(() => {
      events.push("order-cas-update");
      return createChain(options.orderUpdateResult ?? [{ id: ORDER_ID }]);
    }),
    insert: vi.fn(() => createChain([{ id: "inserted" }])),
    delete: vi.fn(() => createChain(undefined)),
    batch: vi.fn(async () => {
      events.push("item-replacement-batch");
      if (options.itemReplacementError) {
        throw options.itemReplacementError;
      }
      return [];
    }),
  };
}

function createRestoreOrderDb(options: {
  order: ReturnType<typeof seedOrder> & {
    deletedAt: number | Date | null;
    shipmentClaimId?: string | null;
    shipmentClaimExpiresAt?: Date | number | null;
  };
  items?: ReturnType<typeof seedOrderItem>[];
  orderUpdateResult?: unknown[];
  activeRefundAttempt?: Record<string, unknown> | null;
  legacyPendingRefund?: Record<string, unknown> | null;
}) {
  let selectIndex = 0;
  const selectResults = [
    options.order,
    options.activeRefundAttempt ?? null,
    options.legacyPendingRefund ?? null,
    options.items ?? [item(1)],
  ];
  const updateSets: unknown[] = [];

  const db = {
    select: vi.fn(() => createChain(selectResults[selectIndex++])),
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

function existingOrder(overrides: Partial<ReturnType<typeof seedOrder>> = {}) {
  return seedOrder({
    id: ORDER_ID,
    customerId: "cust_atomicity",
    customerName: "Atomic Customer",
    customerPhone: "+8801700000000",
    status: "pending",
    inventoryAction: "reserved",
    inventoryPool: "regular",
    ...overrides,
  });
}

function deletedRestoredOrder(status: string, overrides: Partial<ReturnType<typeof seedOrder>> = {}) {
  return {
    ...existingOrder({
      status,
      inventoryAction: "restored",
      inventoryPool: "regular",
      ...overrides,
    }),
    deletedAt: 1_800_000,
    shipmentClaimId: null,
    shipmentClaimExpiresAt: null,
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
      message: "Order has an active shipment creation in progress. Please retry shortly.",
    });

    expect(inventoryMocks.validateStockBatchAvailability).not.toHaveBeenCalled();
    expect(inventoryMocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(inventoryMocks.deductMultiple).not.toHaveBeenCalled();
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
    expect(inventoryMocks.deductMultiple).not.toHaveBeenCalled();
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

    await expect(updateOrder(db as never, ORDER_ID, updateData())).rejects.toMatchObject({
      name: "ConflictError",
      code: "CONFLICT",
      message: "Order was modified by another request. Please reload and try again.",
    });

    const positiveEntries = [{ variantId: EXISTING_VARIANT_ID, quantity: 2, pool: "regular" }];
    expect(inventoryMocks.reserveStockBatch).toHaveBeenCalledWith(
      db,
      [{ variantId: EXISTING_VARIANT_ID, quantity: 2, orderId: ORDER_ID }],
      "regular",
    );
    expect(inventoryMocks.releaseMultiple).toHaveBeenCalledWith(db, positiveEntries, ORDER_ID);
    expect(inventoryMocks.restoreDeductedMultiple).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(events).toEqual(["validate", "reserve", "order-cas-update", "release"]);
  });

  it("reserves and deducts deducted-order positive deltas before write, then restores deducted stock on CAS failure", async () => {
    const db = createUpdateOrderDb({
      existingOrder: existingOrder({ status: "shipped", inventoryAction: "deducted", version: 3 }),
      existingItems: [item(1)],
      orderUpdateResult: [],
    });

    await expect(
      updateOrder(db as never, ORDER_ID, updateData({ status: "shipped", items: [item(4)] })),
    ).rejects.toMatchObject({
      name: "ConflictError",
      code: "CONFLICT",
    });

    const positiveEntries = [{ variantId: EXISTING_VARIANT_ID, quantity: 3, pool: "regular" }];
    expect(inventoryMocks.validateStockBatchAvailability).not.toHaveBeenCalled();
    expect(inventoryMocks.reserveStockBatch).toHaveBeenCalledWith(
      db,
      [{ variantId: EXISTING_VARIANT_ID, quantity: 3, orderId: ORDER_ID }],
      "regular",
    );
    expect(inventoryMocks.deductMultiple).toHaveBeenCalledWith(db, positiveEntries, ORDER_ID);
    expect(inventoryMocks.restoreDeductedMultiple).toHaveBeenCalledWith(db, positiveEntries, ORDER_ID);
    expect(inventoryMocks.releaseMultiple).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(events).toEqual(["reserve", "deduct", "order-cas-update", "restore-deducted"]);
  });

  it("reserves restored-order reactivation items before write and releases them on CAS failure", async () => {
    const db = createUpdateOrderDb({
      existingOrder: existingOrder({
        status: "cancelled",
        inventoryAction: "restored",
        version: 4,
      }),
      existingItems: [item(1)],
      orderUpdateResult: [],
    });
    const newItem = item(2, NEW_VARIANT_ID);

    await expect(
      updateOrder(
        db as never,
        ORDER_ID,
        updateData({ status: "pending", items: [newItem] }),
      ),
    ).rejects.toMatchObject({
      name: "ConflictError",
      code: "CONFLICT",
    });

    const newEntries = [{ variantId: NEW_VARIANT_ID, quantity: 2, pool: "regular" }];
    expect(inventoryMocks.reserveStockBatch).toHaveBeenCalledWith(
      db,
      [{ variantId: NEW_VARIANT_ID, quantity: 2, orderId: ORDER_ID }],
      "regular",
    );
    expect(inventoryMocks.releaseMultiple).toHaveBeenCalledWith(db, newEntries, ORDER_ID);
    expect(inventoryMocks.deductMultiple).not.toHaveBeenCalled();
    expect(inventoryMocks.restoreDeductedMultiple).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(events).toEqual(["reserve", "order-cas-update", "release"]);
  });

  it("fails reserved quantity decreases before item replacement when reservation release fails", async () => {
    const db = createUpdateOrderDb({
      existingOrder: existingOrder({ inventoryAction: "reserved" }),
      existingItems: [item(3)],
    });
    inventoryMocks.releaseMultiple.mockImplementation(async () => {
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

    expect(inventoryMocks.releaseMultiple).toHaveBeenCalledWith(
      db,
      [{ variantId: EXISTING_VARIANT_ID, quantity: 2, pool: "regular" }],
      ORDER_ID,
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
      updateOrder(db as never, ORDER_ID, updateData({ items: [item(1)] })),
    ).rejects.toMatchObject({
      name: "ConflictError",
      code: "CONFLICT",
    });

    const releasedEntries = [{ variantId: EXISTING_VARIANT_ID, quantity: 2, pool: "regular" }];
    expect(inventoryMocks.releaseMultiple).toHaveBeenCalledWith(db, releasedEntries, ORDER_ID);
    expect(inventoryMocks.reserveStockBatch).toHaveBeenCalledWith(
      db,
      [{ variantId: EXISTING_VARIANT_ID, quantity: 2, orderId: ORDER_ID }],
      "regular",
    );
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(events).toEqual(["release", "order-cas-update", "reserve"]);
  });

  it("fails deducted quantity decreases before item replacement when deducted restore fails", async () => {
    const db = createUpdateOrderDb({
      existingOrder: existingOrder({ status: "shipped", inventoryAction: "deducted" }),
      existingItems: [item(3)],
    });
    inventoryMocks.restoreDeductedMultiple.mockImplementation(async () => {
      events.push("restore-deducted");
      return restoreFailure;
    });

    await expect(
      updateOrder(
        db as never,
        ORDER_ID,
        updateData({ status: "shipped", items: [item(1)] }),
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      message: restoreFailure.error,
    });

    expect(inventoryMocks.restoreDeductedMultiple).toHaveBeenCalledWith(
      db,
      [{ variantId: EXISTING_VARIANT_ID, quantity: 2, pool: "regular" }],
      ORDER_ID,
    );
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(events).toEqual(["restore-deducted"]);
  });

  it("compensates restored deducted deltas when the order CAS fails", async () => {
    const db = createUpdateOrderDb({
      existingOrder: existingOrder({ status: "shipped", inventoryAction: "deducted", version: 12 }),
      existingItems: [item(3)],
      orderUpdateResult: [],
    });

    await expect(
      updateOrder(
        db as never,
        ORDER_ID,
        updateData({ status: "shipped", items: [item(1)] }),
      ),
    ).rejects.toMatchObject({
      name: "ConflictError",
      code: "CONFLICT",
    });

    const restoredEntries = [{ variantId: EXISTING_VARIANT_ID, quantity: 2, pool: "regular" }];
    expect(inventoryMocks.restoreDeductedMultiple).toHaveBeenCalledWith(db, restoredEntries, ORDER_ID);
    expect(inventoryMocks.deductMultiple).toHaveBeenCalledWith(db, restoredEntries, ORDER_ID);
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(events).toEqual(["restore-deducted", "order-cas-update", "deduct"]);
  });

  it("compensates full reserved-order cancellation release when the order CAS fails", async () => {
    const db = createUpdateOrderDb({
      existingOrder: existingOrder({ inventoryAction: "reserved", version: 13 }),
      existingItems: [item(2)],
      orderUpdateResult: [],
    });

    await expect(
      updateOrder(
        db as never,
        ORDER_ID,
        updateData({ status: "cancelled", items: [] }),
      ),
    ).rejects.toMatchObject({
      name: "ConflictError",
      code: "CONFLICT",
    });

    const releasedEntries = [{ variantId: EXISTING_VARIANT_ID, quantity: 2, pool: "regular" }];
    expect(inventoryMocks.releaseMultiple).toHaveBeenCalledWith(db, releasedEntries, ORDER_ID);
    expect(inventoryMocks.reserveStockBatch).toHaveBeenCalledWith(
      db,
      [{ variantId: EXISTING_VARIANT_ID, quantity: 2, orderId: ORDER_ID }],
      "regular",
    );
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(events).toEqual(["release", "order-cas-update", "reserve"]);
  });

  it("compensates inventory if atomic item replacement fails after the order CAS", async () => {
    const db = createUpdateOrderDb({
      existingOrder: existingOrder({ inventoryAction: "reserved", version: 14 }),
      existingItems: [item(3)],
      itemReplacementError: new Error("item batch failed"),
    });

    await expect(
      updateOrder(db as never, ORDER_ID, updateData({ items: [item(1)] })),
    ).rejects.toThrow("item batch failed");

    const releasedEntries = [{ variantId: EXISTING_VARIANT_ID, quantity: 2, pool: "regular" }];
    expect(inventoryMocks.releaseMultiple).toHaveBeenCalledWith(db, releasedEntries, ORDER_ID);
    expect(inventoryMocks.reserveStockBatch).toHaveBeenCalledWith(
      db,
      [{ variantId: EXISTING_VARIANT_ID, quantity: 2, orderId: ORDER_ID }],
      "regular",
    );
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["release", "order-cas-update", "item-replacement-batch", "reserve"]);
  });

  it("reconciles inventory when retrying an edit after status already reached shipped", async () => {
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
        updateData({ status: "shipped", items: [item(2)] }),
      ),
    ).resolves.toEqual({ id: ORDER_ID });

    expect(inventoryMocks.applyInventoryForStatusChange).toHaveBeenCalledWith(
      db,
      ORDER_ID,
      "shipped",
    );
  });
});

describe("restoreOrder trash inventory safety", () => {
  it("re-reserves restored inventory only for pre-shipment live statuses", async () => {
    const { db, updateSets } = createRestoreOrderDb({
      order: deletedRestoredOrder("pending"),
      items: [item(2)],
    });

    await expect(restoreOrder(db as never, ORDER_ID)).resolves.toBeUndefined();

    expect(inventoryMocks.reserveStockBatch).toHaveBeenCalledWith(
      db,
      [{ variantId: EXISTING_VARIANT_ID, quantity: 2, orderId: ORDER_ID }],
      "regular",
    );
    expect(updateSets.at(-1)).toMatchObject({
      deletedAt: null,
      inventoryAction: "reserved",
    });
  });

  it("re-reserves incomplete restored orders when variant items exist", async () => {
    const { db, updateSets } = createRestoreOrderDb({
      order: deletedRestoredOrder("incomplete"),
      items: [item(2)],
    });

    await expect(restoreOrder(db as never, ORDER_ID)).resolves.toBeUndefined();

    expect(inventoryMocks.reserveStockBatch).toHaveBeenCalledWith(
      db,
      [{ variantId: EXISTING_VARIANT_ID, quantity: 2, orderId: ORDER_ID }],
      "regular",
    );
    expect(updateSets.at(-1)).toMatchObject({
      deletedAt: null,
      inventoryAction: "reserved",
    });
  });

  it("restores cancelled orders without re-reserving stock", async () => {
    const { db, updateSets } = createRestoreOrderDb({
      order: deletedRestoredOrder("cancelled"),
      items: [item(2)],
    });

    await expect(restoreOrder(db as never, ORDER_ID)).resolves.toBeUndefined();

    expect(inventoryMocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledTimes(3);
    expect(updateSets.at(-1)).toMatchObject({
      deletedAt: null,
      inventoryAction: "restored",
    });
  });

  it("restores no-variant incomplete orders without creating an inventory reservation", async () => {
    const { db, updateSets } = createRestoreOrderDb({
      order: deletedRestoredOrder("incomplete"),
      items: [{ ...item(2), variantId: null }],
    });

    await expect(restoreOrder(db as never, ORDER_ID)).resolves.toBeUndefined();

    expect(inventoryMocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledTimes(4);
    expect(updateSets.at(-1)).toMatchObject({
      deletedAt: null,
      inventoryAction: "none",
    });
  });

  it.each(["shipped", "delivered", "completed", "refunded", "partially_refunded"])(
    "allows %s orders that are already deducted",
    async (status) => {
      const { db, updateSets } = createRestoreOrderDb({
        order: deletedRestoredOrder(status, { inventoryAction: "deducted" }),
        items: [item(2)],
      });

      await expect(restoreOrder(db as never, ORDER_ID)).resolves.toBeUndefined();

      expect(inventoryMocks.reserveStockBatch).not.toHaveBeenCalled();
      expect(updateSets.at(-1)).toMatchObject({
        deletedAt: null,
        inventoryAction: "deducted",
      });
    },
  );

  it.each(["cancelled", "returned", "refunded"])(
    "rejects %s orders that still claim reserved inventory",
    async (status) => {
      const { db } = createRestoreOrderDb({
        order: deletedRestoredOrder(status, { inventoryAction: "reserved" }),
        items: [item(2)],
      });

      await expect(restoreOrder(db as never, ORDER_ID)).rejects.toMatchObject({
        name: "ValidationError",
        code: "VALIDATION_ERROR",
        message: expect.stringContaining(`status "${status}"`),
      });

      expect(inventoryMocks.reserveStockBatch).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    },
  );

  it.each(["shipped", "delivered", "completed", "partially_refunded"])(
    "rejects %s orders whose inventory was restored during trashing",
    async (status) => {
      const { db } = createRestoreOrderDb({
        order: deletedRestoredOrder(status),
        items: [item(2)],
      });

      await expect(restoreOrder(db as never, ORDER_ID)).rejects.toMatchObject({
        name: "ValidationError",
        code: "VALIDATION_ERROR",
        message: expect.stringContaining(`status "${status}"`),
      });

      expect(inventoryMocks.reserveStockBatch).not.toHaveBeenCalled();
      expect(db.select).toHaveBeenCalledTimes(3);
      expect(db.update).not.toHaveBeenCalled();
    },
  );

  it("does not clear deletedAt when re-reservation fails", async () => {
    const { db } = createRestoreOrderDb({
      order: deletedRestoredOrder("confirmed"),
      items: [item(2)],
    });
    inventoryMocks.reserveStockBatch.mockResolvedValueOnce(validationFailure);

    await expect(restoreOrder(db as never, ORDER_ID)).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      message: expect.stringContaining(validationFailure.error),
    });

    expect(db.update).not.toHaveBeenCalled();
  });

  it("rejects active refund attempts before restore re-reserves inventory", async () => {
    const { db } = createRestoreOrderDb({
      order: deletedRestoredOrder("confirmed"),
      items: [item(2)],
      activeRefundAttempt: { id: "rfa_active", orderId: ORDER_ID, status: "reconcile_required" },
    });

    await expect(restoreOrder(db as never, ORDER_ID)).rejects.toMatchObject({
      name: "ConflictError",
      code: "CONFLICT",
      message: "Order has an active refund operation. Complete or reconcile the refund before changing this order.",
    });

    expect(inventoryMocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("compensates a re-reservation when the final restore CAS loses the race", async () => {
    const { db } = createRestoreOrderDb({
      order: deletedRestoredOrder("confirmed"),
      items: [item(2)],
      orderUpdateResult: [],
    });

    await expect(restoreOrder(db as never, ORDER_ID)).rejects.toMatchObject({
      name: "ConflictError",
      code: "CONFLICT",
    });

    const entries = [{ variantId: EXISTING_VARIANT_ID, quantity: 2, pool: "regular" }];
    expect(inventoryMocks.reserveStockBatch).toHaveBeenCalledWith(
      db,
      [{ variantId: EXISTING_VARIANT_ID, quantity: 2, orderId: ORDER_ID }],
      "regular",
    );
    expect(inventoryMocks.releaseMultiple).toHaveBeenCalledWith(db, entries, ORDER_ID);
  });
});
