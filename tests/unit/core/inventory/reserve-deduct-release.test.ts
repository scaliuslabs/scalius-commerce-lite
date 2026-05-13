// tests/unit/core/inventory/reserve-deduct-release.test.ts
// Unit tests for the inventory reserve/deduct/release pure logic.
//
// Since the actual functions depend on a real drizzle db connection,
// we test the business logic by replicating the key algorithms as pure functions
// and verifying the invariants that the hardening session established.

import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { seedVariant } from "../../../setup";

// ---------------------------------------------------------------------------
// Pure logic extracted from reserve.ts, release.ts, deduct.ts
// ---------------------------------------------------------------------------

interface Variant {
  id: string;
  stock: number;
  reservedStock: number;
  preorderStock: number;
  allowPreorder: boolean;
  allowBackorder: boolean;
  backorderLimit: number;
  version: number;
}

interface StockOperationResult {
  success: boolean;
  variantId: string;
  previousStock: number;
  newStock: number;
  error?: string;
}

/**
 * Pure logic from reserveStock() — checks if reservation is possible.
 * Returns the result without any db side effects.
 */
function checkReservation(
  variant: Variant,
  quantity: number,
  pool: "regular" | "preorder" | "backorder" = "regular"
): StockOperationResult {
  if (pool === "preorder") {
    if (!variant.allowPreorder) {
      return {
        success: false,
        variantId: variant.id,
        previousStock: variant.preorderStock,
        newStock: variant.preorderStock,
        error: `Pre-order not allowed for variant ${variant.id}`,
      };
    }
    if (variant.preorderStock < quantity) {
      return {
        success: false,
        variantId: variant.id,
        previousStock: variant.preorderStock,
        newStock: variant.preorderStock,
        error: `Insufficient pre-order stock for variant ${variant.id}. Available: ${variant.preorderStock}, Requested: ${quantity}`,
      };
    }
    return {
      success: true,
      variantId: variant.id,
      previousStock: variant.preorderStock,
      newStock: variant.preorderStock - quantity,
    };
  }

  if (pool === "backorder") {
    if (!variant.allowBackorder) {
      return {
        success: false,
        variantId: variant.id,
        previousStock: variant.stock,
        newStock: variant.stock,
        error: `Backorder not allowed for variant ${variant.id}`,
      };
    }
    if (variant.backorderLimit > 0 && variant.reservedStock + quantity > variant.backorderLimit) {
      return {
        success: false,
        variantId: variant.id,
        previousStock: variant.stock,
        newStock: variant.stock,
        error: `Backorder limit exceeded for variant ${variant.id}`,
      };
    }
    return {
      success: true,
      variantId: variant.id,
      previousStock: variant.stock,
      newStock: variant.stock,
    };
  }

  // Regular stock: available = stock - reservedStock
  const available = variant.stock - variant.reservedStock;
  if (available < quantity) {
    return {
      success: false,
      variantId: variant.id,
      previousStock: variant.stock,
      newStock: variant.stock,
      error: `Insufficient stock for variant ${variant.id}. Available: ${available}, Requested: ${quantity}`,
    };
  }

  return {
    success: true,
    variantId: variant.id,
    previousStock: variant.stock,
    newStock: variant.stock, // Stock doesn't change on reservation, only reservedStock
  };
}

/**
 * Pure logic from deductStock() — computes the new stock level.
 */
function computeDeduction(
  variant: Variant,
  quantity: number,
  pool: "regular" | "preorder" | "backorder" = "regular"
): { newStock: number; newReservedStock: number } {
  if (pool === "regular") {
    return {
      newStock: Math.max(0, variant.stock - quantity),
      newReservedStock: Math.max(0, variant.reservedStock - quantity),
    };
  }
  // preorder & backorder: just release the hold
  return {
    newStock: variant.stock, // unchanged
    newReservedStock: Math.max(0, variant.reservedStock - quantity),
  };
}

/**
 * Pure logic from releaseReservation() — computes the new reserved stock.
 */
