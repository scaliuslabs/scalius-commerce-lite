import { describe, expect, it, vi } from "vitest";

import {
  buildTaxQuoteRequest,
  fetchAuthoritativeTaxQuote,
  TaxQuoteCartChangedError,
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
    shippingMethod: {
      id: "shipping_1",
      name: "Standard delivery",
      description: "Delivered within 2–3 business days",
      baseAmountMinor: 5_000,
      feeWaived: false,
    },
    items: [{
      cartKey: "line:v2:prod_1:variant:var_1",
      productId: "prod_1",
      variantId: "var_1",
      quantity: 2,
      unitPrice: 150,
      productName: "Cotton Panjabi",
      variantLabel: "M / Blue / Long",
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
    discountCodeHidden: JSON.stringify({ code: "SAVE20", amount: 999_999 }),
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
      discountCode: "SAVE20",
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
        ...validQuote().shippingMethod,
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
        ...validQuote().shippingMethod,
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
          ...validQuote().shippingMethod,
          baseAmountMinor: 4_000,
        },
      }),
    })).toThrow(TaxQuoteContractError);

    expect(() => parseTaxQuoteEnvelope({
      success: true,
      data: validQuote({
        shippingMethod: {
          ...validQuote().shippingMethod,
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
