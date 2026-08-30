import { describe, expect, it } from "vitest";

import {
  calculateManualOrderDiscountLimit,
  manualOrderDiscountExceedsLimit,
  resolveManualOrderDiscountGuidance,
} from "./manual-order-discount";

describe("manual-order discount guidance", () => {
  it("matches the staged item subtotal and keeps shipping outside the discount", () => {
    expect(calculateManualOrderDiscountLimit(
      [
        { productId: "prod_1", variantId: "var_1", quantity: 2, price: 100 },
        { productId: "prod_2", variantId: "var_2", quantity: 1, price: 49.99 },
      ],
      249.99,
      2,
    )).toEqual({ maximumAmount: 249.99, exceeded: false });

    expect(calculateManualOrderDiscountLimit(
      [{ productId: "prod_1", variantId: "var_1", quantity: 2, price: 100 }],
      200.01,
      2,
    )).toEqual({ maximumAmount: 200, exceeded: true });
  });

  it("uses the active currency precision before comparing", () => {
    expect(calculateManualOrderDiscountLimit(
      [{ productId: "prod_1", variantId: "var_1", quantity: 2, price: 100.49 }],
      200,
      0,
    )).toEqual({ maximumAmount: 200, exceeded: false });

    expect(calculateManualOrderDiscountLimit(
      [{ productId: "prod_1", variantId: "var_1", quantity: 2, price: 1.2346 }],
      2.471,
      3,
    )).toEqual({ maximumAmount: 2.47, exceeded: true });
  });

  it("compares an authoritative server boundary at its currency precision", () => {
    expect(manualOrderDiscountExceedsLimit(260.004, 260, 2)).toBe(false);
    expect(manualOrderDiscountExceedsLimit(260.006, 260, 2)).toBe(true);
  });

  it("provides a zero boundary before items are staged and fails closed on bad inputs", () => {
    expect(calculateManualOrderDiscountLimit([], 1, 2)).toEqual({
      maximumAmount: 0,
      exceeded: true,
    });
    expect(calculateManualOrderDiscountLimit(
      [{ productId: "prod_1", variantId: "var_1", quantity: 0, price: 100 }],
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
      maximumAmount: 100,
      exceeded: true,
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
    })?.maximumAmount).toBe(0.1);
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
