// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOrder: vi.fn(),
}));

vi.mock("../create-order", () => ({
  createOrder: mocks.createOrder,
  CheckoutOrderError: class CheckoutOrderError extends Error {
    status: number;
    errorCode?: string;
    details: unknown;
    cartIssues: unknown[];

    constructor(message: string, options: {
      status?: number;
      errorCode?: string;
      details?: unknown;
      cartIssues?: unknown[];
    } = {}) {
      super(message);
      this.status = options.status ?? 400;
      this.errorCode = options.errorCode;
      this.details = options.details;
      this.cartIssues = options.cartIssues ?? [];
    }
  },
}));

import { CheckoutOrderError } from "../create-order";
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

function recoveryUrl(gateway: string): string {
  return `/order-success?orderId=order_1&payment=${gateway}&result=failed&paymentType=deposit&depositAmount=50`;
}

function failedRecoveryUrl(gateway: string): string {
  return recoveryUrl(gateway);
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  mocks.createOrder.mockResolvedValue({
    orderId: "order_1",
    totalAmount: 125,
    paymentMethod: "sslcommerz",
  });
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
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
    gateway,
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
      clearCartOnRedirect: true,
      hostedPaymentRecoveryUrl: recoveryUrl(gateway),
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
    });
    expect(payload).not.toHaveProperty("receiptToken");
    expect(payload).not.toHaveProperty("token");
    expect(payload).not.toHaveProperty("receipt_token");
    expect(payload).not.toHaveProperty("paymentType");
    expect(payload).not.toHaveProperty("depositAmount");
  });

  it.each([
    {
      label: "SSLCommerz",
      handler: sslcommerzHandler,
      gateway: "sslcommerz",
      gatewayUrl: "https://ssl.example.test/pay",
    },
    {
      label: "Polar",
      handler: polarHandler,
      gateway: "polar",
      gatewayUrl: "https://polar.example.test/pay",
    },
  ])("uses the fused $label session returned by order creation", async ({
    handler,
    gateway,
    gatewayUrl,
  }) => {
    mocks.createOrder.mockResolvedValueOnce({
      orderId: "order_1",
      totalAmount: 125,
      paymentMethod: gateway,
      initialPaymentSession: {
        gateway,
        gatewayUrl,
      },
    });

    const result = await handler.processPayment(makeContext());

    expect(result).toEqual({
      success: true,
      redirectUrl: gatewayUrl,
      clearCartOnRedirect: true,
      hostedPaymentRecoveryUrl: recoveryUrl(gateway),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries SSLCommerz session creation when the committed order is still processing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({
          status: "processing",
          retryable: true,
          retryAfterSeconds: 2,
          message: "Payment session creation is already processing. Please try again shortly.",
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          gatewayUrl: "https://ssl.example.test/pay",
        }),
      } as Response);

    const resultPromise = sslcommerzHandler.processPayment(makeContext());
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      success: true,
      redirectUrl: "https://ssl.example.test/pay",
      clearCartOnRedirect: true,
      hostedPaymentRecoveryUrl: recoveryUrl("sslcommerz"),
    });
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
    expect(result.clearCartOnRedirect).toBe(true);
    expect(result.redirectUrl).toBe(
      failedRecoveryUrl(gateway),
    );
    expect(result.hostedPaymentRecoveryUrl).toBe(failedRecoveryUrl(gateway));
  });

  it.each([
    { handler: sslcommerzHandler, gateway: "sslcommerz" },
    { handler: polarHandler, gateway: "polar" },
  ])("returns a receipt recovery URL after $gateway order creation when session setup is still processing", async ({
    handler,
    gateway,
  }) => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({
        status: "processing",
        retryable: true,
        retryAfterSeconds: 30,
        message: "Payment session creation is already processing. Please try again shortly.",
      }),
    } as Response);

    const result = await handler.processPayment(makeContext());

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.clearCartOnRedirect).toBe(true);
    expect(result.redirectUrl).toBe(
      failedRecoveryUrl(gateway),
    );
    expect(result.hostedPaymentRecoveryUrl).toBe(failedRecoveryUrl(gateway));
  });

  it.each([
    { handler: sslcommerzHandler, gateway: "sslcommerz" },
    { handler: polarHandler, gateway: "polar" },
  ])("does not retry $gateway session creation when fused initialization already failed", async ({
    handler,
    gateway,
  }) => {
    mocks.createOrder.mockResolvedValueOnce({
      orderId: "order_1",
      totalAmount: 125,
      paymentMethod: gateway,
      initialPaymentSessionError: "Gateway timeout",
    });

    const result = await handler.processPayment(makeContext());

    expect(fetch).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.clearCartOnRedirect).toBe(true);
    expect(result.redirectUrl).toBe(
      failedRecoveryUrl(gateway),
    );
    expect(result.hostedPaymentRecoveryUrl).toBe(failedRecoveryUrl(gateway));
  });

  it.each([
    { handler: sslcommerzHandler, gateway: "sslcommerz" },
    { handler: polarHandler, gateway: "polar" },
  ])("returns backend order failure status for $gateway before payment setup", async ({
    handler,
  }) => {
    mocks.createOrder.mockRejectedValueOnce(new CheckoutOrderError(
      "Order creation failed (503)",
      {
        status: 503,
        errorCode: "CHECKOUT_CONFIG_UNAVAILABLE",
        details: { retryable: true },
        cartIssues: [],
      },
    ));

    const result = await handler.processPayment(makeContext());

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      error: "Order creation failed (503)",
      errorCode: "CHECKOUT_CONFIG_UNAVAILABLE",
      status: 503,
    });
  });
});

