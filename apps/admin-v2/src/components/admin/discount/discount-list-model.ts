import { formatPrice } from "@scalius/shared/currency";

import type { DiscountItem } from "../data-table/columns/discount-columns";

export type DiscountLifecycle =
  | "active"
  | "inactive"
  | "scheduled"
  | "expired"
  | "deleted";

export function getDiscountTypeLabel(type: string): string {
  switch (type) {
    case "amount_off_products":
      return "Amount off products";
    case "amount_off_order":
      return "Amount off order";
    case "free_shipping":
      return "Free shipping";
    default:
      return type.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
}

export function getDiscountValueLabel(
  discount: DiscountItem,
  symbol: string,
): string {
  switch (discount.valueType) {
    case "percentage":
      return `${discount.discountValue}% off`;
    case "fixed_amount":
      return `${formatPrice(discount.discountValue, { symbol })} off`;
    case "free":
      return "Free";
    default:
      return discount.discountValue.toString();
  }
}

function parseDate(value: string | null): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function getDiscountLifecycle(
  discount: DiscountItem,
  now: Date = new Date(),
): DiscountLifecycle {
  if (discount.deletedAt) return "deleted";

  const currentTime = now.getTime();
  const endTime = parseDate(discount.endDate);
  if (
    endTime !== null &&
    Math.floor(endTime / 1_000) < Math.floor(currentTime / 1_000)
  ) {
    return "expired";
  }

  const startTime = parseDate(discount.startDate);
  if (discount.isActive && startTime !== null && startTime > currentTime) {
    return "scheduled";
  }

  return discount.isActive ? "active" : "inactive";
}

export function getDiscountOutcome(
  discount: DiscountItem,
  symbol: string,
): string {
  const value = getDiscountValueLabel(discount, symbol);

  if (discount.type === "amount_off_order") {
    return `${value} the merchandise subtotal`;
  }
  if (discount.type === "free_shipping") {
    return "Free delivery for eligible orders";
  }

  const productCount = discount.relatedProducts.get.length;
  const collectionCount = discount.relatedCollections.get.length;
  const targets = [
    productCount > 0
      ? `${productCount} ${productCount === 1 ? "product" : "products"}`
      : null,
    collectionCount > 0
      ? `${collectionCount} ${collectionCount === 1 ? "collection" : "collections"}`
      : null,
  ].filter(Boolean);

  return targets.length > 0
    ? `${value} ${targets.join(" and ")}`
    : `${value} selected merchandise`;
}

export function getDiscountRequirement(discount: DiscountItem, symbol: string): string {
  if (discount.minPurchaseAmount) {
    return `Minimum ${formatPrice(discount.minPurchaseAmount, { symbol })}`;
  }
  if (discount.minQuantity) {
    return `Minimum ${discount.minQuantity} ${discount.minQuantity === 1 ? "item" : "items"}`;
  }
  return "No minimum";
}
