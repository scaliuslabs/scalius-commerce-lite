import { readBuyerAttributes, renderBuyerUi } from "@/lib/buyer-ui";
import { buyerUiLocaleHeaders } from "@/lib/buyer-ui/locale";
// src/lib/cart/client.ts
import { billingQuoteFields } from "@/lib/checkout/billing-address";
import {
  cartStore,
  hydrateCartFromStorage,
  syncCartFromStorage,
  addToCart,
  startBuyNow,
  addDiscountCode,
  removeCartItemByKey,
  removeDiscountCode,
  restoreCart,
  updateCartItemByKey,
  getEffectiveCartShippingFee,
  cartItemsSubtotal,
  cartLinePropertyInputs,
  cartNeedsDeliveryMethod,
  type CartItem,
  type VariantCartItem,
} from "@/store/cart";
import { readCheckoutDeliveryMode } from "../checkout/delivery-mode";
import { writeCartLineEdit } from "./line-edit";
import { renderCartLineProperties } from "./line-properties-view";
import type {
  CartRuleError,
  CartValidationIssue,
  CartValidationItem,
  CartValidationResult,
} from "@/lib/api/orders";
import type { CheckoutLanguageData } from "@/lib/api/types";
import {
  previewCartDiscounts,
  saveAbandonedCheckoutFromBrowser as saveAbandonedCheckout,
} from "./browser-api";
import { formatMoney, getCurrencyCode, getDecimalPlaces } from "@/lib/currency";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { formatCheckoutLanguageText } from "@scalius/shared/checkout-language-format";
import { numberLocale } from "@scalius/shared/locale-format";
import { formatList } from "@scalius/shared/locale-words";
import { storeRegion } from "@/lib/store-time-zone";
import { nanoid } from "nanoid";
import { getProductImageUrl } from "@/lib/product-media";
import { applyCheckoutButtonState } from "./checkout-button-state";
import { renderEmptyCartState } from "./empty-state";
import { renderCartIssueAction } from "./issue-action";
import {
  readAndClearCartRepairState,
  readAndClearInlineCartRepairState,
} from "./repair-state";
import { reconcileValidatedCartSnapshot, repriceCartForCurrency } from "./validation-reconciliation";
import {
  renderBulkCartRepairActions,
  selectCartKeysForBulkRepair,
  type BulkCartRepairAction,
} from "./bulk-repair-actions";
import { resolveCartKeyForValidatedLine } from "./cart-key-resolution";
import {
  cartLineRuleErrorsId,
  fillCartRuleBanner,
  groupCartRuleErrors,
  mergeCartRuleErrors,
  renderCartLineRuleErrors,
} from "./rule-errors";
import {
  clearCheckoutAttemptSession,
  clearHostedPaymentRecoverySession,
  readHostedPaymentRecoverySession,
  type HostedPaymentRecoverySession,
  writeReviewedCheckoutQuote,
} from "../checkout/session-state";
import { inspectCheckoutRecovery } from "../checkout/recovery-status";
import {
  fetchAuthoritativeTaxQuote,
  TaxQuoteCartChangedError,
  TaxQuoteCartRulesError,
  TaxQuoteDeliveryLocationError,
  TaxQuoteDeliveryRateError,
} from "../checkout/tax-quote-client";
import {
  cartRuleRefusal,
  isDeliveryRateUnavailable,
  parseCartRuleErrors,
  refusedDeliveryRates,
  unavailableDeliveryLocation,
  type DeliveryLocationLevel,
} from "../checkout/tax-quote-error-contract";

/**
 * The merchant removed the city, thana or area the buyer chose: the checkout
 * page clears that choice and asks again at the field (one message, never the
 * connection copy).
 */
function rejectDeliveryLocation(field: DeliveryLocationLevel): void {
  window.dispatchEvent(new CustomEvent("delivery-location-unavailable", { detail: { field } }));
}

/**
 * The checkout refused the chosen delivery option: the options drop it and
 * choose again, from the options still offered when a store app hid it.
 */
function rejectDeliveryRate(shippingRates: QuotedShippingRate[] | null): void {
  window.dispatchEvent(new CustomEvent("delivery-rate-rejected", { detail: { shippingRates } }));
}
import { hasPendingShippingRate, type ShippingMethodDetail } from "../checkout/shipping-methods";
import type {
  CheckoutDiscountFacts,
  CheckoutDiscountOffer,
  CheckoutTaxQuote,
  QuotedShippingRate,
} from "../checkout/tax-quote-contract";
import {
  cartItemVariantLabel as optionVariantLabel,
  normalizeCartItemOptions,
} from "./item-options";
import {
  describeRejectedCode,
  isPendingCodeReason,
  renderDiscountPanel,
} from "./discount-panel";
import { fetchWithTransientRetry } from "@/lib/transient-fetch";
import { currentPresence } from "@/lib/presence-url";

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

// Pixel mappers load on first use, off the checkout's critical path.
function withAnalytics(
  run: (analytics: typeof import("@/lib/analytics")) => void,
): void {
  void import("@/lib/analytics").then(run).catch(() => undefined);
}

// cart.astro always serializes the fully resolved active checkout language
// (English fallback included) before this module runs.
const pageCheckoutLanguage = () =>
  window.__CHECKOUT_LANGUAGE__ as CheckoutLanguageData;
const activeCheckoutCopy = () => pageCheckoutLanguage().languageData;
let hasTrackedInitiateCheckout = false;
let cartValidationIssues: Record<string, CartValidationIssue[]> = {};
/**
 * Store app rules that block the order, from the latest availability check
 * and from the latest quote (which knows the address, codes and phone). A
 * later answer without rules clears its own list.
 */
let validationRuleErrors: CartRuleError[] = [];
let quoteRuleErrors: CartRuleError[] = [];
/** The line rules the painted lines show, so a rule answer repaints only on change. */
let paintedLineRuleErrors = "{}";
let cartValidationGlobalError = "";
let cartValidationSummaryMessage = "";
let cartQuantityLimits: Record<string, number | null> = {};
let preserveCartValidationSummaryOnce = false;
/** The check in flight; a newer cart change cancels it. */
let cartValidationAbort: AbortController | null = null;
/** True while the last check failed in transit, so the message offers "Try again". */
let cartValidationRetryable = false;
const CART_VALIDATION_TIMEOUT_MS = 10_000;
let cartValidationTimer: ReturnType<typeof setTimeout> | null = null;
let cartValidationSequence = 0;
let isApplyingCartSnapshot = false;
let cartTaxQuoteSequence = 0;
/**
 * The cart lines a refused quote already sent back to the availability check.
 * That check re-renders the totals, which quote again: without this, a line
 * the buyer has not fixed yet (sold out, too many) re-checks forever.
 */
let quoteRefusalRecheckedLines: string | null = null;
let discountValidationSequence = 0;
let pendingDiscountValidation: number | null = null;
/** The latest server discount facts, for the applied-code list. */
let latestDiscountFacts: CheckoutDiscountFacts | null = null;
/**
 * Payment methods the server allows for this cart (cash on delivery only when
 * something is shipped, collected or performed); null until it has answered.
 */
let latestAllowedPaymentMethods: string[] | null = null;
/**
 * The names of the validated lines paid only online (digital items, gift
 * cards), and whether every line is one: the cash-on-delivery refusal names them.
 */
let latestOnlineOnlyLines: { names: string[]; all: boolean } = { names: [], all: false };
let latestCheckoutLocation: {
  cityId: string;
  cityName: string;
  zoneId: string;
  zoneName: string;
  areaId: string;
  areaName: string;
} | null = null;
let hostedPaymentRecoverySession: HostedPaymentRecoverySession | null = null;
let undoTimer: ReturnType<typeof setTimeout> | null = null;

function pendingCheckoutForThisTab(): HostedPaymentRecoverySession | null {
  try {
    const recovery = readHostedPaymentRecoverySession();
    return recovery?.checkoutId && recovery.checkoutId === sessionStorage.getItem("checkoutId") ? recovery : null;
  } catch {
    return null;
  }
}

