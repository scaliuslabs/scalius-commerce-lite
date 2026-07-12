import type { ProductVariant } from "@/lib/api/types";

type BuyerVariant = Pick<
  ProductVariant,
  | "id"
  | "deletedAt"
  | "isDefault"
  | "optionCombinationKey"
  | "stock"
  | "reservedStock"
  | "trackInventory"
>;

export type BuyerProductMode =
  | "simple"
  | "optioned"
  | "unavailable"
  | "ambiguous";

export interface BuyerVariantResolution<TVariant extends BuyerVariant> {
  mode: BuyerProductMode;
  variants: TVariant[];
  hasCustomerOptions: boolean;
}

export function hasCustomerOption(
  variant: Pick<BuyerVariant, "optionCombinationKey">,
): boolean {
  return Boolean(variant.optionCombinationKey?.trim());
}

export function isActivePersistedVariant(
  variant: Pick<BuyerVariant, "id" | "deletedAt">,
): boolean {
  return !variant.deletedAt && variant.id !== "default";
}

export function isVariantAvailable(
  variant: Pick<BuyerVariant, "stock" | "reservedStock" | "trackInventory">,
): boolean {
  return (
    variant.trackInventory === false ||
    Math.max(0, variant.stock - (variant.reservedStock ?? 0)) > 0
  );
}

export function availableQuantityForVariant(
  variant: Pick<BuyerVariant, "stock" | "reservedStock" | "trackInventory">,
): number | null {
  if (variant.trackInventory === false) return null;
  return Math.max(0, variant.stock - (variant.reservedStock ?? 0));
}

export function resolveBuyerVariants<TVariant extends BuyerVariant>(
  variants: readonly TVariant[],
): BuyerVariantResolution<TVariant> {
  const activeVariants = variants.filter(isActivePersistedVariant);
  const activeNonDefaultVariants = activeVariants.filter(
    (variant) => !variant.isDefault,
  );
  const optionVariants = activeVariants.filter(
    (variant) => !variant.isDefault && hasCustomerOption(variant),
  );

  if (optionVariants.length > 0) {
    if (activeNonDefaultVariants.some((variant) => !hasCustomerOption(variant))) {
      return {
        mode: "ambiguous",
        variants: [],
        hasCustomerOptions: true,
      };
    }

    return {
      mode: "optioned",
      variants: optionVariants,
      hasCustomerOptions: true,
    };
  }

  if (
    activeVariants.length === 1 &&
    activeVariants[0]?.isDefault === true &&
    !hasCustomerOption(activeVariants[0])
  ) {
    return {
      mode: "simple",
      variants: [activeVariants[0]!],
      hasCustomerOptions: false,
    };
  }

  return {
    mode: activeVariants.length === 0 ? "unavailable" : "ambiguous",
    variants: [],
    hasCustomerOptions: false,
  };
}

export function getBuyerStockSummary(
  variants: readonly Pick<
    BuyerVariant,
    "stock" | "reservedStock" | "trackInventory"
  >[],
): {
  canPurchaseAny: boolean;
  text: "Unavailable" | "In Stock" | "Low Stock" | "Out of Stock";
  tone: "available" | "unavailable";
} {
  if (variants.length === 0) {
    return { canPurchaseAny: false, text: "Unavailable", tone: "unavailable" };
  }

  if (variants.some((variant) => variant.trackInventory === false)) {
    return { canPurchaseAny: true, text: "In Stock", tone: "available" };
  }

  const totalAvailable = variants.reduce(
    (sum, variant) =>
      sum + Math.max(0, variant.stock - (variant.reservedStock ?? 0)),
    0,
  );

  if (totalAvailable > 50) {
    return { canPurchaseAny: true, text: "In Stock", tone: "available" };
  }
  if (totalAvailable > 0) {
    return { canPurchaseAny: true, text: "Low Stock", tone: "available" };
  }
  return { canPurchaseAny: false, text: "Out of Stock", tone: "unavailable" };
}
