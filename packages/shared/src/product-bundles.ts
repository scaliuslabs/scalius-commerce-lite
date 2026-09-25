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
import { cashRoundingMinor, discountedPriceMinor } from "./money";

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

/** One cart line of a product group: its key, catalog unit price and quantity. */
export interface BundleGroupLine {
  key: string;
  /** Catalog unit price after catalog discounts, before buyer-input surcharges. */
  unitPriceMinor: number;
  quantity: number;
}

export interface BundleGroupPricing {
  /** The tier that saved money, or null. */
  tier: ProductBundleTier | null;
  /** The group's units at their catalog prices. */
  plainMinor: number;
  totalMinor: number;
  savingMinor: number;
  /** The saving of every line (zero included), in line order. */
  lineSavings: Array<{ key: string; savingMinor: number }>;
}

/**
 * Splits `amountMinor` (a multiple of `unit`) over `weights` in whole cash
 * units, largest remainder first and line order on ties, so the same cart
 * always splits the same way.
 */
function allocateCashUnits(amountMinor: number, weights: readonly number[], unit: number): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (amountMinor === 0 || total === 0) return weights.map(() => 0);
  const units = BigInt(amountMinor / unit);
  const exact = weights.map((weight) => units * BigInt(weight));
  const shares = exact.map((value) => value / BigInt(total));
  let left = units - shares.reduce((sum, share) => sum + share, 0n);
  const order = exact
    .map((value, index) => ({ index, remainder: value % BigInt(total) }))
    .sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  for (const { index } of order) {
    if (left === 0n) break;
    shares[index]! += 1n;
    left -= 1n;
  }
  return shares.map((share) => Number(share) * unit);
}

/**
 * The tier price of every unit of one product in a cart, whatever SKUs its
 * lines hold. The tier is the deepest active one the group's total quantity
 * reaches (`selectBundleTier`).
 *
 * - `percentage`: each unit is priced like a percentage catalog discount of
 *   its own unit price (half-up to the cash unit).
 * - `fixed_price`: sets of `quantity` units are formed from the dearest units
 *   first (the buyer gets the saving the tier advertises); a set costs
 *   `priceMinor` but never more than its units bought singly, and leftover
 *   units pay their own price. A set's saving is split over its units by
 *   price in whole cash units.
 *
 * With one unit price this equals `bundleTotalMinor`. With BDT's whole-taka
 * prices every saving, and every line's share of it, is whole taka.
 */
export function bundleGroupPricing(
  lines: readonly BundleGroupLine[],
  tiers: readonly ProductBundleTier[],
  currencyCode: string,
): BundleGroupPricing {
  let quantity = 0;
  let plainMinor = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) {
      throw new RangeError("Unit prices are non-negative integer minor units.");
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) throw new RangeError("Quantity is a positive integer.");
    quantity += line.quantity;
    plainMinor += line.unitPriceMinor * line.quantity;
  }
  if (!Number.isSafeInteger(plainMinor)) throw new RangeError("The group total exceeds the supported range.");
  const savings = new Map(lines.map((line) => [line.key, 0]));
  if (savings.size !== lines.length) throw new RangeError("Bundle group line keys must be unique.");
  const tier = selectBundleTier(quantity, tiers);
  if (tier?.discountType === "percentage") {
    for (const line of lines) {
      const unitMinor = discountedPriceMinor(line.unitPriceMinor, "percentage", tier.discountBps, 0, currencyCode);
      savings.set(line.key, (line.unitPriceMinor - unitMinor) * line.quantity);
    }
  } else if (tier?.discountType === "fixed_price") {
    const unit = cashRoundingMinor(currencyCode);
    // Every unit, dearest first; line order breaks ties.
    const units = lines
      .flatMap((line, index) => Array.from({ length: line.quantity }, () => ({ index, priceMinor: line.unitPriceMinor })))
      .sort((a, b) => b.priceMinor - a.priceMinor || a.index - b.index);
    const sets = Math.floor(quantity / tier.quantity);
    for (let set = 0; set < sets; set += 1) {
      const members = units.slice(set * tier.quantity, (set + 1) * tier.quantity);
      const setPlainMinor = members.reduce((sum, member) => sum + member.priceMinor, 0);
      const savingMinor = setPlainMinor - Math.min(tier.priceMinor, setPlainMinor);
      // Only a price that is not whole cash leaves a remainder; it stays on the dearest unit.
      const cashSavingMinor = savingMinor - (savingMinor % unit);
      const shares = allocateCashUnits(cashSavingMinor, members.map((member) => member.priceMinor), unit);
      shares[0] = shares[0]! + savingMinor - cashSavingMinor;
      members.forEach((member, position) => {
        const key = lines[member.index]!.key;
        savings.set(key, savings.get(key)! + shares[position]!);
      });
    }
  }
  const lineSavings = lines.map((line) => ({ key: line.key, savingMinor: savings.get(line.key)! }));
  const savingMinor = lineSavings.reduce((sum, line) => sum + line.savingMinor, 0);
  return { tier: savingMinor > 0 ? tier : null, plainMinor, totalMinor: plainMinor - savingMinor, savingMinor, lineSavings };
}
