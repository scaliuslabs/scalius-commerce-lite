import { describe, expect, it } from "vitest";
import type { TaxQuote } from "@scalius/core/modules/tax";
import {
  StorefrontCheckoutQuoteConflictError,
  assertStorefrontCheckoutQuoteFingerprint,
  buildStorefrontCheckoutQuoteFingerprint,
} from "./checkout-quote-fingerprint";

const quote: TaxQuote = {
  schemaVersion: 1,
  calculationVersion: "tax-v1",
  enabled: true,
  currencyCode: "BDT",
  decimalPlaces: 2,
  displayLabel: "VAT",
  pricesIncludeTax: false,
  shippingTaxed: true,
  settingsVersion: 7,
  subtotalMinor: 95_000,
  shippingMinor: 6_000,
  discountMinor: 1_000,
  taxableMinor: 100_000,
  taxMinor: 5_000,
  totalMinor: 105_000,
  destination: {
    city: "city_dhaka",
    zone: "zone_adabor",
    area: null,
    cityName: "Dhaka",
    zoneName: "Adabor",
    areaName: null,
  },
  lines: [{
    lineId: "checkout:0:variant_black",
    productId: "product_abcd",
    variantId: "variant_black",
    taxClassId: "taxc_standard",
    taxClassName: "Standard",
    unitPriceMinor: 95_000,
    quantity: 1,
    grossAmountMinor: 95_000,
    discountMinor: 1_000,
    taxableAmountMinor: 94_000,
    taxMinor: 4_700,
    totalMinor: 98_700,
    components: [],
  }],
  shipping: {
    taxClassId: "taxc_shipping",
    taxClassName: "Shipping",
    grossAmountMinor: 6_000,
    discountMinor: 0,
    taxableAmountMinor: 6_000,
    taxMinor: 300,
    totalMinor: 6_300,
    components: [],
  },
};

const delivery = {
  id: "shipping_standard",
  name: "Standard delivery",
  description: "Delivered within 2–3 business days",
  baseAmountMinor: 6_000,
  feeWaived: false,
};

describe("storefront checkout quote fingerprint", () => {
  it("is stable for the exact reviewed billable facts", async () => {
    const first = await buildStorefrontCheckoutQuoteFingerprint(quote, delivery);
    const second = await buildStorefrontCheckoutQuoteFingerprint(
      structuredClone(quote),
      structuredClone(delivery),
    );

    expect(first).toMatch(/^taxq_[A-Za-z0-9_-]{22}$/);
    expect(second).toBe(first);
  });

  it.each([
    ["tax settings", { settingsVersion: 8 }],
    ["currency precision", { decimalPlaces: 0 }],
    ["destination", { destination: { ...quote.destination, zone: "zone_gulshan" } }],
    ["shipping", { shippingMinor: 7_000, totalMinor: 106_000 }],
    ["discount", { discountMinor: 2_000, totalMinor: 104_000 }],
    ["tax", { taxMinor: 5_500, totalMinor: 105_500 }],
    ["line price", {
      subtotalMinor: 100_000,
      totalMinor: 110_000,
      lines: [{ ...quote.lines[0]!, unitPriceMinor: 100_000 }],
    }],
  ])("changes when %s changes", async (_label, change) => {
    const reviewed = await buildStorefrontCheckoutQuoteFingerprint(quote, delivery);
    const current = await buildStorefrontCheckoutQuoteFingerprint({ ...quote, ...change }, delivery);

    expect(current).not.toBe(reviewed);
  });

  it.each([
    ["method identity", { id: "shipping_express" }],
    ["method name", { name: "Express delivery" }],
    ["service promise", { description: "Delivered next business day" }],
    ["configured fee", { baseAmountMinor: 8_000 }],
    ["fee waiver", { feeWaived: true }],
  ])("changes when the selected delivery %s changes", async (_label, change) => {
    const reviewed = await buildStorefrontCheckoutQuoteFingerprint(quote, delivery);
    const current = await buildStorefrontCheckoutQuoteFingerprint(quote, {
      ...delivery,
      ...change,
    });

    expect(current).not.toBe(reviewed);
  });

  it("returns a typed conflict instead of accepting changed checkout terms", () => {
    expect(() => assertStorefrontCheckoutQuoteFingerprint(
      "taxq_abcdefghijklmnopqrstuv",
      "taxq_vutsrqponmlkjihgfedcba",
    )).toThrow(StorefrontCheckoutQuoteConflictError);

    try {
      assertStorefrontCheckoutQuoteFingerprint(
        "taxq_abcdefghijklmnopqrstuv",
        "taxq_vutsrqponmlkjihgfedcba",
      );
    } catch (error) {
      expect(error).toMatchObject({
        status: 409,
        code: "STOREFRONT_CHECKOUT_QUOTE_CONFLICT",
        message: expect.stringContaining("Review the refreshed total"),
      });
    }
  });
});
