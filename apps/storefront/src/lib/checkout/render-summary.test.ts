// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analyticsMocks = vi.hoisted(() => ({
  trackStorefrontAddPaymentInfoOnce: vi.fn(),
}));

vi.mock("../analytics", () => ({
  trackStorefrontAddPaymentInfoOnce:
    analyticsMocks.trackStorefrontAddPaymentInfoOnce,
}));

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
  vi.clearAllMocks();
  window.__CURRENCY_CODE__ = "BDT";
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
  delete window.__CURRENCY_CODE__;
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
        redirectUrl: "/order-success?orderId=1",
        clearCartOnRedirect: true,
      }),
    ).toBe(true);
    expect(
      shouldClearCheckoutSessionBeforeRedirect({
        success: true,
        redirectUrl: "/order-success?orderId=1",
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
        "line:v2:prod_1:variant:var_1": {
          id: "prod_1",
          variantId: "var_1",
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
        cartKey: "line:v2:prod_1:variant:var_1",
        productId: "prod_1",
        variantId: "var_1",
        quantity: 2,
        price: 150,
        productName: "Cotton Panjabi",
        variantLabel: "M / Blue",
      },
    ]);
  });

  it("fails closed before fetch when a checkout snapshot has no persisted variant", async () => {
    const fetchMock = vi.mocked(fetch);
    const result = await validateCheckoutCartFreshness({
      cartItems: JSON.stringify({
        line_1: { id: "prod_1", variantId: "default", quantity: 1, price: 150 },
      }),
    });

    expect(result).toEqual({
      valid: false,
      issues: [],
      message: "Your cart contains an item without a saved product variant. Please return to your cart and add it again.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
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
  it("shows a clear cart recovery message instead of redirecting when checkout transfer data is missing", async () => {
    window.history.replaceState(null, "", "/checkout");
    document.body.innerHTML = `
      <section id="orderSummary" class="hidden"><div id="summaryDetails"></div></section>
      <div id="errorMsg" class="hidden"></div>
      <div id="paymentMethods"></div>
      <div id="stripeSection" class="hidden"></div>
      <button id="payButton" disabled><span id="payButtonText">Select a payment method</span></button>
    `;
    (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = {
      ...baseConfig,
      activeDefaultMethod: "cod",
      gateways: [{ id: "cod", name: "Cash on Delivery" }],
    };

    await initCheckoutPage();

    expect(fetch).not.toHaveBeenCalled();
    expect(document.getElementById("errorMsg")?.textContent).toContain(
      "Checkout details were not found",
    );
    expect(document.getElementById("errorMsg")?.classList.contains("hidden")).toBe(false);
    expect(document.querySelector('[data-method="cod"]')).toBeNull();
    expect((document.getElementById("payButton") as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById("payButtonText")?.textContent).toBe("Return to cart");
    expect(window.location.pathname).toBe("/checkout");
  });

  it("clears unreadable checkout transfer data without redirecting", async () => {
    window.history.replaceState(null, "", "/checkout");
    document.body.innerHTML = `
      <section id="orderSummary" class="hidden"><div id="summaryDetails"></div></section>
      <div id="errorMsg" class="hidden"></div>
      <div id="paymentMethods"></div>
      <button id="payButton" disabled><span id="payButtonText">Select a payment method</span></button>
    `;
    sessionStorage.setItem("scalius_checkout_data", "{not-json");
    sessionStorage.setItem("scalius_checkout_gateways", '[{"id":"cod"}]');
    (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = {
      ...baseConfig,
      activeDefaultMethod: "cod",
      gateways: [{ id: "cod", name: "Cash on Delivery" }],
    };

    await initCheckoutPage();

    expect(fetch).not.toHaveBeenCalled();
    expect(document.getElementById("errorMsg")?.textContent).toContain(
      "Checkout details could not be read",
    );
    expect(sessionStorage.getItem("scalius_checkout_data")).toBeNull();
    expect(sessionStorage.getItem("scalius_checkout_gateways")).toBeNull();
    expect((document.getElementById("payButton") as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById("payButtonText")?.textContent).toBe("Return to cart");
    expect(window.location.pathname).toBe("/checkout");
  });

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

  it("emits safe AddPaymentInfo analytics only when the buyer confirms the selected method", async () => {
    document.body.innerHTML = `
      <section id="orderSummary" class="hidden"><div id="summaryDetails"></div></section>
      <div id="errorMsg" class="hidden"></div>
      <div id="paymentMethods"></div>
      <div id="stripeSection" class="hidden"></div>
      <button id="payButton" disabled><span id="payButtonText">Select a payment method</span></button>
    `;
    sessionStorage.setItem("scalius_checkout_data", JSON.stringify({
      checkoutId: "chk_analytics_checkout_1",
      cartItems: JSON.stringify({
        line_1: {
          id: "prod_1",
          variantId: "var_1",
          price: 150,
          quantity: 2,
          name: "Product One",
        },
        line_2: {
          id: "prod_2",
          variantId: "var_2",
          price: 200,
          quantity: 1,
          name: "Product Two",
        },
      }),
      shippingCharge: "60",
      discountAmount: "25",
      customerName: "Buyer Name",
      customerPhone: "+8801700000000",
      shippingAddress: "Buyer Address",
    }));
    (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = {
      ...baseConfig,
      activeDefaultMethod: "cod",
      gateways: [
        { id: "cod", name: "Cash on Delivery" },
        { id: "sslcommerz", name: "SSLCommerz" },
      ],
    };

    await initCheckoutPage();

    expect(analyticsMocks.trackStorefrontAddPaymentInfoOnce).not.toHaveBeenCalled();

    (document.getElementById("payButton") as HTMLButtonElement).click();

    expect(analyticsMocks.trackStorefrontAddPaymentInfoOnce).toHaveBeenCalledTimes(1);
    expect(analyticsMocks.trackStorefrontAddPaymentInfoOnce).toHaveBeenCalledWith({
      checkoutId: "chk_analytics_checkout_1",
      paymentMethod: "cod",
      content_ids: ["var_1", "var_2"],
      contents: [
        { id: "var_1", quantity: 2, item_price: 150 },
        { id: "var_2", quantity: 1, item_price: 200 },
      ],
      currency: "BDT",
      value: 535,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    (document.querySelector('[data-method="sslcommerz"]') as HTMLElement).click();
    expect(analyticsMocks.trackStorefrontAddPaymentInfoOnce).toHaveBeenCalledTimes(1);

    (document.getElementById("payButton") as HTMLButtonElement).click();

    expect(analyticsMocks.trackStorefrontAddPaymentInfoOnce).toHaveBeenCalledTimes(2);
    expect(analyticsMocks.trackStorefrontAddPaymentInfoOnce).toHaveBeenLastCalledWith({
      checkoutId: "chk_analytics_checkout_1",
      paymentMethod: "sslcommerz",
      content_ids: ["var_1", "var_2"],
      contents: [
        { id: "var_1", quantity: 2, item_price: 150 },
        { id: "var_2", quantity: 1, item_price: 200 },
      ],
      currency: "BDT",
      value: 535,
    });

    const analyticsCalls = JSON.stringify(
      analyticsMocks.trackStorefrontAddPaymentInfoOnce.mock.calls,
    );
    expect(analyticsCalls).not.toContain("Buyer Name");
    expect(analyticsCalls).not.toContain("+8801700000000");
    expect(analyticsCalls).not.toContain("Buyer Address");
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
