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

vi.mock("@/lib/api", () => ({
  getActiveCheckoutLanguage: apiMocks.getActiveCheckoutLanguage,
  saveAbandonedCheckout: apiMocks.saveAbandonedCheckout,
  validateDiscount: apiMocks.validateDiscount,
}));

vi.mock("@/lib/analytics", () => ({
  trackFbAddToCart: vi.fn(),
  trackFbInitiateCheckout: vi.fn(),
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
    <form id="checkoutForm">
      <input id="customerPhone" name="customerPhone" value="01700000000" />
      <input id="checkoutIdInput" name="checkoutId" type="hidden" />
      <input id="cartItemsInput" name="cartItems" type="hidden" />
      <input id="discountCodeHidden" name="discountCode" type="hidden" />
      <button id="submitButton" type="submit">Place Order</button>
    </form>
    <form id="discountForm">
      <input id="discountCodeInput" />
      <button id="applyDiscountBtn" type="submit">Apply</button>
    </form>
    <button id="removeDiscountBtn" type="button"></button>
    <div id="discountMessage"></div>
    <div id="cartValidationMessage" class="hidden"></div>
    <div id="cartItems"></div>
    <span id="subtotal"></span>
    <span id="shippingCost"></span>
    <span id="total"></span>
  `;
}

describe("initCartFunctionality", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
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
    const checkoutIdInput = document.getElementById("checkoutIdInput") as HTMLInputElement;

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

  it("reuses an active checkout id for the hidden input and abandoned checkout save", async () => {
    sessionStorage.setItem("checkoutId", "chk_session_existing");

    await initCartFunctionality();

    const checkoutIdInput = document.getElementById("checkoutIdInput") as HTMLInputElement;
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
    const checkoutIdInput = document.getElementById("checkoutIdInput") as HTMLInputElement;
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
    expect(cartPage).toContain("window.__scaliusCartPageAbortController?.abort();");
    expect(cartPage).toContain("writeCheckoutTransferSession(");
    expect(cartPage).toContain("showCheckoutTransferError(transferWrite.message);");
    expect(cartPage).not.toContain('sessionStorage.setItem("scalius_checkout_data"');
    expect(cartPage).toContain('quickBuyStorage") === "blocked"');
    expect(cartPage).toContain(
      'document.addEventListener("cart-updated", updateCheckoutButtonState',
    );
    expect(cartPage).not.toContain(
      'window.addEventListener("cart-updated", updateCheckoutButtonState',
    );
    expect(cartPage).toContain(
      'lg:sticky lg:self-start transition-all duration-200 order-1',
    );
    expect(cartPage).toContain('<div class="lg:w-7/12 order-2">');
    expect(cartPage).not.toContain("order-2 lg:order-1");
    expect(cartPage).not.toContain("order-1 lg:order-2");
  });
});
