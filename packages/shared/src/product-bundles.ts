/**
 * Quantity bundles (migration 0090 `product_bundles`): "2 for 10% off",
 * "3 for ৳900". A tier applies to units of one product (any of its SKUs) in
 * one cart line group; the buyer gets the deepest active tier whose quantity
 * the group reaches. Checkout prices it with this math, so the product page,
 * the landing pack picker and the order total always agree; it is never a
 * display-only discount. Money is integer minor units.
 *
 * - `percentage`: every unit in the group is priced like a percentage
 *   catalog discount (`discountedPriceMinor`, half-up to the cash unit).
 * - `fixed_price`: each complete set of `quantity` units costs `priceMinor`;
 *   leftover units pay the unit price. A set never costs more than buying the
 *   units one by one.
 */
import { z } from "zod";
import { discountedPriceMinor } from "./money";

export const PRODUCT_BUNDLE_DISCOUNT_TYPES = ["percentage", "fixed_price"] as const;
export type ProductBundleDiscountType = (typeof PRODUCT_BUNDLE_DISCOUNT_TYPES)[number];
export const PRODUCT_BUNDLE_MIN_QUANTITY = 2;
export const PRODUCT_BUNDLE_MAX_QUANTITY = 100;
export const PRODUCT_BUNDLES_MAX = 6;

export const productBundleTierSchema = z.discriminatedUnion("discountType", [
  z.object({
    quantity: z.number().int().min(PRODUCT_BUNDLE_MIN_QUANTITY).max(PRODUCT_BUNDLE_MAX_QUANTITY),
    discountType: z.literal("percentage"),
    discountBps: z.number().int().min(1).max(9_999),
    label: z.string().trim().min(1).max(60).nullable(),
    isActive: z.boolean(),
  }).strict(),
  z.object({
    quantity: z.number().int().min(PRODUCT_BUNDLE_MIN_QUANTITY).max(PRODUCT_BUNDLE_MAX_QUANTITY),
    discountType: z.literal("fixed_price"),
    priceMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    label: z.string().trim().min(1).max(60).nullable(),
    isActive: z.boolean(),
  }).strict(),
]);
export type ProductBundleTier = z.infer<typeof productBundleTierSchema>;

export const productBundleTierListSchema = z.array(productBundleTierSchema).max(PRODUCT_BUNDLES_MAX)
  .refine((tiers) => new Set(tiers.map((tier) => tier.quantity)).size === tiers.length, "Each quantity has one tier.");

/** The deepest active tier the quantity reaches, or null. */
export function selectBundleTier(quantity: number, tiers: readonly ProductBundleTier[]): ProductBundleTier | null {
  let best: ProductBundleTier | null = null;
  for (const tier of tiers) {
    if (!tier.isActive || tier.quantity > quantity) continue;
    if (!best || tier.quantity > best.quantity) best = tier;
  }
  return best;
}

/**
 * What `quantity` units at `unitPriceMinor` (the price after catalog
 * discounts) cost under the best tier, and the saving against buying them
 * one by one.
 */
export function bundleTotalMinor(
  unitPriceMinor: number,
  quantity: number,
  tiers: readonly ProductBundleTier[],
  currencyCode: string,
): { totalMinor: number; savingMinor: number; tier: ProductBundleTier | null } {
  if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor < 0) {
    throw new RangeError("Unit prices are non-negative integer minor units.");
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new RangeError("Quantity is a positive integer.");
  const plainMinor = unitPriceMinor * quantity;
  if (!Number.isSafeInteger(plainMinor)) throw new RangeError("The line total exceeds the supported range.");
  const tier = selectBundleTier(quantity, tiers);
  if (!tier) return { totalMinor: plainMinor, savingMinor: 0, tier: null };
  let totalMinor: number;
  if (tier.discountType === "percentage") {
    totalMinor = discountedPriceMinor(unitPriceMinor, "percentage", tier.discountBps, 0, currencyCode) * quantity;
  } else {
    const sets = Math.floor(quantity / tier.quantity);
    const setMinor = Math.min(tier.priceMinor, unitPriceMinor * tier.quantity);
    totalMinor = sets * setMinor + (quantity - sets * tier.quantity) * unitPriceMinor;
  }
  totalMinor = Math.min(totalMinor, plainMinor);
  return { totalMinor, savingMinor: plainMinor - totalMinor, tier };
}
