export const BUYER_AVAILABILITY_BANDS = [
  "untracked",
  "out_of_stock",
  "low_stock",
  "in_stock",
] as const;

export type BuyerAvailabilityBand = (typeof BUYER_AVAILABILITY_BANDS)[number];

// Buyer quantity inputs are bounded to this value throughout the storefront.
// Public cached projections use it as a non-authoritative in-stock sentinel so
// exact inventory does not become stale between availability-band purges.
export const PUBLIC_BUYER_QUANTITY_CEILING = 99;

export interface BuyerAvailabilityInput {
  stock: number;
  reservedStock?: number | null;
  trackInventory?: boolean;
  lowStockThreshold?: number | null;
}

function normalizedLowStockThreshold(value: number | null | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

export function resolveBuyerAvailabilityBand(
  input: BuyerAvailabilityInput,
): BuyerAvailabilityBand {
  if (input.trackInventory === false) return "untracked";
  const available = Math.max(0, input.stock - (input.reservedStock ?? 0));
  if (available <= 0) return "out_of_stock";
  const threshold = normalizedLowStockThreshold(input.lowStockThreshold);
  return threshold > 0 && available <= threshold ? "low_stock" : "in_stock";
}

export function resolveTrackedBuyerAvailabilityBand(
  available: number,
  lowStockThreshold: number | null,
): Exclude<BuyerAvailabilityBand, "untracked"> {
  return resolveBuyerAvailabilityBand({
    stock: Math.max(0, available),
    reservedStock: 0,
    trackInventory: true,
    lowStockThreshold,
  }) as Exclude<BuyerAvailabilityBand, "untracked">;
}

/**
 * Remove exact inventory from a persistent public projection while preserving
 * the buyer-visible availability state that owns cache invalidation.
 *
 * `stock` remains as a compatibility sentinel for older storefront clients;
 * it is deliberately not an inventory fact. New consumers must use
 * `availabilityBand` and validate requested quantities against the live
 * checkout authority.
 */
export function maskPublicBuyerAvailability<
  TVariant extends BuyerAvailabilityInput,
>(variant: TVariant): TVariant & { availabilityBand: BuyerAvailabilityBand } {
  const availabilityBand = resolveBuyerAvailabilityBand(variant);
  const threshold = normalizedLowStockThreshold(variant.lowStockThreshold);
  const stock =
    availabilityBand === "out_of_stock" || availabilityBand === "untracked"
      ? 0
      : availabilityBand === "low_stock"
        ? Math.max(1, threshold)
        : Math.max(PUBLIC_BUYER_QUANTITY_CEILING, threshold + 1);

  return {
    ...variant,
    stock,
    reservedStock: 0,
    availabilityBand,
  };
}
