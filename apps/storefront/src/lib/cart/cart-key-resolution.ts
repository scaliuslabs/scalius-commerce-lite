import type { CartItem } from "../../store/cart";

export type CartLineIdentity = {
  cartKey?: string | null;
  index: number;
  productId: string;
  variantId: string | null;
};

function normalizedCartKey(cartKey: string | null | undefined): string | null {
  const trimmed = cartKey?.trim();
  return trimmed ? trimmed : null;
}

export function resolveCartKeyForValidatedLine(
  line: CartLineIdentity,
  items: Record<string, CartItem>,
): string | null {
  const explicitCartKey = normalizedCartKey(line.cartKey);
  return explicitCartKey &&
    Object.prototype.hasOwnProperty.call(items, explicitCartKey)
    ? explicitCartKey
    : null;
}
