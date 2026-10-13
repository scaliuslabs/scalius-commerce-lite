import { beforeEach, describe, expect, it, vi } from "vitest";

type CartModule = typeof import("./cart");

class LocalStorageMock {
  private store = new Map<string, string>();

  clear() {
    this.store.clear();
  }

  getItem(key: string) {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }

  removeItem(key: string) {
    this.store.delete(key);
  }
}

function installBrowserShims() {
  const localStorage = new LocalStorageMock();
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorage,
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: { localStorage },
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: { dispatchEvent: vi.fn() },
    configurable: true,
  });
  Object.defineProperty(globalThis, "CustomEvent", {
    value: class CustomEvent<T = unknown> extends Event {
      detail: T;

      constructor(type: string, init?: CustomEventInit<T>) {
        super(type);
        this.detail = init?.detail as T;
      }
    },
    configurable: true,
  });
}

const persistedCart = {
  items: {
    drink: {
      id: "drink",
      variantId: "variant_drink",
      name: "Energy Drink",
      price: 120,
      quantity: 2,
      image: "https://cdn.example.com/drink.jpg",
    },
  },
  totalItems: 2,
  totalAmount: 240,
  discountCodes: [],
};

async function importFreshCartModule(): Promise<CartModule> {
  vi.resetModules();
  return import("./cart");
}

