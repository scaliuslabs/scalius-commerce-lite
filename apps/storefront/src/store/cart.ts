import { map } from "nanostores";


export type CartItem = {
  id: string;
  slug?: string;
  name: string;
  price: number;
  quantity: number;
  image?: string;
  variantId?: string;
  size?: string;
  color?: string;
  freeDelivery?: boolean;
};

export type Discount = {
  id: string;
  code: string;
  type: string;
  valueType: string;
  discountValue: number;
  discountAmount: number;
  combineWithProductDiscounts?: boolean;
  combineWithOrderDiscounts?: boolean;
  combineWithShippingDiscounts?: boolean;
};

export type CartStore = {
  items: Record<string, CartItem>;
  totalItems: number;
  totalAmount: number;
  discount: Discount | null;
};

const EMPTY_CART_STATE: CartStore = {
  items: {},
  totalItems: 0,
  totalAmount: 0,
  discount: null,
};

let hasHydratedFromStorage = false;
let canPersistToStorage = false;

export const cartStore = map<CartStore>({ ...EMPTY_CART_STATE });

if (typeof window !== "undefined") {
  cartStore.subscribe((state) => {
    if (!canPersistToStorage) return;
    try {
      localStorage.setItem("cart", JSON.stringify(state));
    } catch (error) {
      console.warn("Could not persist cart state.", error);
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeStoredCartItem(value: unknown): CartItem | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.name !== "string") return null;

  return {
    id: value.id,
    slug: typeof value.slug === "string" ? value.slug : undefined,
    name: value.name,
    price: toNumber(value.price),
    quantity: Math.max(1, Math.floor(toNumber(value.quantity, 1))),
    image: typeof value.image === "string" ? value.image : undefined,
    variantId: typeof value.variantId === "string" ? value.variantId : undefined,
    size: typeof value.size === "string" ? value.size : undefined,
    color: typeof value.color === "string" ? value.color : undefined,
    freeDelivery:
      typeof value.freeDelivery === "boolean" ? value.freeDelivery : undefined,
  };
}

function normalizeStoredDiscount(value: unknown): Discount | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.code !== "string" ||
    typeof value.type !== "string" ||
    typeof value.valueType !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    code: value.code,
    type: value.type,
    valueType: value.valueType,
    discountValue: toNumber(value.discountValue),
    discountAmount: toNumber(value.discountAmount),
    combineWithProductDiscounts:
      typeof value.combineWithProductDiscounts === "boolean"
        ? value.combineWithProductDiscounts
        : undefined,
    combineWithOrderDiscounts:
      typeof value.combineWithOrderDiscounts === "boolean"
        ? value.combineWithOrderDiscounts
        : undefined,
    combineWithShippingDiscounts:
      typeof value.combineWithShippingDiscounts === "boolean"
        ? value.combineWithShippingDiscounts
        : undefined,
  };
}

function normalizeCartTotals(state: CartStore): CartStore {
  const items = Object.values(state.items);
  return {
    ...state,
    totalItems: items.reduce((total, item) => total + item.quantity, 0),
    totalAmount: items.reduce(
      (total, item) => total + item.price * item.quantity,
      0,
    ),
  };
}

export function normalizeStoredCart(value: unknown): CartStore {
  if (!isRecord(value) || !isRecord(value.items)) {
    return { ...EMPTY_CART_STATE };
  }

  const items: Record<string, CartItem> = {};
  for (const [key, item] of Object.entries(value.items)) {
    const normalized = normalizeStoredCartItem(item);
    if (normalized) items[key] = normalized;
  }

  return normalizeCartTotals({
    items,
    totalItems: 0,
    totalAmount: 0,
    discount: normalizeStoredDiscount(value.discount),
  });
}

export function hydrateCartFromStorage(): CartStore {
  if (typeof window === "undefined") return cartStore.get();
  if (hasHydratedFromStorage) return cartStore.get();

  hasHydratedFromStorage = true;
  try {
    const storedCart = localStorage.getItem("cart");
    if (storedCart) {
      cartStore.set(normalizeStoredCart(JSON.parse(storedCart)));
    }
  } catch (error) {
    console.warn("Could not hydrate cart state.", error);
    cartStore.set({ ...EMPTY_CART_STATE });
  } finally {
    canPersistToStorage = true;
  }

  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent("cart-updated"));
  }

  return cartStore.get();
}

function ensureCartHydrated(): void {
  if (typeof window !== "undefined") {
    hydrateCartFromStorage();
  }
}

function emitCartUpdated(): void {
  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent("cart-updated"));
  }
}

// Generate unique cart item key
function generateCartItemKey(
  item: Omit<CartItem, "quantity"> & { quantity?: number },
): string {
  // For products with variants, use id-variantId
  if (item.variantId && item.variantId !== "default") {
    return `${item.id}-${item.variantId}`;
  }

  // For products with size/color but no variantId, create a key based on those
  if (item.size || item.color) {
    const sizeKey = item.size || "no-size";
    const colorKey = item.color || "no-color";
    return `${item.id}-${sizeKey}-${colorKey}`;
  }

  // Default to just the product ID/slug
  return item.id;
}

