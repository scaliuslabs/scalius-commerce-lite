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
  it("allows receipt-page retry for hosted gateway cancel and failure returns", () => {
    expect(isRetryableHostedPaymentMethod("sslcommerz")).toBe(true);
    expect(isRetryableHostedPaymentMethod("polar")).toBe(true);
    expect(isHostedPaymentRetryResult("cancelled")).toBe(true);
    expect(isHostedPaymentRetryResult("failed")).toBe(true);
    expect(getOrderSuccessRetryEndpoint("sslcommerz")).toBe("/api/checkout/sslcommerz-session");
    expect(getOrderSuccessRetryEndpoint("polar")).toBe("/api/checkout/polar-session");

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

  it("does not offer hosted retry for non-hosted methods or ordinary pending receipts", () => {
    expect(isRetryableHostedPaymentMethod("stripe")).toBe(false);
    expect(getOrderSuccessRetryEndpoint("cod")).toBeNull();
    expect(
      canRetryOrderSuccessPayment(
        { paymentMethod: "sslcommerz" },
        "payment_pending",
        null,
      ),
    ).toBe(false);
  });

  it("returns only the current hosted gateway for callback-only cancelled receipts", () => {
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
      },
      {
        gateway: "polar",
        endpoint: "/api/checkout/polar-session",
        current: false,
        label: "Pay with Polar",
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
      },
    ]);
  });

  it("fails closed when checkout config exposes no hosted retry gateway", () => {
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
