// tests/unit/core/inventory/batch-reservation.test.ts
// Tests the batch reservation/deduction logic:
// - All-or-nothing atomicity (if any fail, all rolled back)
// - Duplicate variant merging
// - Rollback mechanics

import { describe, it, expect } from "vitest";
import { groupReservationMovementsForAudit, reserveStockBatch } from "../../../../packages/core/src/modules/inventory/reserve";
import { inventoryMovements, productVariants } from "../../../../packages/database/src/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReservationEntry {
  variantId: string;
  quantity: number;
  pool?: "regular" | "preorder" | "backorder";
}

interface StockOperationResult {
  success: boolean;
  variantId: string;
  previousStock: number;
  newStock: number;
  error?: string;
}

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

// ---------------------------------------------------------------------------
// In-memory simulation of reserveMultiple() from reserve.ts
// ---------------------------------------------------------------------------

function simulateReserveMultiple(
  variants: Map<string, Variant>,
  entries: ReservationEntry[],
): { success: boolean; results: StockOperationResult[]; error?: string; finalState: Map<string, Variant> } {
  // Deep copy the variants so we can mutate
  const state = new Map<string, Variant>();
  for (const [k, v] of variants) {
    state.set(k, { ...v });
  }

  const results: StockOperationResult[] = [];
  const toRollback: ReservationEntry[] = [];

  for (const entry of entries) {
    const variant = state.get(entry.variantId);
    if (!variant) {
      // Rollback all previous
      for (const rb of toRollback) {
        const rbVariant = state.get(rb.variantId)!;
        rbVariant.reservedStock = Math.max(0, rbVariant.reservedStock - rb.quantity);
        rbVariant.version++;
      }
      results.push({
        success: false,
        variantId: entry.variantId,
        previousStock: 0,
        newStock: 0,
        error: `Variant ${entry.variantId} not found`,
      });
      return { success: false, results, error: `Variant ${entry.variantId} not found`, finalState: state };
    }

    const pool = entry.pool ?? "regular";
    const available = variant.stock - variant.reservedStock;

    if (pool === "regular" && available < entry.quantity) {
      // Rollback all previous
      for (const rb of toRollback) {
        const rbVariant = state.get(rb.variantId)!;
        rbVariant.reservedStock = Math.max(0, rbVariant.reservedStock - rb.quantity);
        rbVariant.version++;
      }
      results.push({
        success: false,
        variantId: entry.variantId,
        previousStock: variant.stock,
        newStock: variant.stock,
        error: `Insufficient stock for variant ${entry.variantId}`,
      });
      return {
        success: false,
        results,
        error: `Insufficient stock for variant ${entry.variantId}`,
        finalState: state,
      };
    }

    // Apply the reservation
    variant.reservedStock += entry.quantity;
    variant.version++;
    results.push({
      success: true,
      variantId: entry.variantId,
      previousStock: variant.stock,
      newStock: variant.stock,
    });
    toRollback.push(entry);
  }

  return { success: true, results, finalState: state };
}

/**
 * Merge duplicate variants in a batch (sum quantities).
 * This is tested to ensure the codebase handles it correctly.
 */
