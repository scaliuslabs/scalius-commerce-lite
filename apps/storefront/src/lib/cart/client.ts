// src/lib/cart/client.ts
import {
  cartStore,
  hydrateCartFromStorage,
  addToCart,
  updateQuantity,
  removeFromCart,
  removeCartItemByKey,
  updateCartItemByKey,
  applyDiscount,
  removeDiscount,
  type CartItem,
} from "@/store/cart";
import type { CartValidationIssue, CartValidationResult } from "@/lib/api/orders";
import {
  validateDiscount,
  getActiveCheckoutLanguage,
  type CheckoutLanguageData,
  saveAbandonedCheckout,
} from "@/lib/api";
import { DEFAULT_CURRENCY } from "@scalius/shared/currency";
import { trackFbAddToCart, trackFbInitiateCheckout } from "@/lib/analytics";
import { nanoid } from "nanoid";
import { getProductImageUrl } from "@/lib/product-media";
import { applyCheckoutButtonState } from "./checkout-button-state";
import { renderEmptyCartState } from "./empty-state";
import { renderCartIssueAction } from "./issue-action";
import { readAndClearCartRepairState } from "./repair-state";
import { reconcileValidatedCartSnapshot } from "./validation-reconciliation";

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
let hasTrackedInitiateCheckout = false;
let cartValidationIssues: Record<string, CartValidationIssue[]> = {};
let cartValidationGlobalError = "";
let cartValidationTimer: ReturnType<typeof setTimeout> | null = null;
let cartValidationSequence = 0;

// --- Abandoned Checkout ---
let abandonedCheckoutTimer: ReturnType<typeof setTimeout> | null = null;

function getCheckoutId(): string {
  let checkoutId = sessionStorage.getItem("checkoutId");
  if (!checkoutId) {
    checkoutId = `chk_session_${nanoid()}`;
    sessionStorage.setItem("checkoutId", checkoutId);
  }
  return checkoutId;
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

  data.shipping = window.lastShippingEventDetail;

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
    languageData: {
      pageTitle: "Cart & Checkout",
      checkoutSectionTitle: "Checkout Information",
      cartSectionTitle: "Shopping Cart",
      customerNameLabel: "Full Name",
      customerNamePlaceholder: "Enter your full name",
      customerPhoneLabel: "Phone Number",
      customerPhonePlaceholder: "Phone number",
      customerPhoneHelp: "Enter your phone number with country code",
      customerEmailLabel: "Email (Optional)",
      customerEmailPlaceholder: "Enter your email address",
      shippingAddressLabel: "Delivery Address",
      shippingAddressPlaceholder: "Enter your full delivery address",
      cityLabel: "City",
      zoneLabel: "Zone",
      areaLabel: "Area (Optional)",
      shippingMethodLabel: "Choose Delivery Option",
      orderNotesLabel: "Order Notes (Optional)",
      orderNotesPlaceholder: "Any special instructions for your order?",
      continueShoppingText: "Continue Shopping",
      subtotalText: "Subtotal",
      shippingText: "Shipping",
      discountText: "Discount",
      totalText: "Total",
      discountCodePlaceholder: "Discount code",
      applyDiscountText: "Apply",
      removeDiscountText: "Remove",
      placeOrderText: "Place Order",
      processingText: "Processing...",
      emptyCartText: "Your cart is empty",
      termsText:
        "By placing this order, you agree to our Terms of Service and Privacy Policy",
      processingOrderTitle: "Processing Your Order",
      processingOrderMessage: "Please wait while we process your order.",
      requiredFieldIndicator: "*",
    },
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
        addToCart(data.cartItem);

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
    const sym = window.__CURRENCY_SYMBOL__ || DEFAULT_CURRENCY.symbol;
    discountAmountEl.textContent = `-${sym}${(discount.discountAmount || 0).toLocaleString()}`;
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
  const parts = [item.size, item.color].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" / ") : null;
}

function cartValidationPayload(items: Record<string, CartItem>) {
  return Object.entries(items).map(([cartKey, item]) => ({
    cartKey,
    productId: item.id,
    variantId: item.variantId && item.variantId !== "default" ? item.variantId : null,
    quantity: item.quantity,
    price: item.price,
    productName: item.name,
    variantLabel: cartItemVariantLabel(item),
  }));
}

function formStringValue(name: string): string | null {
  if (typeof document === "undefined") return null;
  const input = document.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
  const value = input?.value?.trim();
  return value ? value : null;
}

