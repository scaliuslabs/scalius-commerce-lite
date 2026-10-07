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
  initCheckoutPage,
  renderOrderSummaryDetails,
  resumeCheckoutPageFromHistory,
} from "./index";
import { showCheckoutLoadingOverlay } from "./loading-overlay";
import { resetStripePaymentElement } from "./handlers/stripe";
import { resolveCheckoutPaymentRequest, resolveExplicitCheckoutPaymentRequest } from "./payment-mode";
import type { CheckoutConfig } from "./types";
import type { CheckoutTaxQuote } from "./tax-quote-contract";
import { CHECKOUT_CART_REPAIR_STORAGE_KEY } from "../cart/repair-state";

const baseConfig: CheckoutConfig = {
  gateways: [],
  guestCheckoutEnabled: true,
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

function taxQuote(
  overrides: Partial<CheckoutTaxQuote> = {},
): CheckoutTaxQuote {
  return {
    valid: true,
    quoteFingerprint: "taxq_abcdefghijklmnopqrstuv",
    discounts: [],
    offers: [],
    rejectedCodes: [],
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
    deliveryMethodKind: "delivery",
    requiresShipping: true,
    pickup: null,
    allowedPaymentMethods: ["cod", "stripe", "sslcommerz", "bkash", "custom"],
    shippingMethod: {
      id: "ship_1",
      name: "Standard Delivery",
      description: null,
      baseAmountMinor: 0,
      feeWaived: false,
    },
    items: [{
      cartKey: "line_1",
      productId: "prod_1",
      variantId: "var_1",
      quantity: 1,
      unitPrice: 100,
      productName: "Product",
      variantLabel: null,
      fulfillmentType: "ship",
      properties: [],
      propertiesPriceMinor: 0,
      propertiesHash: "none",
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

function installStripePaymentFixture() {
  document.body.innerHTML = `
    <section id="orderSummary" class="hidden"><div id="summaryDetails"></div></section>
    <div id="errorMsg" class="hidden"></div>
    <a id="checkoutRecoveryAction" hidden href="/cart">Return to cart</a>
    <div id="paymentMethods"></div>
    <div id="paymentActionParking" class="hidden">
      <div id="testModeNotice" class="hidden">Test mode</div>
      <div id="stripeSection" class="hidden">
        <div id="stripeCardElement"></div><div id="stripeError" class="hidden"></div>
      </div>
      <div id="paymentActionHost" class="hidden">
        <p id="hostedRedirectNote" class="hidden"></p>
        <button id="payButton" disabled><span id="payButtonText"></span></button>
      </div>
    </div>
  `;
  type Change = { complete?: boolean; error?: { message: string } };
  const cards: Array<{
    iframe: HTMLIFrameElement;
    emit: (event: Change) => void;
    destroy: ReturnType<typeof vi.fn>;
  }> = [];
  const createCard = vi.fn(() => {
    const iframe = document.createElement("iframe");
    let change: ((event: Change) => void) | undefined;
    const card = {
      iframe,
      mount: vi.fn((selector: string) => document.querySelector(selector)!.appendChild(iframe)),
      destroy: vi.fn(() => iframe.remove()),
      on: vi.fn((_event: string, listener: (event: Change) => void) => { change = listener; }),
      emit: (event: Change) => change?.(event),
    };
    cards.push(card);
    return card;
  });
  const confirmCardPayment = vi.fn();
  const stripe = vi.fn(() => ({ elements: () => ({ create: createCard }), confirmCardPayment }));
  vi.stubGlobal("Stripe", stripe);
  sessionStorage.setItem("checkoutId", "checkout_stripe_fixture_123456");
  sessionStorage.setItem("scalius_checkout_data", JSON.stringify({
    checkoutId: "checkout_stripe_fixture_123456",
    cartItems: JSON.stringify({ line_1: { id: "prod_1", variantId: "var_1", price: 100, quantity: 1 } }),
    customerName: "Buyer", customerPhone: "+8801700000000", shippingAddress: "Dhaka",
    city: "city_1", zone: "zone_1", shippingMethodId: "ship_1",
  }));
  (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = {
    ...baseConfig, activeDefaultMethod: "stripe",
    gateways: [{ id: "stripe", flow: "card", publishableKey: "pk_stable_host", testMode: true }, { id: "cod" }, { id: "sslcommerz", flow: "hosted" }],
  };
  return { cards, confirmCardPayment, createCard, stripe };
}

function stripeRetryFetch(): typeof fetch {
  return vi.fn(async (input) => {
    const url = String(input);
    if (url === "/api/checkout/tax-quote") {
      return new Response(JSON.stringify({ success: true, data: taxQuote() }));
    }
    if (url === "/api/checkout/create-order") {
      return new Response(JSON.stringify({
        data: {
          id: "order_stripe_retry",
          totalAmount: 100,
          paymentMethod: "stripe",
          initialPaymentSession: {
            gateway: "stripe",
            clientSecret: "pi_secret_original",
          },
        },
      }));
    }
    if (url === "/api/checkout/payment-session/stripe") {
      return new Response(JSON.stringify({ clientSecret: "pi_secret_original" }));
    }
    throw new Error(`Unexpected request: ${url}`);
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
  resetStripePaymentElement();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
  document.body.innerHTML = "";
  delete (window as unknown as { __CHECKOUT_CONFIG__?: CheckoutConfig }).__CHECKOUT_CONFIG__;
  delete window.__CURRENCY_CODE__;
});

describe("renderOrderSummaryDetails", () => {
  it("shows the items, delivery method, and delivery identity before payment", () => {
    const details = document.createElement("div");

    renderOrderSummaryDetails(
      details,
      {
        customerName: "Buyer Name",
        customerPhone: "+8801700000000",
        shippingAddress: "11 Example Road",
        areaName: "Dhanmondi",
        zoneName: "Dhaka South",
        cityName: "Dhaka",
        shippingMethodName: "Stale transferred delivery name",
      },
      baseConfig,
      taxQuote({
        subtotalMinor: 50_000,
        subtotalAmount: 500,
        totalMinor: 50_000,
        totalAmount: 500,
        shippingMethod: {
          id: "ship_1",
          name: "Standard Delivery",
          description: "Arrives in 2–3 business days",
          baseAmountMinor: 0,
          feeWaived: false,
        },
        items: [
          {
            cartKey: "line_1",
            productId: "prod_1",
            variantId: "var_1",
            quantity: 2,
            unitPrice: 150,
            productName: "Product One",
            variantLabel: "Blue",
            fulfillmentType: "ship",
            properties: [],
            propertiesPriceMinor: 0,
            propertiesHash: "none",
          },
          {
            cartKey: "line_2",
            productId: "prod_2",
            variantId: "var_2",
            quantity: 1,
            unitPrice: 200,
            productName: "Product Two",
            variantLabel: null,
            fulfillmentType: "ship",
            properties: [],
            propertiesPriceMinor: 0,
            propertiesHash: "none",
          },
        ],
      }),
    );

    expect(details.textContent).toContain("Product One");
    expect(details.textContent).toContain("Blue · Qty 2");
    expect(details.textContent).toContain("Product Two");
    expect(details.textContent).toContain("Qty 1");
    expect(details.textContent).toContain("Standard Delivery");
    expect(details.textContent).toContain("Arrives in 2–3 business days");
    expect(details.textContent).not.toContain("Stale transferred delivery name");
    // Contact, ship-to and delivery each have a way back to change them.
    expect(details.textContent).toContain("Buyer Name01700-000000");
    expect(details.textContent).toContain("11 Example Road");
    expect(details.textContent).toContain("Dhanmondi, Dhaka South, Dhaka");
    const changeLinks = Array.from(details.querySelectorAll("a")).filter((link) => link.textContent === "Change");
    expect(changeLinks.map((link) => link.getAttribute("href"))).toEqual(["/cart", "/cart", "/cart"]);
    expect(details.textContent).not.toContain("prod_1");
    expect(details.textContent).not.toContain("var_1");
  });

  it("shows the configured delivery fee when an item waives it", () => {
    const details = document.createElement("div");

    renderOrderSummaryDetails(
      details,
      { customerName: "Buyer" },
      baseConfig,
      taxQuote({
        shippingMethod: {
          id: "ship_1",
          name: "Express Delivery",
          description: null,
          baseAmountMinor: 6_000,
          feeWaived: true,
        },
      }),
    );

    expect(details.textContent).toContain("Express Delivery");
    expect(details.textContent).toContain(
      "Normally ৳60; waived by an item in your cart.",
    );
  });

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
    expect(details.textContent).toContain("Subtotal৳100");
    expect(details.textContent).not.toContain("৳200");
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

describe("initCheckoutPage", () => {
  it("draws the summary the cart page showed at once, before its own quote returns", async () => {
    document.body.innerHTML = `
      <section id="orderSummary" aria-busy="true"><span id="orderSummaryToggleTotal"></span><div id="summaryDetails"></div></section>
      <div id="errorMsg" class="hidden"></div>
      <div id="paymentMethods"></div>
      <div id="stripeSection" class="hidden"></div>
      <button id="payButton" disabled><span id="payButtonText">Select a payment method</span></button>
    `;
    const reviewed = taxQuote({ totalMinor: 12_300, totalAmount: 123 });
    sessionStorage.setItem("scalius_checkout_data", JSON.stringify({
      cartItems: JSON.stringify({ line_1: { id: "prod_1", variantId: "var_1", price: 100, quantity: 1 } }),
      expectedQuoteFingerprint: reviewed.quoteFingerprint,
      shippingMethodId: "ship_1",
    }));
    sessionStorage.setItem("scalius_checkout_quote", JSON.stringify(reviewed));
    (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = baseConfig;
    let answerQuote: (response: Response) => void = () => undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input) === "/api/checkout/tax-quote"
      ? new Promise<Response>((resolve) => { answerQuote = resolve; })
      : Promise.reject(new Error(`Unexpected request: ${String(input)}`))) as typeof fetch);

    const init = initCheckoutPage();
    await Promise.resolve();

    const summary = document.getElementById("orderSummary")!;
    expect(summary.getAttribute("aria-busy")).toBe("true");
    expect(document.getElementById("orderSummaryToggleTotal")?.textContent).toContain("123");
    expect(document.getElementById("summaryDetails")?.textContent).toContain("Product");
    expect((document.getElementById("payButton") as HTMLButtonElement).disabled).toBe(true);

    answerQuote(new Response(JSON.stringify({ success: true, data: taxQuote() })));
    await init;
    expect(summary.getAttribute("aria-busy")).toBe("false");
    expect(document.getElementById("orderSummaryToggleTotal")?.textContent).toContain("100");
  });

  it("never draws a stored quote of another checkout", async () => {
    document.body.innerHTML = `
      <section id="orderSummary" class="hidden"><span id="orderSummaryToggleTotal"></span><div id="summaryDetails"></div></section>
      <div id="errorMsg" class="hidden"></div>
      <div id="paymentMethods"></div>
    `;
    sessionStorage.setItem("scalius_checkout_data", JSON.stringify({
      cartItems: JSON.stringify({ line_1: { id: "prod_1", variantId: "var_1", price: 100, quantity: 1 } }),
      expectedQuoteFingerprint: "taxq_zzzzzzzzzzzzzzzzzzzzzz",
    }));
    sessionStorage.setItem("scalius_checkout_quote", JSON.stringify(taxQuote()));
    (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = baseConfig;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)) as typeof fetch);

    void initCheckoutPage();
    await Promise.resolve();

    expect(document.getElementById("orderSummary")?.classList.contains("hidden")).toBe(true);
    expect(document.getElementById("summaryDetails")?.textContent).toBe("");
  });

  it("shows a clear cart recovery message instead of redirecting when checkout transfer data is missing", async () => {
    window.history.replaceState(null, "", "/checkout");
    document.body.innerHTML = `
      <section id="orderSummary" class="hidden"><div id="summaryDetails"></div></section>
      <div id="errorMsg" class="hidden"></div>
      <a id="checkoutRecoveryAction" hidden href="/cart">Return to cart</a>
      <div id="paymentMethods" aria-busy="true"></div>
      <div id="stripeSection" class="hidden"></div>
      <div id="paymentActionParking" class="hidden">
        <div id="paymentActionHost" class="hidden">
          <button id="payButton" disabled><span id="payButtonText">Select a payment method</span></button>
        </div>
      </div>
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
    const recoveryAction = document.getElementById("checkoutRecoveryAction") as HTMLAnchorElement;
    expect(recoveryAction.hidden).toBe(false);
    expect(recoveryAction.getAttribute("href")).toBe("/cart");
    expect(recoveryAction.tabIndex).toBe(0);
    expect(document.getElementById("paymentMethods")?.getAttribute("aria-busy")).toBe("false");
    expect(document.getElementById("paymentActionParking")?.classList.contains("hidden")).toBe(true);
    expect(window.location.pathname).toBe("/checkout");
  });

  it("clears unreadable checkout transfer data without redirecting", async () => {
    window.history.replaceState(null, "", "/checkout");
    document.body.innerHTML = `
      <section id="orderSummary" class="hidden"><div id="summaryDetails"></div></section>
      <div id="errorMsg" class="hidden"></div>
      <a id="checkoutRecoveryAction" hidden href="/cart">Return to cart</a>
      <div id="paymentMethods" aria-busy="true"></div>
      <div id="paymentActionParking" class="hidden">
        <div id="paymentActionHost" class="hidden">
          <button id="payButton" disabled><span id="payButtonText">Select a payment method</span></button>
        </div>
      </div>
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
    const recoveryAction = document.getElementById("checkoutRecoveryAction") as HTMLAnchorElement;
    expect(recoveryAction.hidden).toBe(false);
    expect(recoveryAction.getAttribute("href")).toBe("/cart");
    expect(recoveryAction.tabIndex).toBe(0);
    expect(document.getElementById("paymentMethods")?.getAttribute("aria-busy")).toBe("false");
    expect(document.getElementById("paymentActionParking")?.classList.contains("hidden")).toBe(true);
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
      customerPhone: "+8801700000000",
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
        { id: "sslcommerz", name: "SSLCommerz", flow: "hosted" },
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

  it.each(["cod", "stripe", "stripe becomes ineligible"])("refreshes a quote for %s without resubmitting the order", async (method) => {
    const refreshedQuote = taxQuote({
      quoteFingerprint: "taxq_vutsrqponmlkjihgfedcba",
      subtotalMinor: 12_000,
      subtotalAmount: 120,
      totalMinor: 12_000,
      totalAmount: 120,
      items: [{
        cartKey: "line_1",
        productId: "prod_1",
        variantId: "var_1",
        quantity: 1,
        unitPrice: 120,
        productName: "Product",
        variantLabel: null,
        fulfillmentType: "ship",
        properties: [],
        propertiesPriceMinor: 0,
        propertiesHash: "none",
      }],
    });
    let quoteCalls = 0;
    let orderCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = String(input);
      if (url === "/api/checkout/tax-quote") {
        quoteCalls += 1;
        const quote = quoteCalls === 1 ? taxQuote() : refreshedQuote;
        return new Response(JSON.stringify({ success: true, data: quote }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/checkout/create-order") {
        orderCalls += 1;
        const body = JSON.parse(String(init?.body)) as {
          expectedQuoteFingerprint?: string;
        };
        expect(body.expectedQuoteFingerprint).toBe("taxq_abcdefghijklmnopqrstuv");
        return new Response(JSON.stringify({
          success: false,
          error: "Your order total or checkout terms changed.",
          errorCode: "STOREFRONT_CHECKOUT_QUOTE_CONFLICT",
        }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true, data: {} }));
    }));
    document.body.innerHTML = `
      <section id="orderSummary" class="hidden"><div id="summaryDetails"></div></section>
      <div id="errorMsg" class="hidden"></div>
      <a id="checkoutRecoveryAction" hidden href="/cart">Return to cart</a>
      <div id="paymentMethods"></div>
      <div id="stripeSection" class="hidden"></div>
      <button id="payButton" disabled><span id="payButtonText">Select a payment method</span></button>
    `;
    sessionStorage.setItem("scalius_checkout_data", JSON.stringify({
      checkoutId: "checkout_conflict_test_123456",
      cartItems: JSON.stringify({
        line_1: {
          id: "prod_1",
          variantId: "var_1",
          price: 100,
          quantity: 1,
          name: "Product",
        },
      }),
      shippingCharge: "0",
      discountAmount: "0",
      customerName: "Buyer",
      customerPhone: "+8801700000000",
      shippingAddress: "House 1, Dhaka",
      city: "city_1",
      zone: "zone_1",
      shippingMethodId: "ship_1",
    }));
    (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = {
      ...baseConfig,
      activeDefaultMethod: "cod",
      gateways: [{ id: "cod", name: "Cash on Delivery" }],
    };

    const stripe = method === "cod" ? undefined : installStripePaymentFixture();
    if (method === "stripe becomes ineligible") {
      (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__.gateways[0]!.amountLimits = {
        currency: "BDT", min: 1, max: 110,
      };
    }

    await initCheckoutPage();
    stripe?.cards[0]!.emit({ complete: true });
    (document.getElementById("payButton") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(document.getElementById("errorMsg")?.textContent).toContain(
        "Review the refreshed total",
      );
    });
    expect(document.getElementById("summaryDetails")?.textContent).toContain("৳120");
    expect(quoteCalls).toBe(2);
    expect(orderCalls).toBe(1);
    expect((document.getElementById("checkoutRecoveryAction") as HTMLAnchorElement).hidden).toBe(true);
    expect((document.getElementById("payButton") as HTMLButtonElement).disabled).toBe(method === "stripe");
    if (stripe) {
      expect(stripe.cards[0]!.destroy).toHaveBeenCalledTimes(1);
      expect(stripe.createCard).toHaveBeenCalledTimes(method === "stripe" ? 2 : 1);
      expect(document.getElementById("stripeSection")?.parentElement?.id).toBe(
        method === "stripe" ? "payment-details-stripe" : "paymentActionParking",
      );
      if (method !== "stripe") {
        expect(document.querySelector('[data-method="cod"] .payment-method-control')?.getAttribute("aria-checked")).toBe("true");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(orderCalls).toBe(1);
  });

  it("keeps the mounted Stripe subtree connected through selection and resets it on history restoration", async () => {
    const { cards, createCard } = installStripePaymentFixture();
    await initCheckoutPage();
    const section = document.getElementById("stripeSection")!;
    const host = document.getElementById("stripeCardElement")!;
    const removed: Node[] = [];
    const observer = new MutationObserver((records) => {
      records.forEach((record) => removed.push(...record.removedNodes));
    });
    observer.observe(document.getElementById("paymentMethods")!, { subtree: true, childList: true });
    const select = async (method: string) => {
      document.querySelector<HTMLButtonElement>(`[data-method="${method}"] .payment-method-control`)!.click();
      await vi.waitFor(() => expect(document.querySelector(`[data-method="${method}"] .payment-method-control`)?.getAttribute("aria-checked")).toBe("true"));
    };
    try {
      for (const complete of [false, true]) {
        cards[0]!.emit(complete ? { complete } : { complete, error: { message: "Invalid card number" } });
        await select("cod");
        expect(section.classList.contains("hidden")).toBe(true);
        expect((document.getElementById("payButton") as HTMLButtonElement).disabled).toBe(false);
        await select("sslcommerz");
        expect(document.getElementById("payButtonText")?.textContent).toBe("Continue to SSLCommerz");
        await select("stripe");
        await select("stripe");
        document.getElementById("payment-method-stripe")!.dispatchEvent(new KeyboardEvent("keydown", {
          key: "ArrowDown", bubbles: true, cancelable: true,
        }));
        expect(document.activeElement?.id).toBe("payment-method-cod");
        document.getElementById("payment-method-cod")!.dispatchEvent(new KeyboardEvent("keydown", {
          key: "ArrowUp", bubbles: true, cancelable: true,
        }));
        await vi.waitFor(() => expect(document.getElementById("payment-method-stripe")?.getAttribute("aria-checked")).toBe("true"));
        expect(section.parentElement?.id).toBe("payment-details-stripe");
        expect((document.getElementById("payButton") as HTMLButtonElement).disabled).toBe(!complete);
        expect(document.getElementById("stripeError")?.classList.contains("hidden")).toBe(complete);
        expect(section.previousElementSibling?.id).toBe("testModeNotice");
        expect(section.nextElementSibling?.id).toBe("paymentActionHost");
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(removed.some((node) => node === section || node.contains(host))).toBe(false);
      expect(createCard).toHaveBeenCalledTimes(1);
      expect(cards[0]!.destroy).not.toHaveBeenCalled();
    } finally {
      observer.disconnect();
    }
    cards[0]!.emit({ complete: false, error: { message: "Invalid card number" } });
    await resumeCheckoutPageFromHistory();
    expect(cards[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(createCard).toHaveBeenCalledTimes(2);
    expect(document.getElementById("stripeSection")).toBe(section);
    expect(section.parentElement?.id).toBe("payment-details-stripe");
    expect(document.getElementById("stripeError")?.textContent).toBe("");
    expect(document.getElementById("stripeError")?.classList.contains("hidden")).toBe(true);
    expect((document.getElementById("payButton") as HTMLButtonElement).disabled).toBe(true);
  });

  it("retries a declined Stripe card on the same order and saved deposit intent", async () => {
    const { cards, confirmCardPayment } = installStripePaymentFixture();
    const config = (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__;
    config.partialPaymentEnabled = true;
    config.partialPaymentAmount = 40;
    confirmCardPayment
      .mockResolvedValueOnce({ error: { message: "Your card was declined." } })
      .mockResolvedValueOnce({ paymentIntent: { status: "succeeded" } });
    vi.stubGlobal("fetch", stripeRetryFetch());

    await initCheckoutPage();
    cards[0]!.emit({ complete: true });
    const payButton = document.getElementById("payButton") as HTMLButtonElement;
    payButton.click();
    await vi.waitFor(() => expect(document.getElementById("errorMsg")?.textContent).toContain("declined"));

    payButton.click();
    await vi.waitFor(() => expect(confirmCardPayment).toHaveBeenCalledTimes(2));

    expect(confirmCardPayment).toHaveBeenNthCalledWith(1, "pi_secret_original", expect.any(Object));
    expect(confirmCardPayment).toHaveBeenNthCalledWith(2, "pi_secret_original", expect.any(Object));
    expect(vi.mocked(fetch).mock.calls.filter(
      ([input]) => String(input) === "/api/checkout/create-order",
    )).toHaveLength(1);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/checkout/payment-session/stripe",
      expect.objectContaining({
        body: JSON.stringify({
          orderId: "order_stripe_retry",
          paymentType: "deposit",
          depositAmount: 40,
          replaceExistingAttempt: false,
        }),
      }),
    );
  });

  it.each(["missing recovery pointer", "gateway change"])(
    "does not reuse the in-page Stripe order after a %s",
    async (scenario) => {
      const { cards, confirmCardPayment } = installStripePaymentFixture();
      confirmCardPayment
        .mockResolvedValueOnce({ error: { message: "Your card was declined." } })
        .mockResolvedValueOnce({ paymentIntent: { status: "succeeded" } });
      vi.stubGlobal("fetch", stripeRetryFetch());

      await initCheckoutPage();
      cards[0]!.emit({ complete: true });
      const payButton = document.getElementById("payButton") as HTMLButtonElement;
      payButton.click();
      await vi.waitFor(() => expect(document.getElementById("errorMsg")?.textContent).toContain("declined"));

      if (scenario === "missing recovery pointer") {
        localStorage.clear();
      } else {
        document.querySelector<HTMLButtonElement>(
          '[data-method="cod"] .payment-method-control',
        )!.click();
        await vi.waitFor(() => expect(document.querySelector(
          '[data-method="cod"] .payment-method-control',
        )?.getAttribute("aria-checked")).toBe("true"));
        document.querySelector<HTMLButtonElement>(
          '[data-method="stripe"] .payment-method-control',
        )!.click();
        await vi.waitFor(() => expect(document.querySelector(
          '[data-method="stripe"] .payment-method-control',
        )?.getAttribute("aria-checked")).toBe("true"));
      }

      payButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(confirmCardPayment).toHaveBeenCalledTimes(
        scenario === "missing recovery pointer" ? 2 : 1,
      );
      expect(vi.mocked(fetch).mock.calls.filter(
        ([input]) => String(input) === "/api/checkout/create-order",
      )).toHaveLength(scenario === "missing recovery pointer" ? 2 : 1);
      expect(vi.mocked(fetch).mock.calls.some(
        ([input]) => String(input) === "/api/checkout/payment-session/stripe",
      )).toBe(false);
    },
  );

  it("keeps a newer COD selection when the earlier Stripe script fails", async () => {
    installStripePaymentFixture();
    vi.stubGlobal("Stripe", undefined);
    let script: HTMLScriptElement | undefined;
    const append = vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
      script = node as HTMLScriptElement;
      return node;
    });
    try {
      const init = initCheckoutPage();
      await vi.waitFor(() => expect(script).toBeDefined());
      document.querySelector<HTMLButtonElement>('[data-method="cod"] .payment-method-control')!.click();
      script!.dispatchEvent(new Event("error"));
      await init;
      expect(document.querySelector('[data-method="cod"] .payment-method-control')?.getAttribute("aria-checked")).toBe("true");
      expect(document.getElementById("errorMsg")?.classList.contains("hidden")).toBe(true);
      expect(document.getElementById("payButtonText")?.textContent).toBe("Place order");
      expect((document.getElementById("payButton") as HTMLButtonElement).disabled).toBe(false);
    } finally {
      append.mockRestore();
    }
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
    // Only the neutral mark: the name never becomes markup.
    expect([...customMethod?.querySelectorAll("img") ?? []].map((img) => img.getAttribute("src"))).toEqual(["/payment-marks/wallet.svg"]);
    expect(customMethod?.querySelector("img[onerror]")).toBeNull();
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
          <div id="testModeNotice" class="hidden"></div>
          <div id="stripeSection" class="hidden"></div>
          <div id="paymentActionHost" class="hidden">
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
        { id: "sslcommerz", name: "SSLCommerz", flow: "hosted" },
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
      shippingMethod: {
        id: "ship_1",
        name: "Standard Delivery",
        description: null,
        baseAmountMinor: 6_000,
        feeWaived: false,
      },
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
          fulfillmentType: "ship",
          properties: [],
          propertiesPriceMinor: 0,
          propertiesHash: "none",
        },
        {
          cartKey: "line_2",
          productId: "prod_2",
          variantId: "var_2",
          quantity: 1,
          unitPrice: 200,
          productName: "Product Two",
          variantLabel: null,
          fulfillmentType: "ship",
          properties: [],
          propertiesPriceMinor: 0,
          propertiesHash: "none",
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
        { id: "sslcommerz", name: "SSLCommerz", flow: "hosted" },
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

  it.each(["initial quote", "final order validation", "quote refresh"])(
    "offers explicit cart recovery after %s fails without discarding details or resubmitting",
    async (failure) => {
      window.history.replaceState(null, "", "/checkout");
      const requests: string[] = [];
      const validationError = "Checkout details changed while the order was being placed. Return to your cart to review them and try again.";
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = String(input);
        requests.push(url);
        if (url === "/api/checkout/create-order") {
          return new Response(JSON.stringify({
            success: false,
            error: validationError,
            errorCode: failure === "final order validation"
              ? "VALIDATION_ERROR"
              : "STOREFRONT_CHECKOUT_QUOTE_CONFLICT",
          }), { status: failure === "final order validation" ? 400 : 409 });
        }
        if (failure === "initial quote" || requests.length > 1) {
          return new Response(JSON.stringify({ success: false }), { status: 503 });
        }
        return new Response(JSON.stringify({ success: true, data: taxQuote() }));
      }));
      document.body.innerHTML = `
        <section id="orderSummary" class="hidden"><div id="summaryDetails"></div></section>
        <div id="errorMsg" class="hidden"></div>
        <a id="checkoutRecoveryAction" hidden href="/cart">Return to cart</a>
        <div id="paymentMethods" aria-busy="true">
          <div class="animate-pulse" aria-hidden="true"></div>
          <span role="status">Loading payment methods</span>
        </div>
        <button id="payButton" disabled><span id="payButtonText">Select a payment method</span></button>
      `;
      const transfer = JSON.stringify({
        checkoutId: "checkout_recovery_test_123456",
        cartItems: JSON.stringify({
          line_1: { id: "prod_1", variantId: "var_1", price: 100, quantity: 1 },
        }),
        customerName: "Buyer",
        customerPhone: "+8801700000000",
        shippingAddress: "House 1, Dhaka",
        city: "city_1",
        zone: "zone_1",
        shippingMethodId: "ship_1",
        discountCodeHidden: JSON.stringify({ code: "SAVE", amount: 10 }),
      });
      sessionStorage.setItem("scalius_checkout_data", transfer);
      (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = {
        ...baseConfig,
        activeDefaultMethod: "cod",
        gateways: [{ id: "cod", name: "Cash on Delivery" }],
      };

      await initCheckoutPage();
      const payButton = document.getElementById("payButton") as HTMLButtonElement;
      if (failure === "initial quote") {
        expect(document.querySelector('[data-method="cod"]')).toBeNull();
        expect(document.getElementById("paymentMethods")?.childElementCount).toBe(0);
        expect(payButton.disabled).toBe(true);
        expect(document.getElementById("payButtonText")?.textContent).toBe("Total unavailable");
      } else {
        payButton.click();
      }
      await vi.waitFor(() => expect(document.getElementById("errorMsg")?.textContent).toContain(
        failure === "final order validation"
          ? validationError
          : "could not verify the current taxes and order total",
      ));
      expect(document.getElementById("paymentMethods")?.getAttribute("aria-busy")).toBe("false");
      expect(document.querySelector('#paymentMethods [role="status"]')).toBeNull();
      const recoveryAction = document.getElementById("checkoutRecoveryAction") as HTMLAnchorElement;
      expect(recoveryAction.hidden).toBe(false);
      expect(recoveryAction.getAttribute("href")).toBe("/cart");
      recoveryAction.focus();
      expect(document.activeElement).toBe(recoveryAction);
      expect(document.getElementById("errorMsg")?.textContent).not.toContain("+880");
      expect(sessionStorage.getItem("scalius_checkout_data")).toBe(transfer);
      expect(window.location.pathname).toBe("/checkout");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requests).toEqual([
        "/api/checkout/tax-quote",
        ...(failure === "initial quote" ? [] : ["/api/checkout/create-order"]),
        ...(failure === "quote refresh" ? ["/api/checkout/tax-quote"] : []),
      ]);

      vi.stubGlobal("fetch", successfulCheckoutFetch());
      await initCheckoutPage();
      expect(recoveryAction.hidden).toBe(true);
      expect(payButton.disabled).toBe(false);
      expect(document.getElementById("summaryDetails")?.textContent).toContain("৳100");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(sessionStorage.getItem("scalius_checkout_data")).toBe(transfer);
    },
  );

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
      success: false,
      error: "Current checkout total is unavailable",
      details: { itemIssues: [issue] },
    }), { status: 422 })));
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
      customerPhone: "+8801700000000",
      shippingAddress: "Dhaka",
      city: "city_1",
      zone: "zone_1",
      shippingMethodId: "ship_1",
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

describe("payment page on the pickup and no-delivery paths (Wave A)", () => {
  const engravedLine = {
    cartKey: "line_1",
    productId: "prod_1",
    variantId: "var_1",
    quantity: 1,
    unitPrice: 100,
    productName: "Engraved pen",
    variantLabel: null,
    fulfillmentType: "pickup" as const,
    properties: [{ key: "engraving", label: "Engraving", value: "Anika", displayValue: "Anika", priceMinor: 20_000 }],
    propertiesPriceMinor: 20_000,
    propertiesHash: "0123456789abcdef",
  };
  const pickupQuote = () => taxQuote({
    deliveryMethodKind: "pickup",
    requiresShipping: false,
    pickup: { address: "Shop 12, Dhanmondi", hours: "10am–8pm" },
    shippingMethod: { id: "pickup_1", name: "Shop pickup", description: null, baseAmountMinor: 0, feeWaived: false },
    items: [engravedLine],
  });

  it("reviews where to collect instead of an address, and each line's buyer inputs", () => {
    const details = document.createElement("div");
    renderOrderSummaryDetails(
      details,
      { customerName: "Buyer", customerPhone: "+8801700000000", shippingAddress: "Stale typed address" },
      baseConfig,
      pickupQuote(),
    );
    const text = details.textContent ?? "";
    expect(text).toContain("Engraving: Anika (+৳200)");
    expect(text).toContain("Pick up at");
    expect(text).toContain("Shop 12, Dhanmondi");
    expect(text).toContain("Open 10am–8pm");
    expect(text).toContain("Shop pickup");
    expect(text).not.toContain("Ship to");
    expect(text).not.toContain("Stale typed address");
  });

  it("shows no delivery line and says no delivery is needed when nothing is physical", () => {
    const details = document.createElement("div");
    renderOrderSummaryDetails(
      details,
      { customerName: "Buyer", customerPhone: "+8801700000000" },
      baseConfig,
      taxQuote({
        deliveryMethodKind: null,
        requiresShipping: false,
        shippingMethod: null,
        items: [{ ...engravedLine, fulfillmentType: "service", properties: [], propertiesPriceMinor: 0, propertiesHash: "none" }],
      }),
    );
    const text = details.textContent ?? "";
    expect(text).toContain("No delivery needed");
    expect(text).not.toContain("Shipping");
    expect(text).not.toContain("Ship to");
  });

  it("offers only the payment methods the server allows for the cart, with cash worded for the counter", async () => {
    document.body.innerHTML = `
      <section id="orderSummary" class="hidden"><div id="summaryDetails"></div></section>
      <div id="errorMsg" class="hidden"></div>
      <div id="paymentMethods"></div>
      <div id="stripeSection" class="hidden"></div>
      <button id="payButton" disabled><span id="payButtonText">Select a payment method</span></button>
    `;
    sessionStorage.setItem("scalius_checkout_data", JSON.stringify({
      cartItems: JSON.stringify({
        line_1: { id: "prod_1", variantId: "var_1", price: 300, quantity: 1, name: "Engraved pen",
          properties: [{ key: "engraving", value: "Anika" }] },
      }),
      customerName: "Buyer",
      customerPhone: "+8801700000000",
      deliveryMode: "pickup",
      shippingMethodId: "pickup_1",
    }));
    (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = {
      ...baseConfig,
      activeDefaultMethod: "cod",
      gateways: [
        { id: "cod", name: "Cash on Delivery" },
        { id: "sslcommerz", name: "SSLCommerz", flow: "hosted" },
      ],
    };

    const fetchMock = successfulCheckoutFetch({ ...pickupQuote(), allowedPaymentMethods: ["cod", "sslcommerz"] });
    vi.stubGlobal("fetch", fetchMock);
    await initCheckoutPage();
    expect(document.querySelector('[data-method="cod"]')?.textContent).toContain("Pay when you pick up your order");
    // The pickup quote asks for the rate only, and carries the inputs in the body.
    const quoteRequest = JSON.parse(String(vi.mocked(fetchMock).mock.calls[0]![1]!.body));
    expect(quoteRequest).toMatchObject({
      shippingMethodId: "pickup_1",
      items: [expect.objectContaining({ properties: [{ key: "engraving", value: "Anika" }] })],
    });
    expect(quoteRequest).not.toHaveProperty("city");

    vi.stubGlobal("fetch", successfulCheckoutFetch({ ...pickupQuote(), allowedPaymentMethods: ["sslcommerz"] }));
    await initCheckoutPage();
    expect(document.querySelector('[data-method="cod"]')).toBeNull();
    expect(document.querySelector('[data-method="sslcommerz"]')).not.toBeNull();
  });
});

describe("payment page with store app checkout functions", () => {
  const appRule = { code: "max_qty", message: "At most 10 per order.", index: 0, cartKey: "line_1" };

  function installPaymentPage(activeDefaultMethod = "cod"): void {
    document.body.innerHTML = `
      <section id="orderSummary" class="hidden"><div id="summaryDetails"></div></section>
      <div id="errorMsg" class="hidden"></div>
      <a id="checkoutRecoveryAction" hidden href="/cart">Return to cart</a>
      <div id="paymentMethods"></div>
      <div id="stripeSection" class="hidden"></div>
      <button id="payButton" disabled><span id="payButtonText">Select a payment method</span></button>
    `;
    sessionStorage.setItem("scalius_checkout_data", JSON.stringify({
      checkoutId: "chk_session_app_functions_1",
      cartItems: JSON.stringify({
        line_1: { id: "prod_1", variantId: "var_1", price: 100, quantity: 1, name: "Product" },
      }),
      customerName: "Buyer",
      customerPhone: "+8801700000000",
      shippingAddress: "Dhaka",
      city: "city_1",
      zone: "zone_1",
      shippingMethodId: "ship_1",
    }));
    (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = {
      ...baseConfig,
      activeDefaultMethod,
      gateways: [
        { id: "cod", name: "Cash on Delivery" },
        { id: "sslcommerz", name: "SSLCommerz", flow: "hosted" },
        { id: "bkash", name: "bKash", flow: "hosted" },
      ],
    };
  }

  const shownMethods = () =>
    [...document.querySelectorAll<HTMLElement>(".payment-method-card")].map((card) => card.dataset.method);

  it("keeps every method in the store's order when no app changed them", async () => {
    installPaymentPage();
    await initCheckoutPage();
    expect(shownMethods()).toEqual(["cod", "sslcommerz", "bkash"]);
  });

  it("shows only the methods an app left, in its order, with its names, and selects one left", async () => {
    installPaymentPage("cod");
    vi.stubGlobal("fetch", successfulCheckoutFetch(taxQuote({
      allowedPaymentMethods: ["bkash", "sslcommerz"],
      paymentMethods: [
        { id: "bkash", name: "bKash (5% off)" },
        // The store's own name keeps the page's own wording.
        { id: "sslcommerz", name: "SSLCommerz" },
      ],
    })));
    await initCheckoutPage();

    expect(shownMethods()).toEqual(["bkash", "sslcommerz"]);
    const bkash = document.querySelector('[data-method="bkash"]')!;
    expect(bkash.textContent).toContain("bKash (5% off)");
    expect(document.querySelector('[data-method="sslcommerz"]')?.textContent).toContain("Pay online");
    // The saved default (cash on delivery) is hidden for this order: the first method left is selected.
    expect(bkash.querySelector('[role="radio"]')?.getAttribute("aria-checked")).toBe("true");
    expect((document.getElementById("payButton") as HTMLButtonElement).disabled).toBe(false);
  });

  it("lists an app's discount line in the summary with a stable key, as text", async () => {
    installPaymentPage();
    vi.stubGlobal("fetch", successfulCheckoutFetch(taxQuote({
      discountMinor: 1_500,
      discountAmount: 15,
      totalMinor: 8_500,
      totalAmount: 85,
      discounts: [
        { promotionId: "promo_1", title: "Eid 5%", code: null, amount: 5, shippingAmount: 0 },
        { promotionId: null, appId: "app_loyalty", title: "Loyalty <b>reward</b>", code: null, amount: 10, shippingAmount: 0 },
      ],
    })));
    await initCheckoutPage();

    const lines = [...document.querySelectorAll<HTMLElement>("#summaryDetails [data-discount-line]")];
    expect(lines.map((line) => line.dataset.discountLine)).toEqual(["promo_1", "app:app_loyalty:1"]);
    expect(lines[1]?.textContent).toBe("Discount · Loyalty <b>reward</b>-৳10");
    expect(lines[1]?.querySelector("b")).toBeNull();
  });

  it("sends a quote blocked by an app's rule back to the cart, the rules in session storage only", async () => {
    installPaymentPage();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: "Current checkout total is unavailable",
      details: { reason: "cart_rules", ruleErrors: [appRule] },
    }), { status: 400 })));
    await initCheckoutPage();

    const repair = JSON.parse(sessionStorage.getItem(CHECKOUT_CART_REPAIR_STORAGE_KEY) || "{}") as {
      message?: string;
      ruleErrors?: unknown[];
    };
    expect(repair.message).toBe("This order can't be placed yet.");
    expect(repair.ruleErrors).toEqual([appRule]);
    expect(window.location.href).toContain("/cart?checkoutIssues=1");
    expect(window.location.href).not.toContain("max_qty");
    expect(window.location.href).not.toContain("At%20most");
  });

  function orderRefusingFetch(refusal: Record<string, unknown>, requote = taxQuote()) {
    let quotes = 0;
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/checkout/tax-quote") {
        quotes += 1;
        return new Response(JSON.stringify({ success: true, data: quotes === 1 ? taxQuote() : requote }));
      }
      if (url === "/api/checkout/create-order") {
        return new Response(JSON.stringify({
          success: false,
          error: "This payment method isn't available for this order. Choose another.",
          errorCode: "VALIDATION_ERROR",
          details: refusal,
        }), { status: 400 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  it("re-prices and offers the methods left when the order refuses a method an app hid", async () => {
    installPaymentPage("cod");
    const fetchMock = orderRefusingFetch(
      { reason: "payment_method_unavailable" },
      taxQuote({ allowedPaymentMethods: ["sslcommerz"], paymentMethods: [{ id: "sslcommerz", name: "SSLCommerz" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await initCheckoutPage();
    expect(shownMethods()).toEqual(["cod", "sslcommerz", "bkash"]);

    (document.getElementById("payButton") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(shownMethods()).toEqual(["sslcommerz"]));

    expect(document.getElementById("errorMsg")?.textContent).toBe(
      "This payment method is not available. Choose another method.",
    );
    expect(document.getElementById("errorMsg")?.classList.contains("hidden")).toBe(false);
    expect((document.getElementById("payButton") as HTMLButtonElement).disabled).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/checkout/tax-quote")).toHaveLength(2);
  });

  it("sends an order an app's rule refused back to the cart with the rules", async () => {
    installPaymentPage("cod");
    vi.stubGlobal("fetch", orderRefusingFetch({ reason: "cart_rules", ruleErrors: [appRule] }));
    await initCheckoutPage();

    (document.getElementById("payButton") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(sessionStorage.getItem(CHECKOUT_CART_REPAIR_STORAGE_KEY)).not.toBeNull());
    expect(window.location.href).toContain("/cart?checkoutIssues=1");
    const repair = JSON.parse(sessionStorage.getItem(CHECKOUT_CART_REPAIR_STORAGE_KEY) || "{}") as {
      ruleErrors?: unknown[];
    };
    expect(repair.ruleErrors).toEqual([appRule]);
  });
});

describe("an app's wallet at checkout", () => {
  const BKASH = "scalius.bkash:bkash";

  it("shows its checkout name with its logo and tells the buyer they leave the store to pay", async () => {
    let finishOrder: (response: Response) => void = () => undefined;
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = String(input);
      if (url === "/api/checkout/tax-quote") {
        return new Response(JSON.stringify({ success: true, data: taxQuote({ allowedPaymentMethods: ["cod", BKASH] }) }));
      }
      if (url === "/api/checkout/create-order") {
        return new Promise<Response>((resolve) => { finishOrder = resolve; });
      }
      return new Response(JSON.stringify({ success: true, data: {} }));
    }));
    document.body.innerHTML = `
      <main>
        <section id="orderSummary" class="hidden"><div id="summaryDetails"></div></section>
        <div id="errorMsg" class="hidden"></div>
        <div id="paymentMethods"></div>
        <div id="paymentActionParking" class="hidden">
          <div id="testModeNotice" class="hidden"></div>
          <div id="stripeSection" class="hidden"></div>
          <div id="paymentActionHost" class="hidden">
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
      cartItems: JSON.stringify({ line_1: { id: "prod_1", variantId: "var_1", price: 100, quantity: 1 } }),
      customerName: "Buyer",
      customerPhone: "+8801700000000",
      shippingAddress: "Dhaka",
      city: "city_1",
      zone: "zone_1",
      shippingMethodId: "ship_1",
    }));
    (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = {
      ...baseConfig,
      activeDefaultMethod: BKASH,
      gateways: [
        { id: "cod", name: "Cash on Delivery" },
        { id: BKASH, name: "bKash", flow: "hosted", testMode: false },
      ],
    };

    await initCheckoutPage();

    const row = document.querySelector<HTMLElement>(`[data-method="${BKASH}"]`)!;
    expect(row.textContent).toContain("bKash");
    expect(row.textContent).not.toContain("scalius");
    expect(row.querySelector("img")?.getAttribute("src")).toBe("/payment-marks/bkash.svg");
    expect(row.querySelector(".payment-method-control")?.getAttribute("aria-label")).toBe("bKash");
    expect(document.getElementById("payButtonText")?.textContent).toBe("Continue to bKash");
    expect(document.getElementById("hostedRedirectNote")?.textContent)
      .toBe("You'll be redirected to bKash to complete your payment.");

    document.getElementById("payButton")!.click();
    await vi.waitFor(() => expect(document.getElementById("loadingTitle")?.textContent).toBe("Opening bKash"));
    expect(document.getElementById("loadingMsg")?.textContent)
      .toBe("You'll leave this store to pay with bKash, then come back here for your receipt.");

    // The order is refused: the overlay goes and the buyer stays on checkout.
    finishOrder(new Response(JSON.stringify({ success: false, error: "Checkout is unavailable." }), { status: 503 }));
    await vi.waitFor(() => expect(document.getElementById("loadingOverlay")?.classList.contains("hidden")).toBe(true));
    expect(window.location.pathname).not.toContain("order-success");
  });
});
