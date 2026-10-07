import { fromMinor, toMinor } from "@scalius/shared/money";

/**
 * Shopify's price pair over this store's stored model.
 *
 * The merchant types two prices: what customers pay (Price) and, optionally,
 * what it cost before (Compare-at price). The product stores a base price and
 * a discount, which feeds, structured data and checkout read; nothing about
 * that changes. The pair maps onto it exactly:
 * - no compare-at price: base = price, no discount;
 * - compare-at C above price P: base = C and a flat discount of C - P, so the
 *   product sells at P and C is the struck-through original.
 * Both are multiples of the market's price increment, so the difference is too.
 */

export interface PricePair {
  /** What customers pay. */
  price: number | null;
  /** What it cost before, shown crossed out; null for none. */
  compareAt: number | null;
}

/** Why the compare-at price can't be stored (the form refuses to save it). */
export type CompareAtProblem = "notHigher" | "invalid";

export interface StoredPrice {
  price: number | null;
  /** True when the pair carries a discount (a flat amount); false clears it. */
  discounted: boolean;
  discountAmount: number;
  problem: CompareAtProblem | null;
}

const isNumber = (value: number | null): value is number => value !== null && Number.isFinite(value);

/** The pair a merchant reads for a stored base price and the price it sells at after its discount (null: no discount). */
export function pairFromStored(base: number | null, sale: number | null): PricePair {
  if (isNumber(base) && sale !== null) return { price: sale, compareAt: base };
  return { price: base, compareAt: null };
}

/** The stored base price and flat discount for a pair, exact in minor units. */
export function storedFromPair(pair: PricePair, decimalPlaces: number): StoredPrice {
  const { price, compareAt } = pair;
  const plain: StoredPrice = { price, discounted: false, discountAmount: 0, problem: null };
  if (compareAt === null) return plain;
  if (!Number.isFinite(compareAt) || compareAt < 0) return { ...plain, problem: "invalid" };
  // With no price typed yet there is nothing to compare with.
  if (!isNumber(price)) return plain;
  try {
    const original = toMinor(compareAt, decimalPlaces);
    const selling = toMinor(price, decimalPlaces);
    if (original <= selling) return { ...plain, problem: "notHigher" };
    return { price: compareAt, discounted: true, discountAmount: fromMinor(original - selling, decimalPlaces), problem: null };
  } catch {
    return { ...plain, problem: "invalid" };
  }
}
