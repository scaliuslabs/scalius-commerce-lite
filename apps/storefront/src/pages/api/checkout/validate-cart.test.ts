import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateCartItems: vi.fn(),
  shouldRejectCrossOriginCookieRequest: vi.fn(),
}));

vi.mock("@/lib/api/orders", () => ({
  validateCartItems: mocks.validateCartItems,
}));

vi.mock("@scalius/shared/request-origin-guard", () => ({
  shouldRejectCrossOriginCookieRequest: mocks.shouldRejectCrossOriginCookieRequest,
}));

import { POST } from "./validate-cart";

beforeEach(() => {
  mocks.validateCartItems.mockReset();
  mocks.shouldRejectCrossOriginCookieRequest.mockReset();
  mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(false);
});

describe("checkout validate-cart proxy", () => {
  it("rejects cross-origin cookie cart-validation requests before backend validation", async () => {
    mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(true);

    const response = await POST({
      request: new Request("https://storefront.example.test/api/checkout/validate-cart", {
        method: "POST",
        headers: {
          Cookie: "cs_tok=session",
          Origin: "https://evil.example.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ items: [{ productId: "prod_1", variantId: "default", quantity: 1, price: 150 }] }),
      }),
    } as never);

    expect(response.status).toBe(403);
    expect(mocks.validateCartItems).not.toHaveBeenCalled();
  });

  it("returns 400 for empty or invalid cart items before backend validation", async () => {
    const response = await POST({
      request: new Request("https://storefront.example.test/api/checkout/validate-cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ productId: "", quantity: 1, price: 150 }] }),
      }),
    } as never);

    expect(response.status).toBe(400);
    expect(mocks.validateCartItems).not.toHaveBeenCalled();
  });

  it("normalizes default variant ids to null before backend validation", async () => {
    mocks.validateCartItems.mockResolvedValueOnce({
      success: true,
      data: {
        valid: true,
        issues: [],
        items: [],
        subtotal: 0,
        hasFreeDeliveryProduct: false,
      },
    });

    const response = await POST({
      request: new Request("https://storefront.example.test/api/checkout/validate-cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{
            cartKey: "line_1",
            productId: "prod_1",
            variantId: "default",
            quantity: 1,
            price: 150,
            productName: "Cotton Panjabi",
            variantLabel: "Default",
          }],
          city: "Dhaka",
          zone: "Mirpur",
        }),
      }),
    } as never);

    expect(response.status).toBe(200);
    expect(mocks.validateCartItems).toHaveBeenCalledWith(
      [expect.objectContaining({ variantId: null })],
      { city: "Dhaka", zone: "Mirpur", area: null, shippingMethodId: null },
    );
  });

  it("preserves structured validation failure details and status", async () => {
    const issue = {
      index: 0,
      cartKey: "line_1",
      productId: "prod_1",
      variantId: null,
      code: "PRODUCT_UNAVAILABLE",
      action: "remove",
      message: "Cotton Panjabi is no longer available.",
      productName: "Cotton Panjabi",
      variantLabel: null,
      requestedQuantity: 1,
    };
    mocks.validateCartItems.mockResolvedValueOnce({
      success: false,
      status: 409,
      error: "Some items in your cart need attention.",
      details: { itemIssues: [issue] },
    });

    const response = await POST({
      request: new Request("https://storefront.example.test/api/checkout/validate-cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ productId: "prod_1", variantId: null, quantity: 1, price: 150 }] }),
      }),
    } as never);
    const json = await response.json() as { details?: unknown };

    expect(response.status).toBe(409);
    expect(json.details).toEqual({ itemIssues: [issue] });
  });
});
