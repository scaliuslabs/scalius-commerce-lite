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

import { POST as polarPost } from "../../../../pages/api/checkout/polar-session";
import { POST as sslcommerzPost } from "../../../../pages/api/checkout/sslcommerz-session";
import { POST as stripePost } from "../../../../pages/api/checkout/stripe-intent";
import { POST as stripeReconcilePost } from "../../../../pages/api/checkout/stripe-reconcile";
import { getOrderReceiptCookieName } from "../../../order-receipt-cookie";

beforeEach(() => {
  mocks.createApiUrl.mockClear();
  mocks.fetchWithRetry.mockReset();
  mocks.shouldRejectCrossOriginCookieRequest.mockReset();
  mocks.shouldRejectCrossOriginCookieRequest.mockReturnValue(false);
});

describe("checkout payment-session proxies", () => {
  it.each([
    {
      label: "Stripe",
      endpoint: "https://storefront.example.test/api/checkout/stripe-intent",
      post: stripePost,
    },
    {
      label: "Stripe reconciliation",
      endpoint: "https://storefront.example.test/api/checkout/stripe-reconcile",
      post: stripeReconcilePost,
    },
    {
      label: "SSLCommerz",
      endpoint: "https://storefront.example.test/api/checkout/sslcommerz-session",
      post: sslcommerzPost,
    },
    {
      label: "Polar",
      endpoint: "https://storefront.example.test/api/checkout/polar-session",
      post: polarPost,
    },
  ])("fails closed for $label when the receipt cookie is missing", async ({ endpoint, post }) => {
    const response = await post({
      request: new Request(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: "order_1" }),
      }),
    } as never);
    const json = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(json.error).toContain("Private receipt proof is missing");
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "Stripe",
      endpoint: "https://storefront.example.test/api/checkout/stripe-intent",
      post: stripePost,
    },
    {
      label: "SSLCommerz",
      endpoint: "https://storefront.example.test/api/checkout/sslcommerz-session",
      post: sslcommerzPost,
    },
    {
      label: "Polar",
      endpoint: "https://storefront.example.test/api/checkout/polar-session",
      post: polarPost,
    },
  ])("preserves backend 202 processing responses for $label", async ({ endpoint, post }) => {
    mocks.fetchWithRetry.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
        status: "processing",
        retryable: true,
        retryAfterSeconds: 2,
        message: "Payment session creation is already processing. Please try again shortly.",
      },
    }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    }));

    const response = await post({
      request: new Request(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${getOrderReceiptCookieName("order_1")}=receipt_1`,
        },
        body: JSON.stringify({
          orderId: "order_1",
          paymentType: "full",
        }),
      }),
    } as never);
    const json = await response.json() as Record<string, unknown>;
    const [, requestInit] = mocks.fetchWithRetry.mock.calls[0]!;
    const backendBody = JSON.parse(String(requestInit.body)) as Record<string, unknown>;

    expect(response.status).toBe(202);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(json).toEqual({
      status: "processing",
      retryable: true,
      retryAfterSeconds: 2,
      message: "Payment session creation is already processing. Please try again shortly.",
    });
    expect(json).not.toHaveProperty("gatewayUrl");
    expect(json).not.toHaveProperty("clientSecret");
    expect(mocks.fetchWithRetry).toHaveBeenCalledWith(
      expect.stringMatching(/\/payment\/(?:stripe\/intent|sslcommerz\/session|polar\/session)$/),
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
      }),
      0,
      15000,
      false,
    );
    expect(backendBody).toMatchObject({
      orderId: "order_1",
      paymentType: "full",
      receiptToken: "receipt_1",
    });
    expect(backendBody).not.toHaveProperty("token");
    expect(backendBody).not.toHaveProperty("receipt_token");
  });

  it("keeps Stripe receipt proof server-side while forwarding reconciliation", async () => {
    mocks.fetchWithRetry.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: { status: "scheduled", providerStatus: "succeeded" },
    }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    }));

    const response = await stripeReconcilePost({
      request: new Request("https://storefront.example.test/api/checkout/stripe-reconcile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${getOrderReceiptCookieName("order_1")}=receipt_1`,
        },
        body: JSON.stringify({
          orderId: "order_1",
          receiptToken: "browser-injected-proof",
          token: "browser-injected-token",
        }),
      }),
    } as never);
    const [, requestInit] = mocks.fetchWithRetry.mock.calls[0]!;

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      success: true,
      data: { status: "scheduled", providerStatus: "succeeded" },
    });
    expect(mocks.fetchWithRetry).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/payment/stripe/reconcile",
      expect.objectContaining({ method: "POST", cache: "no-store" }),
      0,
      15000,
      false,
    );
    expect(JSON.parse(String(requestInit.body))).toEqual({
      orderId: "order_1",
      receiptToken: "receipt_1",
    });
  });
});
