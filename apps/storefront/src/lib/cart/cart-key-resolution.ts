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

function normalizedVariantId(variantId: string | null | undefined): string | null {
  return variantId && variantId !== "default" ? variantId : null;
}

export function resolveCartKeyForValidatedLine(
  line: CartLineIdentity,
  items: Record<string, CartItem>,
): string | null {
  const explicitCartKey = normalizedCartKey(line.cartKey);
  if (explicitCartKey) {
    return Object.prototype.hasOwnProperty.call(items, explicitCartKey)
      ? explicitCartKey
      : null;
  }

  const lineVariantId = normalizedVariantId(line.variantId);
  const productVariantMatch = Object.entries(items).find(([, item]) => (
    item.id === line.productId
    && normalizedVariantId(item.variantId) === lineVariantId
  ));
  if (productVariantMatch) return productVariantMatch[0];

  return Object.keys(items)[line.index] ?? null;
}
