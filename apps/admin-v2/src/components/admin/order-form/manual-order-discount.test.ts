import { describe, expect, it } from "vitest";

import {
  calculateManualOrderDiscountLimit,
  manualOrderDiscountExceedsLimit,
  resolveManualOrderDiscountGuidance,
} from "./manual-order-discount";

describe("manual-order discount guidance", () => {
  it("matches the staged items-plus-shipping boundary", () => {
    expect(calculateManualOrderDiscountLimit(
      [
        { productId: "prod_1", variantId: "var_1", quantity: 2, price: 100 },
        { productId: "prod_2", variantId: "var_2", quantity: 1, price: 49.99 },
      ],
      60,
      309.99,
      2,
    )).toEqual({ maximumAmount: 309.99, exceeded: false });

    expect(calculateManualOrderDiscountLimit(
      [{ productId: "prod_1", variantId: "var_1", quantity: 2, price: 100 }],
      60,
      260.01,
      2,
    )).toEqual({ maximumAmount: 260, exceeded: true });
  });

  it("uses the active currency precision before comparing", () => {
    expect(calculateManualOrderDiscountLimit(
      [{ productId: "prod_1", variantId: "var_1", quantity: 2, price: 100.49 }],
      1.6,
      202,
      0,
    )).toEqual({ maximumAmount: 202, exceeded: false });

    expect(calculateManualOrderDiscountLimit(
      [{ productId: "prod_1", variantId: "var_1", quantity: 2, price: 1.2346 }],
      0.0016,
      2.473,
      3,
    )).toEqual({ maximumAmount: 2.472, exceeded: true });
  });

  it("compares an authoritative server boundary at its currency precision", () => {
    expect(manualOrderDiscountExceedsLimit(260.004, 260, 2)).toBe(false);
    expect(manualOrderDiscountExceedsLimit(260.006, 260, 2)).toBe(true);
  });

  it("provides a zero boundary before items are staged and fails closed on bad inputs", () => {
    expect(calculateManualOrderDiscountLimit([], 0, 1, 2)).toEqual({
      maximumAmount: 0,
      exceeded: true,
    });
    expect(calculateManualOrderDiscountLimit(
      [{ productId: "prod_1", variantId: "var_1", quantity: 0, price: 100 }],
      0,
      0,
      2,
    )).toBeNull();
  });

  it("prefers an error boundary, then a successful quote, over local guidance", () => {
    const common = {
      discountAmount: 120,
      localLimit: { maximumAmount: 100, exceeded: true },
      localCurrencyCode: "BDT",
      localDecimalPlaces: 2,
    };
    expect(resolveManualOrderDiscountGuidance({
      ...common,
      authoritativeErrorLimit: null,
      successfulQuote: {
        subtotalAmount: 100,
        shippingAmount: 30,
        currencyCode: "BDT",
        decimalPlaces: 2,
      },
    })).toEqual({
      maximumAmount: 130,
      exceeded: false,
      source: "server",
      currencyCode: "BDT",
      decimalPlaces: 2,
    });
    expect(resolveManualOrderDiscountGuidance({
      ...common,
      discountAmount: 0.3,
      authoritativeErrorLimit: null,
      successfulQuote: {
        subtotalAmount: 0.1,
        shippingAmount: 0.2,
        currencyCode: "BDT",
        decimalPlaces: 2,
      },
    })?.maximumAmount).toBe(0.3);
    expect(resolveManualOrderDiscountGuidance({
      ...common,
      authoritativeErrorLimit: {
        maximumAmount: 90,
        currencyCode: "BDT",
        decimalPlaces: 2,
      },
      successfulQuote: null,
    })).toEqual({
      maximumAmount: 90,
      exceeded: true,
      source: "server",
      currencyCode: "BDT",
      decimalPlaces: 2,
    });
  });
});