describe("cart store", () => {
  beforeEach(() => {
    installBrowserShims();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("starts empty and hydrates persisted cart data only when requested", async () => {
    localStorage.setItem("cart:v3", JSON.stringify(persistedCart));
    const { cartStore, hydrateCartFromStorage } = await importFreshCartModule();

    expect(cartStore.get()).toEqual({
      items: {},
      totalItems: 0,
      totalAmount: 0,
      discountCodes: [],
    });

    const hydrated = hydrateCartFromStorage();
    expect(hydrated).toMatchObject({ totalItems: 2, totalAmount: 240 });
    expect(Object.values(hydrated.items)[0]?.name).toBe("Energy Drink");

    localStorage.setItem("cart:v3", JSON.stringify({ items: {} }));
    expect(hydrateCartFromStorage()).toBe(hydrated);
  });

  it("reconciles a BFCache-restored cart with current browser storage", async () => {
    localStorage.setItem("cart:v3", JSON.stringify(persistedCart));
    const { cartStore, hydrateCartFromStorage, syncCartFromStorage } =
      await importFreshCartModule();

    hydrateCartFromStorage();
    expect(cartStore.get().totalItems).toBe(2);

    localStorage.setItem("cart:v3", JSON.stringify({ items: {} }));
    expect(syncCartFromStorage()).toEqual({
      items: {},
      totalItems: 0,
      totalAmount: 0,
      discountCodes: [],
    });
    expect(cartStore.get().items).toEqual({});
  });

  it("refreshes a BFCache product page before Buy now so purchased lines never return", async () => {
    const listen = vi.fn();
    Object.assign(window, { addEventListener: listen });
    localStorage.setItem("cart:v3", JSON.stringify(persistedCart));
    const { startBuyNow, cartStore } = await importFreshCartModule();
    const tee = { id: "tee", variantId: "tee_m", name: "Tee", price: 500 };
    expect(await startBuyNow(tee)).toBe(true);
    expect(cartStore.get().totalItems).toBe(3);
    // The receipt consumes this order's items in another document, then Back
    // restores this product document with its old in-memory three-item cart.
    localStorage.setItem("cart:v3", JSON.stringify({ items: {}, discountCodes: [] }));
    const onPageShow = listen.mock.calls.find(([type]) => type === "pageshow")?.[1] as (event: Event) => void;
    expect(onPageShow).toBeTypeOf("function");
    onPageShow(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(cartStore.get().totalItems).toBe(0);
    expect(await startBuyNow(tee)).toBe(true);
    expect(Object.values(cartStore.get().items).map(({ id, quantity }) => [id, quantity])).toEqual([["tee", 1]]);
  });

  it("uses one shipping-fee authority for ordinary, waived, mixed, and invalid fees", async () => {
    const {
      cartHasFreeDeliveryItem,
      getEffectiveCartShippingFee,
    } = await importFreshCartModule();
    const ordinary = {
      regular: { freeDelivery: false },
    };
    const mixed = {
      regular: { freeDelivery: false },
      waived: { freeDelivery: true },
    };

    expect(cartHasFreeDeliveryItem(ordinary)).toBe(false);
    expect(getEffectiveCartShippingFee(ordinary, 110)).toBe(110);
    expect(cartHasFreeDeliveryItem(mixed)).toBe(true);
    expect(getEffectiveCartShippingFee(mixed, 110)).toBe(0);
    expect(getEffectiveCartShippingFee(ordinary, -10)).toBe(0);
    expect(getEffectiveCartShippingFee(ordinary, Number.NaN)).toBe(0);
  });

  it("charges nothing once the items subtotal reaches the rate's free-over threshold", async () => {
    const { getEffectiveCartShippingFee } = await importFreshCartModule();
    const below = { a: { freeDelivery: false, price: 1250, quantity: 2 } };
    const exactly = { a: { freeDelivery: false, price: 1500, quantity: 2 } };
    expect(getEffectiveCartShippingFee(below, 150, 3000)).toBe(150);
    expect(getEffectiveCartShippingFee(exactly, 150, 3000)).toBe(0);
    expect(getEffectiveCartShippingFee(exactly, 150, null)).toBe(150);
  });

  it.each([
    { code: "JPY", price: 3, threshold: 10, subtotal: 9, fee: 2 },
    { code: "USD", price: 0.1, threshold: 0.3, subtotal: 0.3, fee: 0 },
    { code: "KWD", price: 3.337, threshold: 10.011, subtotal: 10.011, fee: 0 },
  ])("uses $code minor units at the free-delivery boundary", async ({ code, price, threshold, subtotal, fee }) => {
    Object.assign(window, { __CURRENCY_CODE__: code });
    const { cartItemsSubtotal, getEffectiveCartShippingFee } = await importFreshCartModule();
    const items = { line: { price, quantity: 3 } };
    expect(cartItemsSubtotal(items)).toBe(subtotal);
    expect(getEffectiveCartShippingFee(items, 2, threshold)).toBe(fee);
    expect(getEffectiveCartShippingFee(items, 2, threshold, true)).toBe(2);
  });

  it.each([
    { free: false, threshold: null, quoted: false, expected: 80 },
    { free: true, threshold: null, quoted: false, expected: 0 },
    { free: false, threshold: 100, quoted: false, expected: 0 },
    { free: false, threshold: 100, quoted: true, expected: 80 },
    { free: true, threshold: null, quoted: true, expected: 80 },
    { free: true, threshold: 100, quoted: true, expected: 80 },
  ])("keeps quoted delivery authoritative ($free, $threshold, $quoted)", async ({ free, threshold, quoted, expected }) => {
    const { getEffectiveCartShippingFee } = await importFreshCartModule();
    expect(getEffectiveCartShippingFee({ line: { freeDelivery: free, price: 100, quantity: 1 } }, 80, threshold, quoted)).toBe(expected);
  });

  it("falls back to an empty cart when stored JSON is invalid", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem("cart:v3", "{bad json");
    const { hydrateCartFromStorage } = await importFreshCartModule();

    expect(hydrateCartFromStorage()).toEqual({
      items: {},
      totalItems: 0,
      totalAmount: 0,
      discountCodes: [],
    });
    expect(warn).toHaveBeenCalled();
  });

  it("persists ordinary add, update, and remove operations", async () => {
    const {
      addToCart,
      cartStore,
      createCartItemKey,
      hydrateCartFromStorage,
      removeCartItemByKey,
      updateCartItemByKey,
    } = await importFreshCartModule();
    hydrateCartFromStorage();

    const item = {
      id: "rice",
      variantId: "variant_rice",
      name: "Rice",
      price: 100,
    };
    const lineKey = createCartItemKey(item);

    expect(await addToCart(item)).toBe(true);
    expect(updateCartItemByKey(lineKey, { quantity: 3, price: 90 })).toBe(true);
    expect(cartStore.get()).toMatchObject({ totalItems: 3, totalAmount: 270 });
    expect(JSON.parse(localStorage.getItem("cart:v3") ?? "{}")).toMatchObject({
      items: { [lineKey]: { quantity: 3, price: 90 } },
      totalItems: 3,
      totalAmount: 270,
    });

    expect(removeCartItemByKey(lineKey)).toBe(true);
    expect(cartStore.get()).toEqual({
      items: {},
      totalItems: 0,
      totalAmount: 0,
      discountCodes: [],
    });
  });

  it("keeps applied codes through every cart edit until the cart is empty", async () => {
    const {
      addDiscountCode,
      addToCart,
      cartStore,
      createCartItemKey,
      hydrateCartFromStorage,
      removeCartItemByKey,
      removeDiscountCode,
      updateCartItemByKey,
    } = await importFreshCartModule();
    hydrateCartFromStorage();

    const item = { id: "lamp", variantId: "variant_matte", name: "Matte Lamp", price: 2500 };
    const lineKey = createCartItemKey(item);
    expect(await addToCart(item)).toBe(true);
    expect(addDiscountCode(" save10 ")).toBe(true);
    expect(addDiscountCode("SAVE10")).toBe(false);
    expect(addDiscountCode("SHIPFREE")).toBe(true);
    expect(cartStore.get().discountCodes).toEqual(["SAVE10", "SHIPFREE"]);

    // Quantity and price changes re-check the codes; they never drop them.
    expect(updateCartItemByKey(lineKey, { quantity: 3 })).toBe(true);
    expect(updateCartItemByKey(lineKey, { price: 2400 })).toBe(true);
    expect(cartStore.get().discountCodes).toEqual(["SAVE10", "SHIPFREE"]);
    removeDiscountCode("SHIPFREE");
    expect(JSON.parse(localStorage.getItem("cart:v3")!).discountCodes).toEqual(["SAVE10"]);

    expect(removeCartItemByKey(lineKey)).toBe(true);
    expect(cartStore.get().discountCodes).toEqual([]);
  });

  it("takes only the ordered lines out after an order and restores an undone removal", async () => {
    const {
      addToCart,
      cartStore,
      clearCart,
      createCartItemKey,
      hydrateCartFromStorage,
      removeOrderedLines,
      restoreCart,
    } = await importFreshCartModule();
    hydrateCartFromStorage();
    const tee = { id: "tee", variantId: "tee_m", name: "Tee", price: 500 };
    const cap = { id: "cap", variantId: "cap_1", name: "Cap", price: 200 };
    await addToCart({ ...tee, quantity: 2 });
    await addToCart(cap);
    const teeKey = createCartItemKey(tee);

    // Another tab added the cap after this order (one tee) was submitted.
    removeOrderedLines({ [teeKey]: { ...tee, quantity: 1 } });
    expect(Object.values(cartStore.get().items).map(({ id, quantity }) => [id, quantity]))
      .toEqual([["tee", 1], ["cap", 1]]);

    const before = cartStore.get();
    clearCart();
    expect(cartStore.get().totalItems).toBe(0);
    restoreCart(before);
    expect(cartStore.get().totalItems).toBe(2);
  });

  it("canonicalizes saved line keys and merchant-defined option labels", async () => {
    localStorage.setItem(
      "cart:v3",
      JSON.stringify({
        items: {
          first: {
            id: "prod_1",
            variantId: "var_1",
            name: "Premium Rice",
            price: 100,
            quantity: 1,
            options: [
              { name: " Weight ", label: " 2KG " },
              { name: "Style", label: "Gift Box" },
              { name: "Packaging", label: "Reusable tin" },
            ],
          },
          duplicate: {
            id: "prod_1",
            variantId: "var_1",
            name: "Premium Rice",
            price: 100,
            quantity: 2,
          },
        },
        discountCodes: [],
      }),
    );
    const { createCartItemKey, hydrateCartFromStorage } =
      await importFreshCartModule();

    const hydrated = hydrateCartFromStorage();
    const lineKey = createCartItemKey({ id: "prod_1", variantId: "var_1" });
    expect(Object.keys(hydrated.items)).toEqual([lineKey]);
    expect(hydrated.items[lineKey]).toMatchObject({
      quantity: 3,
      options: [
        { name: "Weight", label: "2KG" },
        { name: "Style", label: "Gift Box" },
        { name: "Packaging", label: "Reusable tin" },
      ],
    });
  });

  it("rejects lines without a persisted sellable variant", async () => {
    const { addToCart, cartStore, hydrateCartFromStorage } =
      await importFreshCartModule();
    localStorage.setItem(
      "cart:v3",
      JSON.stringify({
        items: {
          old: { id: "prod_old", name: "Old", price: 100, quantity: 1 },
        },
      }),
    );
    hydrateCartFromStorage();

    expect(
      await addToCart({ id: "prod_1", name: "Rice", price: 100 } as never),
    ).toBe(false);
    expect(cartStore.get().items).toEqual({});
  });
});

describe("cart v3 line keys (buyer inputs)", () => {
  beforeEach(() => {
    installBrowserShims();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const engraving = { key: "engraving", value: "Anika", label: "Engraving", displayValue: "Anika", priceMinor: 20_000 };
  const wrap = { key: "wrap", value: "true", label: "Gift wrap", displayValue: "Yes", priceMinor: 5_000 };
  const schema = {
    version: 1 as const,
    fields: [
      { key: "engraving", label: "Engraving", type: "text" as const, required: false, help: null, maxLength: 30, priceMinor: 20_000 },
      { key: "wrap", label: "Gift wrap", type: "checkbox" as const, required: false, help: null, priceMinor: 5_000 },
    ],
  };

  it("keys a line with the shared canonical inputs hash (line:v3:…:p:<hash>)", async () => {
    const { addToCart, cartStore, hydrateCartFromStorage, CART_STORAGE_KEY } = await importFreshCartModule();
    const { canonicalizeLineProperties, lineCartKey, linePropertiesHash } = await import("@scalius/shared/line-properties");
    hydrateCartFromStorage();

    expect(await addToCart({ id: "pen", variantId: "pen_gold", name: "Pen", price: 450, properties: [engraving, wrap] })).toBe(true);
    // Buyer typed the inputs in a different order: the canonical order is the schema's.
    const canonical = canonicalizeLineProperties(schema, [
      { key: "wrap", value: "true" },
      { key: "engraving", value: " Anika " },
    ]);
    const expectedKey = lineCartKey("pen", "pen_gold", await linePropertiesHash(canonical));
    expect(Object.keys(cartStore.get().items)).toEqual([expectedKey]);
    expect(expectedKey).toMatch(/^line:v3:pen:variant:pen_gold:p:[0-9a-f]{16}$/);
    expect(cartStore.get().items[expectedKey]).toMatchObject({ propertiesHash: expectedKey.split(":p:")[1] });
    expect(Object.keys(JSON.parse(localStorage.getItem(CART_STORAGE_KEY)!).items)).toEqual([expectedKey]);

    // Without inputs the hash is "none".
    await addToCart({ id: "pen", variantId: "pen_gold", name: "Pen", price: 400 });
    expect(Object.keys(cartStore.get().items)).toContain(lineCartKey("pen", "pen_gold", "none"));
  });

  it("merges the same SKU with the same inputs and keeps different inputs apart", async () => {
    const { addToCart, cartStore, hydrateCartFromStorage } = await importFreshCartModule();
    hydrateCartFromStorage();

    await addToCart({ id: "pen", variantId: "pen_gold", name: "Pen", price: 450, properties: [engraving] });
    await addToCart({ id: "pen", variantId: "pen_gold", name: "Pen", price: 450, properties: [engraving], quantity: 2 });
    await addToCart({
      id: "pen", variantId: "pen_gold", name: "Pen", price: 450,
      properties: [{ ...engraving, value: "Rafi", displayValue: "Rafi" }],
    });

    const lines = Object.values(cartStore.get().items);
    expect(lines.map((line) => [line.properties?.[0]?.value, line.quantity])).toEqual([["Anika", 3], ["Rafi", 1]]);
    expect(cartStore.get().totalItems).toBe(4);
  });

  it("drops a v2 cart at the v3 deploy and removes it from storage", async () => {
    localStorage.setItem("cart", JSON.stringify(persistedCart));
    const { hydrateCartFromStorage } = await importFreshCartModule();

    expect(hydrateCartFromStorage().items).toEqual({});
    expect(localStorage.getItem("cart")).toBeNull();
  });

  it("drops a stored line whose inputs have no hash, and re-keys the rest from their stored hash", async () => {
    const { createCartItemKey, hydrateCartFromStorage } = await importFreshCartModule();
    localStorage.setItem("cart:v3", JSON.stringify({
      items: {
        forged: { id: "pen", variantId: "pen_gold", name: "Pen", price: 1, quantity: 1, properties: [engraving] },
        stale: {
          id: "pen", variantId: "pen_gold", name: "Pen", price: 450, quantity: 1,
          properties: [engraving], propertiesHash: "0123456789abcdef",
        },
      },
    }));

    const hydrated = hydrateCartFromStorage();
    expect(Object.keys(hydrated.items)).toEqual([
      createCartItemKey({ id: "pen", variantId: "pen_gold", propertiesHash: "0123456789abcdef" }),
    ]);
  });

  it("moves a line when the server resolves its inputs to another hash, and replaces an edited line", async () => {
    const { addToCart, cartStore, hydrateCartFromStorage, rekeyCartLine, replaceCartLine, createCartItemKey } =
      await importFreshCartModule();
    const { linePropertiesHash } = await import("@scalius/shared/line-properties");
    hydrateCartFromStorage();
    await addToCart({ id: "pen", variantId: "pen_gold", name: "Pen", price: 450, properties: [engraving], quantity: 2 });
    const [key] = Object.keys(cartStore.get().items);

    expect(rekeyCartLine(key!, "fedcba9876543210", [engraving])).toBe(true);
    const moved = createCartItemKey({ id: "pen", variantId: "pen_gold", propertiesHash: "fedcba9876543210" });
    expect(Object.keys(cartStore.get().items)).toEqual([moved]);
    expect(cartStore.get().items[moved]?.quantity).toBe(2);

    expect(await replaceCartLine(moved, {
      id: "pen", variantId: "pen_gold", name: "Pen", price: 500, quantity: 1,
      properties: [{ ...engraving, value: "Rafi", displayValue: "Rafi" }, wrap],
    })).toBe(true);
    const edited = createCartItemKey({
      id: "pen",
      variantId: "pen_gold",
      propertiesHash: await linePropertiesHash([{ key: "engraving", value: "Rafi" }, { key: "wrap", value: "true" }]),
    });
    expect(Object.keys(cartStore.get().items)).toEqual([edited]);
    expect(cartStore.get().items[edited]).toMatchObject({ quantity: 1, price: 500 });
  });

  it("needs a delivery method unless every line is known not to be physical", async () => {
    const { cartNeedsDeliveryMethod } = await importFreshCartModule();
    expect(cartNeedsDeliveryMethod({ a: { fulfillmentKind: "service" } })).toBe(false);
    expect(cartNeedsDeliveryMethod({ a: { fulfillmentKind: "service" }, b: { fulfillmentKind: "physical" } })).toBe(true);
    // An older line without a known kind still asks for delivery.
    expect(cartNeedsDeliveryMethod({ a: {} })).toBe(true);
  });

  it("Buy now keeps every existing line and discount, then adds the selected line", async () => {
    localStorage.setItem("cart:v3", JSON.stringify({ ...persistedCart, discountCodes: ["SAVE10"] }));
    const { startBuyNow, cartStore, syncCartFromStorage } = await importFreshCartModule();

    expect(await startBuyNow({ id: "tee", variantId: "variant_tee", name: "Tee", price: 500 })).toBe(true);
    expect(Object.values(cartStore.get().items).map(({ id, quantity }) => [id, quantity]))
      .toEqual([["drink", 2], ["tee", 1]]);
    expect(cartStore.get()).toMatchObject({ totalItems: 3, totalAmount: 740, discountCodes: ["SAVE10"] });
    expect(localStorage.getItem("cart:v3:buy-now")).toBeNull();
    const after = structuredClone(cartStore.get());
    expect(syncCartFromStorage()).toEqual(after);
  });

  it("Buy now merges the same SKU and inputs but keeps other options separate", async () => {
    const { addToCart, startBuyNow, cartStore } = await importFreshCartModule();
    const pen = { id: "pen", variantId: "pen_gold", name: "Pen", price: 450, properties: [engraving] };
    await addToCart({ ...pen, quantity: 2 });
    expect(await startBuyNow({ ...pen, quantity: 3 })).toBe(true);
    expect(await startBuyNow({ ...pen, variantId: "pen_silver" })).toBe(true);
    expect(await startBuyNow({ ...pen, properties: [{ ...engraving, value: "Rafi", displayValue: "Rafi" }] })).toBe(true);
    expect(Object.values(cartStore.get().items).map(({ variantId, properties, quantity }) =>
      [variantId, properties?.[0]?.value, quantity]))
      .toEqual([["pen_gold", "Anika", 5], ["pen_silver", "Anika", 1], ["pen_gold", "Rafi", 1]]);
  });

  it("rejects an invalid Buy now or quantity overflow without changing the cart", async () => {
    const { addToCart, startBuyNow, cartStore } = await importFreshCartModule();
    const tee = { id: "tee", variantId: "tee_m", name: "Tee", price: 500 };
    await addToCart({ ...tee, quantity: 99 });
    const before = structuredClone(cartStore.get());
    const onFailure = vi.fn();
    for (const item of [tee, { ...tee, variantId: "default" }, { ...tee, variantId: "new", price: -1 }]) {
      expect(await startBuyNow(item, { onFailure })).toBe(false);
      expect(cartStore.get()).toEqual(before);
      expect(JSON.parse(localStorage.getItem("cart:v3")!)).toEqual(before);
    }
    expect(onFailure.mock.calls).toEqual([["quantity_limit"], ["invalid_item"], ["invalid_item"]]);
  });

  it("Buy now refuses navigation when storage fails without adding a duplicate on retry", async () => {
    const { addToCart, startBuyNow, cartStore } = await importFreshCartModule();
    await addToCart({ id: "rice", variantId: "rice_1", name: "Rice", price: 100 });
    const before = structuredClone(cartStore.get());
    const tee = { id: "tee", variantId: "tee_m", name: "Tee", price: 500 };
    const blocked = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    const onFailure = vi.fn();
    expect(await startBuyNow(tee, { onFailure })).toBe(false);
    expect(onFailure).toHaveBeenCalledWith("storage_unavailable");
    expect(cartStore.get()).toEqual(before);
    blocked.mockRestore();
    expect(await startBuyNow(tee)).toBe(true);
    expect(Object.values(cartStore.get().items).map(({ id, quantity }) => [id, quantity]))
      .toEqual([["rice", 1], ["tee", 1]]);
  });

  it("concurrent Buy now additions use the latest cart after hashing inputs", async () => {
    const { startBuyNow, cartStore } = await importFreshCartModule();
    const pen = { id: "pen", variantId: "pen_gold", name: "Pen", price: 450, properties: [engraving] };
    expect(await Promise.all([startBuyNow(pen), startBuyNow({ ...pen, quantity: 2 }),
      startBuyNow({ id: "tee", variantId: "tee_m", name: "Tee", price: 500 })])).toEqual([true, true, true]);
    expect(Object.values(cartStore.get().items).find(({ id }) => id === "pen")?.quantity).toBe(3);
    expect(cartStore.get().totalItems).toBe(4);
    expect(JSON.parse(localStorage.getItem("cart:v3")!)).toEqual(cartStore.get());
  });

  it("recovers an old hidden cart once and never restores lines removed afterward", async () => {
    const { addToCart, cartStore, createCartItemKey, hydrateCartFromStorage, removeCartItemByKey, syncCartFromStorage } = await importFreshCartModule();
    await addToCart({ id: "tee", variantId: "tee_m", name: "Tee", price: 500 });
    localStorage.setItem("cart:v3:buy-now", JSON.stringify({ ...persistedCart, discountCodes: ["SAVE10"] }));
    syncCartFromStorage();
    expect(cartStore.get()).toMatchObject({ totalItems: 3, totalAmount: 740, discountCodes: ["SAVE10"] });
    expect(localStorage.getItem("cart:v3:buy-now")).toBeNull();
    const drinkKey = createCartItemKey(persistedCart.items.drink);
    removeCartItemByKey(drinkKey);
    syncCartFromStorage();
    expect(hydrateCartFromStorage().items[drinkKey]).toBeUndefined();
    expect(cartStore.get().totalItems).toBe(1);
  });

  it("merges hidden quantities only once and preserves the cart if the old stash is corrupt", async () => {
    localStorage.setItem("cart:v3", JSON.stringify(persistedCart));
    localStorage.setItem("cart:v3:buy-now", JSON.stringify(persistedCart));
    const { hydrateCartFromStorage, syncCartFromStorage } = await importFreshCartModule();
    expect(hydrateCartFromStorage().totalItems).toBe(4);
    expect(syncCartFromStorage().totalItems).toBe(4);
    localStorage.setItem("cart:v3:buy-now", "{invalid");
    expect(syncCartFromStorage().totalItems).toBe(4);
    expect(localStorage.getItem("cart:v3:buy-now")).toBeNull();
  });

  it("keeps the old stash recoverable when persisting its migration fails", async () => {
    const { addToCart, cartStore, syncCartFromStorage } = await importFreshCartModule();
    await addToCart({ id: "tee", variantId: "tee_m", name: "Tee", price: 500 });
    const current = structuredClone(cartStore.get());
    const stashed = JSON.stringify(persistedCart);
    localStorage.setItem("cart:v3:buy-now", stashed);
    const setItem = localStorage.setItem.bind(localStorage);
    const blocked = vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key === "cart:v3") throw new Error("QuotaExceededError");
      setItem(key, value);
    });
    expect(syncCartFromStorage()).toEqual(current);
    expect(localStorage.getItem("cart:v3:buy-now")).toBe(stashed);
    blocked.mockRestore();
    expect(syncCartFromStorage().totalItems).toBe(3);
    expect(localStorage.getItem("cart:v3:buy-now")).toBeNull();
  });
});
