import type { ProductOptionDefinition, ProductVariant } from "@/lib/api";
import { isVariantAvailable } from "@/lib/product-sellable-variants";

export type Variant = ProductVariant & {
  discountedPrice?: number;
  discount?: number;
};

export type VariantOptionAvailability = "available" | "incompatible" | "sold_out";
export type VariantSelection = Record<string, string>;

export function isVariantPurchasable(variant: Pick<Variant, "trackInventory" | "stock" | "reservedStock" | "availabilityBand">): boolean {
  return isVariantAvailable(variant);
}

export function selectedValueMap(variant: Pick<Variant, "selectedOptions">): VariantSelection {
  return Object.fromEntries(
    variant.selectedOptions.map((option) => [option.optionDefinitionId, option.optionValueId]),
  );
}

export function variantMatchesSelection(
  variant: Pick<Variant, "selectedOptions">,
  selection: VariantSelection,
): boolean {
  const values = selectedValueMap(variant);
  return Object.entries(selection).every(([definitionId, valueId]) => values[definitionId] === valueId);
}

export function filterVariantsBySelection(
  variants: Variant[],
  selection: VariantSelection,
): Variant[] {
  return variants.filter((variant) => variantMatchesSelection(variant, selection));
}

export function resolveVariantImageForSelection(
  variants: Variant[],
  selection: VariantSelection,
): string | null {
  if (Object.keys(selection).length === 0) return null;
  const candidates = filterVariantsBySelection(variants, selection);
  if (candidates.length === 0) return null;
  const imageIds = new Set(candidates.map((variant) => variant.imageId ?? null));
  return imageIds.size === 1 ? (candidates[0]?.imageId ?? null) : null;
}

export function resolveExactVariantSelection(
  variants: Variant[],
  selection: VariantSelection | { variantId?: string | null },
): { variant: Variant; selection: VariantSelection } | null {
  if (Object.prototype.hasOwnProperty.call(selection, "variantId")) {
    const variantSelection = selection as { variantId?: string | null };
    const variant = variants.find((candidate) => candidate.id === variantSelection.variantId);
    return variant ? { variant, selection: selectedValueMap(variant) } : null;
  }
  const valueSelection = selection as VariantSelection;
  const selectionCount = Object.keys(valueSelection).length;
  const variant = variants.find((candidate) =>
    candidate.selectedOptions.length === selectionCount && variantMatchesSelection(candidate, valueSelection),
  );
  return variant ? { variant, selection: selectedValueMap(variant) } : null;
}

export function resolveExactAvailableVariantSelection(
  variants: Variant[],
  selection: VariantSelection | { variantId?: string | null },
) {
  const resolved = resolveExactVariantSelection(variants, selection);
  return resolved && isVariantPurchasable(resolved.variant) ? resolved : null;
}

export function getVariantOptionAvailabilityMap(
  variants: Variant[],
  definitionId: string,
  valueIds: string[],
  selection: VariantSelection,
): Map<string, VariantOptionAvailability> {
  const withoutCurrent = { ...selection };
  delete withoutCurrent[definitionId];
  const result = new Map<string, VariantOptionAvailability>();
  for (const valueId of valueIds) {
    const globalCandidates = variants.filter((variant) => variantMatchesSelection(variant, { [definitionId]: valueId }));
    const contextualCandidates = variants.filter((variant) =>
      variantMatchesSelection(variant, { ...withoutCurrent, [definitionId]: valueId }),
    );
    if (contextualCandidates.some(isVariantPurchasable)) result.set(valueId, "available");
    else if (contextualCandidates.length > 0 || globalCandidates.every((variant) => !isVariantPurchasable(variant))) result.set(valueId, "sold_out");
    else result.set(valueId, "incompatible");
  }
  return result;
}

/**
 * Shopify's "selected or first available variant": the first purchasable SKU in
 * the merchant's option order. Nothing is selected when every SKU is sold out.
 */
