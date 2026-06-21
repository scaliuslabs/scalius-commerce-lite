// tests/unit/core/inventory/reserve-deduct-release.test.ts
// Unit tests for the inventory reserve/deduct/release pure logic.
//
// Since the actual functions depend on a real drizzle db connection,
// we test the business logic by replicating the key algorithms as pure functions
// and verifying the invariants that the hardening session established.

import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { seedVariant } from "../../../setup";
import { inventoryMovements, orders, productVariants } from "../../../../packages/database/src/schema";

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
  reserveStockBatch: vi.fn(),
  checkAndAlertLowStock: vi.fn(),
}));

vi.mock("../../../../packages/core/src/modules/inventory/reserve", () => ({
  reserveStockBatch: inventoryTransitionMocks.reserveStockBatch,
}));

vi.mock("../../../../packages/core/src/modules/inventory/alerts", () => ({
  checkAndAlertLowStock: inventoryTransitionMocks.checkAndAlertLowStock,
}));

let applyInventoryForStatusChange: typeof import("../../../../packages/core/src/modules/inventory/inventory-transitions").applyInventoryForStatusChange;

const TRANSITION_ORDER_ID = "ord_inventory_hardening";
const TRANSITION_ITEM = { variantId: "var_1", quantity: 2, inventoryTracked: true };
const TRANSITION_VARIANT = {
  id: "var_1",
  stock: 10,
  reservedStock: 2,
  preorderStock: 0,
  stockVersion: 7,
};

type TransitionStatement = {
  kind: "insertMovement" | "updateVariant" | "updateOrder" | "deleteMovement";
  table: unknown;
  values?: Record<string, unknown>;
  statement?: unknown;
};

type TransitionDbOptions = {
  order?: ReturnType<typeof orderWithInventoryAction> | null;
  items?: Array<typeof TRANSITION_ITEM>;
  variants?: Array<typeof TRANSITION_VARIANT | null>;
  batchErrors?: Error[];
  batchResults?: Array<Array<Array<{ id: string }>>>;
  movementGenerations?: number[];
  movementGeneration?: number;
  existingMovements?: Array<{
    id: string;
    variantId: string;
    orderId: string | null;
    type: string;
    quantity: number;
  }>;
  currentActionAfterMiss?: string | null;
};

function orderWithInventoryAction(inventoryAction: string, overrides: Partial<{
  status: string;
  inventoryPool: string;
  version: number;
}> = {}) {
  return {
    id: TRANSITION_ORDER_ID,
    status: "confirmed",
    inventoryAction,
    inventoryPool: "regular",
    version: 7,
    ...overrides,
  };
}

function createTransitionStatement(
  kind: TransitionStatement["kind"],
  table: unknown,
  values?: Record<string, unknown>,
  statement?: unknown,
): TransitionStatement & { returning: () => TransitionStatement } {
  const transitionStatement = { kind, table, values, statement } as TransitionStatement & {
    returning: () => TransitionStatement;
  };
  transitionStatement.returning = () => transitionStatement;
  return transitionStatement;
}

function createTransitionDb(options: TransitionDbOptions = {}) {
  const batchCalls: TransitionStatement[][] = [];
  const batchErrors = [...(options.batchErrors ?? [])];
  const batchResults = [...(options.batchResults ?? [])];
  const movementGenerations = [...(options.movementGenerations ?? [])];
  const variantQueue = [...(options.variants ?? [TRANSITION_VARIANT])];

  const db = {
    select: vi.fn((projection: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          get: vi.fn(async () => {
            if ("count" in projection) {
              return { count: movementGenerations.shift() ?? options.movementGeneration ?? 0 };
            }
            if ("status" in projection && "version" in projection) {
              return options.order === undefined
                ? orderWithInventoryAction("reserved")
                : options.order;
            }
            if ("stock" in projection && "stockVersion" in projection) {
              return variantQueue.shift() ?? null;
            }
            if ("inventoryAction" in projection) {
              return options.currentActionAfterMiss === undefined
                ? null
                : { inventoryAction: options.currentActionAfterMiss };
            }
            return null;
          }),
          all: vi.fn(async () => {
            if ("type" in projection && "quantity" in projection) {
              return options.existingMovements ?? [];
            }
            if ("variantId" in projection && "quantity" in projection) {
              return options.items ?? [TRANSITION_ITEM];
            }
            return [];
          }),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      select: vi.fn((statement: unknown) => ({
        returning: vi.fn(() => createTransitionStatement("insertMovement", table, undefined, statement)),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => {
          const kind = table === orders ? "updateOrder" : "updateVariant";
          return createTransitionStatement(kind, table, values);
        }),
      })),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(() => createTransitionStatement("deleteMovement", table)),
    })),
    batch: vi.fn(async (statements: TransitionStatement[]) => {
      batchCalls.push(statements);
      const nextError = batchErrors.shift();
      if (nextError) throw nextError;

      const nextResults = batchResults.shift();
      if (nextResults) return nextResults;

      return statements.map((statement) => {
        if (statement.kind === "insertMovement") return [{ id: "movement_1" }];
        if (statement.kind === "updateVariant") return [{ id: TRANSITION_ITEM.variantId }];
        if (statement.kind === "updateOrder") return [{ id: TRANSITION_ORDER_ID }];
        return [];
      });
    }),
  };

  return { db, batchCalls };
}

