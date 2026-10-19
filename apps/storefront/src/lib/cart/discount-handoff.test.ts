// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ENGLISH_CHECKOUT_LANGUAGE_DATA, formatCheckoutLanguageText } from "@scalius/shared/checkout-language";
import { formatMoney } from "@scalius/shared/currency";
import { cartStore, createCartItemKey, type CartStore } from "../../store/cart";
import type { DeliveryRate } from "../checkout/shipping-methods";
import { readCheckoutFormDraft, writeHostedPaymentRecoverySession } from "../checkout/session-state";
import { initCartFunctionality, updateTotals } from "./client";
import { runCartPageScript } from "./cart-page-harness";
import type { CheckoutTaxQuote } from "../checkout/tax-quote-contract";

const apiMocks = vi.hoisted(() => ({
  saveAbandonedCheckout: vi.fn(),
  previewCartDiscounts: vi.fn(),
  getCustomerSession: vi.fn(),
}));

const taxQuoteMocks = vi.hoisted(() => ({
  fetchAuthoritativeTaxQuote: vi.fn(),
}));

vi.mock("./browser-api", () => ({
  saveAbandonedCheckoutFromBrowser: apiMocks.saveAbandonedCheckout,
  previewCartDiscounts: apiMocks.previewCartDiscounts,
}));

vi.mock("../checkout/tax-quote-client", () => ({
  fetchAuthoritativeTaxQuote: taxQuoteMocks.fetchAuthoritativeTaxQuote,
  TaxQuoteCartChangedError: class TaxQuoteCartChangedError extends Error {},
  TaxQuoteCartRulesError: class TaxQuoteCartRulesError extends Error {},
  TaxQuoteDeliveryRateError: class TaxQuoteDeliveryRateError extends Error {},
  TaxQuoteDeliveryLocationError: class TaxQuoteDeliveryLocationError extends Error {},
}));

/** The rates the API offers for the form's address (Dhaka / Banani). */
const STANDARD: DeliveryRate = {
  id: "standard", name: "Standard", fee: 60, description: null, freeOver: null,
  kind: "delivery", pickupAddress: null, pickupHours: null,
};
const deliveryRates = vi.fn(async (): Promise<DeliveryRate[] | null> => [STANDARD]);

const NO_DISCOUNTS = { ok: true, totalDiscount: 0, discounts: [], offers: [], rejectedCodes: [] };
const SAVE10_LINE = { promotionId: "p_save", title: "Save 10", code: "SAVE10", amount: 10, shippingAmount: 0 };

const CART_ITEM = {
  id: "prod_1",
  name: "Rice",
  price: 100,
  quantity: 1,
  variantId: "var_1",
  freeDelivery: false,
};
const CART_LINE_KEY = createCartItemKey(CART_ITEM);
const CART_STATE: CartStore = {
  items: { [CART_LINE_KEY]: CART_ITEM },
  totalItems: 1,
  totalAmount: 100,
  discountCodes: [],
};

let pageController: AbortController | undefined;

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => values.delete(key)),
    setItem: vi.fn((key: string, value: string) => values.set(key, String(value))),
  };
}

function installStorageMocks(): void {
  const local = createMemoryStorage();
  const session = createMemoryStorage();
  for (const [key, value] of [["localStorage", local], ["sessionStorage", session]] as const) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
    Object.defineProperty(window, key, { value, configurable: true });
  }
}

