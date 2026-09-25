// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analyticsMocks = vi.hoisted(() => ({
  trackStorefrontAddPaymentInfoOnce: vi.fn(),
}));

vi.mock("../analytics", () => ({
  trackStorefrontAddPaymentInfoOnce: analyticsMocks.trackStorefrontAddPaymentInfoOnce,
}));

import { initCheckoutPage, renderOrderSummaryDetails } from "./index";
import { GIFT_CARD_STORAGE_KEY, type StoredGiftCard } from "./gift-cards";
import type { CheckoutConfig } from "./types";
import type { CheckoutTaxQuote } from "./tax-quote-contract";

const handle = (seed: string) => `gch_${seed.repeat(48).slice(0, 48)}`;

const baseConfig: CheckoutConfig = {
  gateways: [
    { id: "cod", name: "Cash on Delivery" },
    { id: "sslcommerz", name: "SSLCommerz", flow: "hosted" },
  ],
  activeDefaultMethod: "cod",
  guestCheckoutEnabled: true,
  checkoutMode: "single",
  partialPaymentEnabled: false,
  partialPaymentAmount: 0,
};

function storedCard(seed: string, last4 = "7K2Q"): StoredGiftCard {
  return {
    handle: handle(seed),
    last4,
    balance: 400,
    balanceMinor: 40_000,
    currencyCode: "BDT",
    handleExpiresAt: Date.now() + 60 * 60 * 1000,
  };
}

function quote(overrides: Partial<CheckoutTaxQuote> = {}): CheckoutTaxQuote {
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
    subtotalMinor: 100_000,
    subtotalAmount: 1000,
    shippingMinor: 0,
    shippingAmount: 0,
    discountMinor: 0,
    discountAmount: 0,
    taxMinor: 0,
    taxAmount: 0,
    totalMinor: 100_000,
    totalAmount: 1000,
    deliveryMethodKind: "delivery",
    requiresShipping: true,
    pickup: null,
    allowedPaymentMethods: ["cod", "sslcommerz"],
    shippingMethod: { id: "ship_1", name: "Standard", description: null, baseAmountMinor: 0, feeWaived: false },
    items: [{
      cartKey: "line_1",
      productId: "prod_1",
      variantId: "var_1",
      quantity: 1,
      unitPrice: 1000,
      productName: "Panjabi",
      variantLabel: null,
      fulfillmentType: "ship",
      properties: [],
      propertiesPriceMinor: 0,
      propertiesHash: "none",
    }],
    ...overrides,
  };
}

const partialTender = {
  giftCardTenders: [{ handle: handle("a"), last4: "7K2Q", applied: 400, appliedMinor: 40_000, balance: 400, balanceMinor: 40_000 }],
  giftCardIssues: [],
  amountDue: 600,
  amountDueMinor: 60_000,
};

const fullTender = {
  giftCardTenders: [{ handle: handle("a"), last4: "7K2Q", applied: 1000, appliedMinor: 100_000, balance: 2000, balanceMinor: 200_000 }],
  giftCardIssues: [],
  amountDue: 0,
  amountDueMinor: 0,
  allowedPaymentMethods: ["gift_card"],
};

function installPage(): void {
  document.body.innerHTML = `
    <section id="orderSummary" class="hidden"><span id="orderSummaryToggleTotal"></span><div id="summaryDetails"></div></section>
    <div id="errorMsg" class="hidden"></div>
    <a id="checkoutRecoveryAction" hidden href="/cart">Return to cart</a>
    <section id="giftCardSection">
      <form id="giftCardForm" method="post" action="/api/gift-cards/apply">
        <input id="giftCardCode" name="code" />
        <button id="giftCardApply" type="submit">Apply</button>
      </form>
      <p id="giftCardMessage" class="hidden"></p>
      <ul id="giftCardChips"></ul>
    </section>
    <div id="paymentMethods"></div>
    <div id="paymentActionParking" class="hidden">
      <div id="testModeNotice" class="hidden"></div>
      <div id="stripeSection" class="hidden"></div>
      <div id="paymentActionHost" class="hidden">
        <p id="hostedRedirectNote" class="hidden"></p>
        <button id="payButton" disabled><span id="payButtonText"></span></button>
      </div>
    </div>
  `;
  sessionStorage.setItem("checkoutId", "checkout_gift_fixture_123456");
  sessionStorage.setItem("scalius_checkout_data", JSON.stringify({
    checkoutId: "checkout_gift_fixture_123456",
    cartItems: JSON.stringify({ line_1: { id: "prod_1", variantId: "var_1", price: 1000, quantity: 1, name: "Panjabi" } }),
    customerName: "Buyer",
    customerPhone: "+8801700000000",
    shippingAddress: "Dhaka",
    city: "city_1",
    zone: "zone_1",
    shippingMethodId: "ship_1",
  }));
  (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = baseConfig;
}

type Route = (body: Record<string, unknown>) => Response;

function stubApi(routes: Record<string, Route | Route[]>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, body });
    const route = routes[url];
    const handler = Array.isArray(route) ? (route.length > 1 ? route.shift()! : route[0]) : route;
    if (!handler) throw new Error(`Unexpected request: ${url}`);
    return handler(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  window.__CURRENCY_CODE__ = "BDT";
  installPage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  delete (window as unknown as { __CHECKOUT_CONFIG__?: CheckoutConfig }).__CHECKOUT_CONFIG__;
  delete window.__CURRENCY_CODE__;
});

