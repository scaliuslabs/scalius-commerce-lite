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
}));

type UpdateOrder = typeof import("../../../../packages/core/src/modules/orders/orders.admin").updateOrder;

type MockChain = {
  from: ReturnType<typeof vi.fn>;
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

let updateOrder: UpdateOrder;
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

  ({ updateOrder } = await import("../../../../packages/core/src/modules/orders/orders.admin"));
});

function createChain(result: unknown): MockChain {
  const chain = {} as MockChain;
  chain.from = vi.fn(() => chain);
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
  orderUpdateResult?: unknown[];
}) {
  let selectIndex = 0;
  const selectResults = [
    [],
    options.existingOrder,
    options.existingItems,
  ];

  return {
    select: vi.fn(() => createChain(selectResults[selectIndex++])),
    update: vi.fn(() => {
      events.push("order-cas-update");
      return createChain(options.orderUpdateResult ?? [{ id: ORDER_ID }]);
    }),
    insert: vi.fn(() => createChain([{ id: "inserted" }])),
    delete: vi.fn(() => createChain(undefined)),
  };
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
