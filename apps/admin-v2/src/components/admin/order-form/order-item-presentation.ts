import type { Product } from "./types";

type ProductVariant = Product["variants"][number];

/**
 * The option choice for a line ("Size: L, Color: Black"). A simple product's
 * one default SKU has no label: the product name says it all.
 */
export function orderItemVariantLabel(variant: ProductVariant | undefined): string {
  if (!variant) return "—";
  return variant.selectedOptions
    .map((option) => `${option.name}: ${option.value}`)
    .join(", ")
    || (variant.isDefault ? "" : variant.sku || "—");
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
