// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

import { cartStore } from "../../store/cart";
import type { CheckoutLanguageData } from "../api/types";
import type { CartValidationIssue, CartValidationResult } from "../api/orders";
import { applyCheckoutButtonState } from "./checkout-button-state";
import { renderEmptyCartState } from "./empty-state";
import { renderCartIssueAction } from "./issue-action";
import { reconcileValidatedCartSnapshot } from "./validation-reconciliation";

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

describe("renderIssueAction", () => {
  beforeEach(() => {
    cartStore.set({
      items: {
        line_1: {
          id: "prod_1",
          slug: "cotton-panjabi",
          name: "Cotton Panjabi",
          price: 150,
          quantity: 1,
          variantId: "default",
        },
      },
      totalItems: 1,
      totalAmount: 150,
      discount: null,
    });
  });

  it("links variant-required cart issues back to the product options", () => {
    const issue: CartValidationIssue = {
      index: 0,
      cartKey: "line_1",
      productId: "prod_1",
      variantId: null,
      code: "VARIANT_REQUIRED",
      action: "select_variant",
      message: "Cotton Panjabi needs an option selection before checkout.",
      productName: "Cotton Panjabi",
      variantLabel: null,
      requestedQuantity: 1,
    };

    const html = renderCartIssueAction("line_1", issue, cartStore.get().items.line_1?.slug);

    expect(html).toContain("Choose option");
    expect(html).toContain('href="/products/cotton-panjabi"');
    expect(html).not.toContain("Remove item");
  });
});

describe("reconcileValidatedCartSnapshot", () => {
  function validationResult(
    freeDelivery: boolean,
    overrides: Partial<CartValidationResult["items"][number]> = {},
  ): CartValidationResult {
    return {
      valid: true,
      issues: [],
      subtotal: 300,
      hasFreeDeliveryProduct: freeDelivery,
      items: [
        {
          index: 0,
          cartKey: "line_1",
          productId: "prod_1",
          variantId: "variant_1",
          quantity: 2,
          unitPrice: 150,
          productName: "Cotton Panjabi",
          variantLabel: "M / Black",
          freeDelivery,
          availableQuantity: 12,
          ...overrides,
        },
      ],
    };
  }

  beforeEach(() => {
    document.body.innerHTML = `<div id="discountMessage"></div>`;
  });

  it("updates stale free-delivery eligibility from true to false and clears shipping-sensitive discounts", () => {
    cartStore.set({
      items: {
        line_1: {
          id: "prod_1",
          name: "Cotton Panjabi",
          price: 150,
          quantity: 2,
          variantId: "variant_1",
          freeDelivery: true,
        },
      },
      totalItems: 2,
      totalAmount: 300,
      discount: {
        id: "disc_1",
        code: "SAVE",
        type: "percentage",
        valueType: "percentage",
        discountValue: 10,
        discountAmount: 30,
      },
    });

    const messages: string[] = [];
    expect(reconcileValidatedCartSnapshot(validationResult(false), (message) => {
      messages.push(message);
      const messageElement = document.getElementById("discountMessage");
      if (messageElement) messageElement.textContent = message;
    })).toBe(true);

    const state = cartStore.get();
    expect(state.items.line_1?.freeDelivery).toBe(false);
    expect(state.totalItems).toBe(2);
    expect(state.totalAmount).toBe(300);
    expect(state.discount).toBeNull();
    expect(document.getElementById("discountMessage")?.textContent).toContain(
      "delivery eligibility changed",
    );
    expect(messages).toEqual(["Discount removed - delivery eligibility changed."]);
  });

  it("updates stale free-delivery eligibility from false to true before checkout totals are transferred", () => {
    cartStore.set({
      items: {
        line_1: {
          id: "prod_1",
          name: "Cotton Panjabi",
          price: 150,
          quantity: 2,
          variantId: "variant_1",
          freeDelivery: false,
        },
      },
      totalItems: 2,
      totalAmount: 300,
      discount: null,
    });

    expect(reconcileValidatedCartSnapshot(validationResult(true))).toBe(true);

    const state = cartStore.get();
    expect(state.items.line_1?.freeDelivery).toBe(true);
    expect(state.totalItems).toBe(2);
    expect(state.totalAmount).toBe(300);
    expect(state.discount).toBeNull();
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
