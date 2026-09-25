import {
  cartStore,
  rekeyCartLine,
  updateCartItemsByKeyAtomically,
  type CartLineItemUpdate,
  type CartLineProperty,
} from "../../store/cart";
import type { CartValidationItem, CartValidationResult } from "../api/orders";
import { resolveCartKeyForValidatedLine } from "./cart-key-resolution";

function serverProperties(item: CartValidationItem): CartLineProperty[] | undefined {
  if (!Array.isArray(item.properties)) return undefined;
  return item.properties.map(({ key, value, label, displayValue, priceMinor }) => ({
    key,
    value,
    label,
    displayValue,
    priceMinor,
  }));
}

function sameDisplay(
  current: CartLineProperty[] | undefined,
  next: CartLineProperty[] | undefined,
): boolean {
  const left = current ?? [];
  const right = next ?? [];
  return left.length === right.length && left.every((property, index) => {
    const other = right[index]!;
    return property.key === other.key &&
      property.value === other.value &&
      property.label === other.label &&
      property.displayValue === other.displayValue &&
      property.priceMinor === other.priceMinor;
  });
}

/**
 * Applies what the server said about each line: its image, free-delivery
 * flag, fulfilment kind and the labels of its buyer inputs. When the server
 * resolved the inputs to a different canonical hash (its word is final), the
 * line moves to that key. Prices and quantities are never changed here; the
 * buyer repairs those through the line's issue.
 */
export function reconcileValidatedCartSnapshot(
  validation: CartValidationResult,
): boolean {
  const state = cartStore.get();
  const updates: CartLineItemUpdate[] = [];
  const rekeys: Array<{ key: string; hash: string; properties: CartLineProperty[] }> = [];

  for (const validatedItem of validation.items) {
    const key = resolveCartKeyForValidatedLine(validatedItem, state.items);
    if (!key) continue;

    const currentItem = state.items[key];
    if (!currentItem) continue;

    const properties = serverProperties(validatedItem);
    if (
      typeof validatedItem.propertiesHash === "string" &&
      properties &&
      validatedItem.propertiesHash !== (currentItem.propertiesHash ?? "none")
    ) {
      rekeys.push({ key, hash: validatedItem.propertiesHash, properties });
      continue;
    }

    const nextImage = validatedItem.productImage ?? undefined;
    const nextImageMediaId = validatedItem.productImageMediaId ?? undefined;
    const nextKind = validatedItem.fulfillmentKind ?? currentItem.fulfillmentKind;
    // Labels only: the same keys and values (the line's identity).
    const displayChanged = properties !== undefined &&
      properties.length === (currentItem.properties?.length ?? 0) &&
      !sameDisplay(currentItem.properties, properties);
    if (
      currentItem.freeDelivery !== validatedItem.freeDelivery ||
      currentItem.image !== nextImage ||
      currentItem.imageMediaId !== nextImageMediaId ||
      currentItem.fulfillmentKind !== nextKind ||
      displayChanged
    ) {
      updates.push({
        lineKey: key,
        updates: {
          freeDelivery: validatedItem.freeDelivery,
          image: nextImage,
          imageMediaId: nextImageMediaId,
          ...(nextKind ? { fulfillmentKind: nextKind } : {}),
          ...(displayChanged ? { properties } : {}),
        },
      });
    }
  }

  const updated = updates.length > 0 && updateCartItemsByKeyAtomically(updates);
  let rekeyed = false;
  for (const { key, hash, properties } of rekeys) {
    rekeyed = rekeyCartLine(key, hash, properties) || rekeyed;
  }
  return updated || rekeyed;
}
