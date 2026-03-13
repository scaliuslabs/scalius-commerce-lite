// src/lib/cart/client.ts
import {
  cartStore,
  addToCart,
  updateQuantity,
  removeFromCart,
  applyDiscount,
  removeDiscount,
} from "@/store/cart";
import {
  validateDiscount,
  getActiveCheckoutLanguage,
  type CheckoutLanguageData,
  saveAbandonedCheckout,
} from "@/lib/api";
import { trackFbAddToCart, trackFbInitiateCheckout } from "@/lib/analytics";
import { nanoid } from "nanoid";

let globalLangData: CheckoutLanguageData | null = null;
let hasTrackedInitiateCheckout = false;

// --- Abandoned Checkout ---
let abandonedCheckoutTimer: any = null;

function getCheckoutId(): string {
  let checkoutId = sessionStorage.getItem("checkoutId");
  if (!checkoutId) {
    checkoutId = `chk_session_${nanoid()}`;
    sessionStorage.setItem("checkoutId", checkoutId);
  }
  return checkoutId;
}

function getCheckoutFormData(): Record<string, any> {
  const form = document.getElementById("checkoutForm") as HTMLFormElement;
  if (!form) return {};

  const formData = new FormData(form);
  const data: Record<string, any> = {};
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
  console.log("[client.ts] handleAbandonedCheckout called.");
  clearTimeout(abandonedCheckoutTimer);
  abandonedCheckoutTimer = setTimeout(() => {
    console.log("[client.ts] Debounced save running...");
    const checkoutData = getCheckoutFormData();
    if (!checkoutData.cart || checkoutData.cart.items.length === 0) {
      console.log("[client.ts] Aborting save: cart is empty.");
      return;
    }

    const payload = {
      checkoutId: getCheckoutId(),
      customerPhone: checkoutData.customerPhone,
      checkoutData: checkoutData,
    };
    console.log("[client.ts] Sending abandoned checkout payload:", payload);
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
  } catch (error) {
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
      customerPhonePlaceholder: "01XXXXXXXXX",
      customerPhoneHelp: "Example: 01712345678",
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
        const dynamicCurrency = (window as any).__CURRENCY_CODE__ || "BDT";
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
  } catch (e) {
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
    const sym = (window as any).__CURRENCY_SYMBOL__ || "৳";
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

  const sym = (window as any).__CURRENCY_SYMBOL__ || "৳";
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
    cartItemsContainer.innerHTML = `
      <div class="text-center py-8 px-4">
        <svg class="mx-auto h-12 w-12 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
        <h3 class="mt-2 text-lg font-medium text-foreground">${lang.languageData.emptyCartText}</h3>
        <p class="mt-1 text-sm text-muted-foreground">Looks like you haven't added anything to your cart yet.</p>
        <div class="mt-6"><a href="/" class="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-primary-foreground bg-primary hover:bg-primary/90"><svg class="-ml-1 mr-2 h-5 w-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M9.707 14.707a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 1.414L7.414 9H15a1 1 0 110 2H7.414l2.293 2.293a1 1 0 010 1.414z" clip-rule="evenodd" /></svg>${lang.languageData.continueShoppingText}</a></div>
      </div>`;
    return;
  }

  const csym = (window as any).__CURRENCY_SYMBOL__ || "৳";
  cartItemsContainer.innerHTML = Object.values(items)
    .map(
      (item) => `
      <div class="py-2.5 sm:py-3 first:pt-0"><div class="flex gap-2.5 sm:gap-3">
          <div class="w-16 h-16 sm:w-20 sm:h-20 bg-muted rounded-lg overflow-hidden shrink-0"><img src="${item.image || "/placeholder.jpg"}" alt="${item.name}" class="w-full h-full object-cover" /></div>
          <div class="flex-1 min-w-0">
            <div class="flex justify-between">
              <div class="min-w-0"><h3 class="font-medium truncate text-sm sm:text-base text-foreground">${item.name}</h3><div class="text-xs sm:text-sm text-muted-foreground mt-0.5 sm:mt-1">${item.size || item.color ? `<div class="space-x-1">${item.size ? `<span>Size: ${item.size}</span>` : ""}${item.size && item.color ? "<span>•</span>" : ""}${item.color ? `<span>Color: ${item.color}</span>` : ""}</div>` : ""}</div></div>
              <button class="text-muted-foreground hover:text-destructive transition-colors ml-1.5 sm:ml-2 p-0.5" onclick="window.removeFromCart('${item.id}', '${item.variantId || ""}')"><svg class="w-4 h-4 sm:w-5 sm:h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 18L18 6M6 6l12 12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            </div>
            <div class="flex items-center justify-between mt-1.5 sm:mt-2">
              <div class="flex items-center gap-1.5 sm:gap-2">
                <button class="w-6 h-6 sm:w-7 sm:h-7 rounded-md sm:rounded-lg ring-1 sm:ring-2 ring-border flex items-center justify-center hover:bg-muted text-xs sm:text-sm text-foreground" onclick="window.updateCartQuantity('${item.id}', '${item.variantId || ""}', ${Math.max(0, item.quantity - 1)})">-</button>
                <span class="w-5 sm:w-6 text-center text-xs sm:text-sm text-foreground">${item.quantity}</span>
                <button class="w-6 h-6 sm:w-7 sm:h-7 rounded-md sm:rounded-lg ring-1 sm:ring-2 ring-border flex items-center justify-center hover:bg-muted text-xs sm:text-sm text-foreground" onclick="window.updateCartQuantity('${item.id}', '${item.variantId || ""}', ${item.quantity + 1})">+</button>
              </div>
              <div class="text-right"><div class="font-medium text-sm sm:text-base text-foreground">${csym}${(item.price * item.quantity).toLocaleString()}</div><div class="text-xs text-muted-foreground">${csym}${item.price.toLocaleString()} each</div></div>
            </div>
          </div>
        </div></div>`,
    )
    .join("");

  await updateTotals();
}

function updateCheckoutButtonState() {
  const submitButton = document.getElementById(
    "submitButton",
  ) as HTMLButtonElement;
  if (!submitButton) return;
  const isEmpty = Object.keys(cartStore.get().items).length === 0;
  submitButton.disabled = isEmpty;
  submitButton.classList.toggle("opacity-50", isEmpty);
  submitButton.classList.toggle("cursor-not-allowed", isEmpty);
  submitButton.title = isEmpty ? "Your cart is empty" : "";
}

// --- Analytics & Event Tracking ---
function attemptToTrackInitiateCheckout() {
  if (hasTrackedInitiateCheckout) return;

  const { items, totalAmount } = cartStore.get();
  const customerPhoneInput = document.getElementById(
    "customerPhone",
  ) as HTMLInputElement;
  const phone = customerPhoneInput?.value;
  const isPhoneValid =
    phone && /^01[3-9]\d{8}$/.test(phone.replace(/^\+?88/, ""));

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
      currency: (window as any).__CURRENCY_CODE__ || "BDT",
      num_items: Object.values(items).reduce(
        (sum, item) => sum + item.quantity,
        0,
      ),
      value: totalAmount,
    });

    hasTrackedInitiateCheckout = true;
    console.log("CAPI: InitiateCheckout event tracked.");
  }
}

