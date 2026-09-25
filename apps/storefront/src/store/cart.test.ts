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

  it("Buy now checks out only its line and gives the buyer's own cart back untouched", async () => {
    const {
      addDiscountCode, addToCart, cartStore, clearCart, endBuyNow, hydrateCartFromStorage,
      isBuyNowCheckoutPath, startBuyNow, BUY_NOW_STASH_KEY,
    } = await importFreshCartModule();
    hydrateCartFromStorage();
    await addToCart({ id: "rice", variantId: "variant_rice", name: "Rice", price: 100, quantity: 2 });
    addDiscountCode("SAVE10");
    const own = structuredClone(cartStore.get());

    expect(await startBuyNow({ id: "tee", variantId: "variant_tee", name: "Tee", price: 500 })).toBe(true);
    expect(Object.values(cartStore.get().items).map((item) => [item.id, item.quantity])).toEqual([["tee", 1]]);
    expect(cartStore.get()).toMatchObject({ totalItems: 1, totalAmount: 500, discountCodes: [] });
    // A second Buy now replaces the first; the own cart stays set aside.
    expect(await startBuyNow({ id: "mug", variantId: "variant_mug", name: "Mug", price: 300 })).toBe(true);
    expect(Object.values(cartStore.get().items).map((item) => item.id)).toEqual(["mug"]);

    endBuyNow();
    expect(cartStore.get()).toEqual(own);
    expect(localStorage.getItem(BUY_NOW_STASH_KEY)).toBeNull();
    endBuyNow();
    expect(cartStore.get()).toEqual(own);

    // Signing out (clearCart) also drops a cart set aside by Buy now.
    await startBuyNow({ id: "tee", variantId: "variant_tee", name: "Tee", price: 500 });
    clearCart();
    expect(localStorage.getItem(BUY_NOW_STASH_KEY)).toBeNull();
    endBuyNow();
    expect(cartStore.get().items).toEqual({});

    expect(["/cart", "/checkout", "/checkout/quick", "/buy/tee", "/order-success", "/payment-recovery"].every(isBuyNowCheckoutPath)).toBe(true);
    expect(["/", "/products/tee", "/account", "/cartoon", "/search"].some(isBuyNowCheckoutPath)).toBe(false);
  });
});
