// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOrder: vi.fn(),
  createApiUrl: vi.fn((path: string) => `https://api.example.test/api/v1${path}`),
  fetchWithRetry: vi.fn(),
  shouldRejectCrossOriginCookieRequest: vi.fn(),
}));

vi.mock("../../../api/orders", () => ({
  createOrder: mocks.createOrder,
}));

vi.mock("../../../api/client", () => ({
  createApiUrl: mocks.createApiUrl,
  fetchWithRetry: mocks.fetchWithRetry,
}));

vi.mock("@/lib/api/client", () => ({
  createApiUrl: mocks.createApiUrl,
  fetchWithRetry: mocks.fetchWithRetry,
}));

vi.mock("@scalius/shared/request-origin-guard", () => ({
  shouldRejectCrossOriginCookieRequest: mocks.shouldRejectCrossOriginCookieRequest,
}));

import { POST } from "../../../../pages/api/checkout/create-order";

beforeEach(() => {
  mocks.createOrder.mockReset();
  mocks.createApiUrl.mockClear();
  mocks.fetchWithRetry.mockReset();
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

  it("clears stale customer cookies when backend rejects an expired customer session", async () => {
    mocks.createOrder.mockResolvedValueOnce({
      success: false,
      error: "Your session expired. Please sign in again or continue as a guest.",
      errorCode: "CUSTOMER_SESSION_STALE",
      status: 401,
    });

    const response = await POST({
      request: new Request("https://storefront.example.test/api/checkout/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "cs_tok=expired; cs_auth=1",
        },
        body: JSON.stringify({ items: [] }),
      }),
    } as never);
    const json = await response.json() as { errorCode?: string };
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(401);
    expect(json.errorCode).toBe("CUSTOMER_SESSION_STALE");
    expect(setCookie).toContain("cs_tok=; Max-Age=0");
    expect(setCookie).toContain("cs_auth=; Max-Age=0");
  });

  it.each([
    {
      status: 409,
      errorCode: "CHECKOUT_ATTEMPT_CONFLICT",
      error: "This checkout was already submitted with different details.",
    },
    {
      status: 429,
      errorCode: "CHECKOUT_RATE_LIMITED",
      error: "Too many checkout attempts. Please wait before trying again.",
    },
    {
      status: 503,
      errorCode: "CHECKOUT_CONFIG_UNAVAILABLE",
      error: "Checkout is temporarily unavailable. Please try again shortly.",
    },
  ])("preserves backend checkout failure status $status through the proxy", async ({
    status,
    errorCode,
    error,
  }) => {
    mocks.createOrder.mockResolvedValueOnce({
      success: false,
      error,
      errorCode,
      status,
      details: { retryable: status !== 409 },
    });

    const response = await POST({
      request: new Request("https://storefront.example.test/api/checkout/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [] }),
      }),
    } as never);
    const json = await response.json() as {
      error?: string;
      errorCode?: string;
      details?: unknown;
    };

    expect(response.status).toBe(status);
    expect(json.error).toBe(error);
    expect(json.errorCode).toBe(errorCode);
    expect(json.details).toEqual({ retryable: status !== 409 });
  });

  it("does not attach an initial online payment session unless explicitly requested", async () => {
    mocks.createOrder.mockResolvedValueOnce({
      success: true,
      orderId: "order_1",
      receiptToken: "receipt_1",
      totalAmount: 125,
      paymentMethod: "sslcommerz",
    });

    const response = await POST({
      request: new Request("https://storefront.example.test/api/checkout/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutRequestId: "checkout_req_123456",
          paymentMethod: "sslcommerz",
        }),
      }),
    } as never);
    const json = await response.json() as {
      data?: {
        id?: string;
        receiptToken?: string;
        initialPaymentSession?: unknown;
        initialPaymentSessionError?: string;
      };
    };

    expect(response.status).toBe(200);
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
    expect(json.data).toMatchObject({
      id: "order_1",
      receiptToken: "receipt_1",
    });
    expect(json.data?.initialPaymentSession).toBeUndefined();
    expect(json.data?.initialPaymentSessionError).toBeUndefined();
  });

  it("attaches an initial online payment session after order creation succeeds", async () => {
    mocks.createOrder.mockResolvedValueOnce({
      success: true,
      orderId: "order_1",
      receiptToken: "receipt_1",
      totalAmount: 125,
      paymentMethod: "sslcommerz",
    });
    mocks.fetchWithRetry.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          gatewayUrl: "https://ssl.example.test/pay",
          sessionKey: "ssl_session_1",
        },
      }),
    });

    const response = await POST({
      request: new Request("https://storefront.example.test/api/checkout/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutRequestId: "checkout_req_123456",
          paymentMethod: "sslcommerz",
          initialPaymentSession: true,
        }),
      }),
    } as never);
    const json = await response.json() as {
      data?: {
        initialPaymentSession?: Record<string, unknown>;
      };
    };

    expect(response.status).toBe(200);
    expect(mocks.createOrder).toHaveBeenCalledWith(
      expect.not.objectContaining({ initialPaymentSession: true }),
      { customerSessionToken: null },
    );
    expect(mocks.fetchWithRetry).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/payment/sslcommerz/session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ orderId: "order_1", receiptToken: "receipt_1" }),
      }),
      0,
      15000,
      true,
    );
    expect(json.data?.initialPaymentSession).toEqual({
      gateway: "sslcommerz",
      gatewayUrl: "https://ssl.example.test/pay",
      sessionKey: "ssl_session_1",
    });
  });

  it("keeps the committed order response when initial payment session creation fails", async () => {
    mocks.createOrder.mockResolvedValueOnce({
      success: true,
      orderId: "order_1",
      receiptToken: "receipt_1",
      totalAmount: 125,
      paymentMethod: "polar",
    });
    mocks.fetchWithRetry.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Polar unavailable" }),
    });

    const response = await POST({
      request: new Request("https://storefront.example.test/api/checkout/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkoutRequestId: "checkout_req_123456",
          paymentMethod: "polar",
          initialPaymentSession: true,
        }),
      }),
    } as never);
    const json = await response.json() as {
      success?: boolean;
      data?: {
        id?: string;
        initialPaymentSession?: unknown;
        initialPaymentSessionError?: string;
      };
    };

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data?.id).toBe("order_1");
    expect(json.data?.initialPaymentSession).toBeUndefined();
    expect(json.data?.initialPaymentSessionError).toBe("Polar unavailable");
  });
});
