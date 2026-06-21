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
  return variant.isDefault === true && !hasCustomerOption(variant);
}

export function getVariantManagementMode(variants: ProductVariant[]): VariantManagementMode {
  if (variants.length === 0) {
    return { mode: "empty" };
  }

  if (variants.some((variant) => variant.isDefault === true && hasCustomerOption(variant))) {
    return { mode: "ambiguous", variants };
  }

  const optionVariants = variants.filter(hasCustomerOption);
  const noOptionVariants = variants.filter((variant) => !hasCustomerOption(variant));
  if (optionVariants.length > 0) {
    if (noOptionVariants.length > 1) {
      return { mode: "ambiguous", variants };
    }

    const hiddenSimpleSku = noOptionVariants[0];
    if (hiddenSimpleSku && !isSimpleDefaultVariant(hiddenSimpleSku)) {
      return { mode: "ambiguous", variants };
    }

    return {
      mode: "optioned",
      variants: optionVariants,
      hiddenSimpleSku: hiddenSimpleSku ?? null,
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
