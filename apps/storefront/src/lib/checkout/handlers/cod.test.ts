// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

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
import { codHandler } from "./cod";
import type { PaymentContext } from "../types";

const context: PaymentContext = {
  checkoutData: {
    checkoutRequestId: "chk_cod",
    cartItems: "{}",
  },
  config: {
    gateways: [],
    guestCheckoutEnabled: true,
    authVerificationMethod: "email",
    checkoutMode: "all",
    partialPaymentEnabled: false,
    partialPaymentAmount: 0,
  },
  orderId: "",
  totalAmount: 125,
  advanceAmount: 125,
  currencySymbol: "BDT",
};

describe("COD checkout handler", () => {
  it("records safe recovery as soon as the order is committed", async () => {
    mocks.createOrder.mockResolvedValueOnce({ orderId: "order_cod" });
    const onOrderCreated = vi.fn();

    const result = await codHandler.processPayment({ ...context, onOrderCreated });

    expect(onOrderCreated).toHaveBeenCalledWith("order_cod", "cod");
    expect(result).toEqual({
      success: true,
      redirectUrl: "/order-success?orderId=order_cod",
    });
  });

  it("returns backend order failure status before redirect", async () => {
    mocks.createOrder.mockRejectedValueOnce(new CheckoutOrderError(
      "Order creation failed (429)",
      {
        status: 429,
        errorCode: "CHECKOUT_RATE_LIMITED",
        details: { retryAfterSeconds: 60 },
        cartIssues: [],
      },
    ));

    const result = await codHandler.processPayment(context);

    expect(result).toMatchObject({
      success: false,
      error: "Order creation failed (429)",
      errorCode: "CHECKOUT_RATE_LIMITED",
      status: 429,
    });
  });
});
