import { describe, expect, it } from "vitest";

import type { DiscountItem } from "../data-table/columns/discount-columns";
import {
  getDiscountLifecycle,
  getDiscountOutcome,
  getDiscountRequirement,
  getDiscountTypeLabel,
  getDiscountValueLabel,
} from "./discount-list-model";

function discount(overrides: Partial<DiscountItem> = {}): DiscountItem {
  return {
    id: "disc_1",
    code: "WELCOME10",
    type: "amount_off_products",
    valueType: "percentage",
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
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: null,
    isActive: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    deletedAt: null,
    relatedProducts: { buy: [], get: ["prod_1", "prod_2"] },
    relatedCollections: { buy: [], get: ["col_1"] },
    ...overrides,
  };
}

describe("discount list presentation", () => {
  it("describes the customer outcome and scope without implying unsupported stacking", () => {
    expect(getDiscountOutcome(discount(), "৳")).toBe(
      "10% off 2 products and 1 collection",
    );
    expect(
      getDiscountOutcome(
        discount({ type: "amount_off_order", valueType: "fixed_amount", discountValue: 500 }),
        "৳",
      ),
    ).toBe("৳500.00 off the merchandise subtotal");
    expect(getDiscountOutcome(discount({ type: "free_shipping", valueType: "free" }), "৳")).toBe(
      "Free delivery for eligible orders",
    );
  });

  it("derives lifecycle in the same order merchants need to diagnose it", () => {
    const now = new Date("2026-07-13T12:00:00.000Z");

    expect(getDiscountLifecycle(discount(), now)).toBe("active");
    expect(getDiscountLifecycle(discount({ isActive: false }), now)).toBe("inactive");
    expect(
      getDiscountLifecycle(discount({ startDate: "2026-07-14T00:00:00.000Z" }), now),
    ).toBe("scheduled");
    expect(
      getDiscountLifecycle(discount({ endDate: "2026-07-12T00:00:00.000Z" }), now),
    ).toBe("expired");
    expect(
      getDiscountLifecycle(
        discount({ deletedAt: "2026-07-10T00:00:00.000Z", endDate: "2026-07-12T00:00:00.000Z" }),
        now,
      ),
    ).toBe("deleted");
  });

  it("keeps labels and requirements concise and truthful", () => {
    expect(getDiscountTypeLabel("amount_off_products")).toBe("Amount off products");
    expect(getDiscountValueLabel(discount(), "৳")).toBe("10% off");
    expect(getDiscountRequirement(discount(), "৳")).toBe("No minimum");
    expect(getDiscountRequirement(discount({ minPurchaseAmount: 1500 }), "৳")).toBe(
      "Minimum ৳1,500.00",
    );
    expect(getDiscountRequirement(discount({ minQuantity: 3 }), "৳")).toBe("Minimum 3 items");
  });
});
