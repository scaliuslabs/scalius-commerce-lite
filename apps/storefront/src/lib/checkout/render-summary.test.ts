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
  getPaymentResultRecovery,
  initCheckoutPage,
  renderOrderSummaryDetails,
  resumeCheckoutPageFromHistory,
  validateCheckoutCartFreshness,
} from "./index";
import { showCheckoutLoadingOverlay } from "./loading-overlay";
import { resolveCheckoutPaymentRequest, resolveExplicitCheckoutPaymentRequest } from "./payment-mode";
import type { CheckoutConfig } from "./types";
import type { CheckoutTaxQuote } from "./tax-quote-contract";
import { CHECKOUT_CART_REPAIR_STORAGE_KEY } from "../cart/repair-state";

const baseConfig: CheckoutConfig = {
  gateways: [],
  guestCheckoutEnabled: true,
  authVerificationMethod: "email",
  checkoutMode: "single",
  partialPaymentEnabled: false,
  partialPaymentAmount: 0,
};

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: vi.fn(() => store.clear()),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => store.delete(key)),
    setItem: vi.fn((key: string, value: string) => store.set(key, String(value))),
  };
}

function installStorageMocks(): void {
  const local = createMemoryStorage();
  const session = createMemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true });
  Object.defineProperty(window, "localStorage", { value: local, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: session, configurable: true });
  Object.defineProperty(window, "sessionStorage", { value: session, configurable: true });
}

describe("checkout payment recovery", () => {
  it("turns a cleared stale customer session into an explicit guest continuation", () => {
    expect(getPaymentResultRecovery({
      success: false,
      status: 401,
      errorCode: "CUSTOMER_SESSION_STALE",
      error: "Your session expired.",
    })).toEqual({
      message: "Your sign-in session expired. Your checkout details are safe. Continue as a guest, or sign in again.",
      buttonText: "Continue as guest",
    });
  });

  it("does not relabel unrelated checkout failures", () => {
    expect(getPaymentResultRecovery({
      success: false,
      status: 503,
      errorCode: "CHECKOUT_CONFIG_UNAVAILABLE",
    })).toBeNull();
  });
});

function taxQuote(
  overrides: Partial<CheckoutTaxQuote> = {},
): CheckoutTaxQuote {
  return {
    valid: true,
    quoteFingerprint: "taxq_abcdefghijklmnopqrstuv",
    displayLabel: "VAT",
    pricesIncludeTax: false,
    shippingTaxed: false,
    currencyCode: "BDT",
    decimalPlaces: 2,
    settingsVersion: 1,
    subtotalMinor: 10_000,
    subtotalAmount: 100,
    shippingMinor: 0,
    shippingAmount: 0,
    discountMinor: 0,
    discountAmount: 0,
    taxMinor: 0,
    taxAmount: 0,
    totalMinor: 10_000,
    totalAmount: 100,
    items: [{
      cartKey: "line_1",
      productId: "prod_1",
      variantId: "var_1",
      quantity: 1,
      unitPrice: 100,
      productName: "Product",
      variantLabel: null,
    }],
    ...overrides,
  };
}

function successfulCheckoutFetch(quote = taxQuote()): typeof fetch {
  return vi.fn(async (input) => {
    const url = String(input);
    if (url === "/api/checkout/tax-quote") {
      return new Response(JSON.stringify({ success: true, data: quote }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      success: true,
      data: {
        valid: true,
        issues: [],
        items: [],
        subtotal: 100,
        hasFreeDeliveryProduct: false,
      },
    }));
  }) as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  installStorageMocks();
  localStorage.clear();
  window.__CURRENCY_CODE__ = "BDT";
  vi.stubGlobal("fetch", successfulCheckoutFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
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
      taxQuote({
        pricesIncludeTax: true,
        taxMinor: 1_500,
        taxAmount: 15,
      }),
    );

    expect(details.querySelector("img")).toBeNull();
    expect(details.querySelector("script")).toBeNull();
    expect(details.textContent).toContain('<img src=x onerror="window.__pwned=true">');
    expect(details.textContent).toContain("<script>window.__pwned=true</script>");
    expect(details.textContent).toContain("Subtotal৳100.00");
    expect(details.textContent).not.toContain("৳200.00");
    expect(details.textContent).toContain("VAT (included)");
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
      taxQuote({
        subtotalMinor: 20_000,
        subtotalAmount: 200,
        totalMinor: 20_000,
        totalAmount: 200,
      }),
    );

    expect(details.textContent).not.toContain("Advance Payment Required");
    expect(details.textContent).not.toContain("Balance Due on Delivery");
  });
});