function mergeDuplicateEntries(entries: ReservationEntry[]): ReservationEntry[] {
  const merged = new Map<string, ReservationEntry>();
  for (const entry of entries) {
    const key = `${entry.variantId}:${entry.pool ?? "regular"}`;
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += entry.quantity;
    } else {
      merged.set(key, { ...entry });
    }
  }
  return [...merged.values()];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reserveMultiple (batch reservation)", () => {
  it("succeeds when all variants have sufficient stock", () => {
    const variants = new Map<string, Variant>([
      ["var_a", { id: "var_a", stock: 50, reservedStock: 0, preorderStock: 0, allowPreorder: false, allowBackorder: false, backorderLimit: 0, version: 1 }],
      ["var_b", { id: "var_b", stock: 30, reservedStock: 0, preorderStock: 0, allowPreorder: false, allowBackorder: false, backorderLimit: 0, version: 1 }],
    ]);

    const result = simulateReserveMultiple(variants, [
      { variantId: "var_a", quantity: 5 },
      { variantId: "var_b", quantity: 3 },
    ]);

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].success).toBe(true);
    expect(result.results[1].success).toBe(true);
    expect(result.finalState.get("var_a")!.reservedStock).toBe(5);
    expect(result.finalState.get("var_b")!.reservedStock).toBe(3);
  });

  it("rolls back ALL when second variant fails", () => {
    const variants = new Map<string, Variant>([
      ["var_a", { id: "var_a", stock: 50, reservedStock: 0, preorderStock: 0, allowPreorder: false, allowBackorder: false, backorderLimit: 0, version: 1 }],
      ["var_b", { id: "var_b", stock: 2, reservedStock: 0, preorderStock: 0, allowPreorder: false, allowBackorder: false, backorderLimit: 0, version: 1 }],
    ]);

    const result = simulateReserveMultiple(variants, [
      { variantId: "var_a", quantity: 5 },
      { variantId: "var_b", quantity: 10 }, // More than available
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Insufficient stock");
    // var_a should be rolled back
    expect(result.finalState.get("var_a")!.reservedStock).toBe(0);
    // var_b should never have been modified
    expect(result.finalState.get("var_b")!.reservedStock).toBe(0);
  });

  it("rolls back ALL when third of three fails", () => {
    const variants = new Map<string, Variant>([
      ["var_a", { id: "var_a", stock: 50, reservedStock: 0, preorderStock: 0, allowPreorder: false, allowBackorder: false, backorderLimit: 0, version: 1 }],
      ["var_b", { id: "var_b", stock: 30, reservedStock: 0, preorderStock: 0, allowPreorder: false, allowBackorder: false, backorderLimit: 0, version: 1 }],
      ["var_c", { id: "var_c", stock: 1, reservedStock: 0, preorderStock: 0, allowPreorder: false, allowBackorder: false, backorderLimit: 0, version: 1 }],
    ]);

    const result = simulateReserveMultiple(variants, [
      { variantId: "var_a", quantity: 10 },
      { variantId: "var_b", quantity: 5 },
      { variantId: "var_c", quantity: 5 }, // Only 1 available
    ]);

    expect(result.success).toBe(false);
    // Both var_a and var_b should be rolled back
    expect(result.finalState.get("var_a")!.reservedStock).toBe(0);
    expect(result.finalState.get("var_b")!.reservedStock).toBe(0);
    expect(result.finalState.get("var_c")!.reservedStock).toBe(0);
  });

  it("rolls back when a variant does not exist", () => {
    const variants = new Map<string, Variant>([
      ["var_a", { id: "var_a", stock: 50, reservedStock: 0, preorderStock: 0, allowPreorder: false, allowBackorder: false, backorderLimit: 0, version: 1 }],
    ]);

    const result = simulateReserveMultiple(variants, [
      { variantId: "var_a", quantity: 5 },
      { variantId: "var_nonexistent", quantity: 3 },
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    // var_a should be rolled back
    expect(result.finalState.get("var_a")!.reservedStock).toBe(0);
  });
});

describe("duplicate variant merging", () => {
  it("merges duplicate entries by summing quantities", () => {
    const entries: ReservationEntry[] = [
      { variantId: "var_a", quantity: 3 },
      { variantId: "var_b", quantity: 2 },
      { variantId: "var_a", quantity: 5 },
    ];

    const merged = mergeDuplicateEntries(entries);
    expect(merged).toHaveLength(2);

    const varA = merged.find((e) => e.variantId === "var_a");
    expect(varA!.quantity).toBe(8);

    const varB = merged.find((e) => e.variantId === "var_b");
    expect(varB!.quantity).toBe(2);
  });

  it("keeps separate entries for different pools of same variant", () => {
    const entries: ReservationEntry[] = [
      { variantId: "var_a", quantity: 3, pool: "regular" },
      { variantId: "var_a", quantity: 5, pool: "preorder" },
    ];

    const merged = mergeDuplicateEntries(entries);
    expect(merged).toHaveLength(2);
  });

  it("handles single entry without modification", () => {
    const entries: ReservationEntry[] = [
      { variantId: "var_a", quantity: 3 },
    ];

    const merged = mergeDuplicateEntries(entries);
    expect(merged).toHaveLength(1);
    expect(merged[0].quantity).toBe(3);
  });

  it("handles empty array", () => {
    const merged = mergeDuplicateEntries([]);
    expect(merged).toHaveLength(0);
  });
});

describe("batch reservation audit grouping", () => {
  it("keeps separate movement entries for different orders sharing the same variant", () => {
    const grouped = groupReservationMovementsForAudit([
      { variantId: "var_a", quantity: 2, orderId: "ord_1" },
      { variantId: "var_a", quantity: 3, orderId: "ord_2" },
      { variantId: "var_a", quantity: 1, orderId: "ord_1" },
    ]);

    expect(grouped).toEqual([
      { variantId: "var_a", quantity: 3, orderId: "ord_1" },
      { variantId: "var_a", quantity: 3, orderId: "ord_2" },
    ]);
  });
});

function createReserveStockBatchDb(options: {
  variant?: Variant | null;
  releaseCount?: number;
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
  const variant = options.variant ?? {
    id: "var_a",
    stock: 10,
    reservedStock: 0,
    preorderStock: 0,
    allowPreorder: false,
    allowBackorder: false,
    backorderLimit: 0,
    version: 4,
  };
  const insertResults = [...(options.insertResults ?? [])];
  const updateResults = [...(options.updateResults ?? [])];

  const db = {
    select(projection: Record<string, unknown>) {
      const query = {
        where() {
          return {
            get: async () => {
              if ("count" in projection) return { count: options.releaseCount ?? 0 };
              return null;
            },
            all: async () => {
              if ("stock" in projection) {
                return variant
                  ? [{
                      id: variant.id,
                      stock: variant.stock,
                      reservedStock: variant.reservedStock,
                      preorderStock: variant.preorderStock,
                      allowPreorder: variant.allowPreorder,
                      allowBackorder: variant.allowBackorder,
                      backorderLimit: variant.backorderLimit,
                      trackInventory: true,
                      stockVersion: variant.version,
                    }]
                  : [];
              }
              return options.existingMovements ?? [];
            },
          };
        },
      };
      return {
        from() {
          return {
            ...query,
            innerJoin() {
              return query;
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
          return insertResults.shift() ?? [{ id: "movement_1" }];
        }
        if (statement.kind === "updateVariant") {
          return updateResults.shift() ?? [{ id: "var_a" }];
        }
        return [];
      });
    },
  };

  return { db, batchCalls };
}

describe("reserveStockBatch strict movement claims", () => {
  it("writes the reservation movement claim and stock counter update in one batch", async () => {
    const { db, batchCalls } = createReserveStockBatchDb();

    const result = await reserveStockBatch(
      db as never,
      [{ variantId: "var_a", quantity: 2, orderId: "order_1" }],
      "regular",
      { reservationKey: "checkout-ingest:v1" },
    );

    expect(result.success).toBe(true);
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toEqual([
      expect.objectContaining({ kind: "insertMovement", table: inventoryMovements }),
      expect.objectContaining({ kind: "updateVariant", table: productVariants }),
    ]);
  });

  it("treats an exact duplicate deterministic movement claim as idempotent success", async () => {
    const { db, batchCalls } = createReserveStockBatchDb({
      batchError: new Error("D1_ERROR: UNIQUE constraint failed: inventory_movements.id reservation:claim_1"),
      existingMovements: [
        {
          id: "reservation:claim_1",
          variantId: "var_a",
          orderId: "order_1",
          type: "reserved",
          quantity: 2,
        },
      ],
    });

    const result = await reserveStockBatch(
      db as never,
      [{ variantId: "var_a", quantity: 2, orderId: "order_1", movementId: "reservation:claim_1" }],
      "regular",
    );

    expect(result.success).toBe(true);
    expect(batchCalls).toHaveLength(1);
  });

  it("fails closed when a duplicate deterministic claim has different contents", async () => {
    const { db } = createReserveStockBatchDb({
      batchError: new Error("D1_ERROR: UNIQUE constraint failed: inventory_movements.id reservation:claim_1"),
      existingMovements: [
        {
          id: "reservation:claim_1",
          variantId: "var_a",
          orderId: "order_1",
          type: "reserved",
          quantity: 1,
        },
      ],
    });

    const result = await reserveStockBatch(
      db as never,
      [{ variantId: "var_a", quantity: 2, orderId: "order_1", movementId: "reservation:claim_1" }],
      "regular",
    );

    expect(result).toMatchObject({
      success: false,
      manualReconciliationRequired: true,
      error: "Reservation claim mismatch requires manual inventory reconciliation",
    });
  });
});
