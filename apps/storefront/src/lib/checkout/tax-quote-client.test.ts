import { describe, expect, it, vi } from "vitest";

import {
  buildTaxQuoteRequest,
  fetchAuthoritativeTaxQuote,
  TaxQuoteCartChangedError,
  TaxQuoteDeliveryLocationError,
  TaxQuoteDeliveryRateError,
  TaxQuoteUnavailableError,
} from "./tax-quote-client";
import {
  parseTaxQuoteEnvelope,
  TaxQuoteContractError,
  type CheckoutTaxQuote,
} from "./tax-quote-contract";

function validQuote(
  overrides: Partial<CheckoutTaxQuote> = {},
): CheckoutTaxQuote {
  return {
    valid: true,
    quoteFingerprint: "taxq_abcdefghijklmnopqrstuv",
    displayLabel: "VAT",
    pricesIncludeTax: false,
    shippingTaxed: true,
    currencyCode: "BDT",
    decimalPlaces: 2,
    settingsVersion: 3,
    subtotalMinor: 30_000,
    subtotalAmount: 300,
    shippingMinor: 5_000,
    shippingAmount: 50,
    discountMinor: 2_000,
    discountAmount: 20,
    taxMinor: 4_950,
    taxAmount: 49.5,
    totalMinor: 37_950,
    totalAmount: 379.5,
    deliveryMethodKind: "delivery",
    requiresShipping: true,
    pickup: null,
    allowedPaymentMethods: ["cod"],
    shippingMethod: {
      id: "shipping_1",
      name: "Standard delivery",
      description: "Delivered within 2–3 business days",
      baseAmountMinor: 5_000,
      feeWaived: false,
    },
    discounts: [{ promotionId: "promo_1", title: "Eid 10%", code: "SAVE20", amount: 20, shippingAmount: 0 }],
    offers: [{
      promotionId: "promo_gift", title: "Buy 2 panjabi, get a cap free", code: null, kind: "get",
      percentOff: 100, quantity: 1, shortfallAmount: null,
      products: [{ id: "prod_cap", slug: "cap", name: "Cap", variantId: "var_cap", price: 200 }],
    }],
    rejectedCodes: [{ code: "SHIP", reason: "minimum_subtotal", message: "Add ৳200 more to use SHIP.", shortfallAmount: 200 }],
    items: [{
      cartKey: "line:v2:prod_1:variant:var_1",
      productId: "prod_1",
      variantId: "var_1",
      quantity: 2,
      unitPrice: 150,
      productName: "Cotton Panjabi",
      variantLabel: "M / Blue / Long",
      fulfillmentType: "ship",
      properties: [],
      propertiesPriceMinor: 0,
      propertiesHash: "none",
    }],
    ...overrides,
  };
}

function checkoutData(): Record<string, unknown> {
  return {
    cartItems: JSON.stringify({
      "line:v2:prod_1:variant:var_1": {
        id: "prod_1",
        variantId: "var_1",
        quantity: 2,
        price: 999_999,
        taxClassId: "client_forged_tax_class",
        name: "Cotton Panjabi",
        options: [
          { name: "Fit", label: "M" },
          { name: "Shade", label: "Blue" },
          { name: "Sleeve", label: "Long" },
        ],
      },
    }),
    inventoryPool: "regular",
    city: "city_1",
    zone: "zone_1",
    area: "area_1",
    shippingMethodId: "shipping_1",
    discountCodes: JSON.stringify(["save20", "SHIP"]),
    discountAmount: 999_999,
    customerPhone: "+8801700000000",
    subtotal: 999_999,
    taxClassId: "client_forged_tax_class",
  };
}

