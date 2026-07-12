import { describe, expect, it, vi } from "vitest";

import {
  buildTaxQuoteRequest,
  fetchAuthoritativeTaxQuote,
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
});