function renderCartDom(): void {
  document.body.innerHTML = `
    <div id="checkout-meta" data-cod-only="false" data-checkout-unavailable="false"
      data-guest-checkout-enabled="true"></div>
    <div id="cartPageRoot" data-cart-ready="false" data-cart-has-items="false">
      <div id="checkoutPanel"><form id="checkoutForm">
        <input name="formIntent" value="checkout" />
        <input id="customerName" name="customerName" value="Synthetic buyer" />
        <p id="customerName-error" class="hidden"></p>
        <div id="customerPhone-field" data-default-country="BD">
          <input id="customerPhone-input" value="01712345678" />
          <input type="hidden" name="customerPhone" data-e164-value="" />
        </div>
        <p id="customerPhone-error" class="hidden"></p>
        <input id="customerEmail" name="customerEmail" value="" />
        <p id="customerEmail-error" class="hidden"></p>
        <textarea id="shippingAddress" name="shippingAddress">Synthetic checkout address</textarea>
        <p id="shippingAddressError" class="hidden"></p>
        <div data-location-fields>
          <input id="checkout-city" name="city" value="city_dhaka" />
          <input id="checkout-zone" name="zone" value="zone_banani" />
        </div>
        <p id="shippingLocationError" class="hidden"></p>
        <div data-shipping-methods data-free-text="Free" data-free-over-text="Free over {amount}"
          data-fee-changed-text="${ENGLISH_CHECKOUT_LANGUAGE_DATA.deliveryFeeChangedText}"
          data-no-delivery-text="${ENGLISH_CHECKOUT_LANGUAGE_DATA.noDeliveryToAddressText}">
          <script type="application/json" data-shipping-rates>[]</script>
          <fieldset id="shippingMethods"><p data-shipping-note></p><p data-shipping-notice class="hidden"></p><div data-shipping-options></div></fieldset>
          <p id="shippingMethodError" class="hidden"></p>
        </div>
        <input id="checkoutIdInput" name="checkoutId" type="hidden" />
        <input id="expectedQuoteFingerprint" name="expectedQuoteFingerprint" value="taxq_1234567890123456789012" />
        <input id="cartItemsInput" name="cartItems" type="hidden" />
        <input id="discountCodesInput" name="discountCodes" type="hidden" />
        <div id="checkoutFormMessage" class="hidden"></div>
        <button id="submitButton" type="submit"><span id="submitButtonText">Continue to payment</span></button>
      </form></div>
      <div id="cartSummary"><form id="discountForm">
        <input id="discountCodeInput" />
        <button id="applyDiscountBtn" type="submit">Apply</button>
        <p id="discountMessage" hidden></p>
      </form>
      <div id="discountLines"></div><ul id="appliedCodes" class="hidden"></ul>
      <ul id="discountOffers" class="hidden"></ul><span id="subtotal"></span>
      <span id="shippingCost"></span><div id="taxRow"><span id="taxLabel"></span><span id="taxAmount"></span></div>
      <p id="shippingProgress" class="hidden"></p>
      <p id="taxStatus"></p><span id="totalLabel" data-final-label="Total"></span><span id="total"></span><p id="estimateNote" class="hidden"></p></div>
      <div id="cartValidationMessage" class="hidden"></div><div id="cartItems"></div>
    </div>`;
  window.__CHECKOUT_CONFIG__ = { allowedCountries: [], allowedCountriesMode: "include" } as never;
  window.__CHECKOUT_LANGUAGE__ = { languageData: ENGLISH_CHECKOUT_LANGUAGE_DATA };
}

function taxQuote(): CheckoutTaxQuote {
  const discounted = cartStore.get().discountCodes.includes("SAVE10");
  const totalAmount = discounted ? 150 : 160;
  return {
    valid: true,
    quoteFingerprint: "taxq_1234567890123456789012",
    discounts: discounted ? [SAVE10_LINE] : [],
    offers: [],
    rejectedCodes: [],
    displayLabel: "VAT",
    pricesIncludeTax: false,
    shippingTaxed: true,
    currencyCode: "BDT",
    decimalPlaces: 2,
    settingsVersion: 1,
    subtotalMinor: 10_000,
    subtotalAmount: 100,
    shippingMinor: 6_000,
    shippingAmount: 60,
    discountMinor: discounted ? 1_000 : 0,
    discountAmount: discounted ? 10 : 0,
    taxMinor: 0,
    taxAmount: 0,
    totalMinor: totalAmount * 100,
    totalAmount,
    deliveryMethodKind: "delivery",
    requiresShipping: true,
    pickup: null,
    allowedPaymentMethods: ["cod"],
    shippingMethod: { id: "standard", name: "Standard", description: null, baseAmountMinor: 6_000, feeWaived: false },
    items: [],
  };
}

