// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";

import {
  cartStore,
  createCartItemKey,
  type CartStore,
} from "../../store/cart";
import type { CartValidationIssue } from "../api/orders";
import type { CheckoutTaxQuote } from "../checkout/tax-quote-contract";
import { CHECKOUT_CART_REPAIR_STORAGE_KEY } from "./repair-state";
import { writeHostedPaymentRecoverySession } from "../checkout/session-state";
import {
  initCartFunctionality,
  isDiscountValidationPending,
  resumeCartPageFromHistory,
} from "./client";
import { TaxQuoteDeliveryLocationError, TaxQuoteDeliveryRateError } from "../checkout/tax-quote-client";

const apiMocks = vi.hoisted(() => ({
  saveAbandonedCheckout: vi.fn(),
  previewCartDiscounts: vi.fn(),
}));

const taxQuoteMocks = vi.hoisted(() => ({
  fetchAuthoritativeTaxQuote: vi.fn(),
}));

const analyticsMocks = vi.hoisted(() => ({
  trackFbAddToCart: vi.fn(),
  trackFbInitiateCheckout: vi.fn(),
}));

vi.mock("./browser-api", () => ({
  saveAbandonedCheckoutFromBrowser: apiMocks.saveAbandonedCheckout,
  previewCartDiscounts: apiMocks.previewCartDiscounts,
}));

vi.mock("@/lib/analytics", () => ({
  trackFbAddToCart: analyticsMocks.trackFbAddToCart,
  trackFbInitiateCheckout: analyticsMocks.trackFbInitiateCheckout,
}));

vi.mock("../checkout/tax-quote-client", () => ({
  fetchAuthoritativeTaxQuote: taxQuoteMocks.fetchAuthoritativeTaxQuote,
  TaxQuoteCartChangedError: class TaxQuoteCartChangedError extends Error {},
  TaxQuoteDeliveryRateError: class TaxQuoteDeliveryRateError extends Error {},
  TaxQuoteDeliveryLocationError: class TaxQuoteDeliveryLocationError extends Error {
    constructor(public readonly field: string) { super("gone"); }
  },
}));

const NO_DISCOUNTS = { ok: true, totalDiscount: 0, discounts: [], offers: [], rejectedCodes: [] };

const CART_ITEM = {
  id: "prod_1",
  name: "Rice",
  price: 100,
  quantity: 1,
  variantId: "var_1",
};
const CART_LINE_KEY = createCartItemKey(CART_ITEM);

const cartState: CartStore = {
  items: {
    [CART_LINE_KEY]: CART_ITEM,
  },
  totalItems: 1,
  totalAmount: 100,
  discountCodes: [],
};

function taxQuote(totalAmount: number, zone = "zone_banani"): CheckoutTaxQuote {
  return {
    valid: true,
    quoteFingerprint: `taxq_${zone.padEnd(22, "0")}`,
    discounts: [],
    offers: [],
    rejectedCodes: [],
    displayLabel: "VAT",
    pricesIncludeTax: false,
    shippingTaxed: true,
    currencyCode: "BDT",
    decimalPlaces: 2,
    settingsVersion: 4,
    subtotalMinor: 10_000,
    subtotalAmount: 100,
    shippingMinor: 6_000,
    shippingAmount: 60,
    discountMinor: 0,
    discountAmount: 0,
    taxMinor: Math.round((totalAmount - 160) * 100),
    taxAmount: totalAmount - 160,
    totalMinor: Math.round(totalAmount * 100),
    totalAmount,
    shippingMethod: {
      id: "ship_standard",
      name: "Standard delivery",
      description: null,
      baseAmountMinor: 6_000,
      feeWaived: false,
    },
    items: [],
  };
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: vi.fn(() => store.clear()),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, String(value));
    }),
  };
}

function installStorageMocks() {
  const local = createMemoryStorage();
  const session = createMemoryStorage();

  Object.defineProperty(globalThis, "localStorage", {
    value: local,
    configurable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: session,
    configurable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: local,
    configurable: true,
  });
  Object.defineProperty(window, "sessionStorage", {
    value: session,
    configurable: true,
  });
}

/** The delivery rate the address's options chose (see lib/checkout/shipping-methods). */
const STANDARD_RATE = { id: "standard", fee: 60, freeOver: null, name: "Standard", kind: "delivery" as const };

/** A new address: the options re-read its rates, then announce the chosen one. */
function moveTo(detail: Record<string, string>) {
  window.dispatchEvent(new CustomEvent("checkout-location-change", { detail }));
  window.dispatchEvent(new CustomEvent("shippingLocationChange", { detail: STANDARD_RATE }));
}

