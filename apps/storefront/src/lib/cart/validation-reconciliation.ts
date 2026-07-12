import {
  cartStore,
  updateCartItemsByKeyAtomically,
  type CartLineItemUpdate,
} from "../../store/cart";
import type { CartValidationResult } from "../api/orders";
import { resolveCartKeyForValidatedLine } from "./cart-key-resolution";

export function reconcileValidatedCartSnapshot(
  validation: CartValidationResult,
  onDiscountCleared?: (message: string) => void,
): boolean {
  const state = cartStore.get();
  const updates: CartLineItemUpdate[] = [];

  for (const validatedItem of validation.items) {
    const key = resolveCartKeyForValidatedLine(validatedItem, state.items);
    if (!key) continue;

    const currentItem = state.items[key];
    if (!currentItem) continue;

    const nextImage = validatedItem.productImage ?? undefined;
    const nextImageMediaId = validatedItem.productImageMediaId ?? undefined;
    if (
      currentItem.freeDelivery !== validatedItem.freeDelivery ||
      currentItem.image !== nextImage ||
      currentItem.imageMediaId !== nextImageMediaId
    ) {
      updates.push({
        lineKey: key,
        updates: {
          freeDelivery: validatedItem.freeDelivery,
          image: nextImage,
          imageMediaId: nextImageMediaId,
        },
      });
    }
  }

  if (updates.length === 0 || !updateCartItemsByKeyAtomically(updates)) {
    return false;
  }

  if (state.discount) {
    onDiscountCleared?.("Discount removed - delivery eligibility changed.");
  }

  return true;
}
