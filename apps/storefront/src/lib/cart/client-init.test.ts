// @vitest-environment happy-dom

import { existsSync, readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cartStore,
  createCartItemKey,
  type CartStore,
  type Discount,
} from "../../store/cart";
import type { CartValidationIssue } from "../api/orders";
import { CHECKOUT_CART_REPAIR_STORAGE_KEY } from "./repair-state";
import { initCartFunctionality } from "./client";

const apiMocks = vi.hoisted(() => ({
  getActiveCheckoutLanguage: vi.fn(),
  saveAbandonedCheckout: vi.fn(),
  validateDiscount: vi.fn(),
}));

const taxQuoteMocks = vi.hoisted(() => ({
  fetchAuthoritativeTaxQuote: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getActiveCheckoutLanguage: apiMocks.getActiveCheckoutLanguage,
  saveAbandonedCheckout: apiMocks.saveAbandonedCheckout,
  validateDiscount: apiMocks.validateDiscount,
}));

vi.mock("@/lib/analytics", () => ({
  trackFbAddToCart: vi.fn(),
  trackFbInitiateCheckout: vi.fn(),
}));

vi.mock("../checkout/tax-quote-client", () => ({
  fetchAuthoritativeTaxQuote: taxQuoteMocks.fetchAuthoritativeTaxQuote,
}));

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
  discount: null,
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

function renderCartDom() {
  document.body.innerHTML = `
    <div id="checkout-meta" data-default-shipping-id="standard" data-default-shipping-fee="60"></div>
    <div id="cartPageRoot" data-cart-ready="false" data-cart-has-items="false">
      <div id="checkoutPanel" class="hidden">
        <form id="checkoutForm">
          <input id="customerPhone" name="customerPhone" value="01700000000" />
          <input id="checkoutIdInput" name="checkoutId" type="hidden" />
          <input id="cartItemsInput" name="cartItems" type="hidden" />
          <input id="discountCodeHidden" name="discountCode" type="hidden" />
          <button id="submitButton" type="submit" disabled>Place Order</button>
        </form>
      </div>
      <div id="cartSummary" class="hidden">
        <form id="discountForm">
          <input id="discountCodeInput" />
          <button id="applyDiscountBtn" type="submit">Apply</button>
        </form>
        <button id="removeDiscountBtn" type="button"></button>
        <div id="discountMessage"></div>
        <span id="subtotal"></span>
        <span id="shippingCost"></span>
        <span id="taxLabel">Tax</span>
        <span id="taxAmount">Add city &amp; zone</span>
        <p id="taxStatus" class="hidden"></p>
        <span id="totalLabel" data-final-label="Total">Estimated total</span>
        <span id="total"></span>
      </div>
      <div id="cartValidationMessage" class="hidden"></div>
      <div id="cartItems" aria-busy="true">Loading your cart…</div>
    </div>
  `;
}

