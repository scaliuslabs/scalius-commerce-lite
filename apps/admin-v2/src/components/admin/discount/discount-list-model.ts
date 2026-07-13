import { formatPrice } from "@scalius/shared/currency";

import type { DiscountItem } from "../data-table/columns/discount-columns";
import { formatDiscountRequirement } from "./discount-rule-presentation";

export type DiscountLifecycle =
  | "active"
  | "inactive"
  | "scheduled"
  | "exhausted"
  | "expired"
  | "deleted";

export type DiscountReadinessIssueCode =
  | "invalid_type"
  | "invalid_value"
  | "missing_scope"
  | "ignored_scope"
  | "unsupported_segment"
  | "unsupported_combination"
  | "unsupported_per_order_limit"
  | "invalid_requirement"
  | "invalid_schedule";

export interface DiscountReadinessIssue {
  code: DiscountReadinessIssueCode;
  message: string;
}

const supportedDiscountTypes = new Set([
  "amount_off_products",
  "amount_off_order",
  "free_shipping",
]);

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

  if (
    discount.isActive &&
    discount.maxUses !== null &&
    discount.maxUses > 0 &&
    discount.usageCount !== undefined &&
    discount.usageCount >= discount.maxUses
  ) {
    return "exhausted";
  }

  return discount.isActive ? "active" : "inactive";
}

export function getDiscountReadinessIssues(
  discount: DiscountItem,
): DiscountReadinessIssue[] {
  const issues: DiscountReadinessIssue[] = [];
  const productCount = discount.relatedProducts.get.length;
  const collectionCount = discount.relatedCollections.get.length;
  const scopeCount = productCount + collectionCount;

  if (!supportedDiscountTypes.has(discount.type)) {
    issues.push({
      code: "invalid_type",
      message: "This discount type is not supported by checkout.",
    });
  }

  const valueIsInvalid =
    !Number.isFinite(discount.discountValue) ||
    discount.discountValue <= 0 ||
    (discount.valueType === "percentage" && discount.discountValue > 100) ||
    (discount.type === "free_shipping" && discount.valueType !== "free") ||
    (discount.type !== "free_shipping" &&
      discount.valueType !== "percentage" &&
      discount.valueType !== "fixed_amount");
  if (valueIsInvalid) {
    issues.push({
      code: "invalid_value",
      message: "The saved value does not match this discount type.",
    });
  }

  if (discount.type === "amount_off_products" && scopeCount === 0) {
    issues.push({
      code: "missing_scope",
      message: "Choose at least one product or collection before using this code.",
    });
  } else if (discount.type !== "amount_off_products" && scopeCount > 0) {
    issues.push({
      code: "ignored_scope",
      message: "Saved product targets are ignored by this order-wide discount.",
    });
  }

  if (discount.customerSegment?.trim()) {
    issues.push({
      code: "unsupported_segment",
      message: "The saved customer segment is not enforced by checkout.",
    });
  }

  if (
    discount.combineWithProductDiscounts ||
    discount.combineWithOrderDiscounts ||
    discount.combineWithShippingDiscounts
  ) {
    issues.push({
      code: "unsupported_combination",
      message: "Saved combination settings are not enforced; checkout accepts one code.",
    });
  }

  if (
    discount.maxUsesPerOrder !== null &&
    discount.maxUsesPerOrder !== 1
  ) {
    issues.push({
      code: "unsupported_per_order_limit",
      message: "Checkout supports one use of one discount code per order.",
    });
  }

  const hasInvalidRequirement =
    (discount.minPurchaseAmount !== null &&
      (!Number.isFinite(discount.minPurchaseAmount) ||
        discount.minPurchaseAmount <= 0)) ||
    (discount.minQuantity !== null &&
      (!Number.isInteger(discount.minQuantity) || discount.minQuantity <= 0)) ||
    (discount.maxUses !== null &&
      (!Number.isInteger(discount.maxUses) || discount.maxUses <= 0));
  if (hasInvalidRequirement) {
    issues.push({
      code: "invalid_requirement",
      message: "Saved minimums must be positive; quantity and usage limits must be whole numbers.",
    });
  }

  const startTime = parseDate(discount.startDate);
  const endTime = parseDate(discount.endDate);
  if (
    startTime === null ||
    (discount.endDate !== null && endTime === null) ||
    (endTime !== null && startTime !== null && endTime <= startTime)
  ) {
    issues.push({
      code: "invalid_schedule",
      message: "The saved schedule is invalid and must be reviewed.",
    });
  }

  return issues;
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
  return formatDiscountRequirement({
    minPurchaseAmount: discount.minPurchaseAmount,
    minQuantity: discount.minQuantity,
    symbol,
  });
}
