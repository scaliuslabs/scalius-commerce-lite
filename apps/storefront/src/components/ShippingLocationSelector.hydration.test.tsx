// @vitest-environment happy-dom

import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { cartStore, createCartItemKey, type CartStore } from "@/store/cart";
import ShippingLocationSelector from "./ShippingLocationSelector";

const EMPTY_CART: CartStore = {
  items: {},
  totalItems: 0,
  totalAmount: 0,
  discount: null,
};

const freeDeliveryItem = {
  id: "prod_free",
  name: "Free delivery item",
  price: 100,
  quantity: 1,
  variantId: "var_free",
  freeDelivery: true,
};
const FREE_DELIVERY_CART: CartStore = {
  items: {
    [createCartItemKey(freeDeliveryItem)]: freeDeliveryItem,
  },
  totalItems: 1,
  totalAmount: 100,
  discount: null,
};
const shippingMethods = [
  {
    id: "standard",
    name: "Standard delivery",
    fee: 110,
    description: null,
    isActive: true,
    sortOrder: 0,
    createdAt: null,
    updatedAt: null,
  },
];

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  cartStore.set(EMPTY_CART);
  document.body.innerHTML = "";
});

describe("ShippingLocationSelector hydration", () => {
  it("keeps the first client render aligned when another island has already hydrated the cart", async () => {
    cartStore.set(EMPTY_CART);
    const element = (
      <ShippingLocationSelector shippingMethods={shippingMethods} />
    );
    const serverHtml = renderToString(element);
    expect(serverHtml).toContain("৳110");
    expect(serverHtml).not.toContain("Free");

    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.append(container);

    cartStore.set(FREE_DELIVERY_CART);
    const recoverableErrors: unknown[] = [];

    await act(async () => {
      root = hydrateRoot(container, element, {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
      await Promise.resolve();
    });

    expect(recoverableErrors).toEqual([]);
    expect(container.textContent).toContain("Free");
    expect(container.textContent).not.toContain("৳110");
    expect(
      container.querySelector('[role="radiogroup"]')?.getAttribute("aria-label"),
    ).toBe("Choose Delivery Option");
    expect(
      container.querySelector('[role="radio"]')?.getAttribute("aria-label"),
    ).toBe("Standard delivery, Free");
  });
});
