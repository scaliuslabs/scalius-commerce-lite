// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  shouldRejectCrossOriginCookieRequest: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { PUBLIC_API_BASE_URL: "https://api.example.test" },
}));

vi.mock("@scalius/shared/request-origin-guard", () => ({
  shouldRejectCrossOriginCookieRequest: mocks.shouldRejectCrossOriginCookieRequest,
}));

import { POST } from "../../../pages/api/order-receipt/claim-account";
import { getOrderReceiptCookieName } from "../../order-receipt-cookie";

beforeEach(() => {
  mocks.shouldRejectCrossOriginCookieRequest.mockReset();
  mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(false);
  vi.unstubAllGlobals();
});

describe("guest receipt account-claim proxy", () => {
  it("moves HttpOnly receipt proof to a private header and preserves the account session cookie", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("X-Receipt-Token")).toBe("chk_private_receipt");
      expect(new Headers(init.headers).get("Cookie")).toContain("cs_tok=session_1");
      return new Response(JSON.stringify({
        success: true,
        data: { orderId: "order_1", alreadyClaimed: false },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const receiptCookie = getOrderReceiptCookieName("order_1");

    const response = await POST({
      request: new Request("https://storefront.example.test/api/order-receipt/claim-account", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `cs_tok=session_1; ${receiptCookie}=chk_private_receipt`,
        },
        body: JSON.stringify({ orderId: "order_1" }),
      }),
    } as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/customer-auth/orders/order_1/claim-receipt",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(body).toEqual({
      success: true,
      data: { orderId: "order_1", alreadyClaimed: false },
    });
    expect(JSON.stringify(body)).not.toContain("chk_private_receipt");
  });

  it("rejects cross-origin account claims before forwarding proof", async () => {
    mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(true);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST({
      request: new Request("https://storefront.example.test/api/order-receipt/claim-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1" }),
      }),
    } as never);

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
