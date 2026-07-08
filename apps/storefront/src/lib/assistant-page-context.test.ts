import { describe, expect, it } from "vitest";

import {
  MAX_ASSISTANT_CART_LINES,
  buildStorefrontAssistantPageContext,
  inferStorefrontAssistantPageKind,
} from "./assistant-page-context";

describe("buildStorefrontAssistantPageContext", () => {
  it("redacts sensitive route data and strips private URL components", () => {
    const snapshot = buildStorefrontAssistantPageContext({
      path: "/account/orders/order_private_123?receiptToken=chk_secret",
      route: "/account/orders/[id]",
      canonicalUrl:
        "https://shop.example.test/account/orders/order_private_123?token=chk_secret#receipt",
      title: "Order detail\u0000 page",
    });

    expect(snapshot.page).toEqual({
      path: "/account/orders/[id]",
      route: "/account/orders/[id]",
      canonicalUrl: null,
      title: "Order detail page",
      kind: "account",
    });
    expect(JSON.stringify(snapshot)).not.toContain("chk_secret");
    expect(JSON.stringify(snapshot)).not.toContain("receiptToken");
    expect(JSON.stringify(snapshot)).not.toContain("order_private_123");
  });

  it("keeps the cart summary bounded and allowlisted", () => {
    const items = Object.fromEntries(
      Array.from({ length: MAX_ASSISTANT_CART_LINES + 5 }, (_, index) => [
        `line_${index}`,
        {
          id: `prod_${index}`,
          variantId: `variant_${index}`,
          slug: `product-${index}`,
          name: `Product ${index} ${"x".repeat(300)}`,
          price: 12.345,
          quantity: 2,
          size: "Large",
          color: "Blue",
          image: "https://cdn.example.test/private-tracker.jpg",
          phone: "+8801711111111",
          email: "buyer@example.test",
          address: "Hidden address",
          receiptToken: "chk_private_receipt",
          orderId: "order_private_123",
        },
      ]),
    );

    const snapshot = buildStorefrontAssistantPageContext({
      path: "/products/widget",
      title: "Widget",
      cart: {
        items,
        totalItems: 999999,
        totalAmount: 999999,
        discount: {
          id: "discount_1",
          code: "SECRET10",
          type: "coupon",
          valueType: "fixed",
          discountValue: 10,
          discountAmount: 10,
        },
      },
    });

    expect(snapshot.cart.lines).toHaveLength(MAX_ASSISTANT_CART_LINES);
    expect(snapshot.cart.lineCount).toBe(MAX_ASSISTANT_CART_LINES + 5);
    expect(snapshot.cart.totalItems).toBe((MAX_ASSISTANT_CART_LINES + 5) * 2);
    expect(snapshot.cart.truncated).toBe(true);
    expect(snapshot.cart.hasDiscount).toBe(true);
    expect(snapshot.cart.lines[0]).toEqual({
      productId: "prod_0",
      variantId: "variant_0",
      slug: "product-0",
      name: expect.stringMatching(/^Product 0/),
      quantity: 2,
      unitPrice: 12.35,
      lineTotal: 24.7,
      options: [
        { name: "Option 1", label: "Large" },
        { name: "Option 2", label: "Blue" },
      ],
    });
    expect(snapshot.cart.lines[0]?.name).toHaveLength(160);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("SECRET10");
    expect(serialized).not.toContain("buyer@example.test");
    expect(serialized).not.toContain("+8801711111111");
    expect(serialized).not.toContain("Hidden address");
    expect(serialized).not.toContain("chk_private_receipt");
    expect(serialized).not.toContain("order_private_123");
    expect(serialized).not.toContain("private-tracker");
  });

  it("exposes merchant-defined cart option labels as sanitized pairs", () => {
    const snapshot = buildStorefrontAssistantPageContext({
      path: "/cart",
      title: "Cart",
      cart: {
        items: {
          "prod_weight-var_2kg": {
            id: "prod_weight",
            name: "Premium Rice",
            price: 850,
            quantity: 1,
            variantId: "var_2kg",
            size: "legacy-size-should-not-win",
            color: "legacy-color-should-not-win",
            options: [
              { name: "Weight", label: "2KG" },
              { name: "Style", label: "Gift Box" },
            ],
          },
        },
        totalItems: 1,
        totalAmount: 850,
        discount: null,
      },
    });

    expect(snapshot.cart.lines[0]?.options).toEqual([
      { name: "Weight", label: "2KG" },
      { name: "Style", label: "Gift Box" },
    ]);
    expect(JSON.stringify(snapshot.cart.lines[0]?.options)).not.toContain(
      "size",
    );
    expect(JSON.stringify(snapshot.cart.lines[0]?.options)).not.toContain(
      "color",
    );
  });

  it("normalizes legacy size/color cart options through the same safe array shape", () => {
    const snapshot = buildStorefrontAssistantPageContext({
      path: "/cart",
      title: "Cart",
      cart: {
        items: {
          "prod_1-legacy": {
            id: "prod_1",
            name: "Legacy Product",
            price: 10,
            quantity: 1,
            size: "Bearer abc.def.ghi",
            color: "01711111111",
          },
        },
        totalItems: 1,
        totalAmount: 10,
        discount: null,
      },
    });

    expect(snapshot.cart.lines[0]?.options).toEqual([
      { name: "Option 1", label: "Bearer [redacted-token]" },
      { name: "Option 2", label: "[redacted-phone]" },
    ]);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("abc.def.ghi");
    expect(serialized).not.toContain("01711111111");
  });

  it("redacts contact and token-like display text without hiding normal long product names", () => {
    const snapshot = buildStorefrontAssistantPageContext({
      path: "/products/widget",
      title: "Cart for buyer@example.test +8801711111111 chk_private_receipt",
      cart: {
        items: {
          line_1: {
            id: "prod_1",
            name: `Premium SuperComfortableTravelBackpack ${"x".repeat(120)} buyer@example.test`,
            price: 10,
            quantity: 1,
            size: "Bearer abc.def.ghi",
            color: "01711111111",
          },
        },
        totalItems: 1,
        totalAmount: 10,
        discount: null,
      },
    });

    const serialized = JSON.stringify(snapshot);
    expect(snapshot.page.title).toBe(
      "Cart for [redacted-email] [redacted-phone] [redacted-token]",
    );
    expect(snapshot.cart.lines[0]?.name).toContain(
      "Premium SuperComfortableTravelBackpack",
    );
    expect(snapshot.cart.lines[0]?.name).toContain("xxxxxxxx");
    expect(snapshot.cart.lines[0]?.options).toEqual([
      { name: "Option 1", label: "Bearer [redacted-token]" },
      { name: "Option 2", label: "[redacted-phone]" },
    ]);
    expect(serialized).not.toContain("buyer@example.test");
    expect(serialized).not.toContain("+8801711111111");
    expect(serialized).not.toContain("01711111111");
    expect(serialized).not.toContain("chk_private_receipt");
    expect(serialized).not.toContain("abc.def.ghi");
  });
});

describe("inferStorefrontAssistantPageKind", () => {
  it("infers known public storefront page kinds", () => {
    expect(inferStorefrontAssistantPageKind("/", null)).toBe("home");
    expect(inferStorefrontAssistantPageKind("/products/widget", null)).toBe(
      "product",
    );
    expect(
      inferStorefrontAssistantPageKind("/anything", "/categories/[slug]"),
    ).toBe("category");
    expect(inferStorefrontAssistantPageKind("/cart", null)).toBe("cart");
    expect(inferStorefrontAssistantPageKind("/payment-recovery", null)).toBe(
      "checkout",
    );
  });
});
