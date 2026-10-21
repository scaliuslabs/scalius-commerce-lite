// @vitest-environment happy-dom
// A subscription bought on the online store (final audit I4), with the
// `acme.subscriptions` app's option: the cart keeps it per line (the same SKU
// one-time and subscribed are two lines, keyed by the server's identity hash),
// it survives storage, refreshes and the server's re-key check, and the tax
// quote and the order the checkout places both send it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lineIdentityProperties, linePropertiesHash } from "@scalius/shared/line-properties";

const SUBSCRIBE = { id: "acme.subscriptions.subscribe", title: "Subscribe and save" };

async function freshCart() {
  vi.resetModules();
  const cart = await import("@/store/cart");
  cart.hydrateCartFromStorage();
  return cart;
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a subscribed cart line", () => {
  it("is its own line, keyed by the server's identity hash, and keeps its option through storage and refreshes", async () => {
    const cart = await freshCart();
    const line = { id: "p_coffee", variantId: "v_coffee", name: "Coffee beans", price: 1200, quantity: 1 };
    expect(await cart.addToCart(line)).toBe(true);
    expect(await cart.addToCart({ ...line, price: 1080, purchaseOption: SUBSCRIBE })).toBe(true);
    const items = Object.entries(cart.cartStore.get().items);
    expect(items).toHaveLength(2);
    const [subscribedKey, subscribed] = items.find(([, item]) => item.purchaseOption)!;
    // The hash the API answers for the line (`propertiesHash`), so the cart never re-keys it.
    const serverHash = await linePropertiesHash(lineIdentityProperties([], SUBSCRIBE.id));
    expect(subscribed).toMatchObject({ price: 1080, purchaseOption: SUBSCRIBE, propertiesHash: serverHash });
    expect(subscribedKey).toBe(await cart.cartLineKeyFor({ id: line.id, variantId: line.variantId, purchaseOption: SUBSCRIBE }));
    // Adding it again adds to the same line.
    expect(await cart.addToCart({ ...line, price: 1080, purchaseOption: SUBSCRIBE })).toBe(true);
    expect(cart.cartStore.get().items[subscribedKey]?.quantity).toBe(2);
    // A refresh from the server never drops the option (it is identity).
    expect(cart.updateCartItemByKey(subscribedKey, { price: 1000, quantity: 3 })).toBe(true);
    expect(cart.cartStore.get().items[subscribedKey]).toMatchObject({ price: 1000, quantity: 3, purchaseOption: SUBSCRIBE });

    // Another page load reads it back from storage under the same key.
    const reloaded = await freshCart();
    expect(reloaded.cartStore.get().items[subscribedKey]).toMatchObject({ purchaseOption: SUBSCRIBE, propertiesHash: serverHash });

    // A stored line whose option is malformed cannot be trusted: it is dropped, never bought one-time.
    localStorage.setItem(reloaded.CART_STORAGE_KEY, JSON.stringify({
      items: { [subscribedKey]: { ...subscribed, purchaseOption: { id: "not an option", title: "x" } } },
      totalItems: 1, totalAmount: 1080, discountCodes: [],
    }));
    expect(Object.keys((await freshCart()).cartStore.get().items)).toEqual([]);
  });

  it("is sent with its option to the tax quote and the order", async () => {
    const cart = await freshCart();
    await cart.addToCart({ id: "p_coffee", variantId: "v_coffee", name: "Coffee beans", price: 1080, quantity: 1, purchaseOption: SUBSCRIBE });
    await cart.addToCart({ id: "p_coffee", variantId: "v_coffee", name: "Coffee beans", price: 1200, quantity: 1 });
    const cartItems = JSON.stringify(cart.cartStore.get().items);

    const { buildTaxQuoteRequest } = await import("./tax-quote-client");
    const quote = buildTaxQuoteRequest({ cartItems, deliveryMode: "none", discountCodes: "[]" });
    expect(quote.items.map((item) => item.purchaseOption ?? null).sort()).toEqual([SUBSCRIBE.id, null].sort());

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { id: "ord_1" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const { createOrder } = await import("./create-order");
    await createOrder({
      checkoutRequestId: "checkout_req_test", expectedQuoteFingerprint: "taxq_abcdefghijklmnopqrstuv",
      customerName: "Rahima", customerPhone: "+8801700000000", customerEmail: "rahima@example.com",
      shippingAddress: "House 1", city: "city_1", zone: "zone_1", area: "", notes: "", shippingCharge: "0",
      deliveryMode: "none", cartItems,
    }, "acme.subscriptions:card");
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { items: Array<{ purchaseOption?: string; price: number }> };
    expect(body.items.map((item) => [item.price, item.purchaseOption ?? null])).toEqual(expect.arrayContaining([[1080, SUBSCRIBE.id], [1200, null]]));
  });
});
