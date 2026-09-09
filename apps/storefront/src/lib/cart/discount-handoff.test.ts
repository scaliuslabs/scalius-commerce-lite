// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ENGLISH_CHECKOUT_LANGUAGE_DATA, formatCheckoutLanguageText } from "@scalius/shared/checkout-language";
import {
  cartStore,
  createCartItemKey,
  getEffectiveCartShippingFee,
  type CartStore,
} from "../../store/cart";
import { validateStorefrontPhone } from "../phone-country-policy";
import { getShippingAddressError, MIN_SHIPPING_ADDRESS_LENGTH } from "../checkout/shipping-address";
import {
  readCheckoutFormDraft,
  readHostedPaymentRecoverySession,
  syncCheckoutTransferSession,
  writeCheckoutFormDraft,
  writeCheckoutTransferSession,
} from "../checkout/session-state";
import { findNamedCheckoutControl } from "../checkout/form-controls";
import { storefrontSourcePath } from "../test-source-paths";
import { initCartFunctionality, isDiscountValidationPending } from "./client";
import type { CheckoutTaxQuote } from "../checkout/tax-quote-contract";

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

vi.mock("../checkout/tax-quote-client", () => ({
  fetchAuthoritativeTaxQuote: taxQuoteMocks.fetchAuthoritativeTaxQuote,
}));

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
  discount: null,
};

const cartPageSource = readFileSync(
  storefrontSourcePath("pages", "cart.astro"),
  "utf8",
);
const cartPageAst = ts.createSourceFile(
  "cart.ts",
  cartPageSource.split("<script>")[1]!.split("</script>")[0]!,
  ts.ScriptTarget.ES2022,
  true,
);
const cartPageStatements = cartPageAst.statements
  .filter((statement) => !ts.isImportDeclaration(statement))
  .map((statement) => statement.getFullText(cartPageAst))
  .join("\n");
