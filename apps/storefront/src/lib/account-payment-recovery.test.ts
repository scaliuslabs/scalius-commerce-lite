import { describe, expect, it } from "vitest";

import {
  getAccountPaymentRecoveryAction,
  getAccountPaymentReturnNotice,
  normalizeHostedGatewayUrl,
} from "./account-payment-recovery";
import type { CustomerPaymentRecovery } from "./api/customer-auth";

function recovery(overrides: Partial<CustomerPaymentRecovery> = {}): CustomerPaymentRecovery {
  return {
    eligible: true,
    gateway: "sslcommerz",
    paymentType: "full",
    amountDue: 1200,
    label: "Retry payment",
    reason: null,
    requiresCardForm: false,
    hostedRedirect: true,
    ...overrides,
  };
}

describe("account payment recovery", () => {
  it("builds retry and balance actions from backend recovery policy", () => {
    expect(getAccountPaymentRecoveryAction(recovery())).toMatchObject({
      visible: true,
      title: "Payment needs attention",
      buttonLabel: "Retry payment",
      amountDue: 1200,
      hostedRedirect: true,
    });

    expect(
      getAccountPaymentRecoveryAction(recovery({
        paymentType: "balance",
        amountDue: 900,
        label: "Pay balance",
      })),
    ).toMatchObject({
      title: "Remaining balance is due",
      buttonLabel: "Pay balance",
      amountDue: 900,
    });
  });

  it("uses card copy for Stripe and hides ineligible recovery", () => {
    expect(
      getAccountPaymentRecoveryAction(recovery({
        gateway: "stripe",
        requiresCardForm: true,
        hostedRedirect: false,
      })),
    ).toMatchObject({
      buttonLabel: "Enter card details",
      requiresCardForm: true,
      hostedRedirect: false,
    });

    expect(getAccountPaymentRecoveryAction(recovery({ eligible: false }))).toBeNull();
  });

  it("normalizes account gateway return notices without trusting them as payment truth", () => {
    expect(getAccountPaymentReturnNotice("sslcommerz", "cancelled")).toMatchObject({
      tone: "warning",
      title: "Payment was cancelled",
    });
    expect(getAccountPaymentReturnNotice("polar", "failed")).toMatchObject({
      tone: "warning",
      title: "Payment did not complete",
    });
    expect(getAccountPaymentReturnNotice("stripe", null)).toMatchObject({
      tone: "info",
      title: "Payment submitted",
    });
    expect(getAccountPaymentReturnNotice("cod", "failed")).toBeNull();
  });

  it("accepts only absolute HTTP(S) hosted gateway URLs", () => {
    expect(normalizeHostedGatewayUrl("https://sandbox.sslcommerz.com/pay")).toBe(
      "https://sandbox.sslcommerz.com/pay",
    );
    expect(normalizeHostedGatewayUrl("http://localhost:8787/pay")).toBe(
      "http://localhost:8787/pay",
    );
    expect(normalizeHostedGatewayUrl("/checkout")).toBeNull();
    expect(normalizeHostedGatewayUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeHostedGatewayUrl("")).toBeNull();
  });
});
