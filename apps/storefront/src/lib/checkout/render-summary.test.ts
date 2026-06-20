// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import {
  renderOrderSummaryDetails,
  shouldClearCheckoutBeforeRedirect,
  shouldClearCheckoutSessionBeforeRedirect,
} from "./index";
import type { CheckoutConfig } from "./types";

const baseConfig: CheckoutConfig = {
  gateways: [],
  guestCheckoutEnabled: true,
  authVerificationMethod: "email",
  checkoutMode: "single",
  partialPaymentEnabled: false,
  partialPaymentAmount: 0,
};

describe("renderOrderSummaryDetails", () => {
  it("renders customer checkout data as text, not HTML", () => {
    const details = document.createElement("div");

    renderOrderSummaryDetails(
      details,
      {
        cartItems: JSON.stringify({
          line_1: { price: 100, quantity: 2 },
        }),
        shippingCharge: "40",
        discountAmount: "10",
        customerName: '<img src=x onerror="window.__pwned=true">',
        shippingAddress: "<script>window.__pwned=true</script>",
      },
      baseConfig,
    );

    expect(details.querySelector("img")).toBeNull();
    expect(details.querySelector("script")).toBeNull();
    expect(details.textContent).toContain('<img src=x onerror="window.__pwned=true">');
    expect(details.textContent).toContain("<script>window.__pwned=true</script>");
  });
});

describe("checkout redirect cleanup", () => {
  it("distinguishes cart cleanup from checkout transfer cleanup", () => {
    expect(
      shouldClearCheckoutBeforeRedirect({
        success: true,
        redirectUrl: "https://gateway.example/checkout",
      }),
    ).toBe(false);
    expect(
      shouldClearCheckoutSessionBeforeRedirect({
        success: true,
        redirectUrl: "https://gateway.example/checkout",
      }),
    ).toBe(false);

    expect(
      shouldClearCheckoutBeforeRedirect({
        success: true,
        redirectUrl: "/order-success?orderId=1&token=receipt",
        clearCartOnRedirect: true,
      }),
    ).toBe(true);
    expect(
      shouldClearCheckoutSessionBeforeRedirect({
        success: true,
        redirectUrl: "/order-success?orderId=1&token=receipt",
        clearCartOnRedirect: true,
      }),
    ).toBe(true);

    expect(
      shouldClearCheckoutBeforeRedirect({
        success: true,
        redirectUrl: "https://gateway.example/checkout",
        clearCheckoutSessionOnRedirect: true,
      }),
    ).toBe(false);
    expect(
      shouldClearCheckoutSessionBeforeRedirect({
        success: true,
        redirectUrl: "https://gateway.example/checkout",
        clearCheckoutSessionOnRedirect: true,
      }),
    ).toBe(true);
  });
});
