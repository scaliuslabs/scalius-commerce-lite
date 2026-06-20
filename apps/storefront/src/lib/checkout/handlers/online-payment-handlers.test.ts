// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOrder: vi.fn(),
}));

vi.mock("../create-order", () => ({
  createOrder: mocks.createOrder,
  CheckoutOrderError: class CheckoutOrderError extends Error {
    status = 400;
    details = undefined;
    cartIssues = [];
  },
}));

import { polarHandler } from "./polar";
import { sslcommerzHandler } from "./sslcommerz";
import { stripeHandler } from "./stripe";
import type { CheckoutConfig, PaymentContext } from "../types";

const partialConfig: CheckoutConfig = {
  gateways: [],
  guestCheckoutEnabled: true,
  authVerificationMethod: "email",
  checkoutMode: "all",
  partialPaymentEnabled: true,
  partialPaymentAmount: 50,
};

function makeContext(config: CheckoutConfig = partialConfig): PaymentContext {
  return {
    checkoutData: {
      checkoutRequestId: "chk_1",
      cartItems: "{}",
    },
    config,
    orderId: "",
    totalAmount: 125,
    advanceAmount: 50,
    currencySymbol: "৳",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  mocks.createOrder.mockResolvedValue({
    orderId: "order_1",
    receiptToken: "receipt_1",
    totalAmount: 125,
    paymentMethod: "sslcommerz",
  });
  vi.stubGlobal("fetch", vi.fn());
});

describe("hosted online payment handlers", () => {
  it.each([
    {
      label: "SSLCommerz",
      handler: sslcommerzHandler,
      endpoint: "/api/checkout/sslcommerz-session",
      gateway: "sslcommerz",
      successBody: { gatewayUrl: "https://ssl.example.test/pay" },
    },
    {
      label: "Polar",
      handler: polarHandler,
      endpoint: "/api/checkout/polar-session",
      gateway: "polar",
      successBody: { gatewayUrl: "https://polar.example.test/pay" },
    },
  ])("lets the API derive payment type for $label sessions", async ({
    handler,
    endpoint,
    successBody,
  }) => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => successBody,
    } as Response);

    const result = await handler.processPayment(makeContext());

    expect(result).toEqual({
      success: true,
      redirectUrl: successBody.gatewayUrl,
      clearCheckoutSessionOnRedirect: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        method: "POST",
        body: expect.any(String),
      }),
    );
    const payload = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(payload).toMatchObject({
      orderId: "order_1",
      receiptToken: "receipt_1",
    });
    expect(payload).not.toHaveProperty("paymentType");
    expect(payload).not.toHaveProperty("depositAmount");
  });

  it.each([
    { handler: sslcommerzHandler, gateway: "sslcommerz" },
    { handler: polarHandler, gateway: "polar" },
  ])("returns a receipt recovery URL after $gateway order creation when session setup fails", async ({
    handler,
    gateway,
  }) => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Gateway unavailable" }),
    } as Response);

    const result = await handler.processPayment(makeContext());

    expect(result.success).toBe(true);
    expect(result.clearCheckoutSessionOnRedirect).toBe(true);
    expect(result.redirectUrl).toBe(
      `/order-success?orderId=order_1&token=receipt_1&payment=${gateway}&result=failed&paymentType=deposit&depositAmount=50`,
    );
  });
});

describe("Stripe checkout handler", () => {
  it("keeps card payment failures on checkout instead of redirecting to hosted recovery", async () => {
    document.body.innerHTML = `
      <div id="stripeCardElement"></div>
      <div id="stripeError"></div>
    `;
    const stripeCard = {
      mount: vi.fn(),
      on: vi.fn(),
    };
    const stripeInstance = {
      elements: vi.fn(() => ({
        create: vi.fn(() => stripeCard),
      })),
      confirmCardPayment: vi.fn(),
    };
    vi.stubGlobal("Stripe", vi.fn(() => stripeInstance));
    const container = document.createElement("div");
    container.dataset.publishableKey = "pk_test";
    await stripeHandler.onSelect?.(container);

    mocks.createOrder.mockResolvedValueOnce({
      orderId: "order_1",
      receiptToken: "receipt_1",
      totalAmount: 125,
      paymentMethod: "stripe",
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Stripe unavailable" }),
    } as Response);

    const result = await stripeHandler.processPayment(makeContext());

    expect(result).toEqual({
      success: false,
      error: "Stripe unavailable",
    });
    expect(result.redirectUrl).toBeUndefined();
    expect(result.clearCheckoutSessionOnRedirect).toBeUndefined();
  });
});