function renderCartDom() {
  document.body.innerHTML = `
    <div id="checkout-meta"></div>
    <div id="cartPageRoot" data-cart-ready="false" data-cart-has-items="false">
      <div id="checkoutPanel" class="hidden">
        <form id="checkoutForm">
          <input id="customerPhone-input" value="" />
          <input id="customerPhone" name="customerPhone" value="01700000000" />
          <input id="checkoutIdInput" name="checkoutId" type="hidden" />
          <input id="expectedQuoteFingerprint" name="expectedQuoteFingerprint" type="hidden" />
          <input id="cartItemsInput" name="cartItems" type="hidden" />
          <input id="discountCodesInput" name="discountCodes" type="hidden" />
          <button id="submitButton" type="submit" disabled>Place Order</button>
        </form>
      </div>
      <div id="cartSummary" class="hidden">
        <span id="subtotal"></span>
        <span id="shippingCost"></span>
        <p id="shippingProgress" class="hidden"></p>
        <div id="discountLines"></div>
        <div id="taxRow" class="hidden"><span id="taxLabel">Tax</span><span id="taxAmount">—</span></div>
        <p id="taxStatus" class="hidden"></p>
        <form id="discountForm">
          <input id="discountCodeInput" />
          <button id="applyDiscountBtn" type="submit">Apply</button>
          <p id="discountMessage" hidden></p>
        </form>
        <ul id="appliedCodes" class="hidden"></ul>
        <ul id="discountOffers" class="hidden"></ul>
        <span id="totalLabel" data-final-label="Total">Estimated total</span>
        <span id="total"></span>
      </div>
      <div id="cartValidationMessage" class="hidden"></div>
      <div id="cartItems" aria-busy="true">Loading your cart…</div>
    </div>
  `;
}

const VALID_CART = {
  success: true,
  data: {
    valid: true,
    issues: [],
    items: [
      {
        index: 0,
        cartKey: CART_LINE_KEY,
        productId: "prod_1",
        variantId: "var_1",
        quantity: 1,
        unitPrice: 100,
        productName: "Rice",
        variantLabel: null,
        freeDelivery: false,
        inventoryTracked: false,
        availableQuantity: null,
      },
    ],
    subtotal: 100,
    hasFreeDeliveryProduct: false,
  },
};