describe("Stripe checkout handler", () => {
  it("does not create an order until the Stripe card form is complete", async () => {
    document.body.innerHTML = `
      <div id="stripeSection">
        <div id="stripeCardElement"></div>
        <div id="stripeError"></div>
      </div>
      <button id="payButton"></button>
    `;
    let changeHandler: ((event: { complete?: boolean }) => void) | undefined;
    const stripeCard = {
      mount: vi.fn(),
      on: vi.fn((_event: string, handler: (event: { complete?: boolean }) => void) => {
        changeHandler = handler;
      }),
    };
    const stripeInstance = {
      elements: vi.fn(() => ({ create: vi.fn(() => stripeCard) })),
      confirmCardPayment: vi.fn(),
    };
    vi.stubGlobal("Stripe", vi.fn(() => stripeInstance));
    const container = document.getElementById("stripeSection") as HTMLElement;
    container.dataset.publishableKey = "pk_incomplete";
    await stripeHandler.onSelect?.(container);

    expect(stripeHandler.isReady?.()).toBe(false);
    expect(await stripeHandler.processPayment(makeContext())).toEqual({
      success: false,
      error: "Complete your card details before paying.",
    });
    expect(mocks.createOrder).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(stripeInstance.confirmCardPayment).not.toHaveBeenCalled();

    changeHandler?.({ complete: true });
    expect(stripeHandler.isReady?.()).toBe(true);
    expect((document.getElementById("payButton") as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps card payment failures on checkout instead of redirecting to hosted recovery", async () => {
    document.body.innerHTML = `
      <div id="stripeCardElement"></div>
      <div id="stripeError"></div>
    `;
    const stripeCard = {
      mount: vi.fn(),
      on: vi.fn((_event, handler) => handler({ complete: true })),
    };
    const stripeInstance = {
      elements: vi.fn(() => ({
        create: vi.fn(() => stripeCard),
      })),
      confirmCardPayment: vi.fn(),
    };
    vi.stubGlobal("Stripe", vi.fn(() => stripeInstance));
    const container = document.createElement("div");
    container.dataset.publishableKey = "pk_failure";
    await stripeHandler.onSelect?.(container);

    mocks.createOrder.mockResolvedValueOnce({
      orderId: "order_1",
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

  it("creates a Stripe intent after order commit when no fused session is returned", async () => {
    document.body.innerHTML = `
      <div id="stripeCardElement"></div>
      <div id="stripeError"></div>
    `;
    const stripeCard = {
      mount: vi.fn(),
      on: vi.fn((_event, handler) => handler({ complete: true })),
    };
    const stripeInstance = {
      elements: vi.fn(() => ({
        create: vi.fn(() => stripeCard),
      })),
      confirmCardPayment: vi.fn(async () => ({
        paymentIntent: { status: "succeeded" },
      })),
    };
    vi.stubGlobal("Stripe", vi.fn(() => stripeInstance));
    const container = document.createElement("div");
    container.dataset.publishableKey = "pk_fallback";
    await stripeHandler.onSelect?.(container);

    mocks.createOrder.mockResolvedValueOnce({
      orderId: "order_1",
      totalAmount: 125,
      paymentMethod: "stripe",
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        clientSecret: "pi_secret_fallback",
      }),
    } as Response);

    const result = await stripeHandler.processPayment(makeContext());

    expect(fetch).toHaveBeenCalledWith(
      "/api/checkout/stripe-intent",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ orderId: "order_1" }),
      }),
    );
    expect(stripeInstance.confirmCardPayment).toHaveBeenCalledWith("pi_secret_fallback", {
      payment_method: { card: stripeCard },
    });
    expect(result).toEqual({
      success: true,
      redirectUrl: "/order-success?orderId=order_1&payment=stripe",
    });
  });

  it("retries Stripe intent creation when the committed order is still processing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    document.body.innerHTML = `
      <div id="stripeCardElement"></div>
      <div id="stripeError"></div>
    `;
    const stripeCard = {
      mount: vi.fn(),
      on: vi.fn((_event, handler) => handler({ complete: true })),
    };
    const stripeInstance = {
      elements: vi.fn(() => ({
        create: vi.fn(() => stripeCard),
      })),
      confirmCardPayment: vi.fn(async () => ({
        paymentIntent: { status: "succeeded" },
      })),
    };
    vi.stubGlobal("Stripe", vi.fn(() => stripeInstance));
    const container = document.createElement("div");
    container.dataset.publishableKey = "pk_retry";
    await stripeHandler.onSelect?.(container);

    mocks.createOrder.mockResolvedValueOnce({
      orderId: "order_1",
      totalAmount: 125,
      paymentMethod: "stripe",
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({
          status: "processing",
          retryable: true,
          retryAfterSeconds: 2,
          message: "Payment session creation is already processing. Please try again shortly.",
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          clientSecret: "pi_secret_retry",
        }),
      } as Response);

    const resultPromise = stripeHandler.processPayment(makeContext());
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(stripeInstance.confirmCardPayment).toHaveBeenCalledWith("pi_secret_retry", {
      payment_method: { card: stripeCard },
    });
    expect(result).toEqual({
      success: true,
      redirectUrl: "/order-success?orderId=order_1&payment=stripe",
    });
  });

  it("does not confirm Stripe payment while intent creation is still processing", async () => {
    document.body.innerHTML = `
      <div id="stripeCardElement"></div>
      <div id="stripeError"></div>
    `;
    const stripeCard = {
      mount: vi.fn(),
      on: vi.fn((_event, handler) => handler({ complete: true })),
    };
    const stripeInstance = {
      elements: vi.fn(() => ({
        create: vi.fn(() => stripeCard),
      })),
      confirmCardPayment: vi.fn(),
    };
    vi.stubGlobal("Stripe", vi.fn(() => stripeInstance));
    const container = document.createElement("div");
    container.dataset.publishableKey = "pk_processing";
    await stripeHandler.onSelect?.(container);

    mocks.createOrder.mockResolvedValueOnce({
      orderId: "order_1",
      totalAmount: 125,
      paymentMethod: "stripe",
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({
        status: "processing",
        retryable: true,
        retryAfterSeconds: 30,
        message: "Payment session creation is already processing. Please try again shortly.",
      }),
    } as Response);

    const result = await stripeHandler.processPayment(makeContext());

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(stripeInstance.confirmCardPayment).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: "Payment session creation is already processing. Please try again shortly.",
    });
  });

  it("uses the fused Stripe PaymentIntent returned by order creation", async () => {
    document.body.innerHTML = `
      <div id="stripeCardElement"></div>
      <div id="stripeError"></div>
    `;
    const stripeCard = {
      mount: vi.fn(),
      on: vi.fn((_event, handler) => handler({ complete: true })),
    };
    const stripeInstance = {
      elements: vi.fn(() => ({
        create: vi.fn(() => stripeCard),
      })),
      confirmCardPayment: vi.fn(async () => ({
        paymentIntent: { status: "succeeded" },
      })),
    };
    vi.stubGlobal("Stripe", vi.fn(() => stripeInstance));
    const container = document.createElement("div");
    container.dataset.publishableKey = "pk_fused";
    await stripeHandler.onSelect?.(container);

    mocks.createOrder.mockResolvedValueOnce({
      orderId: "order_1",
      totalAmount: 125,
      paymentMethod: "stripe",
      initialPaymentSession: {
        gateway: "stripe",
        clientSecret: "pi_secret_1",
      },
    });

    const result = await stripeHandler.processPayment(makeContext());

    expect(fetch).not.toHaveBeenCalled();
    expect(stripeInstance.confirmCardPayment).toHaveBeenCalledWith("pi_secret_1", {
      payment_method: { card: stripeCard },
    });
    expect(result).toEqual({
      success: true,
      redirectUrl: "/order-success?orderId=order_1&payment=stripe",
    });
  });

  it("does not retry Stripe intent creation when fused initialization already failed", async () => {
    document.body.innerHTML = `
      <div id="stripeCardElement"></div>
      <div id="stripeError"></div>
    `;
    const stripeCard = {
      mount: vi.fn(),
      on: vi.fn((_event, handler) => handler({ complete: true })),
    };
    const stripeInstance = {
      elements: vi.fn(() => ({
        create: vi.fn(() => stripeCard),
      })),
      confirmCardPayment: vi.fn(),
    };
    vi.stubGlobal("Stripe", vi.fn(() => stripeInstance));
    const container = document.createElement("div");
    container.dataset.publishableKey = "pk_timeout";
    await stripeHandler.onSelect?.(container);

    mocks.createOrder.mockResolvedValueOnce({
      orderId: "order_1",
      totalAmount: 125,
      paymentMethod: "stripe",
      initialPaymentSessionError: "Stripe timeout",
    });

    const result = await stripeHandler.processPayment(makeContext());

    expect(fetch).not.toHaveBeenCalled();
    expect(stripeInstance.confirmCardPayment).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: "Stripe timeout",
    });
  });
});
