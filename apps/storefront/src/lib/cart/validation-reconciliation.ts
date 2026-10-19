import {
  cartStore,
  normalizeCartLineAdjustments,
  rekeyCartLine,
  updateCartItemsByKeyAtomically,
  type CartLineAdjustment,
  type CartLineItemUpdate,
  type CartLineProperty,
} from "../../store/cart";
import type { CartValidationIssue, CartValidationItem, CartValidationResult } from "../api/orders";
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

function sameAdjustments(current: CartLineAdjustment[] | undefined, next: CartLineAdjustment[]): boolean {
  const left = current ?? [];
  return left.length === next.length && left.every((entry, index) =>
    entry.label === next[index]!.label && entry.displayValue === next[index]!.displayValue && entry.priceMinor === next[index]!.priceMinor);
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
 * flag, fulfilment kind, the labels of its buyer inputs and the apps'
 * add-ons priced into it (display only). When the server
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
    }

    const nextImage = validatedItem.productImage ?? undefined;
    const nextImageMediaId = validatedItem.productImageMediaId ?? undefined;
    const nextKind = validatedItem.fulfillmentKind ?? currentItem.fulfillmentKind;
    // Labels only: the same keys and values (the line's identity).
    const displayChanged = (!validatedItem.propertiesHash || validatedItem.propertiesHash === (currentItem.propertiesHash ?? "none")) &&
      properties !== undefined &&
      properties.length === (currentItem.properties?.length ?? 0) &&
      !sameDisplay(currentItem.properties, properties);
    const adjustments = normalizeCartLineAdjustments(validatedItem.adjustments);
    const adjustmentsChanged = !sameAdjustments(currentItem.adjustments, adjustments);
    if (
      currentItem.freeDelivery !== validatedItem.freeDelivery ||
      currentItem.image !== nextImage ||
      currentItem.imageMediaId !== nextImageMediaId ||
      currentItem.fulfillmentKind !== nextKind ||
      displayChanged ||
      adjustmentsChanged
    ) {
      updates.push({
        lineKey: key,
        updates: {
          freeDelivery: validatedItem.freeDelivery,
          image: nextImage,
          imageMediaId: nextImageMediaId,
          ...(nextKind ? { fulfillmentKind: nextKind } : {}),
          ...(displayChanged ? { properties } : {}),
          ...(adjustmentsChanged ? { adjustments } : {}),
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

const CART_CURRENCY_KEY = "scalius_cart_currency";

function readCartCurrency(): string | null {
  try {
    return localStorage.getItem(CART_CURRENCY_KEY);
  } catch {
    return null;
  }
}

function writeCartCurrency(code: string): void {
  try {
    localStorage.setItem(CART_CURRENCY_KEY, code);
  } catch {
    // A cart without storage re-prices with the buyer's repair actions instead.
  }
}

/**
 * A cart moved to a market in another currency re-prices (MARKETS-DESIGN
 * step 6, Shopify's rule): every line whose price changed only because the
 * currency did takes the server's price at once, without a "price changed"
 * warning. Returns the issues left for the buyer. The currency the cart was
 * last priced in is a per-browser convenience (localStorage); without it the
 * buyer repairs the lines as usual.
 */
export function repriceCartForCurrency(
  validation: Pick<CartValidationResult, "currencyCode">,
  issues: readonly CartValidationIssue[],
): CartValidationIssue[] {
  const code = validation.currencyCode;
  if (!code) return [...issues];
  const previous = readCartCurrency();
  writeCartCurrency(code);
  if (!previous || previous === code) return [...issues];
  const repriced = issues.filter((issue) =>
    issue.code === "PRICE_CHANGED" && typeof issue.currentPrice === "number" && typeof issue.cartKey === "string" && cartStore.get().items[issue.cartKey]);
  if (repriced.length === 0) return [...issues];
  updateCartItemsByKeyAtomically(repriced.map((issue) => ({
    lineKey: issue.cartKey!,
    updates: { price: issue.currentPrice! },
  })));
  return issues.filter((issue) => !repriced.includes(issue));
}
