// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { cartStore } from "../../store/cart";
import type { CheckoutLanguageData } from "../api/types";
import type { CartValidationIssue, CartValidationResult } from "../api/orders";
import { applyCheckoutButtonState } from "./checkout-button-state";
import { resolveCartKeyForValidatedLine } from "./cart-key-resolution";
import { renderEmptyCartState } from "./empty-state";
import { renderCartIssueAction } from "./issue-action";
import { reconcileValidatedCartSnapshot } from "./validation-reconciliation";
import {
  getBulkCartRepairActionCounts,
  renderBulkCartRepairActions,
  selectCartKeysForBulkRepair,
} from "./bulk-repair-actions";

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

  it("renders hosted payment recovery as an explicit receipt action", () => {
    const cartItemsContainer = document.getElementById("cartItems");
    if (!cartItemsContainer) {
      throw new Error("Missing cartItems container");
    }
    const onClick = vi.fn();

    renderEmptyCartState(
      cartItemsContainer,
      checkoutLanguage(),
      {
        href: "/order-success?orderId=order_1&token=receipt_1&payment=sslcommerz",
        onClick,
      },
    );

    const links = [...cartItemsContainer.querySelectorAll("a")];
    expect(cartItemsContainer.textContent).toContain("Your order was created before payment handoff");
    expect(links[0]?.getAttribute("href")).toBe(
      "/order-success?orderId=order_1&token=receipt_1&payment=sslcommerz",
    );
    expect(links[0]?.textContent).toBe("View payment status");
    links[0]?.dispatchEvent(new Event("click"));
    expect(onClick).toHaveBeenCalledTimes(1);
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

describe("bulk cart repair actions", () => {
  const issues: Record<string, CartValidationIssue[]> = {
    remove_line: [
      {
        index: 0,
        cartKey: "remove_line",
        productId: "prod_removed",
        variantId: null,
        code: "PRODUCT_UNAVAILABLE",
        action: "remove",
        message: "This product is no longer available.",
        productName: "Removed product",
        variantLabel: null,
        requestedQuantity: 1,
      },
    ],
    reduce_line: [
      {
        index: 1,
        cartKey: "reduce_line",
        productId: "prod_low",
        variantId: "var_low",
        code: "QUANTITY_UNAVAILABLE",
        action: "reduce_quantity",
        message: "Only 2 left.",
        productName: "Low stock product",
        variantLabel: null,
        requestedQuantity: 5,
        availableQuantity: 2,
      },
    ],
    sold_out_line: [
      {
        index: 2,
        cartKey: "sold_out_line",
        productId: "prod_sold",
        variantId: "var_sold",
        code: "QUANTITY_UNAVAILABLE",
        action: "reduce_quantity",
        message: "Sold out.",
        productName: "Sold out product",
        variantLabel: null,
        requestedQuantity: 1,
        availableQuantity: 0,
      },
    ],
    refresh_line: [
      {
        index: 3,
        cartKey: "refresh_line",
        productId: "prod_price",
        variantId: "var_price",
        code: "PRICE_CHANGED",
        action: "refresh_item",
        message: "Price changed.",
        productName: "Price product",
        variantLabel: null,
        requestedQuantity: 1,
        submittedPrice: 100,
        currentPrice: 120,
      },
    ],
  };

  it("counts and selects safe bulk repair targets by action", () => {
    expect(getBulkCartRepairActionCounts(issues)).toEqual({
      remove: 2,
      reduceQuantity: 1,
      refreshPrice: 1,
    });
    expect(selectCartKeysForBulkRepair(issues, "remove")).toEqual([
      "remove_line",
      "sold_out_line",
    ]);
    expect(selectCartKeysForBulkRepair(issues, "reduce_quantity")).toEqual([
      "reduce_line",
    ]);
    expect(selectCartKeysForBulkRepair(issues, "refresh_item")).toEqual([
      "refresh_line",
    ]);
  });

  it("renders only available bulk repair buttons", () => {
    const html = renderBulkCartRepairActions(issues);

    expect(html).toContain("Remove unavailable (2)");
    expect(html).toContain("Update quantities (1)");
    expect(html).toContain("Refresh prices (1)");
    expect(html).toContain("window.bulkRemoveCartIssueItems()");
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

  it("does not reconcile a stale explicit cart key onto another row by index", () => {
    cartStore.set({
      items: {
        current_line: {
          id: "prod_current",
          name: "Current product",
          price: 150,
          quantity: 1,
          variantId: "variant_current",
          freeDelivery: false,
        },
      },
      totalItems: 1,
      totalAmount: 150,
      discount: null,
    });

    expect(reconcileValidatedCartSnapshot({
      valid: true,
      issues: [],
      subtotal: 300,
      hasFreeDeliveryProduct: true,
      items: [
        {
          index: 0,
          cartKey: "removed_line",
          productId: "prod_removed",
          variantId: "variant_removed",
          quantity: 1,
          unitPrice: 300,
          productName: "Removed product",
          variantLabel: null,
          freeDelivery: true,
          availableQuantity: 5,
        },
      ],
    })).toBe(false);

    expect(cartStore.get().items.current_line?.freeDelivery).toBe(false);
  });
});

describe("resolveCartKeyForValidatedLine", () => {
  const items = {
    current_line: {
      id: "prod_current",
      name: "Current product",
      price: 150,
      quantity: 1,
      variantId: "variant_current",
    },
  };

  it("does not fall back by index when a server repair issue names a missing cart key", () => {
    expect(resolveCartKeyForValidatedLine({
      index: 0,
      cartKey: "old_line",
      productId: "prod_old",
      variantId: "variant_old",
    }, items)).toBeNull();
  });

  it("keeps product and variant fallback for older validation payloads without cart keys", () => {
    expect(resolveCartKeyForValidatedLine({
      index: 99,
      productId: "prod_current",
      variantId: "variant_current",
    }, items)).toBe("current_line");
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