function cartValidationDeliveryPayload() {
  const city = formStringValue("city");
  const zone = formStringValue("zone");
  if (!city || !zone) return {};

  const meta = document.getElementById("checkout-meta");
  const shippingMethodId = window.lastShippingEventDetail?.id
    ?? meta?.dataset.defaultShippingId
    ?? null;

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
  if (issue.cartKey && items[issue.cartKey]) return issue.cartKey;

  const match = Object.entries(items).find(([, item], index) => {
    const itemVariant = item.variantId && item.variantId !== "default" ? item.variantId : null;
    return (
      index === issue.index ||
      (item.id === issue.productId && itemVariant === issue.variantId)
    );
  });

  return match?.[0] ?? null;
}

function setCartValidationIssues(
  issues: CartValidationIssue[],
  items: Record<string, CartItem>,
) {
  cartValidationGlobalError = "";
  const grouped: Record<string, CartValidationIssue[]> = {};
  for (const issue of issues) {
    const key = issueKeyForCart(issue, items);
    if (!key) continue;
    grouped[key] = [...(grouped[key] ?? []), issue];
  }
  cartValidationIssues = grouped;
  updateCartValidationMessage();
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
  return count === 1
    ? "One cart item needs attention before checkout."
    : `${count} cart items need attention before checkout.`;
}

function updateCartValidationMessage() {
  const message = document.getElementById("cartValidationMessage");
  if (!message) return;

  if (hasBlockingCartIssues()) {
    message.textContent = cartBlockedMessage();
    message.classList.remove("hidden");
  } else {
    message.textContent = "";
    message.classList.add("hidden");
  }
}

