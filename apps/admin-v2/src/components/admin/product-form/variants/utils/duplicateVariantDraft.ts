import type { ProductVariant, VariantFormValues } from "../types";

/**
 * Starts a duplicate as a new unsaved identity. One populated option axis is
 * cleared so the merchant must choose a different combination before create.
 */
export function buildDuplicateVariantDraft(
  source: ProductVariant,
): Partial<VariantFormValues> {
  return {
    size: source.color ? source.size : "",
    color: source.color ? "" : source.color,
    weight: source.weight,
    sku: "",
    barcode: null,
    barcodeType: null,
    price: source.price,
    stock: 0,
    trackInventory: source.trackInventory ?? true,
    discountType: source.discountType,
    discountPercentage: source.discountPercentage,
    discountAmount: source.discountAmount,
  };
}
