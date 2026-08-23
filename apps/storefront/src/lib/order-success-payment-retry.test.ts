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

describe("order success payment retry", () => {
  it("allows receipt-page retry for online gateway cancel and failure returns", () => {
    expect(isRetryableHostedPaymentMethod("sslcommerz")).toBe(true);
    expect(isRetryableHostedPaymentMethod("polar")).toBe(true);
    expect(isRetryableHostedPaymentMethod("stripe")).toBe(true);
    expect(isHostedPaymentRetryResult("cancelled")).toBe(true);
    expect(isHostedPaymentRetryResult("failed")).toBe(true);
    expect(getOrderSuccessRetryEndpoint("sslcommerz")).toBe("/api/checkout/sslcommerz-session");
    expect(getOrderSuccessRetryEndpoint("polar")).toBe("/api/checkout/polar-session");
    expect(getOrderSuccessRetryEndpoint("stripe")).toBe("/api/checkout/stripe-intent");

    expect(
      canRetryOrderSuccessPayment(
        { paymentMethod: "sslcommerz" },
        "payment_pending",
        "cancelled",
      ),
    ).toBe(true);
  });

  it("allows hosted payment-issue receipts even without a callback result", () => {
    expect(
      canRetryOrderSuccessPayment(
        { paymentMethod: "polar" },
        "payment_issue",
        null,
      ),
    ).toBe(true);
  });

  it("does not offer online retry for COD or ordinary pending receipts", () => {
    expect(getOrderSuccessRetryEndpoint("cod")).toBeNull();
    expect(
      canRetryOrderSuccessPayment(
        { paymentMethod: "sslcommerz" },
        "payment_pending",
        null,
      ),
    ).toBe(false);
  });

  it("offers every visible online method for an explicitly cancelled receipt", () => {
    expect(
      getOrderSuccessRetryOptions(
        { paymentMethod: "sslcommerz" },
        "payment_pending",
        "cancelled",
        [
          { id: "sslcommerz" },
          { id: "polar" },
          { id: "stripe" },
          { id: "cod" },
        ],
      ),
    ).toEqual([
      {
        gateway: "sslcommerz",
        endpoint: "/api/checkout/sslcommerz-session",
        current: true,
        label: "Retry payment",
        requiresCardForm: false,
      },
      {
        gateway: "polar",
        endpoint: "/api/checkout/polar-session",
        current: false,
        label: "Pay with Polar",
        requiresCardForm: false,
      },
      {
        gateway: "stripe",
        endpoint: "/api/checkout/stripe-intent",
        current: false,
        label: "Pay with international card",
        requiresCardForm: true,
      },
    ]);
  });

  it("returns alternate visible hosted gateways for durable payment issues", () => {
    expect(
      getOrderSuccessRetryOptions(
        { paymentMethod: "sslcommerz" },
        "payment_issue",
        null,
        [
          { id: "sslcommerz" },
          { id: "polar" },
          { id: "stripe" },
          { id: "cod" },
        ],
      ),
    ).toEqual([
      {
        gateway: "sslcommerz",
        endpoint: "/api/checkout/sslcommerz-session",
        current: true,
        label: "Retry payment",
        requiresCardForm: false,
      },
      {
        gateway: "polar",
        endpoint: "/api/checkout/polar-session",
        current: false,
        label: "Pay with Polar",
        requiresCardForm: false,
      },
      {
        gateway: "stripe",
        endpoint: "/api/checkout/stripe-intent",
        current: false,
        label: "Pay with international card",
        requiresCardForm: true,
      },
    ]);
  });

  it("allows a durable payment issue to switch away from a now-hidden current gateway", () => {
    expect(
      getOrderSuccessRetryOptions(
        { paymentMethod: "sslcommerz" },
        "payment_issue",
        null,
        [{ id: "polar" }],
      ),
    ).toEqual([
      {
        gateway: "polar",
        endpoint: "/api/checkout/polar-session",
        current: false,
        label: "Pay with Polar",
        requiresCardForm: false,
      },
    ]);
  });

  it("uses Stripe as an alternate when it is the only visible online retry gateway", () => {
    expect(
      getOrderSuccessRetryOptions(
        { paymentMethod: "sslcommerz" },
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
        endpoint: "/api/checkout/stripe-intent",
        current: false,
        label: "Pay with international card",
        requiresCardForm: true,
      },
    ]);
  });

  it("fails closed when checkout config exposes only COD", () => {
    expect(
      getOrderSuccessRetryOptions(
        { paymentMethod: "sslcommerz" },
        "payment_issue",
        "failed",
        [{ id: "cod" }],
      ),
    ).toEqual([]);
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
