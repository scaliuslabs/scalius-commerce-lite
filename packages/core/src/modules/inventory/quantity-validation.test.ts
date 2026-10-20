import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { prepareReservedStockReleaseBatch } from "./release";
import { reserveStockBatch } from "./reserve";

const invalidQuantities = [
  ["zero", 0],
  ["negative", -1],
  ["fractional", 1.5],
  ["NaN", Number.NaN],
  ["infinite", Number.POSITIVE_INFINITY],
] as const;

type QuantityMutation = (db: Database, quantity: number) => Promise<unknown>;

const quantityMutations: Array<[string, QuantityMutation]> = [
  ["reserveStockBatch", (db, quantity) => reserveStockBatch(db, [{ variantId: "variant_1", quantity }], "regular", { salesChannelId: "sc_online_store" })],
  [
    "prepareReservedStockReleaseBatch",
    (db, quantity) => prepareReservedStockReleaseBatch(
      db,
      [{ variantId: "variant_1", quantity }],
      "order_1",
    ),
  ],
];

describe("inventory mutation quantity validation", () => {
  for (const [operationName, mutate] of quantityMutations) {
    describe(operationName, () => {
      it.each(invalidQuantities)("rejects %s quantities before reading or writing", async (_label, quantity) => {
        const select = vi.fn();
        const db = { select } as unknown as Database;

        await expect(mutate(db, quantity)).rejects.toThrow(/quantity must/);
        expect(select).not.toHaveBeenCalled();
      });
    });
  }

  it.each([
    [
      "reserveStockBatch",
      (db: Database) => reserveStockBatch(db, [
        { variantId: "variant_1", quantity: 1 },
        { variantId: "variant_2", quantity: 0 },
      ], "regular", { salesChannelId: "sc_online_store" }),
    ],
    [
      "prepareReservedStockReleaseBatch",
      (db: Database) => prepareReservedStockReleaseBatch(db, [
        { variantId: "variant_1", quantity: 1 },
        { variantId: "variant_2", quantity: 0 },
      ], "order_1"),
    ],
  ] satisfies Array<[string, (db: Database) => Promise<unknown>]>) (
    "%s validates the entire batch before its first database read",
    async (_operationName, mutate) => {
      const select = vi.fn();
      const db = { select } as unknown as Database;

      await expect(mutate(db)).rejects.toThrow(/quantity must/);
      expect(select).not.toHaveBeenCalled();
    },
  );
});
