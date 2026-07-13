import { describe, expect, it } from "vitest";

import {
  buildDiscountRuleSummary,
  createDiscountEditorDefaults,
  discountEditorSchema,
  fromDateInputValue,
  parseOptionalNumber,
  toDateInputValue,
  toDiscountWritePayload,
} from "./discount-editor-model";

describe("discount editor model", () => {
  it("keeps new and duplicated rules draft-first", () => {
    expect(createDiscountEditorDefaults("amount_off_order").isActive).toBe(false);
    expect(
      createDiscountEditorDefaults("free_shipping", {
        valueType: "percentage",
        discountValue: 100,
      }),
    ).toMatchObject({ valueType: "free", discountValue: 1, isActive: false });
  });

  it("requires explicit scope for product discounts and forbids invalid value semantics", () => {
    const targetless = createDiscountEditorDefaults("amount_off_products", {
      code: "PRODUCT10",
    });
    expect(discountEditorSchema.safeParse(targetless).success).toBe(false);

    expect(
      discountEditorSchema.safeParse({
        ...createDiscountEditorDefaults("amount_off_order", { code: "ORDER10" }),
        valueType: "percentage",
        discountValue: 101,
      }).success,
    ).toBe(false);
  });

  it("serializes one truthful code rule and clears unsupported capability flags", () => {
    const values = createDiscountEditorDefaults("amount_off_products", {
      code: "  product-10 ",
      appliesToProducts: ["prod_1"],
      minPurchaseAmount: 500,
      minQuantity: 2,
      maxUses: 100,
      limitOnePerCustomer: true,
      startDate: new Date(2026, 6, 13, 14, 0),
      endDate: new Date(2026, 6, 13, 14, 0),
    });
    const payload = toDiscountWritePayload(values);

    expect(payload).toMatchObject({
      code: "PRODUCT-10",
      maxUsesPerOrder: 1,
      combineWithProductDiscounts: false,
      combineWithOrderDiscounts: false,
      combineWithShippingDiscounts: false,
      customerSegment: null,
      appliesToProducts: ["prod_1"],
      minPurchaseAmount: 500,
      minQuantity: 2,
    });
    expect(payload.startDate.getHours()).toBe(0);
    expect(payload.endDate?.getHours()).toBe(23);
  });

  it("parses native date and optional number controls without UTC day drift", () => {
    const date = fromDateInputValue("2026-07-13");
    expect(date).not.toBeNull();
    expect(toDateInputValue(date)).toBe("2026-07-13");
    expect(fromDateInputValue("2026-02-31")).toBeNull();
    expect(parseOptionalNumber("")).toBeNull();
    expect(parseOptionalNumber("12.5")).toBe(12.5);
    expect(parseOptionalNumber("3", true)).toBe(3);
    expect(parseOptionalNumber("1.5", true)).toBeNaN();
  });

  it("describes the buyer outcome rather than implementation fields", () => {
    expect(
      buildDiscountRuleSummary(
        createDiscountEditorDefaults("amount_off_order", {
          code: "WELCOME10",
          valueType: "percentage",
          discountValue: 10,
        }),
        "৳",
      ),
    ).toBe("10% off the merchandise subtotal.");

    expect(
      buildDiscountRuleSummary(
        createDiscountEditorDefaults("amount_off_products", {
          code: "PICKED",
          valueType: "fixed_amount",
          discountValue: 250,
          appliesToProducts: ["prod_1", "prod_2"],
          appliesToCollections: ["collection_1"],
        }),
        "৳",
      ),
    ).toBe("৳250.00 off 2 products and 1 collection.");

    expect(
      buildDiscountRuleSummary(
        createDiscountEditorDefaults("free_shipping", { code: "DELIVERY" }),
        "৳",
      ),
    ).toBe("Free delivery for eligible orders.");
  });
});
