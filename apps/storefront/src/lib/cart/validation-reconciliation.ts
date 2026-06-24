import { cartStore } from "../../store/cart";
import type { CartValidationResult } from "../api/orders";
import { resolveCartKeyForValidatedLine } from "./cart-key-resolution";

export function reconcileValidatedCartSnapshot(
  validation: CartValidationResult,
  onDiscountCleared?: (message: string) => void,
): boolean {
  const state = cartStore.get();
  const nextItems = { ...state.items };
  let changed = false;

  for (const validatedItem of validation.items) {
    const key = resolveCartKeyForValidatedLine(validatedItem, nextItems);
    if (!key) continue;

    const currentItem = nextItems[key];
    if (!currentItem) continue;

    if (currentItem.freeDelivery !== validatedItem.freeDelivery) {
      nextItems[key] = {
        ...currentItem,
        freeDelivery: validatedItem.freeDelivery,
      };
      changed = true;
    }
  }

  if (!changed) return false;

  const itemList = Object.values(nextItems);
  cartStore.set({
    ...state,
    items: nextItems,
    totalItems: itemList.reduce((total, item) => total + item.quantity, 0),
    totalAmount: itemList.reduce(
      (total, item) => total + item.price * item.quantity,
      0,
    ),
    discount: state.discount ? null : state.discount,
  });

  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent("cart-updated"));
  }

  if (state.discount) {
    onDiscountCleared?.("Discount removed - delivery eligibility changed.");
  }

  return true;
}