export function createInitialSelection(
  options: ProductOptionDefinition[],
  variants: Variant[],
): VariantSelection {
  const rank = (variant: Variant) => {
    const values = selectedValueMap(variant);
    return options.map((option) => option.values.findIndex((value) => value.id === values[option.id]));
  };
  const firstAvailable = variants
    .filter(isVariantPurchasable)
    .map((variant) => ({ variant, rank: rank(variant) }))
    .sort((a, b) => {
      for (let i = 0; i < a.rank.length; i += 1) if (a.rank[i] !== b.rank[i]) return a.rank[i]! - b.rank[i]!;
      return 0;
    })[0]?.variant;
  return firstAvailable ? selectedValueMap(firstAvailable) : {};
}

export function reconcileSelectionForValue(
  variants: Variant[],
  definitionId: string,
  valueId: string,
  current: VariantSelection,
  optionOrder: string[],
): VariantSelection {
  const next = { ...current, [definitionId]: valueId };
  if (filterVariantsBySelection(variants, next).length > 0) return next;
  for (const otherId of [...optionOrder].reverse()) {
    if (otherId === definitionId || next[otherId] === undefined) continue;
    delete next[otherId];
    if (filterVariantsBySelection(variants, next).length > 0) break;
  }
  return next;
}

export function validateSelection(
  selection: VariantSelection,
  options: ProductOptionDefinition[],
  variants: Variant[],
): { valid: boolean; error?: string; variant?: Variant; missingOption?: ProductOptionDefinition } {
  const missing = options.find((option) => !selection[option.id]);
  if (missing) return { valid: false, error: `Select ${missing.name}.`, missingOption: missing };
  const resolved = resolveExactVariantSelection(variants, selection)?.variant;
  if (!resolved) return { valid: false, error: "That option combination is unavailable." };
  if (!isVariantPurchasable(resolved)) return { valid: false, error: "That option combination is out of stock." };
  return { valid: true, variant: resolved };
}

export function loadVariantsFromDOM(): Variant[] {
  const element = document.getElementById("product-variants-data");
  if (!element?.textContent) return [];
  try {
    const value = JSON.parse(element.textContent);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function loadOptionsFromDOM(): ProductOptionDefinition[] {
  const element = document.getElementById("product-options-data");
  if (!element?.textContent) return [];
  try {
    const value = JSON.parse(element.textContent);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function shouldShowStartingVariantPrice(
  hasCustomerOptions: boolean,
  exactVariant?: Variant | null,
): boolean {
  return hasCustomerOptions && !exactVariant;
}

/**
 * The choice the product page opens on and the SKUs its first price is read
 * from. One answer for the buy box and for the page's metadata (Open Graph,
 * Product JSON-LD, analytics), so they always state the price the buyer sees.
 * A link to a sold-out combination still shows that combination.
 */
export function initialVariantPresentation<TVariant extends Variant>(
  options: ProductOptionDefinition[],
  variants: TVariant[],
  initialVariant: TVariant | null = null,
  initialUnavailableVariant: TVariant | null = null,
): {
  selection: VariantSelection;
  selectedVariant: TVariant | null;
  stockVariant: TVariant | null;
  pricingVariants: TVariant[];
} {
  const selection = initialUnavailableVariant
    ? selectedValueMap(initialUnavailableVariant)
    : initialVariant
      ? selectedValueMap(initialVariant)
      : createInitialSelection(options, variants);
  const selectedVariant = initialVariant
    ?? (resolveExactVariantSelection(variants, selection)?.variant as TVariant | undefined)
    ?? null;
  const stockVariant = initialUnavailableVariant ?? selectedVariant;
  const pricingVariants = stockVariant
    ? [stockVariant]
    : Object.keys(selection).length
      ? (filterVariantsBySelection(variants, selection) as TVariant[])
      : variants;
  return { selection, selectedVariant, stockVariant, pricingVariants };
}
