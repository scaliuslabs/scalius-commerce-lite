export const PRODUCT_OPTION_STANDARD_MAPPINGS = [
  "size",
  "color",
  "material",
  "pattern",
  "none",
] as const;

export type ProductOptionStandardMapping =
  (typeof PRODUCT_OPTION_STANDARD_MAPPINGS)[number];

/** Maximum ordered customer-choice axes supported by one product. */
export const MAX_PRODUCT_OPTION_AXES = 5;

/** Maximum sellable Cartesian combinations accepted by one atomic matrix write. */
export const MAX_PRODUCT_OPTION_COMBINATIONS = 150;

/** Highest on-hand quantity one SKU can hold. */
export const MAX_SKU_STOCK = 1_000_000;

/** Heaviest SKU weight, in grams (one tonne). */
export const MAX_SKU_WEIGHT_GRAMS = 1_000_000;

export function normalizeProductOptionIdentity(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export function isProductOptionStandardMapping(
  value: unknown,
): value is ProductOptionStandardMapping {
  return PRODUCT_OPTION_STANDARD_MAPPINGS.includes(
    value as ProductOptionStandardMapping,
  );
}