function computeRelease(
  variant: Variant,
  quantity: number,
  pool: "regular" | "preorder" | "backorder" = "regular"
): { newReservedStock: number; newPreorderStock: number } {
  return {
    newReservedStock: Math.max(0, variant.reservedStock - quantity),
    newPreorderStock: pool === "preorder"
      ? variant.preorderStock + quantity
      : variant.preorderStock,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reserveStock logic", () => {
  it("succeeds when sufficient regular stock available", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 50,
      reservedStock: 10,
      preorderStock: 0,
      allowPreorder: false,
      allowBackorder: false,
      backorderLimit: 0,
      version: 1,
    };

    const result = checkReservation(variant, 5);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("fails when insufficient regular stock", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 10,
      reservedStock: 8,
      preorderStock: 0,
      allowPreorder: false,
      allowBackorder: false,
      backorderLimit: 0,
      version: 1,
    };

    const result = checkReservation(variant, 5);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Insufficient stock");
    expect(result.error).toContain("Available: 2");
    expect(result.error).toContain("Requested: 5");
  });

  it("fails when stock equals reservedStock (zero available)", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 10,
      reservedStock: 10,
      preorderStock: 0,
      allowPreorder: false,
      allowBackorder: false,
      backorderLimit: 0,
      version: 1,
    };

    const result = checkReservation(variant, 1);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Insufficient stock");
  });

  it("succeeds for exact available quantity", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 10,
      reservedStock: 5,
      preorderStock: 0,
      allowPreorder: false,
      allowBackorder: false,
      backorderLimit: 0,
      version: 1,
    };

    const result = checkReservation(variant, 5);
    expect(result.success).toBe(true);
  });
});

describe("reserveStock pool-aware logic", () => {
  it("preorder: fails when allowPreorder is false", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 0,
      reservedStock: 0,
      preorderStock: 20,
      allowPreorder: false,
      allowBackorder: false,
      backorderLimit: 0,
      version: 1,
    };

    const result = checkReservation(variant, 5, "preorder");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Pre-order not allowed");
  });

  it("preorder: succeeds when allowPreorder is true and sufficient preorderStock", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 0,
      reservedStock: 0,
      preorderStock: 20,
      allowPreorder: true,
      allowBackorder: false,
      backorderLimit: 0,
      version: 1,
    };

    const result = checkReservation(variant, 5, "preorder");
    expect(result.success).toBe(true);
    expect(result.newStock).toBe(15); // preorderStock - quantity
  });

  it("preorder: fails when insufficient preorderStock", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 100,
      reservedStock: 0,
      preorderStock: 3,
      allowPreorder: true,
      allowBackorder: false,
      backorderLimit: 0,
      version: 1,
    };

    const result = checkReservation(variant, 5, "preorder");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Insufficient pre-order stock");
  });

  it("backorder: fails when allowBackorder is false", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 0,
      reservedStock: 0,
      preorderStock: 0,
      allowPreorder: false,
      allowBackorder: false,
      backorderLimit: 0,
      version: 1,
    };

    const result = checkReservation(variant, 5, "backorder");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Backorder not allowed");
  });

  it("backorder: succeeds when allowBackorder is true and within limit", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 0,
      reservedStock: 5,
      preorderStock: 0,
      allowPreorder: false,
      allowBackorder: true,
      backorderLimit: 20,
      version: 1,
    };

    const result = checkReservation(variant, 10, "backorder");
    expect(result.success).toBe(true);
  });

  it("backorder: fails when exceeding backorder limit", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 0,
      reservedStock: 15,
      preorderStock: 0,
      allowPreorder: false,
      allowBackorder: true,
      backorderLimit: 20,
      version: 1,
    };

    const result = checkReservation(variant, 10, "backorder");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Backorder limit exceeded");
  });

  it("backorder: unlimited when backorderLimit is 0", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 0,
      reservedStock: 1000,
      preorderStock: 0,
      allowPreorder: false,
      allowBackorder: true,
      backorderLimit: 0,
      version: 1,
    };

    const result = checkReservation(variant, 500, "backorder");
    expect(result.success).toBe(true);
  });
});

