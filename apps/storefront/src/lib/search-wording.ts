import { normalizeSearchQuery } from "./search-query";

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
  const pageSuffix = input.page > 1 ? ` – Page ${input.page}` : "";
  const title = `${shown ? `Search results for “${shown}”` : "All products"}${pageSuffix}`;
  const description = shown
    ? `${input.resultCountLabel} for “${shown}”.${correction ? ` No exact results for “${correction.originalQuery}”.` : ""}`
    : "Explore our full collection of products.";
  const countLabel =
    input.productCount === 0 ? null : shown ? `${input.resultCountLabel} for “${shown}”` : input.resultCountLabel;
  return { title, description, countLabel, correction };
}
