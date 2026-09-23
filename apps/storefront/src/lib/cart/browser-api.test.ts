// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  saveAbandonedCheckoutFromBrowser,
  validateDiscountFromBrowser,
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

describe("validateDiscountFromBrowser", () => {
  it("POSTs the code, cart and phone in the body, never in the URL", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { valid: true, discountAmount: 10 } })),
    );

    const result = await validateDiscountFromBrowser(
      "SAVE10",
      [{ id: "prod_1", name: "Rice", price: 100, quantity: 2, variantId: "var_1" }],
      60,
      "+8801712345678",
    );

    expect(result).toEqual({ valid: true, discountAmount: 10 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/v1/discounts/validate");
    expect(url).not.toContain("?");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      code: "SAVE10",
      shippingCost: 60,
      customerPhone: "+8801712345678",
      items: [{ id: "prod_1", price: 100, quantity: 2, variantId: "var_1" }],
    });
  });

  it("returns the API error body for a rejected code", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ valid: false, error: "Code expired" }), { status: 400 }),
    );
    await expect(validateDiscountFromBrowser("OLD")).resolves.toEqual({
      valid: false,
      error: "Code expired",
    });
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
