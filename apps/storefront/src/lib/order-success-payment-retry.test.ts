import { describe, expect, it } from "vitest";

import {
  canRetryOrderSuccessPayment,
  getOrderSuccessRetryEndpoint,
  getOrderSuccessRetryOptions,
  isHostedPaymentRetryResult,
  isRetryableHostedPaymentMethod,
  normalizeRetryDepositAmount,
  resolveOrderSuccessRetryPaymentType,
} from "./order-success-payment-retry";

function makeRetryOrder(overrides: Partial<{
  paymentMethod: string;
  status: string;
  paymentStatus: string;
  totalAmount: number;
  paidAmount: number;
  balanceDue: number;
}> = {}) {
  return {
    paymentMethod: "sslcommerz",
    status: "incomplete",
    paymentStatus: "unpaid",
    totalAmount: 1200,
    paidAmount: 0,
    balanceDue: 1200,
    ...overrides,
  };
}

describe("order success payment retry", () => {
  it("recognizes callback outcomes while allowing pending hosted payment continuation", () => {
    expect(isRetryableHostedPaymentMethod("sslcommerz")).toBe(true);
    expect(isRetryableHostedPaymentMethod("stripe")).toBe(true);
    expect(isHostedPaymentRetryResult("cancelled")).toBe(true);
    expect(isHostedPaymentRetryResult("failed")).toBe(true);
    expect(getOrderSuccessRetryEndpoint("sslcommerz")).toBe("/api/checkout/payment-session/sslcommerz");
    expect(getOrderSuccessRetryEndpoint("stripe")).toBe("/api/checkout/payment-session/stripe");

    expect(
      canRetryOrderSuccessPayment(
        makeRetryOrder(),
        "payment_pending",
        "cancelled",
      ),
    ).toBe(true);
  });

  it("allows hosted payment-issue receipts even without a callback result", () => {
    expect(
      canRetryOrderSuccessPayment(
        makeRetryOrder({ paymentMethod: "stripe", paymentStatus: "failed" }),
        "payment_issue",
        null,
      ),
    ).toBe(true);
  });

  it("does not offer online retry for COD receipts", () => {
    expect(getOrderSuccessRetryEndpoint("cod")).toBeNull();
    expect(
      canRetryOrderSuccessPayment(
        makeRetryOrder({ paymentMethod: "cod" }),
        "payment_pending",
        null,
      ),
    ).toBe(false);
  });

  it("does not trust a stale or forged cancelled query to unlock alternate gateways", () => {
    expect(
      getOrderSuccessRetryOptions(
        makeRetryOrder(),
        "payment_pending",
        "cancelled",
        [
          { id: "sslcommerz" },
          { id: "stripe" },
          { id: "cod" },
        ],
      ),
    ).toEqual([
      {
        gateway: "sslcommerz",
        endpoint: "/api/checkout/payment-session/sslcommerz",
        current: true,
        label: "Pay online",
        requiresCardForm: false,
      },
    ]);
  });

  it("returns alternate visible hosted gateways for durable payment issues", () => {
    expect(
      getOrderSuccessRetryOptions(
        makeRetryOrder({ paymentStatus: "failed" }),
        "payment_issue",
        null,
        [
          { id: "sslcommerz" },
          { id: "stripe" },
          { id: "cod" },
        ],
      ),
    ).toEqual([
      {
        gateway: "sslcommerz",
        endpoint: "/api/checkout/payment-session/sslcommerz",
        current: true,
        label: "Pay online",
        requiresCardForm: false,
      },
      {
        gateway: "stripe",
        endpoint: "/api/checkout/payment-session/stripe",
        current: false,
        label: "Credit or debit card",
        requiresCardForm: true,
      },
    ]);
  });

  it("uses Stripe as an alternate when it is the only visible online retry gateway", () => {
    expect(
      getOrderSuccessRetryOptions(
        makeRetryOrder({ paymentStatus: "failed" }),
        "payment_issue",
        "failed",
        [
          { id: "stripe" },
          { id: "cod" },
        ],
      ),
    ).toEqual([
      {
        gateway: "stripe",
        endpoint: "/api/checkout/payment-session/stripe",
        current: false,
        label: "Credit or debit card",
        requiresCardForm: true,
      },
    ]);
  });

  it("fails closed when checkout config exposes only COD", () => {
    expect(
      getOrderSuccessRetryOptions(
        makeRetryOrder({ paymentStatus: "failed" }),
        "payment_issue",
        "failed",
        [{ id: "cod" }],
      ),
    ).toEqual([]);
  });

  it.each([
    { status: "cancelled", paymentStatus: "unpaid", balanceDue: 1200 },
    { status: "returned", paymentStatus: "unpaid", balanceDue: 1200 },
    { status: "refunded", paymentStatus: "refunded", balanceDue: 1200 },
    { status: "confirmed", paymentStatus: "paid", balanceDue: 0 },
  ])("never offers retry for a terminal or paid order", (state) => {
    expect(canRetryOrderSuccessPayment(
      makeRetryOrder(state),
      "order_updated",
      "failed",
    )).toBe(false);
  });

  it("preserves callback payment type and falls back to balance for partial receipts", () => {
    expect(
      resolveOrderSuccessRetryPaymentType(
        { paymentStatus: "unpaid", paidAmount: 0, balanceDue: 1200 },
        "deposit",
      ),
    ).toBe("deposit");

    expect(
      resolveOrderSuccessRetryPaymentType(
        { paymentStatus: "partial", paidAmount: 300, balanceDue: 900 },
        null,
      ),
    ).toBe("balance");
  });

  it("normalizes deposit amounts for retry payloads", () => {
    expect(normalizeRetryDepositAmount("60")).toBe(60);
    expect(normalizeRetryDepositAmount("0")).toBeNull();
    expect(normalizeRetryDepositAmount("not-a-number")).toBeNull();
  });
});
