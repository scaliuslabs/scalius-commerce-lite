// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

import type { CheckoutLanguageData } from "../api/types";
import { applyCheckoutButtonState } from "./checkout-button-state";
import { renderEmptyCartState } from "./empty-state";

const maliciousEmptyCartText =
  '</h3><img src=x onerror="window.__emptyCartPwned=true"><h3>';
const maliciousContinueShoppingText =
  '</a><script>window.__continuePwned=true</script><a>';

function checkoutLanguage(
  overrides: Partial<CheckoutLanguageData["languageData"]> = {},
): CheckoutLanguageData {
  return {
    id: "malicious",
    name: "Malicious",
    code: "xx",
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
      ...overrides,
    },
    fieldVisibility: {
      showEmailField: true,
      showOrderNotesField: true,
      showAreaField: true,
    },
    isActive: true,
    isDefault: true,
  };
}

describe("renderEmptyCartState", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="cartItems"></div>
    `;
  });

  it("renders empty-cart language strings as text instead of HTML", async () => {
    const cartItemsContainer = document.getElementById("cartItems");
    if (!cartItemsContainer) {
      throw new Error("Missing cartItems container");
    }

    renderEmptyCartState(
      cartItemsContainer,
      checkoutLanguage({
        emptyCartText: maliciousEmptyCartText,
        continueShoppingText: maliciousContinueShoppingText,
      }),
    );
    const title = cartItemsContainer?.querySelector("h3");
    const continueLink = cartItemsContainer?.querySelector("a");

    expect(cartItemsContainer?.querySelector("img")).toBeNull();
    expect(cartItemsContainer?.querySelector("script")).toBeNull();
    expect(title?.textContent).toBe(maliciousEmptyCartText);
    expect(continueLink?.textContent).toContain(maliciousContinueShoppingText);
    expect(
      (window as typeof window & { __emptyCartPwned?: boolean })
        .__emptyCartPwned,
    ).toBeUndefined();
    expect(
      (window as typeof window & { __continuePwned?: boolean }).__continuePwned,
    ).toBeUndefined();
  });
});

describe("updateCheckoutButtonState", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div
        id="checkout-meta"
        data-checkout-unavailable="true"
        data-checkout-unavailable-message="Checkout setup is incomplete."
      ></div>
      <button id="submitButton">Place Order</button>
    `;
  });

  it("keeps submit disabled when checkout is unavailable even with cart items", () => {
    const submitButton = document.getElementById(
      "submitButton",
    ) as HTMLButtonElement;
    applyCheckoutButtonState(submitButton, {
      checkoutUnavailable: true,
      unavailableMessage: "Checkout setup is incomplete.",
      isEmpty: false,
    });

    expect(submitButton.disabled).toBe(true);
    expect(submitButton.classList.contains("opacity-50")).toBe(true);
    expect(submitButton.classList.contains("cursor-not-allowed")).toBe(true);
    expect(submitButton.title).toBe("Checkout setup is incomplete.");
  });
});
