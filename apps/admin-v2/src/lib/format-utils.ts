import { htmlToPlainText } from "@scalius/shared/html-sanitize";

/** Rich text as readable plain text (tags dropped, entities decoded), truncated to maxLength. */
export function getPlainText(html: string | null, maxLength = 60): string {
  const text = htmlToPlainText(html);
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + "...";
}

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
