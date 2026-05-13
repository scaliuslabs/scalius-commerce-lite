import { describe, expect, it } from "vitest";
import { parseDiscountInput } from "../../../apps/storefront/src/lib/checkout/create-order";

describe("parseDiscountInput", () => {
  it("extracts the real code and amount from the hidden cart JSON", () => {
    expect(
      parseDiscountInput({
        discountCodeHidden: JSON.stringify({
          id: "disc_1",
          code: "SAVE10",
          type: "amount_off_order",
          amount: 120,
        }),
        discountAmount: "999",
      }),
    ).toEqual({ code: "SAVE10", amount: 120 });
  });

  it("falls back to direct discount code fields for non-cart callers", () => {
    expect(
      parseDiscountInput({
        discountCode: "save10",
        discountAmount: "75",
      }),
    ).toEqual({ code: "save10", amount: 75 });
  });

  it("treats legacy plain hidden values as codes", () => {
    expect(
      parseDiscountInput({
        discountCodeHidden: "SAVE10",
        discountAmount: "75",
      }),
    ).toEqual({ code: "SAVE10", amount: 75 });
  });
});
