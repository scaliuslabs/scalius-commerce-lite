//src/store/cart.ts
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

// Load initial state from localStorage
const initialState: CartStore =
  typeof window !== "undefined"
    ? JSON.parse(
        localStorage.getItem("cart") ||
          '{"items":{},"totalItems":0,"totalAmount":0,"discount":null}',
      )
    : {
        items: {},
        totalItems: 0,
        totalAmount: 0,
        discount: null,
      };

// Initialize cart store
export const cartStore = map<CartStore>(initialState);

// Save to localStorage whenever store changes
if (typeof window !== "undefined") {
  cartStore.subscribe((state) => {
    localStorage.setItem("cart", JSON.stringify(state));
  });
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

  // Dispatch event for cross-component communication
  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent("cart-updated"));
  }
}

// Remove item from cart
export function removeFromCart(itemId: string, variantId?: string) {
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
}

// Update item quantity
export function updateQuantity(
  itemId: string,
  variantId: string | undefined,
  quantity: number,
) {
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
}

// Apply discount to cart
export function applyDiscount(discount: Discount) {
  cartStore.setKey("discount", discount);
  updateCartTotals();

  // Dispatch event for cross-component communication
  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent("discount-applied"));
    document.dispatchEvent(new CustomEvent("cart-updated"));
  }
}

// Remove discount from cart
export function removeDiscount() {
  cartStore.setKey("discount", null);
  updateCartTotals();

  // Dispatch event for cross-component communication
  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent("discount-removed"));
    document.dispatchEvent(new CustomEvent("cart-updated"));
  }
}

// Clear cart
export function clearCart() {
  cartStore.set({
    items: {},
    totalItems: 0,
    totalAmount: 0,
    discount: null,
  });
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