describe("tax quote client contract", () => {
  it("builds only server-resolvable quote inputs and drops client prices and tax classes", () => {
    const request = buildTaxQuoteRequest(checkoutData());

    expect(request).toEqual({
      items: [{
        cartKey: "line:v2:prod_1:variant:var_1",
        productId: "prod_1",
        variantId: "var_1",
        quantity: 2,
        productName: "Cotton Panjabi",
        variantLabel: "M / Blue / Long",
      }],
      inventoryPool: "regular",
      city: "city_1",
      zone: "zone_1",
      area: "area_1",
      shippingMethodId: "shipping_1",
      discountCodes: ["SAVE20", "SHIP"],
      customerPhone: "+8801700000000",
    });
    expect(JSON.stringify(request)).not.toContain("999999");
    expect(JSON.stringify(request)).not.toContain("taxClass");
  });

  it("rejects missing persisted variants and incomplete delivery inputs", () => {
    expect(() => buildTaxQuoteRequest({
      ...checkoutData(),
      cartItems: JSON.stringify({
        line_1: { id: "prod_1", variantId: "default", quantity: 1 },
      }),
    })).toThrow(TaxQuoteUnavailableError);

    expect(() => buildTaxQuoteRequest({
      ...checkoutData(),
      shippingMethodId: "",
    })).toThrow(TaxQuoteUnavailableError);
  });

  it("parses a coherent minor-unit response and rejects mismatched totals", () => {
    expect(parseTaxQuoteEnvelope({ success: true, data: validQuote() })).toEqual(
      validQuote(),
    );

    expect(() => parseTaxQuoteEnvelope({
      success: true,
      data: validQuote({ totalMinor: 99_999, totalAmount: 999.99 }),
    })).toThrow(TaxQuoteContractError);
  });

  it("preserves a bounded multiline delivery description", () => {
    const quote = validQuote({
      shippingMethod: {
        ...validQuote().shippingMethod!,
        description: "Orders before noon\nusually arrive next day.",
      },
    });

    expect(parseTaxQuoteEnvelope({ success: true, data: quote }).shippingMethod)
      .toEqual(quote.shippingMethod);
  });

  it("posts a no-store same-origin request and accepts only the strict envelope", async () => {
    const quote = validQuote();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: quote,
    }), { status: 200 })) as unknown as typeof fetch;

    await expect(fetchAuthoritativeTaxQuote(checkoutData(), fetcher)).resolves.toEqual(quote);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetcher).mock.calls[0];
    expect(url).toBe("/api/checkout/tax-quote");
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain("taxClass");
    expect(JSON.stringify(body)).not.toContain("999999");
  });

  it("rejects a coherent quote that does not identify the submitted cart line", async () => {
    const quote = validQuote({
      items: [{
        ...validQuote().items[0],
        variantId: "var_other",
      }],
    });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: quote,
    }), { status: 200 })) as unknown as typeof fetch;

    await expect(
      fetchAuthoritativeTaxQuote(checkoutData(), fetcher),
    ).rejects.toBeInstanceOf(TaxQuoteUnavailableError);
  });

  it("rejects a quote for a different delivery method", async () => {
    const quote = validQuote({
      shippingMethod: {
        ...validQuote().shippingMethod!,
        id: "shipping_other",
      },
    });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: quote,
    }), { status: 200 })) as unknown as typeof fetch;

    await expect(
      fetchAuthoritativeTaxQuote(checkoutData(), fetcher),
    ).rejects.toBeInstanceOf(TaxQuoteUnavailableError);
  });

  it("rejects delivery snapshots whose fee semantics contradict the quote", () => {
    expect(() => parseTaxQuoteEnvelope({
      success: true,
      data: validQuote({
        shippingMethod: {
          ...validQuote().shippingMethod!,
          baseAmountMinor: 4_000,
        },
      }),
    })).toThrow(TaxQuoteContractError);

    expect(() => parseTaxQuoteEnvelope({
      success: true,
      data: validQuote({
        shippingMethod: {
          ...validQuote().shippingMethod!,
          feeWaived: true,
        },
      }),
    })).toThrow(TaxQuoteContractError);
  });

  it("does not expose upstream payload details when a quote is unavailable", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: "Rejected phone +8801700000000",
    }), { status: 422 })) as unknown as typeof fetch;

    const error = await fetchAuthoritativeTaxQuote(checkoutData(), fetcher)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaxQuoteUnavailableError);
    expect(String(error)).not.toContain("+8801700000000");
  });

  it("reports a refused delivery rate apart from an unavailable total", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: "Current checkout total is unavailable",
      details: { reason: "delivery_rate_unavailable" },
    }), { status: 400 })) as unknown as typeof fetch;

    await expect(fetchAuthoritativeTaxQuote(checkoutData(), fetcher))
      .rejects.toBeInstanceOf(TaxQuoteDeliveryRateError);
  });

  it("names the removed thana instead of reporting an unavailable total", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: "Current checkout total is unavailable",
      details: { reason: "delivery_location_unavailable", field: "zone" },
    }), { status: 400 })) as unknown as typeof fetch;

    const refused = await fetchAuthoritativeTaxQuote(checkoutData(), fetcher).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TaxQuoteDeliveryLocationError);
    expect((refused as TaxQuoteDeliveryLocationError).field).toBe("zone");
  });

  it("preserves only bounded cart-repair issues from a failed quote", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: "Current checkout total is unavailable",
      details: {
        itemIssues: [{
          index: 0,
          cartKey: "line:v2:prod_1:variant:var_1",
          productId: "prod_1",
          variantId: "var_1",
          code: "PRICE_CHANGED",
          action: "refresh_item",
          message: "The price changed.",
          productName: "Cotton Panjabi",
          variantLabel: "M / Blue",
          requestedQuantity: 2,
          submittedPrice: 140,
          currentPrice: 150,
          privatePhone: "+8801700000000",
        }],
      },
    }), { status: 422 })) as unknown as typeof fetch;

    const error = await fetchAuthoritativeTaxQuote(checkoutData(), fetcher)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaxQuoteCartChangedError);
    expect((error as TaxQuoteCartChangedError).issues).toEqual([
      expect.objectContaining({
        cartKey: "line:v2:prod_1:variant:var_1",
        code: "PRICE_CHANGED",
        currentPrice: 150,
      }),
    ]);
    expect(JSON.stringify((error as TaxQuoteCartChangedError).issues))
      .not.toContain("privatePhone");
  });
});

