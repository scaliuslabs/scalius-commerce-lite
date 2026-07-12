import { describe, expect, it, vi } from "vitest";

import { DiscountType, DiscountValueType } from "@scalius/database/schema";
import { ForbiddenError } from "@scalius/core/errors";
import { createDiscount, updateDiscount } from "./discounts.service";

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
});