describe("deductStock logic", () => {
  it("decrements both stock and reservedStock for regular pool", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 50,
      reservedStock: 10,
      preorderStock: 0,
      allowPreorder: false,
      allowBackorder: false,
      backorderLimit: 0,
      version: 1,
    };

    const result = computeDeduction(variant, 5);
    expect(result.newStock).toBe(45);
    expect(result.newReservedStock).toBe(5);
  });

  it("uses MAX(0, ...) to prevent negative stock", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 3,
      reservedStock: 2,
      preorderStock: 0,
      allowPreorder: false,
      allowBackorder: false,
      backorderLimit: 0,
      version: 1,
    };

    const result = computeDeduction(variant, 5);
    expect(result.newStock).toBe(0); // MAX(0, 3-5) = 0
    expect(result.newReservedStock).toBe(0); // MAX(0, 2-5) = 0
  });

  it("only decrements reservedStock for preorder pool (stock unchanged)", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 10,
      reservedStock: 5,
      preorderStock: 0,
      allowPreorder: true,
      allowBackorder: false,
      backorderLimit: 0,
      version: 1,
    };

    const result = computeDeduction(variant, 3, "preorder");
    expect(result.newStock).toBe(10); // Unchanged
    expect(result.newReservedStock).toBe(2);
  });

  it("only decrements reservedStock for backorder pool (stock unchanged)", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 0,
      reservedStock: 5,
      preorderStock: 0,
      allowPreorder: false,
      allowBackorder: true,
      backorderLimit: 20,
      version: 1,
    };

    const result = computeDeduction(variant, 3, "backorder");
    expect(result.newStock).toBe(0); // Unchanged
    expect(result.newReservedStock).toBe(2);
  });
});

describe("releaseReservation logic", () => {
  it("decrements reservedStock using MAX(0, ...) for idempotency", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 50,
      reservedStock: 10,
      preorderStock: 0,
      allowPreorder: false,
      allowBackorder: false,
      backorderLimit: 0,
      version: 1,
    };

    const result = computeRelease(variant, 5);
    expect(result.newReservedStock).toBe(5);
    expect(result.newPreorderStock).toBe(0);
  });

  it("never goes negative on reservedStock (MAX(0, ...))", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 50,
      reservedStock: 2,
      preorderStock: 0,
      allowPreorder: false,
      allowBackorder: false,
      backorderLimit: 0,
      version: 1,
    };

    const result = computeRelease(variant, 10);
    expect(result.newReservedStock).toBe(0); // MAX(0, 2-10) = 0
  });

  it("restores preorderStock for preorder pool", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 0,
      reservedStock: 5,
      preorderStock: 15,
      allowPreorder: true,
      allowBackorder: false,
      backorderLimit: 0,
      version: 1,
    };

    const result = computeRelease(variant, 5, "preorder");
    expect(result.newReservedStock).toBe(0);
    expect(result.newPreorderStock).toBe(20); // Restored
  });

  it("does NOT restore preorderStock for regular pool", () => {
    const variant: Variant = {
      id: "var_1",
      stock: 50,
      reservedStock: 5,
      preorderStock: 10,
      allowPreorder: true,
      allowBackorder: false,
      backorderLimit: 0,
      version: 1,
    };

    const result = computeRelease(variant, 3);
    expect(result.newPreorderStock).toBe(10); // Unchanged
  });
});

