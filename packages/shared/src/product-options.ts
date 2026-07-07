export const PRODUCT_OPTION_SCHEMA_VALUES = [
  "size",
  "color",
  "material",
  "pattern",
  "none",
] as const;

export type ProductOptionSchema = (typeof PRODUCT_OPTION_SCHEMA_VALUES)[number];

export const DEFAULT_PRODUCT_OPTION_LABELS = {
  option1: "Size",
  option2: "Color",
} as const;

export const DEFAULT_PRODUCT_OPTION_SCHEMA = {
  option1: "size",
  option2: "color",
} as const satisfies Record<"option1" | "option2", ProductOptionSchema>;

export function normalizeProductOptionLabel(
  value: string | null | undefined,
  fallback: string,
): string {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 40) : fallback;
}

export function normalizeProductOptionSchema(
  value: string | null | undefined,
  fallback: ProductOptionSchema,
): ProductOptionSchema {
  return PRODUCT_OPTION_SCHEMA_VALUES.includes(value as ProductOptionSchema)
    ? (value as ProductOptionSchema)
    : fallback;
}
