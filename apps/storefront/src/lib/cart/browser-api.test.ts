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
          { promotionId: "p1", title: "Eid 10%", code: "SAVE10", amount: 20 },
          { promotionId: "p2", title: "Free delivery", code: null, amount: 50 },
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
      discounts: [{ title: "Eid 10%", code: "SAVE10", amount: 20 }, { title: "Free delivery", code: null, amount: 50 }],
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