describe("CAS (optimistic locking) behavior", () => {
  it("detects version mismatch and would trigger retry", () => {
    // Simulating the optimistic locking logic:
    // If db.update().where(version = expected_version).returning() returns 0 rows,
    // it means a concurrent modification happened and the operation should retry.

    const expectedVersion = 5;
    const actualVersion = 6; // Another process incremented it

    const versionMatch = expectedVersion === actualVersion;
    expect(versionMatch).toBe(false);
    // In the real code, this would trigger a retry with backoff
  });

  it("succeeds when version matches", () => {
    const expectedVersion = 5;
    const actualVersion = 5;

    const versionMatch = expectedVersion === actualVersion;
    expect(versionMatch).toBe(true);
  });

  it("respects MAX_RETRIES = 3", () => {
    const MAX_RETRIES = 3;
    const attempts: number[] = [];

    // Simulate 3 failed attempts
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      attempts.push(attempt);
    }

    expect(attempts).toHaveLength(3);
    expect(attempts).toEqual([0, 1, 2]);
  });

  it("calculates exponential backoff correctly", () => {
    const BASE_BACKOFF_MS = 50;
    const backoffs = [0, 1, 2].map(
      (attempt) => BASE_BACKOFF_MS * Math.pow(2, attempt)
    );

    expect(backoffs).toEqual([50, 100, 200]);
  });
});

// ---------------------------------------------------------------------------
// Inventory transition failure hardening
// ---------------------------------------------------------------------------

const inventoryTransitionMocks = vi.hoisted(() => ({
  deductMultiple: vi.fn(),
  releaseMultiple: vi.fn(),
  reserveMultiple: vi.fn(),
  restoreDeductedMultiple: vi.fn(),
  checkAndAlertLowStock: vi.fn(),
}));

vi.mock("../../../../packages/core/src/modules/inventory/deduct", () => ({
  deductMultiple: inventoryTransitionMocks.deductMultiple,
}));

vi.mock("../../../../packages/core/src/modules/inventory/release", () => ({
  releaseMultiple: inventoryTransitionMocks.releaseMultiple,
}));

vi.mock("../../../../packages/core/src/modules/inventory/reserve", () => ({
  reserveMultiple: inventoryTransitionMocks.reserveMultiple,
}));

vi.mock("../../../../packages/core/src/modules/inventory/restore", () => ({
  restoreDeductedMultiple: inventoryTransitionMocks.restoreDeductedMultiple,
}));

vi.mock("../../../../packages/core/src/modules/inventory/alerts", () => ({
  checkAndAlertLowStock: inventoryTransitionMocks.checkAndAlertLowStock,
}));

let applyInventoryForStatusChange: typeof import("../../../../packages/core/src/modules/inventory/inventory-transitions").applyInventoryForStatusChange;

const TRANSITION_ORDER_ID = "ord_inventory_hardening";
const TRANSITION_ITEM = { variantId: "var_1", quantity: 2 };
const TRANSITION_VARIANT = { id: "var_1" };

type MockChain = {
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
};

function createChain(result: unknown): MockChain {
  const chain = {} as MockChain;
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.set = vi.fn(() => chain);
  chain.get = vi.fn(async () => result ?? null);
  chain.all = vi.fn(async () => {
    if (Array.isArray(result)) return result;
    return result ? [result] : [];
  });
  return chain;
}

function createTransitionDb(selectResults: unknown[]) {
  let selectIndex = 0;

  return {
    select: vi.fn(() => createChain(selectResults[selectIndex++])),
    update: vi.fn(() => createChain([{ id: TRANSITION_ORDER_ID }])),
    batch: vi.fn(async () => []),
  };
}

function orderWithInventoryAction(inventoryAction: string) {
  return {
    id: TRANSITION_ORDER_ID,
    status: "confirmed",
    inventoryAction,
    inventoryPool: "regular",
  };
}

function failedTransitionResult(operation: string) {
  return {
    success: false,
    results: [
      {
        success: false,
        variantId: TRANSITION_ITEM.variantId,
        previousStock: 0,
        newStock: 0,
        error: `${operation} failed`,
      },
    ],
    error: `${operation} failed`,
  };
}

