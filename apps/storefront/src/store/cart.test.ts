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
  discount: null,
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
    localStorage.setItem("cart", JSON.stringify(persistedCart));
    const { cartStore, hydrateCartFromStorage } = await importFreshCartModule();

    expect(cartStore.get()).toEqual({
      items: {},
      totalItems: 0,
      totalAmount: 0,
      discount: null,
    });

    const hydrated = hydrateCartFromStorage();
    expect(hydrated).toMatchObject({ totalItems: 2, totalAmount: 240 });
    expect(Object.values(hydrated.items)[0]?.name).toBe("Energy Drink");

    localStorage.setItem("cart", JSON.stringify({ items: {} }));
    expect(hydrateCartFromStorage()).toBe(hydrated);
  });

  it("reconciles a BFCache-restored cart with current browser storage", async () => {
    localStorage.setItem("cart", JSON.stringify(persistedCart));
    const { cartStore, hydrateCartFromStorage, syncCartFromStorage } =
      await importFreshCartModule();

    hydrateCartFromStorage();
    expect(cartStore.get().totalItems).toBe(2);

    localStorage.setItem("cart", JSON.stringify({ items: {} }));
    expect(syncCartFromStorage()).toEqual({
      items: {},
      totalItems: 0,
      totalAmount: 0,
      discount: null,
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

  it("falls back to an empty cart when stored JSON is invalid", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem("cart", "{bad json");
    const { hydrateCartFromStorage } = await importFreshCartModule();

    expect(hydrateCartFromStorage()).toEqual({
      items: {},
      totalItems: 0,
      totalAmount: 0,
      discount: null,
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

    expect(addToCart(item)).toBe(true);
    expect(updateCartItemByKey(lineKey, { quantity: 3, price: 90 })).toBe(true);
    expect(cartStore.get()).toMatchObject({ totalItems: 3, totalAmount: 270 });
    expect(JSON.parse(localStorage.getItem("cart") ?? "{}")).toMatchObject({
      items: { [lineKey]: { quantity: 3, price: 90 } },
      totalItems: 3,
      totalAmount: 270,
    });

    expect(removeCartItemByKey(lineKey)).toBe(true);
    expect(cartStore.get()).toEqual({
      items: {},
      totalItems: 0,
      totalAmount: 0,
      discount: null,
    });
  });

  it("preserves discounts for presentation-only repairs but clears them for commercial changes", async () => {
    const {
      addToCart,
      applyDiscount,
      cartStore,
      createCartItemKey,
      hydrateCartFromStorage,
      updateCartItemByKey,
    } = await importFreshCartModule();
    hydrateCartFromStorage();

    const item = {
      id: "lamp",
      variantId: "variant_matte",
      name: "Matte Lamp",
      price: 2500,
      image: "https://media.example.test/stale.webp",
    };
    const lineKey = createCartItemKey(item);
    expect(addToCart(item)).toBe(true);
    applyDiscount({
      id: "disc_1",
      code: "SAVE10",
      type: "percentage",
      valueType: "percentage",
      discountValue: 10,
      discountAmount: 250,
    });

    expect(updateCartItemByKey(lineKey, {
      image: "https://media.example.test/matte.webp",
      imageMediaId: "med_matte",
    })).toBe(true);
    expect(cartStore.get().discount?.code).toBe("SAVE10");

    expect(updateCartItemByKey(lineKey, { price: 2400 })).toBe(true);
    expect(cartStore.get().discount).toBeNull();
  });

  it("canonicalizes saved line keys and merchant-defined option labels", async () => {
    localStorage.setItem(
      "cart",
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
        discount: null,
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
      "cart",
      JSON.stringify({
        items: {
          old: { id: "prod_old", name: "Old", price: 100, quantity: 1 },
        },
      }),
    );
    hydrateCartFromStorage();

    expect(
      addToCart({ id: "prod_1", name: "Rice", price: 100 } as never),
    ).toBe(false);
    expect(cartStore.get().items).toEqual({});
  });
});
