// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkoutCartValidationPayload,
  initCheckoutPage,
  renderOrderSummaryDetails,
  shouldClearCheckoutBeforeRedirect,
  shouldClearCheckoutSessionBeforeRedirect,
  validateCheckoutCartFreshness,
} from "./index";
import { resolveCheckoutPaymentRequest } from "./payment-mode";
import type { CheckoutConfig } from "./types";
import { CHECKOUT_CART_REPAIR_STORAGE_KEY } from "../cart/repair-state";

const baseConfig: CheckoutConfig = {
  gateways: [],
  guestCheckoutEnabled: true,
  authVerificationMethod: "email",
  checkoutMode: "single",
  partialPaymentEnabled: false,
  partialPaymentAmount: 0,
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    success: true,
    data: {
      valid: true,
      issues: [],
      items: [],
      subtotal: 100,
      hasFreeDeliveryProduct: false,
    },
  }))));
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  document.body.innerHTML = "";
  delete (window as unknown as { __CHECKOUT_CONFIG__?: CheckoutConfig }).__CHECKOUT_CONFIG__;
});

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

  it("does not show an advance payment row when the deposit would cover the full order", () => {
    const details = document.createElement("div");

    renderOrderSummaryDetails(
      details,
      {
        cartItems: JSON.stringify({
          line_1: { price: 100, quantity: 2 },
        }),
        shippingCharge: "0",
        discountAmount: "0",
        customerName: "Buyer",
        shippingAddress: "Dhaka",
      },
      {
        ...baseConfig,
        partialPaymentEnabled: true,
        partialPaymentAmount: 500,
      },
    );

    expect(details.textContent).not.toContain("Advance Payment Required");
    expect(details.textContent).not.toContain("Balance Due on Delivery");
  });
});

describe("resolveCheckoutPaymentRequest", () => {
  it("uses a full payment request when the configured deposit is not less than the total", () => {
    expect(
      resolveCheckoutPaymentRequest({
        ...baseConfig,
        partialPaymentEnabled: true,
        partialPaymentAmount: 500,
      }, 500),
    ).toEqual({ paymentType: "full" });

    expect(
      resolveCheckoutPaymentRequest({
        ...baseConfig,
        partialPaymentEnabled: true,
        partialPaymentAmount: 600,
      }, 500),
    ).toEqual({ paymentType: "full" });
  });

  it("uses a deposit payment request only for positive deposits below the order total", () => {
    expect(
      resolveCheckoutPaymentRequest({
        ...baseConfig,
        partialPaymentEnabled: true,
        partialPaymentAmount: 200,
      }, 500),
    ).toEqual({ paymentType: "deposit", depositAmount: 200 });
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

describe("checkout cart freshness", () => {
  it("builds a cart-validation payload with cart keys and customer-facing line labels", () => {
    const items = checkoutCartValidationPayload({
      cartItems: JSON.stringify({
        "prod_1:default": {
          id: "prod_1",
          variantId: "default",
          quantity: 2,
          price: 150,
          name: "Cotton Panjabi",
          size: "M",
          color: "Blue",
        },
      }),
    });

    expect(items).toEqual([
      {
        cartKey: "prod_1:default",
        productId: "prod_1",
        variantId: null,
        quantity: 2,
        price: 150,
        productName: "Cotton Panjabi",
        variantLabel: "M / Blue",
      },
    ]);
  });

  it("returns structured item issues when checkout validation fails", async () => {
    const issue = {
      index: 0,
      cartKey: "line_1",
      productId: "prod_1",
      variantId: "var_1",
      code: "PRICE_CHANGED" as const,
      action: "refresh_item" as const,
      message: "The price changed.",
      productName: "Cotton Panjabi",
      variantLabel: "M / Blue",
      requestedQuantity: 1,
      currentPrice: 180,
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { valid: false, issues: [issue] },
    }))));

    const result = await validateCheckoutCartFreshness({
      cartItems: JSON.stringify({
        line_1: { id: "prod_1", variantId: "var_1", quantity: 1, price: 150 },
      }),
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([issue]);
    expect(result.message).toBe("One cart item changed before payment. Please review it before checkout.");
  });
});

describe("initCheckoutPage", () => {
  it("preselects the merchant's active default payment method when it renders", async () => {
    document.body.innerHTML = `
      <section id="orderSummary" class="hidden"><div id="summaryDetails"></div></section>
      <div id="errorMsg" class="hidden"></div>
      <div id="paymentMethods"></div>
      <div id="stripeSection" class="hidden"></div>
      <button id="payButton" disabled><span id="payButtonText">Select a payment method</span></button>
    `;
    sessionStorage.setItem("scalius_checkout_data", JSON.stringify({
      cartItems: JSON.stringify({
        line_1: { id: "prod_1", variantId: "var_1", price: 100, quantity: 1, name: "Product" },
      }),
      shippingCharge: "0",
      discountAmount: "0",
      customerName: "Buyer",
      shippingAddress: "Dhaka",
    }));
    (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = {
      ...baseConfig,
      activeDefaultMethod: "cod",
      gateways: [{ id: "cod", name: "Cash on Delivery" }],
    };

    await initCheckoutPage();

    expect(document.querySelector('[data-method="cod"]')?.classList.contains("border-primary")).toBe(true);
    expect((document.getElementById("payButton") as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById("payButtonText")?.textContent).toContain("Place Order");

  });

  it("sends stale checkout snapshots back to cart with a one-shot repair payload", async () => {
    const issue = {
      index: 0,
      cartKey: "line_1",
      productId: "prod_1",
      variantId: "var_1",
      code: "QUANTITY_UNAVAILABLE" as const,
      action: "reduce_quantity" as const,
      message: "Only 1 left.",
      productName: "Product",
      variantLabel: null,
      requestedQuantity: 3,
      availableQuantity: 1,
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { valid: false, issues: [issue] },
    }))));
    document.body.innerHTML = `
      <section id="orderSummary" class="hidden"><div id="summaryDetails"></div></section>
      <div id="errorMsg" class="hidden"></div>
      <div id="paymentMethods"></div>
      <button id="payButton" disabled><span id="payButtonText">Select a payment method</span></button>
    `;
    sessionStorage.setItem("scalius_checkout_data", JSON.stringify({
      cartItems: JSON.stringify({
        line_1: { id: "prod_1", variantId: "var_1", price: 100, quantity: 3, name: "Product" },
      }),
      shippingCharge: "0",
      discountAmount: "0",
      customerName: "Buyer",
      shippingAddress: "Dhaka",
    }));
    (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = {
      ...baseConfig,
      activeDefaultMethod: "cod",
      gateways: [{ id: "cod", name: "Cash on Delivery" }],
    };

    await initCheckoutPage();

    const repair = JSON.parse(sessionStorage.getItem(CHECKOUT_CART_REPAIR_STORAGE_KEY) || "{}") as {
      message?: string;
      issues?: unknown[];
    };
    expect(repair.message).toBe("One cart item changed before payment. Please review it before checkout.");
    expect(repair.issues).toEqual([issue]);
    expect(document.querySelector('[data-method="cod"]')).toBeNull();
    expect(window.location.href).toContain("/cart?checkoutIssues=1");
  });
});
