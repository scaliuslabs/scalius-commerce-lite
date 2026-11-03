/**
 * The words of a search query, and when a typed query is worth a
 * search-as-you-type request. One definition for the storefront palette (it
 * sends no request below the minimum), the public search route (it answers
 * empty below it, before any database work or rate limit) and the text
 * search itself (`@scalius/core/search` splits a query with the same tokens).
 *
 * The minimum applies to the tokens the search runs on, not to the typed
 * text: "a." and "a b" are one-letter prefix searches, so they ask nothing. A
 * query is searchable when at least one token is a word: two graphemes or
 * more, or one grapheme that is a word by itself (a Han ideograph, a Hangul
 * syllable, or a Bangla grapheme of two or more code points, a consonant with
 * its vowel sign or conjunct, as in চা or ঘি). A lone Latin letter, kana or
 * bare Bangla consonant is a prefix, not a word. A deliberate submit on the
 * full search page uses the product list endpoint and is not bound by this.
 */
export const MIN_SEARCH_GRAPHEMES = 2;

/**
 * Every ASCII character outside an FTS5 bareword (letters, digits, `_`) and
 * the Bangla danda: a stray `%`, `$` or `;` would otherwise be an FTS5 syntax
 * error, not a search.
 */
const SEARCH_SEPARATORS = /[\p{Cc}\x20-\x2F\x3A-\x40\x5B-\x5E\x60\x7B-\x7E।॥]/gu;
/** The words one search reads at most. */
export const MAX_SEARCH_TOKENS = 8;

/**
 * Splits buyer/admin input into bounded search tokens. Input is NFC-normalized
 * first so Bangla typed through different keyboards (for example a precomposed
 * or decomposed য়) produces one token form.
 */
export function searchQueryTokens(input: string): string[] {
  const cleaned = input.normalize("NFC").replace(SEARCH_SEPARATORS, " ").trim();
  if (!cleaned) return [];
  return cleaned.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TOKENS);
}

const HAN = /\p{Script=Han}/u;
/** A precomposed Hangul syllable (가-힣): a whole word such as 책, 옷 or 차. */
const HANGUL_SYLLABLE = /^[가-힣]$/u;
const BENGALI = /^\p{Script=Bengali}+$/u;

const SEGMENTER: Intl.Segmenter | null = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

function graphemes(value: string): string[] {
  return SEGMENTER ? Array.from(SEGMENTER.segment(value), (part) => part.segment) : Array.from(value);
}

/** User-perceived characters in `value` (code points when `Intl.Segmenter` is missing). */
export function countGraphemes(value: string): number {
  return graphemes(value).length;
}

/** A one-grapheme token that is a word by itself. */
function isOneGraphemeWord(grapheme: string): boolean {
  if (HAN.test(grapheme) || HANGUL_SYLLABLE.test(grapheme)) return true;
  return BENGALI.test(grapheme) && Array.from(grapheme).length >= 2;
}

function isSearchableToken(token: string): boolean {
  const parts = graphemes(token);
  if (parts.length >= MIN_SEARCH_GRAPHEMES) return true;
  return parts.length === 1 && isOneGraphemeWord(parts[0]!);
}

export function isSearchableQuery(value: string | null | undefined): boolean {
  return searchQueryTokens(value ?? "").some(isSearchableToken);
}