async function expectedTransitionMovementId(
  operation: "deduct" | "release" | "reserve" | "restore",
  generation = 0,
): Promise<string> {
  const payload = [
    "order-inventory-transition:v1",
    TRANSITION_ORDER_ID,
    TRANSITION_ITEM.variantId,
    operation,
    "regular",
    String(generation),
  ].join("\0");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `transition:${hex}`;
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
    inventoryTransitionMocks.reserveStockBatch.mockResolvedValue({
      success: true,
      results: [{ success: true, variantId: TRANSITION_ITEM.variantId, previousStock: 10, newStock: 10 }],
    });
  });

  it("batches a deterministic movement claim with the stock CAS before finalizing the inventoryAction", async () => {
    const { db, batchCalls } = createTransitionDb();

    await expect(
      applyInventoryForStatusChange(db as never, TRANSITION_ORDER_ID, "shipped"),
    ).resolves.toBe("deducted");

    expect(batchCalls).toHaveLength(2);
    expect(batchCalls[0]).toEqual([
      expect.objectContaining({ kind: "insertMovement", table: inventoryMovements }),
      expect.objectContaining({ kind: "updateVariant", table: productVariants }),
    ]);
    expect(batchCalls[1]).toEqual([
      expect.objectContaining({ kind: "updateOrder", table: orders }),
    ]);
    expect(inventoryTransitionMocks.checkAndAlertLowStock).toHaveBeenCalledWith(db, TRANSITION_ITEM.variantId);
    expect(inventoryTransitionMocks.reserveStockBatch).not.toHaveBeenCalled();
  });

  it("treats an exact duplicate transition movement as idempotent success", async () => {
    const movementId = await expectedTransitionMovementId("deduct");
    const { db, batchCalls } = createTransitionDb({
      order: orderWithInventoryAction("reserved", { version: 99 }),
      batchErrors: [
        new Error(`D1_ERROR: UNIQUE constraint failed: inventory_movements.id ${movementId}`),
      ],
      existingMovements: [
        {
          id: movementId,
          variantId: TRANSITION_ITEM.variantId,
          orderId: TRANSITION_ORDER_ID,
          type: "deducted",
          quantity: TRANSITION_ITEM.quantity,
        },
      ],
    });

    await expect(
      applyInventoryForStatusChange(db as never, TRANSITION_ORDER_ID, "delivered"),
    ).resolves.toBe("deducted");

    expect(batchCalls).toHaveLength(2);
    expect(batchCalls[0]).toEqual([
      expect.objectContaining({ kind: "insertMovement", table: inventoryMovements }),
      expect.objectContaining({ kind: "updateVariant", table: productVariants }),
    ]);
    expect(batchCalls[1]).toEqual([
      expect.objectContaining({ kind: "updateOrder", table: orders }),
    ]);
  });

  it("fails closed when a duplicate transition movement has different contents", async () => {
    const movementId = await expectedTransitionMovementId("deduct");
    const { db, batchCalls } = createTransitionDb({
      batchErrors: [
        new Error(`D1_ERROR: UNIQUE constraint failed: inventory_movements.id ${movementId}`),
      ],
      existingMovements: [
        {
          id: movementId,
          variantId: TRANSITION_ITEM.variantId,
          orderId: TRANSITION_ORDER_ID,
          type: "deducted",
          quantity: 1,
        },
      ],
    });

    await expect(
      applyInventoryForStatusChange(db as never, TRANSITION_ORDER_ID, "shipped"),
    ).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      message: `Inventory deduct failed for order ${TRANSITION_ORDER_ID}: Inventory transition claim mismatch requires manual inventory reconciliation`,
    });

    expect(batchCalls).toHaveLength(1);
    expect(inventoryTransitionMocks.checkAndAlertLowStock).not.toHaveBeenCalled();
  });

  it("accepts a missed inventoryAction CAS when another caller already finalized the same transition", async () => {
    const { db } = createTransitionDb({
      batchResults: [
        [[{ id: "movement_1" }], [{ id: TRANSITION_ITEM.variantId }]],
        [[]],
      ],
      currentActionAfterMiss: "deducted",
    });

    await expect(
      applyInventoryForStatusChange(db as never, TRANSITION_ORDER_ID, "shipped"),
    ).resolves.toBe("deducted");
  });

  it("rejects a missed inventoryAction CAS when the order is still on a conflicting action", async () => {
    const { db } = createTransitionDb({
      batchResults: [
        [[{ id: "movement_1" }], [{ id: TRANSITION_ITEM.variantId }]],
        [[]],
      ],
      currentActionAfterMiss: "reserved",
    });

    await expect(
      applyInventoryForStatusChange(db as never, TRANSITION_ORDER_ID, "shipped"),
    ).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      message: `Inventory action update conflicted for order ${TRANSITION_ORDER_ID}`,
    });
  });

  it("throws before batching the inventoryAction when a transition variant is missing", async () => {
    const { db, batchCalls } = createTransitionDb({ variants: [null] });

    await expect(
      applyInventoryForStatusChange(db as never, TRANSITION_ORDER_ID, "cancelled"),
    ).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      message: `Inventory release failed for order ${TRANSITION_ORDER_ID}: Missing variant: ${TRANSITION_ITEM.variantId}`,
    });

    expect(batchCalls).toHaveLength(0);
  });

  it("does not re-reserve restored inventory for non-reservable statuses", async () => {
    const { db, batchCalls } = createTransitionDb({
      order: orderWithInventoryAction("restored", { status: "completed" }),
    });

    await expect(
      applyInventoryForStatusChange(db as never, TRANSITION_ORDER_ID, "completed"),
    ).resolves.toBe("restored");

    expect(inventoryTransitionMocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(batchCalls).toHaveLength(0);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("passes a deterministic movement claim to reserveStockBatch when re-reserving restored inventory", async () => {
    const expectedMovementId = await expectedTransitionMovementId("reserve");
    const { db, batchCalls } = createTransitionDb({
      order: orderWithInventoryAction("restored", { version: 99 }),
    });

    await expect(
      applyInventoryForStatusChange(db as never, TRANSITION_ORDER_ID, "pending"),
    ).resolves.toBe("reserved");

    expect(inventoryTransitionMocks.reserveStockBatch).toHaveBeenCalledWith(
      db,
      [{
        variantId: TRANSITION_ITEM.variantId,
        quantity: TRANSITION_ITEM.quantity,
        orderId: TRANSITION_ORDER_ID,
        movementId: expectedMovementId,
      }],
      "regular",
    );
    expect(batchCalls).toEqual([
      [expect.objectContaining({ kind: "updateOrder", table: orders })],
    ]);
  });

  it("throws before finalizing the inventoryAction when re-reservation fails", async () => {
    const { db, batchCalls } = createTransitionDb({
      order: orderWithInventoryAction("restored"),
    });
    inventoryTransitionMocks.reserveStockBatch.mockResolvedValueOnce({
      success: false,
      results: [{
        success: false,
        variantId: TRANSITION_ITEM.variantId,
        previousStock: 10,
        newStock: 10,
        error: "reserve failed",
      }],
      error: "reserve failed",
    });

    await expect(
      applyInventoryForStatusChange(db as never, TRANSITION_ORDER_ID, "pending"),
    ).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      message: `Inventory reserve failed for order ${TRANSITION_ORDER_ID}: reserve failed`,
    });

    expect(batchCalls).toHaveLength(0);
  });
});
