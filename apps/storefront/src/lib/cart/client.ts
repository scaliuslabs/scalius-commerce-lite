// src/lib/cart/client.ts
import {
  cartStore,
  hydrateCartFromStorage,
  syncCartFromStorage,
  addToCart,
  removeCartItemByKey,
  updateCartItemByKey,
  applyDiscount,
  getEffectiveCartShippingFee,
  removeDiscount,
  type CartItem,
  type VariantCartItem,
} from "@/store/cart";
import type {
  CartValidationIssue,
  CartValidationResult,
} from "@/lib/api/orders";
import {
  validateDiscount,
  getActiveCheckoutLanguage,
  type CheckoutLanguageData,
  saveAbandonedCheckout,
} from "@/lib/api";
import { formatPriceShort } from "@scalius/shared/currency";
import {
  ENGLISH_CHECKOUT_LANGUAGE_DATA,
  formatCheckoutLanguageText,
} from "@scalius/shared/checkout-language";
import { trackFbAddToCart, trackFbInitiateCheckout } from "@/lib/analytics";
import { nanoid } from "nanoid";
import { getProductImageUrl } from "@/lib/product-media";
import { applyCheckoutButtonState } from "./checkout-button-state";
import { renderEmptyCartState } from "./empty-state";
import { renderCartIssueAction } from "./issue-action";
import {
  readAndClearCartRepairState,
  readAndClearInlineCartRepairState,
} from "./repair-state";
import { reconcileValidatedCartSnapshot } from "./validation-reconciliation";
import {
  renderBulkCartRepairActions,
  selectCartKeysForBulkRepair,
  type BulkCartRepairAction,
} from "./bulk-repair-actions";
import { resolveCartKeyForValidatedLine } from "./cart-key-resolution";
import {
  clearHostedPaymentRecoverySession,
  matchesCheckoutRecoveryCart,
  readHostedPaymentRecoverySession,
  type HostedPaymentRecoverySession,
} from "../checkout/session-state";
import { fetchAuthoritativeTaxQuote } from "../checkout/tax-quote-client";
import type { CheckoutTaxQuote } from "../checkout/tax-quote-contract";
import {
  cartItemVariantLabel as optionVariantLabel,
  normalizeCartItemOptions,
} from "./item-options";

