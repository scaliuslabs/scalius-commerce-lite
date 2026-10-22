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
const recoveryMocks = vi.hoisted(() => ({ inspectCheckoutRecovery: vi.fn() }));

vi.mock("../checkout/recovery-status", () => recoveryMocks);

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
  TaxQuoteCartRulesError: class TaxQuoteCartRulesError extends Error {
    constructor(public readonly ruleErrors: unknown[]) { super("rules"); }
  },
  TaxQuoteDeliveryRateError: class TaxQuoteDeliveryRateError extends Error {
    constructor(public readonly shippingRates: unknown[] | null = null) { super("rate"); }
  },
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
    deliveryMethodKind: "delivery",
    requiresShipping: true,
    pickup: null,
    allowedPaymentMethods: ["cod"],
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
    <div id="checkoutRecoveryNotice" class="hidden" aria-hidden="true">
      <span id="checkoutRecoveryReference"></span><a id="checkoutRecoveryLink"></a>
    </div>
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
          <p id="submitButtonReason" hidden></p>
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
    recoveryMocks.inspectCheckoutRecovery.mockReset().mockResolvedValue("unknown");
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockReset();
    apiMocks.previewCartDiscounts.mockReset();
    apiMocks.previewCartDiscounts.mockResolvedValue(NO_DISCOUNTS);
    installStorageMocks();
    localStorage.clear();
    sessionStorage.clear();
    renderCartDom();
    window.lastShippingEventDetail = STANDARD_RATE;
    localStorage.setItem("cart:v3", JSON.stringify(cartState));
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

  it("paints the lines and totals before the availability check answers", async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      String(url).includes("validate-cart")
        ? new Promise<Response>((resolve) => { answer = resolve; })
        : Promise.resolve(new Response(JSON.stringify(VALID_CART), { status: 200, headers: { "Content-Type": "application/json" } }))));
    const root = document.getElementById("cartPageRoot")!;
    const init = initCartFunctionality();
    await vi.advanceTimersByTimeAsync(50);
    // The check is still pending: the buyer already sees their lines and totals.
    expect(root.dataset.cartState).toBe("items");
    expect(document.querySelectorAll("#cartItems li")).toHaveLength(1);
    expect(document.getElementById("cartSummary")!.classList.contains("hidden")).toBe(false);
    answer(new Response(JSON.stringify(VALID_CART), { status: 200, headers: { "Content-Type": "application/json" } }));
    await init;
    expect(root.dataset.cartState).toBe("items");
  });

  it("lands an availability issue in the line's fixed controls slot and the banner below the totals", async () => {
    const issue: CartValidationIssue = {
      index: 0,
      cartKey: CART_LINE_KEY,
      productId: "prod_1",
      variantId: "var_1",
      code: "quantity_unavailable",
      action: "reduce_quantity",
      message: "Only 1 left.",
      productName: "Rice",
      variantLabel: null,
      requestedQuantity: 3,
      availableQuantity: 1,
    };
    // The line asks for 3 of the 1 left (an answer the line already follows is not shown).
    const threeInCart = { ...cartState, items: { [CART_LINE_KEY]: { ...CART_ITEM, quantity: 3 } }, totalItems: 3, totalAmount: 300 };
    localStorage.setItem("cart:v3", JSON.stringify(threeInCart));
    cartStore.set(threeInCart);
    await initCartFunctionality();
    const line = () => document.querySelector("#cartItems li")!;
    const controls = line().querySelector(".mt-2")!;
    // Before: the controls row (stepper and price) holds the slot.
    expect(controls.className).toContain("min-h-11");
    expect(line().querySelectorAll("button[aria-label]").length).toBeGreaterThan(1);

    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { ...VALID_CART.data, valid: false, issues: [issue] },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await window.validateCartSnapshot?.();

    // After: the issue takes the same slot (same minimum height), with its repair action.
    const slot = line().querySelector("[data-cart-line-issue]")!;
    expect(slot).not.toBeNull();
    expect(slot.className).toContain("mt-2");
    expect(slot.className).toContain("min-h-11");
    expect(slot.textContent).toContain("Only 1 left.");
    expect(slot.innerHTML).toContain("reduceCartIssueItem");
    expect(line().querySelectorAll(".mt-2")).toHaveLength(1);
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

    localStorage.setItem("cart:v3", JSON.stringify({ items: {} }));
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

  it("keeps the old order's recovery notice after the buyer changes to a different cart", async () => {
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

    expect(localStorage.getItem("scalius_hosted_payment_recovery")).toContain("order_old");
    expect(document.getElementById("checkoutRecoveryNotice")?.getAttribute("aria-hidden")).toBe("false");
    expect(document.getElementById("checkoutRecoveryReference")?.textContent).toBe("order_old");
  });

  it("clears only an authoritatively expired checkout, preserving the cart and form draft", async () => {
    sessionStorage.setItem("checkoutId", "checkout_old");
    sessionStorage.setItem("scalius_checkout_data", "old transfer");
    sessionStorage.setItem("scalius_checkout_form_draft", "saved draft");
    writeHostedPaymentRecoverySession("/order-success?orderId=order_old&payment=stripe", {
      checkoutId: "checkout_old", cartItems: cartState.items,
    });
    recoveryMocks.inspectCheckoutRecovery.mockResolvedValue("expired");

    await initCartFunctionality();

    expect(localStorage.getItem("scalius_hosted_payment_recovery")).toBeNull();
    expect(sessionStorage.getItem("scalius_checkout_data")).toBeNull();
    expect(sessionStorage.getItem("checkoutId")).not.toBe("checkout_old");
    expect(sessionStorage.getItem("scalius_checkout_form_draft")).toBe("saved draft");
    expect(cartStore.get().items).toEqual({
      [CART_LINE_KEY]: { ...CART_ITEM, freeDelivery: false, propertiesHash: "none" },
    });
    expect(document.getElementById("checkoutRecoveryNotice")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("ignores a stale expiry response when another tab replaces the recovery pointer", async () => {
    let answer!: (status: string) => void;
    recoveryMocks.inspectCheckoutRecovery.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    writeHostedPaymentRecoverySession("/order-success?orderId=order_old&payment=stripe", {
      checkoutId: "checkout_old", cartItems: cartState.items,
    });
    const initializing = initCartFunctionality();
    writeHostedPaymentRecoverySession("/order-success?orderId=order_new&payment=stripe", {
      checkoutId: "checkout_new", cartItems: cartState.items,
    });
    sessionStorage.setItem("checkoutId", "checkout_new");
    answer("expired");
    await initializing;

    expect(localStorage.getItem("scalius_hosted_payment_recovery")).toContain("order_new");
    expect(sessionStorage.getItem("checkoutId")).toBe("checkout_new");
  });

  it.each([true, false])("resets a returned expired COD attempt only when this tab still owns it (matching: %s)", async (matching) => {
    document.getElementById("cartPageRoot")!.dataset.expiredCheckoutId = "checkout_old";
    sessionStorage.setItem("checkoutId", matching ? "checkout_old" : "checkout_new");
    sessionStorage.setItem("scalius_checkout_form_draft", "saved draft");
    await initCartFunctionality();
    expect(sessionStorage.getItem("checkoutId")).not.toBe("checkout_old");
    if (!matching) expect(sessionStorage.getItem("checkoutId")).toBe("checkout_new");
    expect(sessionStorage.getItem("scalius_checkout_form_draft")).toBe("saved draft");
    expect(cartStore.get().items).toEqual({
      [CART_LINE_KEY]: { ...CART_ITEM, freeDelivery: false, propertiesHash: "none" },
    });
  });

  it.each([true, false])("blocks only this tab's pending checkout (matching identity: %s)", async (matching) => {
    const checkoutId = matching ? "checkout_current" : "checkout_new";
    sessionStorage.setItem("checkoutId", checkoutId);
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
    ).toBe(matching);
    expect(sessionStorage.getItem("checkoutId")).toBe(checkoutId);
    expect(document.getElementById("checkoutRecoveryNotice")?.getAttribute("aria-hidden")).toBe("false");
  });

  it("keeps a changed cart blocked when its checkout identity is still pending", async () => {
    sessionStorage.setItem("checkoutId", "checkout_current");
    writeHostedPaymentRecoverySession("/order-success?orderId=order_current&payment=stripe", {
      checkoutId: "checkout_current", cartItems: {},
    });
    await initCartFunctionality();
    expect((document.getElementById("submitButton") as HTMLButtonElement).disabled).toBe(true);
    expect(sessionStorage.getItem("checkoutId")).toBe("checkout_current");
  });

  it("shows a normal empty cart when a different tab has a pending order", async () => {
    sessionStorage.setItem("checkoutId", "checkout_new");
    const emptyCart = { items: {}, totalItems: 0, totalAmount: 0, discountCodes: [] };
    cartStore.set(emptyCart);
    localStorage.setItem("cart:v3", JSON.stringify(emptyCart));
    writeHostedPaymentRecoverySession("/order-success?orderId=order_old&payment=stripe", {
      checkoutId: "checkout_old", cartItems: cartState.items,
    });
    await initCartFunctionality();
    expect(document.querySelector('#cartItems a[href*="order_old"]')).toBeNull();
    expect(document.getElementById("cartItems")?.textContent).toContain(ENGLISH_CHECKOUT_LANGUAGE_DATA.emptyCartText);
    expect(localStorage.getItem("scalius_hosted_payment_recovery")).toContain("order_old");
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
      // The cart asks again after a failure in transit: the fetcher and the waits.
      expect.anything(),
      expect.arrayContaining([expect.any(Number)]),
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
        expect.anything(),
        expect.arrayContaining([expect.any(Number)]),
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
    localStorage.setItem("cart:v3", JSON.stringify(emptyCart));
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

  it.each((["quantity", "remove", "remove_issue", "reduce", "refresh"] as const).flatMap((action) =>
    [false, true].map((hasRecovery) => ({ action, hasRecovery })),
  ))("preserves the submitted identity through $action repair (recovery: $hasRecovery)", async ({ action, hasRecovery }) => {
    const failedCheckoutId = "chk_session_failed_claim";
    const issue: CartValidationIssue = {
      index: 0,
      cartKey: CART_LINE_KEY,
      productId: "prod_1",
      variantId: "var_1",
      code: action === "refresh" ? "price_changed" : "quantity_unavailable",
      action: action === "refresh" ? "refresh_item" : "reduce_quantity",
      message: "Only 1 left.",
      productName: "Rice",
      variantLabel: null,
      requestedQuantity: 3,
      availableQuantity: 1,
      currentPrice: 110,
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

    localStorage.setItem("cart:v3", JSON.stringify(staleCart));
    cartStore.set(staleCart);
    sessionStorage.setItem("checkoutId", failedCheckoutId);
    if (hasRecovery) {
      writeHostedPaymentRecoverySession("/order-success?orderId=order_pending&payment=stripe", {
        checkoutId: failedCheckoutId, cartItems: staleCart.items,
      });
      recoveryMocks.inspectCheckoutRecovery.mockResolvedValue("active");
    }
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
    expect(repairStateCheckoutId).toBe(failedCheckoutId);
    expect(checkoutIdInput.value).toBe(repairStateCheckoutId);

    if (action === "quantity") window.updateCartQuantity?.(CART_LINE_KEY, 1);
    else if (action === "remove") window.removeFromCart?.(CART_LINE_KEY);
    else if (action === "remove_issue") window.removeCartIssueItem?.(CART_LINE_KEY);
    else if (action === "refresh") window.refreshCartIssueItem?.(CART_LINE_KEY);
    else window.reduceCartIssueItem?.(CART_LINE_KEY);
    await Promise.resolve();

    const resubmitCheckoutId = sessionStorage.getItem("checkoutId");
    const form = document.getElementById("checkoutForm") as HTMLFormElement;
    if (action === "remove" || action === "remove_issue") expect(cartStore.get().items[CART_LINE_KEY]).toBeUndefined();
    else if (action === "refresh") expect(cartStore.get().items[CART_LINE_KEY]?.price).toBe(110);
    else expect(cartStore.get().items[CART_LINE_KEY]?.quantity).toBe(1);
    expect(resubmitCheckoutId).toBe(failedCheckoutId);
    expect(checkoutIdInput.value).toBe(resubmitCheckoutId);
    expect(new FormData(form).get("checkoutId")).toBe(resubmitCheckoutId);
    expect(sessionStorage.getItem(CHECKOUT_CART_REPAIR_STORAGE_KEY)).toBeNull();
    if (hasRecovery) {
      expect(localStorage.getItem("scalius_hosted_payment_recovery")).toContain("order_pending");
      expect((document.getElementById("submitButton") as HTMLButtonElement).disabled).toBe(true);
    }
  });

  const submitCode = (code: string) => {
    (document.getElementById("discountCodeInput") as HTMLInputElement).value = code;
    document
      .getElementById("discountForm")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  };

  it("keeps applied codes through a quantity change and re-checks them", async () => {
    cartStore.setKey("discountCodes", ["WELCOME"]);
    localStorage.setItem("cart:v3", JSON.stringify(cartStore.get()));
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
    localStorage.setItem("cart:v3", JSON.stringify(cartStore.get()));
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
    expect(lines).toEqual(["Discount · Free delivery-৳60", "Discount · SAVE10-৳10"]);
    expect(document.getElementById("total")?.textContent).toBe("৳90");
    const applied = document.getElementById("appliedCodes")!;
    expect(applied.textContent).toContain("Add Cap to get it free.");
    expect((document.getElementById("discountCodesInput") as HTMLInputElement).value).toBe('["SAVE10"]');

    Array.from(applied.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === "Add Cap")!.click();
    await vi.advanceTimersByTimeAsync(0);
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

  it("clears the cart from the cart page's Clear cart, with Undo", async () => {
    document.getElementById("cartItems")!.insertAdjacentHTML(
      "afterend",
      `<button id="clearCartButton" type="button">Clear cart</button><p id="cartUndo" hidden></p>`,
    );
    await initCartFunctionality();

    document.getElementById("clearCartButton")!.click();
    expect(Object.keys(cartStore.get().items)).toEqual([]);
    const undo = document.getElementById("cartUndo")!;
    expect(undo.hidden).toBe(false);
    expect(undo.textContent).toContain(ENGLISH_CHECKOUT_LANGUAGE_DATA.cartClearedText);
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

  it("checks availability once when the quote refuses an unfixed line, never in a loop", async () => {
    withAddress();
    const { TaxQuoteCartChangedError } = await import("../checkout/tax-quote-client");
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockRejectedValue(new TaxQuoteCartChangedError([]));
    await initCartFunctionality();
    await vi.advanceTimersByTimeAsync(5_000);

    const cartChecks = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("validate-cart")).length;
    // One check on load and one for the refusal; the re-render that follows quotes
    // again but does not start another check while the lines are unchanged.
    expect(cartChecks()).toBeLessThanOrEqual(2);
    expect(taxQuoteMocks.fetchAuthoritativeTaxQuote.mock.calls.length).toBeLessThanOrEqual(4);

    // A change to the lines is checked again.
    cartStore.set({ ...cartState, items: { [CART_LINE_KEY]: { ...CART_ITEM, quantity: 2 } }, totalItems: 2, totalAmount: 200 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cartChecks()).toBeGreaterThan(2);
    expect(cartChecks()).toBeLessThanOrEqual(4);
  });

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

  it("retries an aborted cart check, never a refusal, and offers Try again when it still fails", async () => {
    await initCartFunctionality();
    const message = document.getElementById("cartValidationMessage")!;
    const submit = document.getElementById("submitButton") as HTMLButtonElement;
    const fetchMock = vi.mocked(fetch);

    // The first call aborts in transit; the repeat answers.
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    fetchMock.mockResolvedValue(jsonResponse(VALID_CART));
    const check = window.validateCartSnapshot?.();
    await vi.advanceTimersByTimeAsync(600);
    expect(await check).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(message.textContent).toBe("");

    // A 4xx answer is final: one call.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: "Cart is not valid." }, 400));
    await window.validateCartSnapshot?.();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(message.querySelector("[data-cart-validation-retry]")).toBeNull();

    // Every try fails: the plain error, a working Try again, and checkout stays off.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ success: false }, 503));
    const failing = window.validateCartSnapshot?.();
    await vi.advanceTimersByTimeAsync(2500);
    expect(await failing).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retry = message.querySelector<HTMLButtonElement>("[data-cart-validation-retry]")!;
    expect(retry).not.toBeNull();
    expect(submit.disabled).toBe(true);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse(VALID_CART));
    retry.click();
    await vi.waitFor(() => expect(message.classList).toContain("hidden"));
    expect(submit.disabled).toBe(false);
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
      .toEqual(["Discount · SAVE10-৳10"]);
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

  describe("store app checkout rules and options", () => {
    const MALICIOUS = '<img src=x onerror="window.__rulePwned=true">At most 10 per order.';
    const lineRule = { code: "max_qty", message: MALICIOUS, index: 0, cartKey: CART_LINE_KEY };
    const cartRule = { code: "min_total", message: "Spend ৳500 to check out.", index: null, cartKey: null };
    const banner = () => document.getElementById("cartRuleErrors")!;
    const submit = () => document.getElementById("submitButton") as HTMLButtonElement;
    const blockedCart = (ruleErrors: unknown[]) =>
      jsonResponse({ success: true, data: { ...VALID_CART.data, valid: false, ruleErrors } });

    beforeEach(() => {
      // The banner sits right above the checkout action (cart.astro).
      submit().insertAdjacentHTML(
        "beforebegin",
        `<div id="cartRuleErrors" class="hidden" role="alert" tabindex="-1"></div>`,
      );
    });

    afterEach(() => {
      delete (window as typeof window & { __rulePwned?: boolean }).__rulePwned;
    });

    it("says a rule under its line and the cart's rules above Place order, as text, and blocks checkout", async () => {
      vi.mocked(fetch).mockResolvedValue(blockedCart([lineRule, cartRule]));
      await initCartFunctionality();

      const ruleList = document.querySelector<HTMLElement>("#cartItems li [data-cart-line-rule-errors]")!;
      expect(ruleList.textContent).toBe(MALICIOUS);
      expect(document.querySelector("#cartItems img[src='x']")).toBeNull();
      // The line's controls name the rule, so it is read with them.
      const described = document.querySelectorAll(`#cartItems [aria-describedby="${ruleList.id}"]`);
      expect(described.length).toBe(3);
      // The quantity stepper stays: lowering the quantity is how the buyer meets the rule.
      expect(document.querySelector("#cartItems [data-cart-line-issue]")).toBeNull();

      expect(banner().classList.contains("hidden")).toBe(false);
      expect(banner().getAttribute("role")).toBe("alert");
      expect(banner().textContent).toContain("This order can't be placed yet.");
      expect(banner().textContent).toContain("Spend ৳500 to check out.");
      expect(banner().textContent).toContain(ENGLISH_CHECKOUT_LANGUAGE_DATA.reviewCartItemsText);
      // Said once: the summary's availability box stays quiet for rules alone.
      expect(document.getElementById("cartValidationMessage")?.classList).toContain("hidden");
      expect(submit().disabled).toBe(true);
      // The reason is a visible line the button names, not a tooltip.
      expect(document.getElementById("submitButtonReason")?.textContent).toBe("This order can't be placed yet.");
      expect(document.getElementById("submitButtonReason")?.hidden).toBe(false);
      expect(submit().getAttribute("aria-describedby")).toBe("submitButtonReason");
      expect(window.hasCartRuleErrors?.()).toBe(true);
      expect((window as typeof window & { __rulePwned?: boolean }).__rulePwned).toBeUndefined();

      // A later check without rules clears them everywhere.
      vi.mocked(fetch).mockResolvedValue(jsonResponse(VALID_CART));
      await window.validateCartSnapshot?.();
      expect(document.querySelector("#cartItems [data-cart-line-rule-errors]")).toBeNull();
      expect(document.querySelector("#cartItems [aria-describedby]")).toBeNull();
      expect(banner().classList).toContain("hidden");
      expect(submit().disabled).toBe(false);
      expect(window.hasCartRuleErrors?.()).toBe(false);
    });

    it("blocks on the quote's rules and clears them with the next quote, without another quote", async () => {
      withAddress();
      const { TaxQuoteCartRulesError } = await import("../checkout/tax-quote-client");
      taxQuoteMocks.fetchAuthoritativeTaxQuote.mockRejectedValue(new TaxQuoteCartRulesError([cartRule]));
      await initCartFunctionality();
      await vi.waitFor(() => expect(banner().classList.contains("hidden")).toBe(false));

      expect(banner().textContent).toContain("Spend ৳500 to check out.");
      expect(submit().disabled).toBe(true);
      // Not a connection problem: no retry offer.
      expect(document.getElementById("taxStatus")?.classList).toContain("hidden");
      const quotes = taxQuoteMocks.fetchAuthoritativeTaxQuote.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(taxQuoteMocks.fetchAuthoritativeTaxQuote.mock.calls.length).toBe(quotes);

      taxQuoteMocks.fetchAuthoritativeTaxQuote.mockResolvedValue(taxQuote(310));
      window.dispatchEvent(new CustomEvent("shippingLocationChange", { detail: { ...STANDARD_RATE } }));
      await vi.waitFor(() => expect(banner().classList).toContain("hidden"));
      await vi.advanceTimersByTimeAsync(400);
      expect(submit().disabled).toBe(false);
    });

    it("shows the rules the payment step handed back, from session storage", async () => {
      sessionStorage.setItem(CHECKOUT_CART_REPAIR_STORAGE_KEY, JSON.stringify({
        source: "checkout",
        message: "This order can't be placed yet.",
        issues: [],
        ruleErrors: [lineRule],
        createdAt: Date.now(),
      }));
      await initCartFunctionality();

      expect(document.querySelector("#cartItems [data-cart-line-rule-errors]")?.textContent).toBe(MALICIOUS);
      expect(submit().disabled).toBe(true);
      expect(sessionStorage.getItem(CHECKOUT_CART_REPAIR_STORAGE_KEY)).toBeNull();
      expect(window.location.search).not.toContain("max_qty");
    });

    it("hands each quote's app-changed options to the delivery options, and null when no app changed them", async () => {
      withAddress();
      const quoted = vi.fn();
      const changed = vi.fn();
      window.addEventListener("delivery-rates-quoted", quoted);
      window.addEventListener("delivery-rate-changed", changed);
      const shippingRates = [{ id: "ship_standard", name: "Standard (app)", kind: "delivery", amount: 0, amountMinor: 0 }];
      // The options already show the app's fee; the quote's own fee is never compared with it.
      window.lastShippingEventDetail = { id: "ship_standard", fee: 0, freeOver: null, name: "Standard (app)", kind: "delivery", quoted: true };
      taxQuoteMocks.fetchAuthoritativeTaxQuote.mockResolvedValue({ ...taxQuote(310), shippingRates });

      await initCartFunctionality();
      await vi.waitFor(() => expect(quoted).toHaveBeenCalled());
      expect((quoted.mock.calls.at(-1)![0] as CustomEvent).detail).toEqual({ shippingRates });
      expect(changed).not.toHaveBeenCalled();

      taxQuoteMocks.fetchAuthoritativeTaxQuote.mockResolvedValue(taxQuote(310));
      quoted.mockClear();
      window.dispatchEvent(new CustomEvent("shippingLocationChange", { detail: { ...STANDARD_RATE } }));
      await vi.waitFor(() => expect(quoted).toHaveBeenCalled());
      expect((quoted.mock.calls.at(-1)![0] as CustomEvent).detail).toEqual({ shippingRates: null });
      window.removeEventListener("delivery-rates-quoted", quoted);
      window.removeEventListener("delivery-rate-changed", changed);
    });

    it("passes the options still offered when a store app hid the chosen one", async () => {
      withAddress();
      const rejected = vi.fn();
      window.addEventListener("delivery-rate-rejected", rejected);
      const left = [{ id: "ship_2", name: "Standard", kind: "delivery", amount: 60, amountMinor: 6_000 }];
      taxQuoteMocks.fetchAuthoritativeTaxQuote.mockRejectedValue(new TaxQuoteDeliveryRateError(left as never));
      await initCartFunctionality();
      await vi.waitFor(() => expect(rejected).toHaveBeenCalled());
      expect((rejected.mock.calls[0]![0] as CustomEvent).detail).toEqual({ shippingRates: left });

      rejected.mockClear();
      vi.mocked(fetch).mockResolvedValue(jsonResponse({
        success: false,
        error: "This delivery option isn't available.",
        details: { reason: "delivery_rate_unavailable", shippingRates: left },
      }, 400));
      await window.validateCartSnapshot?.();
      expect((rejected.mock.calls[0]![0] as CustomEvent).detail).toEqual({ shippingRates: left });
      window.removeEventListener("delivery-rate-rejected", rejected);
    });
  });
});