describe("resolveCheckoutPaymentRequest", () => {
  it("supports explicit existing-order balance recovery and validates advances", () => {
    expect(resolveExplicitCheckoutPaymentRequest("balance")).toEqual({ paymentType: "balance" });
    expect(resolveExplicitCheckoutPaymentRequest("deposit", 200)).toEqual({ paymentType: "deposit", depositAmount: 200 });
    expect(() => resolveExplicitCheckoutPaymentRequest("deposit")).toThrow("valid advance amount");
  });

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
          options: [
            { name: "Fit", label: "M" },
            { name: "Shade", label: "Blue" },
            { name: "Sleeve", label: "Long" },
          ],
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
        variantLabel: "M / Blue / Long",
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
      city: "city_1",
      zone: "zone_1",
      shippingMethodId: "ship_1",
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

    const paymentMethods = document.getElementById("paymentMethods");
    const codCard = document.querySelector('[data-method="cod"]');
    const codMethod = document.querySelector(
      '[data-method="cod"] .payment-method-control',
    );
    expect(paymentMethods?.getAttribute("role")).toBe("radiogroup");
    expect(paymentMethods?.getAttribute("aria-label")).toBe("Payment methods");
    expect(codMethod).toBeInstanceOf(HTMLButtonElement);
    expect(codMethod?.getAttribute("role")).toBe("radio");
    expect(codMethod?.getAttribute("aria-checked")).toBe("true");
    expect((codMethod as HTMLButtonElement).type).toBe("button");
    expect(codMethod?.getAttribute("aria-label")).toContain(
      "Cash on delivery. Pay when you receive your order",
    );
    expect((codMethod as HTMLButtonElement).tabIndex).toBe(0);
    expect(codCard?.classList.contains("border-primary")).toBe(true);
    expect((document.getElementById("payButton") as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById("payButtonText")?.textContent).toContain("Place order");

    const onlineMethod = document.querySelector<HTMLButtonElement>(
      '[data-method="sslcommerz"] .payment-method-control',
    );
    expect(onlineMethod?.tabIndex).toBe(-1);

    codMethod?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.activeElement).toBe(onlineMethod);
    expect(onlineMethod?.getAttribute("aria-checked")).toBe("true");
    expect(onlineMethod?.tabIndex).toBe(0);
    expect((codMethod as HTMLButtonElement).tabIndex).toBe(-1);
  });

  it("renders unknown gateway labels as text instead of executable markup", async () => {
    document.body.innerHTML = `
      <section id="orderSummary" class="hidden"><div id="summaryDetails"></div></section>
      <div id="errorMsg" class="hidden"></div>
      <div id="paymentMethods"></div>
      <div id="stripeSection" class="hidden"></div>
      <button id="payButton" disabled><span id="payButtonText">Select a payment method</span></button>
    `;
    sessionStorage.setItem("scalius_checkout_data", JSON.stringify({
      cartItems: JSON.stringify({
        line_1: { id: "prod_1", variantId: "var_1", price: 100, quantity: 1 },
      }),
      city: "city_1",
      zone: "zone_1",
      shippingMethodId: "ship_1",
    }));
    (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = {
      ...baseConfig,
      activeDefaultMethod: "custom",
      gateways: [{
        id: "custom",
        name: '<img src=x onerror="window.__gatewayPwned=true">Custom pay',
      }],
    };

    await initCheckoutPage();

    const customMethod = document.querySelector('[data-method="custom"]');
    const customControl = customMethod?.firstElementChild;
    expect(customMethod?.querySelector("img")).toBeNull();
    expect(customMethod?.textContent).toContain(
      '<img src=x onerror="window.__gatewayPwned=true">Custom pay',
    );
    expect(customControl?.getAttribute("aria-label")).toContain("Custom pay");
  });

  it("preselects the only eligible method when a saved default is no longer available", async () => {
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
      city: "city_1",
      zone: "zone_1",
      shippingMethodId: "ship_1",
    }));
    (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = {
      ...baseConfig,
      activeDefaultMethod: "sslcommerz",
      gateways: [{ id: "cod", name: "Cash on Delivery" }],
    };

    await initCheckoutPage();

    const codMethod = document.querySelector('[data-method="cod"]');
    expect(codMethod?.classList.contains("border-primary")).toBe(true);
    expect(codMethod?.querySelector('[role="radio"]')).toBeNull();
    expect((document.getElementById("payButton") as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById("payButtonText")?.textContent).toContain("Place order");
  });

  it("unfreezes a BFCache-restored payment page and keeps the buyer's method", async () => {
    document.body.innerHTML = `
      <main>
        <section id="orderSummary" class="hidden"><div id="summaryDetails"></div></section>
        <div id="errorMsg" class="hidden"></div>
        <div id="paymentMethods"></div>
        <div id="paymentActionParking" class="hidden">
          <div id="paymentActionHost" class="hidden">
            <div id="testModeNotice" class="hidden"></div>
            <div id="stripeSection" class="hidden"></div>
            <p id="hostedRedirectNote" class="hidden"></p>
            <button id="payButton" disabled><span id="payButtonText">Select a payment method</span></button>
          </div>
        </div>
      </main>
      <div id="loadingOverlay" class="hidden" aria-hidden="true" tabindex="-1">
        <span id="loadingTitle"></span><span id="loadingMsg"></span>
      </div>
    `;
    sessionStorage.setItem("scalius_checkout_data", JSON.stringify({
      cartItems: JSON.stringify({
        line_1: { id: "prod_1", variantId: "var_1", price: 100, quantity: 1 },
      }),
      customerName: "Buyer",
      shippingAddress: "Dhaka",
      city: "city_1",
      zone: "zone_1",
      shippingMethodId: "ship_1",
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
    document.querySelector<HTMLButtonElement>(
      '[data-method="sslcommerz"] .payment-method-control',
    )?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    showCheckoutLoadingOverlay({
      title: "Opening secure payment",
      message: "Leaving this page",
    });

    expect(document.querySelector("main")?.inert).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    await resumeCheckoutPageFromHistory();

    const restored = document.querySelector<HTMLButtonElement>(
      '[data-method="sslcommerz"] .payment-method-control',
    );
    expect(restored?.getAttribute("aria-checked")).toBe("true");
    expect(document.getElementById("loadingOverlay")?.classList.contains("hidden")).toBe(true);
    expect(document.querySelector("main")?.inert).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(document.getElementById("payButtonText")?.textContent).toBe(
      "Continue to SSLCommerz",
    );
  });

  it("emits safe AddPaymentInfo analytics only when the buyer confirms the selected method", async () => {
    vi.stubGlobal("fetch", successfulCheckoutFetch(taxQuote({
      subtotalMinor: 50_000,
      subtotalAmount: 500,
      shippingMinor: 6_000,
      shippingAmount: 60,
      discountMinor: 2_500,
      discountAmount: 25,
      taxMinor: 8_000,
      taxAmount: 80,
      totalMinor: 61_500,
      totalAmount: 615,
      items: [
        {
          cartKey: "line_1",
          productId: "prod_1",
          variantId: "var_1",
          quantity: 2,
          unitPrice: 150,
          productName: "Product One",
          variantLabel: null,
        },
        {
          cartKey: "line_2",
          productId: "prod_2",
          variantId: "var_2",
          quantity: 1,
          unitPrice: 200,
          productName: "Product Two",
          variantLabel: null,
        },
      ],
    })));
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
      city: "city_1",
      zone: "zone_1",
      shippingMethodId: "ship_1",
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
      value: 615,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    (document.querySelector(
      '[data-method="sslcommerz"] .payment-method-control',
    ) as HTMLElement).click();
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
      value: 615,
    });

    const analyticsCalls = JSON.stringify(
      analyticsMocks.trackStorefrontAddPaymentInfoOnce.mock.calls,
    );
    expect(analyticsCalls).not.toContain("Buyer Name");
    expect(analyticsCalls).not.toContain("+8801700000000");
    expect(analyticsCalls).not.toContain("Buyer Address");
  });

  it("fails closed without rendering gateways when the authoritative quote is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      if (String(input) === "/api/checkout/tax-quote") {
        return new Response(JSON.stringify({ success: false }), { status: 503 });
      }
      return new Response(JSON.stringify({
        success: true,
        data: { valid: true, issues: [] },
      }));
    }));
    document.body.innerHTML = `
      <section id="orderSummary" class="hidden"><div id="summaryDetails"></div></section>
      <div id="errorMsg" class="hidden"></div>
      <div id="paymentMethods"></div>
      <button id="payButton" disabled><span id="payButtonText">Select a payment method</span></button>
    `;
    sessionStorage.setItem("scalius_checkout_data", JSON.stringify({
      cartItems: JSON.stringify({
        line_1: { id: "prod_1", variantId: "var_1", price: 100, quantity: 1 },
      }),
      city: "city_1",
      zone: "zone_1",
      shippingMethodId: "ship_1",
      customerPhone: "+8801700000000",
    }));
    (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = {
      ...baseConfig,
      activeDefaultMethod: "cod",
      gateways: [{ id: "cod", name: "Cash on Delivery" }],
    };

    await initCheckoutPage();

    expect(document.querySelector('[data-method="cod"]')).toBeNull();
    expect((document.getElementById("payButton") as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById("payButtonText")?.textContent).toBe("Total unavailable");
    expect(document.getElementById("errorMsg")?.textContent).toContain(
      "could not verify the current taxes and order total",
    );
    expect(document.getElementById("errorMsg")?.textContent).not.toContain("+880");
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
