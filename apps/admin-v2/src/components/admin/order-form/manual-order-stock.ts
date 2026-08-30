import type { OrderItem, Product } from "./types";

type ProductVariant = Product["variants"][number];

export function trackedAvailableStock(
  variant: ProductVariant | null | undefined,
): number | null {
  if (!variant || variant.trackInventory === false) return null;
  return Math.max(0, (variant.stock ?? 0) - (variant.reservedStock ?? 0));
}

export function stagedVariantQuantity(
  items: readonly OrderItem[],
  variantId: string,
  excludeIndex?: number,
): number {
  return items.reduce((total, item, index) => {
    if (index === excludeIndex || item.variantId !== variantId) return total;
    return total + item.quantity;
  }, 0);
}

export function remainingStockForNewOrderLine(
  variant: ProductVariant | null | undefined,
  items: readonly OrderItem[],
  excludeIndex?: number,
): number | null {
  const available = trackedAvailableStock(variant);
  if (available === null || !variant) return null;

  return Math.max(
    0,
    available - stagedVariantQuantity(items, variant.id, excludeIndex),
  );
}

export function remainingStockMessage(
  remaining: number,
  alreadyStaged = 0,
): string {
  if (remaining === 0) {
    return "Out of stock. This SKU cannot be added to a confirmed order.";
  }

  const suffix = alreadyStaged > 0
    ? ` (${alreadyStaged} already staged).`
    : ".";
  return `${remaining}${alreadyStaged > 0 ? " more" : ""} available for this order${suffix}`;
}

export function exceededStockMessage(remaining: number): string {
  return remaining === 0
    ? "This SKU is out of stock."
    : `Only ${remaining} ${remaining === 1 ? "unit is" : "units are"} available for this order.`;
}
