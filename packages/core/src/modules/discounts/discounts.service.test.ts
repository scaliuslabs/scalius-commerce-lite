import { describe, expect, it, vi } from "vitest";

import { DiscountType, DiscountValueType } from "@scalius/database/schema";
import { ConflictError, ForbiddenError } from "@scalius/core/errors";
import {
  bulkDeleteDiscounts,
  createDiscount,
  deleteDiscount,
  permanentlyDeleteDiscount,
  restoreDiscounts,
  setDiscountActiveStatus,
  updateDiscount,
} from "./discounts.service";

const activeDiscount = {
  id: "disc_1",
  code: "WELCOME10",
  type: DiscountType.AMOUNT_OFF_ORDER,
  valueType: DiscountValueType.PERCENTAGE,
  discountValue: 10,
  minPurchaseAmount: null,
  minQuantity: null,
  maxUsesPerOrder: 1,
  maxUses: null,
  limitOnePerCustomer: false,
  combineWithProductDiscounts: false,
  combineWithOrderDiscounts: false,
  combineWithShippingDiscounts: false,
  customerSegment: null,
  startDate: new Date("2026-01-01T00:00:00.000Z"),
  endDate: null,
  isActive: true,
};

describe("discount lifecycle authority", () => {
  it("requires toggle authority to create an active discount", async () => {
    await expect(
      createDiscount({} as never, activeDiscount),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("does not let ordinary edit permission activate a discount", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn(async () => ({ id: "disc_1", isActive: false })),
          })),
        })),
      })),
      batch: vi.fn(),
    };

    await expect(
      updateDiscount(db as never, "disc_1", activeDiscount),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("chunks association inserts below the D1 parameter ceiling", async () => {
    const insertedValueCounts: number[] = [];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ get: vi.fn(async () => null) })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((values: unknown | unknown[]) => {
          insertedValueCounts.push(Array.isArray(values) ? values.length : 1);
          return { kind: "insert" };
        }),
      })),
      batch: vi.fn(async () => undefined),
    };

    await createDiscount(db as never, {
      ...activeDiscount,
      isActive: false,
      type: DiscountType.AMOUNT_OFF_PRODUCTS,
      appliesToProducts: Array.from({ length: 45 }, (_, index) => `prod_${index}`),
    });

    expect(insertedValueCounts).toEqual([1, 20, 20, 5]);
  });

  it("keeps activation status aligned with the inclusive end second", async () => {
    vi.useFakeTimers();
    try {
      const endDate = new Date(1_800_000_000_000);
      vi.setSystemTime(new Date(1_800_000_000_500));
      const activeBoundary = createLifecycleDb([{ id: "disc_1", endDate }]);
      await expect(setDiscountActiveStatus(activeBoundary.db, "disc_1", true))
        .resolves.toEqual({ id: "disc_1", isActive: true });

      vi.setSystemTime(new Date(1_800_000_001_000));
      const expired = createLifecycleDb([{ id: "disc_1", endDate }]);
      await expect(setDiscountActiveStatus(expired.db, "disc_1", true))
        .rejects.toThrow(/Expired discounts cannot be activated/u);
    } finally {
      vi.useRealTimers();
    }
  });
});

function createLifecycleDb(selectResults: unknown[] = []) {
  const updateSets: Array<Record<string, unknown>> = [];
  const deleteWhere = vi.fn(async () => undefined);
  const db = {
    select: vi.fn(() => {
      const result = selectResults.shift();
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(() => chain);
      chain.get = vi.fn(async () => result);
      return chain;
    }),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateSets.push(values);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
    delete: vi.fn(() => ({ where: deleteWhere })),
  };
  return { db: db as never, updateSets, deleteWhere };
}

describe("discount destructive lifecycle", () => {
  it("deactivates discounts when moving them to trash", async () => {
    const { db, updateSets } = createLifecycleDb();
    await deleteDiscount(db, "disc_1");
    expect(updateSets[0]).toMatchObject({ isActive: false });
    expect(updateSets[0]?.deletedAt).toBeDefined();
  });

  it("restores discounts as inactive drafts", async () => {
    const { db, updateSets } = createLifecycleDb();
    await restoreDiscounts(db, ["disc_1"]);
    expect(updateSets[0]).toMatchObject({ isActive: false, deletedAt: null });
  });

  it("blocks permanent deletion when order usage history exists", async () => {
    const { db, deleteWhere } = createLifecycleDb([
      { id: "disc_1", deletedAt: new Date("2026-01-01T00:00:00.000Z") },
      { id: "usage_1" },
    ]);

    await expect(permanentlyDeleteDiscount(db, "disc_1"))
      .rejects.toBeInstanceOf(ConflictError);
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it("requires bulk permanent deletes to target trash", async () => {
    const { db, deleteWhere } = createLifecycleDb([{ id: "disc_active" }]);
    await expect(bulkDeleteDiscounts(db, ["disc_active"], true))
      .rejects.toThrow(/Move discounts to trash/);
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it("bounds bulk mutations below the D1 parameter ceiling", async () => {
    const { db } = createLifecycleDb();
    await expect(bulkDeleteDiscounts(
      db,
      Array.from({ length: 91 }, (_, index) => `disc_${index}`),
    )).rejects.toThrow(/maximum of 90/);
  });
});