function clearExpiredCheckoutAttempt(checkoutId: string): void {
  try {
    if (sessionStorage.getItem("checkoutId") === checkoutId) {
      clearCheckoutAttemptSession({ preserveFormDraft: true });
    }
  } catch {
    // Blocked storage cannot establish which attempt this tab owns.
  }
}

async function refreshCheckoutRecovery(signal: AbortSignal): Promise<void> {
  const recovery = hostedPaymentRecoverySession;
  if (!recovery) return;
  const status = await inspectCheckoutRecovery(recovery);
  if (signal.aborted || status !== "expired"
    || JSON.stringify(readHostedPaymentRecoverySession()) !== JSON.stringify(recovery)) return;
  clearHostedPaymentRecoverySession();
  hostedPaymentRecoverySession = null;
  if (recovery.checkoutId) clearExpiredCheckoutAttempt(recovery.checkoutId);
  renderCheckoutRecoveryNotice();
  syncCheckoutIdInput();
  if (Object.keys(cartStore.get().items).length === 0) await renderCartItems();
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
  const hadPendingDiscountValidation = pendingDiscountValidation !== null;
  cartTaxQuoteSequence += 1;
  discountValidationSequence += 1;
  pendingDiscountValidation = null;
  latestDiscountFacts = null;
  latestAllowedPaymentMethods = null;
  latestOnlineOnlyLines = { names: [], all: false };
  latestCheckoutLocation = null;
  cartQuantityLimits = {};
  validationRuleErrors = [];
  quoteRuleErrors = [];
  cartStoreUnsubscribe?.();
  cartStoreUnsubscribe = null;
  cartRuntimeAbortController?.abort();
  cartRuntimeAbortController = new AbortController();
  cartValidationAbort?.abort();
  cartValidationAbort = null;
  cartValidationRetryable = false;

  for (const timer of [abandonedCheckoutTimer, cartValidationTimer, undoTimer]) {
    if (timer !== null) clearTimeout(timer);
  }
  abandonedCheckoutTimer = null;
  cartValidationTimer = null;
  undoTimer = null;

  if (hadPendingDiscountValidation) {
    setApplyButtonPending(false);
    notifyDiscountValidationState();
  }

  return cartRuntimeAbortController.signal;
}

export function isDiscountValidationPending(): boolean {
  return pendingDiscountValidation !== null;
}

function notifyDiscountValidationState(): void {
  updateCheckoutButtonState();
  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent("discount-validation-state"));
  }
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

interface CheckoutFormData {
  [key: string]:
    | FormDataEntryValue
    | { items: unknown[]; totalAmount: number; discountCodes: string[] }
    | { id: string; fee: number }
    | undefined;
  cart?: { items: unknown[]; totalAmount: number; discountCodes: string[] };
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

  const { items, totalAmount, discountCodes } = cartStore.get();
  data.cart = {
    items: Object.values(items),
    totalAmount,
    discountCodes,
  };

