import { translate } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";
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
  if (remaining === 0) return translate(orderFormMessages, "outOfStock");
  return alreadyStaged > 0
    ? translate(orderFormMessages, "availableMore", { count: remaining, staged: alreadyStaged })
    : translate(orderFormMessages, "available", { count: remaining });
}

export function exceededStockMessage(remaining: number): string {
  return remaining === 0
    ? translate(orderFormMessages, "outOfStock")
    : translate(orderFormMessages, "onlyAvailable", { count: remaining });
}
