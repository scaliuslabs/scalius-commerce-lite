// Order status transitions move stock once, through one ledger-v2 claim per
// SKU batched with its stockVersion CAS (a fake db records the batches).

import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { seedVariant } from "../../../setup";
import { inventoryMovements, orders, productVariants } from "../../../../packages/database/src/schema";

// Keep the inventory batch observable without reproducing the catalog SQL builder.
// catalog-projections.d1.test.ts verifies the real refresh against migrated SQLite.
vi.mock("../../../../packages/core/src/modules/products/catalog-projections", () => ({
  catalogBuyerStateRefreshStatementsForSkus: (_db: unknown, skuIds: readonly string[]) => [
    { kind: "refreshBuyerState", skuIds },
  ],
}));

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
const TRANSITION_SALES_CHANNEL_ID = "sc_wholesale";
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
    fulfillmentLocationId: null,
    // Not the default channel, so a re-reservation provably forwards the order's own.
    salesChannelId: TRANSITION_SALES_CHANNEL_ID,
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
            // The default inventory location (migration 0102 creates it).
            if ("id" in projection && "name" in projection && Object.keys(projection).length === 2) {
              return { id: "loc_default", name: "Main location" };
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
            // Levels at the fulfilment location: enough for every line.
            if ("variantId" in projection && "onHand" in projection) {
              return (options.items ?? [TRANSITION_ITEM]).map((item) => ({ variantId: item.variantId, onHand: 1_000 }));
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
      expect.objectContaining({ kind: "refreshBuyerState", skuIds: [TRANSITION_ITEM.variantId] }),
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
      expect.objectContaining({ kind: "refreshBuyerState", skuIds: [TRANSITION_ITEM.variantId] }),
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
        [[{ id: "movement_1" }], [{ id: TRANSITION_ITEM.variantId }], []],
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
        [[{ id: "movement_1" }], [{ id: TRANSITION_ITEM.variantId }], []],
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
      { salesChannelId: TRANSITION_SALES_CHANNEL_ID },
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
