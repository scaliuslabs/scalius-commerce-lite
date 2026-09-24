import { describe, expect, it } from "vitest";
import type { OrderReceiptDiscount } from "@/lib/api/types";
import { summarizeOrderDiscounts } from "./order-discount-summary";

const discount = (overrides: Partial<OrderReceiptDiscount>): OrderReceiptDiscount => ({
  promotionId: "promo", title: "Promo", code: null, kind: "order", amount: 0, shippingAmount: 0, ...overrides,
});

describe("order discount summary", () => {
  it("names each code on its own line and puts the delivery saving on the delivery line", () => {
    const summary = summarizeOrderDiscounts({
      discounts: [
        discount({ title: "R2SJPROD", code: "R2SJPROD", kind: "product", amount: 200 }),
        discount({ title: "Eid sale", code: "R2SJORD10", amount: 230 }),
        discount({ title: "Free delivery", code: "R2SJSHIP", kind: "shipping", shippingAmount: 80 }),
      ],
      shipping: 80,
      deliveryFee: 80,
      discount: 510,
      discountText: "Discount",
    });

    expect(summary.lines).toEqual([
      { label: "Discount · R2SJPROD", amount: 200 },
      { label: "Discount · Eid sale (R2SJORD10)", amount: 230 },
    ]);
    expect(summary.delivery).toEqual({ fee: 80, charged: 0, codes: "R2SJSHIP" });
  });

  it("keeps a partly discounted delivery charge and an automatic discount's title", () => {
    const summary = summarizeOrderDiscounts({
      discounts: [discount({ title: "Half-price delivery", kind: "shipping", shippingAmount: 40 })],
      shipping: 80,
      discount: 40,
      discountText: "ছাড়",
    });

    expect(summary.lines).toEqual([]);
    expect(summary.delivery).toEqual({ fee: 80, charged: 40, codes: "Half-price delivery" });
  });

  it("shows a discount without allocations as one plain line holding the rest", () => {
    expect(summarizeOrderDiscounts({ discounts: [], shipping: 60, discount: 150, discountText: "Discount" }).lines)
      .toEqual([{ label: "Discount", amount: 150 }]);
    expect(summarizeOrderDiscounts({
      discounts: [discount({ title: "Eid", code: "EID10", amount: 100.1 })],
      shipping: 0,
      discount: 150.3,
      discountText: "Discount",
    }).lines).toEqual([{ label: "Discount · Eid (EID10)", amount: 100.1 }, { label: "Discount", amount: 50.2 }]);
  });

  it("strikes through a waived fee: the method's fee stands, nothing is charged", () => {
    const summary = summarizeOrderDiscounts({ discounts: undefined, shipping: 0, deliveryFee: 80, discount: 0, discountText: "Discount" });
    expect(summary).toEqual({ delivery: { fee: 80, charged: 0, codes: "" }, lines: [] });
  });
});
