import { normalizeSearchQuery } from "./search-query";
import { catalogCopy, type CatalogCopy } from "./catalog-copy";
import { formatCount } from "./store-time-zone";

export interface SearchWordingInput {
  /** What the buyer typed. */
  query: string;
  /** The spelling the API retried when the typed query matched nothing. */
  correctedQuery?: string | null;
  /** "12 results" / "1 result": the count with its noun. */
  resultCountLabel: string;
  /** Products on this page. */
  productCount: number;
  page: number;
  /** The words, in the store's language (English by default). */
  copy?: CatalogCopy["search"];
}

export interface SearchWording {
  title: string;
  description: string;
  /** The hero's results bar; null when nothing matched. */
  countLabel: string | null;
  /** Set only when the results are for a corrected spelling. */
  correction: { shownQuery: string; originalQuery: string } | null;
}

/**
 * Title, description, results bar and "did you mean" notice for the search
 * page, from one decision. A corrected search leads with the spelling that was
 * searched (Google, Amazon: "Showing results for X"), then names what was typed
 * ("No exact results for Y"); every part agrees with the products shown.
 * Quotes are typographic, and the query is whitespace-normalised.
 */
export function searchWording(input: SearchWordingInput): SearchWording {
  const original = normalizeSearchQuery(input.query);
  const corrected = normalizeSearchQuery(input.correctedQuery);
  const correction =
    original && corrected && input.productCount > 0 && corrected.toLowerCase() !== original.toLowerCase()
      ? { shownQuery: corrected, originalQuery: original }
      : null;
  const shown = correction?.shownQuery ?? original;
  const copy = input.copy ?? catalogCopy("en").search;
  const pageSuffix = input.page > 1 ? copy.page(formatCount(input.page)) : "";
  const title = `${shown ? copy.resultsFor(shown) : copy.allProducts}${pageSuffix}`;
  const description = shown
    ? `${copy.countFor(input.resultCountLabel, shown)}.${correction ? ` ${copy.noExact(correction.originalQuery)}` : ""}`
    : copy.describeAll;
  const countLabel =
    input.productCount === 0 ? null : shown ? copy.countFor(input.resultCountLabel, shown) : input.resultCountLabel;
  return { title, description, countLabel, correction };
}
