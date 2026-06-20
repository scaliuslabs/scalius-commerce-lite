import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOrder: vi.fn(),
}));

vi.mock("../../../lib/api/orders", () => ({
  createOrder: mocks.createOrder,
}));

vi.mock("@scalius/shared/request-origin-guard", () => ({
  shouldRejectCrossOriginCookieRequest: () => true,
}));

import { POST } from "./create-order";

describe("checkout create-order proxy Origin guard", () => {
  it("rejects cross-origin cookie checkout requests before backend order creation", async () => {
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
});