// --- Discount Logic ---
async function handleApplyDiscount() {
  const lang = await getLanguageData();
  const codeInput = document.getElementById(
    "discountCodeInput",
  ) as HTMLInputElement;
  const code = codeInput.value.trim();
  if (!code) {
    showDiscountMessage("Please enter a discount code", "error");
    return;
  }

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
  if (
    !customerPhone ||
    !/^01[3-9]\d{8}$/.test(customerPhone.replace(/^\+?88/, ""))
  ) {
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
  } catch (error) {
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

  window.updateCartQuantity = (id, variantId, qty) =>
    updateQuantity(id, variantId || undefined, qty);
  window.removeFromCart = (id, variantId) =>
    removeFromCart(id, variantId || undefined);

  cartStore.subscribe(() => {
    renderCartItems();
    updateTotals();
    updateCheckoutButtonState();
    handleAbandonedCheckout();
  });

  window.addEventListener("shippingLocationChange", (e) => {
    window.lastShippingEventDetail = (e as CustomEvent).detail;
    // Reset discount when delivery option changes
    if (cartStore.get().discount) {
      removeDiscount();
      showDiscountMessage("Discount removed — delivery option changed.", "info");
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
  updateTotals();
  updateCheckoutButtonState();
}

declare global {
  interface Window {
    updateCartQuantity: (
      id: string,
      variantId: string,
      quantity: number,
    ) => void;
    removeFromCart: (id: string, variantId: string) => void;
    lastShippingEventDetail?: { id: string; fee: number };
    handleAbandonedCheckout?: () => void;
  }
}
