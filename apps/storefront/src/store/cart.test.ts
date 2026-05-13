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

describe("cart store hydration", () => {
  beforeEach(() => {
    installBrowserShims();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("starts empty even when localStorage already has cart data", async () => {
    localStorage.setItem("cart", JSON.stringify(persistedCart));

    const { cartStore } = await importFreshCartModule();

    expect(cartStore.get()).toEqual({
      items: {},
      totalItems: 0,
      totalAmount: 0,
      discount: null,
    });
  });

  it("hydrates persisted cart exactly once", async () => {
    localStorage.setItem("cart", JSON.stringify(persistedCart));
    const { cartStore, hydrateCartFromStorage } = await importFreshCartModule();

    expect(hydrateCartFromStorage()).toMatchObject({
      totalItems: 2,
      totalAmount: 240,
    });
    expect(cartStore.get().items.drink?.name).toBe("Energy Drink");

    localStorage.setItem(
      "cart",
      JSON.stringify({
        items: {
          changed: { id: "changed", name: "Changed", price: 1, quantity: 1 },
        },
        totalItems: 1,
        totalAmount: 1,
        discount: null,
      }),
    );
    hydrateCartFromStorage();

    expect(cartStore.get().items.drink).toBeDefined();
    expect(cartStore.get().items.changed).toBeUndefined();
  });

  it("does not overwrite saved cart before hydration", async () => {
    localStorage.setItem("cart", JSON.stringify(persistedCart));
    const { cartStore } = await importFreshCartModule();

    cartStore.setKey("totalItems", 99);

    expect(JSON.parse(localStorage.getItem("cart") ?? "{}")).toEqual(
      persistedCart,
    );
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

  it("persists cart mutations after hydration", async () => {
    const { addToCart, hydrateCartFromStorage } = await importFreshCartModule();
    hydrateCartFromStorage();

    addToCart({ id: "prime", name: "Prime", price: 80 });

    expect(JSON.parse(localStorage.getItem("cart") ?? "{}")).toMatchObject({
      items: {
        prime: { id: "prime", name: "Prime", price: 80, quantity: 1 },
      },
      totalItems: 1,
      totalAmount: 80,
    });
  });
});
