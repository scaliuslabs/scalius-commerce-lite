import { translate } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";
import type { Product } from "./types";

type ProductVariant = Product["variants"][number];

export function orderItemVariantLabel(variant: ProductVariant | undefined): string {
  if (!variant) return "—";
  return variant.selectedOptions
    .map((option) => `${option.name}: ${option.value}`)
    .join(", ")
    || (variant.isDefault ? translate(orderFormMessages, "defaultVariant") : variant.sku || "—");
}

/**
 * Unit price after the catalog discount: a variant discount overrides the
 * product discount. The server quote stays the source of the saved total.
 */
export function discountedUnitPrice(
  product: Product,
  variant: ProductVariant | null | undefined,
): number {
  const basePrice = variant ? variant.price : product.price;
  if (variant?.discountType === "flat" && variant.discountAmount && variant.discountAmount > 0) {
    return Math.max(0, basePrice - variant.discountAmount);
  }
  if (
    variant?.discountType === "percentage"
    && variant.discountPercentage
    && variant.discountPercentage > 0
  ) {
    return basePrice - basePrice * (variant.discountPercentage / 100);
  }
  if (product.discountType === "flat" && product.discountAmount && product.discountAmount > 0) {
    return Math.max(0, basePrice - product.discountAmount);
  }
  if (product.discountPercentage && product.discountPercentage > 0) {
    return basePrice - basePrice * (product.discountPercentage / 100);
  }
  return basePrice;
}
