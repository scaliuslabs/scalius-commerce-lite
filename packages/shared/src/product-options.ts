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

export const PRODUCT_VARIANT_OPTION_AXES = [
  "option1",
  "option2",
  "option1_option2",
] as const;

/** Maximum option SKUs accepted by one atomic product edit plan. */
export const MAX_PRODUCT_OPTION_COMBINATIONS = 150;

export type ProductVariantOptionAxis =
  (typeof PRODUCT_VARIANT_OPTION_AXES)[number];

export type ProductVariantOptionTopology =
  | "none"
  | "mixed"
  | ProductVariantOptionAxis;

type ProductVariantOptionValues = {
  size?: string | null;
  color?: string | null;
};

function hasSavedOptionValue(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

export function getProductVariantOptionAxis(
  variant: ProductVariantOptionValues,
): ProductVariantOptionAxis | null {
  const hasOption1 = hasSavedOptionValue(variant.size);
  const hasOption2 = hasSavedOptionValue(variant.color);

  if (hasOption1 && hasOption2) return "option1_option2";
  if (hasOption1) return "option1";
  if (hasOption2) return "option2";
  return null;
}

/**
 * Classifies one product's active non-default SKU rows by their saved option
 * fields. No-option rows do not contribute an axis; callers separately decide
 * whether such a row is a protected default SKU or an invalid normal SKU.
 * Callers must filter deleted rows before using this helper.
 */
export function classifyProductVariantOptionAxes(
  variants: readonly ProductVariantOptionValues[],
): ProductVariantOptionTopology {
  let axis: ProductVariantOptionAxis | null = null;

  for (const variant of variants) {
    const candidate = getProductVariantOptionAxis(variant);
    if (!candidate) continue;
    if (axis && axis !== candidate) return "mixed";
    axis = candidate;
  }

  return axis ?? "none";
}

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
