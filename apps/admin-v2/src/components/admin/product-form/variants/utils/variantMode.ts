import type { ProductVariant } from "../types";

export type VariantManagementMode =
  | { mode: "simple"; variant: ProductVariant }
  | { mode: "optioned"; variants: ProductVariant[]; hiddenSimpleSku: ProductVariant | null }
  | { mode: "empty" }
  | { mode: "ambiguous"; variants: ProductVariant[] };

function normalizeOption(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function hasCustomerOption(variant: Pick<ProductVariant, "size" | "color">): boolean {
  return Boolean(normalizeOption(variant.size) || normalizeOption(variant.color));
}

export function isSimpleDefaultVariant(
  variant: Pick<ProductVariant, "isDefault" | "size" | "color">,
): boolean {
  return variant.isDefault === true;
}

export function getVariantManagementMode(variants: ProductVariant[]): VariantManagementMode {
  if (variants.length === 0) {
    return { mode: "empty" };
  }

  const defaultVariants = variants.filter((variant) => variant.isDefault === true);
  if (defaultVariants.length > 1) {
    return { mode: "ambiguous", variants };
  }

  const optionVariants = variants.filter((variant) => !variant.isDefault && hasCustomerOption(variant));
  const malformedNoOptionVariants = variants.filter((variant) => !variant.isDefault && !hasCustomerOption(variant));
  if (optionVariants.length > 0) {
    if (malformedNoOptionVariants.length > 0) {
      return { mode: "ambiguous", variants };
    }

    return {
      mode: "optioned",
      variants: optionVariants,
      hiddenSimpleSku: defaultVariants[0] ?? null,
    };
  }

  if (variants.length === 1 && isSimpleDefaultVariant(variants[0])) {
    return { mode: "simple", variant: variants[0] };
  }

  return { mode: "ambiguous", variants };
}

export function variantsForOptionMatrix(variants: ProductVariant[]): ProductVariant[] {
  const mode = getVariantManagementMode(variants);
  return mode.mode === "optioned" ? mode.variants : variants;
}
