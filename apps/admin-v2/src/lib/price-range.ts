// A product's price range, apart from the rich-text helpers in format-utils.ts:
// the products list shows prices on every row, and must not download the HTML
// parser the plain-text helper needs.

/** What buyers pay for a product, as the API's `priceRange` carries it. */
export type BuyerPriceRange = { from: number; to: number; compareAt: number | null };

/**
 * "৳2,400–৳2,600", or one price when every variant costs the same; null when
 * nothing has a price yet. The same numbers the storefront shows.
 */
export function priceRangeText(
  range: BuyerPriceRange | null | undefined,
  fmt: (price: number) => string,
): string | null {
  if (!range || range.to <= 0) return null;
  return range.from === range.to ? fmt(range.from) : `${fmt(range.from)}–${fmt(range.to)}`;
}