describe("initCartFunctionality", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockReset();
    apiMocks.previewCartDiscounts.mockReset();
    apiMocks.previewCartDiscounts.mockResolvedValue(NO_DISCOUNTS);
    installStorageMocks();
    localStorage.clear();
    sessionStorage.clear();
    renderCartDom();
    window.lastShippingEventDetail = STANDARD_RATE;
    localStorage.setItem("cart", JSON.stringify(cartState));
    cartStore.set(cartState);
    window.__CHECKOUT_LANGUAGE__ = { languageData: ENGLISH_CHECKOUT_LANGUAGE_DATA };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(VALID_CART), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete window.lastShippingEventDetail;
  });

  it("keeps one checkout id and one abandoned-checkout listener across repeated init", async () => {
    await initCartFunctionality();
    const firstCheckoutId = sessionStorage.getItem("checkoutId");
    const checkoutIdInput = document.getElementById(
      "checkoutIdInput",
    ) as HTMLInputElement;

    expect(firstCheckoutId).toMatch(/^chk_session_/);
    expect(checkoutIdInput.value).toBe(firstCheckoutId);

    await initCartFunctionality();
    expect(sessionStorage.getItem("checkoutId")).toBe(firstCheckoutId);
    expect(checkoutIdInput.value).toBe(firstCheckoutId);

    document
      .getElementById("checkoutForm")
      ?.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1500);

    expect(apiMocks.saveAbandonedCheckout).toHaveBeenCalledTimes(1);
    expect(apiMocks.saveAbandonedCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutId: firstCheckoutId,
        customerPhone: "01700000000",
      }),
    );
  });

  it("does not revalidate a cart solely because validation reconciled server metadata", async () => {
    await initCartFunctionality();

    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(350);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reconciles an accepted order when the cart document returns from BFCache", async () => {
    await initCartFunctionality();
    const originalCheckoutId = sessionStorage.getItem("checkoutId");
    expect(originalCheckoutId).toBeTruthy();
    expect(cartStore.get().totalItems).toBe(1);

    localStorage.setItem("cart", JSON.stringify({ items: {} }));
    sessionStorage.removeItem("checkoutId");

    await resumeCartPageFromHistory();

    expect(cartStore.get().items).toEqual({});
    expect(
      (document.getElementById("cartItemsInput") as HTMLInputElement).value,
    ).toBe("{}");
    expect(sessionStorage.getItem("checkoutId")).toBeTruthy();
    expect(sessionStorage.getItem("checkoutId")).not.toBe(originalCheckoutId);
    expect(
      (document.getElementById("submitButton") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("uses one validation and quote when a populated cart returns from browser history", async () => {
    document.getElementById("checkoutForm")?.insertAdjacentHTML(
      "beforeend",
      `
        <input name="city" value="city_bagerhat" />
        <input name="zone" value="zone_bajua" />
      `,
    );
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockResolvedValue(taxQuote(170));

    await initCartFunctionality();
    vi.mocked(fetch).mockClear();
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockClear();

    await resumeCartPageFromHistory();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(taxQuoteMocks.fetchAuthoritativeTaxQuote).toHaveBeenCalledTimes(1);
    expect(document.getElementById("total")?.textContent).toBe("৳170");
  });

  it("tracks checkout initiation from the visible phone control blur", async () => {
    const canonicalPhone = document.querySelector<HTMLInputElement>(
      '[name="customerPhone"]',
    )!;
    canonicalPhone.value = "+8801712345678";
    canonicalPhone.dataset.e164Value = "+8801712345678";

    await initCartFunctionality();
    document
      .getElementById("customerPhone-input")
      ?.dispatchEvent(new FocusEvent("blur"));

    await vi.waitFor(() =>
      expect(analyticsMocks.trackFbInitiateCheckout).toHaveBeenCalledTimes(1),
    );
  });

  it("clears an old hosted-payment pointer after the buyer changes to a different cart", async () => {
    expect(
      writeHostedPaymentRecoverySession(
        "/order-success?orderId=order_old&payment=sslcommerz",
        {
          checkoutId: "checkout_old",
          cartItems: {
            old_line: {
              id: "old_product",
              variantId: "old_variant",
              quantity: 1,
            },
          },
        },
      ),
    ).toBe(true);

    await initCartFunctionality();

    expect(localStorage.getItem("scalius_hosted_payment_recovery")).toBeNull();
  });

  it("keeps the recovery pointer while the cart still matches the pending checkout", async () => {
    expect(
      writeHostedPaymentRecoverySession(
        "/order-success?orderId=order_current&payment=sslcommerz",
        {
          checkoutId: "checkout_current",
          cartItems: cartState.items,
        },
      ),
    ).toBe(true);

    await initCartFunctionality();

    expect(localStorage.getItem("scalius_hosted_payment_recovery")).toContain(
      "order_current",
    );
    expect(
      (document.getElementById("submitButton") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("reveals truthful cart and checkout panels only after stored items hydrate", async () => {
    const root = document.getElementById("cartPageRoot") as HTMLElement;
    const cartSummary = document.getElementById("cartSummary") as HTMLElement;
    const checkoutPanel = document.getElementById(
      "checkoutPanel",
    ) as HTMLElement;
    const cartItems = document.getElementById("cartItems") as HTMLElement;

    await initCartFunctionality();

    expect(root.dataset.cartReady).toBe("true");
    expect(root.dataset.cartHasItems).toBe("true");
    expect(cartSummary.classList.contains("hidden")).toBe(false);
    expect(checkoutPanel.classList.contains("hidden")).toBe(false);
    expect(cartItems.getAttribute("aria-busy")).toBe("false");
    expect(cartItems.textContent).toContain("Rice");
    expect(document.getElementById("taxAmount")?.textContent).toBe("—");
    expect(document.getElementById("totalLabel")?.textContent).toBe(
      "Estimated total",
    );
  });

  it("stops quantity increases at the last validated available stock", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            valid: true,
            issues: [],
            items: [
              {
                index: 0,
                cartKey: CART_LINE_KEY,
                productId: "prod_1",
                variantId: "var_1",
                quantity: 1,
                unitPrice: 100,
                productName: "Rice",
                variantLabel: null,
                freeDelivery: false,
                inventoryTracked: true,
                availableQuantity: 2,
              },
            ],
            subtotal: 100,
            hasFreeDeliveryProduct: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await initCartFunctionality();

    const increase = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Increase Rice quantity"]',
    );
    expect(increase?.disabled).toBe(false);
    window.updateCartQuantity?.(CART_LINE_KEY, 2);
    await vi.advanceTimersByTimeAsync(0);

    expect(cartStore.get().items[CART_LINE_KEY]?.quantity).toBe(2);
    const cappedIncrease = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Maximum available quantity reached for Rice"]',
    );
    expect(cappedIncrease?.disabled).toBe(true);

    window.updateCartQuantity?.(CART_LINE_KEY, 99);
    expect(cartStore.get().items[CART_LINE_KEY]?.quantity).toBe(2);
  });

  it("replaces provisional cart totals with the authoritative destination quote", async () => {
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockResolvedValue({
      valid: true,
      quoteFingerprint: "taxq_1234567890123456789012",
      displayLabel: "VAT",
      pricesIncludeTax: false,
      shippingTaxed: true,
      currencyCode: "BDT",
      decimalPlaces: 2,
      settingsVersion: 4,
      subtotalMinor: 10_000,
      subtotalAmount: 100,
      shippingMinor: 6_000,
      shippingAmount: 60,
      discountMinor: 0,
      discountAmount: 0,
      taxMinor: 1_120,
      taxAmount: 11.2,
      totalMinor: 17_120,
      totalAmount: 171.2,
      discounts: [],
      offers: [],
      rejectedCodes: [],
      shippingMethod: { id: "standard", name: "Standard", description: null, baseAmountMinor: 6_000, feeWaived: false },
      items: [],
    });

    await initCartFunctionality();
    moveTo({ cityId: "city_dhaka", zoneId: "zone_banani", areaId: "", });
    await vi.waitFor(() => {
      expect(document.getElementById("taxAmount")?.textContent).toBe("৳11.20");
    });

    expect(taxQuoteMocks.fetchAuthoritativeTaxQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        city: "city_dhaka",
        zone: "zone_banani",
        shippingMethodId: "standard",
        cartItems: expect.stringContaining('"variantId":"var_1"'),
      }),
    );
    expect(document.getElementById("taxLabel")?.textContent).toBe("VAT");
    expect(document.getElementById("shippingCost")?.textContent).toBe("৳60");
    expect(document.getElementById("totalLabel")?.textContent).toBe("Total");
    expect(document.getElementById("total")?.textContent).toBe("৳171.20");
    expect(document.getElementById("taxStatus")?.classList).toContain("hidden");
    expect((document.getElementById("expectedQuoteFingerprint") as HTMLInputElement).value)
      .toBe("taxq_1234567890123456789012");
  });

  it("omits an incomplete display-only calling code and still requests the location quote", async () => {
    const phoneInput = document.querySelector<HTMLInputElement>(
      '[name="customerPhone"]',
    )!;
    phoneInput.value = "+880";
    phoneInput.dataset.e164Value = "";
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockResolvedValue(taxQuote(171.2));

    await initCartFunctionality();
    moveTo({ cityId: "city_bagerhat", zoneId: "zone_bagerhat_sadar", areaId: "", });

    await vi.waitFor(() => {
      expect(taxQuoteMocks.fetchAuthoritativeTaxQuote).toHaveBeenCalledWith(
        expect.objectContaining({
          city: "city_bagerhat",
          zone: "zone_bagerhat_sadar",
          customerPhone: undefined,
        }),
      );
      expect(document.getElementById("total")?.textContent).toBe("৳171.20");
    });
  });

  it("keeps the newest location quote when an older request settles later", async () => {
    let resolveFirst:
      ((value: ReturnType<typeof taxQuote>) => void) | undefined;
    let resolveSecond:
      ((value: ReturnType<typeof taxQuote>) => void) | undefined;
    taxQuoteMocks.fetchAuthoritativeTaxQuote
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );

    await initCartFunctionality();
    moveTo({ cityId: "city_bagerhat", zoneId: "zone_bajua", areaId: "" });
    await Promise.resolve();
    moveTo({ cityId: "city_baria", zoneId: "zone_akhaura", areaId: "" });
    await Promise.resolve();

    resolveSecond?.(taxQuote(175, "zone_akhaura"));
    await Promise.resolve();
    expect(document.getElementById("total")?.textContent).toBe("৳175");
    expect((document.getElementById("expectedQuoteFingerprint") as HTMLInputElement).value)
      .toBe("taxq_zone_akhaura0000000000");

    resolveFirst?.(taxQuote(170, "zone_bajua"));
    await Promise.resolve();
    expect(document.getElementById("total")?.textContent).toBe("৳175");
    expect((document.getElementById("expectedQuoteFingerprint") as HTMLInputElement).value)
      .toBe("taxq_zone_akhaura0000000000");
  });

  it("shows an estimate and a retry, never a final total, when the total cannot be verified", async () => {
    document.getElementById("checkoutForm")?.insertAdjacentHTML(
      "beforeend",
      `
        <input name="city" value="city_dhaka" />
        <input name="zone" value="zone_banani" />
      `,
    );
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockRejectedValue(
      new Error("quote unavailable"),
    );

    await initCartFunctionality();
    await vi.waitFor(() => {
      expect(document.getElementById("taxStatus")?.classList).not.toContain("hidden");
    });

    expect(document.getElementById("totalLabel")?.textContent).toBe("Estimated total");
    expect(document.getElementById("total")?.textContent).toBe("৳160");
    expect(document.getElementById("taxStatus")?.textContent).toContain(
      "We couldn't update the total",
    );
    expect(document.querySelector("#taxStatus button")?.textContent).toBe("Try again");
    expect((document.getElementById("expectedQuoteFingerprint") as HTMLInputElement).value)
      .toBe("");
  });

  it("keeps operational panels hidden when hydration resolves to an empty cart", async () => {
    const emptyCart: CartStore = {
      items: {},
      totalItems: 0,
      totalAmount: 0,
      discountCodes: [],
    };
    localStorage.setItem("cart", JSON.stringify(emptyCart));
    cartStore.set(emptyCart);

    await initCartFunctionality();

    const root = document.getElementById("cartPageRoot") as HTMLElement;
    const submit = document.getElementById("submitButton") as HTMLButtonElement;
    expect(root.dataset.cartReady).toBe("true");
    expect(root.dataset.cartHasItems).toBe("false");
    expect(
      document.getElementById("cartSummary")?.classList.contains("hidden"),
    ).toBe(true);
    expect(
      document.getElementById("checkoutPanel")?.classList.contains("hidden"),
    ).toBe(true);
    expect(
      document.getElementById("cartItems")?.getAttribute("aria-busy"),
    ).toBe("false");
    expect(submit.disabled).toBe(true);
  });

  it("reuses an active checkout id for the hidden input and abandoned checkout save", async () => {
    sessionStorage.setItem("checkoutId", "chk_session_existing");

    await initCartFunctionality();

    const checkoutIdInput = document.getElementById(
      "checkoutIdInput",
    ) as HTMLInputElement;
    expect(sessionStorage.getItem("checkoutId")).toBe("chk_session_existing");
    expect(checkoutIdInput.value).toBe("chk_session_existing");

    window.handleAbandonedCheckout?.();
    await vi.advanceTimersByTimeAsync(1500);

    expect(apiMocks.saveAbandonedCheckout).toHaveBeenCalledTimes(1);
    expect(apiMocks.saveAbandonedCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutId: "chk_session_existing",
        customerPhone: "01700000000",
      }),
    );
  });

  it("debounces abandoned checkout saves through the global cart runtime hook", async () => {
    await initCartFunctionality();
    const firstCheckoutId = sessionStorage.getItem("checkoutId");

    window.handleAbandonedCheckout?.();
    window.handleAbandonedCheckout?.();
    await vi.advanceTimersByTimeAsync(1499);
    expect(apiMocks.saveAbandonedCheckout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(apiMocks.saveAbandonedCheckout).toHaveBeenCalledTimes(1);
    expect(apiMocks.saveAbandonedCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutId: firstCheckoutId,
        customerPhone: "01700000000",
      }),
    );
  });

  it("keeps readable delivery names in abandoned checkout recovery context", async () => {
    await initCartFunctionality();

    moveTo({ cityId: "city_dhaka", cityName: "Dhaka", zoneId: "zone_banani", zoneName: "Banani", areaId: "area_11", areaName: "Road 11", });
    await vi.advanceTimersByTimeAsync(1500);

    expect(apiMocks.saveAbandonedCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutData: expect.objectContaining({
          cityName: "Dhaka",
          zoneName: "Banani",
          areaName: "Road 11",
        }),
      }),
    );
  });

  it("rotates a failed checkout id before resubmitting a repaired cart", async () => {
    const failedCheckoutId = "chk_session_failed_claim";
    const issue: CartValidationIssue = {
      index: 0,
      cartKey: CART_LINE_KEY,
      productId: "prod_1",
      variantId: "var_1",
      code: "QUANTITY_UNAVAILABLE",
      action: "reduce_quantity",
      message: "Only 1 left.",
      productName: "Rice",
      variantLabel: null,
      requestedQuantity: 3,
      availableQuantity: 1,
    };
    const staleCart: CartStore = {
      ...cartState,
      items: {
        [CART_LINE_KEY]: {
          ...cartState.items[CART_LINE_KEY]!,
          quantity: 3,
        },
      },
      totalItems: 3,
      totalAmount: 300,
    };

    localStorage.setItem("cart", JSON.stringify(staleCart));
    cartStore.set(staleCart);
    sessionStorage.setItem("checkoutId", failedCheckoutId);
    sessionStorage.setItem(
      CHECKOUT_CART_REPAIR_STORAGE_KEY,
      JSON.stringify({
        source: "checkout",
        message: "Some items in your cart need attention.",
        issues: [issue],
        createdAt: Date.now(),
      }),
    );
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            valid: false,
            issues: [issue],
            items: [],
            subtotal: 300,
            hasFreeDeliveryProduct: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await initCartFunctionality();

    const repairStateCheckoutId = sessionStorage.getItem("checkoutId");
    const checkoutIdInput = document.getElementById(
      "checkoutIdInput",
    ) as HTMLInputElement;
    expect(repairStateCheckoutId).toMatch(/^chk_session_/);
    expect(repairStateCheckoutId).not.toBe(failedCheckoutId);
    expect(checkoutIdInput.value).toBe(repairStateCheckoutId);

    window.reduceCartIssueItem?.(CART_LINE_KEY);
    await Promise.resolve();

    const resubmitCheckoutId = sessionStorage.getItem("checkoutId");
    const form = document.getElementById("checkoutForm") as HTMLFormElement;
    expect(cartStore.get().items[CART_LINE_KEY]?.quantity).toBe(1);
    expect(resubmitCheckoutId).toMatch(/^chk_session_/);
    expect(resubmitCheckoutId).not.toBe(failedCheckoutId);
    expect(resubmitCheckoutId).not.toBe(repairStateCheckoutId);
    expect(checkoutIdInput.value).toBe(resubmitCheckoutId);
    expect(new FormData(form).get("checkoutId")).toBe(resubmitCheckoutId);
    expect(sessionStorage.getItem(CHECKOUT_CART_REPAIR_STORAGE_KEY)).toBeNull();
  });

  const submitCode = (code: string) => {
    (document.getElementById("discountCodeInput") as HTMLInputElement).value = code;
    document
      .getElementById("discountForm")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  };

  it("keeps applied codes through a quantity change and re-checks them", async () => {
    cartStore.setKey("discountCodes", ["WELCOME"]);
    localStorage.setItem("cart", JSON.stringify(cartStore.get()));
    await initCartFunctionality();
    apiMocks.previewCartDiscounts.mockClear();

    window.updateCartQuantity?.(CART_LINE_KEY, 2);
    await vi.advanceTimersByTimeAsync(400);

    expect(cartStore.get().discountCodes).toEqual(["WELCOME"]);
    expect(apiMocks.previewCartDiscounts).toHaveBeenCalledWith(
      ["WELCOME"],
      [expect.objectContaining({ id: "prod_1", quantity: 2 })],
      60,
      expect.anything(),
    );
  });

  it("lists one line per discount and says what a code still needs, with a one-tap add", async () => {
    cartStore.setKey("discountCodes", ["SAVE10", "CAPGIFT"]);
    localStorage.setItem("cart", JSON.stringify(cartStore.get()));
    apiMocks.previewCartDiscounts.mockResolvedValue({
      ok: true,
      totalDiscount: 70,
      discounts: [
        { promotionId: "p_auto", title: "Free delivery", code: null, amount: 60, shippingAmount: 0 },
        { promotionId: "p_code", title: "Eid 10%", code: "SAVE10", amount: 10, shippingAmount: 0 },
      ],
      offers: [],
      rejectedCodes: [{
        code: "CAPGIFT",
        reason: "get_items",
        message: "Add Cap to your cart to get it free.",
        offer: {
          promotionId: "p_gift", title: "Cap gift", code: "CAPGIFT", kind: "get",
          percentOff: 100, quantity: 1, shortfallAmount: null,
          products: [{ id: "prod_cap", slug: "cap", name: "Cap", variantId: "var_cap", price: 200 }],
        },
      }],
    });

    await initCartFunctionality();
    await vi.advanceTimersByTimeAsync(0);

    const lines = Array.from(document.querySelectorAll("#discountLines > div")).map((row) => row.textContent);
    expect(lines).toEqual(["Discount · Free delivery-৳60", "Discount · Eid 10% (SAVE10)-৳10"]);
    expect(document.getElementById("total")?.textContent).toBe("৳90");
    const applied = document.getElementById("appliedCodes")!;
    expect(applied.textContent).toContain("Add Cap to get it free.");
    expect((document.getElementById("discountCodesInput") as HTMLInputElement).value).toBe('["SAVE10"]');

    Array.from(applied.querySelectorAll("button")).find((button) => button.textContent === "Add Cap")!.click();
    expect(Object.values(cartStore.get().items).map(({ id }) => id)).toEqual(["prod_1", "prod_cap"]);
    expect(cartStore.get().discountCodes).toEqual(["SAVE10", "CAPGIFT"]);
  });

  it("answers every Apply and keeps the message until the code is edited", async () => {
    apiMocks.previewCartDiscounts.mockResolvedValue({
      ...NO_DISCOUNTS,
      rejectedCodes: [{ code: "ZZZ", reason: "not_found", message: "This discount code is not valid." }],
    });
    await initCartFunctionality();
    const message = document.getElementById("discountMessage")!;

    submitCode("zzz");
    await vi.advanceTimersByTimeAsync(0);
    expect(message.textContent).toBe(ENGLISH_CHECKOUT_LANGUAGE_DATA.invalidDiscountCodeText);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(message.hidden).toBe(false);

    apiMocks.previewCartDiscounts.mockResolvedValue({
      ...NO_DISCOUNTS,
      rejectedCodes: [{ code: "ZZY", reason: "not_combinable", message: "x", conflictsWith: "SAVE10" }],
    });
    submitCode("ZZY");
    await vi.advanceTimersByTimeAsync(0);
    expect(message.textContent).toBe("ZZY can't be combined with SAVE10.");
    expect(cartStore.get().discountCodes).toEqual([]);

    document.getElementById("discountCodeInput")!.dispatchEvent(new Event("input"));
    expect(message.hidden).toBe(true);

    submitCode("x".repeat(60));
    expect(message.textContent).toBe(ENGLISH_CHECKOUT_LANGUAGE_DATA.invalidDiscountCodeText);
  });

  it("keeps a code the buyer can still qualify for and asks for the phone a one-use code needs", async () => {
    const phoneInput = document.getElementById("customerPhone-input") as HTMLInputElement;
    apiMocks.previewCartDiscounts.mockResolvedValue({
      ...NO_DISCOUNTS,
      rejectedCodes: [{
        code: "ONCE",
        reason: "needs_phone",
        message: "Enter your phone number to check this one-use discount.",
        requiresCustomerPhone: true,
      }],
    });
    await initCartFunctionality();

    submitCode("once");
    await vi.advanceTimersByTimeAsync(0);

    expect(apiMocks.previewCartDiscounts).toHaveBeenCalledWith(
      ["ONCE"],
      [expect.objectContaining(CART_ITEM)],
      60,
      expect.anything(),
    );
    expect(cartStore.get().discountCodes).toEqual(["ONCE"]);
    expect(document.activeElement).toBe(phoneInput);
    expect(document.getElementById("appliedCodes")?.textContent).toContain(
      "Enter your phone number to use ONCE.",
    );
  });

  it("does not start a second check while Apply is pending, and ignores it after a reset", async () => {
    await initCartFunctionality();
    let resolvePreview!: (value: typeof NO_DISCOUNTS) => void;
    apiMocks.previewCartDiscounts.mockClear();
    apiMocks.previewCartDiscounts.mockImplementation(
      () => new Promise((resolve) => { resolvePreview = resolve; }),
    );

    submitCode("OPEN10");
    submitCode("OPEN10");
    await Promise.resolve();
    expect(apiMocks.previewCartDiscounts).toHaveBeenCalledTimes(1);
    expect(isDiscountValidationPending()).toBe(true);
    expect((document.getElementById("submitButton") as HTMLButtonElement).disabled).toBe(true);

    apiMocks.previewCartDiscounts.mockResolvedValue(NO_DISCOUNTS);
    await initCartFunctionality();
    expect(isDiscountValidationPending()).toBe(false);
    resolvePreview(NO_DISCOUNTS);
    await Promise.resolve();
    await Promise.resolve();
    expect(cartStore.get().discountCodes).toEqual([]);
  });

  it("offers Undo after a line is removed", async () => {
    document.getElementById("cartItems")!.insertAdjacentHTML("afterend", `<p id="cartUndo" hidden></p>`);
    await initCartFunctionality();

    window.removeFromCart?.(CART_LINE_KEY);
    const undo = document.getElementById("cartUndo")!;
    expect(undo.hidden).toBe(false);
    expect(undo.textContent).toContain("Rice removed");
    undo.querySelector("button")!.click();
    expect(cartStore.get().items[CART_LINE_KEY]?.quantity).toBe(1);
  });

  const withAddress = () =>
    document.getElementById("checkoutForm")?.insertAdjacentHTML(
      "beforeend",
      `<input name="city" value="city_ctg" /><input name="zone" value="zone_agrabad" />`,
    );
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("re-reads the delivery options instead of reporting a failed total when the quote refuses the rate", async () => {
    withAddress();
    const rejected = vi.fn();
    window.addEventListener("delivery-rate-rejected", rejected);
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockRejectedValue(new TaxQuoteDeliveryRateError());

    await initCartFunctionality();
    await vi.waitFor(() => expect(rejected).toHaveBeenCalled());

    expect(document.getElementById("taxStatus")?.classList).toContain("hidden");
    expect(document.getElementById("taxStatus")?.textContent).not.toContain("couldn't update");
    window.removeEventListener("delivery-rate-rejected", rejected);
  });

  it("asks for the thana again, never the connection, when the merchant removed it (R3-SB-04)", async () => {
    withAddress();
    const gone = vi.fn();
    window.addEventListener("delivery-location-unavailable", gone);
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockRejectedValue(new TaxQuoteDeliveryLocationError("zone"));

    await initCartFunctionality();
    await vi.waitFor(() => expect(gone).toHaveBeenCalled());
    expect((gone.mock.calls[0]![0] as CustomEvent).detail).toEqual({ field: "zone" });
    expect(document.getElementById("taxStatus")?.textContent).not.toContain("connection");

    // The cart check that follows says nothing of its own: the thana field says it once.
    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      success: false,
      error: "Selected thana is no longer available for the chosen city.",
      details: { reason: "delivery_location_unavailable", field: "zone" },
    }, 400));
    gone.mockClear();
    await window.validateCartSnapshot?.();
    expect(gone).toHaveBeenCalledWith(expect.objectContaining({ detail: { field: "zone" } }));
    expect(document.getElementById("cartValidationMessage")?.classList).toContain("hidden");
    expect(document.getElementById("cartValidationMessage")?.textContent).toBe("");
    window.removeEventListener("delivery-location-unavailable", gone);
  });

  it("clears a delivery refusal once the buyer picks an option that applies", async () => {
    withAddress();
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockResolvedValue(taxQuote(310));
    await initCartFunctionality();

    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      success: false,
      error: "This delivery option isn't available for the selected address. Choose another delivery option.",
    }, 400));
    await window.validateCartSnapshot?.();
    const message = document.getElementById("cartValidationMessage")!;
    const submit = document.getElementById("submitButton") as HTMLButtonElement;
    expect(message.textContent).toContain("isn't available");
    expect(submit.disabled).toBe(true);

    vi.mocked(fetch).mockImplementation(async () => jsonResponse(VALID_CART));
    window.dispatchEvent(new CustomEvent("shippingLocationChange", {
      detail: { id: "ctg", fee: 150, freeOver: 3000, name: "Ctg Delivery", kind: "delivery" },
    }));
    await vi.advanceTimersByTimeAsync(400);

    await vi.waitFor(() => expect(message.classList).toContain("hidden"));
    expect(message.textContent).toBe("");
    expect(submit.disabled).toBe(false);
  });

  it("does not block checkout on a refused rate the options can replace", async () => {
    withAddress();
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockResolvedValue(taxQuote(310));
    await initCartFunctionality();
    const rejected = vi.fn();
    window.addEventListener("delivery-rate-rejected", rejected);

    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      success: false,
      error: "This delivery option isn't available for the selected address.",
      details: { reason: "delivery_rate_unavailable" },
    }, 400));
    await window.validateCartSnapshot?.();

    expect(rejected).toHaveBeenCalledTimes(1);
    expect(document.getElementById("cartValidationMessage")?.classList).toContain("hidden");
    window.removeEventListener("delivery-rate-rejected", rejected);
  });

  it("charges nothing for a rate once the items reach its free-over threshold", async () => {
    window.lastShippingEventDetail = { id: "ctg", fee: 150, freeOver: 100, name: "Ctg", kind: "delivery" };
    await initCartFunctionality();
    await vi.advanceTimersByTimeAsync(0);
    // The rate's fee is struck through next to "Free".
    expect(document.querySelector("#shippingCost s")?.textContent).toBe("৳150");
    expect(document.getElementById("shippingCost")?.textContent).toBe("৳150Free");
  });

  it("shows a delivery discount on the delivery line, not as a discount line", async () => {
    apiMocks.previewCartDiscounts.mockResolvedValue({
      ok: true,
      totalDiscount: 70,
      discounts: [
        { promotionId: "p_ship", title: "Free delivery", code: "SHIPFREE", amount: 0, shippingAmount: 60 },
        { promotionId: "p_save", title: "Eid 10%", code: "SAVE10", amount: 10, shippingAmount: 0 },
      ],
      offers: [],
      rejectedCodes: [],
    });
    await initCartFunctionality();
    await vi.advanceTimersByTimeAsync(0);
    const shipping = document.getElementById("shippingCost")!;
    expect(shipping.querySelector("s")?.textContent).toBe("৳60");
    expect(shipping.textContent).toBe("৳60Free(SHIPFREE)");
    expect(Array.from(document.querySelectorAll("#discountLines > div")).map((row) => row.textContent))
      .toEqual(["Discount · Eid 10% (SAVE10)-৳10"]);
    expect(document.getElementById("total")?.textContent).toBe("৳90");
  });

  it("says how much more buys free delivery with the chosen rate", async () => {
    window.lastShippingEventDetail = { id: "ctg", fee: 150, freeOver: 300, name: "Ctg", kind: "delivery" };
    await initCartFunctionality();
    await vi.advanceTimersByTimeAsync(0);
    const progress = document.getElementById("shippingProgress")!;
    expect(progress.classList.contains("hidden")).toBe(false);
    expect(progress.textContent).toBe("Add ৳200 more for free delivery.");
  });

  it("shows shipping as not yet known before an option applies to the address", async () => {
    delete window.lastShippingEventDetail;
    await initCartFunctionality();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("shippingCost")?.textContent).toBe("—");
    expect(document.getElementById("total")?.textContent).toBe("৳100");
  });
});
