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

function isActiveVariant(variant: Pick<ProductVariant, "deletedAt">): boolean {
  return variant.deletedAt === null;
}

export function getVariantManagementMode(variants: ProductVariant[]): VariantManagementMode {
  const activeVariants = variants.filter(isActiveVariant);

  if (activeVariants.length === 0) {
    return { mode: "empty" };
  }

  const defaultVariants = activeVariants.filter((variant) => variant.isDefault === true);
  if (defaultVariants.length > 1) {
    return { mode: "ambiguous", variants: activeVariants };
  }

  const optionVariants = activeVariants.filter((variant) => !variant.isDefault && hasCustomerOption(variant));
  const malformedNoOptionVariants = activeVariants.filter((variant) => !variant.isDefault && !hasCustomerOption(variant));
  if (optionVariants.length > 0) {
    if (malformedNoOptionVariants.length > 0) {
      return { mode: "ambiguous", variants: activeVariants };
    }

    return {
      mode: "optioned",
      variants: optionVariants,
      hiddenSimpleSku: defaultVariants[0] ?? null,
    };
  }

  if (activeVariants.length === 1 && isSimpleDefaultVariant(activeVariants[0])) {
    return { mode: "simple", variant: activeVariants[0] };
  }

  return { mode: "ambiguous", variants: activeVariants };
}

export function variantsForOptionMatrix(variants: ProductVariant[]): ProductVariant[] {
  const mode = getVariantManagementMode(variants);
  if (mode.mode === "optioned" || mode.mode === "ambiguous") {
    return mode.variants;
  }
  if (mode.mode === "simple") {
    return [mode.variant];
  }
  return [];
}
