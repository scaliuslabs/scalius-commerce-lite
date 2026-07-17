import type { Product } from "./types";

type ProductVariant = Product["variants"][number];

export function orderItemVariantLabel(variant: ProductVariant | undefined): string {
  if (!variant) return "—";
  return variant.selectedOptions
    .map((option) => `${option.name}: ${option.value}`)
    .join(", ") || (variant.isDefault ? "Product SKU" : variant.sku || "SKU");
}
