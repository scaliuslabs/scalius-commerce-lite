/**
 * Search text: the one definition of the words search reads, shared by the
 * write side (a rich-text column's search text, computed in TypeScript where
 * the rich text is written) and the query side (a buyer's or an agent's
 * query, folded the same way on Turso and PostgreSQL).
 *
 * The fold is FTS5's (unicode61, `remove_diacritics 2`, as D1's FTS5 tables
 * are built), read from FTS5 for every character of the Basic Multilingual
 * Plane (search-fold-data.ts), then SEARCH_NORMALIZATION. Pure functions: no
 * bindings or database access.
 */
import { htmlToPlainText } from "./html-sanitize";
import { FTS5_DROPPED_RANGES, FTS5_FOLD_PAIRS, FTS5_SEPARATOR_RANGES } from "./search-fold-data";

/** The longest term the index keeps; longer words are compared on their first 100 characters. */
export const SEARCH_TERM_MAX_LENGTH = 100;

/**
 * The characters of a rich-text column's search text the index reads: its
 * first 20,000 (about 3,000 words). The rest of a longer text is not
 * searchable, and the editor says so where the limit is reached.
 */
export const SEARCH_TEXT_MAX_LENGTH = 20_000;

/**
 * Characters read differently before matching, on every provider and in
 * every query: the zero-width joiner and non-joiner are ignored (a word typed
 * with or without them matches), and the precomposed Bengali nukta letters
 * read as their canonical decomposition (Unicode composition exclusions,
 * which a query's NFC normalisation decomposes).
 */
export const SEARCH_NORMALIZATION: ReadonlyMap<string, string> = new Map([
  ["‌", ""],
  ["‍", ""],
  ["ড়", "ড়"],
  ["ঢ়", "ঢ়"],
  ["য়", "য়"],
]);

function codePoints(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function pairsOf(text: string): Array<readonly [string, string]> {
  const characters = Array.from(text);
  return Array.from({ length: characters.length / 2 }, (_, index) => [characters[2 * index]!, characters[2 * index + 1]!] as const);
}

/**
 * Every character FTS5 changes and what it becomes: a separator a space, a
 * combining diacritic nothing, a letter its folded letter, then
 * SEARCH_NORMALIZATION. ASCII capitals are left to `lower()`.
 */
export const SEARCH_FOLD_MAP: ReadonlyMap<string, string> = new Map([
  ...FTS5_SEPARATOR_RANGES.flatMap(([from, to]) => codePoints(from, to).filter((point) => point !== 0x20).map((point) => [String.fromCodePoint(point), " "] as const)),
  ...FTS5_DROPPED_RANGES.flatMap(([from, to]) => codePoints(from, to).map((point) => [String.fromCodePoint(point), ""] as const)),
  ...pairsOf(FTS5_FOLD_PAIRS),
  ...SEARCH_NORMALIZATION,
]);

/** The text as the index stores it, before it is split on spaces: ASCII lower-cased (SQL `lower()`), then folded as FTS5 folds. */
export function foldSearchText(text: string): string {
  let folded = "";
  for (const character of text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase())) {
    folded += SEARCH_FOLD_MAP.get(character) ?? character;
  }
  return folded;
}

/** The terms of a text, in order (a word longer than the cap keeps its first 100 characters). */
export function searchTerms(text: string): string[] {
  return foldSearchText(text).split(" ").filter(Boolean)
    .map((word) => Array.from(word).slice(0, SEARCH_TERM_MAX_LENGTH).join(""));
}

/**
 * The characters of a rich-text value's HTML its search text is read from:
 * its first 40,000. That holds 20,000 characters of text whenever markup is
 * at most half of it (an editor's paragraphs and emphasis are about 40%), and
 * it bounds the cost of a search text whatever the value's size: about 5 ms
 * (40,000 characters of `&`, the slowest input measured, about 8 ms), so a
 * row stored before the size limit, or written by SQL, costs no more.
 */
export const SEARCH_HTML_MAX_LENGTH = 40_000;

/** The first `count` code points of `text` (SQL `substr` counts code points), scanning no further. */
export function codePointPrefix(text: string, count: number): string {
  if (text.length <= count) return text;
  let index = 0;
  for (let points = 0; points < count && index < text.length; points += 1) {
    const code = text.charCodeAt(index);
    index += code >= 0xd800 && code <= 0xdbff && index + 1 < text.length ? 2 : 1;
  }
  return text.slice(0, index);
}

/** The plain text search reads of a rich-text value: of its first SEARCH_HTML_MAX_LENGTH characters, without a word the cut may have split. */
function searchedPlainText(html: string): { plain: string; cut: boolean } {
  const prefix = codePointPrefix(html, SEARCH_HTML_MAX_LENGTH);
  const cut = prefix.length < html.length;
  let plain = htmlToPlainText(prefix);
  if (cut) plain = plain.slice(0, Math.max(0, plain.search(/\s\S*$/)));
  return { plain, cut };
}

/**
 * The search text of a rich-text value: the plain text (`htmlToPlainText`)
 * of its first SEARCH_HTML_MAX_LENGTH characters, folded, its words joined
 * by single spaces, cut to its first SEARCH_TEXT_MAX_LENGTH characters at a
 * word boundary. Null for no value. It reads nothing past that prefix, so it
 * depends on the prefix alone. Every provider indexes it as it is: FTS5
 * re-folds it to the same tokens, and Turso and PostgreSQL split it on spaces.
 */
export function richTextSearchText(html: string | null | undefined): string | null {
  if (html === null || html === undefined) return null;
  const words = foldSearchText(searchedPlainText(html).plain).split(" ").filter(Boolean);
  let text = "";
  let length = 0;
  for (const word of words) {
    const wordLength = Array.from(word).length + (text ? 1 : 0);
    if (length + wordLength > SEARCH_TEXT_MAX_LENGTH) break;
    text += text ? ` ${word}` : word;
    length += wordLength;
  }
  return text;
}

/**
 * Whether a raw value indexes exactly as its search text does, so a row that
 * has none can be marked as needing none: no markup or entity, and short
 * enough that neither its search text nor the raw fallback the index reads
 * (its first SEARCH_TEXT_MAX_LENGTH characters) is cut.
 */
export function rawTextIsItsSearchText(raw: string): boolean {
  return !/[<&]/.test(raw) && codePointPrefix(raw, SEARCH_TEXT_MAX_LENGTH).length === raw.length;
}

/**
 * The characters of a rich-text value's plain text search reads when that
 * is not all of it (the editor's notice), else null.
 */
export function searchTextCoverage(html: string | null | undefined): number | null {
  if (!html) return null;
  const { plain, cut } = searchedPlainText(html);
  const length = Array.from(plain).length;
  if (!cut && length <= SEARCH_TEXT_MAX_LENGTH) return null;
  return Math.min(length, SEARCH_TEXT_MAX_LENGTH);
}
