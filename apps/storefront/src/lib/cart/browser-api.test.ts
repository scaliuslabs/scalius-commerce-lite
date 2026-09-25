// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  previewCartDiscounts,
  saveAbandonedCheckoutFromBrowser,
} from "./browser-api";

const fetchMock = vi.fn();

beforeEach(() => {
  window.__API_BASE_URL__ = "https://api.example.test/api/v1";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  delete window.__API_BASE_URL__;
  vi.unstubAllGlobals();
});

describe("previewCartDiscounts", () => {
  it("POSTs every applied code, the cart and phone in the body, never in the URL", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        totalDiscount: 70,
        discounts: [
          { promotionId: "p1", title: "Eid 10%", code: "SAVE10", amount: 20, shippingAmount: 0 },
          { promotionId: "p2", title: "Free delivery", code: null, amount: 0, shippingAmount: 50 },
        ],
        offers: [],
        rejectedCodes: [],
      },
    })));

    const result = await previewCartDiscounts(
      ["SAVE10"],
      [{ id: "prod_1", name: "Rice", price: 100, quantity: 2, variantId: "var_1" }],
      60,
      "+8801712345678",
    );

    expect(result).toMatchObject({
      ok: true,
      totalDiscount: 70,
      discounts: [{ title: "Eid 10%", code: "SAVE10", amount: 20 }, { title: "Free delivery", code: null, amount: 0, shippingAmount: 50 }],
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/v1/discounts/validate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      codes: ["SAVE10"],
      shippingCost: 60,
      customerPhone: "+8801712345678",
      items: [{ id: "prod_1", price: 100, quantity: 2, variantId: "var_1" }],
    });
  });

  it("sends the pre-surcharge price bundles use and lists the bundle saving in the estimate", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        totalDiscount: 50,
        bundleDiscountAmount: 50,
        bundles: [{ productId: "prod_soap", quantity: 2, discountType: "percentage", label: "Pair" }],
        discounts: [],
        offers: [],
        rejectedCodes: [{
          code: "SAVE5",
          reason: "lower_savings",
          message: "Bundle saving applied: better than SAVE5.",
          conflictsWith: "Bundle saving",
          bundleSavesMore: true,
        }],
      },
    })));

    const result = await previewCartDiscounts(["SAVE5"], [
      { id: "prod_soap", name: "Soap", price: 250, quantity: 2, variantId: "var_soap" },
      {
        id: "prod_mug", name: "Mug", price: 900, quantity: 1, variantId: "var_mug",
        properties: [{ key: "wrap", value: "true", label: "Gift wrap", displayValue: "Yes", priceMinor: 10_000 }],
      },
    ]);

    expect(result).toMatchObject({
      ok: true,
      totalDiscount: 50,
      discounts: [{ promotionId: "bundle", title: "Pair", code: null, amount: 50, shippingAmount: 0 }],
      rejectedCodes: [{ code: "SAVE5", reason: "lower_savings", bundleSavesMore: true }],
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).items).toEqual([
      { id: "prod_soap", price: 250, quantity: 2, variantId: "var_soap" },
      { id: "prod_mug", price: 900, basePrice: 800, quantity: 1, variantId: "var_mug" },
    ]);
  });

  it("reads the message out of the API error envelope instead of printing an object", async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ success: false, error: { code: "VALIDATION_ERROR", message: "Use up to 5 discount codes." } }),
      { status: 400 },
    ));
    await expect(previewCartDiscounts(["A1A"], [])).resolves.toEqual({
      ok: false,
      message: "Use up to 5 discount codes.",
    });
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await expect(previewCartDiscounts(["A1A"], [])).resolves.toEqual({ ok: false, message: null });
  });
});

describe("saveAbandonedCheckoutFromBrowser", () => {
  it("is best effort", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await expect(
      saveAbandonedCheckoutFromBrowser({ checkoutId: "chk_1", checkoutData: {} }),
    ).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/api/v1/abandoned-checkouts",
    );
  });
});