const cartPageScript = ts.transpileModule(cartPageStatements, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

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
      data-guest-checkout-enabled="true" data-default-shipping-id="standard" data-default-shipping-fee="60"></div>
    <div id="cartPageRoot" data-cart-ready="false" data-cart-has-items="false">
      <div id="checkoutPanel"><form id="checkoutForm">
        <input name="formIntent" value="checkout" />
        <input name="customerName" value="Synthetic buyer" />
        <input name="customerPhone" value="+8801712345678" />
        <textarea id="shippingAddress" name="shippingAddress">Synthetic checkout address</textarea>
        <input name="city" value="city_dhaka" />
        <input name="zone" value="zone_banani" />
        <input name="shippingLocation" value="standard" />
        <input id="checkoutIdInput" name="checkoutId" type="hidden" />
        <input id="expectedQuoteFingerprint" name="expectedQuoteFingerprint" value="taxq_1234567890123456789012" />
        <input id="cartItemsInput" name="cartItems" type="hidden" />
        <input id="discountCodeHidden" name="discountCodeHidden" type="hidden" />
        <div id="checkoutFormMessage" class="hidden"></div>
        <button id="submitButton" type="submit"><span id="submitButtonText">Continue to payment</span></button>
      </form></div>
      <div id="cartSummary"><form id="discountForm">
        <input id="discountCodeInput" />
        <button id="applyDiscountBtn" type="submit">Apply</button>
      </form><button id="removeDiscountBtn" type="button"></button>
      <div id="discountMessage"></div><div id="discountRow"></div><div id="discountAmount"></div>
      <span><span id="appliedDiscountCode"></span></span><span id="subtotal"></span>
      <span id="shippingCost"></span><span id="taxLabel"></span><span id="taxAmount"></span>
      <p id="taxStatus"></p><span id="totalLabel" data-final-label="Total"></span><span id="total"></span></div>
      <div id="cartValidationMessage" class="hidden"></div><div id="cartItems"></div>
    </div>`;
  window.__CHECKOUT_CONFIG__ = { allowedCountries: [], allowedCountriesMode: "include" } as never;
}

function taxQuote(): CheckoutTaxQuote {
  const discounted = cartStore.get().discount !== null;
  const totalAmount = discounted ? 150 : 160;
  return {
    valid: true,
    quoteFingerprint: "taxq_1234567890123456789012",
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
    shippingMethod: { id: "standard", name: "Standard", description: null, baseAmountMinor: 6_000, feeWaived: false },
    items: [],
  };
}

async function startCartPage(): Promise<void> {
  let initialization!: Promise<void>;
  const dependencies = {
    initCartFunctionality: () => initialization = initCartFunctionality(),
    isDiscountValidationPending,
    resumeCartPageFromHistory: () => Promise.resolve(),
    getCustomerSession: vi.fn().mockResolvedValue({ authenticated: false }),
    readHostedPaymentRecoverySession,
    writeCheckoutTransferSession,
    readCheckoutFormDraft,
    writeCheckoutFormDraft,
    syncCheckoutTransferSession,
    getEffectiveCartShippingFee,
    validateStorefrontPhone,
    findNamedCheckoutControl,
    getShippingAddressError,
    MIN_SHIPPING_ADDRESS_LENGTH,
    formatCheckoutLanguageText,
    ENGLISH_CHECKOUT_LANGUAGE_DATA,
    hideCheckoutLoadingOverlay: vi.fn(),
    showCheckoutLoadingOverlay: vi.fn(),
  };
  new Function(
    ...Object.keys(dependencies),
    cartPageScript,
  )(...Object.values(dependencies));
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
    localStorage.setItem("cart", JSON.stringify(CART_STATE));
    cartStore.set(CART_STATE);
    renderCartDom();
    apiMocks.getActiveCheckoutLanguage.mockResolvedValue(null);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Response(JSON.stringify({
      success: true,
      data: { valid: true, issues: [], items: [{ index: 0, cartKey: CART_LINE_KEY, productId: "prod_1", variantId: "var_1", quantity: 1, unitPrice: 100, productName: "Rice", variantLabel: null, freeDelivery: false, inventoryTracked: false, availableQuantity: null }], subtotal: 100, hasFreeDeliveryProduct: false },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    taxQuoteMocks.fetchAuthoritativeTaxQuote.mockImplementation(async () => taxQuote());
  });

  afterEach(() => {
    pageController?.abort();
    pageController = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("holds native submit until a deferred Apply settles, then transfers the applied code", async () => {
    let resolveValidation!: (value: unknown) => void;
    apiMocks.validateDiscount.mockImplementation(
      () => new Promise((resolve) => { resolveValidation = resolve; }),
    );
    await startCartPage();

    (document.getElementById("discountCodeInput") as HTMLInputElement).value = "SAVE10";
    document.getElementById("applyDiscountBtn")?.click();
    await Promise.resolve();
    expect((document.getElementById("submitButton") as HTMLButtonElement).disabled).toBe(true);

    const blockedSubmit = submitCheckout();
    await vi.advanceTimersByTimeAsync(0);
    expect(blockedSubmit.defaultPrevented).toBe(true);
    expect(document.getElementById("checkoutFormMessage")?.textContent).toBe("");
    expect(sessionStorage.getItem("scalius_checkout_data")).toBeNull();

    resolveValidation({
      valid: true,
      discountAmount: 10,
      discount: { id: "disc_1", code: "SAVE10", type: "amount_off_order", valueType: "fixed_amount", discountValue: 10 },
    });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect((document.getElementById("discountCodeHidden") as HTMLInputElement).value).toContain("SAVE10");
    const transferredSubmit = submitCheckout();
    await settleCheckout();
    expect(transferredSubmit.defaultPrevented).toBe(true);
    const transferred = JSON.parse(sessionStorage.getItem("scalius_checkout_data")!);
    expect(JSON.parse(transferred.discountCodeHidden).code).toBe("SAVE10");
  });

  it("requires a new explicit submit after a failed Apply", async () => {
    let resolveValidation!: (value: unknown) => void;
    apiMocks.validateDiscount.mockImplementation(
      () => new Promise((resolve) => { resolveValidation = resolve; }),
    );
    await startCartPage();
    (document.getElementById("discountCodeInput") as HTMLInputElement).value = "BAD10";
    document.getElementById("applyDiscountBtn")?.click();
    await Promise.resolve();
    const blockedSubmit = submitCheckout();
    await vi.advanceTimersByTimeAsync(0);
    expect(blockedSubmit.defaultPrevented).toBe(true);
    resolveValidation({ valid: false, error: "Invalid code" });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(sessionStorage.getItem("scalius_checkout_data")).toBeNull();

    const transferredSubmit = submitCheckout();
    await settleCheckout();
    expect(transferredSubmit.defaultPrevented).toBe(true);
    expect(JSON.parse(sessionStorage.getItem("scalius_checkout_data")!).discountCodeHidden).toBe("");
  });

  it("rechecks pending Apply after cart validation and does not auto-submit", async () => {
    let resolveCart!: (value: boolean) => void;
    let resolveDiscount!: (value: unknown) => void;
    apiMocks.validateDiscount.mockImplementation(
      () => new Promise((resolve) => { resolveDiscount = resolve; }),
    );
    await startCartPage();
    window.validateCartSnapshot = () => new Promise((resolve) => { resolveCart = resolve; });

    const initialSubmit = submitCheckout();
    await vi.advanceTimersByTimeAsync(0);
    expect(initialSubmit.defaultPrevented).toBe(true);
    expect(document.getElementById("checkoutFormMessage")?.textContent).toBe("");
    expect(resolveCart).toBeTypeOf("function");
    (document.getElementById("discountCodeInput") as HTMLInputElement).value = "SAVE10";
    document.getElementById("applyDiscountBtn")?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("applyDiscountBtn")).toBeTruthy();
    resolveCart(true);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(sessionStorage.getItem("scalius_checkout_data")).toBeNull();

    resolveDiscount({ valid: true, discountAmount: 10, discount: { id: "disc_1", code: "SAVE10", type: "amount_off_order", valueType: "fixed_amount", discountValue: 10 } });
  });

  it("holds COD submit while Apply is pending, then permits the normal submit", async () => {
    let resolveValidation!: (value: unknown) => void;
    apiMocks.validateDiscount.mockImplementation(
      () => new Promise((resolve) => { resolveValidation = resolve; }),
    );
    document.getElementById("checkout-meta")!.setAttribute("data-cod-only", "true");
    await startCartPage();

    const form = document.getElementById("checkoutForm") as HTMLFormElement;
    const submitEvents: boolean[] = [];
    form.addEventListener("submit", (event) => submitEvents.push(event.defaultPrevented));
    (document.getElementById("discountCodeInput") as HTMLInputElement).value = "SAVE10";
    document.getElementById("applyDiscountBtn")?.click();
    await vi.advanceTimersByTimeAsync(0);

    const blockedSubmit = submitCheckout();
    await vi.advanceTimersByTimeAsync(0);
    expect(blockedSubmit.defaultPrevented).toBe(true);
    expect(submitEvents).toEqual([true]);
    expect(sessionStorage.getItem("scalius_checkout_data")).toBeNull();

    resolveValidation({
      valid: true,
      discountAmount: 10,
      discount: { id: "disc_1", code: "SAVE10", type: "amount_off_order", valueType: "fixed_amount", discountValue: 10 },
    });
    await settleCheckout();

    const normalSubmit = submitCheckout();
    await settleCheckout();
    expect(normalSubmit.defaultPrevented).toBe(true);
    expect(submitEvents).toEqual([true, true, false]);
    expect((document.getElementById("submitButton") as HTMLButtonElement).disabled).toBe(true);
  });
});
