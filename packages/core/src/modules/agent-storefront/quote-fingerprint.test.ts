import { describe, expect, it } from "vitest";
import type { TaxQuote } from "@scalius/core/modules/tax";
import {
  AgentStorefrontCheckoutQuoteConflictError,
  assertAgentStorefrontCheckoutQuoteFingerprint,
  buildAgentStorefrontCheckoutQuoteFingerprint,
} from "./quote-fingerprint";

const quote: TaxQuote = {
  schemaVersion: 1,
  calculationVersion: "tax-v1",
  enabled: true,
  currencyCode: "BDT",
  decimalPlaces: 2,
  displayLabel: "Tax",
  pricesIncludeTax: true,
  shippingTaxed: false,
  settingsVersion: 4,
  subtotalMinor: 95_000,
  shippingMinor: 0,
  discountMinor: 0,
  taxableMinor: 95_000,
  taxMinor: 0,
  totalMinor: 95_000,
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
    taxClassId: null,
    taxClassName: null,
    unitPriceMinor: 95_000,
    quantity: 1,
    grossAmountMinor: 95_000,
    discountMinor: 0,
    taxableAmountMinor: 95_000,
    taxMinor: 0,
    totalMinor: 95_000,
    components: [],
  }],
  shipping: {
    taxClassId: null,
    taxClassName: null,
    grossAmountMinor: 0,
    discountMinor: 0,
    taxableAmountMinor: 0,
    taxMinor: 0,
    totalMinor: 0,
    components: [],
  },
};

const identity = {
  contextRevision: 3,
  shippingMethodId: "shipping_standard",
  discountCode: null,
  quote,
};

describe("agent storefront checkout quote fingerprint", () => {
  it("is stable for the exact reviewed billable facts", async () => {
    const first = await buildAgentStorefrontCheckoutQuoteFingerprint(identity);
    const second = await buildAgentStorefrontCheckoutQuoteFingerprint({
      ...identity,
      quote: structuredClone(quote),
    });

    expect(first).toMatch(/^taxq_[A-Za-z0-9_-]{22}$/);
    expect(second).toBe(first);
  });

  it.each([
    ["context revision", { contextRevision: 4 }],
    ["shipping method", { shippingMethodId: "shipping_express" }],
    ["discount", { discountCode: "SAVE10" }],
    ["tax settings", { quote: { ...quote, settingsVersion: 5 } }],
    ["line price", {
      quote: {
        ...quote,
        subtotalMinor: 100_000,
        totalMinor: 100_000,
        taxableMinor: 100_000,
        lines: [{
          ...quote.lines[0]!,
          unitPriceMinor: 100_000,
          grossAmountMinor: 100_000,
          taxableAmountMinor: 100_000,
          totalMinor: 100_000,
        }],
      },
    }],
  ])("changes when %s changes", async (_label, change) => {
    const reviewed = await buildAgentStorefrontCheckoutQuoteFingerprint(identity);
    const current = await buildAgentStorefrontCheckoutQuoteFingerprint({ ...identity, ...change });

    expect(current).not.toBe(reviewed);
  });

  it("returns a typed conflict instead of accepting changed checkout terms", () => {
    expect(() => assertAgentStorefrontCheckoutQuoteFingerprint(
      "taxq_abcdefghijklmnopqrstuv",
      "taxq_vutsrqponmlkjihgfedcba",
    )).toThrow(AgentStorefrontCheckoutQuoteConflictError);

    try {
      assertAgentStorefrontCheckoutQuoteFingerprint(
        "taxq_abcdefghijklmnopqrstuv",
        "taxq_vutsrqponmlkjihgfedcba",
      );
    } catch (error) {
      expect(error).toMatchObject({
        status: 409,
        code: "AGENT_STOREFRONT_CHECKOUT_QUOTE_CONFLICT",
        message: expect.stringContaining("fresh quote"),
      });
    }
  });
});
