export const PRODUCT_CONDITION_VALUES = ["new", "refurbished", "used"] as const;

export type ProductCondition = (typeof PRODUCT_CONDITION_VALUES)[number];

export const DEFAULT_PRODUCT_CONDITION: ProductCondition = "new";

export const PRODUCT_CONDITION_LABELS = {
  new: "New",
  refurbished: "Refurbished",
  used: "Used",
} as const satisfies Record<ProductCondition, string>;

export const PRODUCT_CONDITION_SCHEMA_URLS = {
  new: "https://schema.org/NewCondition",
  refurbished: "https://schema.org/RefurbishedCondition",
  used: "https://schema.org/UsedCondition",
} as const satisfies Record<ProductCondition, string>;

export function normalizeSavedProductCondition(
  value: string | null | undefined,
): ProductCondition | null {
  return PRODUCT_CONDITION_VALUES.includes(value as ProductCondition)
    ? (value as ProductCondition)
    : null;
}
