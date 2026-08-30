// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearCheckoutFormDraft,
  writeCheckoutFormDraft,
} from "@/lib/checkout/session-state";
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
  clearCheckoutFormDraft();
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
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
    expect(container.querySelector('[role="radio"]')).toBeNull();
    expect(
      container.querySelector<HTMLInputElement>('input[name="shippingLocation"]')?.value,
    ).toBe("standard");
    expect(container.textContent).toContain("Standard delivery");
  });

  it("exposes one named native radio for each available shipping method", async () => {
    const methods = [
      shippingMethods[0],
      { ...shippingMethods[0], id: "express", name: "Express delivery", fee: 200 },
    ];
    const container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      root = createRoot(container);
      root.render(<ShippingLocationSelector shippingMethods={methods} />);
    });

    const radios = container.querySelectorAll<HTMLInputElement>(
      'input[type="radio"][name="shippingLocation"]',
    );
    expect(radios).toHaveLength(2);
    expect(radios[0]?.checked).toBe(true);
    expect(radios[0]?.getAttribute("aria-label")).toContain("Standard delivery");
    expect(container.querySelector('[role="radio"]')).toBeNull();
  });

  it("restores the saved delivery method before publishing the first shipping change", async () => {
    const methods = [
      shippingMethods[0],
      { ...shippingMethods[0], id: "collection", name: "Collection point", fee: 50 },
    ];
    writeCheckoutFormDraft({ shippingLocation: "collection" });
    const publishedMethods: Array<{ id: string; name?: string }> = [];
    const trackPublishedMethod = (event: Event) => {
      publishedMethods.push((event as CustomEvent<{ id: string; name?: string }>).detail);
    };
    window.addEventListener("shippingLocationChange", trackPublishedMethod);

    const container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      root = createRoot(container);
      root.render(<ShippingLocationSelector shippingMethods={methods} />);
      await Promise.resolve();
    });

    expect(
      container.querySelector<HTMLInputElement>(
        'input[name="shippingLocation"][value="collection"]',
      )?.checked,
    ).toBe(true);
    expect(publishedMethods).toEqual([
      expect.objectContaining({ id: "collection", name: "Collection point" }),
    ]);
    window.removeEventListener("shippingLocationChange", trackPublishedMethod);
  });

  it("falls back to the first active method when the saved method is unavailable", async () => {
    const methods = [
      shippingMethods[0],
      { ...shippingMethods[0], id: "express", name: "Express delivery", fee: 200 },
    ];
    writeCheckoutFormDraft({ shippingLocation: "retired-method" });
    const publishedMethods: Array<{ id: string; name?: string }> = [];
    const trackPublishedMethod = (event: Event) => {
      publishedMethods.push((event as CustomEvent<{ id: string; name?: string }>).detail);
    };
    window.addEventListener("shippingLocationChange", trackPublishedMethod);

    const container = document.createElement("div");
    document.body.append(container);

    await act(async () => {
      root = createRoot(container);
      root.render(<ShippingLocationSelector shippingMethods={methods} />);
      await Promise.resolve();
    });

    expect(
      container.querySelector<HTMLInputElement>(
        'input[name="shippingLocation"][value="standard"]',
      )?.checked,
    ).toBe(true);
    expect(publishedMethods).toEqual([
      expect.objectContaining({ id: "standard", name: "Standard delivery" }),
    ]);
    window.removeEventListener("shippingLocationChange", trackPublishedMethod);
  });
});
