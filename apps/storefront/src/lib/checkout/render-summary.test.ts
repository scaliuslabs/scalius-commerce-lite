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
  getPaymentResultRecovery,
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
  const stripe = vi.fn(() => ({ elements: () => ({ create: createCard }), confirmCardPayment: vi.fn() }));
  vi.stubGlobal("Stripe", stripe);
  sessionStorage.setItem("scalius_checkout_data", JSON.stringify({
    checkoutId: "checkout_stripe_fixture_123456",
    cartItems: JSON.stringify({ line_1: { id: "prod_1", variantId: "var_1", price: 100, quantity: 1 } }),
    customerName: "Buyer", customerPhone: "+8801700000000", shippingAddress: "Dhaka",
    city: "city_1", zone: "zone_1", shippingMethodId: "ship_1",
  }));
  (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = {
    ...baseConfig, activeDefaultMethod: "stripe",
    gateways: [{ id: "stripe", publishableKey: "pk_stable_host", testMode: true }, { id: "cod" }, { id: "sslcommerz" }],
  };
  return { cards, createCard, stripe };
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
      }),
    );

    expect(details.textContent).toContain("Product One");
    expect(details.textContent).toContain("Blue · Qty 2");
    expect(details.textContent).toContain("Product Two");
    expect(details.textContent).toContain("Qty 1");
    expect(details.textContent).toContain("Standard Delivery");
    expect(details.textContent).toContain("Arrives in 2–3 business days");
    expect(details.textContent).not.toContain("Stale transferred delivery name");
    expect(details.textContent).toContain("Buyer Name · +8801700000000");
    expect(details.textContent).toContain("11 Example Road");
    expect(details.textContent).toContain("Dhanmondi, Dhaka South, Dhaka");
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
      "Normally ৳60.00; waived by an item in your cart.",
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

describe("initCheckoutPage", () => {
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
