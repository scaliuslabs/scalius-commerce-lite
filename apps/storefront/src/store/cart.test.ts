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
      revision: 0,
      appliedOperationIds: [],
    });
  });

  it("hydrates persisted cart exactly once", async () => {
    localStorage.setItem("cart", JSON.stringify(persistedCart));
    const { cartStore, hydrateCartFromStorage } = await importFreshCartModule();

    expect(hydrateCartFromStorage()).toMatchObject({
      totalItems: 2,
      totalAmount: 240,
    });
    expect(Object.values(cartStore.get().items)[0]?.name).toBe("Energy Drink");

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

    expect(Object.values(cartStore.get().items)).toEqual([
      expect.objectContaining({ id: "drink", name: "Energy Drink" }),
    ]);
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
      revision: 0,
      appliedOperationIds: [],
    });
    expect(warn).toHaveBeenCalled();
  });

  it("persists cart mutations after hydration", async () => {
    const { addToCart, createCartItemKey, hydrateCartFromStorage } =
      await importFreshCartModule();
    hydrateCartFromStorage();

    const item = {
      id: "prime",
      variantId: "variant_prime",
      name: "Prime",
      price: 80,
    };
    expect(addToCart(item)).toBe(true);
    const lineKey = createCartItemKey(item);

    expect(JSON.parse(localStorage.getItem("cart") ?? "{}")).toMatchObject({
      items: {
        [lineKey]: {
          id: "prime",
          variantId: "variant_prime",
          name: "Prime",
          price: 80,
          quantity: 1,
        },
      },
      totalItems: 1,
      totalAmount: 80,
      revision: 1,
    });
  });

  it("hydrates merchant-labeled cart option pairs without changing saved size/color fields", async () => {
    localStorage.setItem(
      "cart",
      JSON.stringify({
        items: {
          rice: {
            id: "rice",
            variantId: "variant_rice_2kg_gift",
            name: "Premium Rice",
            price: 850,
            quantity: 1,
            size: "2KG",
            color: "Gift Box",
            options: [
              { name: " Weight ", label: " 2KG " },
              { name: "Style", label: "Gift Box" },
              { name: "Ignored", label: "Extra" },
            ],
          },
        },
        totalItems: 1,
        totalAmount: 850,
        discount: null,
      }),
    );

    const { hydrateCartFromStorage } = await importFreshCartModule();

    expect(Object.values(hydrateCartFromStorage().items)[0]).toMatchObject({
      size: "2KG",
      color: "Gift Box",
      options: [
        { name: "Weight", label: "2KG" },
        { name: "Style", label: "Gift Box" },
      ],
    });
  });

  it("canonicalizes pre-v2 browser keys once and merges duplicate sellable identities", async () => {
    localStorage.setItem(
      "cart",
      JSON.stringify({
        items: {
          arbitrary_a: {
            id: "prod_1",
            variantId: "var_1",
            name: "Rice",
            price: 100,
            quantity: 1,
          },
          arbitrary_b: {
            id: "prod_1",
            variantId: "var_1",
            name: "Rice",
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
    const lineKey = createCartItemKey({
      id: "prod_1",
      variantId: "var_1",
    });
    expect(Object.keys(hydrated.items)).toEqual([lineKey]);
    expect(hydrated.items[lineKey]?.quantity).toBe(3);
    expect(hydrated).toMatchObject({
      totalItems: 3,
      totalAmount: 300,
      revision: 0,
      appliedOperationIds: [],
    });
    expect(
      Object.keys(JSON.parse(localStorage.getItem("cart") ?? "{}").items),
    ).toEqual([lineKey]);
  });

  it("drops stored rows and rejects new rows without an authoritative persisted variant", async () => {
    const { addToCart, cartStore, hydrateCartFromStorage } =
      await importFreshCartModule();
    localStorage.setItem(
      "cart",
      JSON.stringify({
        items: {
          old_row: { id: "prod_old", name: "Old", price: 100, quantity: 1 },
        },
      }),
    );
    hydrateCartFromStorage();

    expect(
      addToCart({ id: "prod_1", name: "Rice", price: 100 } as never),
    ).toBe(false);
    expect(cartStore.get()).toMatchObject({ items: {}, revision: 0 });
  });
});

describe("atomic absolute-quantity cart patches", () => {
  beforeEach(() => {
    installBrowserShims();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("plans a multi-line absolute update without mutating the source", async () => {
    const { createCartItemKey, getCartFingerprint, planAtomicCartPatch } =
      await importFreshCartModule();
    const first = {
      id: "prod_1",
      variantId: "var_1",
      name: "Rice",
      price: 100,
    };
    const second = {
      id: "prod_2",
      variantId: "var_2",
      name: "Oil",
      price: 250,
    };
    const firstKey = createCartItemKey(first);
    const secondKey = createCartItemKey(second);
    const source = {
      items: { [firstKey]: { ...first, quantity: 1 } },
      totalItems: 1,
      totalAmount: 100,
      discount: null,
      revision: 7,
      appliedOperationIds: [],
    };

    const result = planAtomicCartPatch(source, {
      operationId: "assistant:cart:op_1",
      expectedRevision: 7,
      expectedFingerprint: getCartFingerprint(source),
      patches: [
        {
          lineKey: firstKey,
          productId: first.id,
          variantId: first.variantId,
          quantity: 3,
        },
        {
          lineKey: secondKey,
          productId: second.id,
          variantId: second.variantId,
          quantity: 2,
          item: second,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(source.items[firstKey]?.quantity).toBe(1);
    expect(result.state).toMatchObject({
      totalItems: 5,
      totalAmount: 800,
      revision: 8,
      appliedOperationIds: ["assistant:cart:op_1"],
    });
    expect(result.state.items[firstKey]?.quantity).toBe(3);
    expect(result.state.items[secondKey]?.quantity).toBe(2);
    expect(result.fingerprint).not.toBe(getCartFingerprint(source));
  });

  it("rejects stale revisions and replayed operation IDs", async () => {
    const { getCartFingerprint, planAtomicCartPatch } =
      await importFreshCartModule();
    const source = {
      items: {},
      totalItems: 0,
      totalAmount: 0,
      discount: null,
      revision: 4,
      appliedOperationIds: ["assistant:cart:already"],
    };
    const base = {
      expectedFingerprint: getCartFingerprint(source),
      patches: [
        {
          lineKey: "line:v2:prod:variant:var",
          productId: "prod",
          variantId: "var",
          quantity: 1,
          item: { id: "prod", variantId: "var", name: "Product", price: 1 },
        },
      ],
    };

    expect(
      planAtomicCartPatch(source, {
        ...base,
        operationId: "assistant:cart:stale",
        expectedRevision: 3,
      }),
    ).toMatchObject({ ok: false, code: "revision_mismatch" });
    expect(
      planAtomicCartPatch(source, {
        ...base,
        operationId: "assistant:cart:already",
        expectedRevision: 4,
      }),
    ).toMatchObject({ ok: false, code: "operation_replayed" });
  });

  it("rejects missing exact keys, variant mismatches, and invalid quantities all-or-nothing", async () => {
    const { createCartItemKey, getCartFingerprint, planAtomicCartPatch } =
      await importFreshCartModule();
    const itemA = {
      id: "prod",
      variantId: "var_a",
      name: "A",
      price: 10,
      quantity: 1,
    };
    const itemB = { ...itemA, variantId: "var_b", name: "B" };
    const keyA = createCartItemKey(itemA);
    const keyB = createCartItemKey(itemB);
    const source = {
      items: { [keyA]: itemA, [keyB]: itemB },
      totalItems: 2,
      totalAmount: 20,
      discount: null,
      revision: 2,
      appliedOperationIds: [],
    };
    const expectedFingerprint = getCartFingerprint(source);

    expect(
      planAtomicCartPatch(source, {
        operationId: "assistant:cart:missing",
        expectedRevision: 2,
        expectedFingerprint,
        patches: [
          {
            lineKey: "line:v2:missing:variant:missing",
            productId: "missing",
            variantId: "missing",
            quantity: 0,
          },
        ],
      }),
    ).toMatchObject({ ok: false, code: "line_not_found" });

    expect(
      planAtomicCartPatch(source, {
        operationId: "assistant:cart:wrong_variant",
        expectedRevision: 2,
        expectedFingerprint,
        patches: [
          {
            lineKey: keyA,
            productId: "prod",
            variantId: "var_b",
            quantity: 2,
          },
        ],
      }),
    ).toMatchObject({ ok: false, code: "invalid_variant" });

    expect(
      planAtomicCartPatch(source, {
        operationId: "assistant:cart:replace_existing",
        expectedRevision: 2,
        expectedFingerprint,
        patches: [
          {
            lineKey: keyA,
            productId: "prod",
            variantId: "var_a",
            quantity: 2,
            item: {
              id: "prod",
              variantId: "var_a",
              name: "Injected replacement",
              price: 1,
            },
          },
        ],
      }),
    ).toMatchObject({ ok: false, code: "item_not_allowed" });

    const invalid = planAtomicCartPatch(source, {
      operationId: "assistant:cart:invalid",
      expectedRevision: 2,
      expectedFingerprint,
      patches: [
        {
          lineKey: keyA,
          productId: "prod",
          variantId: "var_a",
          quantity: 5,
        },
        {
          lineKey: keyB,
          productId: "prod",
          variantId: "wrong_variant",
          quantity: 100,
        },
      ],
    });
    expect(invalid).toMatchObject({ ok: false, code: "invalid_quantity" });
    expect(source.items[keyA]?.quantity).toBe(1);
    expect(source.items[keyB]?.quantity).toBe(1);
  });

  it("applies one validated operation with one revision increment and rejects its replay", async () => {
    const {
      applyAtomicCartPatch,
      cartStore,
      createCartItemKey,
      getCartFingerprint,
      hydrateCartFromStorage,
    } = await importFreshCartModule();
    hydrateCartFromStorage();
    vi.mocked(document.dispatchEvent).mockClear();
    const item = {
      id: "prod_1",
      variantId: "var_1",
      name: "Rice",
      price: 100,
    };
    const request = {
      operationId: "assistant:cart:apply_1",
      expectedRevision: 0,
      expectedFingerprint: getCartFingerprint(cartStore.get()),
      patches: [
        {
          lineKey: createCartItemKey(item),
          productId: item.id,
          variantId: item.variantId,
          quantity: 2,
          item,
        },
      ],
    };

    expect(applyAtomicCartPatch(request)).toMatchObject({ ok: true, revision: 1 });
    expect(document.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(applyAtomicCartPatch(request)).toMatchObject({
      ok: false,
      code: "operation_replayed",
    });
    expect(cartStore.get().revision).toBe(1);
  });

  it("keeps fingerprints deterministic across record insertion order and revision changes", async () => {
    const { createCartItemKey, getCartFingerprint } =
      await importFreshCartModule();
    const a = { id: "a", variantId: "va", name: "A", price: 1, quantity: 1 };
    const b = { id: "b", variantId: "vb", name: "B", price: 2, quantity: 2 };
    const keyA = createCartItemKey(a);
    const keyB = createCartItemKey(b);
    const first = {
      items: { [keyA]: a, [keyB]: b },
      totalItems: 3,
      totalAmount: 5,
      discount: null,
      revision: 1,
      appliedOperationIds: [],
    };
    const second = {
      ...first,
      items: { [keyB]: b, [keyA]: a },
      revision: 99,
    };
    expect(getCartFingerprint(first)).toBe(getCartFingerprint(second));
  });
});