async function startCartPage(): Promise<void> {
  let initialization!: Promise<void>;
  runCartPageScript({
    initCartFunctionality: () => initialization = initCartFunctionality(),
    resumeCartPageFromHistory: () => Promise.resolve(),
    getCustomerSession: apiMocks.getCustomerSession,
    fetchDeliveryRates: deliveryRates,
    browserApiUrl: (path: string) => path,
    hideCheckoutLoadingOverlay: vi.fn(),
    showCheckoutLoadingOverlay: vi.fn(),
  });
  document.dispatchEvent(new Event("DOMContentLoaded"));
  pageController = window.__scaliusCartPageAbortController;
  await initialization;
  await vi.advanceTimersByTimeAsync(400);
}

function submitCheckout(): Event {
  const event = new Event("submit", { bubbles: true, cancelable: true });
  document.getElementById("checkoutForm")?.dispatchEvent(event);
  return event;
}

async function settleCheckout(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
  }
}

describe("cart discount checkout handoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
    installStorageMocks();
    localStorage.setItem("cart:v3", JSON.stringify(CART_STATE));
    cartStore.set(CART_STATE);
    renderCartDom();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Response(JSON.stringify({
      success: true,
      data: { valid: true, issues: [], items: [{ index: 0, cartKey: CART_LINE_KEY, productId: "prod_1", variantId: "var_1", quantity: 1, unitPrice: 100, productName: "Rice", variantLabel: null, freeDelivery: false, inventoryTracked: false, availableQuantity: null }], subtotal: 100, hasFreeDeliveryProduct: false },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockImplementation(async () => taxQuote());
    apiMocks.previewCartDiscounts.mockResolvedValue(NO_DISCOUNTS);
    apiMocks.getCustomerSession.mockResolvedValue({ authenticated: false });
  });

  afterEach(() => {
    pageController?.abort();
    pageController = undefined;
    delete window.lastShippingEventDetail;
    delete window.__CURRENCY_CODE__;
    deliveryRates.mockResolvedValue([STANDARD]);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const applyCode = (code: string) => {
    (document.getElementById("discountCodeInput") as HTMLInputElement).value = code;
    document.getElementById("applyDiscountBtn")?.click();
  };

  it("offers an earned automatic free item with a one-tap add", async () => {
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockImplementation(async () => ({
      ...taxQuote(),
      offers: [{
        promotionId: "p_gift", title: "Buy a tee, get a cap free", code: null, kind: "get",
        percentOff: 100, quantity: 1, shortfallAmount: null,
        products: [{ id: "prod_cap", slug: "cap", name: "Cap", variantId: "var_cap", price: 200 }],
      }],
    }));
    await startCartPage();
    const offers = document.getElementById("discountOffers")!;
    expect(offers.classList.contains("hidden")).toBe(false);
    expect(offers.textContent).toContain("Choose your free gift");
    expect(offers.textContent).toContain("Buy a tee, get a cap free");
    expect(offers.textContent).toContain("Cap");
    expect(offers.querySelector("button")?.textContent).toBe("Add");
    expect(offers.querySelector("button")?.getAttribute("aria-label")).toBe("Add Cap");
  });

  it("holds native submit until a deferred Apply settles, then transfers the applied code", async () => {
    await startCartPage();
    let resolvePreview!: (value: unknown) => void;
    apiMocks.previewCartDiscounts.mockImplementation(
      () => new Promise((resolve) => { resolvePreview = resolve; }),
    );

    applyCode("SAVE10");
    await Promise.resolve();
    expect((document.getElementById("submitButton") as HTMLButtonElement).disabled).toBe(true);

    const blockedSubmit = submitCheckout();
    await vi.advanceTimersByTimeAsync(0);
    expect(blockedSubmit.defaultPrevented).toBe(true);
    expect(document.getElementById("checkoutFormMessage")?.textContent).toBe("");
    expect(sessionStorage.getItem("scalius_checkout_data")).toBeNull();

    apiMocks.previewCartDiscounts.mockResolvedValue({ ...NO_DISCOUNTS, totalDiscount: 10, discounts: [SAVE10_LINE] });
    resolvePreview({ ...NO_DISCOUNTS, totalDiscount: 10, discounts: [SAVE10_LINE] });
    await settleCheckout();

    expect(cartStore.get().discountCodes).toEqual(["SAVE10"]);
    expect((document.getElementById("discountCodesInput") as HTMLInputElement).value).toBe('["SAVE10"]');
    const transferredSubmit = submitCheckout();
    await settleCheckout();
    expect(transferredSubmit.defaultPrevented).toBe(true);
    const transferred = JSON.parse(sessionStorage.getItem("scalius_checkout_data")!);
    expect(JSON.parse(transferred.discountCodes)).toEqual(["SAVE10"]);
  });

  it("requires a new explicit submit after a refused Apply and transfers no code", async () => {
    await startCartPage();
    let resolvePreview!: (value: unknown) => void;
    apiMocks.previewCartDiscounts.mockImplementation(
      () => new Promise((resolve) => { resolvePreview = resolve; }),
    );
    applyCode("BAD10");
    await Promise.resolve();
    const blockedSubmit = submitCheckout();
    await vi.advanceTimersByTimeAsync(0);
    expect(blockedSubmit.defaultPrevented).toBe(true);
    resolvePreview({ ...NO_DISCOUNTS, rejectedCodes: [{ code: "BAD10", reason: "not_found", message: "x" }] });
    await settleCheckout();
    expect(sessionStorage.getItem("scalius_checkout_data")).toBeNull();
    expect(cartStore.get().discountCodes).toEqual([]);

    const transferredSubmit = submitCheckout();
    await settleCheckout();
    expect(transferredSubmit.defaultPrevented).toBe(true);
    expect(JSON.parse(sessionStorage.getItem("scalius_checkout_data")!).discountCodes).toBe("");
  });

  it("sends the rate chosen for the address and quotes nothing before it", async () => {
    await startCartPage();
    await settleCheckout();
    expect(deliveryRates).toHaveBeenCalledWith("", { cityId: "city_dhaka", zoneId: "zone_banani", areaId: "" });
    expect(taxQuoteMocks.fetchAuthoritativeTaxQuote).toHaveBeenCalled();
    for (const [request] of taxQuoteMocks.fetchAuthoritativeTaxQuote.mock.calls) {
      expect(request).toMatchObject({ shippingMethodId: "standard" });
    }

    const submit = submitCheckout();
    await settleCheckout();
    expect(submit.defaultPrevented).toBe(true);
    const transferred = JSON.parse(sessionStorage.getItem("scalius_checkout_data")!);
    expect(transferred).toMatchObject({ shippingMethodId: "standard", shippingCharge: "60" });
  });

  it("keeps an app-quoted delivery charge for a free-delivery product in estimates and checkout handoff", async () => {
    const freeCart = { ...CART_STATE, items: { [CART_LINE_KEY]: { ...CART_STATE.items[CART_LINE_KEY]!, freeDelivery: true } } };
    localStorage.setItem("cart:v3", JSON.stringify(freeCart));
    cartStore.set(freeCart);
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({
      success: true,
      data: { valid: true, issues: [], items: [{ index: 0, cartKey: CART_LINE_KEY, productId: "prod_1", variantId: "var_1", quantity: 1,
        unitPrice: 100, productName: "Rice", variantLabel: null, freeDelivery: true, inventoryTracked: false, availableQuantity: null }],
      subtotal: 100, hasFreeDeliveryProduct: true },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const quoted = (): CheckoutTaxQuote => ({
      ...taxQuote(), shippingMinor: 8000, shippingAmount: 80, totalMinor: 18000, totalAmount: 180,
      shippingMethod: { id: "standard", name: "Standard", description: null, baseAmountMinor: 8000, feeWaived: false },
      shippingRates: [{ id: "standard", name: "Standard", kind: "delivery", amount: 80, amountMinor: 8000 }],
    });
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockImplementation(async () => quoted());
    await startCartPage();
    await settleCheckout();
    expect(cartStore.get().items[CART_LINE_KEY]?.freeDelivery).toBe(true);
    expect(window.lastShippingEventDetail).toMatchObject({ fee: 80, quoted: true });
    expect(document.querySelector('[data-rate-id="standard"] [data-fee-label]')?.textContent).toBe("৳80");

    let resolveQuote!: (quote: CheckoutTaxQuote) => void;
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockImplementationOnce(() => new Promise((resolve) => { resolveQuote = resolve; }));
    const updating = updateTotals();
    await Promise.resolve();
    expect(document.getElementById("shippingCost")?.textContent).toBe("৳80");
    resolveQuote(quoted());
    await updating;
    submitCheckout();
    await settleCheckout();
    const transferred = JSON.parse(sessionStorage.getItem("scalius_checkout_data")!);
    expect(transferred).toMatchObject({ shippingMethodId: "standard", shippingCharge: "80" });
  });

  it.each([
    { code: "JPY", places: 0, feeMinor: 2, discountMinor: 1 },
    { code: "USD", places: 2, feeMinor: 105, discountMinor: 1 },
    { code: "KWD", places: 3, feeMinor: 1005, discountMinor: 1 },
  ])("keeps $code shipping discounts and free-delivery progress exact", async ({ code, places, feeMinor, discountMinor }) => {
    window.__CURRENCY_CODE__ = code;
    const scale = 10 ** places;
    const fee = feeMinor / scale;
    const discount = discountMinor / scale;
    deliveryRates.mockResolvedValue([{ ...STANDARD, fee, freeOver: 100 + 1 / scale }]);
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockImplementation(async () => ({
      ...taxQuote(), currencyCode: code, decimalPlaces: places, subtotalMinor: 100 * scale,
      shippingMinor: feeMinor, shippingAmount: fee, discountMinor, discountAmount: discount,
      discounts: [{ promotionId: "shipping", title: "Shipping offer", code: "SHIP", amount: discount, shippingAmount: discount }],
      totalMinor: 100 * scale + feeMinor - discountMinor, totalAmount: 100 + fee - discount,
      shippingMethod: { id: "standard", name: "Standard", description: null, baseAmountMinor: feeMinor, feeWaived: false },
    }));
    await startCartPage();
    await settleCheckout();
    const shipping = document.getElementById("shippingCost")!;
    expect(shipping.querySelector("s")?.textContent).toBe(formatMoney(fee));
    expect(shipping.textContent).toContain(formatMoney((feeMinor - discountMinor) / scale));
    expect(document.getElementById("shippingProgress")?.textContent).toBe(formatCheckoutLanguageText(
      ENGLISH_CHECKOUT_LANGUAGE_DATA.freeDeliveryProgressText, { amount: formatMoney(1 / scale) },
    ));
    submitCheckout();
    await settleCheckout();
    expect(JSON.parse(sessionStorage.getItem("scalius_checkout_data")!).shippingCharge).toBe(String(fee));
  });

  it("stops Place order to say the delivery fee changed, never blaming the cart items", async () => {
    await startCartPage();
    await settleCheckout();
    deliveryRates.mockResolvedValue([{ ...STANDARD, fee: 80 }]);

    const submit = submitCheckout();
    await settleCheckout();

    expect(submit.defaultPrevented).toBe(true);
    expect(document.querySelector("[data-shipping-notice]")?.textContent).toBe(
      formatCheckoutLanguageText(ENGLISH_CHECKOUT_LANGUAGE_DATA.deliveryFeeChangedText, { old: "৳60", new: "৳80" }),
    );
    expect(document.getElementById("checkoutFormMessage")?.textContent).not.toContain(
      ENGLISH_CHECKOUT_LANGUAGE_DATA.reviewCartItemsText,
    );
    expect(sessionStorage.getItem("scalius_checkout_data")).toBeNull();
    deliveryRates.mockResolvedValue([STANDARD]);
  });

  it("refreshes the delivery options as soon as the total shows a changed fee", async () => {
    // The options were read at ৳60; since then the merchant made the rate ৳80.
    deliveryRates.mockResolvedValueOnce([STANDARD]).mockResolvedValue([{ ...STANDARD, fee: 80 }]);
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockImplementation(async () => ({
      ...taxQuote(),
      shippingMinor: 8_000,
      shippingAmount: 80,
      totalMinor: 18_000,
      totalAmount: 180,
      shippingMethod: { id: "standard", name: "Standard", description: null, baseAmountMinor: 8_000, feeWaived: false },
    }));

    await startCartPage();
    await settleCheckout();

    // No Place order needed: the option and the summary agree, and the buyer is told why.
    expect(document.querySelector("[data-shipping-notice]")?.textContent).toBe(
      formatCheckoutLanguageText(ENGLISH_CHECKOUT_LANGUAGE_DATA.deliveryFeeChangedText, { old: "৳60", new: "৳80" }),
    );
    expect(document.querySelector('[data-rate-id="standard"] [data-fee-label]')?.textContent).toBe("৳80");
    expect(document.getElementById("shippingCost")?.textContent).toBe("৳80");
    expect(window.lastShippingEventDetail?.fee).toBe(80);
    deliveryRates.mockReset();
    deliveryRates.mockResolvedValue([STANDARD]);
  });

  it("says once, at the thana, that the merchant removed it, and Place order goes back there (R3-SB-04)", async () => {
    await startCartPage();
    window.dispatchEvent(new CustomEvent("delivery-location-unavailable", { detail: { field: "zone" } }));
    const error = document.getElementById("shippingLocationError")!;
    expect(error.textContent).toBe("That thana is no longer available. Choose another.");
    expect(error.classList).not.toContain("hidden");
    expect(document.getElementById("checkout-zone")?.getAttribute("aria-invalid")).toBe("true");

    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({
      success: false,
      error: "Selected thana is no longer available for the chosen city.",
      details: { reason: "delivery_location_unavailable", field: "zone" },
    }), { status: 400, headers: { "Content-Type": "application/json" } }));
    submitCheckout();
    await settleCheckout();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement?.id).toBe("checkout-zone");
    expect(document.getElementById("checkoutFormMessage")?.classList).toContain("hidden");
    expect(document.body.textContent).not.toContain("Selected thana is no longer available");
    expect(document.body.textContent?.match(/That thana is no longer available/g)).toHaveLength(1);
  });

  it("asks for a delivery option when none applies to the address", async () => {
    deliveryRates.mockResolvedValueOnce([]);
    await startCartPage();
    await settleCheckout();

    const submit = submitCheckout();
    await settleCheckout();

    expect(submit.defaultPrevented).toBe(true);
    expect(document.getElementById("shippingMethodError")?.textContent)
      .toBe(ENGLISH_CHECKOUT_LANGUAGE_DATA.deliveryRequiredText);
    expect(document.querySelector("[data-shipping-note]")?.textContent)
      .toBe(ENGLISH_CHECKOUT_LANGUAGE_DATA.noDeliveryToAddressText);
    expect(taxQuoteMocks.fetchAuthoritativeTaxQuote).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("scalius_checkout_data")).toBeNull();
  });

  it("marks every missing field at once, under each field, and focuses the first", async () => {
    await startCartPage();
    (document.getElementById("customerName") as HTMLInputElement).value = "";
    (document.getElementById("customerPhone-input") as HTMLInputElement).value = "";
    (document.getElementById("customerEmail") as HTMLInputElement).value = "abc@";
    (document.getElementById("shippingAddress") as HTMLTextAreaElement).value = "";
    (document.getElementById("checkout-zone") as HTMLInputElement).value = "";

    const submit = submitCheckout();
    await settleCheckout();

    expect(submit.defaultPrevented).toBe(true);
    const errorOf = (id: string) => document.getElementById(id)?.textContent;
    expect(errorOf("customerName-error")).toBe(ENGLISH_CHECKOUT_LANGUAGE_DATA.nameRequiredText);
    expect(errorOf("customerPhone-error")).toBe(ENGLISH_CHECKOUT_LANGUAGE_DATA.phoneRequiredText);
    expect(errorOf("customerEmail-error")).toBe(ENGLISH_CHECKOUT_LANGUAGE_DATA.emailInvalidText);
    expect(errorOf("shippingAddressError")).toBe(ENGLISH_CHECKOUT_LANGUAGE_DATA.addressRequiredText);
    expect(errorOf("shippingLocationError")).toBe(ENGLISH_CHECKOUT_LANGUAGE_DATA.zoneRequiredText);
    // With a city chosen, the zone (not the city) is the field marked.
    expect(document.getElementById("checkout-zone")?.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("checkout-city")?.hasAttribute("aria-invalid")).toBe(false);
    expect(document.getElementById("customerName")?.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement?.id).toBe("customerName");
    expect(sessionStorage.getItem("scalius_checkout_data")).toBeNull();

    // A fixed field clears its own message immediately.
    const name = document.getElementById("customerName") as HTMLInputElement;
    name.value = "Rahim Uddin";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    expect(errorOf("customerName-error")).toBe("");
    expect(name.hasAttribute("aria-invalid")).toBe(false);
  });

  it("replaces a guest's typed details with the account's when the buyer signs in", async () => {
    await startCartPage();
    const name = document.getElementById("customerName") as HTMLInputElement;
    name.value = "Previous Buyer";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);
    expect(readCheckoutFormDraft()?.customerName).toBe("Previous Buyer");

    window.dispatchEvent(new CustomEvent("customer-login", {
      detail: {
        customerId: "cust_2", name: "Account Owner", email: "owner@example.com",
        defaultAddress: { countryCode: "BD", line1: "Owner road 12, Dhaka" },
      },
    }));
    expect(name.value).toBe("Account Owner");
    expect((document.getElementById("customerEmail") as HTMLInputElement).value).toBe("owner@example.com");
    expect(readCheckoutFormDraft()?.customerName).toBe("Account Owner");

    window.dispatchEvent(new CustomEvent("customer-logout"));
    expect(name.value).toBe("");
    expect(readCheckoutFormDraft()).toBeNull();
  });

  it("asks the server, not the readable auth cookie, before an account-only checkout", async () => {
    document.getElementById("checkout-meta")!.setAttribute("data-guest-checkout-enabled", "false");
    document.cookie = "cs_auth=1; path=/";
    await startCartPage();
    apiMocks.getCustomerSession.mockResolvedValue({ authenticated: false });
    const openAuth = vi.fn();
    window.addEventListener("open-auth-modal", openAuth);

    const submit = submitCheckout();
    await settleCheckout();

    expect(submit.defaultPrevented).toBe(true);
    expect(openAuth).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("scalius_checkout_data")).toBeNull();
    window.removeEventListener("open-auth-modal", openAuth);
    document.cookie = "cs_auth=; Max-Age=0; path=/";
  });

  it("leaves a sold-out line and its offer out of the estimate, and says so", async () => {
    const mug = { id: "prod_2", name: "Mug", price: 50, quantity: 2, variantId: "var_2", freeDelivery: false };
    const mugKey = createCartItemKey(mug);
    const cart = { ...CART_STATE, items: { ...CART_STATE.items, [mugKey]: mug }, totalItems: 3, totalAmount: 200 };
    localStorage.setItem("cart:v3", JSON.stringify(cart));
    cartStore.set(cart);
    const rice = { index: 0, cartKey: CART_LINE_KEY, productId: "prod_1", variantId: "var_1", quantity: 1, unitPrice: 100,
      productName: "Rice", variantLabel: null, freeDelivery: false, inventoryTracked: false, availableQuantity: null };
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({
      success: true,
      data: {
        valid: false, subtotal: 100, hasFreeDeliveryProduct: false, items: [rice],
        issues: [{ index: 1, cartKey: mugKey, productId: "prod_2", variantId: "var_2", code: "PRODUCT_UNAVAILABLE", action: "remove",
          message: "Mug is sold out.", productName: "Mug", variantLabel: null, requestedQuantity: 2, availableQuantity: 0 }],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    // The quote refuses a cart that changed: the totals are the estimate.
    const { TaxQuoteCartChangedError } = await import("../checkout/tax-quote-client");
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockRejectedValue(new TaxQuoteCartChangedError("cart changed"));
    // A buy-one-get-one on the mug would discount it; it is not counted.
    apiMocks.previewCartDiscounts.mockImplementation(async (_codes: string[], lines: Array<{ id: string }>) =>
      lines.some((line) => line.id === "prod_2") ? { ...NO_DISCOUNTS, totalDiscount: 50 } : NO_DISCOUNTS);
    await startCartPage();
    await settleCheckout();

    expect(document.getElementById("subtotal")?.textContent).toBe(formatMoney(100));
    const lastPreview = apiMocks.previewCartDiscounts.mock.calls.at(-1)!;
    expect((lastPreview[1] as Array<{ id: string }>).map((line) => line.id)).toEqual(["prod_1"]);
    const note = document.getElementById("estimateNote")!;
    expect(note.classList.contains("hidden")).toBe(false);
    expect(note.textContent).toBe(formatCheckoutLanguageText(ENGLISH_CHECKOUT_LANGUAGE_DATA.estimateLeavesOutText, { items: "Mug" }));
    expect((document.getElementById("submitButton") as HTMLButtonElement).disabled).toBe(true);
  });

  it("names the items a cash-only store can't take, and why, instead of blaming the total", async () => {
    document.getElementById("checkout-meta")!.setAttribute("data-cod-only", "true");
    const line = { index: 0, cartKey: CART_LINE_KEY, productId: "prod_1", variantId: "var_1", quantity: 1, unitPrice: 100,
      variantLabel: null, freeDelivery: false, inventoryTracked: false, availableQuantity: null, fulfillmentKind: "digital" };
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({
      success: true,
      data: {
        valid: true, issues: [], subtotal: 100, hasFreeDeliveryProduct: false, requiresDeliveryMethod: false, allowedPaymentMethods: [],
        items: [{ ...line, productName: "Licence key", fulfillmentType: "digital" }],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockImplementation(async () => ({ ...taxQuote(), allowedPaymentMethods: [] }));
    await startCartPage();
    await settleCheckout();

    const message = document.getElementById("cartValidationMessage")!;
    expect(message.classList.contains("hidden")).toBe(false);
    expect(message.textContent).toBe(formatCheckoutLanguageText(ENGLISH_CHECKOUT_LANGUAGE_DATA.cartOnlinePaymentRequiredText, { items: "Licence key" }));
    expect(message.textContent).not.toContain("order total");
    expect((document.getElementById("submitButton") as HTMLButtonElement).disabled).toBe(true);
  });

  it("holds COD submit while Apply is pending, then permits the normal submit", async () => {
    document.getElementById("checkout-meta")!.setAttribute("data-cod-only", "true");
    await startCartPage();
    let resolvePreview!: (value: unknown) => void;
    apiMocks.previewCartDiscounts.mockImplementation(
      () => new Promise((resolve) => { resolvePreview = resolve; }),
    );

    const form = document.getElementById("checkoutForm") as HTMLFormElement;
    const submitEvents: boolean[] = [];
    form.addEventListener("submit", (event) => submitEvents.push(event.defaultPrevented));
    applyCode("SAVE10");
    await vi.advanceTimersByTimeAsync(0);

    const blockedSubmit = submitCheckout();
    await vi.advanceTimersByTimeAsync(0);
    expect(blockedSubmit.defaultPrevented).toBe(true);
    expect(submitEvents).toEqual([true]);
    expect(sessionStorage.getItem("scalius_checkout_data")).toBeNull();

    apiMocks.previewCartDiscounts.mockResolvedValue({ ...NO_DISCOUNTS, totalDiscount: 10, discounts: [SAVE10_LINE] });
    resolvePreview({ ...NO_DISCOUNTS, totalDiscount: 10, discounts: [SAVE10_LINE] });
    await settleCheckout();

    const normalSubmit = submitCheckout();
    await settleCheckout();
    expect(normalSubmit.defaultPrevented).toBe(true);
    expect(submitEvents).toEqual([true, true, false]);
    expect((document.getElementById("submitButton") as HTMLButtonElement).disabled).toBe(true);
    // The exact submitted lines are kept for the receipt to take out of the cart.
    expect(sessionStorage.getItem("scalius_submitted_cart")).toContain(CART_LINE_KEY);
  });

  it.each([true, false])("blocks a pending COD submission only for its posted checkout identity (matching: %s)", async (matching) => {
    document.getElementById("checkout-meta")!.setAttribute("data-cod-only", "true");
    await startCartPage();
    const checkoutId = (document.getElementById("checkoutIdInput") as HTMLInputElement).value;
    writeHostedPaymentRecoverySession("/order-success?orderId=order_old&payment=stripe", {
      checkoutId: matching ? checkoutId : "another_tabs_checkout", cartItems: {},
    });
    const submitEvents: boolean[] = [];
    document.getElementById("checkoutForm")!.addEventListener("submit", (event) => submitEvents.push(event.defaultPrevented));

    submitCheckout();
    await settleCheckout();

    expect(submitEvents.includes(false)).toBe(!matching);
    expect(document.getElementById("checkoutFormMessage")?.textContent).toBe(
      matching ? ENGLISH_CHECKOUT_LANGUAGE_DATA.reviewExistingCheckoutText : "",
    );
    expect(sessionStorage.getItem("checkoutId")).toBe(checkoutId);
    expect(localStorage.getItem("scalius_hosted_payment_recovery")).toContain("order_old");
  });
});
