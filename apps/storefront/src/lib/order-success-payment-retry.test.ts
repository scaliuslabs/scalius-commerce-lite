import { describe, expect, it } from "vitest";

import {
  canRetryOrderSuccessPayment,
  getOrderSuccessRetryEndpoint,
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
