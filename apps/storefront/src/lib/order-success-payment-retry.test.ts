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
    paymentMethod: "scalius.bangladesh:sslcommerz",
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
    expect(isRetryableHostedPaymentMethod("scalius.bangladesh:sslcommerz")).toBe(true);
    expect(isRetryableHostedPaymentMethod("stripe")).toBe(true);
    expect(isHostedPaymentRetryResult("cancelled")).toBe(true);
    expect(isHostedPaymentRetryResult("failed")).toBe(true);
    expect(getOrderSuccessRetryEndpoint("scalius.bangladesh:sslcommerz")).toBe("/api/checkout/payment-session/scalius.bangladesh:sslcommerz");
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
          { id: "scalius.bangladesh:sslcommerz" },
          { id: "stripe" },
          { id: "cod" },
        ],
      ),
    ).toEqual([
      {
        gateway: "scalius.bangladesh:sslcommerz",
        endpoint: "/api/checkout/payment-session/scalius.bangladesh:sslcommerz",
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
          { id: "scalius.bangladesh:sslcommerz" },
          { id: "stripe" },
          { id: "cod" },
        ],
      ),
    ).toEqual([
      {
        gateway: "scalius.bangladesh:sslcommerz",
        endpoint: "/api/checkout/payment-session/scalius.bangladesh:sslcommerz",
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

  it("retries an app's wallet by its checkout name at its own session endpoint", () => {
    const bkash = "scalius.bangladesh:bkash";
    expect(isRetryableHostedPaymentMethod(bkash)).toBe(true);
    expect(getOrderSuccessRetryEndpoint(bkash)).toBe(`/api/checkout/payment-session/${bkash}`);
    expect(
      getOrderSuccessRetryOptions(
        makeRetryOrder({ paymentMethod: bkash, paymentStatus: "failed" }),
        "payment_issue",
        "cancelled",
        [
          { id: "cod", name: "Cash on Delivery" },
          { id: bkash, name: "bKash" },
          { id: "scalius.bangladesh:nagad", name: "Nagad" },
          { id: "scalius.bangladesh:sslcommerz", name: "SSLCommerz" },
        ],
      ),
    ).toEqual([
      { gateway: bkash, endpoint: `/api/checkout/payment-session/${bkash}`, current: true, label: "bKash", requiresCardForm: false },
      {
        gateway: "scalius.bangladesh:nagad",
        endpoint: "/api/checkout/payment-session/scalius.bangladesh:nagad",
        current: false,
        label: "Nagad",
        requiresCardForm: false,
      },
      { gateway: "scalius.bangladesh:sslcommerz", endpoint: "/api/checkout/payment-session/scalius.bangladesh:sslcommerz", current: false, label: "Pay online", requiresCardForm: false },
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

  it("never treats a gift-card-paid order as a hosted gateway to retry", () => {
    expect(isRetryableHostedPaymentMethod("gift_card")).toBe(false);
    expect(getOrderSuccessRetryEndpoint("gift_card")).toBeNull();
    // Even a (hypothetical) unpaid gift_card order with money due offers no gateway.
    const order = makeRetryOrder({ paymentMethod: "gift_card", paymentStatus: "unpaid", paidAmount: 0, balanceDue: 500 });
    expect(canRetryOrderSuccessPayment(order, "payment_issue", "failed")).toBe(false);
    expect(getOrderSuccessRetryOptions(order, "payment_issue", "failed", [{ id: "gift_card" }, { id: "scalius.bangladesh:sslcommerz" }])).toEqual([]);
    // A card + gateway order keeps its gateway retry for the amount due.
    expect(isRetryableHostedPaymentMethod("scalius.bangladesh:sslcommerz")).toBe(true);
    expect(getOrderSuccessRetryOptions(
      makeRetryOrder({ paymentMethod: "scalius.bangladesh:sslcommerz", status: "incomplete", paymentStatus: "partial", paidAmount: 400, balanceDue: 800 }),
      "payment_issue",
      null,
      [{ id: "gift_card" }, { id: "scalius.bangladesh:sslcommerz" }],
    ).map(({ gateway }) => gateway)).toEqual(["scalius.bangladesh:sslcommerz"]);
  });
});