  const selectedShipping = window.lastShippingEventDetail;
  data.shipping = selectedShipping
    ? {
        ...selectedShipping,
        fee: getEffectiveCartShippingFee(items, selectedShipping.fee, selectedShipping.freeOver, selectedShipping.quoted),
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

/** The totals ask again after a quote fails in transit (a cold or restarting API), then say so with a retry button. */
const QUOTE_RETRY_DELAYS_MS = [500, 1500] as const;

function syncCartPagePresentation(ready: boolean): void {
  const root = document.getElementById("cartPageRoot");
  const cartItems = document.getElementById("cartItems");
  const cartSummary = document.getElementById("cartSummary");
  const checkoutPanel = document.getElementById("checkoutPanel");
  const hasItems = Object.keys(cartStore.get().items).length > 0;

  if (root) {
    root.dataset.cartReady = ready ? "true" : "false";
    root.dataset.cartHasItems = hasItems ? "true" : "false";
    // An empty cart is a centred empty state without checkout steps.
    root.dataset.cartState = !ready ? "loading" : hasItems ? "items" : "empty";
  }
  cartItems?.setAttribute("aria-busy", ready ? "false" : "true");

  const hideOperationalPanels = !ready || !hasItems;
  cartSummary?.classList.toggle("hidden", hideOperationalPanels);
  checkoutPanel?.classList.toggle("hidden", hideOperationalPanels);
  // The cart drawer's "Checkout" lands on the form (`#checkoutFormCard`). It is
  // shown only now, after the browser tried the fragment, so scroll here once.
  if (!hideOperationalPanels && !checkoutFragmentShown && window.location.hash === "#checkoutFormCard") {
    checkoutFragmentShown = true;
    document.getElementById("checkoutFormCard")?.scrollIntoView({ block: "start" });
  }
}

let checkoutFragmentShown = false;

async function processQuickBuy() {
  try {
    const quickBuyJSON = sessionStorage.getItem("quickBuyData");
    if (quickBuyJSON) {
      // IMPORTANT: Remove the item immediately to prevent re-adding on refresh
      sessionStorage.removeItem("quickBuyData");

      const data = JSON.parse(quickBuyJSON);

      if (data.cartItem) {
        // Buyer inputs (from the product page's no-JS form) come with the
        // line; the analytics events below never carry them.
        // The quick-buy line joins the existing cart before checkout.
        if (!(await startBuyNow(data.cartItem))) {
          const notice = document.getElementById("quickBuyStorageNotice");
          if (notice) {
            notice.textContent = activeCheckoutCopy().quickBuyFailedText;
            notice.hidden = false;
          }
          return;
        }

        const dynamicCurrency = window.__CURRENCY_CODE__ || "BDT";
        if (data.addToCartEvent) {
          data.addToCartEvent.currency = dynamicCurrency;
          withAnalytics((analytics) =>
            analytics.trackFbAddToCart(data.addToCartEvent),
          );
        }
        if (data.initiateCheckoutEvent) {
          data.initiateCheckoutEvent.currency = dynamicCurrency;
          withAnalytics((analytics) =>
            analytics.trackFbInitiateCheckout(data.initiateCheckoutEvent),
          );
        }
      }
    }
  } catch (e: unknown) {
    console.error("Error processing quick buy data:", e);
  }
}

// --- Discount code field ---

/**
 * The code field's message stays until the buyer edits the field or applies
 * again, so it never disappears before it is read.
 */
function showDiscountMessage(message: string, type: "success" | "error") {
  const messageElement = document.getElementById("discountMessage");
  const input = document.getElementById("discountCodeInput");
  if (!messageElement) return;
  messageElement.dataset.tone = type;
  messageElement.textContent = message;
  messageElement.className = `mt-1.5 text-sm ${type === "error" ? "text-destructive" : "text-primary"}`;
  messageElement.hidden = !message;
  if (type === "error" && message) input?.setAttribute("aria-invalid", "true");
  else input?.removeAttribute("aria-invalid");
}

function clearDiscountMessage() {
  showDiscountMessage("", "success");
}

/**
 * "SAVE10 applied" is true only for the cart it was applied to; after a cart
 * change each code's own status (under the code) says whether it still applies.
 */
function clearDiscountSuccessMessage() {
  if (document.getElementById("discountMessage")?.dataset.tone === "success") clearDiscountMessage();
}

function setApplyButtonPending(pending: boolean) {
  const applyButton = document.getElementById(
    "applyDiscountBtn",
  ) as HTMLButtonElement | null;
  if (!applyButton) return;
  applyButton.textContent = pending
    ? activeCheckoutCopy().processingText
    : activeCheckoutCopy().applyDiscountText;
  applyButton.disabled = pending;
}

function cartItemVariantLabel(item: CartItem): string | null {
  return optionVariantLabel(item.options);
}

function cartValidationPayload(items: Record<string, VariantCartItem>) {
  return Object.entries(items).map(([cartKey, item]) => {
    const properties = cartLinePropertyInputs(item);
    return {
      cartKey,
      productId: item.id,
      variantId: item.variantId,
      quantity: item.quantity,
      price: item.price,
      productName: item.name,
      variantLabel: cartItemVariantLabel(item),
      ...(properties.length > 0 ? { properties } : {}),
    };
  });
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

  // The checkout phone field exposes only its validated E.164 value through
  // this dataset; an incomplete number must never reach tax-quote input.
  if (input.dataset.e164Value !== undefined) {
    const canonical = input.dataset.e164Value.trim();
    return /^\+[1-9]\d{6,14}$/.test(canonical) ? canonical : null;
  }

  const legacyValue = input.value.trim();
  return legacyValue.length >= 7 ? legacyValue : null;
}

/**
 * What the authoritative quote needs on each checkout path: delivery needs
 * the address and a delivery rate, pickup only the pickup rate, and a cart
 * with nothing physical nothing at all (no method, no fee, store-wide tax).
 */
function cartTaxQuoteInput(): Record<string, unknown> | null {
  const mode = readCheckoutDeliveryMode();
  const city = latestCheckoutLocation?.cityId || formStringValue("city");
  const zone = latestCheckoutLocation?.zoneId || formStringValue("zone");
  const method = window.lastShippingEventDetail;
  const cartItems = (
    document.getElementById("cartItemsInput") as HTMLInputElement | null
  )?.value;

  if (!cartItems || cartItems === "{}") return null;
  const common = {
    cartItems,
    attributes: readBuyerAttributes(),
    deliveryMode: mode,
    discountCodes: cartStore.get().discountCodes,
    customerPhone: formCanonicalPhoneValue() || undefined,
  };
  // Nothing physical: taxed at the billing country, region and postal code (MARKETS-DESIGN, 0119).
  if (mode === "none") {
    return {
      ...common,
      ...billingQuoteFields(mode, {
        billingCountryCode: formStringValue("billingCountryCode"),
        billingAdminArea: formStringValue("billingAdminArea"),
        billingPostalCode: formStringValue("billingPostalCode"),
      }),
    };
  }
  if (mode === "pickup") {
    return method?.kind === "pickup" ? { ...common, shippingMethodId: method.id } : null;
  }
  // Another country's delivery: its shipping zone matches on its region and
  // postal code (MARKETS-DESIGN step 3b); Bangladesh's form sends neither.
  const country = formStringValue("shippingCountryCode")?.toUpperCase() ?? "";
  if (country && country !== "BD") {
    if (!method || method.kind !== "delivery") return null;
    return {
      ...common,
      shippingCountryCode: country,
      shippingAdminArea: formStringValue("shippingAdminArea") || undefined,
      shippingPostalCode: formStringValue("shippingPostalCode") || undefined,
      shippingMethodId: method.id,
    };
  }
  if (!city || !zone || !method || method.kind !== "delivery") return null;
  return {
    ...common,
    city,
    zone,
    area:
      latestCheckoutLocation?.areaId || formStringValue("area") || undefined,
    shippingMethodId: method.id,
  };
}

/** The codes the latest quote applied; only these go to the order commit. */
function setAcceptedDiscountCodes(facts: CheckoutDiscountFacts | null): void {
  const input = document.getElementById("discountCodesInput") as HTMLInputElement | null;
  if (!input) return;
  const accepted = (facts?.discounts ?? []).flatMap(({ code }) => (code ? [code] : []));
  input.value = accepted.length > 0 ? JSON.stringify(accepted) : "";
}

function renderDiscountFacts(facts: CheckoutDiscountFacts | null): void {
  latestDiscountFacts = facts;
  setAcceptedDiscountCodes(facts);
  const summary = document.getElementById("cartSummary");
  if (!summary) return;
  renderDiscountPanel(
    summary,
    { codes: cartStore.get().discountCodes, facts },
    activeCheckoutCopy(),
    {
      removeCode: (code) => {
        clearDiscountMessage();
        removeDiscountCode(code);
      },
      addOfferProduct,
      focusPhone: () => document.getElementById("customerPhone-input")?.focus(),
    },
  );
}

/** One-tap add of a simple product that completes a Buy X get Y. */
function addOfferProduct(offer: CheckoutDiscountOffer, productIndex: number): void {
  const product = offer.products[productIndex];
  if (!product?.variantId || product.price === null) return;
  void addToCart({
    id: product.id,
    slug: product.slug,
    name: product.name,
    price: product.price,
    variantId: product.variantId,
    quantity: Math.max(1, offer.quantity),
  });
}

type TotalsElements = {
  subtotal: HTMLElement;
  shipping: HTMLElement;
  total: HTMLElement;
  totalLabel: HTMLElement | null;
  taxLabel: HTMLElement | null;
  taxAmount: HTMLElement | null;
  taxStatus: HTMLElement | null;
  taxRow: HTMLElement | null;
};

/**
 * The delivery line: what the buyer pays, with the rate's fee struck through
 * when a free-delivery item, the rate's free-over threshold or a delivery
 * discount lowers it, and the code(s) that did. Never a separate discount line.
 */
function renderShippingLine(
  element: HTMLElement,
  shipping: { baseFee: number; charged: number; discounts: CheckoutDiscountFacts["discounts"] } | null,
  decimalPlaces = getDecimalPlaces(getCurrencyCode()),
): void {
  const copy = activeCheckoutCopy();
  if (!shipping) {
    element.textContent = "—";
    return;
  }
  const delivery = shipping.discounts.filter(({ shippingAmount }) => shippingAmount > 0);
  const discountMinor = delivery.reduce((total, { shippingAmount }) => total + toMinor(shippingAmount, decimalPlaces), 0);
  const net = fromMinor(Math.max(0, toMinor(shipping.charged, decimalPlaces) - discountMinor), decimalPlaces);
  const parts: Array<Node | string> = [];
  if (net < shipping.baseFee) {
    const struck = document.createElement("s");
    struck.className = "me-1.5 font-normal text-muted-foreground";
    struck.textContent = formatMoney(shipping.baseFee);
    parts.push(struck);
  }
  parts.push(net === 0 ? copy.freeText : formatMoney(net));
  if (delivery.length > 0) {
    const codes = document.createElement("span");
    codes.className = "ms-1 font-normal text-muted-foreground";
    codes.textContent = `(${delivery.map(({ code, title }) => code ?? title).join(", ")})`;
    parts.push(codes);
  }
  element.replaceChildren(...parts);
}

/** "Add ৳500 more for free delivery." while the chosen rate's threshold is not reached. */
function renderFreeDeliveryProgress(
  chargedFee: number,
  subtotal = cartItemsSubtotal(cartStore.get().items),
  decimalPlaces = getDecimalPlaces(getCurrencyCode()),
): void {
  const progress = document.getElementById("shippingProgress");
  if (!progress) return;
  const method = window.lastShippingEventDetail;
  const shortfall = method && method.freeOver !== null && chargedFee > 0
    ? fromMinor(toMinor(method.freeOver, decimalPlaces) - toMinor(subtotal, decimalPlaces), decimalPlaces)
    : 0;
  progress.textContent = shortfall > 0
    ? formatCheckoutLanguageText(activeCheckoutCopy().freeDeliveryProgressText, { amount: formatMoney(shortfall) })
    : "";
  progress.classList.toggle("hidden", shortfall <= 0);
}

function renderAuthoritativeCartQuote(
  quote: CheckoutTaxQuote,
  elements: TotalsElements,
): void {
  elements.taxRow?.classList.toggle("hidden", quote.taxMinor === 0);
  elements.subtotal.textContent = formatMoney(quote.subtotalAmount);
  latestAllowedPaymentMethods = quote.allowedPaymentMethods;
  if (quote.shippingMethod) {
    const quotedFee = quote.shippingMethod.baseAmountMinor / 10 ** quote.decimalPlaces;
    // The merchant changed this rate since the options were read: the options
    // re-read the rates and say "Delivery fee changed…" now, so the option label
    // and the summary never disagree.
    const chosen = window.lastShippingEventDetail;
    // A store app's options carry this quote's own fees (applied below).
    if (
      !quote.shippingRates &&
      chosen &&
      !chosen.quoted &&
      chosen.id === quote.shippingMethod.id &&
      chosen.fee !== quotedFee
    ) {
      window.dispatchEvent(new CustomEvent("delivery-rate-changed"));
    }
    renderShippingLine(elements.shipping, {
      baseFee: quotedFee,
      charged: quote.shippingAmount,
      discounts: quote.discounts,
    }, quote.decimalPlaces);
  } else {
    // Nothing physical: no delivery line to price (the row is hidden).
    renderShippingLine(elements.shipping, { baseFee: 0, charged: 0, discounts: [] });
  }
  renderFreeDeliveryProgress(quote.shippingAmount, quote.subtotalAmount, quote.decimalPlaces);
  elements.total.textContent = formatMoney(quote.totalAmount);
  if (elements.totalLabel) {
    elements.totalLabel.textContent =
      elements.totalLabel.dataset.finalLabel || activeCheckoutCopy().totalText;
  }
  if (elements.taxLabel) {
    elements.taxLabel.textContent = quote.pricesIncludeTax
      ? `${quote.displayLabel} (${activeCheckoutCopy().includedText})`
      : quote.displayLabel;
  }
  if (elements.taxAmount) {
    elements.taxAmount.textContent = formatMoney(quote.taxAmount);
  }
  setTaxStatus(elements, "");
  renderDiscountFacts(quote);
  // The delivery options as a store app left them for this cart; null keeps
  // the store's own (and takes back an earlier app change).
  window.dispatchEvent(new CustomEvent("delivery-rates-quoted", {
    detail: { shippingRates: quote.shippingRates ?? null },
  }));
}

function setTaxStatus(elements: TotalsElements, message: string): void {
  const status = elements.taxStatus;
  if (!status) return;
  status.replaceChildren();
  status.classList.toggle("hidden", !message);
  if (!message) return;
  status.append(document.createTextNode(`${message} `));
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "font-medium underline underline-offset-2";
  retry.textContent = activeCheckoutCopy().retryText;
  retry.addEventListener("click", () => {
    // A clear state while it asks again: the button says so and cannot be pressed twice.
    retry.disabled = true;
    retry.textContent = activeCheckoutCopy().calculatingText;
    void updateTotals();
  });
  status.append(retry);
}

/** The page's subfolder presence for a cart check (none at the root). */
function cartPresencePayload(): { presence?: string } {
  const presence = currentPresence();
  return presence ? { presence } : {};
}

function cartValidationDeliveryPayload() {
  const mode = readCheckoutDeliveryMode();
  const method = window.lastShippingEventDetail;
  if (mode === "none" || !method) return {};
  // A pickup rate is checked on its own: it needs no address.
  if (mode === "pickup") return method.kind === "pickup" ? { shippingMethodId: method.id } : {};
  const city = formStringValue("city");
  const zone = formStringValue("zone");
  // Delivery is checked only against a rate chosen for this address.
  if (!city || !zone || method.kind !== "delivery") return {};

  return {
    city,
    zone,
    area: formStringValue("area"),
    shippingMethodId: method.id,
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
  // The estimate counts only buyable units: a line that sold out (or came
  // back) changes the totals, so they are drawn again.
  const estimateBefore = JSON.stringify(estimableCartLines(items, cartValidationIssues).items);
  cartValidationIssues = grouped;
  updateCartValidationMessage();
  if (JSON.stringify(estimableCartLines(items, grouped).items) !== estimateBefore) void updateTotals();
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

/**
 * A cash-on-delivery-only store can't take a cart the server allows no cash
 * payment for (a cart of digital items). The payment page filters the same
 * list for stores with online methods.
 */
function codRefusedForCart(): boolean {
  if (typeof document === "undefined") return false;
  const codOnly = document.getElementById("checkout-meta")?.dataset.codOnly === "true";
  return codOnly && latestAllowedPaymentMethods !== null && !latestAllowedPaymentMethods.includes("cod");
}

/** The lines nothing but an online payment can pay for (digital items and gift cards). */
function onlineOnlyLines(items: readonly CartValidationItem[]): { names: string[]; all: boolean } {
  const online = items.filter((item) => item.fulfillmentType === "digital" || item.fulfillmentType === "gift_card");
  return {
    names: [...new Set(online.map((item) => item.productName.trim()).filter(Boolean))],
    all: items.length > 0 && online.length === items.length,
  };
}

/**
 * Why a cash-on-delivery-only store refuses this cart, in words that name the
 * reason: its digital items and gift cards are paid only online. Any other
 * refusal (a delivery country cash on delivery doesn't serve) keeps the
 * general wording.
 */
function codRefusedMessage(): string {
  const copy = activeCheckoutCopy();
  const { names, all } = latestOnlineOnlyLines;
  if (!all || names.length === 0) return copy.noPaymentMethodsText;
  const language = pageCheckoutLanguage().code;
  return formatCheckoutLanguageText(copy.cartOnlinePaymentRequiredText, {
    items: formatList(names, numberLocale(language || "en", storeRegion())),
  });
}

function cartRuleErrors(): CartRuleError[] {
  return mergeCartRuleErrors(validationRuleErrors, quoteRuleErrors);
}

function hasCartRuleErrors(): boolean {
  return validationRuleErrors.length > 0 || quoteRuleErrors.length > 0;
}

function hasBlockingCartIssues(): boolean {
  return Boolean(cartValidationGlobalError) || cartIssueCount() > 0 || hasCartRuleErrors() || codRefusedForCart();
}

/** The banner above the checkout action, repainted only when what it says changes. */
function renderCartRuleBanner(): boolean {
  const banner = document.getElementById("cartRuleErrors");
  if (!banner) return false;
  const groups = groupCartRuleErrors(cartRuleErrors(), cartStore.get().items);
  const key = JSON.stringify([groups.cart, Object.keys(groups.lines)]);
  if (banner.dataset.ruleKey !== key) {
    banner.dataset.ruleKey = key;
    fillCartRuleBanner(banner, groups, activeCheckoutCopy());
  }
  return !banner.classList.contains("hidden");
}

function cartBlockedMessage(): string {
  if (cartValidationGlobalError) return cartValidationGlobalError;
  if (cartIssueCount() === 0 && hasCartRuleErrors()) return activeCheckoutCopy().cartRulesBlockedText;
  if (cartIssueCount() === 0 && codRefusedForCart()) return codRefusedMessage();
  const count = Object.keys(cartValidationIssues).length;
  if (count <= 0) return "";
  if (cartValidationSummaryMessage) return cartValidationSummaryMessage;
  return count === 1
    ? activeCheckoutCopy().cartItemChangedText
    : formatCheckoutLanguageText(activeCheckoutCopy().cartItemsNeedAttentionText, { count });
}

function updateCartValidationMessage() {
  const ruleBannerShown = renderCartRuleBanner();
  const message = document.getElementById("cartValidationMessage");
  if (!message) return;

  // Rules alone are said once, by the banner above the checkout action.
  const rulesOnly = ruleBannerShown && !cartValidationGlobalError && cartIssueCount() === 0 && !codRefusedForCart();
  if (hasBlockingCartIssues() && !rulesOnly) {
    message.textContent = cartBlockedMessage();
    if (cartValidationGlobalError && cartValidationRetryable) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.dataset.cartValidationRetry = "true";
      retry.className = "ms-1 font-medium underline underline-offset-2";
      retry.textContent = activeCheckoutCopy().retryText;
      retry.addEventListener("click", () => {
        retry.disabled = true;
        retry.textContent = activeCheckoutCopy().calculatingText;
        void validateCartSnapshot({ renderUnchanged: false });
      });
      message.append(retry);
    }
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

  // A rejected validation does not prove that an earlier submit failed to
  // commit. Keep its identity even when its response/recovery pointer was lost.

  if (state.issues.length > 0) {
    setCartValidationIssues(state.issues, cartStore.get().items, state.message);
    preserveCartValidationSummaryOnce = true;
  } else if (state.ruleErrors?.length) {
    // What the checkout's quote or order said; this page's next quote replaces it.
    cartValidationIssues = {};
    clearCartValidationSummary();
    quoteRuleErrors = state.ruleErrors;
    updateCartValidationMessage();
  } else {
    cartValidationIssues = {};
    clearCartValidationSummary();
    cartValidationGlobalError = state.message;
    updateCartValidationMessage();
  }
  updateCheckoutButtonState();
  return true;
}

async function refreshBuyerUi(): Promise<void> {
  await validateCartSnapshot();
}

export async function validateCartSnapshot(
  /** Re-render the lines even when the check changed nothing (a page shown again). */
  { renderUnchanged = true }: { renderUnchanged?: boolean } = {},
): Promise<boolean> {
  const { items } = cartStore.get();
  const attributes = readBuyerAttributes();
  const attributesInput = document.getElementById("attributesInput") as HTMLInputElement | null;
  if (attributesInput) attributesInput.value = JSON.stringify(attributes);
  const payloadItems = cartValidationPayload(items);
  const sequence = ++cartValidationSequence;
  cartValidationAbort?.abort();
  const controller = new AbortController();
  cartValidationAbort = controller;

  if (payloadItems.length === 0) {
    renderBuyerUi([]);
    cartValidationRetryable = false;
    cartValidationIssues = {};
    validationRuleErrors = [];
    quoteRuleErrors = [];
    cartValidationGlobalError = "";
    clearCartValidationSummary();
    updateCartValidationMessage();
    updateCheckoutButtonState();
    return true;
  }

  try {
    const response = await fetchWithTransientRetry(
      fetch,
      "/api/checkout/validate-cart",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...await buyerUiLocaleHeaders() },
        body: JSON.stringify({
          items: payloadItems,
          ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
          ...cartValidationDeliveryPayload(),
          // The page's market prices the cart (MARKETS-DESIGN D5).
          ...cartPresencePayload(),
        }),
      },
      QUOTE_RETRY_DELAYS_MS,
      { timeoutMs: CART_VALIDATION_TIMEOUT_MS, signal: controller.signal },
    );
    const json = (await response.json().catch(() => null)) as {
      success?: boolean;
      error?: string;
      data?: CartValidationResult;
      details?: { itemIssues?: CartValidationIssue[]; message?: string };
    } | null;

    if (sequence !== cartValidationSequence) {
      return !hasBlockingCartIssues();
    }
    cartValidationRetryable = false;

    // What the lines show: a check that changes none of it re-renders (and
    // re-prices) nothing, so choosing a delivery option quotes once.
    const shown = () => JSON.stringify([cartStore.get().items, cartValidationIssues, cartRuleErrors(), cartValidationGlobalError, cartQuantityLimits, latestAllowedPaymentMethods]);
    const shownBefore = shown();
    const rawIssues = json?.data?.issues ?? json?.details?.itemIssues ?? [];
    let issues = Array.isArray(rawIssues) ? rawIssues : [];
    // A cart moved to a market in another currency takes its new prices at once.
    if (response.ok && json?.success && json.data) {
      isApplyingCartSnapshot = true;
      try {
        issues = repriceCartForCurrency(json.data, issues);
      } finally {
        isApplyingCartSnapshot = false;
      }
    }
    const summaryMessage =
      issues.length > 0 && preserveCartValidationSummaryOnce
        ? cartValidationSummaryMessage
        : "";
    preserveCartValidationSummaryOnce = false;
    // Rules are checked only once nothing else is wrong; no rules clears them.
    validationRuleErrors = response.ok && json?.success && json.data
      ? parseCartRuleErrors(json.data.ruleErrors)
      : cartRuleRefusal(json) ?? [];
    if (response.ok && json?.success && json.data) {
      isApplyingCartSnapshot = true;
      try {
        reconcileValidatedCartSnapshot(json.data);
      } finally {
        isApplyingCartSnapshot = false;
      }
      if (Array.isArray(json.data.allowedPaymentMethods)) {
        latestAllowedPaymentMethods = json.data.allowedPaymentMethods;
      }
      latestOnlineOnlyLines = onlineOnlyLines(json.data.items);
      updateCartQuantityLimits(json.data, issues, cartStore.get().items);
      renderBuyerUi(json.data.buyerUi, { onChange: refreshBuyerUi });
    }
    setCartValidationIssues(issues, cartStore.get().items, summaryMessage);
    const deliveryRateRefused =
      !response.ok && issues.length === 0 && isDeliveryRateUnavailable(json);
    if (deliveryRateRefused) rejectDeliveryRate(refusedDeliveryRates(json));
    const locationGone = !response.ok && issues.length === 0 ? unavailableDeliveryLocation(json) : null;
    if (locationGone) rejectDeliveryLocation(locationGone);
    if (!response.ok || !json?.success) {
      // A refusal with a reason (4xx) is said as is; an outage gets the store's own wording.
      // A refused rate or a removed thana is said at its own field instead.
      cartValidationGlobalError =
        issues.length > 0 || deliveryRateRefused || locationGone
          ? ""
          : (response.status < 500 ? json?.error || json?.details?.message : "") ||
            activeCheckoutCopy().cartAvailabilityFailedText;
      cartValidationRetryable = Boolean(cartValidationGlobalError) && (response.status >= 500 || response.status === 429);
      if (issues.length === 0) clearCartValidationSummary();
      updateCartValidationMessage();
    }
    if (renderUnchanged || shown() !== shownBefore) await renderCartItems();
    updateCheckoutButtonState();

    if (!response.ok || !json?.success) {
      return false;
    }

    return json.data?.valid !== false && !hasBlockingCartIssues();
  } catch (error) {
    // A newer check (or a page reset) replaced this one; it speaks for itself.
    if (sequence !== cartValidationSequence || controller.signal.aborted) return !hasBlockingCartIssues();
    console.warn("Could not refresh cart availability before checkout.", error);
    cartValidationRetryable = true;
    cartValidationIssues = {};
    validationRuleErrors = [];
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
  cartValidationAbort?.abort();
  if (cartValidationTimer) clearTimeout(cartValidationTimer);
  cartValidationTimer = setTimeout(() => {
    void validateCartSnapshot({ renderUnchanged: false });
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

/**
 * A line's issue, rendered in the same fixed-height slot as its quantity
 * and price controls (the controls row), so an availability answer never
 * changes the line's height. The first issue is shown with its repair
 * action; the full message stays available as the slot's title.
 */
function renderCartItemIssues(cartKey: string): string {
  const issues = cartValidationIssues[cartKey] ?? [];
  const issue = issues[0];
  if (!issue) return "";
  const message = issues.map((entry) => entry.message).join(" ");
  return `<div class="mt-2 flex min-h-11 items-center justify-between gap-2" role="alert" data-cart-line-issue title="${escapeHtml(message)}">
        <p class="line-clamp-2 min-w-0 text-xs font-medium text-destructive">${escapeHtml(issue.message)}</p>
        <div class="shrink-0">${renderIssueAction(cartKey, issue)}</div>
      </div>`;
}

/** Codes that leave a line with nothing a buyer can buy now (sold out, gone, unavailable). */
const UNBUYABLE_ISSUE_CODES = new Set<CartValidationIssue["code"]>([
  "PRODUCT_UNAVAILABLE",
  "VARIANT_UNAVAILABLE",
  "VARIANT_REQUIRED",
  "VARIANT_MISMATCH",
  "FULFILMENT_UNAVAILABLE",
]);

/**
 * The lines an estimate can count: a line the server says can't be bought
 * now (sold out, unavailable) is left out, and a line with fewer units left
 * counts only those. Its offers (a buy-one-get-one) go with it. Checkout
 * still takes nothing until the buyer fixes the line.
 */
export function estimableCartLines(
  items: Record<string, CartItem>,
  issues: Record<string, CartValidationIssue[]>,
): { items: Record<string, CartItem>; leftOut: string[] } {
  const counted: Record<string, CartItem> = {};
  const leftOut: string[] = [];
  for (const [cartKey, item] of Object.entries(items)) {
    const lineIssues = issues[cartKey] ?? [];
    const available = lineIssues.reduce<number | null>((limit, issue) => {
      if (UNBUYABLE_ISSUE_CODES.has(issue.code)) return 0;
      if (issue.code === "QUANTITY_UNAVAILABLE" && typeof issue.availableQuantity === "number") {
        const units = Math.max(0, Math.floor(issue.availableQuantity));
        return limit === null ? units : Math.min(limit, units);
      }
      return limit;
    }, null);
    if (available === 0) {
      leftOut.push(item.name);
      continue;
    }
    counted[cartKey] = available !== null && available < item.quantity ? { ...item, quantity: available } : item;
  }
  return { items: counted, leftOut };
}

/** Says which lines the estimate leaves out, or nothing when it counts them all. */
function renderEstimateNote(leftOut: readonly string[]): void {
  const note = document.getElementById("estimateNote");
  if (!note) return;
  const names = [...new Set(leftOut.map((name) => name.trim()).filter(Boolean))];
  note.textContent = names.length > 0
    ? formatCheckoutLanguageText(activeCheckoutCopy().estimateLeavesOutText, {
        items: formatList(names, numberLocale(pageCheckoutLanguage().code || "en", storeRegion())),
      })
    : "";
  note.classList.toggle("hidden", names.length === 0);
}

/**
 * Totals are always the server's: the authoritative tax quote once a
 * destination is chosen, otherwise the discount preview for the chosen
 * delivery method. Applied codes stay applied through every cart edit.
 */
export async function updateTotals() {
  const quoteSequence = ++cartTaxQuoteSequence;
  const { items: cartItems, discountCodes } = cartStore.get();
  // The estimate counts only what can be bought now (the quote refuses the rest).
  const estimable = estimableCartLines(cartItems, cartValidationIssues);
  const items = estimable.items;
  const totalAmount = cartItemsSubtotal(items);
  const selectedMethod = window.lastShippingEventDetail;
  const pendingShipping = selectedMethod ? hasPendingShippingRate(selectedMethod) : false;
  const shippingFee = selectedMethod
    ? getEffectiveCartShippingFee(items, selectedMethod.fee, selectedMethod.freeOver, selectedMethod.quoted)
    : 0;

  const subtotalEl = document.getElementById("subtotal");
  const shippingEl = document.getElementById("shippingCost");
  const totalEl = document.getElementById("total");
  const expectedQuoteFingerprintInput = document.getElementById(
    "expectedQuoteFingerprint",
  ) as HTMLInputElement | null;

  if (expectedQuoteFingerprintInput) expectedQuoteFingerprintInput.value = "";
  updateCheckoutButtonState();

  if (!subtotalEl || !shippingEl || !totalEl) return;
  const elements: TotalsElements = {
    subtotal: subtotalEl,
    shipping: shippingEl,
    total: totalEl,
    totalLabel: document.getElementById("totalLabel"),
    taxLabel: document.getElementById("taxLabel"),
    taxAmount: document.getElementById("taxAmount"),
    taxStatus: document.getElementById("taxStatus"),
    taxRow: document.getElementById("taxRow"),
  };

  subtotalEl.textContent = formatMoney(totalAmount);
  renderEstimateNote(estimable.leftOut);
  // Before a delivery option applies to the address, shipping isn't known yet.
  const estimateShipping = (discounts: CheckoutDiscountFacts["discounts"]) =>
    renderShippingLine(shippingEl, selectedMethod && !pendingShipping
      ? { baseFee: selectedMethod.fee, charged: shippingFee, discounts }
      : null);
  estimateShipping(latestDiscountFacts?.discounts ?? []);
  renderFreeDeliveryProgress(selectedMethod ? shippingFee : 0, totalAmount);
  elements.taxRow?.classList.add("hidden");
  if (Object.keys(items).length === 0) {
    // Nothing left to buy: the total says so instead of keeping a stale amount.
    if (Object.keys(cartItems).length > 0) totalEl.textContent = formatMoney(0);
    return;
  }

  const renderEstimate = async (failure: string) => {
    const preview = await previewCartDiscounts(
      discountCodes,
      Object.values(items),
      // No delivery option yet: delivery discounts wait for the address instead of failing.
      selectedMethod && !pendingShipping ? shippingFee : undefined,
      formCanonicalPhoneValue() || undefined,
    );
    if (quoteSequence !== cartTaxQuoteSequence) return;
    const discount = preview.ok ? preview.totalDiscount : 0;
    if (preview.ok) estimateShipping(preview.discounts);
    totalEl.textContent = formatMoney(Math.max(0, totalAmount + shippingFee - discount));
    if (elements.totalLabel) elements.totalLabel.textContent = activeCheckoutCopy().estimatedTotalText;
    setTaxStatus(elements, failure || (preview.ok ? "" : activeCheckoutCopy().taxVerificationFailedText));
    renderDiscountFacts(preview.ok ? preview : latestDiscountFacts);
  };

  const quoteInput = cartTaxQuoteInput();
  if (!quoteInput) {
    await renderEstimate("");
    return;
  }

  totalEl.textContent = activeCheckoutCopy().calculatingText;
  try {
    const quote = await fetchAuthoritativeTaxQuote(quoteInput, fetch, QUOTE_RETRY_DELAYS_MS);
    if (quoteSequence !== cartTaxQuoteSequence) return;
    if (expectedQuoteFingerprintInput) {
      expectedQuoteFingerprintInput.value = quote.quoteFingerprint;
    }
    writeReviewedCheckoutQuote(quote);
    setQuoteRuleErrors([]);
    updateCheckoutButtonState();
    renderAuthoritativeCartQuote(quote, elements);
    renderBuyerUi(quote.buyerUi, { onChange: refreshBuyerUi });
  } catch (error) {
    if (quoteSequence !== cartTaxQuoteSequence) return;
    // An item that changed is shown on its line and a refused delivery rate
    // re-reads the address's rates; only a real outage asks for a retry.
    const cartChanged = error instanceof TaxQuoteCartChangedError;
    const rulesRefused = error instanceof TaxQuoteCartRulesError;
    const rateRefused = error instanceof TaxQuoteDeliveryRateError;
    const locationGone = error instanceof TaxQuoteDeliveryLocationError;
    if (cartChanged) {
      const lines = JSON.stringify(cartStore.get().items);
      if (lines !== quoteRefusalRecheckedLines) {
        quoteRefusalRecheckedLines = lines;
        scheduleCartValidation();
      }
    }
    // A store app's rule is said at its line or above the checkout action.
    if (rulesRefused) setQuoteRuleErrors(error.ruleErrors);
    if (rateRefused) rejectDeliveryRate(error.shippingRates ?? null);
    if (locationGone) rejectDeliveryLocation(error.field);
    await renderEstimate(cartChanged || rulesRefused || rateRefused || locationGone ? "" : activeCheckoutCopy().taxVerificationFailedText);
    updateCheckoutButtonState();
  }
}

/** The quote's rules changed: say so on the lines and above the checkout action. */
function setQuoteRuleErrors(next: CartRuleError[]): void {
  if (JSON.stringify(next) === JSON.stringify(quoteRuleErrors)) return;
  quoteRuleErrors = next;
  const lineRules = JSON.stringify(groupCartRuleErrors(cartRuleErrors(), cartStore.get().items).lines);
  // Only the lines repaint (no new quote); the totals already have this answer.
  if (lineRules !== paintedLineRuleErrors) paintCartLines();
  updateCartValidationMessage();
  updateCheckoutButtonState();
}

function renderCartLine(
  cartKey: string,
  item: VariantCartItem,
  position: number,
  ruleErrors: CartRuleError[],
  /** Some lines ship and some don't: the ones that don't say so. */
  mixed = false,
): string {
  const rawName = item.name || "";
  const safeName = escapeHtml(rawName);
  const safeImage = escapeHtml(getProductImageUrl(item.image, 96));
  const jsCartKey = inlineJsString(cartKey);
  const copy = activeCheckoutCopy();
  const options = normalizeCartItemOptions(item.options) ?? [];
  const issueBlock = renderCartItemIssues(cartKey);
  // A store app's rule about this line: under its controls, which name it for assistive technology.
  const ruleErrorsId = cartLineRuleErrorsId(position);
  const ruleBlock = renderCartLineRuleErrors(ruleErrors, ruleErrorsId);
  const describedBy = ruleBlock ? ` aria-describedby="${ruleErrorsId}"` : "";
  const quantityKnown = Object.prototype.hasOwnProperty.call(
    cartQuantityLimits,
    cartKey,
  );
  const quantityLimit = cartQuantityLimits[cartKey];
  const atLimit = typeof quantityLimit === "number" && item.quantity >= quantityLimit;
  const increaseDisabled = !quantityKnown || atLimit;
  const increaseLabel = escapeHtml(formatCheckoutLanguageText(
    !quantityKnown
      ? copy.checkingAvailableQuantityText
      : atLimit
        ? copy.maximumAvailableQuantityText
        : copy.increaseQuantityText,
    { item: rawName },
  ));
  const variantInfo = options
    .map((option) => `<span class="block">${escapeHtml(option.name)}: ${escapeHtml(option.label)}</span>`)
    .join("") + renderCartLineProperties(item, {
      surchargeText: copy.customizationSurchargeText,
      editText: copy.editLineText,
      editLabelText: copy.editLineLabelText,
      jsCartKey,
    }) + (mixed && (item.fulfillmentKind === "digital" || item.fulfillmentKind === "service")
      ? `<span class="block" data-cart-line-fulfilment>${escapeHtml(item.fulfillmentKind === "digital" ? copy.cartLineDigitalText : copy.cartLineServiceText)}</span>`
      : "");
  const stepperButton =
    "flex h-full w-11 items-center justify-center text-sm text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent sm:w-9";

  return `
      <li class="py-3 first:pt-0"><div class="flex gap-3">
          <div class="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-muted sm:h-20 sm:w-20"><img src="${safeImage}" alt="" width="80" height="80" loading="lazy" decoding="async" class="h-full w-full object-contain object-center" /></div>
          <div class="min-w-0 flex-1">
            <div class="flex justify-between gap-2">
              <div class="min-w-0"><h3 class="line-clamp-2 text-sm font-medium text-foreground sm:text-base">${safeName}</h3><div class="mt-0.5 text-sm text-muted-foreground">${variantInfo}</div></div>
              <button type="button" aria-label="${escapeHtml(formatCheckoutLanguageText(copy.removeFromCartText, { item: rawName }))}"${describedBy} class="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:h-9 sm:w-9" onclick="window.removeFromCart(${jsCartKey})"><svg aria-hidden="true" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 18L18 6M6 6l12 12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            </div>
            ${issueBlock || `<div class="mt-2 flex min-h-11 items-center justify-between gap-2">
              <div class="flex h-11 items-center overflow-hidden rounded-md ring-1 ring-inset ring-border sm:h-9">
                <button type="button" aria-label="${escapeHtml(formatCheckoutLanguageText(copy.decreaseQuantityText, { item: rawName }))}"${describedBy} class="${stepperButton}" onclick="window.updateCartQuantity(${jsCartKey}, ${Math.max(0, item.quantity - 1)})">−</button>
                <span class="flex h-full w-8 items-center justify-center text-center text-sm tabular-nums text-foreground" aria-live="polite">${item.quantity}</span>
                <button type="button" aria-label="${increaseLabel}"${describedBy} ${increaseDisabled ? "disabled" : ""} class="${stepperButton}" onclick="window.updateCartQuantity(${jsCartKey}, ${item.quantity + 1})">+</button>
              </div>
              <div class="text-end"><div class="text-sm font-medium tabular-nums text-foreground sm:text-base">${formatMoney(item.price * item.quantity)}</div>${item.quantity > 1 ? `<div class="text-sm tabular-nums text-muted-foreground">${formatMoney(item.price)} ${escapeHtml(copy.eachText)}</div>` : ""}</div>
            </div>`}
            ${ruleBlock}
          </div>
        </div></li>`;
}

/** The lines, each with its availability issue and any store app rule about it. */
function paintCartLines(): void {
  const container = document.getElementById("cartItems");
  const { items } = cartStore.get();
  if (!container || Object.keys(items).length === 0) return;
  const lineRules = groupCartRuleErrors(cartRuleErrors(), items).lines;
  paintedLineRuleErrors = JSON.stringify(lineRules);
  // A cart that ships some lines says which ones don't (the receipt groups them the same way).
  const mixed = cartNeedsDeliveryMethod(items)
    && Object.values(items).some((item) => item.fulfillmentKind === "digital" || item.fulfillmentKind === "service");
  container.innerHTML = `<ul class="divide-y divide-border">${Object.entries(items)
    .map(([cartKey, item], position) => renderCartLine(cartKey, item, position, lineRules[cartKey] ?? [], mixed))
    .join("")}</ul>`;
}

export async function renderCartItems() {
  const lang = pageCheckoutLanguage();
  const cartItemsContainer = document.getElementById("cartItems");
  const cartItemsInput = document.getElementById(
    "cartItemsInput",
  ) as HTMLInputElement;

  if (!cartItemsContainer || !cartItemsInput) return;

  const { items } = cartStore.get();
  cartItemsInput.value =
    Object.keys(items).length > 0 ? JSON.stringify(items) : "{}";

  if (Object.keys(items).length === 0) {
    const pendingCheckout = pendingCheckoutForThisTab();
    renderEmptyCartState(
      cartItemsContainer,
      lang,
      pendingCheckout
        ? {
            href: pendingCheckout.href,
          }
        : null,
    );
    renderDiscountFacts(null);
    syncCartPagePresentation(true);
    return;
  }
  renderCheckoutRecoveryNotice();

  paintCartLines();
  await updateTotals();
  syncCartPagePresentation(true);
}

/**
 * Re-reads the page's payment facts after the cart page changes them (the
 * buyer chose the gift-card step, so a cart cash cannot pay is no longer
 * blocked here: the payment step prices it).
 */
export function refreshCartBlockingState() {
  updateCartValidationMessage();
  updateCheckoutButtonState();
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
  const cartReady =
    document.getElementById("cartPageRoot")?.dataset.cartReady !== "false";
  const isEmpty = Object.keys(cartStore.get().items).length === 0;
  const copy = activeCheckoutCopy();
  applyCheckoutButtonState(submitButton, {
    checkoutUnavailable,
    unavailableMessage,
    isEmpty: isEmpty || !cartReady,
    emptyMessage: copy.cartEmptyErrorText,
    cartBlocked: hasBlockingCartIssues(),
    cartBlockedMessage: cartBlockedMessage(),
    cartAttentionMessage: copy.cartAttentionText,
    cartRulesBlocked: hasCartRuleErrors(),
    cartRulesBlockedMessage: copy.cartRulesBlockedText,
    checkoutPending: pendingCheckoutForThisTab() !== null,
    checkoutPendingMessage: copy.existingCheckoutTitle,
    discountValidationPending: isDiscountValidationPending(),
    discountValidationPendingMessage: copy.processingText,
    reasonElement: document.getElementById("submitButtonReason"),
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
    const event = {
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
    };
    withAnalytics((analytics) => analytics.trackFbInitiateCheckout(event));

    hasTrackedInitiateCheckout = true;
  }
}

// --- Discount Logic ---
const DISCOUNT_CODE_INPUT = /^[A-Z0-9_-]{1,50}$/;

/**
 * Checks a new code together with the codes already applied. A code the
 * buyer can still qualify for (a minimum, a missing free item, a phone) is
 * kept and shown as pending; a code that can never apply is refused.
 */
async function handleApplyDiscount() {
  const codeInput = document.getElementById(
    "discountCodeInput",
  ) as HTMLInputElement;
  const copy = activeCheckoutCopy();
  const code = codeInput.value.trim().toUpperCase();
  codeInput.value = code;
  if (!code) {
    showDiscountMessage(copy.enterDiscountCodeText, "error");
    return;
  }
  if (!DISCOUNT_CODE_INPUT.test(code)) {
    showDiscountMessage(copy.invalidDiscountCodeText, "error");
    return;
  }
  const { items, discountCodes } = cartStore.get();
  if (Object.keys(items).length === 0) {
    showDiscountMessage(copy.emptyCartText, "error");
    return;
  }
  if (discountCodes.includes(code)) {
    showDiscountMessage(formatCheckoutLanguageText(copy.discountAlreadyAppliedText, { code }), "error");
    return;
  }
  if (isDiscountValidationPending()) return;

  const requestSequence = ++discountValidationSequence;
  pendingDiscountValidation = requestSequence;
  clearDiscountMessage();
  setApplyButtonPending(true);
  notifyDiscountValidationState();

  try {
    const preview = await previewCartDiscounts(
      [...discountCodes, code],
      Object.values(items),
      window.lastShippingEventDetail
        ? getEffectiveCartShippingFee(
            items,
            window.lastShippingEventDetail.fee,
            window.lastShippingEventDetail.freeOver,
            window.lastShippingEventDetail.quoted,
          )
        : undefined,
      formCanonicalPhoneValue() || undefined,
    );
    if (pendingDiscountValidation !== requestSequence) return;
    if (!preview.ok) {
      showDiscountMessage(preview.message || copy.discountApplyFailedText, "error");
      return;
    }
    const rejection = preview.rejectedCodes.find((candidate) => candidate.code === code);
    // A code the bundle saving beats is kept: it wins again if the cart changes.
    if (rejection && !isPendingCodeReason(rejection.reason) && !rejection.bundleSavesMore) {
      showDiscountMessage(describeRejectedCode(rejection, copy), "error");
      return;
    }
    codeInput.value = "";
    addDiscountCode(code);
    if (rejection) {
      // A kept code that adds nothing now says why under the code itself.
      showDiscountMessage("", "success");
      if (rejection.requiresCustomerPhone) {
        document.getElementById("customerPhone-input")?.focus();
      }
    } else {
      showDiscountMessage(formatCheckoutLanguageText(copy.discountAppliedText, { code }), "success");
    }
  } finally {
    if (pendingDiscountValidation === requestSequence) {
      pendingDiscountValidation = null;
      setApplyButtonPending(false);
      notifyDiscountValidationState();
    }
  }
}

// --- Undo for removals ---

/** "Item removed · Undo" for 10 seconds, instead of a silent removal. */
function offerUndo(message: string, snapshot: ReturnType<typeof cartStore.get>): void {
  const status = document.getElementById("cartUndo");
  if (!status) return;
  if (undoTimer !== null) clearTimeout(undoTimer);
  status.replaceChildren(document.createTextNode(`${message} · `));
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "font-medium text-foreground underline underline-offset-2";
  undo.textContent = activeCheckoutCopy().undoText;
  undo.addEventListener("click", () => {
    restoreCart(snapshot);
    hideUndo();
  });
  status.append(undo);
  status.hidden = false;
  undoTimer = setTimeout(hideUndo, 10_000);
}

function hideUndo(): void {
  const status = document.getElementById("cartUndo");
  if (status) {
    status.hidden = true;
    status.replaceChildren();
  }
  if (undoTimer !== null) clearTimeout(undoTimer);
  undoTimer = null;
}

function removeLineWithUndo(cartKey: string): void {
  const snapshot = cartStore.get();
  const item = snapshot.items[cartKey];
  if (!item || !removeCartItemByKey(cartKey)) return;
  offerUndo(formatCheckoutLanguageText(activeCheckoutCopy().itemRemovedText, { item: item.name }), snapshot);
}

// --- Initialization ---
export async function initCartFunctionality() {
  const runtimeSignal = resetCartRuntimeListeners();
  quoteRefusalRecheckedLines = null;
  hydrateCartFromStorage();
  hostedPaymentRecoverySession = readHostedPaymentRecoverySession();
  const expiredCheckoutId = document.getElementById("cartPageRoot")?.dataset.expiredCheckoutId;
  if (expiredCheckoutId) {
    clearExpiredCheckoutAttempt(expiredCheckoutId);
    if (hostedPaymentRecoverySession?.checkoutId === expiredCheckoutId) {
      clearHostedPaymentRecoverySession();
      hostedPaymentRecoverySession = null;
    }
  }
  renderCheckoutRecoveryNotice();
  const recoveryCheck = refreshCheckoutRecovery(runtimeSignal);

  await processQuickBuy();
  syncCheckoutIdInput();

  window.handleAbandonedCheckout = handleAbandonedCheckout;
  window.validateCartSnapshot = validateCartSnapshot;
  window.hasCartValidationIssues = () => hasBlockingCartIssues();
  window.hasCartRuleErrors = () => hasCartRuleErrors();
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
    clearCartValidationSummary();
    if (nextQuantity <= 0) removeLineWithUndo(cartKey);
    else updateCartItemByKey(cartKey, { quantity: nextQuantity });
  };
  window.removeFromCart = (cartKey) => {
    clearCartValidationSummary();
    delete cartQuantityLimits[cartKey];
    removeLineWithUndo(cartKey);
  };
  window.editCartLine = (cartKey) => {
    const item = cartStore.get().items[cartKey];
    if (item) {
      // Session storage, not the URL: the inputs are buyer content.
      writeCartLineEdit({
        lineKey: cartKey,
        productId: item.id,
        variantId: item.variantId,
        quantity: item.quantity,
        properties: cartLinePropertyInputs(item),
      });
    }
    return true;
  };
  window.removeCartIssueItem = (cartKey) => {
    clearCartValidationSummary();
    delete cartValidationIssues[cartKey];
    delete cartQuantityLimits[cartKey];
    removeCartItemByKey(cartKey);
  };
  window.reduceCartIssueItem = (cartKey) => {
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
  let lastItemsJson = JSON.stringify(cartStore.get().items);
  cartStoreUnsubscribe = cartStore.subscribe((state) => {
    // Nanostores invokes subscribers once immediately. Initialization already
    // renders and validates the hydrated cart below, so treating that first
    // observation as a mutation schedules a duplicate serial validation.
    if (!cartSubscriptionIsLive) {
      cartSubscriptionIsLive = true;
      return;
    }
    if (isApplyingCartSnapshot) return;
    const itemsJson = JSON.stringify(state.items);
    const itemsChanged = itemsJson !== lastItemsJson;
    lastItemsJson = itemsJson;
    void renderCartItems();
    updateCheckoutButtonState();
    handleAbandonedCheckout();
    // A code change only needs a new quote; stock needs checking only when lines change.
    if (itemsChanged) {
      clearDiscountSuccessMessage();
      scheduleCartValidation();
    }
  });

  window.addEventListener(
    "shippingLocationChange",
    (e) => {
      const detail = (e as CustomEvent<ShippingMethodDetail | null>).detail;
      window.lastShippingEventDetail = detail ?? undefined;
      void updateTotals();
      handleAbandonedCheckout();
      // A delivery refusal belongs to the previous choice: check the new one.
      if (detail) scheduleCartValidation();
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
      if (latestCheckoutLocation.zoneId) attemptToTrackInitiateCheckout();
      // Totals follow the delivery options, which re-read the rates for this
      // address and announce the choice with `shippingLocationChange`.
      handleAbandonedCheckout();
    },
    { signal: runtimeSignal },
  );

  document.getElementById("discountForm")?.addEventListener(
    "submit",
    (e) => {
      e.preventDefault();
      void handleApplyDiscount();
    },
    { signal: runtimeSignal },
  );
  document.getElementById("discountCodeInput")?.addEventListener(
    "input",
    clearDiscountMessage,
    { signal: runtimeSignal },
  );

  let lastQuotedPhone = formCanonicalPhoneValue();
  document.getElementById("customerPhone-input")?.addEventListener(
    "blur",
    () => {
      attemptToTrackInitiateCheckout();
      // One-use codes are checked against the phone: re-quote when it changes.
      const phone = formCanonicalPhoneValue();
      if (phone !== lastQuotedPhone && cartStore.get().discountCodes.length > 0) {
        void updateTotals();
      }
      lastQuotedPhone = phone;
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

  // Lines paint straight from the saved cart; the availability check's
  // answer lands inside each line's fixed status slot and below the totals,
  // so it never moves painted content (no CLS, no network-gated first paint).
  await renderCartItems();
  if (applyPendingCartRepairState()) {
    await renderCartItems();
  }
  await validateCartSnapshot();
  await recoveryCheck;
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
  renderCheckoutRecoveryNotice();
  const recoveryCheck = refreshCheckoutRecovery(cartRuntimeAbortController?.signal ?? new AbortController().signal);
  syncCheckoutIdInput();
  if (Object.keys(cartStore.get().items).length > 0) {
    await validateCartSnapshot();
  } else {
    await renderCartItems();
  }
  await recoveryCheck;
  updateCheckoutButtonState();
}

// Window augmentations for cart handlers are declared in env.d.ts