// Add item to cart
export function addToCart(
  item: Omit<CartItem, "quantity"> & { quantity?: number },
) {
  ensureCartHydrated();
  // Reset discount when cart contents change
  if (cartStore.get().discount) {
    cartStore.setKey("discount", null);
  }

  const currentItems = cartStore.get().items;
  const itemKey = generateCartItemKey(item);
  const existingItem = currentItems[itemKey];
  const quantity = item.quantity || 1; // Use passed quantity or default to 1

  if (existingItem) {
    cartStore.setKey("items", {
      ...currentItems,
      [itemKey]: {
        ...existingItem,
        quantity: existingItem.quantity + quantity,
      },
    });
  } else {
    cartStore.setKey("items", {
      ...currentItems,
      [itemKey]: {
        ...item,
        quantity: quantity, // Use the specified quantity
      },
    });
  }

  updateCartTotals();

  emitCartUpdated();
}

// Remove item from cart
export function removeFromCart(itemId: string, variantId?: string) {
  ensureCartHydrated();
  // Reset discount when cart contents change
  if (cartStore.get().discount) {
    cartStore.setKey("discount", null);
  }

  const currentItems = cartStore.get().items;

  // Try to find the item using different key patterns
  let itemKey = itemId;

  if (variantId && variantId !== "default") {
    itemKey = `${itemId}-${variantId}`;
  }

  // If not found, try to find by checking all keys
  if (!currentItems[itemKey]) {
    const foundKey = Object.keys(currentItems).find(
      (key) => key.startsWith(itemId) || key === itemId,
    );
    if (foundKey) {
      itemKey = foundKey;
    }
  }

  const newItems = { ...currentItems };
  delete newItems[itemKey];

  cartStore.setKey("items", newItems);
  updateCartTotals();
  emitCartUpdated();
}

export function removeCartItemByKey(itemKey: string) {
  ensureCartHydrated();
  if (cartStore.get().discount) {
    cartStore.setKey("discount", null);
  }

  const currentItems = cartStore.get().items;
  if (!currentItems[itemKey]) return;

  const newItems = { ...currentItems };
  delete newItems[itemKey];

  cartStore.setKey("items", newItems);
  updateCartTotals();
  emitCartUpdated();
}

// Update item quantity
export function updateQuantity(
  itemId: string,
  variantId: string | undefined,
  quantity: number,
) {
  ensureCartHydrated();
  const currentItems = cartStore.get().items;

  // Try to find the item using different key patterns
  let itemKey = itemId;

  if (variantId && variantId !== "default") {
    itemKey = `${itemId}-${variantId}`;
  }

  // If not found, try to find by checking all keys
  if (!currentItems[itemKey]) {
    const foundKey = Object.keys(currentItems).find(
      (key) => key.startsWith(itemId) || key === itemId,
    );
    if (foundKey) {
      itemKey = foundKey;
    }
  }

  const existingItem = currentItems[itemKey];

  if (!existingItem) return;

  if (quantity <= 0) {
    removeFromCart(itemId, variantId);
    return;
  }

  // Reset discount when cart contents change
  if (cartStore.get().discount) {
    cartStore.setKey("discount", null);
  }

  cartStore.setKey("items", {
    ...currentItems,
    [itemKey]: {
      ...existingItem,
      quantity,
    },
  });

  updateCartTotals();
  emitCartUpdated();
}

export function updateCartItemByKey(
  itemKey: string,
  updates: Partial<Pick<CartItem, "name" | "price" | "quantity" | "freeDelivery">>,
) {
  ensureCartHydrated();
  const currentItems = cartStore.get().items;
  const existingItem = currentItems[itemKey];
  if (!existingItem) return;

  if (cartStore.get().discount) {
    cartStore.setKey("discount", null);
  }

  const quantity =
    updates.quantity !== undefined
      ? Math.max(1, Math.floor(updates.quantity))
      : existingItem.quantity;

  cartStore.setKey("items", {
    ...currentItems,
    [itemKey]: {
      ...existingItem,
      ...updates,
      quantity,
    },
  });

  updateCartTotals();
  emitCartUpdated();
}

// Apply discount to cart
export function applyDiscount(discount: Discount) {
  ensureCartHydrated();
  cartStore.setKey("discount", discount);
  updateCartTotals();

  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent("discount-applied"));
  }
  emitCartUpdated();
}

// Remove discount from cart
export function removeDiscount() {
  ensureCartHydrated();
  cartStore.setKey("discount", null);
  updateCartTotals();

  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent("discount-removed"));
  }
  emitCartUpdated();
}

// Clear cart
export function clearCart() {
  ensureCartHydrated();
  cartStore.set({
    ...EMPTY_CART_STATE,
  });
  emitCartUpdated();
}

// Update cart totals
function updateCartTotals() {
  const state = cartStore.get();
  const items = Object.values(state.items);

  const totalItems = items.reduce((total, item) => total + item.quantity, 0);
  const totalAmount = items.reduce(
    (total, item) => total + item.price * item.quantity,
    0,
  );

  cartStore.setKey("totalItems", totalItems);
  cartStore.setKey("totalAmount", totalAmount);

  // If there's a discount but cart is now empty, remove it
  if (totalItems === 0 && state.discount) {
    cartStore.setKey("discount", null);
  }
}