describe("initCartFunctionality", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockReset();
    installStorageMocks();
    localStorage.clear();
    sessionStorage.clear();
    renderCartDom();
    localStorage.setItem("cart", JSON.stringify(cartState));
    cartStore.set(cartState);
    apiMocks.getActiveCheckoutLanguage.mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
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
                  inventoryTracked: false,
                  availableQuantity: null,
                },
              ],
              subtotal: 100,
              hasFreeDeliveryProduct: false,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
    expect(document.getElementById("taxAmount")?.textContent).toBe(
      "Add city & zone",
    );
    expect(document.getElementById("totalLabel")?.textContent).toBe(
      "Estimated total",
    );
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
      items: [],
    });

    await initCartFunctionality();
    window.dispatchEvent(
      new CustomEvent("checkout-location-change", {
        detail: {
          cityId: "city_dhaka",
          zoneId: "zone_banani",
          areaId: "",
        },
      }),
    );
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
  });

  it("does not present a provisional amount as final when tax cannot be verified", async () => {
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
      expect(document.getElementById("taxAmount")?.textContent).toBe(
        "Unavailable",
      );
    });

    expect(document.getElementById("totalLabel")?.textContent).toBe("Total");
    expect(document.getElementById("total")?.textContent).toBe("—");
    expect(document.getElementById("taxStatus")?.classList).not.toContain(
      "hidden",
    );
    expect(document.getElementById("taxStatus")?.textContent).toContain(
      "Change the destination or try again",
    );
  });

  it("keeps operational panels hidden when hydration resolves to an empty cart", async () => {
    const emptyCart: CartStore = {
      items: {},
      totalItems: 0,
      totalAmount: 0,
      discount: null,
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

    window.dispatchEvent(
      new CustomEvent("checkout-location-change", {
        detail: {
          cityId: "city_dhaka",
          cityName: "Dhaka",
          zoneId: "zone_banani",
          zoneName: "Banani",
          areaId: "area_11",
          areaName: "Road 11",
        },
      }),
    );
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

  it("does not duplicate remove-discount listeners after repeated init", async () => {
    await initCartFunctionality();
    await initCartFunctionality();

    const discount: Discount = {
      id: "disc_1",
      code: "WELCOME",
      type: "percentage",
      valueType: "percentage",
      discountValue: 10,
      discountAmount: 10,
    };
    const removedEvents = vi.fn();
    document.addEventListener("discount-removed", removedEvents);
    cartStore.setKey("discount", discount);

    document.getElementById("removeDiscountBtn")?.click();

    expect(cartStore.get().discount).toBeNull();
    expect(removedEvents).toHaveBeenCalledTimes(1);
  });

  it("validates unrestricted discount codes before the buyer enters a phone", async () => {
    const phoneInput = document.getElementById(
      "customerPhone",
    ) as HTMLInputElement;
    phoneInput.value = "";
    apiMocks.validateDiscount.mockResolvedValue({
      valid: true,
      discount: {
        id: "disc_open",
        code: "OPEN10",
        type: "amount_off_order",
        valueType: "percentage",
        discountValue: 10,
      },
      discountAmount: 10,
    });

    await initCartFunctionality();
    const codeInput = document.getElementById(
      "discountCodeInput",
    ) as HTMLInputElement;
    codeInput.value = "open10";
    document
      .getElementById("discountForm")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect(apiMocks.validateDiscount).toHaveBeenCalledWith(
      "OPEN10",
      100,
      [expect.objectContaining(CART_ITEM)],
      60,
      undefined,
    );
    expect(cartStore.get().discount?.code).toBe("OPEN10");
  });

  it("focuses the phone field only when a one-use code requires identity", async () => {
    const phoneInput = document.getElementById(
      "customerPhone",
    ) as HTMLInputElement;
    phoneInput.value = "";
    apiMocks.validateDiscount.mockResolvedValue({
      valid: false,
      error: "Enter your phone number to check this one-use discount",
      requiresCustomerPhone: true,
    });

    await initCartFunctionality();
    const codeInput = document.getElementById(
      "discountCodeInput",
    ) as HTMLInputElement;
    codeInput.value = "ONCE";
    document
      .getElementById("discountForm")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect(apiMocks.validateDiscount).toHaveBeenCalledWith(
      "ONCE",
      100,
      [expect.objectContaining(CART_ITEM)],
      60,
      undefined,
    );
    expect(document.activeElement).toBe(phoneInput);
    expect(document.getElementById("discountMessage")?.textContent).toBe(
      "Enter your phone number to check this one-use discount",
    );
    expect(cartStore.get().discount).toBeNull();
  });

  it("keeps cart page startup free of stale checkout id and inline discount hooks", () => {
    const cartPagePath = [
      `${process.cwd()}/src/pages/cart.astro`,
      `${process.cwd()}/apps/storefront/src/pages/cart.astro`,
    ].find((path) => existsSync(path));
    expect(cartPagePath).toBeDefined();

    const cartPage = readFileSync(cartPagePath as string, "utf8");
    const clearIndex = cartPage.indexOf("clearCheckoutTransferSession();");
    const initIndex = cartPage.indexOf("void initCartFunctionality();");

    expect(clearIndex).toBeGreaterThan(-1);
    expect(initIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeLessThan(initIndex);
    expect(cartPage).not.toContain('onclick="window.removeDiscountCode()"');
    expect(cartPage).toContain(
      "window.__scaliusCartPageAbortController?.abort();",
    );
    expect(cartPage).toContain("writeCheckoutTransferSession(");
    expect(cartPage).toContain(
      "showCheckoutTransferError(transferWrite.message);",
    );
    expect(cartPage).not.toContain(
      'sessionStorage.setItem("scalius_checkout_data"',
    );
    expect(cartPage).toContain('quickBuyStorage") === "blocked"');
    expect(cartPage).toContain(
      'document.addEventListener("cart-updated", updateCheckoutButtonState',
    );
    expect(cartPage).not.toContain(
      'window.addEventListener("cart-updated", updateCheckoutButtonState',
    );
    expect(cartPage).toContain(
      "lg:sticky lg:self-start transition-all duration-200 order-1",
    );
    expect(cartPage).toContain(
      '<div id="checkoutPanel" class="hidden lg:w-7/12 order-2">',
    );
    expect(cartPage).not.toContain("order-2 lg:order-1");
    expect(cartPage).not.toContain("order-1 lg:order-2");
    expect(cartPage).toContain('id="cartPageRoot"');
    expect(cartPage).toContain('data-cart-ready="false"');
    expect(cartPage).toContain('id="cartSummary"');
    expect(cartPage).toContain('id="checkoutPanel"');
    expect(cartPage).toContain('id="taxAmount"');
    expect(cartPage).toContain('id="totalLabel"');
    expect(cartPage).toContain("Estimated total");
    expect(cartPage).toContain("Loading your cart…");
    expect(cartPage).toContain("Enable JavaScript to load your saved cart");
    expect(cartPage).toContain("window.__CHECKOUT_LANGUAGE__=");
    expect(cartPage).toContain("disabled={true}");
  });
});