/**
 * Escape HTML entities in user-supplied strings to prevent XSS when
 * interpolating into innerHTML templates.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function inlineJsString(value: string): string {
  return escapeHtml(JSON.stringify(value));
}

let globalLangData: CheckoutLanguageData | null = null;
const activeCheckoutCopy = () =>
  globalLangData?.languageData ?? ENGLISH_CHECKOUT_LANGUAGE_DATA;
let hasTrackedInitiateCheckout = false;
let cartValidationIssues: Record<string, CartValidationIssue[]> = {};
let cartValidationGlobalError = "";
let cartValidationSummaryMessage = "";
let cartQuantityLimits: Record<string, number | null> = {};
let preserveCartValidationSummaryOnce = false;
let cartValidationTimer: ReturnType<typeof setTimeout> | null = null;
let cartValidationSequence = 0;
let isApplyingCartSnapshot = false;
let cartTaxQuoteSequence = 0;
let latestCheckoutLocation: {
  cityId: string;
  cityName: string;
  zoneId: string;
  zoneName: string;
  areaId: string;
  areaName: string;
} | null = null;
let hostedPaymentRecoverySession: HostedPaymentRecoverySession | null = null;

function reconcileHostedPaymentRecoveryWithCart(): void {
  if (
    hostedPaymentRecoverySession?.cartFingerprint &&
    !matchesCheckoutRecoveryCart(
      hostedPaymentRecoverySession,
      cartStore.get().items,
    )
  ) {
    clearHostedPaymentRecoverySession();
    hostedPaymentRecoverySession = null;
    renderCheckoutRecoveryNotice();
  }
}

function renderCheckoutRecoveryNotice(): void {
  const notice = document.getElementById("checkoutRecoveryNotice");
  const link = document.getElementById(
    "checkoutRecoveryLink",
  ) as HTMLAnchorElement | null;
  const reference = document.getElementById("checkoutRecoveryReference");
  if (!notice || !link || !reference) return;

  if (!hostedPaymentRecoverySession) {
    notice.classList.add("hidden");
    notice.setAttribute("aria-hidden", "true");
    link.removeAttribute("href");
    reference.textContent = "";
    return;
  }

  reference.textContent = hostedPaymentRecoverySession.orderId;
  link.href = hostedPaymentRecoverySession.href;
  notice.classList.remove("hidden");
  notice.setAttribute("aria-hidden", "false");
}

// --- Abandoned Checkout ---
let abandonedCheckoutTimer: ReturnType<typeof setTimeout> | null = null;
let cartRuntimeAbortController: AbortController | null = null;
let cartStoreUnsubscribe: (() => void) | null = null;

function resetCartRuntimeListeners(): AbortSignal {
  cartTaxQuoteSequence += 1;
  latestCheckoutLocation = null;
  cartQuantityLimits = {};
  cartStoreUnsubscribe?.();
  cartStoreUnsubscribe = null;
  cartRuntimeAbortController?.abort();
  cartRuntimeAbortController = new AbortController();

  if (abandonedCheckoutTimer !== null) {
    clearTimeout(abandonedCheckoutTimer);
    abandonedCheckoutTimer = null;
  }
  if (cartValidationTimer !== null) {
    clearTimeout(cartValidationTimer);
    cartValidationTimer = null;
  }

  return cartRuntimeAbortController.signal;
}

function getCheckoutId(): string {
  let checkoutId = sessionStorage.getItem("checkoutId");
  if (!checkoutId) {
    checkoutId = `chk_session_${nanoid()}`;
    sessionStorage.setItem("checkoutId", checkoutId);
  }
  return checkoutId;
}

function setCheckoutIdInputValue(checkoutId: string): void {
  const checkoutIdInput = document.getElementById(
    "checkoutIdInput",
  ) as HTMLInputElement | null;
  if (checkoutIdInput) {
    checkoutIdInput.value = checkoutId;
  }
}

function syncCheckoutIdInput(): void {
  setCheckoutIdInputValue(getCheckoutId());
}

function rotateCheckoutId(): string {
  const checkoutId = `chk_session_${nanoid()}`;
  sessionStorage.setItem("checkoutId", checkoutId);
  setCheckoutIdInputValue(checkoutId);
  return checkoutId;
}

function rotateCheckoutIdIfCartBlocked(): void {
  if (hasBlockingCartIssues()) {
    rotateCheckoutId();
  }
}

interface CheckoutFormData {
  [key: string]:
    | FormDataEntryValue
    | { items: unknown[]; totalAmount: number; discount: unknown }
    | { id: string; fee: number }
    | undefined;
  cart?: { items: unknown[]; totalAmount: number; discount: unknown };
  shipping?: { id: string; fee: number };
  customerPhone?: FormDataEntryValue;
}

function getCheckoutFormData(): CheckoutFormData {
  const form = document.getElementById("checkoutForm") as HTMLFormElement;
  if (!form) return {};

  const formData = new FormData(form);
  const data: CheckoutFormData = {};
  formData.forEach((value, key) => {
    data[key] = value;
  });

  const { items, totalAmount, discount } = cartStore.get();
  data.cart = {
    items: Object.values(items),
    totalAmount,
    discount,
  };

  const selectedShipping = window.lastShippingEventDetail;
  data.shipping = selectedShipping
    ? {
        ...selectedShipping,
        fee: getEffectiveCartShippingFee(items, selectedShipping.fee),
      }
    : undefined;

  if (latestCheckoutLocation) {
    data.cityName = latestCheckoutLocation.cityName;
    data.zoneName = latestCheckoutLocation.zoneName;
    data.areaName = latestCheckoutLocation.areaName;
  }

  return data;
}

function handleAbandonedCheckout() {
  if (abandonedCheckoutTimer !== null) clearTimeout(abandonedCheckoutTimer);
  abandonedCheckoutTimer = setTimeout(() => {
    const checkoutData = getCheckoutFormData();
    if (!checkoutData.cart || checkoutData.cart.items.length === 0) {
      return;
    }

    const phone = checkoutData.customerPhone;
    const payload = {
      checkoutId: getCheckoutId(),
      customerPhone: typeof phone === "string" ? phone : undefined,
      checkoutData: checkoutData,
    };
    saveAbandonedCheckout(payload);
  }, 1500); // Debounce for 1.5 seconds
}

// --- Language Data Management ---
async function getLanguageData(): Promise<CheckoutLanguageData> {
  if (globalLangData) return globalLangData;
  const serverLanguage = window.__CHECKOUT_LANGUAGE__;
  if (
    serverLanguage &&
    typeof serverLanguage === "object" &&
    "languageData" in serverLanguage &&
    typeof serverLanguage.languageData === "object" &&
    serverLanguage.languageData !== null
  ) {
    globalLangData = serverLanguage as CheckoutLanguageData;
    return globalLangData;
  }
  try {
    const language = await getActiveCheckoutLanguage();
    if (language) {
      globalLangData = language;
      return globalLangData;
    }
  } catch (error: unknown) {
    console.error("Error fetching checkout language:", error);
  }
  // Fallback language object in case API fails
  const fallbackLang: CheckoutLanguageData = {
    id: "fallback",
    name: "English (Fallback)",
    code: "en",
    languageData: { ...ENGLISH_CHECKOUT_LANGUAGE_DATA },
    fieldVisibility: {
      showEmailField: true,
      showOrderNotesField: true,
      showAreaField: true,
    },
    isActive: true,
    isDefault: true,
  };
  globalLangData = fallbackLang;
  return fallbackLang;
}

function syncCartPagePresentation(ready: boolean): void {
  const root = document.getElementById("cartPageRoot");
  const cartItems = document.getElementById("cartItems");
  const cartSummary = document.getElementById("cartSummary");
  const checkoutPanel = document.getElementById("checkoutPanel");
  const hasItems = Object.keys(cartStore.get().items).length > 0;

  if (root) {
    root.dataset.cartReady = ready ? "true" : "false";
    root.dataset.cartHasItems = hasItems ? "true" : "false";
  }
  cartItems?.setAttribute("aria-busy", ready ? "false" : "true");

  const hideOperationalPanels = !ready || !hasItems;
  cartSummary?.classList.toggle("hidden", hideOperationalPanels);
  checkoutPanel?.classList.toggle("hidden", hideOperationalPanels);
}

// --- NEW FUNCTION: To handle the quick buy action ---
function processQuickBuy() {
  try {
    const quickBuyJSON = sessionStorage.getItem("quickBuyData");
    if (quickBuyJSON) {
      // IMPORTANT: Remove the item immediately to prevent re-adding on refresh
      sessionStorage.removeItem("quickBuyData");

      const data = JSON.parse(quickBuyJSON);

      if (data.cartItem) {
        // 1. Add item to cart store
        if (!addToCart(data.cartItem)) return;

        // 2. Fire analytics events (override currency with dynamic value)
        const dynamicCurrency = window.__CURRENCY_CODE__ || "BDT";
        if (data.addToCartEvent) {
          data.addToCartEvent.currency = dynamicCurrency;
          trackFbAddToCart(data.addToCartEvent);
        }
        if (data.initiateCheckoutEvent) {
          data.initiateCheckoutEvent.currency = dynamicCurrency;
          trackFbInitiateCheckout(data.initiateCheckoutEvent);
        }
      }
    }
  } catch (e: unknown) {
    console.error("Error processing quick buy data:", e);
  }
}

function showDiscountMessage(
  message: string,
  type: "success" | "error" | "info",
) {
  const messageElement = document.getElementById("discountMessage");
  if (!messageElement) return;

  messageElement.textContent = message;
  messageElement.setAttribute("role", type === "error" ? "alert" : "status");
  messageElement.setAttribute(
    "aria-live",
    type === "error" ? "assertive" : "polite",
  );
  const colors = {
    success: "text-primary",
    error: "text-destructive",
    info: "text-primary",
  };
  messageElement.className = `text-xs mt-1 ${colors[type]}`;
  messageElement.style.display = "block";

  setTimeout(() => {
    if (messageElement) messageElement.style.display = "none";
  }, 4000);
}

function updateDiscountUI() {
  const { discount } = cartStore.get();
  const discountCodeInput = document.getElementById(
    "discountCodeInput",
  ) as HTMLInputElement;
  const applyButton = document.getElementById(
    "applyDiscountBtn",
  ) as HTMLButtonElement;
  const removeButton = document.getElementById(
    "removeDiscountBtn",
  ) as HTMLButtonElement;
  const discountRowEl = document.getElementById("discountRow");
  const discountAmountEl = document.getElementById("discountAmount");
  const appliedDiscountCodeEl = document.getElementById("appliedDiscountCode");

  if (
    !discountCodeInput ||
    !applyButton ||
    !removeButton ||
    !discountRowEl ||
    !discountAmountEl ||
    !appliedDiscountCodeEl
  )
    return;

  if (discount) {
    discountCodeInput.value = discount.code;
    discountCodeInput.disabled = true;
    applyButton.style.display = "none";
    removeButton.style.display = "block";

    discountRowEl.style.display = "flex";
    discountAmountEl.textContent = `-${formatPriceShort(discount.discountAmount || 0)}`;
    appliedDiscountCodeEl.textContent = discount.code;
    appliedDiscountCodeEl.parentElement!.classList.remove("hidden");
  } else {
    discountCodeInput.value = "";
    discountCodeInput.disabled = false;
    applyButton.style.display = "block";
    removeButton.style.display = "none";
    discountRowEl.style.display = "none";
  }
}

function cartItemVariantLabel(item: CartItem): string | null {
  return optionVariantLabel(item.options);
}

function cartValidationPayload(items: Record<string, VariantCartItem>) {
  return Object.entries(items).map(([cartKey, item]) => ({
    cartKey,
    productId: item.id,
    variantId: item.variantId,
    quantity: item.quantity,
    price: item.price,
    productName: item.name,
    variantLabel: cartItemVariantLabel(item),
  }));
}

function formStringValue(name: string): string | null {
  if (typeof document === "undefined") return null;
  const input = document.querySelector(
    `[name="${name}"]`,
  ) as HTMLInputElement | null;
  const value = input?.value?.trim();
  return value ? value : null;
}

function formCanonicalPhoneValue(): string | null {
  if (typeof document === "undefined") return null;
  const input = document.querySelector<HTMLInputElement>(
    '[name="customerPhone"]',
  );
  if (!input) return null;

  // PhoneField exposes only its validated E.164 value through this dataset.
  // An empty Bangladesh control visibly contains the "+880" calling code, so
  // falling back to that display value makes tax-quote construction fail
  // synchronously before a request can be sent.
  if (input.dataset.e164Value !== undefined) {
    const canonical = input.dataset.e164Value.trim();
    return /^\+[1-9]\d{6,14}$/.test(canonical) ? canonical : null;
  }

  const legacyValue = input.value.trim();
  return legacyValue.length >= 7 ? legacyValue : null;
}

function cartTaxQuoteInput(): Record<string, unknown> | null {
  const city = latestCheckoutLocation?.cityId || formStringValue("city");
  const zone = latestCheckoutLocation?.zoneId || formStringValue("zone");
  const shippingMethodId =
    window.lastShippingEventDetail?.id ||
    document.getElementById("checkout-meta")?.dataset.defaultShippingId;
  const cartItems = (
    document.getElementById("cartItemsInput") as HTMLInputElement | null
  )?.value;

  if (!city || !zone || !shippingMethodId || !cartItems || cartItems === "{}") {
    return null;
  }

  return {
    cartItems,
    city,
    zone,
    area:
      latestCheckoutLocation?.areaId || formStringValue("area") || undefined,
    shippingMethodId,
    discountCodeHidden: (
      document.getElementById("discountCodeHidden") as HTMLInputElement | null
    )?.value,
    customerPhone: formCanonicalPhoneValue() || undefined,
  };
}

function renderAuthoritativeCartQuote(
  quote: CheckoutTaxQuote,
  elements: {
    subtotal: HTMLElement;
    shipping: HTMLElement;
    total: HTMLElement;
    totalLabel: HTMLElement | null;
    taxLabel: HTMLElement | null;
    taxAmount: HTMLElement | null;
    taxStatus: HTMLElement | null;
  },
): void {
  document
    .getElementById("taxRow")
    ?.classList.toggle("hidden", quote.taxMinor === 0);
  elements.subtotal.textContent = formatPriceShort(quote.subtotalAmount);
  elements.shipping.textContent =
    quote.shippingAmount === 0
      ? activeCheckoutCopy().freeText
      : formatPriceShort(quote.shippingAmount);
  elements.total.textContent = formatPriceShort(quote.totalAmount);
  if (elements.totalLabel) {
    elements.totalLabel.textContent =
      elements.totalLabel.dataset.finalLabel || activeCheckoutCopy().totalText;
  }

  if (elements.taxLabel) {
    elements.taxLabel.textContent = `${quote.displayLabel}${
      quote.pricesIncludeTax ? " (included)" : ""
    }`;
  }
  if (elements.taxAmount) {
    elements.taxAmount.textContent = formatPriceShort(quote.taxAmount);
  }
  if (elements.taxStatus) {
    elements.taxStatus.textContent = "";
    elements.taxStatus.classList.add("hidden");
  }

  const discountRow = document.getElementById("discountRow");
  const discountAmount = document.getElementById("discountAmount");
  if (discountRow && discountAmount) {
    if (quote.discountAmount > 0) {
      discountRow.style.display = "flex";
      discountAmount.textContent = `-${formatPriceShort(quote.discountAmount)}`;
    } else {
      discountRow.style.display = "none";
    }
  }
}

function cartValidationDeliveryPayload() {
  const city = formStringValue("city");
  const zone = formStringValue("zone");
  if (!city || !zone) return {};

  const meta = document.getElementById("checkout-meta");
  const shippingMethodId =
    window.lastShippingEventDetail?.id ??
    meta?.dataset.defaultShippingId ??
    null;

  return {
    city,
    zone,
    area: formStringValue("area"),
    shippingMethodId,
  };
}

function issueKeyForCart(
  issue: CartValidationIssue,
  items: Record<string, CartItem>,
): string | null {
  return resolveCartKeyForValidatedLine(issue, items);
}

function setCartValidationIssues(
  issues: CartValidationIssue[],
  items: Record<string, CartItem>,
  summaryMessage = "",
) {
  cartValidationGlobalError = "";
  cartValidationSummaryMessage = summaryMessage;
  const grouped: Record<string, CartValidationIssue[]> = {};
  for (const issue of issues) {
    const key = issueKeyForCart(issue, items);
    if (!key) continue;
    grouped[key] = [...(grouped[key] ?? []), issue];
  }
  cartValidationIssues = grouped;
  updateCartValidationMessage();
}

function updateCartQuantityLimits(
  result: CartValidationResult,
  issues: CartValidationIssue[],
  items: Record<string, CartItem>,
): void {
  const next: Record<string, number | null> = {};
  for (const cartKey of Object.keys(items)) {
    if (Object.prototype.hasOwnProperty.call(cartQuantityLimits, cartKey)) {
      next[cartKey] = cartQuantityLimits[cartKey] ?? null;
    }
  }
  for (const item of result.items) {
    const cartKey = resolveCartKeyForValidatedLine(item, items);
    if (cartKey) next[cartKey] = item.availableQuantity;
  }
  for (const issue of issues) {
    const cartKey = issueKeyForCart(issue, items);
    if (cartKey && typeof issue.availableQuantity === "number") {
      next[cartKey] = Math.max(0, Math.floor(issue.availableQuantity));
    }
  }
  cartQuantityLimits = next;
}

function clearCartValidationSummary() {
  cartValidationSummaryMessage = "";
  preserveCartValidationSummaryOnce = false;
}

function cartIssueCount(): number {
  return Object.values(cartValidationIssues).reduce(
    (count, issues) => count + issues.length,
    0,
  );
}

function hasBlockingCartIssues(): boolean {
  return Boolean(cartValidationGlobalError) || cartIssueCount() > 0;
}

function cartBlockedMessage(): string {
  if (cartValidationGlobalError) return cartValidationGlobalError;
  const count = Object.keys(cartValidationIssues).length;
  if (count <= 0) return "";
  if (cartValidationSummaryMessage) return cartValidationSummaryMessage;
  return count === 1
    ? activeCheckoutCopy().cartItemChangedText
    : `${count} cart items need attention before checkout.`;
}

function updateCartValidationMessage() {
  const message = document.getElementById("cartValidationMessage");
  if (!message) return;

  if (hasBlockingCartIssues()) {
    message.textContent = cartBlockedMessage();
    if (!cartValidationGlobalError) {
      message.insertAdjacentHTML(
        "beforeend",
        renderBulkCartRepairActions(cartValidationIssues),
      );
    }
    message.classList.remove("hidden");
  } else {
    message.textContent = "";
    message.classList.add("hidden");
  }
}

function applyPendingCartRepairState(): boolean {
  const state =
    readAndClearCartRepairState() ?? readAndClearInlineCartRepairState();
  if (!state) return false;

  rotateCheckoutId();

  if (state.issues.length > 0) {
    setCartValidationIssues(state.issues, cartStore.get().items, state.message);
    preserveCartValidationSummaryOnce = true;
  } else {
    cartValidationIssues = {};
    clearCartValidationSummary();
    cartValidationGlobalError = state.message;
    updateCartValidationMessage();
  }
  updateCheckoutButtonState();
  return true;
}

export async function validateCartSnapshot(): Promise<boolean> {
  const { items } = cartStore.get();
  const payloadItems = cartValidationPayload(items);
  const sequence = ++cartValidationSequence;

  if (payloadItems.length === 0) {
    cartValidationIssues = {};
    cartValidationGlobalError = "";
    clearCartValidationSummary();
    updateCartValidationMessage();
    updateCheckoutButtonState();
    return true;
  }

  try {
    const response = await fetch("/api/checkout/validate-cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: payloadItems,
        ...cartValidationDeliveryPayload(),
      }),
    });
    const json = (await response.json().catch(() => null)) as {
      success?: boolean;
      error?: string;
      data?: CartValidationResult;
      details?: { itemIssues?: CartValidationIssue[]; message?: string };
    } | null;

    if (sequence !== cartValidationSequence) {
      return !hasBlockingCartIssues();
    }

    const rawIssues = json?.data?.issues ?? json?.details?.itemIssues ?? [];
    const issues = Array.isArray(rawIssues) ? rawIssues : [];
    const summaryMessage =
      issues.length > 0 && preserveCartValidationSummaryOnce
        ? cartValidationSummaryMessage
        : "";
    preserveCartValidationSummaryOnce = false;
    if (response.ok && json?.success && json.data) {
      isApplyingCartSnapshot = true;
      try {
        reconcileValidatedCartSnapshot(json.data, (message) => {
          showDiscountMessage(message, "info");
        });
      } finally {
        isApplyingCartSnapshot = false;
      }
      updateCartQuantityLimits(json.data, issues, cartStore.get().items);
    }
    setCartValidationIssues(issues, cartStore.get().items, summaryMessage);
    if (!response.ok || !json?.success) {
      cartValidationGlobalError =
        issues.length > 0
          ? ""
          : json?.error ||
            json?.details?.message ||
            activeCheckoutCopy().cartAvailabilityFailedText;
      if (issues.length === 0) clearCartValidationSummary();
      updateCartValidationMessage();
    }
    await renderCartItems();
    updateCheckoutButtonState();

    if (!response.ok || !json?.success) {
      return false;
    }

    return json.data?.valid !== false && !hasBlockingCartIssues();
  } catch (error) {
    console.warn("Could not refresh cart availability before checkout.", error);
    cartValidationIssues = {};
    clearCartValidationSummary();
    cartValidationGlobalError =
      activeCheckoutCopy().cartAvailabilityFailedText;
    updateCartValidationMessage();
    updateCheckoutButtonState();
    return false;
  }
}

function scheduleCartValidation() {
  cartValidationSequence += 1;
  if (cartValidationTimer) clearTimeout(cartValidationTimer);
  cartValidationTimer = setTimeout(() => {
    void validateCartSnapshot();
  }, 350);
}

export function renderIssueAction(
  cartKey: string,
  issue: CartValidationIssue,
): string {
  return renderCartIssueAction(
    cartKey,
    issue,
    cartStore.get().items[cartKey]?.slug,
  );
}

function renderCartItemIssues(cartKey: string): string {
  const issues = cartValidationIssues[cartKey] ?? [];
  if (issues.length === 0) return "";

  return `<div class="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive space-y-1">${issues
    .map(
      (issue) =>
        `<div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <span>${escapeHtml(issue.message)}</span>
        ${renderIssueAction(cartKey, issue)}
      </div>`,
    )
    .join("")}</div>`;
}

export async function updateTotals() {
  const quoteSequence = ++cartTaxQuoteSequence;
  const { items, totalAmount, discount } = cartStore.get();
  const selectedMethodFee = window.lastShippingEventDetail?.fee ?? 0;
  const shippingFee = getEffectiveCartShippingFee(items, selectedMethodFee);
  const shippingFeeIsWaived = selectedMethodFee > 0 && shippingFee === 0;

  const subtotalEl = document.getElementById("subtotal");
  const shippingEl = document.getElementById("shippingCost");
  const totalEl = document.getElementById("total");
  const totalLabelEl = document.getElementById("totalLabel");
  const taxLabelEl = document.getElementById("taxLabel");
  const taxAmountEl = document.getElementById("taxAmount");
  const taxStatusEl = document.getElementById("taxStatus");
  const taxRowEl = document.getElementById("taxRow");
  const discountHiddenInput = document.getElementById(
    "discountCodeHidden",
  ) as HTMLInputElement;
  const expectedQuoteFingerprintInput = document.getElementById(
    "expectedQuoteFingerprint",
  ) as HTMLInputElement | null;

  if (expectedQuoteFingerprintInput) expectedQuoteFingerprintInput.value = "";
  updateCheckoutButtonState();

  if (!subtotalEl || !shippingEl || !totalEl || !discountHiddenInput) return;

  subtotalEl.textContent = formatPriceShort(totalAmount);
  shippingEl.textContent =
    shippingFeeIsWaived || shippingFee === 0
      ? activeCheckoutCopy().freeText
      : formatPriceShort(shippingFee);

  let finalTotal = totalAmount + shippingFee;

  if (discount && discount.discountAmount) {
    finalTotal -= discount.discountAmount;
    discountHiddenInput.value = JSON.stringify({
      id: discount.id,
      code: discount.code,
      type: discount.type,
      amount: discount.discountAmount,
    });
  } else {
    discountHiddenInput.value = "";
  }

  totalEl.textContent = formatPriceShort(Math.max(0, finalTotal));
  if (totalLabelEl) totalLabelEl.textContent = activeCheckoutCopy().estimatedTotalText;
  updateDiscountUI();

  const quoteInput = cartTaxQuoteInput();
  if (!quoteInput) {
    if (taxLabelEl) taxLabelEl.textContent = activeCheckoutCopy().taxText;
    if (taxAmountEl) taxAmountEl.textContent = "—";
    taxRowEl?.classList.add("hidden");
    if (taxStatusEl) {
      taxStatusEl.textContent = "";
      taxStatusEl.classList.add("hidden");
    }
    return;
  }

  if (taxLabelEl) taxLabelEl.textContent = activeCheckoutCopy().taxText;
  if (taxAmountEl) taxAmountEl.textContent = "—";
  taxRowEl?.classList.add("hidden");
  if (taxStatusEl) {
    taxStatusEl.textContent = "";
    taxStatusEl.classList.add("hidden");
  }
  totalEl.textContent = activeCheckoutCopy().calculatingText;
  if (totalLabelEl) {
    totalLabelEl.textContent =
      totalLabelEl.dataset.finalLabel || activeCheckoutCopy().totalText;
  }

  try {
    const quote = await fetchAuthoritativeTaxQuote(quoteInput);
    if (quoteSequence !== cartTaxQuoteSequence) return;
    if (expectedQuoteFingerprintInput) {
      expectedQuoteFingerprintInput.value = quote.quoteFingerprint;
    }
    updateCheckoutButtonState();
    renderAuthoritativeCartQuote(quote, {
      subtotal: subtotalEl,
      shipping: shippingEl,
      total: totalEl,
      totalLabel: totalLabelEl,
      taxLabel: taxLabelEl,
      taxAmount: taxAmountEl,
      taxStatus: taxStatusEl,
    });
  } catch {
    if (quoteSequence !== cartTaxQuoteSequence) return;
    if (taxAmountEl) taxAmountEl.textContent = activeCheckoutCopy().unavailableText;
    taxRowEl?.classList.add("hidden");
    totalEl.textContent = "—";
    if (taxStatusEl) {
      taxStatusEl.textContent =
        activeCheckoutCopy().taxVerificationFailedText;
      taxStatusEl.classList.remove("hidden");
    }
    updateCheckoutButtonState();
  }
}

export async function renderCartItems() {
  const lang = await getLanguageData();
  const cartItemsContainer = document.getElementById("cartItems");
  const cartItemsInput = document.getElementById(
    "cartItemsInput",
  ) as HTMLInputElement;

  if (!cartItemsContainer || !cartItemsInput) return;

  const { items } = cartStore.get();
  cartItemsInput.value =
    Object.keys(items).length > 0 ? JSON.stringify(items) : "{}";

  if (Object.keys(items).length === 0) {
    renderEmptyCartState(
      cartItemsContainer,
      lang,
      hostedPaymentRecoverySession
        ? {
            href: hostedPaymentRecoverySession.href,
          }
        : null,
    );
    syncCartPagePresentation(true);
    return;
  }
  renderCheckoutRecoveryNotice();

  cartItemsContainer.innerHTML = Object.entries(items)
    .map(([cartKey, item]) => {
      // Escape all user-supplied strings to prevent XSS via innerHTML
      const rawName = item.name || "";
      const safeName = escapeHtml(rawName);
      const safeImage = escapeHtml(
        getProductImageUrl(item.image, {
          width: 96,
          height: 96,
          quality: 75,
          format: "auto",
          fit: "contain",
        }),
      );
      const jsCartKey = inlineJsString(cartKey);
      const safeOptions = normalizeCartItemOptions(item.options)?.map(
        (option) => ({
          name: escapeHtml(option.name),
          label: escapeHtml(option.label),
        }),
      );
      const issueBlock = renderCartItemIssues(cartKey);
      const quantityKnown = Object.prototype.hasOwnProperty.call(
        cartQuantityLimits,
        cartKey,
      );
      const quantityLimit = cartQuantityLimits[cartKey];
      const increaseDisabled =
        !quantityKnown ||
        (typeof quantityLimit === "number" && item.quantity >= quantityLimit);
      const increaseLabel = escapeHtml(!quantityKnown
        ? formatCheckoutLanguageText(activeCheckoutCopy().checkingAvailableQuantityText, { item: rawName })
        : typeof quantityLimit === "number" && item.quantity >= quantityLimit
          ? formatCheckoutLanguageText(activeCheckoutCopy().maximumAvailableQuantityText, { item: rawName })
          : formatCheckoutLanguageText(activeCheckoutCopy().increaseQuantityText, { item: rawName }));

      const variantInfo = safeOptions
        ? `<div class="space-x-1">${safeOptions
            .map((option) => `<span>${option.name}: ${option.label}</span>`)
            .join("<span>•</span>")}</div>`
        : "";

      return `
      <div class="py-2.5 sm:py-3 first:pt-0"><div class="flex gap-2.5 sm:gap-3">
          <div class="w-16 h-16 sm:w-20 sm:h-20 bg-muted rounded-lg overflow-hidden shrink-0"><img src="${safeImage}" alt="${safeName}" class="w-full h-full object-contain object-center" /></div>
          <div class="flex-1 min-w-0">
            <div class="flex justify-between">
              <div class="min-w-0"><h3 class="line-clamp-2 text-sm font-medium text-foreground sm:text-base">${safeName}</h3><div class="mt-0.5 text-xs text-muted-foreground sm:mt-1 sm:text-sm">${variantInfo}</div></div>
              <button aria-label="${escapeHtml(formatCheckoutLanguageText(activeCheckoutCopy().removeFromCartText, { item: rawName }))}" class="ml-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive sm:ml-2 sm:h-9 sm:w-9" onclick="window.removeFromCart(${jsCartKey})"><svg class="w-4 h-4 sm:w-5 sm:h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 18L18 6M6 6l12 12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            </div>
            <div class="flex items-center justify-between mt-1.5 sm:mt-2">
              <div class="flex h-11 items-center overflow-hidden rounded-md ring-1 ring-inset ring-border sm:h-8">
                <button aria-label="${escapeHtml(formatCheckoutLanguageText(activeCheckoutCopy().decreaseQuantityText, { item: rawName }))}" class="flex h-full w-11 items-center justify-center text-sm text-foreground hover:bg-muted sm:w-8" onclick="window.updateCartQuantity(${jsCartKey}, ${Math.max(0, item.quantity - 1)})">-</button>
                <span class="flex h-full w-7 items-center justify-center text-center text-xs text-foreground sm:w-6 sm:text-sm">${item.quantity}</span>
                <button aria-label="${increaseLabel}" ${increaseDisabled ? "disabled" : ""} class="flex h-full w-11 items-center justify-center text-sm text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent sm:w-8" onclick="window.updateCartQuantity(${jsCartKey}, ${item.quantity + 1})">+</button>
              </div>
              <div class="text-right"><div class="font-medium text-sm sm:text-base text-foreground">${formatPriceShort(item.price * item.quantity)}</div><div class="text-xs text-muted-foreground">${formatPriceShort(item.price)} ${escapeHtml(activeCheckoutCopy().eachText)}</div></div>
            </div>
            ${issueBlock}
          </div>
        </div></div>`;
    })
    .join("");

  await updateTotals();
  syncCartPagePresentation(true);
}

export function updateCheckoutButtonState() {
  const submitButton = document.getElementById(
    "submitButton",
  ) as HTMLButtonElement;
  if (!submitButton) return;
  const meta = document.getElementById("checkout-meta") as HTMLElement | null;
  const checkoutUnavailable = meta?.dataset.checkoutUnavailable === "true";
  const unavailableMessage =
    meta?.dataset.checkoutUnavailableMessage ||
    activeCheckoutCopy().checkoutUnavailableMessage;
  const isEmpty = Object.keys(cartStore.get().items).length === 0;
  const expectedQuoteFingerprint = (
    document.getElementById("expectedQuoteFingerprint") as HTMLInputElement | null
  )?.value ?? "";
  const quoteUnverified =
    meta?.dataset.codOnly === "true" &&
    !/^taxq_[A-Za-z0-9_-]{22}$/.test(expectedQuoteFingerprint);
  applyCheckoutButtonState(submitButton, {
    checkoutUnavailable,
    unavailableMessage,
    isEmpty,
    cartBlocked: hasBlockingCartIssues(),
    cartBlockedMessage: cartBlockedMessage(),
    checkoutPending: hostedPaymentRecoverySession !== null,
    quoteUnverified,
    quoteUnverifiedMessage: activeCheckoutCopy().totalVerificationFailedText,
  });
}

// --- Analytics & Event Tracking ---
function attemptToTrackInitiateCheckout() {
  if (hasTrackedInitiateCheckout) return;

  const { items, totalAmount } = cartStore.get();
  const customerPhoneInput = document.querySelector<HTMLInputElement>(
    '[name="customerPhone"]',
  );
  const phone =
    customerPhoneInput?.dataset.e164Value || customerPhoneInput?.value;
  const isPhoneValid = phone && phone.trim().length >= 7;

  // The checkout is considered "initiated" once we have items and a valid phone number.
  if (Object.keys(items).length > 0 && isPhoneValid) {
    trackFbInitiateCheckout({
      content_ids: Object.values(items).map(
        (item) => item.variantId || item.id,
      ),
      contents: Object.values(items).map((item) => ({
        id: item.variantId || item.id,
        quantity: item.quantity,
        item_price: item.price,
      })),
      currency: window.__CURRENCY_CODE__ || "BDT",
      num_items: Object.values(items).reduce(
        (sum, item) => sum + item.quantity,
        0,
      ),
      value: totalAmount,
    });

    hasTrackedInitiateCheckout = true;
  }
}

// --- Discount Logic ---
async function handleApplyDiscount() {
  const lang = await getLanguageData();
  const codeInput = document.getElementById(
    "discountCodeInput",
  ) as HTMLInputElement;
  const code = codeInput.value.trim().toUpperCase();
  if (!code) {
    showDiscountMessage(activeCheckoutCopy().enterDiscountCodeText, "error");
    return;
  }
  // Reflect the normalized code back in the input
  codeInput.value = code;

  const { items, totalAmount, discount: existingDiscount } = cartStore.get();
  if (Object.keys(items).length === 0) {
    showDiscountMessage(lang.languageData.emptyCartText, "error");
    return;
  }
  if (existingDiscount) {
    showDiscountMessage(activeCheckoutCopy().removeCurrentDiscountText, "error");
    return;
  }

  const customerPhoneInput = document.querySelector<HTMLInputElement>(
    '[name="customerPhone"]',
  );
  const enteredPhone = (
    customerPhoneInput?.dataset.e164Value ||
    customerPhoneInput?.value ||
    ""
  ).trim();
  const customerPhone =
    enteredPhone && enteredPhone.length >= 7 ? enteredPhone : undefined;

  const applyBtn = document.getElementById(
    "applyDiscountBtn",
  ) as HTMLButtonElement;
  applyBtn.textContent = lang.languageData.processingText;
  applyBtn.disabled = true;

  try {
    const shippingCost = getEffectiveCartShippingFee(
      items,
      window.lastShippingEventDetail?.fee ?? 0,
    );
    const result = await validateDiscount(
      code,
      totalAmount,
      Object.values(items),
      shippingCost,
      customerPhone,
    );

    if (
      result?.valid &&
      result.discount &&
      result.discountAmount !== undefined
    ) {
      applyDiscount({
        ...result.discount,
        discountAmount: result.discountAmount,
      });
      showDiscountMessage(activeCheckoutCopy().discountAppliedText, "success");
    } else {
      if (result?.requiresCustomerPhone) {
        customerPhoneInput?.focus();
      }
      showDiscountMessage(result?.error || activeCheckoutCopy().invalidDiscountCodeText, "error");
    }
  } catch (error: unknown) {
    console.error("Error applying discount:", error);
    showDiscountMessage(activeCheckoutCopy().discountApplyFailedText, "error");
  } finally {
    applyBtn.textContent = lang.languageData.applyDiscountText;
    applyBtn.disabled = false;
  }
}

function handleRemoveDiscount() {
  removeDiscount();
  showDiscountMessage(activeCheckoutCopy().discountRemovedText, "success");
}

// --- Initialization ---
export async function initCartFunctionality() {
  const runtimeSignal = resetCartRuntimeListeners();
  hydrateCartFromStorage();
  hostedPaymentRecoverySession = readHostedPaymentRecoverySession();
  reconcileHostedPaymentRecoveryWithCart();
  renderCheckoutRecoveryNotice();

  // ── Read server-rendered shipping defaults ────────────────────────────────
  // Eliminates the race condition: this runs before React hydration, ensuring
  // window.lastShippingEventDetail is always set for the first updateTotals().
  if (!window.lastShippingEventDetail) {
    const meta = document.getElementById("checkout-meta");
    const defaultId = meta?.dataset.defaultShippingId;
    const defaultFee = meta?.dataset.defaultShippingFee;
    const defaultName = meta?.dataset.defaultShippingName;
    if (defaultId) {
      window.lastShippingEventDetail = {
        id: defaultId,
        fee: parseInt(defaultFee || "0", 10),
        name: defaultName || "",
      };
    }
  }

  // --- MODIFIED: Call the new quick buy processor first ---
  processQuickBuy();

  // Populate the hidden checkoutId input field
  syncCheckoutIdInput();

  window.handleAbandonedCheckout = handleAbandonedCheckout;
  window.validateCartSnapshot = validateCartSnapshot;
  window.hasCartValidationIssues = () => hasBlockingCartIssues();
  window.getCartBlockedMessage = () => cartBlockedMessage();

  window.updateCartQuantity = (cartKey, qty) => {
    const currentQuantity = cartStore.get().items[cartKey]?.quantity ?? 0;
    if (
      !Object.prototype.hasOwnProperty.call(cartQuantityLimits, cartKey) &&
      qty > currentQuantity
    ) {
      return;
    }
    const quantityLimit = cartQuantityLimits[cartKey];
    const nextQuantity =
      typeof quantityLimit === "number" ? Math.min(qty, quantityLimit) : qty;
    rotateCheckoutIdIfCartBlocked();
    clearCartValidationSummary();
    if (nextQuantity <= 0) removeCartItemByKey(cartKey);
    else updateCartItemByKey(cartKey, { quantity: nextQuantity });
  };
  window.removeFromCart = (cartKey) => {
    rotateCheckoutIdIfCartBlocked();
    clearCartValidationSummary();
    delete cartQuantityLimits[cartKey];
    removeCartItemByKey(cartKey);
  };
  window.removeCartIssueItem = (cartKey) => {
    rotateCheckoutIdIfCartBlocked();
    clearCartValidationSummary();
    delete cartValidationIssues[cartKey];
    delete cartQuantityLimits[cartKey];
    removeCartItemByKey(cartKey);
  };
  window.reduceCartIssueItem = (cartKey) => {
    rotateCheckoutIdIfCartBlocked();
    const issue = (cartValidationIssues[cartKey] ?? []).find(
      (item) => item.action === "reduce_quantity",
    );
    clearCartValidationSummary();
    if (
      typeof issue?.availableQuantity !== "number" ||
      issue.availableQuantity < 1
    ) {
      delete cartValidationIssues[cartKey];
      removeCartItemByKey(cartKey);
      return;
    }
    delete cartValidationIssues[cartKey];
    updateCartItemByKey(cartKey, { quantity: issue.availableQuantity });
  };
  window.refreshCartIssueItem = (cartKey) => {
    rotateCheckoutIdIfCartBlocked();
    const issue = (cartValidationIssues[cartKey] ?? []).find(
      (item) => item.action === "refresh_item",
    );
    if (typeof issue?.currentPrice !== "number") return;
    clearCartValidationSummary();
    delete cartValidationIssues[cartKey];
    updateCartItemByKey(cartKey, {
      price: issue.currentPrice,
      name: issue.productName || undefined,
    });
  };
  const applyBulkCartRepair = (action: BulkCartRepairAction) => {
    const keys = selectCartKeysForBulkRepair(cartValidationIssues, action);
    keys.forEach((cartKey) => {
      if (action === "remove") {
        window.removeCartIssueItem?.(cartKey);
      } else if (action === "reduce_quantity") {
        window.reduceCartIssueItem?.(cartKey);
      } else {
        window.refreshCartIssueItem?.(cartKey);
      }
    });
    if (keys.length > 0) {
      void validateCartSnapshot();
    }
  };
  window.bulkRemoveCartIssueItems = () => applyBulkCartRepair("remove");
  window.bulkReduceCartIssueItems = () =>
    applyBulkCartRepair("reduce_quantity");
  window.bulkRefreshCartIssueItems = () => applyBulkCartRepair("refresh_item");

  let cartSubscriptionIsLive = false;
  cartStoreUnsubscribe = cartStore.subscribe(() => {
    // Nanostores invokes subscribers once immediately. Initialization already
    // renders and validates the hydrated cart below, so treating that first
    // observation as a mutation schedules a duplicate serial validation.
    if (!cartSubscriptionIsLive) {
      cartSubscriptionIsLive = true;
      return;
    }
    if (isApplyingCartSnapshot) return;
    reconcileHostedPaymentRecoveryWithCart();
    void renderCartItems();
    updateCheckoutButtonState();
    handleAbandonedCheckout();
    scheduleCartValidation();
  });

  window.addEventListener(
    "shippingLocationChange",
    (e) => {
      window.lastShippingEventDetail = (e as CustomEvent).detail;
      // Preserve the buyer's code while the authoritative quote rechecks it
      // against the newly selected delivery method. Initialization and browser
      // restoration emit this event too, so clearing here loses valid codes.
      void updateTotals();
      handleAbandonedCheckout();
    },
    { signal: runtimeSignal },
  );

  window.addEventListener(
    "checkout-location-change",
    (event) => {
      const detail = (
        event as CustomEvent<{
          cityId?: unknown;
          cityName?: unknown;
          zoneId?: unknown;
          zoneName?: unknown;
          areaId?: unknown;
          areaName?: unknown;
        }>
      ).detail;
      latestCheckoutLocation = {
        cityId: typeof detail?.cityId === "string" ? detail.cityId : "",
        cityName: typeof detail?.cityName === "string" ? detail.cityName : "",
        zoneId: typeof detail?.zoneId === "string" ? detail.zoneId : "",
        zoneName: typeof detail?.zoneName === "string" ? detail.zoneName : "",
        areaId: typeof detail?.areaId === "string" ? detail.areaId : "",
        areaName: typeof detail?.areaName === "string" ? detail.areaName : "",
      };
      void updateTotals();
      handleAbandonedCheckout();
    },
    { signal: runtimeSignal },
  );

  document.addEventListener(
    "zone-selected",
    () => {
      attemptToTrackInitiateCheckout();
      handleAbandonedCheckout();
    },
    { signal: runtimeSignal },
  );

  document.getElementById("discountForm")?.addEventListener(
    "submit",
    (e) => {
      e.preventDefault();
      handleApplyDiscount();
    },
    { signal: runtimeSignal },
  );

  document.getElementById("customerPhone-input")?.addEventListener(
    "blur",
    () => {
      attemptToTrackInitiateCheckout();
    },
    { signal: runtimeSignal },
  );

  document.getElementById("checkoutForm")?.addEventListener(
    "input",
    () => {
      handleAbandonedCheckout();
    },
    { signal: runtimeSignal },
  );

  document
    .getElementById("removeDiscountBtn")
    ?.addEventListener("click", handleRemoveDiscount, {
      signal: runtimeSignal,
    });

  await getLanguageData();
  await renderCartItems();
  if (applyPendingCartRepairState()) {
    await renderCartItems();
  }
  await validateCartSnapshot();
  updateCheckoutButtonState();
}

export async function resumeCartPageFromHistory(): Promise<void> {
  hostedPaymentRecoverySession = readHostedPaymentRecoverySession();
  isApplyingCartSnapshot = true;
  try {
    syncCartFromStorage();
  } finally {
    isApplyingCartSnapshot = false;
  }
  reconcileHostedPaymentRecoveryWithCart();
  renderCheckoutRecoveryNotice();
  syncCheckoutIdInput();
  if (Object.keys(cartStore.get().items).length > 0) {
    await validateCartSnapshot();
  } else {
    await renderCartItems();
  }
  updateCheckoutButtonState();
}

// Window augmentations for cart handlers are declared in env.d.ts
