import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOrder: vi.fn(),
  shouldRejectCrossOriginCookieRequest: vi.fn(),
}));

vi.mock("../../../lib/api/orders", () => ({
  createOrder: mocks.createOrder,
}));

vi.mock("@scalius/shared/request-origin-guard", () => ({
  shouldRejectCrossOriginCookieRequest: mocks.shouldRejectCrossOriginCookieRequest,
}));

import { POST } from "./create-order";

beforeEach(() => {
  mocks.createOrder.mockReset();
  mocks.shouldRejectCrossOriginCookieRequest.mockReset();
  mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(false);
});

describe("checkout create-order proxy Origin guard", () => {
  it("rejects cross-origin cookie checkout requests before backend order creation", async () => {
    mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(true);

    const response = await POST({
      request: new Request("https://storefront.example.test/api/checkout/create-order", {
        method: "POST",
        headers: {
          Cookie: "cs_tok=session",
          Origin: "https://evil.example.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ items: [] }),
      }),
    } as never);

    expect(response.status).toBe(403);
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });

  it("preserves structured cart issues returned by backend order creation", async () => {
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
    mocks.createOrder.mockResolvedValueOnce({
      success: false,
      error: "Some items in your cart need attention.",
      status: 400,
      details: { itemIssues: [issue] },
    });

    const response = await POST({
      request: new Request("https://storefront.example.test/api/checkout/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [] }),
      }),
    } as never);
    const json = await response.json() as { details?: unknown };

    expect(response.status).toBe(400);
    expect(json.details).toEqual({ itemIssues: [issue] });
  });
});