function applyPendingCartRepairState(): boolean {
  const state = readAndClearCartRepairState();
  if (!state) return false;

  if (state.issues.length > 0) {
    setCartValidationIssues(state.issues, cartStore.get().items);
  } else {
    cartValidationIssues = {};
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
    const json = await response.json().catch(() => null) as {
      success?: boolean;
      error?: string;
      data?: CartValidationResult;
      details?: { itemIssues?: CartValidationIssue[]; message?: string };
    } | null;

    if (sequence !== cartValidationSequence) {
      return !hasBlockingCartIssues();
    }

    const issues = json?.data?.issues ?? json?.details?.itemIssues ?? [];
    if (response.ok && json?.success && json.data) {
      reconcileValidatedCartSnapshot(json.data, (message) => {
        showDiscountMessage(message, "info");
      });
    }
    setCartValidationIssues(Array.isArray(issues) ? issues : [], cartStore.get().items);
    if (!response.ok || !json?.success) {
      cartValidationGlobalError = issues.length > 0
        ? ""
        : json?.error
          || json?.details?.message
          || "Could not verify cart availability. Please refresh and try again.";
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
    cartValidationGlobalError = "Could not verify cart availability. Please refresh and try again.";
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

export function renderIssueAction(cartKey: string, issue: CartValidationIssue): string {
  return renderCartIssueAction(cartKey, issue, cartStore.get().items[cartKey]?.slug);
}

function renderCartItemIssues(cartKey: string): string {
  const issues = cartValidationIssues[cartKey] ?? [];
  if (issues.length === 0) return "";

  return `<div class="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive space-y-1">${issues
    .map((issue) => (
      `<div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <span>${escapeHtml(issue.message)}</span>
        ${renderIssueAction(cartKey, issue)}
      </div>`
    ))
    .join("")}</div>`;
}

export async function updateTotals() {
  const { items, totalAmount, discount } = cartStore.get();

  // Check if any item in the cart has free delivery
  const hasFreeDeliveryItem = Object.values(items).some(
    (item) => item.freeDelivery,
  );

  let shippingFee = window.lastShippingEventDetail?.fee ?? 0;

  // If there's a free delivery item, the shipping cost for the entire order is 0.
  if (hasFreeDeliveryItem) {
    shippingFee = 0;
  }

  const subtotalEl = document.getElementById("subtotal");
  const shippingEl = document.getElementById("shippingCost");
  const totalEl = document.getElementById("total");
  const discountHiddenInput = document.getElementById(
    "discountCodeHidden",
  ) as HTMLInputElement;

  if (!subtotalEl || !shippingEl || !totalEl || !discountHiddenInput) return;

  const sym = window.__CURRENCY_SYMBOL__ || DEFAULT_CURRENCY.symbol;
  subtotalEl.textContent = `${sym}${totalAmount.toLocaleString()}`;
  shippingEl.textContent =
    hasFreeDeliveryItem && shippingFee === 0
      ? "Free"
      : `${sym}${shippingFee.toLocaleString()}`;

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

  totalEl.textContent = `${sym}${Math.max(0, finalTotal).toLocaleString()}`;
  updateDiscountUI();
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
    renderEmptyCartState(cartItemsContainer, lang);
    return;
  }

  const csym = window.__CURRENCY_SYMBOL__ || DEFAULT_CURRENCY.symbol;
  cartItemsContainer.innerHTML = Object.entries(items)
    .map(([cartKey, item]) => {
      // Escape all user-supplied strings to prevent XSS via innerHTML
      const safeName = escapeHtml(item.name || "");
      const safeImage = escapeHtml(
        getProductImageUrl(item.image, {
          width: 96,
          height: 96,
          quality: 75,
          format: "auto",
          fit: "cover",
        }),
      );
      const jsId = inlineJsString(item.id || "");
      const jsVariantId = inlineJsString(item.variantId || "");
      const safeSize = item.size ? escapeHtml(item.size) : "";
      const safeColor = item.color ? escapeHtml(item.color) : "";
      const issueBlock = renderCartItemIssues(cartKey);

      const variantInfo =
        safeSize || safeColor
          ? `<div class="space-x-1">${safeSize ? `<span>Size: ${safeSize}</span>` : ""}${safeSize && safeColor ? "<span>•</span>" : ""}${safeColor ? `<span>Color: ${safeColor}</span>` : ""}</div>`
          : "";

      return `
      <div class="py-2.5 sm:py-3 first:pt-0"><div class="flex gap-2.5 sm:gap-3">
          <div class="w-16 h-16 sm:w-20 sm:h-20 bg-muted rounded-lg overflow-hidden shrink-0"><img src="${safeImage}" alt="${safeName}" class="w-full h-full object-cover" /></div>
          <div class="flex-1 min-w-0">
            <div class="flex justify-between">
              <div class="min-w-0"><h3 class="font-medium truncate text-sm sm:text-base text-foreground">${safeName}</h3><div class="text-xs sm:text-sm text-muted-foreground mt-0.5 sm:mt-1">${variantInfo}</div></div>
              <button class="text-muted-foreground hover:text-destructive transition-colors ml-1.5 sm:ml-2 p-0.5" onclick="window.removeFromCart(${jsId}, ${jsVariantId})"><svg class="w-4 h-4 sm:w-5 sm:h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 18L18 6M6 6l12 12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            </div>
            <div class="flex items-center justify-between mt-1.5 sm:mt-2">
              <div class="flex items-center gap-1.5 sm:gap-2">
                <button class="w-6 h-6 sm:w-7 sm:h-7 rounded-md sm:rounded-lg ring-1 sm:ring-2 ring-border flex items-center justify-center hover:bg-muted text-xs sm:text-sm text-foreground" onclick="window.updateCartQuantity(${jsId}, ${jsVariantId}, ${Math.max(0, item.quantity - 1)})">-</button>
                <span class="w-5 sm:w-6 text-center text-xs sm:text-sm text-foreground">${item.quantity}</span>
                <button class="w-6 h-6 sm:w-7 sm:h-7 rounded-md sm:rounded-lg ring-1 sm:ring-2 ring-border flex items-center justify-center hover:bg-muted text-xs sm:text-sm text-foreground" onclick="window.updateCartQuantity(${jsId}, ${jsVariantId}, ${item.quantity + 1})">+</button>
              </div>
              <div class="text-right"><div class="font-medium text-sm sm:text-base text-foreground">${csym}${(item.price * item.quantity).toLocaleString()}</div><div class="text-xs text-muted-foreground">${csym}${item.price.toLocaleString()} each</div></div>
            </div>
            ${issueBlock}
          </div>
        </div></div>`;
    })
    .join("");

  await updateTotals();
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
    "Checkout is temporarily unavailable. Please try again shortly.";
  const isEmpty = Object.keys(cartStore.get().items).length === 0;
  applyCheckoutButtonState(submitButton, {
    checkoutUnavailable,
    unavailableMessage,
    isEmpty,
    cartBlocked: hasBlockingCartIssues(),
    cartBlockedMessage: cartBlockedMessage(),
  });
}

// --- Analytics & Event Tracking ---
function attemptToTrackInitiateCheckout() {
  if (hasTrackedInitiateCheckout) return;

  const { items, totalAmount } = cartStore.get();
  const customerPhoneInput = document.getElementById(
    "customerPhone",
  ) as HTMLInputElement;
  const phone = customerPhoneInput?.value;
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
    showDiscountMessage("Please enter a discount code", "error");
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
    showDiscountMessage("Please remove the current discount first.", "error");
    return;
  }

  const customerPhoneInput = document.getElementById(
    "customerPhone",
  ) as HTMLInputElement;
  const customerPhone = customerPhoneInput?.value;
  if (!customerPhone || customerPhone.trim().length < 7) {
    showDiscountMessage(
      "Please enter a valid phone number before applying a discount.",
      "info",
    );
    customerPhoneInput.focus();
    return;
  }

  const applyBtn = document.getElementById(
    "applyDiscountBtn",
  ) as HTMLButtonElement;
  applyBtn.textContent = lang.languageData.processingText;
  applyBtn.disabled = true;

  try {
    const shippingCost = window.lastShippingEventDetail?.fee ?? 0;
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
      showDiscountMessage("Discount applied successfully!", "success");
    } else {
      showDiscountMessage(result?.error || "Invalid discount code", "error");
    }
  } catch (error: unknown) {
    console.error("Error applying discount:", error);
    showDiscountMessage("Failed to apply discount. Please try again.", "error");
  } finally {
    applyBtn.textContent = lang.languageData.applyDiscountText;
    applyBtn.disabled = false;
  }
}