describe("checkout summary with gift cards", () => {
  it("lists each card after the total and shows the amount due", () => {
    const details = document.createElement("div");
    renderOrderSummaryDetails(details, { customerName: "Buyer" }, baseConfig, quote(partialTender));
    const text = details.textContent ?? "";
    expect(text).toContain("Gift card •••• 7K2Q");
    expect(text).toContain("-৳400");
    expect(text).toContain("Amount due");
    expect(text).toContain("৳600");
  });

  it("shows no deposit row while gift cards pay part", () => {
    const details = document.createElement("div");
    renderOrderSummaryDetails(
      details,
      {},
      { ...baseConfig, partialPaymentEnabled: true, partialPaymentAmount: 100 },
      quote(partialTender),
    );
    expect(details.textContent).not.toContain("Due now");
  });
});

describe("checkout payment with gift cards", () => {
  it("applies a code through the proxy, keeps only the handle, and re-prices the order", async () => {
    const { calls } = stubApi({
      "/api/checkout/tax-quote": [
        () => json({ success: true, data: quote() }),
        () => json({ success: true, data: quote(partialTender) }),
      ],
      "/api/gift-cards/apply": () => json({
        success: true,
        data: {
          handle: handle("a"),
          handleExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
          last4: "7K2Q",
          balance: 400,
          balanceMinor: 40_000,
          currencyCode: "BDT",
          expiresAt: null,
        },
      }),
    });
    await initCheckoutPage();

    const input = document.getElementById("giftCardCode") as HTMLInputElement;
    input.value = "abcd-efgh-jkmn-7k2q";
    document.getElementById("giftCardForm")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(calls.filter(({ url }) => url === "/api/checkout/tax-quote")).toHaveLength(2));
    await vi.waitFor(() => expect(document.getElementById("giftCardChips")?.textContent).toContain("•••• 7K2Q −৳400"));

    // The code went to the proxy in a POST body only; the quote got the handle.
    expect(calls.find(({ url }) => url === "/api/gift-cards/apply")?.body).toEqual({ code: "ABCDEFGHJKMN7K2Q" });
    expect(calls.every(({ url }) => !/ABCD|abcd/.test(url))).toBe(true);
    expect(calls[2]?.body.giftCards).toEqual([{ handle: handle("a") }]);
    expect(input.value).toBe("");
    const stored = sessionStorage.getItem(GIFT_CARD_STORAGE_KEY) ?? "";
    expect(stored).toContain(handle("a"));
    expect(stored).not.toContain("ABCDEFGHJKMN7K2Q");
    expect(JSON.stringify({ ...localStorage })).not.toContain(handle("a"));
    expect(document.getElementById("summaryDetails")?.textContent).toContain("Amount due");
    expect(document.querySelector('[data-method="cod"]')?.textContent).toContain("Pay ৳600 when you receive your order");
  });

  it("offers only 'Paid with gift card' when the cards cover everything, and places the order with it", async () => {
    sessionStorage.setItem(GIFT_CARD_STORAGE_KEY, JSON.stringify([storedCard("a")]));
    const { calls } = stubApi({
      "/api/checkout/tax-quote": () => json({ success: true, data: quote(fullTender) }),
      "/api/checkout/create-order": () => json({ success: true, data: { id: "ord_gift", paymentMethod: "gift_card" } }),
    });
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, replace, origin: window.location.origin });

    await initCheckoutPage();
    const methods = document.querySelectorAll(".payment-method-card");
    expect(methods).toHaveLength(1);
    expect(methods[0]?.textContent).toContain("Paid with gift card");
    expect(document.getElementById("payButtonText")?.textContent).toBe("Place order");

    (document.getElementById("payButton") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(replace).toHaveBeenCalled());
    const order = calls.find(({ url }) => url === "/api/checkout/create-order")!.body;
    expect(order.paymentMethod).toBe("gift_card");
    expect(order.giftCards).toEqual([{ handle: handle("a") }]);
    expect(order.expectedAmountDueMinor).toBe(0);
    // The order holds the cards now: the handles are gone from the page's storage.
    expect(sessionStorage.getItem(GIFT_CARD_STORAGE_KEY)).toBeNull();
    // Analytics sees the order total only, never a card or a handle.
    const analyticsPayload = JSON.stringify(analyticsMocks.trackStorefrontAddPaymentInfoOnce.mock.calls);
    expect(analyticsPayload).toContain("\"value\":1000");
    expect(analyticsPayload).not.toContain("gch_");
    expect(analyticsPayload).not.toContain("7K2Q");
  });

  it("shows the amount due, not the total, on a gateway's pay path and never asks for a deposit", async () => {
    sessionStorage.setItem(GIFT_CARD_STORAGE_KEY, JSON.stringify([storedCard("a")]));
    (window as unknown as { __CHECKOUT_CONFIG__: CheckoutConfig }).__CHECKOUT_CONFIG__ = {
      ...baseConfig,
      activeDefaultMethod: "sslcommerz",
      partialPaymentEnabled: true,
      partialPaymentAmount: 100,
    };
    stubApi({
      "/api/checkout/tax-quote": () => json({ success: true, data: quote({ ...partialTender, allowedPaymentMethods: ["sslcommerz"] }) }),
    });
    await initCheckoutPage();
    expect(document.getElementById("orderSummaryToggleTotal")?.textContent).toBe("৳600");
    expect(document.getElementById("summaryDetails")?.textContent).not.toContain("Due now");
    expect(document.querySelector('[data-method="sslcommerz"]')).not.toBeNull();
  });

  it("drops a card the quote refuses and tells the buyer", async () => {
    sessionStorage.setItem(GIFT_CARD_STORAGE_KEY, JSON.stringify([storedCard("a"), storedCard("b", "9XYZ")]));
    const { calls } = stubApi({
      "/api/checkout/tax-quote": [
        () => json({
          success: true,
          data: quote({
            ...partialTender,
            giftCardIssues: [{ handle: handle("b"), code: "GIFT_CARD_UNUSABLE", message: "This gift card can't be used." }],
          }),
        }),
        () => json({ success: true, data: quote(partialTender) }),
      ],
    });
    await initCheckoutPage();
    expect(document.getElementById("giftCardMessage")?.textContent).toBe("This gift card can't be used.");
    expect(document.getElementById("giftCardChips")?.textContent).not.toContain("9XYZ");
    // Quoted again without the refused card, so the order carries a matching fingerprint.
    expect(calls[1]?.body.giftCards).toEqual([{ handle: handle("a") }]);
    expect(sessionStorage.getItem(GIFT_CARD_STORAGE_KEY)).not.toContain(handle("b"));
  });

  it("re-prices and explains when a card changed before the order was placed", async () => {
    sessionStorage.setItem(GIFT_CARD_STORAGE_KEY, JSON.stringify([storedCard("a")]));
    const { calls } = stubApi({
      "/api/checkout/tax-quote": () => json({ success: true, data: quote(partialTender) }),
      "/api/checkout/create-order": () => json({
        success: false,
        errorCode: "GIFT_CARD_CHANGED",
        error: "Your gift card balance changed; review and place the order again.",
      }, 409),
    });
    await initCheckoutPage();
    (document.getElementById("payButton") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(calls.filter(({ url }) => url === "/api/checkout/tax-quote")).toHaveLength(2));
    await vi.waitFor(() => expect(document.getElementById("errorMsg")?.textContent)
      .toBe("Your gift card balance changed; review and place the order again."));
    expect(sessionStorage.getItem(GIFT_CARD_STORAGE_KEY)).toContain(handle("a"));
  });

  it("goes on without gift cards when they cannot be priced", async () => {
    sessionStorage.setItem(GIFT_CARD_STORAGE_KEY, JSON.stringify([storedCard("a")]));
    const { calls } = stubApi({
      "/api/checkout/tax-quote": [
        () => json({ success: false, error: "Current checkout total is unavailable" }, 503),
        () => json({ success: true, data: quote() }),
      ],
    });
    await initCheckoutPage();
    expect(calls[1]?.body).not.toHaveProperty("giftCards");
    expect(document.getElementById("giftCardMessage")?.textContent).toBe("Gift cards can't be used right now. Try again later.");
    expect(document.querySelector('[data-method="cod"]')).not.toBeNull();
  });
});
