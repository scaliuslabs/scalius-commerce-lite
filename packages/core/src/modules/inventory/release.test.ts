import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { inventoryMovements, productVariants } from "@scalius/database/schema";
import { releaseReservedStockBatch } from "./release";

const alertMocks = vi.hoisted(() => ({
  checkAndAlertLowStock: vi.fn(async () => undefined),
}));

vi.mock("./alerts", () => ({
  checkAndAlertLowStock: alertMocks.checkAndAlertLowStock,
}));

type ReleaseStats = {
  reservedQuantity: number;
  releasedQuantity: number;
  reservationGenerations: number;
};

async function createExpectedReleaseId(input: {
  releaseKey: string;
  orderId: string;
  variantId: string;
  pool: "regular" | "preorder" | "backorder";
  generation: number;
}): Promise<string> {
  const payload = [
    input.releaseKey,
    input.orderId,
    input.variantId,
    input.pool,
    String(input.generation),
  ].join("\0");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `release:${hex}`;
}

function createReleaseBatchDb(options: {
  stats?: ReleaseStats[];
  batchError?: Error;
  existingMovements?: Array<{
    id: string;
    variantId: string;
    orderId: string | null;
    type: string;
    quantity: number;
  }>;
  insertResults?: Array<Array<{ id: string }>>;
  updateResults?: Array<Array<{ id: string }>>;
} = {}) {
  const batchCalls: unknown[][] = [];
  const statsQueue = [...(options.stats ?? [{
    reservedQuantity: 2,
    releasedQuantity: 0,
    reservationGenerations: 1,
  }])];
  const insertResults = [...(options.insertResults ?? [])];
  const updateResults = [...(options.updateResults ?? [])];

  const db = {
    select(projection: Record<string, unknown>) {
      return {
        from() {
          return {
            where() {
              return {
                all: async () => {
                  if ("stockVersion" in projection) {
                    return [{
                      id: "var_a",
                      stock: 10,
                      reservedStock: 2,
                      preorderStock: 0,
                      trackInventory: true,
                      stockVersion: 4,
                    }];
                  }
                  return options.existingMovements ?? [];
                },
                get: async () => {
                  if ("reservedQuantity" in projection) {
                    return statsQueue.shift() ?? statsQueue.at(-1) ?? {
                      reservedQuantity: 2,
                      releasedQuantity: 0,
                      reservationGenerations: 1,
                    };
                  }
                  return null;
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        select(statement: unknown) {
          return {
            returning() {
              return { kind: "insertMovement" as const, table, statement };
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              return {
                returning() {
                  return { kind: "updateVariant" as const, table, values };
                },
              };
            },
          };
        },
      };
    },
    delete(table: unknown) {
      return {
        where() {
          return { kind: "deleteMovement" as const, table };
        },
      };
    },
    batch: async (statements: Array<{ kind?: string; table?: unknown }>) => {
      batchCalls.push(statements);
      if (options.batchError) throw options.batchError;
      return statements.map((statement) => {
        if (statement.kind === "insertMovement") {
          return insertResults.shift() ?? [{ id: "release_1" }];
        }
        if (statement.kind === "updateVariant") {
          return updateResults.shift() ?? [{ id: "var_a" }];
        }
        return [];
      });
    },
  };

  return { db: db as unknown as Database, batchCalls };
}

describe("releaseReservedStockBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the release movement claim and stock counter update in one batch", async () => {
    const { db, batchCalls } = createReleaseBatchDb();

    const result = await releaseReservedStockBatch(
      db,
      [{ variantId: "var_a", quantity: 2, pool: "regular" }],
      "order_1",
      { releaseKey: "checkout-rollback:v1" },
    );

    expect(result.success).toBe(true);
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toEqual([
      expect.objectContaining({ kind: "insertMovement", table: inventoryMovements }),
      expect.objectContaining({ kind: "updateVariant", table: productVariants }),
    ]);
    expect(alertMocks.checkAndAlertLowStock).toHaveBeenCalledWith(db, "var_a");
  });

  it("treats an exact duplicate deterministic release claim as idempotent success", async () => {
    const movementId = await createExpectedReleaseId({
      releaseKey: "checkout-rollback:v1",
      orderId: "order_1",
      variantId: "var_a",
      pool: "regular",
      generation: 1,
    });
    const { db, batchCalls } = createReleaseBatchDb({
      stats: [
        { reservedQuantity: 2, releasedQuantity: 0, reservationGenerations: 1 },
        { reservedQuantity: 2, releasedQuantity: 2, reservationGenerations: 1 },
      ],
      batchError: new Error("D1_ERROR: UNIQUE constraint failed: inventory_movements.id release:claim_1"),
      existingMovements: [{
        id: movementId,
        variantId: "var_a",
        orderId: "order_1",
        type: "released",
        quantity: -2,
      }],
    });

    const result = await releaseReservedStockBatch(
      db,
      [{ variantId: "var_a", quantity: 2, pool: "regular" }],
      "order_1",
      { releaseKey: "checkout-rollback:v1" },
    );

    expect(result.success).toBe(true);
    expect(batchCalls).toHaveLength(1);
  });

  it("does not decrement stock again when the reservation is already fully released", async () => {
    const { db, batchCalls } = createReleaseBatchDb({
      stats: [{ reservedQuantity: 2, releasedQuantity: 2, reservationGenerations: 1 }],
    });

    const result = await releaseReservedStockBatch(
      db,
      [{ variantId: "var_a", quantity: 2, pool: "regular" }],
      "order_1",
      { releaseKey: "checkout-rollback:v1" },
    );

    expect(result.success).toBe(true);
    expect(batchCalls).toHaveLength(0);
    expect(alertMocks.checkAndAlertLowStock).not.toHaveBeenCalled();
  });

  it("fails closed when a duplicate deterministic release claim has different contents", async () => {
    const movementId = await createExpectedReleaseId({
      releaseKey: "checkout-rollback:v1",
      orderId: "order_1",
      variantId: "var_a",
      pool: "regular",
      generation: 1,
    });
    const { db } = createReleaseBatchDb({
      batchError: new Error("D1_ERROR: UNIQUE constraint failed: inventory_movements.id release:claim_1"),
      existingMovements: [{
        id: movementId,
        variantId: "var_a",
        orderId: "order_1",
        type: "released",
        quantity: -1,
      }],
    });

    const result = await releaseReservedStockBatch(
      db,
      [{ variantId: "var_a", quantity: 2, pool: "regular" }],
      "order_1",
      { releaseKey: "checkout-rollback:v1" },
    );

    expect(result).toMatchObject({
      success: false,
      manualReconciliationRequired: true,
      error: "Reservation release batch failed",
    });
  });

  it("fails closed when there is no reservation movement to release", async () => {
    const { db, batchCalls } = createReleaseBatchDb({
      stats: [{ reservedQuantity: 0, releasedQuantity: 0, reservationGenerations: 0 }],
    });

    const result = await releaseReservedStockBatch(
      db,
      [{ variantId: "var_a", quantity: 2, pool: "regular" }],
      "order_1",
      { releaseKey: "checkout-rollback:v1" },
    );

    expect(result).toMatchObject({
      success: false,
      manualReconciliationRequired: true,
      error: "No reservation movement found for order order_1 and variant var_a",
    });
    expect(batchCalls).toHaveLength(0);
  });
});
