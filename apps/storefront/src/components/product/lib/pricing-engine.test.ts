import { describe, expect, it } from "vitest";
import {
  calculateVariantPrice,
  getBuyerVariantPricePresentation,
} from "./pricing-engine";
import { formatMoney } from "@scalius/shared/currency";

describe("buyer variant pricing", () => {
  it("preserves fractional buyer prices at configured currency precision", () => {
    const kwd = calculateVariantPrice(
      {
        basePrice: 1.234,
        discountType: "percentage",
        discountPercentage: 10,
        discountAmount: 0,
        currencyDecimalPlaces: 3,
        currencyCode: "KWD",
      },
      {
        price: 1.234,
        discountType: null,
        discountPercentage: 0,
        discountAmount: 0,
      },
    );
    const bdt = calculateVariantPrice(
      {
        basePrice: 10.4,
        discountType: "flat",
        discountPercentage: 0,
        discountAmount: 10,
        currencyDecimalPlaces: 2,
      },
      null,
    );
    const checkoutRoundingBoundary = calculateVariantPrice(
      {
        basePrice: 1.005,
        discountType: "percentage",
        discountPercentage: 10,
        discountAmount: null,
        currencyDecimalPlaces: 2,
        currencyCode: "USD",
      },
      null,
    );
    const defaultBdtPrecision = calculateVariantPrice(
      {
        basePrice: 10.4,
        discountType: "flat",
        discountPercentage: null,
        discountAmount: 10,
      },
      null,
    );

    expect(kwd.finalPrice).toBe(1.111);
    expect(bdt.finalPrice).toBe(0.4);
    // Stored prices are whole minor units (1.005 → 1.01); 10% off 1.01 rounds half-up to 0.91.
    expect(checkoutRoundingBoundary).toMatchObject({
      originalPrice: 1.01,
      finalPrice: 0.91,
    });
    expect(defaultBdtPrecision.finalPrice).toBe(0.4);
    expect(formatMoney(kwd.finalPrice, { symbol: "د.ك", code: "KWD" })).toBe("د.ك1.111");
  });

  it("presents a truthful lowest available SKU starting price", () => {
    const productPricing = {
      basePrice: 45_600,
      discountType: "percentage" as const,
      discountPercentage: 10,
      discountAmount: 0,
    };
    const variants = [
      {
        price: 45_600,
        discountType: null,
        discountPercentage: 0,
        discountAmount: 0,
        stock: 5,
        reservedStock: 0,
        trackInventory: true,
      },
      {
        price: 4_500,
        discountType: null,
        discountPercentage: 0,
        discountAmount: 0,
        stock: 5,
        reservedStock: 0,
        trackInventory: true,
      },
    ];

    expect(getBuyerVariantPricePresentation(productPricing, variants)).toMatchObject({
      isStartingAt: true,
      pricing: { finalPrice: 4_050 },
    });
    expect(
      getBuyerVariantPricePresentation(productPricing, [
        variants[0]!,
        { ...variants[1]!, stock: 0 },
      ]).pricing.finalPrice,
    ).toBe(41_040);
    expect(
      getBuyerVariantPricePresentation(
        productPricing,
        variants.map((variant) => ({ ...variant, stock: 0 })),
      ).pricing.finalPrice,
    ).toBe(4_050);
  });

  it("rounds BDT percentage prices to whole taka and says From only when prices differ", () => {
    const productPricing = {
      basePrice: 8_990,
      discountType: "percentage" as const,
      discountPercentage: 8,
      discountAmount: 0,
      currencyCode: "BDT",
    };
    const sku = {
      price: 8_990,
      discountType: null,
      discountPercentage: 0,
      discountAmount: 0,
      stock: 5,
      trackInventory: true,
    };

    expect(calculateVariantPrice(productPricing, sku)).toMatchObject({
      originalPrice: 8_990,
      finalPrice: 8_271,
      savingsAmount: 719,
    });
    expect(getBuyerVariantPricePresentation(productPricing, [sku, { ...sku }])).toMatchObject({
      isStartingAt: false,
      pricing: { finalPrice: 8_271, originalPrice: 8_990 },
    });
    expect(
      getBuyerVariantPricePresentation(productPricing, [sku, { ...sku, price: 9_990 }]).isStartingAt,
    ).toBe(true);
  });
});
