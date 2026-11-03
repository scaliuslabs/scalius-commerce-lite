/**
 * When a typed query is worth a search-as-you-type request. One definition for
 * the storefront palette (it sends no request below it) and the public search
 * route (it answers empty below it, before any database work or rate limit).
 *
 * A query needs at least two graphemes after trimming; a single Han ideograph
 * is a whole word, so one is enough. Only Han counts as a one-character word:
 * a lone Latin, Bangla, kana or Hangul character is not a word on its own.
 * A deliberate submit on the full search page uses the product list endpoint
 * and is not bound by this minimum.
 */
export const MIN_SEARCH_GRAPHEMES = 2;

const HAN = /\p{Script=Han}/u;

const SEGMENTER: Intl.Segmenter | null = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

/** User-perceived characters in `value` (code points when `Intl.Segmenter` is missing). */
export function countGraphemes(value: string): number {
  if (!SEGMENTER) return Array.from(value).length;
  let count = 0;
  for (const _ of SEGMENTER.segment(value)) count += 1;
  return count;
}

export function isSearchableQuery(value: string | null | undefined): boolean {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return false;
  if (countGraphemes(trimmed) >= MIN_SEARCH_GRAPHEMES) return true;
  return HAN.test(trimmed);
}
