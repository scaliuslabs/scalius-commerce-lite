// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApiUrl: vi.fn((path: string) => `https://api.example.test/api/v1${path}`),
  fetchWithRetry: vi.fn(),
  shouldRejectCrossOriginCookieRequest: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  createApiUrl: mocks.createApiUrl,
  fetchWithRetry: mocks.fetchWithRetry,
}));

vi.mock("@scalius/shared/request-origin-guard", () => ({
  shouldRejectCrossOriginCookieRequest: mocks.shouldRejectCrossOriginCookieRequest,
}));

import { POST } from "../../../../pages/api/order-support/receipt-request";

beforeEach(() => {
  mocks.createApiUrl.mockClear();
  mocks.fetchWithRetry.mockReset();
  mocks.shouldRejectCrossOriginCookieRequest.mockReset();
  mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(false);
});

describe("receipt-token order support proxy", () => {
  it("rejects cross-origin cookie support requests before backend work", async () => {
    mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(true);

    const response = await POST({
      request: new Request("https://storefront.example.test/api/order-support/receipt-request", {
        method: "POST",
        headers: {
          Cookie: "cs_tok=session",
          Origin: "https://evil.example.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          orderId: "ord_1",
          receiptToken: "receipt_1",
          type: "cancel_pre_shipment",
          reason: "Please cancel this order.",
        }),
      }),
    } as never);

    expect(response.status).toBe(403);
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
  });

  it("returns 400 for missing receipt proof or unsupported actions", async () => {
    const response = await POST({
      request: new Request("https://storefront.example.test/api/order-support/receipt-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "ord_1",
          receiptToken: "",
          type: "delete_order",
          reason: "Please delete this order.",
        }),
      }),
    } as never);

    expect(response.status).toBe(400);
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
  });

  it("forwards a sanitized receipt-token support request to the API", async () => {
    mocks.fetchWithRetry.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
        request: { id: "req_1" },
        supportRequests: [{ id: "req_1" }],
        supportRequestActions: [],
      },
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));

    const response = await POST({
      request: new Request("https://storefront.example.test/api/order-support/receipt-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "ord_1",
          receiptToken: " receipt_1 ",
          type: "cancel_pre_shipment",
          reason: "  Please cancel before shipment. ",
          message: "   ",
        }),
      }),
    } as never);
    const json = await response.json() as { success?: boolean };
    const [, requestInit, retries, timeout, requiresAuth] = mocks.fetchWithRetry.mock.calls[0]!;

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(json.success).toBe(true);
    expect(mocks.createApiUrl).toHaveBeenCalledWith("/orders/receipt/ord_1/support-requests");
    expect(requestInit).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(requestInit.body))).toEqual({
      token: "receipt_1",
      type: "cancel_pre_shipment",
      reason: "Please cancel before shipment.",
      message: null,
    });
    expect(retries).toBe(0);
    expect(timeout).toBe(8000);
    expect(requiresAuth).toBe(true);
  });

  it("preserves backend failure status and body", async () => {
    mocks.fetchWithRetry.mockResolvedValueOnce(new Response(JSON.stringify({
      success: false,
      error: "This private receipt link is no longer valid.",
    }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }));

    const response = await POST({
      request: new Request("https://storefront.example.test/api/order-support/receipt-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "ord_1",
          receiptToken: "receipt_1",
          type: "refund",
          reason: "Payment issue.",
        }),
      }),
    } as never);
    const json = await response.json() as { error?: string };

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(json.error).toBe("This private receipt link is no longer valid.");
  });
});