describe("tax quote on the pickup and no-delivery paths (Wave A)", () => {
  const withInputs = () => ({
    ...checkoutData(),
    cartItems: JSON.stringify({
      "line:v3:prod_1:variant:var_1:p:0123456789abcdef": {
        id: "prod_1",
        variantId: "var_1",
        quantity: 1,
        name: "Engraved pen",
        properties: [{ key: "engraving", value: "Anika", label: "Engraving", displayValue: "Anika", priceMinor: 20_000 }],
      },
    }),
  });

  it("sends only the pickup rate for pickup, and nothing for a cart with nothing physical", () => {
    const pickup = buildTaxQuoteRequest({ ...withInputs(), deliveryMode: "pickup", shippingMethodId: "pickup_1" });
    expect(pickup).not.toHaveProperty("city");
    expect(pickup).not.toHaveProperty("zone");
    expect(pickup).not.toHaveProperty("area");
    expect(pickup.shippingMethodId).toBe("pickup_1");
    // Buyer inputs go by key and value only; labels and prices are the server's.
    expect(pickup.items[0]?.properties).toEqual([{ key: "engraving", value: "Anika" }]);

    const none = buildTaxQuoteRequest({ ...withInputs(), deliveryMode: "none" });
    expect(none).not.toHaveProperty("city");
    expect(none).not.toHaveProperty("shippingMethodId");
  });

  it("reads a quote with no delivery method and refuses one that charges for delivery anyway", () => {
    const noDelivery = validQuote({
      shippingMethod: null,
      deliveryMethodKind: null,
      requiresShipping: false,
      shippingMinor: 0,
      shippingAmount: 0,
      taxMinor: 0,
      taxAmount: 0,
      totalMinor: 28_000,
      totalAmount: 280,
      allowedPaymentMethods: ["cod", "sslcommerz"],
    });
    const parsed = parseTaxQuoteEnvelope({ success: true, data: noDelivery });
    expect(parsed.shippingMethod).toBeNull();
    expect(parsed.requiresShipping).toBe(false);
    expect(parsed.allowedPaymentMethods).toEqual(["cod", "sslcommerz"]);

    expect(() => parseTaxQuoteEnvelope({
      success: true,
      data: { ...noDelivery, shippingMinor: 5_000, shippingAmount: 50, totalMinor: 33_000, totalAmount: 330 },
    })).toThrow(TaxQuoteContractError);
  });

  it("fails closed when the quote does not say which payment methods the cart may use", () => {
    const { allowedPaymentMethods: _omitted, ...quote } = validQuote();
    expect(() => parseTaxQuoteEnvelope({ success: true, data: quote })).toThrow(TaxQuoteContractError);
  });
});

describe("tax quote with a quantity bundle", () => {
  // 2 × ৳250 with the "Pair" tier (10% off): the API folds the ৳50 saving into
  // discountMinor with no promotion line, so the summary lines must name it.
  const bundleQuote = {
    ...validQuote({
      subtotalMinor: 50_000, subtotalAmount: 500,
      shippingMinor: 6_000, shippingAmount: 60,
      discountMinor: 5_000, discountAmount: 50,
      taxMinor: 0, taxAmount: 0,
      totalMinor: 51_000, totalAmount: 510,
      shippingMethod: { id: "shipping_1", name: "Inside Dhaka", description: null, baseAmountMinor: 6_000, feeWaived: false },
      discounts: [], offers: [], rejectedCodes: [],
      items: [{ ...validQuote().items[0], quantity: 2, unitPrice: 250 }],
    }),
    bundleDiscountMinor: 5_000,
    bundleDiscountAmount: 50,
    bundles: [{ productId: "prod_1", quantity: 2, discountType: "percentage", label: "Pair" }],
  };

  it("lists the bundle saving as a discount line so subtotal + delivery - discounts = total", () => {
    const parsed = parseTaxQuoteEnvelope({ success: true, data: bundleQuote });
    expect(parsed.discounts).toEqual([
      { promotionId: "bundle", title: "Pair", code: null, amount: 50, shippingAmount: 0 },
    ]);
    const listed = parsed.discounts.reduce((sum, line) => sum + line.amount + line.shippingAmount, 0);
    expect(parsed.subtotalAmount + parsed.shippingAmount - listed).toBe(parsed.totalAmount);
  });

  it("adds no line when no bundle applies, and refuses a saving that contradicts its minor units", () => {
    const none = parseTaxQuoteEnvelope({ success: true, data: { ...validQuote(), bundleDiscountMinor: 0, bundleDiscountAmount: 0, bundles: [] } });
    expect(none.discounts.map((line) => line.promotionId)).toEqual(["promo_1"]);
    expect(() => parseTaxQuoteEnvelope({ success: true, data: { ...bundleQuote, bundleDiscountAmount: 5 } }))
      .toThrow(TaxQuoteContractError);
  });
});
