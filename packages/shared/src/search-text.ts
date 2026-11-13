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
 * The search text of a rich-text value: its plain text (`htmlToPlainText`),
 * folded, its words joined by single spaces, cut to its first
 * SEARCH_TEXT_MAX_LENGTH characters at a word boundary. Null for no value.
 * Every provider indexes it as it is: FTS5 re-folds it to the same tokens,
 * and Turso and PostgreSQL split it on spaces.
 */
export function richTextSearchText(html: string | null | undefined): string | null {
  if (html === null || html === undefined) return null;
  const words = foldSearchText(htmlToPlainText(html)).split(" ").filter(Boolean);
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

/** Whether a rich-text value's plain text runs past what search reads (the editor's notice). */
export function richTextExceedsSearchText(html: string | null | undefined): boolean {
  return Boolean(html) && Array.from(htmlToPlainText(html)).length > SEARCH_TEXT_MAX_LENGTH;
}
