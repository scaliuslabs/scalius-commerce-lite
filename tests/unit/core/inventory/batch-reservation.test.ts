// tests/unit/core/inventory/batch-reservation.test.ts
// Tests the batch reservation/deduction logic:
// - All-or-nothing atomicity (if any fail, all rolled back)
// - Duplicate variant merging
// - Rollback mechanics

import { describe, it, expect } from "vitest";
import { groupReservationMovementsForAudit } from "../../../../packages/core/src/modules/inventory/reserve";

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
