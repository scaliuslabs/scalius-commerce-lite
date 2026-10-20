import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { inventoryMovements, productVariants } from "@scalius/database/schema";
import { prepareReservedStockReleaseBatch } from "./release";

// The fake databases here carry no projection SQL; catalog-projections.d1.test.ts covers it.
vi.mock("../products/catalog-projections", () => ({ catalogBuyerStateRefreshStatementsForSkus: () => [] }));

type ReleaseStats = {
  reservedQuantity: number;
  releasedQuantity: number;
  reservationGenerations: number;
};

/** The ledger v2 rows that stand for a reservation of `reservedQuantity` units, `releasedQuantity` of them released. */
function ledgerRows(stats: ReleaseStats) {
  const rows: Array<Record<string, unknown>> = [];
  let reserved = 0;
  let version = 1;
  const edge = (type: string, delta: number) => {
    rows.push({
      id: `${type}_${version}`, variantId: "var_a", orderId: "order_1", type, ledgerVersion: 2, pool: "regular",
      reservationGeneration: Math.max(1, stats.reservationGenerations),
      stockVersionBefore: version, stockVersionAfter: version + 1,
      previousStock: 10, newStock: 10, stockDelta: 0,
      previousReservedStock: reserved, newReservedStock: reserved + delta, reservedStockDelta: delta,
      previousPreorderStock: 0, newPreorderStock: 0, preorderStockDelta: 0,
    });
    reserved += delta;
    version += 1;
  };
  if (stats.reservedQuantity > 0) edge("reserved", stats.reservedQuantity);
  if (stats.releasedQuantity > 0) edge("released", -stats.releasedQuantity);
  return rows;
}

function createReleaseBatchDb(stats: ReleaseStats = {
  reservedQuantity: 2,
  releasedQuantity: 0,
  reservationGenerations: 1,
}) {
  const db = {
    select(projection: Record<string, unknown>) {
      return {
        from() {
          return {
            where() {
              return {
                all: async () => {
                  if ("ledgerVersion" in projection) return ledgerRows(stats);
                  return [{
                    id: "var_a",
                    stock: 10,
                    reservedStock: 2,
                    preorderStock: 0,
                    trackInventory: true,
                    stockVersion: 4,
                  }];
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return { select: (statement: unknown) => ({ returning: () => ({ kind: "insertMovement" as const, table, statement }) }) };
    },
    update(table: unknown) {
      return { set: (values: Record<string, unknown>) => ({ where: () => ({ returning: () => ({ kind: "updateVariant" as const, table, values }) }) }) };
    },
  };
  return db as unknown as Database;
}

describe("prepareReservedStockReleaseBatch", () => {
  it("rejects two pools for the same SKU because one CAS edge can have only one ledger event", async () => {
    const result = await prepareReservedStockReleaseBatch(
      createReleaseBatchDb(),
      [
        { variantId: "var_a", quantity: 1, pool: "regular" },
        { variantId: "var_a", quantity: 1, pool: "preorder" },
      ],
      "order_1",
    );

    expect(result).toMatchObject({
      success: false,
      manualReconciliationRequired: true,
      error: expect.stringContaining("multiple inventory pools"),
      statements: [],
    });
  });

  it("prepares the release movement claim, its counter update and their guard together", async () => {
    const result = await prepareReservedStockReleaseBatch(
      createReleaseBatchDb(),
      [{ variantId: "var_a", quantity: 2, pool: "regular" }],
      "order_1",
    );

    expect(result.success).toBe(true);
    expect(result.statements.slice(0, 2)).toEqual([
      expect.objectContaining({ kind: "insertMovement", table: inventoryMovements }),
      expect.objectContaining({ kind: "updateVariant", table: productVariants }),
    ]);
    expect(result.statements).toHaveLength(3);
  });

  it.each([
    ["there is no reservation movement", { reservedQuantity: 0, releasedQuantity: 0, reservationGenerations: 0 }],
    ["the reservation is already fully released", { reservedQuantity: 2, releasedQuantity: 2, reservationGenerations: 1 }],
  ])("fails closed with no statements when %s", async (_label, stats) => {
    const result = await prepareReservedStockReleaseBatch(
      createReleaseBatchDb(stats),
      [{ variantId: "var_a", quantity: 2, pool: "regular" }],
      "order_1",
    );

    expect(result).toMatchObject({
      success: false,
      manualReconciliationRequired: true,
      error: "Reservation evidence is insufficient for order order_1 and variant var_a",
      statements: [],
    });
  });
});
