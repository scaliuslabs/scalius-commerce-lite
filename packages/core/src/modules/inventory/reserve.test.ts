import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { SQL } from "drizzle-orm";
import {
  isInventoryReservationConflictError,
  prepareStockReservationBatch,
  reserveStockBatch,
} from "./reserve";

function createReservationReadDb(rows: unknown[]): Database {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            all: vi.fn(async () => rows),
          })),
        })),
      })),
    })),
    update: vi.fn(),
    insert: vi.fn(),
  } as unknown as Database;
}

function createTrackedReservationPlanDb(row: Record<string, unknown>): {
  db: Database;
  guardExpressions: SQL[];
} {
  const guardExpressions: SQL[] = [];
  const db = {
    select: vi.fn((projection: Record<string, unknown>) => ({
      from: vi.fn(() => {
        if ("batchGuard" in projection) {
          guardExpressions.push(projection.batchGuard as SQL);
          return { kind: "guard" };
        }
        if ("ledgerVersion" in projection) {
          return { where: vi.fn(() => ({ all: vi.fn(async () => []) })) };
        }
        if ("count" in projection) {
          return { where: vi.fn(() => ({ get: vi.fn(async () => ({ count: 0 })) })) };
        }
        return {
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({ all: vi.fn(async () => [row]) })),
          })),
        };
      }),
    })),
    insert: vi.fn(() => ({
      select: vi.fn(() => ({
        returning: vi.fn(() => ({ kind: "movement" })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => ({ kind: "counter-update" })),
        })),
      })),
    })),
  } as unknown as Database;

  return { db, guardExpressions };
}

describe("reserveStockBatch sellability guard", () => {
  it("recognizes an exhausted provider MVCC conflict for outer transaction retry", () => {
    const conflict = Object.assign(new Error("write conflict"), {
      code: "SQLITE_BUSY_SNAPSHOT",
    });

    expect(isInventoryReservationConflictError(conflict)).toBe(true);
  });

  it("rejects reserving one SKU for multiple orders in a single CAS edge", async () => {
    const db = createReservationReadDb([]);

    const result = await reserveStockBatch(
      db,
      [
        { variantId: "variant_a", quantity: 1, orderId: "order_1" },
        { variantId: "variant_a", quantity: 1, orderId: "order_2" },
      ],
      "regular",
      { reservationKey: "checkout-test" },
    );

    expect(result).toMatchObject({
      success: false,
      manualReconciliationRequired: true,
      error: expect.stringContaining("multiple orders"),
    });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("fails before writing when the reservation-time variant read is not sellable", async () => {
    const db = createReservationReadDb([]);

    const result = await reserveStockBatch(
      db,
      [{ variantId: "variant_deleted", quantity: 1, orderId: "order_1" }],
      "regular",
      { reservationKey: "checkout-test" },
    );

    expect(result).toMatchObject({
      success: false,
      error: "Variant variant_deleted not found",
      results: [
        {
          success: false,
          variantId: "variant_deleted",
        },
      ],
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("loads reservation-time variant states with one batched read", async () => {
    const db = createReservationReadDb([
      {
        id: "variant_a",
        stock: 0,
        reservedStock: 0,
        preorderStock: 0,
        allowPreorder: false,
        allowBackorder: false,
        backorderLimit: 0,
        trackInventory: false,
        stockVersion: 1,
      },
      {
        id: "variant_b",
        stock: 0,
        reservedStock: 0,
        preorderStock: 0,
        allowPreorder: false,
        allowBackorder: false,
        backorderLimit: 0,
        trackInventory: false,
        stockVersion: 7,
      },
    ]);

    const result = await reserveStockBatch(
      db,
      [
        { variantId: "variant_a", quantity: 1, orderId: "order_1" },
        { variantId: "variant_b", quantity: 2, orderId: "order_1" },
      ],
      "regular",
      { reservationKey: "checkout-test" },
    );

    expect(result.success).toBe(true);
    expect(result.results.map((item) => item.variantId)).toEqual(["variant_a", "variant_b"]);
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("prepares a guarded ledger edge and CAS update without executing writes", async () => {
    const { db, guardExpressions } = createTrackedReservationPlanDb({
      id: "variant_a",
      productId: "product_a",
      slug: "product-a",
      categoryId: "category_a",
      stock: 3,
      reservedStock: 1,
      preorderStock: 0,
      allowPreorder: false,
      allowBackorder: false,
      backorderLimit: 0,
      trackInventory: true,
      stockVersion: 7,
    });

    const plan = await prepareStockReservationBatch(
      db,
      [{ variantId: "variant_a", quantity: 2, orderId: "order_1" }],
      "regular",
      { reservationKey: "checkout-test" },
    );

    expect(plan.success).toBe(true);
    expect(plan.statements).toHaveLength(3);
    expect(guardExpressions).toHaveLength(1);
    const guard = new SQLiteSyncDialect().sqlToQuery(guardExpressions[0]!);
    expect(guard.sql).toContain('"products"."id" = "product_variants"."product_id"');
    expect(guard.sql).toContain('"product_variants"."id" = ?');
    expect(guard.sql).toContain('"product_variants"."stock_version"');
    expect(guard.sql).toContain('"product_variants"."stock" - (');
    expect(guard.sql).toContain('SUM("inventory_reservation_lanes"."reserved_quantity")');
    expect(guard.sql).toContain('"inventory_reservation_lanes"."pool" = \'regular\'');
    expect(guard.params).toContain(7);
    expect(guard.params).toContain(2);
    expect(guard.params).toContain("INVENTORY_RESERVATION_CONFLICT");
    expect(plan.availabilityChangedSubjects).toEqual([{
      productId: "product_a",
      slug: "product-a",
      categoryId: "category_a",
    }]);
    expect((db as unknown as { batch?: unknown }).batch).toBeUndefined();
  });

  it("skips historical generation reads for a transactionally fresh order id", async () => {
    const { db } = createTrackedReservationPlanDb({
      id: "variant_fresh",
      productId: "product_fresh",
      slug: "product-fresh",
      categoryId: null,
      stock: 10,
      reservedStock: 0,
      preorderStock: 0,
      allowPreorder: false,
      allowBackorder: false,
      backorderLimit: 0,
      trackInventory: true,
      stockVersion: 1,
    });

    const plan = await prepareStockReservationBatch(
      db,
      [{ variantId: "variant_fresh", quantity: 1, orderId: "order_fresh" }],
      "regular",
      {
        reservationKey: "checkout-test",
        freshOrderIds: new Set(["order_fresh"]),
      },
    );

    expect(plan.success).toBe(true);
    // One variant-state read plus the composable batch guard. There are no
    // inventory-movement or legacy-release generation reads.
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});
