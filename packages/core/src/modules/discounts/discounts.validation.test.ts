import { describe, expect, it } from "vitest";

import { DiscountType, DiscountValueType } from "@scalius/database/schema";
import { createDiscountSchema } from "./discounts.validation";

describe("discount validation", () => {
  it("creates discounts as inactive drafts by default", () => {
    const parsed = createDiscountSchema.parse({
      code: "WELCOME10",
      type: DiscountType.AMOUNT_OFF_ORDER,
      valueType: DiscountValueType.PERCENTAGE,
      discountValue: 10,
      startDate: "2026-01-01T00:00:00.000Z",
    });

    expect(parsed.isActive).toBe(false);
  });

  it("normalizes safe codes and rejects ambiguous code characters", () => {
    const parsed = createDiscountSchema.parse({
      code: "  welcome-10  ",
      type: DiscountType.AMOUNT_OFF_ORDER,
      valueType: DiscountValueType.PERCENTAGE,
      discountValue: 10,
      startDate: "2026-01-01T00:00:00.000Z",
    });

    expect(parsed.code).toBe("WELCOME-10");
    expect(() => createDiscountSchema.parse({
      ...parsed,
      code: "WELCOME 10",
    })).toThrow(/letters, numbers, underscores, and hyphens/);
  });

  it.each([
    ["invalid start date", { startDate: "not-a-date" }],
    ["end before start", { endDate: "2025-12-31T23:59:59.000Z" }],
    ["equal end and start", { endDate: "2026-01-01T00:00:00.000Z" }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => createDiscountSchema.parse({
      code: "WELCOME10",
      type: DiscountType.AMOUNT_OFF_ORDER,
      valueType: DiscountValueType.PERCENTAGE,
      discountValue: 10,
      startDate: "2026-01-01T00:00:00.000Z",
      ...overrides,
    })).toThrow();
  });

  it("requires value semantics that match the discount type", () => {
    expect(() => createDiscountSchema.parse({
      code: "FREESHIP",
      type: DiscountType.FREE_SHIPPING,
      valueType: DiscountValueType.PERCENTAGE,
      discountValue: 100,
      startDate: "2026-01-01T00:00:00.000Z",
    })).toThrow(/free value type/);

    expect(() => createDiscountSchema.parse({
      code: "FREEORDER",
      type: DiscountType.AMOUNT_OFF_ORDER,
      valueType: DiscountValueType.FREE,
      discountValue: 100,
      startDate: "2026-01-01T00:00:00.000Z",
    })).toThrow(/percentage or fixed amount/);
  });

  it("rejects controls that checkout does not enforce", () => {
    expect(() => createDiscountSchema.parse({
      code: "STACKED",
      type: DiscountType.AMOUNT_OFF_ORDER,
      valueType: DiscountValueType.PERCENTAGE,
      discountValue: 10,
      startDate: "2026-01-01T00:00:00.000Z",
      combineWithProductDiscounts: true,
    })).toThrow(/one code per order/);

    expect(() => createDiscountSchema.parse({
      code: "SEGMENT",
      type: DiscountType.AMOUNT_OFF_ORDER,
      valueType: DiscountValueType.PERCENTAGE,
      discountValue: 10,
      startDate: "2026-01-01T00:00:00.000Z",
      customerSegment: "vip",
    })).toThrow(/not supported yet/);

    expect(() => createDiscountSchema.parse({
      code: "MULTIUSE",
      type: DiscountType.AMOUNT_OFF_ORDER,
      valueType: DiscountValueType.PERCENTAGE,
      discountValue: 10,
      startDate: "2026-01-01T00:00:00.000Z",
      maxUsesPerOrder: 2,
    })).toThrow(/one discount code/);
  });

  it("deduplicates and bounds product and collection scope", () => {
    const parsed = createDiscountSchema.parse({
      code: "TARGETED",
      type: DiscountType.AMOUNT_OFF_PRODUCTS,
      valueType: DiscountValueType.FIXED_AMOUNT,
      discountValue: 50,
      startDate: "2026-01-01T00:00:00.000Z",
      appliesToProducts: ["product_1", " product_1 ", "product_2"],
    });
    expect(parsed.appliesToProducts).toEqual(["product_1", "product_2"]);

    expect(() => createDiscountSchema.parse({
      ...parsed,
      appliesToProducts: Array.from({ length: 90 }, (_, index) => `product_${index}`),
      appliesToCollections: ["collection_1"],
    })).toThrow(/at most 90/);
  });
});
