// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addOrderToCart } from "./account-buy-again";
import { addLinesToCart, addToCart, CART_STORAGE_KEY, cartLineKeyFor, cartStore, clearCart, MAX_CART_QUANTITY } from "@/store/cart";

type Line = Parameters<typeof addOrderToCart>[0][number];

const orderLine = (variantId: string, price: number, quantity = 1): Line => ({
  productId: "prod_psn",
  variantId,
  quantity,
  price,
  productName: "PlayStation gift card",
  productSlug: "playstation-gift-card",
  productImage: null,
  variantLabel: `${price}$`,
} as Line);

function validated(lines: Line[], issues: Array<{ index: number; code: string }> = []) {
  return {
    success: true,
    data: {
      valid: issues.length === 0,
      issues,
      items: lines.map((line, index) => ({
        index,
        productId: line.productId,
        variantId: line.variantId,
        quantity: line.quantity,
        unitPrice: line.price,
        productName: line.productName,
        variantLabel: line.variantLabel,
        freeDelivery: false,
        availableQuantity: null,
        productImageMediaId: null,
        productImage: null,
      })),
      subtotal: 0,
      hasFreeDeliveryProduct: false,
    },
  };
}

const opened: Array<{ addedLineKey?: string } | undefined> = [];
const added: unknown[] = [];
const onOpen = (event: Event) => opened.push((event as CustomEvent).detail);
const onAdd = (event: Event) => added.push((event as CustomEvent).detail);

beforeEach(() => {
  localStorage.clear();
  clearCart();
  opened.length = 0;
  added.length = 0;
  document.addEventListener("open-cart", onOpen);
  document.addEventListener("add-to-cart", onAdd);
});

afterEach(() => {
  document.removeEventListener("open-cart", onOpen);
  document.removeEventListener("add-to-cart", onAdd);
  vi.unstubAllGlobals();
});

const quantities = () => Object.fromEntries(Object.values(cartStore.get().items).map((item) => [item.variantId, item.quantity]));

describe("buy again", () => {
  it("puts every line of a multi-line order in the cart in one change and opens the drawer once", async () => {
    const lines = [orderLine("var_25", 25), orderLine("var_50", 50)];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(validated(lines)))));
    const changes: number[] = [];
    const stop = cartStore.listen((state) => changes.push(Object.keys(state.items).length));

    await expect(addOrderToCart(lines)).resolves.toEqual({ added: 2, missing: 0 });
    stop();

    expect(quantities()).toEqual({ var_25: 1, var_50: 1 });
    // One store change holds both lines: nothing can see (or persist) a half-added order.
    expect(changes).toEqual([2]);
    expect(Object.keys(JSON.parse(localStorage.getItem(CART_STORAGE_KEY) ?? "{}").items ?? {})).toHaveLength(2);
    expect(added).toEqual([]);
    expect(opened).toEqual([{ addedLineKey: await cartLineKeyFor({ id: "prod_psn", variantId: "var_25" }) }]);

    // Again: each line grows by its ordered quantity.
    await expect(addOrderToCart(lines)).resolves.toEqual({ added: 2, missing: 0 });
    expect(quantities()).toEqual({ var_25: 2, var_50: 2 });
  });

  it("counts only the lines that went in", async () => {
    const lines = [orderLine("var_25", 25), orderLine("var_50", 50)];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(validated(lines, [{ index: 1, code: "variant_unavailable" }])))));
    await expect(addOrderToCart(lines)).resolves.toEqual({ added: 1, missing: 1 });
    expect(quantities()).toEqual({ var_25: 1 });
  });
});

describe("addLinesToCart", () => {
  it("merges repeated lines and stops at the per-line limit", async () => {
    await addToCart({ id: "p", variantId: "v1", name: "One", price: 1, quantity: MAX_CART_QUANTITY - 1 });
    const keys = await addLinesToCart([
      { id: "p", variantId: "v1", name: "One", price: 1, quantity: 5 },
      { id: "p", variantId: "v2", name: "Two", price: 2, quantity: 1 },
      { id: "p", variantId: "v2", name: "Two", price: 2, quantity: 2 },
    ]);
    expect(keys).toHaveLength(2);
    expect(quantities()).toEqual({ v1: MAX_CART_QUANTITY, v2: 3 });
    // A line already at the limit is not added to again.
    await expect(addLinesToCart([{ id: "p", variantId: "v1", name: "One", price: 1, quantity: 1 }])).resolves.toEqual([]);
  });
});