function handleRemoveDiscount() {
  removeDiscount();
  showDiscountMessage("Discount removed.", "success");
}

// --- Initialization ---
export async function initCartFunctionality() {
  hydrateCartFromStorage();

  // ── Read server-rendered shipping defaults ────────────────────────────────
  // Eliminates the race condition: this runs before React hydration, ensuring
  // window.lastShippingEventDetail is always set for the first updateTotals().
  if (!window.lastShippingEventDetail) {
    const meta = document.getElementById("checkout-meta");
    const defaultId = meta?.dataset.defaultShippingId;
    const defaultFee = meta?.dataset.defaultShippingFee;
    if (defaultId) {
      window.lastShippingEventDetail = {
        id: defaultId,
        fee: parseInt(defaultFee || "0", 10),
      };
    }
  }

  // Clear any stale discount on page load — customers must re-apply at checkout
  if (cartStore.get().discount) {
    cartStore.setKey("discount", null);
  }

  // --- MODIFIED: Call the new quick buy processor first ---
  processQuickBuy();

  // Populate the hidden checkoutId input field
  const checkoutIdInput = document.getElementById(
    "checkoutIdInput",
  ) as HTMLInputElement;
  if (checkoutIdInput) {
    checkoutIdInput.value = getCheckoutId();
  }

  window.handleAbandonedCheckout = handleAbandonedCheckout;
  window.validateCartSnapshot = validateCartSnapshot;
  window.hasCartValidationIssues = () => hasBlockingCartIssues();
  window.getCartBlockedMessage = () => cartBlockedMessage();

  window.updateCartQuantity = (id, variantId, qty) =>
    updateQuantity(id, variantId || undefined, qty);
  window.removeFromCart = (id, variantId) =>
    removeFromCart(id, variantId || undefined);
  window.removeCartIssueItem = (cartKey) => {
    delete cartValidationIssues[cartKey];
    removeCartItemByKey(cartKey);
  };
  window.reduceCartIssueItem = (cartKey) => {
    const issue = (cartValidationIssues[cartKey] ?? []).find(
      (item) => item.action === "reduce_quantity",
    );
    if (typeof issue?.availableQuantity !== "number" || issue.availableQuantity < 1) {
      removeCartItemByKey(cartKey);
      return;
    }
    updateCartItemByKey(cartKey, { quantity: issue.availableQuantity });
  };
  window.refreshCartIssueItem = (cartKey) => {
    const issue = (cartValidationIssues[cartKey] ?? []).find(
      (item) => item.action === "refresh_item",
    );
    if (typeof issue?.currentPrice !== "number") return;
    updateCartItemByKey(cartKey, {
      price: issue.currentPrice,
      name: issue.productName || undefined,
    });
  };

  cartStore.subscribe(() => {
    renderCartItems();
    updateTotals();
    updateCheckoutButtonState();
    handleAbandonedCheckout();
    scheduleCartValidation();
  });

  window.addEventListener("shippingLocationChange", (e) => {
    window.lastShippingEventDetail = (e as CustomEvent).detail;
    // Reset discount when delivery option changes
    if (cartStore.get().discount) {
      removeDiscount();
      showDiscountMessage(
        "Discount removed — delivery option changed.",
        "info",
      );
    }
    updateTotals();
    handleAbandonedCheckout();
  });

  document.addEventListener("zone-selected", () => {
    attemptToTrackInitiateCheckout();
    handleAbandonedCheckout();
  });

  document.getElementById("discountForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    handleApplyDiscount();
  });

  document.getElementById("customerPhone")?.addEventListener("blur", () => {
    attemptToTrackInitiateCheckout();
  });

  document
    .getElementById("removeDiscountBtn")
    ?.addEventListener("click", handleRemoveDiscount);

  await getLanguageData();
  await renderCartItems();
  if (applyPendingCartRepairState()) {
    await renderCartItems();
  }
  await validateCartSnapshot();
  updateTotals();
  updateCheckoutButtonState();
}

// Window augmentations for cart handlers are declared in env.d.ts