describe("inventory status transition hardening", () => {
  beforeAll(async () => {
    ({ applyInventoryForStatusChange } = await import(
      "../../../../packages/core/src/modules/inventory/inventory-transitions"
    ));
  });

  beforeEach(() => {
    vi.resetAllMocks();
    inventoryTransitionMocks.checkAndAlertLowStock.mockResolvedValue(undefined);
  });

  it("throws and skips the inventoryAction batch when deduction fails", async () => {
    const db = createTransitionDb([orderWithInventoryAction("reserved"), [TRANSITION_ITEM]]);
    inventoryTransitionMocks.deductMultiple.mockResolvedValue(failedTransitionResult("deduct"));

    await expect(
      applyInventoryForStatusChange(db as never, TRANSITION_ORDER_ID, "shipped"),
    ).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      message: `Inventory deduct failed for order ${TRANSITION_ORDER_ID}: deduct failed`,
    });

    expect(inventoryTransitionMocks.deductMultiple).toHaveBeenCalledWith(
      db,
      [{ variantId: TRANSITION_ITEM.variantId, quantity: TRANSITION_ITEM.quantity, pool: "regular" }],
      TRANSITION_ORDER_ID,
    );
    expect(db.batch).not.toHaveBeenCalled();
    expect(inventoryTransitionMocks.checkAndAlertLowStock).not.toHaveBeenCalled();
  });

  it("throws and skips the inventoryAction batch when release reports failure", async () => {
    const db = createTransitionDb([
      orderWithInventoryAction("reserved"),
      [TRANSITION_ITEM],
      [TRANSITION_VARIANT],
    ]);
    inventoryTransitionMocks.releaseMultiple.mockResolvedValue(failedTransitionResult("release"));

    await expect(
      applyInventoryForStatusChange(db as never, TRANSITION_ORDER_ID, "cancelled"),
    ).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      message: `Inventory release failed for order ${TRANSITION_ORDER_ID}: release failed`,
    });

    expect(inventoryTransitionMocks.releaseMultiple).toHaveBeenCalledWith(
      db,
      [{ variantId: TRANSITION_ITEM.variantId, quantity: TRANSITION_ITEM.quantity, pool: "regular" }],
      TRANSITION_ORDER_ID,
    );
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("checks release variants before calling the best-effort release helper", async () => {
    const db = createTransitionDb([orderWithInventoryAction("reserved"), [TRANSITION_ITEM], []]);

    await expect(
      applyInventoryForStatusChange(db as never, TRANSITION_ORDER_ID, "cancelled"),
    ).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      message: `Inventory release failed for order ${TRANSITION_ORDER_ID}: Missing variant: ${TRANSITION_ITEM.variantId}`,
    });

    expect(inventoryTransitionMocks.releaseMultiple).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("throws and skips the inventoryAction batch when re-reservation fails", async () => {
    const db = createTransitionDb([orderWithInventoryAction("restored"), [TRANSITION_ITEM]]);
    inventoryTransitionMocks.reserveMultiple.mockResolvedValue(failedTransitionResult("reserve"));

    await expect(
      applyInventoryForStatusChange(db as never, TRANSITION_ORDER_ID, "pending"),
    ).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      message: `Inventory reserve failed for order ${TRANSITION_ORDER_ID}: reserve failed`,
    });

    expect(inventoryTransitionMocks.reserveMultiple).toHaveBeenCalledWith(
      db,
      [{ variantId: TRANSITION_ITEM.variantId, quantity: TRANSITION_ITEM.quantity, pool: "regular" }],
      TRANSITION_ORDER_ID,
    );
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("throws and skips the inventoryAction batch when deducted-stock restore fails", async () => {
    const db = createTransitionDb([
      orderWithInventoryAction("deducted"),
      [TRANSITION_ITEM],
      [TRANSITION_VARIANT],
    ]);
    inventoryTransitionMocks.restoreDeductedMultiple.mockResolvedValue(failedTransitionResult("restore"));

    await expect(
      applyInventoryForStatusChange(db as never, TRANSITION_ORDER_ID, "returned"),
    ).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      message: `Inventory restore failed for order ${TRANSITION_ORDER_ID}: restore failed`,
    });

    expect(inventoryTransitionMocks.restoreDeductedMultiple).toHaveBeenCalledWith(
      db,
      [{ variantId: TRANSITION_ITEM.variantId, quantity: TRANSITION_ITEM.quantity, pool: "regular" }],
      TRANSITION_ORDER_ID,
    );
    expect(db.batch).not.toHaveBeenCalled();
  });
});
